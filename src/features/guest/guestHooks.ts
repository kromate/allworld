// The one seam between the guest windows and the session controller (src/state/app.ts and
// src/platform/, owned by the hosted-bridge track). The controller in guestControl.ts is written
// against this interface, so a change to those hooks is a change to this file only. Nothing here
// reads or returns the guest capability itself: the windows only ever learn whether one is held.
import { accountAvailable, app, authenticate, cancelAuthentication, claimGuest, claimRecovery, claimRecoveryKept, currentAccount, hasStoredGuest, openAccount, resumeGuest, settleAccount, signOutAccount, startGuest, useSavedAccount } from '../../state/app.ts'
import { ACCOUNT_PASSWORD_MAX, ACCOUNT_PASSWORD_MIN } from '../../platform/account.ts'
import type { AccountUser, CancelResult } from '../../platform/account.ts'
import { guestStorageScope } from '../../platform/guestService.ts'
import { hostedWorldConfig } from '../../platform/runtime.ts'
import type { GuestClaimResult, GuestStatus } from '../../shared/guest.ts'

export interface GuestHooks {
  /** The session controller is showing the guest first screen. */
  welcome(): boolean
  /** The service's answer for the guest now connected. Null for anyone else. */
  status(): GuestStatus | null
  /** Whether this browser managed to keep the guest session. False means it lasts for this tab only. */
  persisted(): boolean
  /** The hosted backend can take a claim, and this page can sign an account in. */
  claimAvailable(): boolean
  /** Why the guest session this browser held was given up by the controller: it ran out, or the service refused it. */
  ended(): 'expired' | 'refused' | null
  /** A save of this guest got no definite answer, possibly before a reload: the guest it named, noted on this device. */
  claimRecovery(): string | null
  /** A reload would keep both the connected guest's capability and that note on this device. */
  claimRecoveryKept(): boolean
  /** The service saved the character to the account, and the account's world has not opened yet. */
  claimReconnectPending(): boolean
  /** The controller's own sentence for the state it is in. */
  failure(): string
  /** An account is playing on a configured hosted world (not a guest, not a local test member). */
  accountSession(): boolean
  /** This browser holds a guest session for this App and channel. Says nothing about what it is. */
  hasStoredGuest(): boolean
  /** The App, package and channel this tab is running against, as one non-secret string. Null when no hosted world is configured. */
  scope(): string | null
  /**
   * Whether this host admits a guest freely or asks for a private-playtest pass. Read from the
   * hosted world's reviewed public configuration. Legacy test builds ask for a pass; legacy Store builds are open.
   */
  admission(): 'open' | 'pass'
  /**
   * After the visitor pressed Play: resume the guest this browser holds, or make one. `pass`
   * travels in the request body only. A refusal leaves the first screen up with the reason in `failure()`.
   */
  startGuest(pass?: string): Promise<void>
  /** Whether this page can sign an account in at all: it is the hosted world's own origin. */
  canSignIn(): boolean
  /** The password bounds for a new account (root policy). The server checks the same bounds and decides. */
  passwordBounds(): { min: number; max: number }
  /** Who this device's session names, as the server records it, with its own email. Null when signed out. Opens nothing and claims nothing. */
  currentUser(): Promise<AccountUser | null>
  /**
   * Sign in, or create an account, with what the form handed over. Rejects with the server's own
   * sentence. The password is passed straight through and kept nowhere. Opens no world and makes no
   * character. Resolves with the account just signed in: submitting the form is choosing it.
   */
  authenticate(mode: 'signin' | 'create', email: string, password: string): Promise<AccountUser>
  /** Stop `authenticate`. The server is asked to cancel that exact attempt; resolves with its receipt (`confirmed`) or without one (`unconfirmed`). */
  cancelAuthentication(): Promise<CancelResult>
  /** Retry a cancel the server has not confirmed. True when nothing is left owing. */
  settleAccount(): Promise<boolean>
  /** Open the chosen account's own character. Refused while this browser holds a guest: that guest is claimed first. */
  openAccount(expected: AccountUser): Promise<void>
  /**
   * Claim the connected guest for the account the visitor chose, which it verifies is still the one signed in. The
   * service's own answer. `claimed` means ownership was saved; whether the account's world then
   * opened is read from the phase, `claimReconnectPending()` and `failure()`.
   */
  claimGuest(expected: AccountUser, signal?: AbortSignal): Promise<GuestClaimResult>
  /** Leave the guest link and open the account's own character. Rejects when it could not be opened; the guest session is kept either way, its connection is not. */
  useSavedAccount(expected?: AccountUser): Promise<void>
  /** Reopen the guest session this browser holds. A refusal ends at the first screen with the reason. */
  resumeGuest(): Promise<void>
  /** Close the world here, then end this device's session on the server. A held guest session is kept and is not opened by itself. */
  signOutAccount(): Promise<void>
}

export const guestHooks: GuestHooks = {
  welcome: () => app.phase === 'guest-welcome',
  status: () => app.guest,
  persisted: () => app.guestPersisted,
  claimAvailable: () => app.claimAvailable,
  ended: () => app.guestEnded,
  claimReconnectPending: () => app.claimReconnectPending,
  claimRecovery, claimRecoveryKept,
  failure: () => app.failure,
  accountSession: () => app.phase === 'ready' && app.hosted !== null && app.guest === null && hostedWorldConfig() !== null,
  hasStoredGuest,
  scope: () => { const config = hostedWorldConfig(); return config ? guestStorageScope(config) : null },
  admission: () => { const config = hostedWorldConfig(); return (config?.guestAdmission ?? (config?.channel === 'test' ? 'invite' : 'public')) === 'invite' ? 'pass' : 'open' },
  canSignIn: accountAvailable, passwordBounds: () => ({ min: ACCOUNT_PASSWORD_MIN, max: ACCOUNT_PASSWORD_MAX }), currentUser: () => currentAccount(), authenticate, cancelAuthentication, settleAccount, openAccount,
  startGuest, claimGuest, useSavedAccount, resumeGuest, signOutAccount,
}
