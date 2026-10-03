// The touch joystick as a small state machine, apart from the component that draws it, so that what
// happens when a finger is lifted, cancelled, taken away by the system, or the phone is turned can be
// run without a screen. One pointer owns the stick at a time; a second finger on it is ignored. The
// sink always ends at (0, 0) when the stick lets go, whatever the reason.

export interface StickRect { left: number; top: number; width: number; height: number }
export interface StickView { x: number; y: number; active: boolean }

/** How far past the pad's edge the engine is asked to run: the pad fills at 1, the engine caps at 1.3. */
const GAIN = 1.3

export interface Stick {
  readonly active: boolean
  /** A finger came down on the pad. False when another finger already holds it. */
  start(pointerId: number, x: number, y: number, rect: StickRect): boolean
  move(pointerId: number, x: number, y: number): void
  /** The finger that holds the pad went up or was cancelled. Other fingers cannot end it. */
  end(pointerId: number): void
  /** Let go now, whatever holds it: blur, hidden page, turned phone, a panel opening, unmount. */
  release(): void
}

export function createStick(sink: (x: number, z: number) => void, onView: (view: StickView) => void = () => undefined): Stick {
  let holder: number | null = null
  let rect: StickRect | null = null
  const show = (x: number, y: number, active: boolean): void => onView({ x, y, active })

  function aim(x: number, y: number): void {
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    const dx = (x - (rect.left + rect.width / 2)) / (rect.width / 2)
    const dy = (y - (rect.top + rect.height / 2)) / (rect.height / 2)
    const length = Math.hypot(dx, dy) || 1
    const clamped = Math.min(1, length)
    const nx = (dx / length) * clamped, ny = (dy / length) * clamped
    show(nx, ny, true)
    sink(nx * GAIN, ny * GAIN)
  }

  return {
    get active() { return holder !== null },
    start(pointerId, x, y, area) {
      if (holder !== null) return false
      holder = pointerId; rect = area
      aim(x, y)
      return true
    },
    move(pointerId, x, y) { if (pointerId === holder) aim(x, y) },
    end(pointerId) { if (pointerId === holder) this.release() },
    release() {
      holder = null; rect = null
      show(0, 0, false)
      // Always zero the sink, even if nothing held the pad: a stuck value from elsewhere is worse than a redundant zero.
      sink(0, 0)
    },
  }
}

/** The events that mean a held finger can no longer be trusted. Returns the function that removes them. */
export function releaseOnLoss(stick: Stick, sources: { window: EventTarget; document: EventTarget & { hidden?: boolean }; orientation?: EventTarget | null }): () => void {
  const let_go = (): void => stick.release()
  const hidden = (): void => { if (sources.document.hidden) stick.release() }
  sources.window.addEventListener('blur', let_go)
  sources.window.addEventListener('pagehide', let_go)
  sources.window.addEventListener('orientationchange', let_go)
  sources.document.addEventListener('visibilitychange', hidden)
  sources.orientation?.addEventListener('change', let_go)
  return () => {
    sources.window.removeEventListener('blur', let_go)
    sources.window.removeEventListener('pagehide', let_go)
    sources.window.removeEventListener('orientationchange', let_go)
    sources.document.removeEventListener('visibilitychange', hidden)
    sources.orientation?.removeEventListener('change', let_go)
  }
}
