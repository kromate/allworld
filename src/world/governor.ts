export type Tier = 'low' | 'medium' | 'high'
export type PowerMode = 'battery' | 'balanced' | 'quality'

export interface TierPreset {
  resolutionCap: number
  fps: number
  idleFps: number
  shadows: boolean
  drawDistance: number
  textureSize: number
  avatarHz: number
}

export const TIER_PRESETS: Record<Tier, Readonly<TierPreset>> = {
  low: { resolutionCap: 1, fps: 30, idleFps: 12, shadows: false, drawDistance: 520, textureSize: 256, avatarHz: 12 },
  medium: { resolutionCap: 1.5, fps: 45, idleFps: 15, shadows: true, drawDistance: 900, textureSize: 512, avatarHz: 20 },
  high: { resolutionCap: 2, fps: 60, idleFps: 20, shadows: true, drawDistance: 1300, textureSize: 512, avatarHz: 30 },
}

interface BatteryStatus extends EventTarget {
  readonly level: number
  readonly charging: boolean
}

interface BatteryNavigator extends Navigator {
  getBattery?: () => Promise<BatteryStatus>
}

const governors = new WeakMap<HTMLCanvasElement, FrameGovernor>()

export function governorSnapshot(canvas: HTMLCanvasElement): GovernorSnapshot | null {
  return governors.get(canvas)?.snapshot() ?? null
}

export interface GovernorSnapshot {
  renderedFrames: number
  tier: Tier
  mode: PowerMode
  preset: Readonly<TierPreset>
  running: boolean
  suspended: boolean
  visible: boolean
  active: boolean
  probeSamples: number
  cpuP95: number | null
  gpuP95: number | null
  frameIntervalMeanMs: number | null
}

export interface FrameGovernorOptions {
  canvas: HTMLCanvasElement
  active: () => boolean
  frame: (delta: number, elapsed: number) => void
  changed?: (tier: Tier) => void
  tier?: Tier
  automatic?: boolean
  maxFps?: number
}

export function chooseInitialTier(): Tier {
  const device = navigator as BatteryNavigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  const cores = navigator.hardwareConcurrency || 4
  const memory = device.deviceMemory ?? 8
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const dpr = window.devicePixelRatio || 1
  if (device.connection?.saveData || reducedMotion || cores <= 4 || memory <= 4) return 'low'
  if (coarse || cores < 8 || dpr > 2) return 'medium'
  return 'high'
}

function p95(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null
}

function sample(values: number[], ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  values.push(ms)
  if (values.length > 48) values.shift()
}

function lower(tier: Tier): Tier {
  return tier === 'high' ? 'medium' : 'low'
}

function rank(tier: Tier): number {
  return tier === 'low' ? 0 : tier === 'medium' ? 1 : 2
}

export class FrameGovernor {
  private readonly canvas: HTMLCanvasElement
  private readonly active: () => boolean
  private readonly frame: (delta: number, elapsed: number) => void
  private readonly changed?: (tier: Tier) => void
  private automatic: boolean
  private readonly maxFps: number
  private initial: Tier
  private tier: Tier
  private mode: PowerMode = 'balanced'
  private running = false
  private disposed = false
  private suspended = false
  private visible = true
  private raf = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private observer: IntersectionObserver | null = null
  private battery: BatteryStatus | null = null
  private batteryGeneration = 0
  private lastFrameAt = 0
  private nextDueAt = 0
  private pacedActive: boolean | null = null
  private badFor = 0
  private batteryLimited = false
  private readonly cpu: number[] = []
  private readonly gpu: number[] = []
  private readonly intervals: number[] = []
  private probeSamples = 0
  private renderedFrames = 0

  constructor(options: FrameGovernorOptions) {
    this.canvas = options.canvas
    this.active = options.active
    this.frame = options.frame
    this.changed = options.changed
    this.automatic = options.automatic ?? true
    this.maxFps = options.maxFps ?? 60
    const hint = chooseInitialTier()
    const requested = options.tier ?? hint
    this.initial = this.automatic && rank(hint) < rank(requested) ? hint : requested
    this.tier = this.initial
    governors.set(this.canvas, this)
  }

  snapshot(): GovernorSnapshot {
    return {
      renderedFrames: this.renderedFrames, tier: this.tier, mode: this.mode, preset: { ...TIER_PRESETS[this.tier], fps: Math.min(TIER_PRESETS[this.tier].fps, this.maxFps) },
      running: this.running, suspended: this.suspended,
      visible: !document.hidden && this.visible, active: this.active(),
      probeSamples: this.probeSamples, cpuP95: p95(this.cpu), gpuP95: p95(this.gpu),
      frameIntervalMeanMs: this.intervals.length ? this.intervals.reduce((sum, value) => sum + value, 0) / this.intervals.length : null,
    }
  }

  start(): void {
    if (this.running || this.disposed) return
    this.running = true
    try { this.changed?.(this.tier) } catch (error) { this.running = false; throw error }
    this.visible = this.inViewport()
    document.addEventListener('visibilitychange', this.onVisibility)
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(entries => {
        this.visible = entries[0]?.isIntersecting ?? false
        this.sync()
      })
      this.observer.observe(this.canvas)
    } else {
      window.addEventListener('scroll', this.onViewport, { passive: true })
      window.addEventListener('resize', this.onViewport)
    }
    this.watchBattery()
    this.sync()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.cancelPending()
    this.lastFrameAt = 0
    this.nextDueAt = 0
    this.pacedActive = null
    this.badFor = 0
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.observer?.disconnect()
    this.observer = null
    window.removeEventListener('scroll', this.onViewport)
    window.removeEventListener('resize', this.onViewport)
    this.batteryGeneration++
    this.battery?.removeEventListener('levelchange', this.onBattery)
    this.battery?.removeEventListener('chargingchange', this.onBattery)
    this.battery = null
    this.resetMeasurements()
  }

  dispose(): void {
    this.stop()
    this.disposed = true
    if (governors.get(this.canvas) === this) governors.delete(this.canvas)
  }

  invalidate(): void {
    if (!this.running || !this.canRun()) return
    if (this.pacedActive && this.active() && (this.raf || this.timer !== null)) return
    this.cancelPending()
    this.nextDueAt = 0
    this.raf = requestAnimationFrame(this.onFrame)
  }

  configure(tier: Tier, automatic: boolean): void {
    const hint = chooseInitialTier()
    this.initial = automatic && rank(hint) < rank(tier) ? hint : tier
    this.automatic = automatic
    this.resetMeasurements()
    this.setTier(this.ceiling())
    this.invalidate()
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    this.sync()
  }

  setMode(mode: PowerMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.resetMeasurements()
    this.setTier(this.ceiling())
    this.invalidate()
  }

  /** Submit a valid GPU timer result in milliseconds after the caller checks for disjoint results. */
  recordGpu(ms: number): void {
    if (this.running && this.canRun() && (this.active() || this.probeSamples < 48)) sample(this.gpu, ms)
  }

  private readonly onVisibility = (): void => this.sync()
  private readonly onViewport = (): void => {
    this.visible = this.inViewport()
    this.sync()
  }
  private readonly onBattery = (): void => {
    const limited = Boolean(this.battery && !this.battery.charging && this.battery.level <= 0.2)
    if (limited === this.batteryLimited) return
    this.batteryLimited = limited
    this.resetMeasurements()
    this.setTier(this.ceiling())
    this.invalidate()
  }

  private watchBattery(): void {
    const device = navigator as BatteryNavigator
    if (typeof device.getBattery !== 'function') return
    const generation = ++this.batteryGeneration
    void device.getBattery().then(battery => {
      if (!this.running || generation !== this.batteryGeneration) return
      this.battery = battery
      battery.addEventListener('levelchange', this.onBattery)
      battery.addEventListener('chargingchange', this.onBattery)
      this.onBattery()
    }).catch(() => undefined)
  }

  private ceiling(): Tier {
    if (this.battery && !this.battery.charging && this.battery.level <= 0.2) return 'low'
    return this.mode === 'battery' ? 'low' : this.mode === 'quality' ? 'high' : this.initial
  }

  private setTier(tier: Tier): void {
    if (tier === this.tier) return
    this.tier = tier
    this.nextDueAt = 0
    this.changed?.(tier)
  }

  private resetMeasurements(): void {
    this.cpu.length = this.gpu.length = this.intervals.length = 0
    this.probeSamples = 0
    this.badFor = 0
  }

  private inViewport(): boolean {
    const rect = this.canvas.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth
  }

  private canRun(): boolean {
    return !this.suspended && !document.hidden && this.visible
  }

  private cancelPending(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    if (this.timer !== null) clearTimeout(this.timer)
    this.raf = 0
    this.timer = null
  }

  private sync(): void {
    if (!this.running || !this.canRun()) {
      this.cancelPending()
      this.lastFrameAt = 0
      this.nextDueAt = 0
      this.pacedActive = null
      this.badFor = 0
      return
    }
    if (!this.raf && this.timer === null) this.raf = requestAnimationFrame(this.onFrame)
  }

  private schedule(): void {
    const preset = TIER_PRESETS[this.tier]
    const active = this.active()
    if (active !== this.pacedActive) this.nextDueAt = 0
    this.pacedActive = active
    const fps = Math.min(active ? preset.fps : preset.idleFps, this.maxFps)
    const period = 1000 / fps
    this.nextDueAt = this.nextDueAt ? this.nextDueAt + period : this.lastFrameAt + period
    if (this.nextDueAt <= this.lastFrameAt) this.nextDueAt = this.lastFrameAt + period
    const delay = Math.max(0, this.nextDueAt - performance.now() - 2)
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.running && this.canRun()) this.raf = requestAnimationFrame(this.onFrame)
      }, delay)
    } else this.raf = requestAnimationFrame(this.onFrame)
  }

  private readonly onFrame = (now: number): void => {
    this.raf = 0
    if (!this.running || !this.canRun()) { this.sync(); return }
    try {
      const elapsed = this.lastFrameAt ? Math.max(0, (now - this.lastFrameAt) / 1000) : 0
      this.lastFrameAt = now
      const active = this.active()
      const started = performance.now()
      this.frame(Math.min(elapsed, 0.1), elapsed)
      this.renderedFrames++
      if (!this.running) return
      sample(this.cpu, performance.now() - started)
      this.probeSamples = Math.min(48, this.probeSamples + 1)
      if (active) {
        if (elapsed > 0 && elapsed < 1) sample(this.intervals, elapsed * 1000)
        this.adapt(Math.min(elapsed, 0.25))
      } else { this.badFor = 0; this.intervals.length = 0 }
      if (this.canRun() && !this.raf && this.timer === null) this.schedule()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  private adapt(elapsed: number): void {
    if (!this.automatic || this.probeSamples < 48 || elapsed <= 0) return
    const budget = 1000 / Math.min(TIER_PRESETS[this.tier].fps, this.maxFps)
    const cpu = p95(this.cpu) ?? 0
    const gpu = p95(this.gpu) ?? 0
    const interval = this.intervals.length >= 24 ? this.intervals.reduce((sum, value) => sum + value, 0) / this.intervals.length : 0
    const bad = Math.max(cpu, gpu) > budget * 0.8 || interval > budget * 1.35
    this.badFor = bad ? this.badFor + elapsed : 0
    if (this.badFor >= 10 && this.tier !== 'low') {
      this.setTier(lower(this.tier))
      this.resetMeasurements()
    }
  }
}
