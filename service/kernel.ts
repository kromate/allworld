// The world service kernel: state slices, operation registry, connections and event fan-out.
// Transport-free on purpose — the same World runs behind a WebSocket, or in-process for checks.
import { performance } from 'node:perf_hooks'
import type { MemberId, RoomKey } from '../src/shared/ids.ts'
import { iso } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { RoomRef } from '../src/shared/model.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import type { ClientFrame, OpName, Ops, ServerEvent, ServerFrame } from '../src/shared/protocol.ts'

export const BUILD = 'local-service-0.2.0'
/** A room step is split into this many phases so the rooms are not all sent out in the same instant. */
export const STEP_PHASES = 10

/** One avatar's latest position in a room step. */
export interface Moved { memberId: MemberId; x: number; z: number; heading: number; moving: boolean }

/**
 * What moved in one room instance during one step. The same object is handed to every recipient
 * in that instance, so a transport can encode each avatar once (in `memo`) and reuse the bytes.
 */
export interface MovementStep { room: RoomKey; moved: Moved[]; memo: Record<string, unknown> }

/** Fast paths a transport may offer. Without one, everything goes through `send`. */
export interface Link {
  /** A frame that is already text. Never dropped. */
  sendText(text: string): void
  /** A frame that may wait for this member's next room step (at most one step), to share its write. Never dropped. */
  sendLater(text: string): void
  /** True while this socket's send buffer is over its limit. Movement is held back; nothing else is. */
  congested(): boolean
  /** Movement and presence changes for one step, written to the socket in one go. */
  sendStep(step: MovementStep, indices: number[], events: ServerEvent[]): void
}

export interface Connection {
  readonly id: number
  readonly memberId: MemberId
  send(frame: ServerFrame): void
  close(): void
  readonly link?: Link
}

export interface Ctx {
  world: World
  memberId: MemberId
  now: number
}

type Handler<K extends OpName> = (ctx: Ctx, input: Ops[K]['in']) => Ops[K]['out']
type Parser<K extends OpName> = (raw: unknown) => Ops[K]['in']
interface Registered {
  parse: (raw: unknown) => unknown; handle: (ctx: Ctx, input: never) => unknown; cost: number
  /** The answer may ride with the member's next room step instead of being written on its own. */
  lazyAck: boolean
  calls: number; timed: number; totalMs: number; maxMs: number
}

export interface Persistence {
  load(): Record<string, unknown> | null
  /** Write the whole state now, blocking. Used for the last write at shutdown. */
  save(state: Record<string, unknown>): void
  /**
   * Write state that is already text, without blocking the caller. Resolves once it is on disk.
   * `sequence` rises with every capture; a store must never let an older one replace a newer one.
   */
  write?(text: string, sequence: number): Promise<void>
  /** Blocking form of `write`, for the last write at shutdown. */
  writeNow?(text: string, sequence: number): void
  /** True once another instance owns the store. This one's writes are being dropped and it must stop. */
  superseded?(): boolean
  /** True when the stored state was replaced or removed by something that is not its owner. The World writes it again. */
  foreign?(): boolean
  /**
   * Lets a newer instance in the same process ask this one to write what it holds before it
   * takes over (`flush`), and tells this one the moment it has been replaced (`retired`).
   */
  bind?(flush: () => void, retired?: () => void): void
  /** Give the store up cleanly (after the last write). */
  close?(): void
  describe?(): Record<string, unknown>
}

/**
 * Set on the state process of a sharded service. Room instances then live on room shards; this
 * World keeps only who is in which room (so homes, games and travel can still ask) and hands the
 * rest over. See service/cluster.ts.
 */
export interface RoomHost {
  enter(request: {
    memberId: MemberId; ref: RoomRef; key: RoomKey; instance: number; pos: Vec2; heading: number; now: number
    reply: Reply
  }): void
  leave(memberId: MemberId, key: RoomKey): void
  /** A block or a changed look has to reach the shard holding the room at once. */
  changed(memberId: MemberId, key: RoomKey, what: 'look' | { blocked: MemberId }): void
}

export interface Reply { (data: unknown): void; fail(code: string, message: string): void }

export interface WorldOptions {
  persistence?: Persistence
  /** Injectable clock so expiry, quiet hours and weekly resets can be checked deterministically. */
  now?: () => number
  roomHost?: RoomHost
  /** Hold the answer to an operation that changed state until that change is on disk. */
  durableAcks?: boolean
}

export interface SaveStats {
  captures: number
  /** Longest time the event loop was held turning state into text, in ms. */
  maxCaptureMs: number
  lastCaptureMs: number
  lastBytes: number
  lastWriteMs: number
  /** Gap being left between captures right now: the most recent writes that a crash could lose. */
  windowMs: number
  failures: number
  /** Why the newest state is not on disk. Null again once a state at least as new as the one that failed has been written. */
  lastError: string | null
  /** True while a change is in memory but not yet on disk. */
  unsaved: boolean
  /** Another instance owns the state file; nothing this one holds is being saved. */
  superseded: boolean
}

interface Bucket { tokens: number; at: number; max: number; windowMs: number; /** When operation listeners last heard of this member. */ seenAt: number }
/** Operation listeners hear a member's movement only when they have not heard of that member for this long. */
const MOVEMENT_SEEN_EVERY_MS = 30_000
const BASE_SAVE_GAP_MS = 250
const BUCKET = { burst: 40, perSecond: 15 }

export class World {
  private readonly ops = new Map<string, Registered>()
  private readonly slices: Record<string, unknown>
  private readonly connections = new Map<MemberId, Connection>()
  private readonly disconnectHooks: ((memberId: MemberId) => void)[] = []
  private readonly connectHooks: ((memberId: MemberId) => void)[] = []
  private readonly tickHooks: ((now: number) => void)[] = []
  private readonly stepHooks: ((now: number, phase: number | null) => void)[] = []
  private readonly supersededHooks: (() => void)[] = []
  private readonly buckets = new Map<string, Bucket>()
  private readonly operationHooks: ((memberId: MemberId, op: string, now: number) => void)[] = []
  private readonly persistence: Persistence | null
  private readonly clock: () => number
  private nextConnection = 1
  private lastPrune = 0
  readonly roomHost: RoomHost | null

  // ── Saving ──
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private writing = false
  private sequence = 0
  /** The newest capture known to be on disk. Writes can come back out of order; this never steps back. */
  private committed = 0
  /** The newest capture whose write failed and has not been made good by one at least as new. 0 when there is none. */
  private failed = 0
  private retryGap = 0
  private closed = false
  /** Slices read or written in the current scope; they are saved again only if the scope changed something. */
  private readonly accessed = new Set<string>()
  private readonly dirty = new Set<string>()
  /** Slices that can change without being named: see `slice` and `audit`. */
  private readonly loose = new Set<string>()
  private auditCursor = 0
  private readonly texts = new Map<string, string>()
  private scopeDepth = 0
  private touched = false
  private touchCount = 0
  private saveEverything = true
  private readonly durableAcks: boolean
  private waitingAcks: { sequence: number; connection: Connection; text: string }[] = []
  private reply: { connection: Connection; id: number; taken: boolean } | null = null
  readonly saveStats: SaveStats = { captures: 0, maxCaptureMs: 0, lastCaptureMs: 0, lastBytes: 0, lastWriteMs: 0, windowMs: BASE_SAVE_GAP_MS, failures: 0, lastError: null, unsaved: false, superseded: false }
  /** `hookMaxMs` is the longest run of each tick hook, in registration order; `hookNames` says which module each belongs to. */
  readonly tickStats = { lastMs: 0, maxMs: 0, lastStepMs: 0, maxStepMs: 0, hookMaxMs: [] as number[], hookNames: [] as string[] }
  private phased = false

  constructor(options: WorldOptions = {}) {
    this.persistence = options.persistence ?? null
    this.clock = options.now ?? Date.now
    this.slices = this.persistence?.load() ?? {}
    this.persistence?.bind?.(() => this.flush(), () => {
      this.saveStats.superseded = true
      for (const hook of this.supersededHooks) hook()
    })
    this.roomHost = options.roomHost ?? null
    this.durableAcks = options.durableAcks === true && typeof this.persistence?.write === 'function'
  }

  now(): number { return this.clock() }

  /** Each module owns one named slice of persisted state. */
  slice<T>(name: string, initial: () => T): T {
    // Asked for outside any operation or hook (while a module registers, say), the reference may
    // have been kept and can be changed later without the slice being named again. Such a slice
    // is "loose": every announced change is taken to include it.
    if (this.scopeDepth === 0) this.loose.add(name); else this.accessed.add(name)
    if (!(name in this.slices)) this.slices[name] = initial()
    return this.slices[name] as T
  }

  /** Read a slice without creating it (and without counting as a change to it). */
  peek<T>(name: string): T | undefined { return this.slices[name] as T | undefined }

  /**
   * Mark state changed. Saving is batched and stays off the request path: see `capture`.
   * Which slices changed is not said here, so every slice the current operation or hook asked
   * for is treated as changed, together with every loose slice (one whose reference a module
   * may have kept). `audit` catches anything that still slips past.
   */
  touch(): void {
    this.touched = true
    this.touchCount++
    // Outside an operation there is no telling what was looked at: save everything.
    if (this.scopeDepth === 0) { this.saveEverything = true; this.closeScope() }
  }

  /** Run work that may change state outside an operation (first sign-in, for example). */
  scoped<T>(run: () => T): T {
    this.openScope()
    try { return run() } finally { this.closeScope() }
  }

  private openScope(): void {
    if (this.scopeDepth++ === 0) { this.accessed.clear(); this.touched = false }
  }

  private closeScope(): void {
    if (this.scopeDepth > 0 && --this.scopeDepth > 0) return
    if (!this.touched) return
    this.touched = false
    for (const name of this.accessed) this.dirty.add(name)
    for (const name of this.loose) this.dirty.add(name)
    this.accessed.clear()
    this.saveStats.unsaved = true
    this.scheduleSave()
  }

  /** True once another instance has taken over the saved state. A transport should stop serving. */
  get superseded(): boolean {
    if (!this.saveStats.superseded && this.persistence?.superseded?.()) {
      this.saveStats.superseded = true
      for (const hook of this.supersededHooks) hook()
    }
    return this.saveStats.superseded
  }

  /**
   * The safety net under "which slices changed". Once a second one slice that is believed
   * unchanged is turned into text and compared with what was last saved. If it differs, a module
   * changed it without the kernel seeing — through a reference it kept, or without calling
   * `touch` at all — so it is saved now and treated as loose from then on. Every slice comes
   * round every few seconds; no change can stay unsaved for longer than that.
   */
  private audit(): void {
    if (!this.persistence || this.saveStats.superseded) return
    const names = Object.keys(this.slices)
    if (names.length === 0) return
    const name = names[this.auditCursor++ % names.length]!
    const known = this.texts.get(name)
    if (known === undefined || this.saveEverything || this.dirty.has(name)) return
    if ((JSON.stringify(this.slices[name]) ?? 'null') === known) return
    this.loose.add(name)
    this.dirty.add(name)
    this.saveStats.unsaved = true
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (!this.persistence || this.saveTimer || this.writing || this.closed || this.superseded) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.capture() }, Math.max(this.saveStats.windowMs, this.retryGap))
  }

  /**
   * Turn what changed into text in one uninterrupted step (so the saved state is a consistent
   * moment), then hand the text to the store, which writes it without holding the event loop.
   * Only slices that changed are turned into text again; the rest reuse their last text.
   */
  private serialise(everything = false): string {
    const started = performance.now()
    const full = everything || this.saveEverything
    let out = '{'
    let first = true
    for (const name of Object.keys(this.slices)) {
      let text = full || this.dirty.has(name) ? undefined : this.texts.get(name)
      if (text === undefined) { text = JSON.stringify(this.slices[name]) ?? 'null'; this.texts.set(name, text) }
      out += `${first ? '' : ','}${JSON.stringify(name)}:${text}`
      first = false
    }
    out += '}'
    // Only now: a slice that cannot be turned into text throws above, and what was owed is still owed.
    this.saveEverything = false
    this.dirty.clear()
    const took = performance.now() - started
    const stats = this.saveStats
    stats.captures++
    stats.lastCaptureMs = took
    stats.lastBytes = out.length
    if (took > stats.maxCaptureMs) stats.maxCaptureMs = took
    // Never spend more than about 1% of the time capturing: a bigger state is saved less often.
    stats.windowMs = Math.max(BASE_SAVE_GAP_MS, Math.ceil(took * 100))
    return out
  }

  private capture(): void {
    const store = this.persistence
    if (!store || this.superseded) return
    const sequence = ++this.sequence
    let write: Promise<void> | null = null
    let started = 0
    try {
      if (store.write) {
        const text = this.serialise()
        started = performance.now()
        write = store.write(text, sequence)
      } else {
        // A store with no non-blocking write (the in-process checks) is written the simple way.
        store.save(this.slices)
        this.dirty.clear()
      }
    } catch (error) {
      // The state could not be turned into text, or the store threw where it should have answered.
      this.saveFailed(sequence, error)
      return
    }
    if (!write) { this.settled(sequence, 0); return }
    this.writing = true
    write.then(
      () => { this.writing = false; this.settled(sequence, performance.now() - started) },
      (error: unknown) => { this.writing = false; this.saveFailed(sequence, error) },
    )
  }

  /**
   * The one place a save that did not happen is recorded, whichever way it failed: the timed
   * capture or `flush`, turning the state into text or writing it. It is never swallowed: it is
   * logged, shown on /world/health, and retried (after 1 s, doubling to 30 s) until a state at
   * least as new is on disk. What changed stays in memory and stays owed.
   */
  private saveFailed(sequence: number, error: unknown): void {
    if (sequence <= this.committed) {
      // A newer state is already on disk (a flush overtook this write), so nothing is missing.
      console.error('[world] an older save failed after a newer one was stored; nothing is missing', error)
      this.resume()
      return
    }
    if (sequence > this.failed) this.failed = sequence
    this.saveStats.failures++
    this.saveStats.lastError = error instanceof Error ? error.message : String(error)
    this.saveStats.unsaved = true
    this.retryGap = Math.min(30_000, Math.max(1000, this.retryGap * 2))
    console.error(`[world] state could not be saved (attempt ${this.saveStats.failures}); ${this.closed ? 'the service is stopping, so it is not retried' : `retrying in ${this.retryGap} ms`}`, error)
    this.scheduleSave()
  }

  private settled(sequence: number, writeMs: number): void {
    // A store that has been taken over wrote nothing: nothing is committed and no answer is released.
    if (this.superseded) return
    if (sequence > this.committed) { this.committed = sequence; this.saveStats.lastWriteMs = writeMs }
    // A failure is made good only by a write at least as new as the one that failed: an older
    // write that was still under way and lands afterwards proves nothing about the newer state.
    if (sequence >= this.failed) { this.failed = 0; this.retryGap = 0; this.saveStats.lastError = null }
    if (this.waitingAcks.length) {
      const ready = this.waitingAcks.filter(entry => entry.sequence <= this.committed)
      this.waitingAcks = this.waitingAcks.filter(entry => entry.sequence > this.committed)
      for (const entry of ready) sendText(entry.connection, entry.text)
    }
    this.resume()
  }

  /** After a write has come back, either way: go again if anything is still owed. */
  private resume(): void {
    if (this.dirty.size > 0 || this.failed !== 0) this.scheduleSave()
    else this.saveStats.unsaved = false
  }

  /**
   * Write everything now, blocking: before an answer that must not outrun the disk, and at
   * shutdown. If it cannot be written the failure is recorded like any other and thrown to the
   * caller, who must not go on as if it had been.
   */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    const store = this.persistence
    if (!store) return
    const sequence = ++this.sequence
    try {
      if (store.writeNow) store.writeNow(this.serialise(true), sequence)
      else { store.save(this.slices); this.dirty.clear() }
    } catch (error) {
      this.saveFailed(sequence, error)
      throw error
    }
    this.settled(sequence, 0)
  }

  /** Last write, then let go of the store. After this the World must not be used. */
  close(): void {
    // Nothing is retried from here on: a last write that fails is thrown to whoever is stopping the service.
    this.closed = true
    this.flush()
    this.persistence?.close?.()
  }

  register<K extends OpName>(op: K, parse: Parser<K>, handle: Handler<K>, options: { cost?: number; lazyAck?: boolean } = {}): void {
    if (this.ops.has(op)) throw new Error(`Operation registered twice: ${op}`)
    this.ops.set(op, { parse, handle: handle as (ctx: Ctx, input: never) => unknown, cost: options.cost ?? 1, lazyAck: options.lazyAck === true, calls: 0, timed: 0, totalMs: 0, maxMs: 0 })
  }

  registered(): string[] { return [...this.ops.keys()].sort() }

  onConnect(hook: (memberId: MemberId) => void): void { this.connectHooks.push(hook) }
  onDisconnect(hook: (memberId: MemberId) => void): void { this.disconnectHooks.push(hook) }
  onTick(hook: (now: number) => void): void {
    this.tickHooks.push(hook)
    // Diagnostics only: remember which module registered the hook, from where this was called.
    const caller = /\/service\/([\w-]+)\.ts/.exec((new Error().stack ?? '').split('\n').find(line => line.includes('/service/') && !line.includes('/kernel.ts')) ?? '')
    this.tickStats.hookNames.push(caller?.[1] ?? `hook-${this.tickHooks.length}`)
  }
  /** Called once, the moment another instance takes over the saved state. A transport disconnects its members here. */
  onSuperseded(hook: () => void): void { this.supersededHooks.push(hook) }
  /**
   * Called after every successful member operation, so a module can tell a member who is doing
   * things from one whose socket is merely open. Every operation is reported each time, except
   * movement (`room.move`, eight a second while walking): a step is reported only when the
   * member has not been reported for 30 seconds, so someone who only walks is still heard from
   * twice a minute. Nothing is allocated per call. A listener that throws is logged and does
   * not fail the operation.
   */
  onOperation(listener: (memberId: MemberId, op: string, now: number) => void): void { this.operationHooks.push(listener) }

  /** Report an operation that ran elsewhere (a room shard tells the state thread who is moving). */
  noteOperation(memberId: MemberId, op: string): void {
    const now = this.now()
    for (const hook of this.operationHooks) { try { hook(memberId, op, now) } catch (error) { console.error(`[world] an operation listener failed after ${op}`, error) } }
  }

  /** Work done many times a second: rooms send out movement here. */
  onStep(hook: (now: number, phase: number | null) => void): void { this.stepHooks.push(hook) }

  /** Run time-based work: expiries, shift timeouts, reminder scheduling, turn clocks. */
  tick(): void {
    const started = performance.now()
    const now = this.now()
    // With no transport stepping the rooms in phases (the in-process checks), a tick sends movement too.
    if (!this.phased) this.step()
    this.openScope()
    try {
      for (let index = 0; index < this.tickHooks.length; index++) {
        const hookStarted = performance.now()
        this.tickHooks[index]!(now)
        const hookTook = performance.now() - hookStarted
        if (hookTook > (this.tickStats.hookMaxMs[index] ?? 0)) this.tickStats.hookMaxMs[index] = Math.round(hookTook * 100) / 100
      }
    } finally { this.closeScope() }
    if (now - this.lastPrune > 30_000) { this.lastPrune = now; this.pruneBuckets(now) }
    this.audit()
    // Once a second: is the saved state still the one this World wrote? If not, write it again now.
    if (this.persistence?.foreign?.() && !this.superseded) {
      this.saveEverything = true
      this.saveStats.unsaved = true
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
      if (!this.writing) this.capture()
    }
    const took = performance.now() - started
    this.tickStats.lastMs = took
    if (took > this.tickStats.maxMs) this.tickStats.maxMs = took
  }

  /**
   * Send out what moved since the last step. A transport calls this with phases 0…STEP_PHASES-1
   * in turn, so each room is stepped ten times a second but the rooms are not all stepped in the
   * same instant. With no phase every room is stepped (the in-process checks, via `tick`).
   */
  step(phase: number | null = null): void {
    if (phase !== null) this.phased = true
    const started = performance.now()
    const now = this.now()
    for (const hook of this.stepHooks) hook(now, phase)
    const took = performance.now() - started
    this.tickStats.lastStepMs = took
    if (took > this.tickStats.maxStepMs) this.tickStats.maxStepMs = took
  }

  // ── Calls ──

  /** Execute one operation as a member. Throws WorldError for expected failures. */
  call<K extends OpName>(memberId: MemberId, op: K, input: Ops[K]['in']): Ops[K]['out'] {
    return this.execute(memberId, op, input) as Ops[K]['out']
  }

  private execute(memberId: MemberId, op: string, raw: unknown): unknown {
    const registered = this.ops.get(op)
    if (!registered) throw new WorldError('invalid', `Unknown operation: ${op}`)
    // An instance that can no longer save must not accept anything: the member's App reconnects to the one that can.
    if (this.saveStats.superseded) throw new WorldError('unavailable', 'The world service restarted. Reconnecting.')
    const now = this.now()
    const bucket = this.spend(memberId, registered.cost, now)
    // One call in eight is timed: enough to see which operations are slow, cheap enough to leave on.
    const started = (registered.calls++ & 7) === 0 ? performance.now() : 0
    this.openScope()
    try {
      const input = registered.parse(raw)
      const result = registered.handle({ world: this, memberId, now }, input as never)
      if (this.operationHooks.length > 0 && (!registered.lazyAck || now - bucket.seenAt >= MOVEMENT_SEEN_EVERY_MS)) {
        bucket.seenAt = now
        for (const hook of this.operationHooks) { try { hook(memberId, op, now) } catch (error) { console.error(`[world] an operation listener failed after ${op}`, error) } }
      }
      return result
    } finally {
      this.closeScope()
      if (started !== 0) {
        const took = performance.now() - started
        registered.timed++
        registered.totalMs += took
        if (took > registered.maxMs) registered.maxMs = took
      }
    }
  }

  /** Token bucket per member: 40 operations of burst, refilled at 15 per second. */
  private spend(memberId: MemberId, cost: number, now: number): Bucket {
    let bucket = this.buckets.get(memberId)
    if (!bucket) { bucket = { tokens: BUCKET.burst, at: now, max: BUCKET.burst, windowMs: (BUCKET.burst / BUCKET.perSecond) * 1000, seenAt: -Infinity }; this.buckets.set(memberId, bucket) }
    bucket.tokens = Math.min(BUCKET.burst, bucket.tokens + ((now - bucket.at) / 1000) * BUCKET.perSecond)
    bucket.at = now
    if (bucket.tokens < cost) throw new WorldError('rate_limited', 'Too many requests. Wait a moment and try again.')
    bucket.tokens -= cost
    return bucket
  }

  /** Stricter named limit, for example chat or reports. */
  limit(key: string, max: number, windowMs: number): void {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) { bucket = { tokens: max, at: now, max, windowMs, seenAt: -Infinity }; this.buckets.set(key, bucket) }
    bucket.tokens = Math.min(max, bucket.tokens + ((now - bucket.at) / windowMs) * max)
    bucket.at = now
    if (bucket.tokens < 1) throw new WorldError('rate_limited', 'You are doing that too quickly. Wait a moment and try again.')
    bucket.tokens -= 1
  }

  /** A bucket that has refilled says nothing a fresh one would not: forget it, so the map tracks active members only. */
  private pruneBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.tokens + ((now - bucket.at) / bucket.windowMs) * bucket.max >= bucket.max) this.buckets.delete(key)
  }

  // ── Connections ──

  connect(memberId: MemberId, send: (frame: ServerFrame) => void, close: () => void, link?: Link): Connection {
    const previous = this.connections.get(memberId)
    if (previous) {
      previous.send({ t: 'event', event: { type: 'session.replaced' } })
      this.scoped(() => { for (const hook of this.disconnectHooks) hook(memberId) })
      previous.close()
    }
    const connection: Connection = { id: this.nextConnection++, memberId, send, close, link }
    this.connections.set(memberId, connection)
    connection.send({ t: 'welcome', memberId, serverTime: iso(this.now()), build: BUILD })
    this.scoped(() => { for (const hook of this.connectHooks) hook(memberId) })
    return connection
  }

  /**
   * Room shards only: register a member's connection as relayed by an edge. The member signed in
   * on the state process, so there is no welcome here and no connect hooks.
   */
  attach(memberId: MemberId, send: (frame: ServerFrame) => void, close: () => void, link: Link): Connection {
    const connection: Connection = { id: this.nextConnection++, memberId, send, close, link }
    this.connections.set(memberId, connection)
    return connection
  }

  /** Room shards only: the member left this shard's rooms or disconnected. */
  detach(memberId: MemberId): void {
    const connection = this.connections.get(memberId)
    if (connection) this.disconnect(connection)
  }

  disconnect(connection: Connection): void {
    if (this.connections.get(connection.memberId) !== connection) return
    this.connections.delete(connection.memberId)
    this.scoped(() => { for (const hook of this.disconnectHooks) hook(connection.memberId) })
  }

  isOnline(memberId: MemberId): boolean { return this.connections.has(memberId) }
  online(): number { return this.connections.size }

  /** Handle one frame from a connected member. */
  receive(connection: Connection, frame: ClientFrame): void {
    if (frame.t === 'ping') { connection.send({ t: 'pong' }); return }
    if (frame.t !== 'req') return
    const slot = { connection, id: frame.id, taken: false }
    const touchesBefore = this.touchCount
    this.reply = slot
    try {
      const data = this.execute(connection.memberId, frame.op, frame.input)
      if (slot.taken) return
      if (this.durableAcks && this.touchCount !== touchesBefore) {
        // The change is in memory; the answer waits for the capture that puts it on disk.
        this.waitingAcks.push({ sequence: this.sequence + 1, connection, text: JSON.stringify({ t: 'res', id: frame.id, ok: true, data }) })
        return
      }
      if (connection.link && this.ops.get(frame.op)?.lazyAck) connection.link.sendLater(JSON.stringify({ t: 'res', id: frame.id, ok: true, data }))
      else connection.send({ t: 'res', id: frame.id, ok: true, data })
    } catch (error) {
      if (slot.taken) { console.error(`[world] ${frame.op} failed after handing its answer on`, error); return }
      if (error instanceof WorldError) connection.send({ t: 'res', id: frame.id, ok: false, code: error.code, message: error.message })
      else {
        console.error(`[world] ${frame.op} failed`, error)
        connection.send({ t: 'res', id: frame.id, ok: false, code: 'unavailable', message: 'The world service hit an unexpected error.' })
      }
    } finally {
      this.reply = null
    }
  }

  /**
   * For a handler whose answer comes from elsewhere (a room shard): take over the reply to the
   * request being handled. Returns null when the operation was not called over a connection.
   */
  deferReply(): Reply | null {
    const slot = this.reply
    if (!slot || slot.taken) return null
    slot.taken = true
    const { connection, id } = slot
    const reply = ((data: unknown) => connection.send({ t: 'res', id, ok: true, data })) as Reply
    reply.fail = (code, message) => connection.send({ t: 'res', id, ok: false, code, message })
    return reply
  }

  /** Push an event to one member, if connected. */
  push(memberId: MemberId, event: ServerEvent): void {
    this.connections.get(memberId)?.send({ t: 'event', event })
  }

  /** Push the same event to several members. It is turned into text once, not once per member. */
  pushMany(memberIds: Iterable<MemberId>, event: ServerEvent): number {
    let text: string | null = null
    let delivered = 0
    for (const memberId of memberIds) {
      const connection = this.connections.get(memberId)
      if (!connection) continue
      delivered++
      if (!connection.link) { connection.send({ t: 'event', event }); continue }
      text ??= `{"t":"event","event":${JSON.stringify(event)}}`
      connection.link.sendText(text)
    }
    return delivered
  }

  /** Movement and presence changes for one member from one room step. */
  pushStep(memberId: MemberId, step: MovementStep, indices: number[], events: ServerEvent[]): void {
    const connection = this.connections.get(memberId)
    if (!connection) return
    if (connection.link) { connection.link.sendStep(step, indices, events); return }
    for (const event of events) connection.send({ t: 'event', event })
    for (const index of indices) {
      const moved = step.moved[index]!
      connection.send({ t: 'event', event: { type: 'presence.move', room: step.room, memberId: moved.memberId, pos: { x: moved.x, z: moved.z }, heading: moved.heading, moving: moved.moving } })
    }
  }

  /** True when movement for this member should be held back because their socket is not keeping up. */
  congested(memberId: MemberId): boolean {
    return this.connections.get(memberId)?.link?.congested() ?? false
  }

  /** Per-operation timings and save figures, for /world/health diagnostics. */
  stats(): { operations: { op: string; calls: number; meanMs: number; maxMs: number }[]; save: SaveStats & Record<string, unknown>; tick: World['tickStats']; buckets: number } {
    const operations = [...this.ops].filter(([, entry]) => entry.timed > 0)
      .map(([op, entry]) => ({ op, calls: entry.calls, meanMs: Math.round((entry.totalMs / entry.timed) * 1000) / 1000, maxMs: Math.round(entry.maxMs * 100) / 100 }))
      .sort((a, b) => b.calls * b.meanMs - a.calls * a.meanMs)
    return { operations, save: { ...this.saveStats, looseSlices: [...this.loose], ...(this.persistence?.describe?.() ?? {}) }, tick: { ...this.tickStats, hookMaxMs: [...this.tickStats.hookMaxMs], hookNames: [...this.tickStats.hookNames] }, buckets: this.buckets.size }
  }
}

function sendText(connection: Connection, text: string): void {
  if (connection.link) connection.link.sendText(text)
  else connection.send(JSON.parse(text) as ServerFrame)
}

export function requireFound<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new WorldError('not_found', `${what} was not found.`)
  return value
}
