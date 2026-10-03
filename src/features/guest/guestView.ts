// What the guest windows show, in the shape they show it, and the words they use. The shell fills
// these from the guest contract (src/shared/guest.ts) and the Allworld runtime; nothing here calls
// the service, reads storage or signs anyone in. docs/GUEST-UX.md lists the hooks.
import type { InjectionKey, Ref } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import type { AvatarLook, ErrorCode } from '../../shared/model.ts'
import { GUEST_GATE_MESSAGE } from '../../shared/guest.ts'
import type { GuestGate, GuestStatus, SavedCharacter } from '../../shared/guest.ts'

/** A character as a window shows it. A `SavedCharacter` from a claim conflict fits as it is. */
export interface GuestCharacter { memberId?: MemberId; displayName: string; look: AvatarLook }

/** Whether Allworld sign-in can be started from where the App is running. */
export type GuestSignIn = 'available' | 'unavailable'

export interface GuestSessionView {
  /** The service's own answer for this guest: who, and when the session expires and ends. */
  status: GuestStatus
  /** Null until the first-run steps have saved a character. */
  character: GuestCharacter | null
  /** False when this browser could not keep the guest session: it lasts for this tab only. */
  persisted: boolean
  /** 'available' only where the hosted backend and the account service can both take a claim. */
  signIn: GuestSignIn
}

/**
 * Why a save did not happen. The first three come from the platform and the link; the rest are the
 * service's codes for a guest (`claimFailureOf`).
 */
export type ClaimFailure = 'sign-in-cancelled' | 'sign-in-unavailable' | 'offline' | 'interrupted' | 'expired' | 'unauthorized' | 'rate_limited' | 'unavailable' | 'service'

/** `claimed` and `conflict` are only ever set from the service's `GuestClaimResult`. */
export type ClaimState =
  | { kind: 'idle' }
  /** Waiting on Allworld sign-in. */
  | { kind: 'signing-in' }
  /** The service has the request and has not answered. */
  | { kind: 'claiming' }
  /**
   * The service saved the character to the account. `character` is the one that was saved, when
   * known. This says who owns it; it does not say the account's world is open on this screen.
   */
  | { kind: 'claimed'; character: GuestCharacter | null }
  /**
   * The account already owns a character. Nothing changed and the guest session still works;
   * `guestAfterSwitch` says whether this browser keeps it if the visitor takes the saved one.
   */
  | { kind: 'conflict'; existing: SavedCharacter; guestAfterSwitch: 'kept' | 'ended' }
  /** `message` is the service's or the platform's own sentence. */
  | { kind: 'failed'; reason: ClaimFailure; message: string }

/** Why an earlier guest session in this browser cannot be opened: it ran out, or the service refused it. */
export type GuestEnded = 'expired' | 'refused'

export interface GuestController {
  /** Null when the visitor is not a guest. */
  session: Readonly<Ref<GuestSessionView | null>>
  claim: Readonly<Ref<ClaimState>>
  /** The conflict choice being applied. */
  busy: Readonly<Ref<'use-saved' | 'keep-guest' | null>>
  /** Start Allworld sign-in, then the claim. */
  save(): void
  /** Stop waiting for sign-in. Nothing is claimed afterwards, whatever the sign-in goes on to do. */
  cancel(): void
  /** Conflict, `use-saved`: switch to the character the account already has. */
  useSaved(): void
  /** Conflict, `keep-guest`: stay a guest. */
  keepGuest(): void
  /** Back to idle after `claimed` or `failed`. */
  reset(): void
}
export const GUEST_CONTROL: InjectionKey<GuestController> = Symbol('guest')

/** The service's error code for a failed claim, as the reason the save window words. */
export function claimFailureOf(code: ErrorCode): ClaimFailure {
  return code === 'expired' || code === 'unauthorized' || code === 'rate_limited' || code === 'unavailable' ? code : 'service'
}

const isGate = (value: string): value is GuestGate => Object.hasOwn(GUEST_GATE_MESSAGE, value)
/** The gate a route names in `meta.gate`: a section closed whole to a guest. Null for anything else. */
export function routeGate(value: unknown): GuestGate | null {
  return typeof value === 'string' && isGate(value) ? value : null
}

/** The one line shown where a guest sets up, so it reads the same everywhere. */
export const GUEST_LINE = 'Playing as a guest. This character stays on this device until you save it.'

export const STAYS_ON_DEVICE: readonly string[] = [
  'Your guest session. It is the only way back to this character, and only this browser on this device holds it.',
  'Any photo you use to match a look. It is read on this device and never uploaded.',
]
// The member id does not change when a guest is claimed, so everything recorded against it stays.
export const CARRIES_OVER: readonly string[] = [
  'Your character: its name, look and outfit.',
  'Your starting area, your home, and your passport and trips.',
  'Coins and work progress you earned as a guest. Nothing is copied, so nothing is given twice.',
]
// A summary in words of GUEST_OPS and the gates in src/shared/guest.ts. The service enforces the list itself.
export const GUEST_CAN = 'As a guest you can explore, travel, change your character and home, work shifts, play the computer and find a casual match.'
export const GUEST_WAITS = 'Chat and messages, meeting and finding people, the market, listings, rated games, challenges, standings and a photo face wait until the character is saved.'
export const NOT_PERSISTED = 'This browser could not keep your guest session, so it lasts only while this tab stays open. Save your character before you close it.'

/** How long is left, in words. `soon` is under a day and a half. Null when there is no usable time. */
export function timeLeft(until: string | null | undefined, now: number): { text: string; soon: boolean } | null {
  if (!until) return null
  const at = Date.parse(until)
  if (!Number.isFinite(at)) return null
  const hours = (at - now) / 3_600_000
  if (hours <= 0) return { text: 'has ended', soon: true }
  if (hours < 1.5) return { text: 'ends within the hour', soon: true }
  if (hours < 36) return { text: `ends in about ${Math.round(hours)} hours`, soon: true }
  return { text: `ends in about ${Math.round(hours / 24)} days`, soon: false }
}

export function endedText(ended: GuestEnded): string {
  return ended === 'expired'
    ? 'Your guest character has expired. The guest session on this device ran out before it was saved, so that character cannot be reopened by anyone.'
    : 'Your guest character can no longer be opened here: the world ended or refused its guest session. If you saved that character to an account, sign in to Allworld to open it.'
}
export const GUEST_KEPT_LINE = 'Your guest character is still kept on this device.'

export interface FailureView {
  title: string
  advice: string
  /** The one next step offered. Giving the guest up is never one of them: a failed save leaves the guest as it was. */
  next: 'retry' | 'close'
}

export function failureView(reason: ClaimFailure): FailureView {
  switch (reason) {
    case 'sign-in-cancelled': return { title: 'Sign-in was cancelled', advice: 'Nothing was moved. You are still playing as a guest.', next: 'retry' }
    case 'sign-in-unavailable': return { title: 'Account sign-in is not available here', advice: 'Saving to an account is not available on this host yet. Keep this browser open to retain your guest character.', next: 'close' }
    case 'offline': return { title: 'Not saved yet', advice: 'The connection dropped before the world answered. Trying again is safe: a character is never saved twice.', next: 'retry' }
    // Stopped part-way by a sign-out or an account change. The request may already have reached the
    // service, so the window does not promise that nothing moved.
    case 'interrupted': return { title: 'The save was interrupted', advice: 'Sign-in changed before the world answered. If you are still a guest here, nothing was moved and you can try again; trying again never saves a character twice.', next: 'retry' }
    // The service gives these two codes for the account's proof and for the guest session alike,
    // so the window does not say which it was and does not treat the guest as gone.
    case 'expired': return { title: 'The save ran out of time', advice: 'The sign-in or the guest session expired before the world answered. Nothing was moved.', next: 'retry' }
    case 'unauthorized': return { title: 'The save was not accepted', advice: 'Either Allworld could not confirm your account, or this guest session is no longer valid. Nothing was moved.', next: 'retry' }
    case 'rate_limited': return { title: 'Too many tries just now', advice: 'Nothing was moved. Wait a minute, then try again.', next: 'retry' }
    case 'unavailable': return { title: 'The world cannot save right now', advice: 'Nothing was moved. You are still playing as a guest.', next: 'retry' }
    case 'service': return { title: 'The save did not go through', advice: 'Nothing was moved. You are still playing as a guest.', next: 'retry' }
  }
}
