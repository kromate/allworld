// The guest journey's controller: starting as a guest, saving the character to an account later,
// and moving between a guest and an account. It decides nothing. Outcomes come from the session
// hooks (guestHooks.ts), which also sign the account in; this keeps the order right and the
// states honest:
//   - a guest this browser holds is opened, then the account is proved, then that guest is claimed:
//     the account's own world is never opened first, so no empty character is made beside the guest;
//   - a claim is only ever for an account the visitor chose on this screen: a fresh sign-in, or an
//     explicit "Continue as <email>" for one already signed in here. Nothing is claimed unseen;
//   - a claim that got no definite answer may have been saved: it is shown as uncertain, never as
//     undone, and recovered by saving again with the same guest and the same account;
//   - "saved" and "already has a character" are set only from the service's claim answer;
//   - "saved" says who owns the character, never that the account's world is open: that is the phase;
//   - a sign-in the visitor stopped waiting for can never be followed by a claim or a switch;
//   - an answer that arrives after the visitor moved on is dropped, not applied to whoever is here now;
//   - a guest session this browser holds is never given up from here.
import { computed, reactive, ref } from 'vue'
import type { InjectionKey } from 'vue'
import type { GuestClaimResult } from '../../shared/guest.ts'
import type { MemberId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import { ClaimUncertainError, app, messageOf, toast, transfer } from '../../state/app.ts'
import type { ReloadContext } from '../../ui/gameReload.ts'
import { PASSWORD_RULE } from '../../platform/account.ts'
import type { AccountUser, GoogleCredentialCollector, GooglePreparedAttempt } from '../../platform/account.ts'
import type { GuestHooks } from './guestHooks.ts'
import { claimFailureOf } from './guestView.ts'
import type { ClaimFailure, ClaimState, GuestCharacter, GuestController, GuestEnded, GuestSessionView } from './guestView.ts'

const aborted = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError'

/** What the account form hands over (src/features/account/AccountAccess.vue emits this shape). */
export interface AccessCredentials { mode: 'signin' | 'create'; email: string; password: string }
/** The inline account choice, wherever it is shown. It never holds a password: that passes through `submitAccess` once. */
export interface GuestAccess {
  /**
   * Where it is open: on the first screen, on the save page, or nowhere. `existing` is the email of
   * an account already signed in on this device: it is offered by name ("Continue as") and used
   * only when the visitor confirms it. Null shows the sign-in form.
   */
  access: Readonly<{ at: 'welcome' | 'save' | null; pending: boolean; error: { message: string; field?: 'email' | 'password' } | null; existing: string | null }>
  /** The last save got no definite answer, so it may have gone through. Saving again with the same account finds out. */
  claimUncertain: Readonly<{ value: boolean }>
  /** Root password policy, for the form's own check when creating an account. The server decides. */
  passwordPolicy(): { minLength: number; hint: string }
  googleAvailable: Readonly<{ value: boolean }>
  prepareGoogleAccess(signal?: AbortSignal): Promise<GooglePreparedAttempt>
  submitGoogleAccess(collect: GoogleCredentialCollector, prepared?: GooglePreparedAttempt): Promise<void>
  submitAccess(credentials: AccessCredentials): void
  /** The visitor confirmed the account named in `existing`. */
  continueAs(): void
  /** The visitor wants a different account: the form instead of the named one. */
  useAnother(): void
  /** Close it. A sign-in under way is cancelled on the server for that exact attempt; a claim already sent is not stopped by this. */
  cancelAccess(): void
}
export const GUEST_ACCESS: InjectionKey<GuestAccess> = Symbol('guest-access')

export interface GuestControl extends GuestController, GuestAccess {
  /** The first screen is the guest welcome. */
  welcome: Readonly<{ value: boolean }>
  /** Starting as a guest, and the sign-in offered beside it. */
  start: Readonly<{ pending: boolean; signingIn: boolean; problem: string }>
  /** Why the guest this browser held can no longer be opened, as the session controller reported it. */
  ended: Readonly<{ value: GuestEnded | null }>
  /** This browser holds a guest session for this App and channel. */
  storedGuest: Readonly<{ value: boolean }>
  /** An account is playing and a guest session is still held: the way back to it can be offered. Survives a reload. */
  returnable: Readonly<{ value: boolean }>
  /** An account is playing on the hosted world, so signing out applies. */
  account: Readonly<{ value: boolean }>
  /** The service saved the character to the account, and the account's world did not open. */
  savedUnopened: Readonly<{ value: boolean }>
  /** "Use my saved character" could not open it. The guest session is kept; its connection is closed. */
  switchFailed: Readonly<{ value: boolean }>
  /** Whether the host asks for a private-playtest pass. */
  admission(): 'open' | 'pass'
  /** Whether an account can be signed in where this is running. */
  canSignIn(): boolean
  /** The visitor pressed Play (or Continue, when a guest session is held). */
  play(pass?: string): Promise<void>
  /** The visitor already saved a character, or wants an account: the account form, then the character. */
  signIn(): Promise<void>
  cancelSignIn(): void
  /** Back to the guest character this browser holds, from an account session or one that would not open. */
  returnToGuest(): Promise<void>
  /** Try again to open the account's world after a save that could not reopen it. */
  openSaved(): Promise<void>
  /** Sign the account out on this device. Ends at the first screen; no guest is opened by itself. */
  signOut(): Promise<void>
  /**
   * What in this journey stands in the way of a reload (src/ui/gameReload.ts). `critical` holds even
   * against a hard update: a guest being issued, sign-in or a cancel in flight, a save being sent, an
   * account switch, a character being moved here, or an unanswered save this device could not note.
   * `activity` is an open sign-in form, which a hard update may go past.
   */
  dispose(): void
  reloadBlockers(): ReloadContext
}

export function createGuestControl(hooks: GuestHooks, go: (path: string) => void): GuestControl {
  const claim = ref<ClaimState>({ kind: 'idle' })
  const busy = ref<'use-saved' | 'keep-guest' | null>(null)
  const start = reactive({ pending: false, signingIn: false, problem: '' })
  /** Each save attempt has a number; a result is applied only while its attempt is still the current one. */
  let attempt = 0
  let signInRun = 0
  /** Stops a claim that is being proved or sent. It cannot take back one the service already saved. */
  let claimWork: AbortController | null = null
  /** Bumped after an action here that may have changed what this browser holds, which nothing reactive reports. */
  const held = ref(0)

  const googleAvailable = ref(false)
  let googleMetadata: AbortController | null = null
  function stopGoogleMetadata(): void { googleMetadata?.abort(); googleMetadata = null; googleAvailable.value = false }
  function refreshGoogleMetadata(): void {
    stopGoogleMetadata()
    const at = access.at
    if (!at || access.existing || !canSignIn()) return
    const work = new AbortController(); googleMetadata = work
    void hooks.googleConfiguration(work.signal).then(config => {
      if (!work.signal.aborted && googleMetadata === work && access.at === at && !access.existing) googleAvailable.value = config !== null
    }).catch(() => { /* Password access stays available when capability discovery fails. */ })
  }

  const access = reactive<{ at: 'welcome' | 'save' | null; pending: boolean; error: { message: string; field?: 'email' | 'password' } | null; existing: string | null }>({ at: null, pending: false, error: null, existing: null })
  /** The account behind `access.existing`, used only once the visitor confirms it. */
  let existingUser: AccountUser | null = null
  /** The account the current save was made for: a conflict's "Use my saved character" opens that one and no other. */
  let chosen: AccountUser | null = null
  /** Whether the sign-in under way creates an account, so a cancel is worded truthfully. */
  let creating = false
  /** This page saw a save go unanswered. */
  const uncertainHere = ref(false)
  // Or one did before a reload: the note on this device names the guest now connected. Read again
  // whenever the guest, the claim or what this browser holds changes.
  const claimUncertain = computed(() => {
    void held.value; void claim.value
    const memberId = hooks.status()?.memberId
    return uncertainHere.value || (memberId !== undefined && hooks.claimRecovery() === memberId)
  })
  const canSignIn = (): boolean => hooks.canSignIn()
  function openAccess(at: 'welcome' | 'save', existing: AccountUser | null = null): void {
    access.at = at; access.pending = false; access.error = null; access.existing = existing?.email ?? null; existingUser = existing
    refreshGoogleMetadata()
  }
  function closeAccess(): void { stopGoogleMetadata(); access.at = null; access.pending = false; access.error = null; access.existing = null; existingUser = null }
  /**
   * The visitor stopped a sign-in. The server is asked to cancel that exact attempt, and nothing is
   * said to be cancelled until it confirms. A provider account a sign-up already made is not undone.
   */
  function abandonAuth(): void {
    const wasCreating = creating
    void hooks.cancelAuthentication().then(result => {
      if (result === 'confirmed') toast(wasCreating ? 'Cancelled on this device. The account may already have been created; you can sign in with it later.' : 'Sign-in cancelled. You can try again.', 'info')
      else if (result === 'unconfirmed') toast('The server has not yet confirmed the cancel, so no account is used on this device until it does.', 'bad', { label: 'Retry', run: () => {
        void hooks.settleAccount().then(done => toast(done ? 'Cancel confirmed.' : 'Still not confirmed. Check your connection; no account is used here meanwhile.', done ? 'info' : 'bad'))
      } })
    })
  }

  const session = computed<GuestSessionView | null>(() => {
    const status = hooks.status()
    // The guest the service names must be the member this tab is playing as.
    if (!status || app.phase !== 'ready' || !app.me || app.me.id !== status.memberId) return null
    const character: GuestCharacter | null = app.me.onboardedAt ? { memberId: app.me.id, displayName: app.me.displayName, look: app.me.look } : null
    return { status, character, persisted: hooks.persisted(), signIn: hooks.claimAvailable() && canSignIn() ? 'available' : 'unavailable' }
  })
  const welcome = computed(() => app.phase !== 'ready' && (hooks.welcome() || start.pending || start.signingIn))
  const ended = computed(() => hooks.ended())
  // Whether a session is held changes only when the session does; the phase, the guest and the
  // member are what move then, so reading them keeps this current without touching storage on a timer.
  const storedGuest = computed(() => { void held.value; void app.phase; void app.me; void hooks.status(); return hooks.hasStoredGuest() })
  const account = computed(() => hooks.accountSession())
  const returnable = computed(() => account.value && storedGuest.value)
  const savedUnopened = computed(() => app.phase === 'failed' && (hooks.claimReconnectPending() || claim.value.kind === 'claimed'))
  const switchFailed = computed(() => app.phase === 'failed' && claim.value.kind === 'conflict' && !savedUnopened.value)

  const fail = (reason: ClaimFailure, message = ''): void => { claim.value = { kind: 'failed', reason, message } }
  function failWith(error: unknown): void {
    // Sent with no definite answer: it may have been saved. Never said to be undone.
    if (error instanceof ClaimUncertainError) { uncertainHere.value = true; held.value++; fail('offline', error.message) }
    // Stopped by a sign-out or an account change. The request may or may not have reached the service.
    else if (aborted(error)) fail('interrupted')
    else if (app.link !== 'online') fail('offline', messageOf(error))
    else fail(error instanceof WorldError ? claimFailureOf(error.code) : 'service', messageOf(error))
  }
  /** Anything in flight for a save stops counting, and what can still be stopped is. */
  function dropAttempt(): void {
    attempt++
    claimWork?.abort()
    claimWork = null
    if (access.at === 'save') { closeAccess(); abandonAuth() }
  }

  /** The claim itself. Called only with the account the visitor just chose and the same guest still connected. */
  async function claimNow(run: number, memberId: MemberId, character: GuestCharacter | null, user: AccountUser): Promise<void> {
    if (hooks.status()?.memberId !== memberId || !hooks.claimAvailable()) { fail('service', 'This guest is no longer the one connected, so nothing was saved.'); return }
    const work = new AbortController()
    claimWork = work
    claim.value = { kind: 'claiming' }
    let result: GuestClaimResult
    chosen = user
    try { result = await hooks.claimGuest(user, work.signal) } finally { if (claimWork === work) claimWork = null }
    // A definite answer: whatever an earlier save did, this one says it.
    uncertainHere.value = false
    held.value++
    // A late answer for an attempt the visitor left (cancel, sign-out) changes nothing on screen.
    // If the service had already saved it, the session controller says so in its own sentence.
    if (run !== attempt) return
    // The member keeps its id through a claim, so the character named is the one that was on screen.
    // This says who owns it now. Whether the account's world is open is the phase, not this.
    if (result.outcome === 'claimed') claim.value = { kind: 'claimed', character: result.memberId === memberId ? character : null }
    else claim.value = { kind: 'conflict', existing: result.existing, guestAfterSwitch: 'kept' }
  }

  async function save(): Promise<void> {
    const guest = session.value
    if (!guest || claim.value.kind === 'signing-in' || claim.value.kind === 'claiming') return
    // No claim is possible where the backend cannot take one or this page cannot sign anyone in.
    if (guest.signIn === 'unavailable' || !hooks.scope()) { fail('sign-in-unavailable'); return }
    const run = ++attempt
    const memberId = guest.status.memberId
    claim.value = { kind: 'signing-in' }
    try {
      const user = await hooks.currentUser()
      if (run !== attempt || hooks.status()?.memberId !== memberId) return
      // Signed in here already: named, and used only once confirmed (`continueAs`). Otherwise the form (`submitAccess`).
      openAccess('save', user)
    } catch (error) {
      if (run === attempt) failWith(error)
    }
  }

  /** Stop waiting for sign-in. A claim not yet sent is stopped; one the service already saved stays saved. */
  function cancel(): void {
    if (claim.value.kind !== 'signing-in') return
    const signingIn = access.at === 'save'
    dropAttempt()
    if (!signingIn) abandonAuth()
    claim.value = { kind: 'idle' }
  }

  /**
   * With the account the visitor chose. A connected guest is claimed, and nothing else is opened:
   * the claim's own answer decides what follows. Only a browser holding no guest opens the account's
   * own character.
   */
  async function proceed(at: 'welcome' | 'save', current: () => boolean, user: AccountUser): Promise<void> {
    const guest = session.value
    if (!guest) {
      // A saved character that could not be opened is shown by the recovery screen, from the controller's own sentence.
      try { await hooks.openAccount(user) }
      catch (error) { if (current() && hooks.welcome()) start.problem = hooks.failure() || messageOf(error) }
      finally { if (current()) { closeAccess(); start.signingIn = false } }
      return
    }
    const run = at === 'save' ? attempt : ++attempt
    closeAccess()
    if (at === 'welcome') { signInRun++; start.signingIn = false; go('/save') }
    try { await claimNow(run, guest.status.memberId, guest.character, user) } catch (error) { if (run === attempt) failWith(error) }
  }

  /**
   * Before an account is proved from the first screen: the guest this browser holds is opened, so
   * the account can only take that guest. False when it is held and could not be opened; nothing is sent then.
   */
  async function holdGuest(current: () => boolean): Promise<boolean> {
    if (session.value || !hooks.hasStoredGuest()) return true
    try { await hooks.resumeGuest() } finally { held.value++ }
    if (!current()) return false
    // Gone for good (ran out, or refused): the controller forgot it and says why. Still held and not open: stop.
    return Boolean(session.value) || !hooks.hasStoredGuest()
  }

  function heldUntil<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work
    return new Promise((resolve, reject) => {
      const stopped = (): void => { signal.removeEventListener('abort', stopped); reject(new WorldError('expired', 'Google sign-in expired or was cancelled. Load Google again to continue.')) }
      if (signal.aborted) { stopped(); void work.catch(() => undefined); return }
      signal.addEventListener('abort', stopped, { once: true })
      work.then(value => { signal.removeEventListener('abort', stopped); if (signal.aborted) stopped(); else resolve(value) }, error => { signal.removeEventListener('abort', stopped); reject(error) })
    })
  }

  /** Common to both ways of choosing: the request is marked running, and the held guest is open first. Null when stopped. */
  async function begin(signal?: AbortSignal): Promise<{ at: 'welcome' | 'save'; current: () => boolean } | null> {
    const at = access.at
    if (!at || access.pending) return null
    const run = at === 'save' ? attempt : signInRun
    const current = (): boolean => access.at === at && run === (at === 'save' ? attempt : signInRun)
    access.pending = true
    access.error = null
    if (!await heldUntil(holdGuest(() => current() && !signal?.aborted), signal)) {
      if (current()) throw new WorldError('unavailable', hooks.failure() || 'Your guest character could not be opened, so nothing was sent. Try again.')
      return null
    }
    if (session.value?.signIn === 'unavailable') throw new WorldError('unavailable', 'This host cannot save a guest to an account yet, so nothing was sent. Your guest character is unchanged.')
    return { at, current }
  }
  /** Set together, so the form keeps what was typed for another try. */
  function refuse(error: unknown, field?: 'email' | 'password'): void { access.error = { message: messageOf(error), ...(field ? { field } : {}) }; access.pending = false }

  /** The form's answer. Submitting it is choosing that account. The password is used for this one request and kept nowhere. */
  async function submitAccess(credentials: AccessCredentials): Promise<void> {
    if (!access.at || access.pending) return
    const characters = [...credentials.password].length
    const { min, max } = hooks.passwordBounds()
    if (characters > max || (credentials.mode === 'create' && characters < min)) { refuse(new Error(PASSWORD_RULE), 'password'); return }
    let step: Awaited<ReturnType<typeof begin>>
    try { step = await begin() } catch (error) { if (access.at) refuse(error); return }
    if (!step) return
    let user: AccountUser
    creating = credentials.mode === 'create'
    try {
      user = await hooks.authenticate(credentials.mode, credentials.email, credentials.password)
      if (!step.current()) return
    } catch (error) {
      if (step.current()) refuse(error)
      return
    }
    await proceed(step.at, step.current, user)
  }

  /** Passive readiness is separate from begin(): it opens no guest and marks no authentication pending. */
  async function prepareGoogleAccess(signal?: AbortSignal): Promise<GooglePreparedAttempt> {
    if (!googleAvailable.value || !access.at || access.existing || access.pending) throw new WorldError('unavailable', 'Google sign-in is not available on this form.')
    const at = access.at, run = at === 'save' ? attempt : signInRun
    const prepared = await hooks.prepareGoogleAuthentication(signal)
    if (signal?.aborted || access.at !== at || access.pending || run !== (at === 'save' ? attempt : signInRun)) {
      await prepared.cancel()
      throw new DOMException('The account form changed.', 'AbortError')
    }
    return prepared
  }
  /** The real Google click reserves the nonce first. Hold this guest before exchanging any callback. */
  async function submitGoogleAccess(collect: GoogleCredentialCollector, prepared?: GooglePreparedAttempt): Promise<void> {
    try {
      if (!googleAvailable.value || !access.at || access.pending) return
      const at = access.at, run = at === 'save' ? attempt : signInRun
      const selected = (): boolean => access.at === at && run === (at === 'save' ? attempt : signInRun)
      let step: Awaited<ReturnType<typeof begin>>
      try { step = await begin(prepared?.signal) } catch (error) { if (selected()) refuse(error); return }
      if (!step) return
      creating = false
      let user: AccountUser
      try {
        user = await hooks.authenticateGoogle(collect, prepared)
        if (!step.current()) return
      } catch (error) { if (step.current()) refuse(error); return }
      await proceed(step.at, step.current, user)
    } finally { if (prepared) await prepared.cancel() }
  }

  /** "Continue as <email>": the visitor confirmed the account already signed in here. */
  async function continueAs(): Promise<void> {
    const user = existingUser
    if (!user) return
    let step: Awaited<ReturnType<typeof begin>>
    try { step = await begin() } catch (error) { if (access.at) refuse(error); return }
    if (!step) return
    await proceed(step.at, step.current, user)
  }
  function useAnother(): void {
    if (!access.at || access.pending) return
    access.existing = null; existingUser = null; access.error = null
    refreshGoogleMetadata()
  }

  function cancelAccess(): void {
    if (access.at === 'save') cancel()
    else if (access.at === 'welcome') cancelSignIn()
  }

  /** Conflict, or its retry after the saved character could not be opened. */
  async function useSaved(): Promise<void> {
    if (claim.value.kind !== 'conflict' || busy.value) return
    const run = attempt
    busy.value = 'use-saved'
    try {
      await hooks.useSavedAccount(chosen ?? undefined)
      if (run !== attempt) return
      claim.value = { kind: 'idle' }
      go('/')
    } catch {
      // The account's world did not open. The guest session is still held but its connection is
      // closed, so the choice stays open on the recovery screen (`switchFailed`) with the
      // controller's own reason: try again, or go back to the guest.
    } finally { busy.value = null; held.value++ }
  }

  /** Conflict: stay a guest. Says play has resumed only once the guest is actually connected. */
  async function keepGuest(): Promise<void> {
    if (claim.value.kind !== 'conflict' || busy.value) return
    dropAttempt()
    if (session.value) {
      // The service changed nothing on a conflict and the guest is still connected: no call is needed.
      claim.value = { kind: 'idle' }
      go('/')
      return
    }
    busy.value = 'keep-guest'
    try {
      // Reopens the held session. A refusal ends at the first screen with the service's reason.
      await hooks.resumeGuest()
      claim.value = { kind: 'idle' }
      if (session.value) go('/')
    } catch (error) {
      toast(messageOf(error), 'bad')
    } finally { busy.value = null; held.value++ }
  }

  /** From an account session, or from an account that would not open: reopen the guest this browser holds. */
  async function returnToGuest(): Promise<void> {
    if (!storedGuest.value || session.value || busy.value) return
    dropAttempt()
    busy.value = 'keep-guest'
    try {
      // A refusal ends at the first screen with the service's reason; the guest is not said to be back until it is.
      await hooks.resumeGuest()
      claim.value = { kind: 'idle' }
      if (session.value) go('/')
    } catch (error) {
      toast(messageOf(error), 'bad')
    } finally { busy.value = null; held.value++ }
  }

  async function openSaved(): Promise<void> {
    if (!savedUnopened.value || busy.value) return
    busy.value = 'use-saved'
    // A failure leaves the recovery screen up with the controller's reason; nothing is said to be restored.
    try { await hooks.useSavedAccount(chosen ?? undefined) } catch { /* shown from the controller's own sentence */ } finally { busy.value = null }
    if (!savedUnopened.value || !canSignIn() || start.signingIn || access.at) return
    // Signed out on this device since the save, or another account is: only an explicit choice can
    // open it, so the form (or the account signed in, by name) is offered here.
    const run = signInRun
    let user: AccountUser | null
    try { user = await hooks.currentUser() } catch { return }
    if (run !== signInRun || !savedUnopened.value || access.at) return
    if (!user) openAccess('welcome')
    else if (chosen && user.userId !== chosen.userId) openAccess('welcome', user)
  }

  async function signOut(): Promise<void> {
    if (!account.value) return
    dropAttempt()
    claim.value = { kind: 'idle' }
    signInRun++
    start.signingIn = false
    start.problem = ''
    go('/')
    await hooks.signOutAccount()
    held.value++
  }

  function reset(): void {
    if (claim.value.kind === 'claimed' || claim.value.kind === 'failed') claim.value = { kind: 'idle' }
  }

  async function play(pass?: string): Promise<void> {
    if (start.pending || start.signingIn) return
    start.pending = true
    start.problem = ''
    // Whatever a save was doing belongs to the session that is being left.
    dropAttempt()
    claim.value = { kind: 'idle' }
    try {
      await hooks.startGuest(pass)
      // A start that ends back on the first screen did not work; the controller's reason is shown.
      if (hooks.welcome()) start.problem = hooks.failure() || 'The world did not start a guest. Try again.'
    } catch (error) { start.problem = messageOf(error) } finally { start.pending = false; held.value++ }
  }

  async function signIn(): Promise<void> {
    if (!canSignIn() || start.pending || start.signingIn) return
    const run = ++signInRun
    const current = (): boolean => run === signInRun
    start.signingIn = true
    start.problem = ''
    try {
      const user = await hooks.currentUser()
      if (!current()) return
      // Signed in here already: named, and used only once confirmed (`continueAs`). Otherwise the form (`submitAccess`).
      openAccess('welcome', user)
    } catch (error) {
      if (current()) { start.problem = messageOf(error); start.signingIn = false }
    }
  }
  function cancelSignIn(): void {
    signInRun++
    start.signingIn = false
    if (access.at === 'welcome') closeAccess()
    abandonAuth()
  }

  function dispose(): void {
    stopGoogleMetadata(); claimWork?.abort(); claimWork = null
    attempt++; signInRun++
    const wasOpen = access.at !== null
    closeAccess()
    if (wasOpen) void hooks.cancelAuthentication()
  }

  function reloadBlockers(): ReloadContext {
    if (transfer.stage === 'receiving' || transfer.stage === 'confirm' || transfer.stage === 'opening') return { critical: 'Finish or cancel moving your character here first.' }
    if (start.pending) return { critical: 'Wait for your guest character to start.' }
    // Checking for an account before the form opens, or a save on its way: the service is deciding.
    const deciding = claim.value.kind === 'claiming' || ((claim.value.kind === 'signing-in' || start.signingIn) && !access.at)
    if (busy.value || access.pending || app.authWork > 0 || deciding) return { critical: 'Wait for sign-in or saving your character to finish.' }
    // A save that got no answer is settled, but may have gone through. A reload is safe once this
    // device keeps the guest and a note to check it with the same account afterwards.
    if (claimUncertain.value && !hooks.claimRecoveryKept()) return { critical: 'This device could not keep your guest character and its unfinished save, so a reload now would lose them. Keep this page open and check your save first.' }
    if (access.at) return { activity: 'Finish or close the sign-in before updating.' }
    return {}
  }

  return {
    session, claim, busy, welcome, start, ended, storedGuest, returnable, account, savedUnopened, switchFailed,
    access, claimUncertain, googleAvailable, prepareGoogleAccess, submitGoogleAccess, dispose, passwordPolicy: () => ({ minLength: hooks.passwordBounds().min, hint: PASSWORD_RULE }),
    submitAccess: credentials => { void submitAccess(credentials) }, continueAs: () => { void continueAs() }, useAnother, cancelAccess,
    admission: () => hooks.admission(), canSignIn,
    save: () => { void save() }, cancel, useSaved: () => { void useSaved() }, keepGuest: () => { void keepGuest() }, reset,
    play, signIn, cancelSignIn, returnToGuest, openSaved, signOut, reloadBlockers,
  }
}
