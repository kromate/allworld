// Leaving a building by its door, as a small state machine apart from the component that shows it, so that
// what happens on arrival, on a refusal, on a failed exit and on an account change can be run without a
// screen. Every method takes the time it happens: nothing here reads a clock or a timer.
//
// The rule it keeps is "walking up to the door is not the same as having been asked": a door only asks (or,
// when the member chose "Don't ask again", only leaves) after the member has been seen away from it, on
// this scene, for a moment. So arriving beside a door, answering "Stay", a failed exit and signing in as
// someone else can never loop into another exit.
//
//   settling ──(away from the door for REARM_MS, and SETTLE_MS since the scene began)──▶ armed
//   armed ──(near the door)──▶ asking                       preference 'ask'
//   armed ──(near the door)──▶ leaving                      preference 'auto'
//   asking ──(Exit)──▶ leaving      asking ──(Stay, or walked away)──▶ declined      asking ──(a window opened)──▶ armed
//   declined ──(away from the door for REARM_MS)──▶ armed
//   leaving ──(scene changed)──▶ reset      leaving ──(LEAVE_MS pass, or the exit reports failure)──▶ declined
//
// A hold that stops walking while the avatar is at the door (a menu, a window, a seat, an order) is not a way to
// leave: the door is then "held", and under 'auto' it will not leave on release. It leaves only after the member has
// been seen continuously away for REARM_MS and comes back. With 'ask' the question may show again after the hold.
// The member's own Leave button and E go through `explicit` and are unchanged.
//
// This is presentation only. The effect `leave` is carried out by the same call the "Leave" button has always
// made, and the service still decides whether the member goes anywhere; a saved preference never changes that.

export type DoorPhase = 'settling' | 'armed' | 'asking' | 'declined' | 'leaving'
export type DoorPreference = 'ask' | 'auto'
/** What the caller should do now: nothing, show the question, take the question away, or leave. */
export type DoorEffect = 'none' | 'ask' | 'dismiss' | 'leave'

export const DOORWAY = {
  /** After a scene begins, nothing is asked or done for this long, whatever the member does. */
  settleMs: 1200,
  /** The member must be seen away from the door this long (continuously) before it can ask again. */
  rearmMs: 700,
  /** A started exit that has not changed the scene by now counts as failed. */
  leaveMs: 6000,
} as const

export interface DoorInput {
  /** The engine says the avatar is at the door. */
  near: boolean
  /** The world is standing, nothing in front holds the avatar, and the member is not in a vehicle. */
  allowed: boolean
  preference: DoorPreference
}

export interface Doorway {
  readonly phase: DoorPhase
  /** The scene and member this intent belongs to. */
  readonly scope: string
  /** A new scene, a new member or a reset account: forget everything and start settling. */
  reset(now: number, scope: string): void
  /** The engine's door signal, a changed permission or a tick. Returns what to do. Safe to call as often as wanted. */
  step(now: number, input: DoorInput): DoorEffect
  /** The member answered the question. Only meaningful while asking. */
  answer(now: number, choice: 'exit' | 'stay'): DoorEffect
  /** The member chose to leave by a control of their own (the Leave button, the E key). Allowed in any phase but leaving. */
  explicit(now: number): DoorEffect
  /** The exit was started and the scene is still the same: it did not happen. */
  failed(): void
}

export function createDoorway(): Doorway {
  let phase: DoorPhase = 'settling'
  let scope = ''
  let settleUntil = 0
  let awaySince: number | null = null
  let leaveUntil = 0
  /** Walking was held while the avatar was at the door. Cleared by a continuous stretch away, a re-arm or a reset. */
  let held = false

  const leave = (now: number): DoorEffect => { phase = 'leaving'; leaveUntil = now + DOORWAY.leaveMs; return 'leave' }

  return {
    get phase() { return phase },
    get scope() { return scope },
    reset(now, next) { phase = 'settling'; scope = next; settleUntil = now + DOORWAY.settleMs; awaySince = now; leaveUntil = 0; held = false },
    step(now, input) {
      // How long the member had been away before this sample, read before the sample can end it.
      const awayFor = awaySince === null ? 0 : now - awaySince
      if (!input.near) awaySince ??= now
      else awaySince = null
      if (held && awayFor >= DOORWAY.rearmMs) held = false
      if (input.near && !input.allowed && (phase === 'armed' || phase === 'asking')) held = true
      if (phase === 'leaving') { if (now >= leaveUntil) { phase = 'declined'; awaySince = input.near ? null : now } return 'none' }
      // Walking away takes the question back, but the door has to be left alone for REARM_MS before it asks again: standing on the edge of the zone cannot make it flicker.
      if (phase === 'asking' && !input.near) { phase = 'declined'; awaySince = now; return 'dismiss' }
      if (phase === 'asking' && !input.allowed) { phase = 'armed'; return 'dismiss' }
      if (phase === 'settling' || phase === 'declined') {
        const away = awaySince !== null && now - awaySince >= DOORWAY.rearmMs
        if (away && (phase === 'declined' || now >= settleUntil)) { phase = 'armed'; held = false }
        return 'none'
      }
      if (phase === 'armed' && input.near && input.allowed) {
        if (input.preference === 'auto') return held ? 'none' : leave(now)
        phase = 'asking'
        return 'ask'
      }
      return 'none'
    },
    answer(now, choice) {
      if (phase !== 'asking') return 'none'
      if (choice === 'exit') return leave(now)
      phase = 'declined'; awaySince = null
      return 'dismiss'
    },
    explicit(now) { return phase === 'leaving' ? 'none' : leave(now) },
    failed() { if (phase === 'leaving') { phase = 'declined'; awaySince = null; leaveUntil = 0 } },
  }
}

// ── The saved "Don't ask again" ──
// A preference of this browser, kept for one member at a time. It only ever means "do not show the question";
// it is read back strictly (anything but the exact word is 'ask') and it is never sent anywhere.
export interface PreferenceStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const key = (member: string): string => `nw:doorway:${member}`

export function readDoorPreference(store: PreferenceStore | null, member: string | null): DoorPreference {
  if (!store || !member) return 'ask'
  try { return store.getItem(key(member)) === 'auto' ? 'auto' : 'ask' } catch { return 'ask' }
}

/** Returns what is now true, which is 'ask' whenever the store refuses. */
export function writeDoorPreference(store: PreferenceStore | null, member: string | null, value: DoorPreference): DoorPreference {
  if (!store || !member) return 'ask'
  try {
    if (value === 'auto') { store.setItem(key(member), 'auto'); return store.getItem(key(member)) === 'auto' ? 'auto' : 'ask' }
    store.removeItem(key(member)); return 'ask'
  } catch { return 'ask' }
}
