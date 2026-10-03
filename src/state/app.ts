// App state and the session controller: sign-in, the service link, and shared reactive state.
import { reactive } from 'vue'
import type { MemberId } from '../shared/ids.ts'
import { WorldError } from '../shared/model.ts'
import type { MemberProfile, PublicMember } from '../shared/model.ts'
import type { OpName, Ops, ServerEvent } from '../shared/protocol.ts'
import { connectGuestService, connectHostedService, connectLocalService, listLocalActors } from '../platform/gateway.ts'
import type { Gateway, LinkState, LocalActorInfo } from '../platform/gateway.ts'
import { hostedWorldConfig, localActorKey, runtimeMode, setLocalActorKey } from '../platform/runtime.ts'
import type { HostedWorldSetup } from '../platform/runtime.ts'
import { accountApi } from '../platform/account.ts'
import type { AccountApi, AccountUser, CancelResult, GoogleCredentialCollector, GooglePreparedAttempt } from '../platform/account.ts'
import { openGuest, storedGuest, forgetGuest, guestRequest, submitGuestClaim, guestStorageScope, storedSessionChoice, rememberSessionChoice } from '../platform/guestService.ts'
import { UpdateRequiredError, openHostedWorldSession } from '../platform/hostedService.ts'
import { takeTransfer } from '../platform/transferFragment.ts'
import type { CapturedTransfer } from '../platform/transferFragment.ts'
import { TRANSFER_KEPT, consumeTransfer, deviceHeld, restoreDevice, transferReplaces } from '../platform/guestTransfer.ts'
import type { DeviceHeld, ReceivedGuest } from '../platform/guestTransfer.ts'
import type { GuestStatus, GuestClaimResult } from '../shared/guest.ts'

export interface Toast { id: number; text: string; tone: 'info' | 'good' | 'bad'; action?: { label: string; run(): void } }

export type Phase =
  | 'booting'
  | 'guest-welcome'
  | 'ready'
  /** Local dev server is up but the world service is not answering. */
  | 'service-down'
  | 'unsupported'
  | 'replaced'
  /**
   * The world could not be opened because the service runs a newer build of this App than this page.
   * Only at start-up: a page already playing stays 'ready' and learns it from `link`, so nothing
   * mounted is thrown away. Either way only the member reloads; no session is dropped or swapped.
   */
  | 'update-required'
  | 'failed'

export const app = reactive({
  pendingCalls: 0,
  mode: runtimeMode(),
  phase: 'booting' as Phase,
  failure: '',
  link: 'connecting' as LinkState,
  actors: [] as LocalActorInfo[],
  actorKey: 'a',
  /** The account whose character is open. Never a guest, and never taken from anything but the server's answer. */
  hosted: null as AccountUser | null,
  guest: null as GuestStatus | null,
  guestPersisted: false,
  guestEnded: null as 'expired' | 'refused' | null,
  claimReconnectPending: false,
  claimAvailable: false,
  /** Account requests running outside the forms (sign-out, cancelling a sign-in): a reload would cut them off. */
  authWork: 0,
  me: null as MemberProfile | null,
  reviewer: false,
  blocked: [] as PublicMember[],
  unread: 0,
  /** Game points from play. Not credits, not money. */
  points: null as number | null,
  toasts: [] as Toast[],
  /** Bumped when the service says a list changed, so open pages reload it. */
  changed: { intros: 0, friends: 0, communities: 0, meetups: 0, homes: 0, quotes: 0, listings: 0, matches: 0, notifications: 0 },
})

/**
 * A guest character being moved here from the world's old address. Only what the screen shows:
 * the service's dates for the character and what it would replace here. The capability itself is
 * never in reactive state.
 */
export const transfer = reactive({
  stage: 'none' as 'none' | 'receiving' | 'confirm' | 'opening' | 'failed',
  replaces: { guest: false, account: false },
  /** This device changed (another tab) while the question was open, so it is being asked again. */
  changed: false,
  startedAt: null as string | null,
  message: '',
  /** The old address, where the move can be started again. Null when it is this page. */
  retryFrom: null as string | null,
})
/** The moved guest's capability, in memory only, until the person confirms or declines. */
let received: ReceivedGuest | null = null
/** Exactly what this device held when the question was asked: the guest capability and the session choice. Private, never reactive or shown. */
let askedAgainst: DeviceHeld | null = null
/** The recovery marker (the guest an unfinished save named) as it was when the question was asked. Private, never reactive or shown. A marker is not part of `DeviceHeld`, so it is kept beside it. */
let askedRecovery: MemberId | null = null

let gateway: Gateway | null = null
let hostedAuthCleanup: (() => void) | null = null
let bootGeneration = 0
let guestToken: string | null = null
let guestScope: string | null = null
let sessionWork = new AbortController()
let accounts: AccountApi | null = null
/** This world's own accounts. Null where no hosted world is configured. */
function account(): AccountApi | null {
  const config = hostedWorldConfig()
  if (!config) return null
  return accounts ??= accountApi(config)
}
const eventListeners = new Set<(event: ServerEvent) => void>()
const reconnectListeners = new Set<() => void>()
let toastId = 1

export function toast(text: string, tone: Toast['tone'] = 'info', action?: Toast['action']): void {
  const id = toastId++
  app.toasts.push({ id, text, tone, action })
  setTimeout(() => dismissToast(id), action ? 9000 : 5200)
}
export function dismissToast(id: number): void {
  const index = app.toasts.findIndex(entry => entry.id === id)
  if (index >= 0) app.toasts.splice(index, 1)
}

/** Message fit to show a member, whatever was thrown. */
export function messageOf(error: unknown): string {
  if (error instanceof WorldError) return error.message
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong. Try again.'
}

let seatedOperationGuard: (() => boolean) | null = null
const FOOT_ROOM_OPERATIONS: ReadonlySet<OpName> = new Set(['room.enter', 'room.move', 'room.leave', 'table.watch', 'travel.book', 'member.setBrowsing'])
/** Presentation guard only. The service still validates every operation and owns transfers. */
export function setSeatedOperationGuard(guard: () => boolean): () => void {
  seatedOperationGuard = guard
  return () => { if (seatedOperationGuard === guard) seatedOperationGuard = null }
}

/** Call the world service. Throws WorldError; callers decide how to show it. */
export async function api<K extends OpName>(op: K, input: Ops[K]['in']): Promise<Ops[K]['out']> {
  if (FOOT_ROOM_OPERATIONS.has(op) && seatedOperationGuard?.()) throw new WorldError('conflict', 'Exit your vehicle safely before walking, entering a room or starting other travel.')
  const link = gateway, generation = bootGeneration
  if (!link) throw new WorldError('unavailable', 'The shared world service is not connected in this build.')
  app.pendingCalls++
  try {
    const result = await link.call(op, input)
    if (gateway !== link || generation !== bootGeneration) throw new DOMException('The current session changed.', 'AbortError')
    return result
  } catch (error) {
    if (gateway !== link || generation !== bootGeneration) throw new DOMException('The current session changed.', 'AbortError')
    throw error
  } finally { app.pendingCalls-- }
}

/** Call the service and show a toast on failure. Resolves to null when it failed. */
export async function attempt<K extends OpName>(op: K, input: Ops[K]['in'], success?: string): Promise<Ops[K]['out'] | null> {
  const link = gateway, generation = bootGeneration
  try {
    const result = await api(op, input)
    if (gateway !== link || generation !== bootGeneration) return null
    if (success) toast(success, 'good')
    return result
  } catch (error) {
    if (gateway === link && generation === bootGeneration) toast(messageOf(error), 'bad')
    return null
  }
}

export function onServerEvent(listener: (event: ServerEvent) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}
/** Runs after the link comes back, so rooms can be re-entered and lists reloaded. */
export function onReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener)
  return () => reconnectListeners.delete(listener)
}

export const myId = (): MemberId | null => app.me?.id ?? null

function handleEvent(event: ServerEvent): void {
  if (event.type === 'notify.new') { app.unread = event.unread; app.changed.notifications++ }
  else if (event.type === 'notify.changed') { app.unread = event.unread; app.changed.notifications++ }
  else if (event.type === 'social.changed') app.changed[event.scope]++
  else if (event.type === 'match.changed') { app.changed.matches++; void refreshPoints() }
  for (const listener of eventListeners) listener(event)
}

export async function refreshPoints(): Promise<void> {
  const link = gateway, generation = bootGeneration
  if (!link) return
  try {
    const { career } = await link.call('work.career', {})
    if (gateway === link && generation === bootGeneration) app.points = career.points
  } catch { /* keeps the last known value for this session */ }
}

export async function refreshMe(): Promise<void> {
  const result = await api('member.me', {})
  app.me = result.profile
  app.reviewer = result.reviewer
  app.blocked = result.blocked
}

async function startLocal(): Promise<void> {
  app.actorKey = localActorKey()
  try { app.actors = await listLocalActors() } catch { app.phase = 'service-down'; app.failure = 'The local world service is not answering on this dev server.'; return }
  if (!app.actors.some(actor => actor.key === app.actorKey)) app.actorKey = app.actors[0]?.key ?? 'a'
  gateway?.close()
  const link = connectLocalService(app.actorKey)
  gateway = link
  let wasOnline = false
  link.onEvent(handleEvent)
  link.onState((state, detail) => {
    if (gateway !== link) return
    app.link = state
    if (state === 'replaced') { app.phase = 'replaced'; app.failure = detail; return }
    if (state === 'denied') { app.phase = 'failed'; app.failure = detail; return }
    if (state === 'online') {
      if (wasOnline) {
        void refreshMe().then(() => { for (const listener of reconnectListeners) listener() }).catch(() => undefined)
        toast('Back online. Your place in the world was restored.', 'good')
      }
      wasOnline = true
    }
  })
  try {
    await refreshMe()
    const inbox = await api('notify.list', { includeRead: false })
    app.unread = inbox.unread
    void refreshPoints()
    app.phase = 'ready'
  } catch (error) {
    app.phase = 'service-down'
    app.failure = messageOf(error)
  }
}

export async function boot(): Promise<void> {
  const generation = resetSession()
  app.mode = runtimeMode()
  // Opened from the old address's transfer link: that comes first, and nothing is opened until the person chooses.
  const moving = takeTransfer()
  if (moving.kind !== 'none') { await receiveTransfer(moving, generation); return }
  if (app.mode === 'local') { await startLocal(); return }
  const config = hostedWorldConfig(), api = account()
  if (app.mode !== 'hosted' || !config || !api) { app.phase = 'unsupported'; return }
  const token = currentGuest()
  const choice = storedSessionChoice(config)
  if (choice === 'welcome') { app.phase = 'guest-welcome'; return }
  if (choice !== 'account' && token) { await startGuestSession({ token }); return }
  try {
    const user = await api.me(sessionWork.signal)
    if (generation !== bootGeneration) return
    if (user) { await bootAccount(generation); return }
    app.phase = 'guest-welcome'
    if (choice === 'account') app.failure = 'Sign in again to open your saved character. Your guest is still kept if you had one.'
  } catch (error) {
    if (generation !== bootGeneration) return
    app.phase = 'guest-welcome'; app.failure = messageOf(error)
  }
}

/**
 * Opens the signed-in account's own character. The socket's first frame is where the service makes
 * one for a new account, so a held guest is claimed before this, never after. With `expected`, only
 * that account is opened: the one the visitor chose on this screen.
 */
async function bootAccount(generation: number, expected?: Pick<AccountUser, 'userId' | 'accountId'>): Promise<void> {
  try {
    const config = hostedWorldConfig(), api = account()
    if (!config || !api) throw new Error('This build has no hosted world to open.')
    // Always confirm the live session; a saved preference is never identity proof.
    const identity = await api.me(sessionWork.signal)
    if (generation !== bootGeneration) return
    if (!identity) throw new Error('You are signed out on this device. Sign in again to open your saved character.')
    if (expected && (identity.userId !== expected.userId || identity.accountId !== expected.accountId)) throw new Error('The account signed in on this device is not the one you chose. Nothing was opened. Sign in again.')
    app.hosted = identity
    app.guest = null
    const link = connectHostedService(config, identity, api.issuer)
    gateway = link
    let wasOnline = false
    link.onEvent(event => { if (gateway === link) handleEvent(event) })
    link.onState((state, detail) => {
      if (gateway !== link) return
      app.link = state
      if (state === 'denied' || state === 'replaced') { app.phase = state === 'replaced' ? 'replaced' : 'failed'; app.failure = detail }
      if (state === 'online') {
        if (wasOnline) void link.call('member.me', {}).then(result => {
          if (gateway !== link || generation !== bootGeneration) return
          app.me = result.profile; app.blocked = result.blocked; app.reviewer = result.reviewer
          for (const listener of reconnectListeners) listener()
        }).catch(() => undefined)
        wasOnline = true
      }
    })
    hostedAuthCleanup = api.onChange(user => {
      if (user?.userId === identity.userId && user.accountId === identity.accountId) return
      resetSession()
      rememberSessionChoice(config, 'welcome')
      app.phase = 'guest-welcome'; app.failure = 'Your session ended, or the account on this device changed. Sign in again to open your saved character.'
    })
    const result = await link.call('member.me', {})
    if (generation !== bootGeneration || gateway !== link) return
    app.me = result.profile; app.reviewer = result.reviewer; app.blocked = result.blocked
    const inbox = await link.call('notify.list', { includeRead: false })
    if (generation !== bootGeneration || gateway !== link) return
    app.unread = inbox.unread
    rememberSessionChoice(config, 'account')
    app.claimReconnectPending = false
    // The account's own character is the guest an unfinished save named: that save went through.
    if (app.me && claimRecovery() === app.me.id) clearClaimRecovery()
    app.phase = 'ready'
  } catch (error) {
    if (generation !== bootGeneration) return
    hostedAuthCleanup?.()
    hostedAuthCleanup = null
    gateway?.close()
    gateway = null
    app.phase = error instanceof UpdateRequiredError ? 'update-required' : 'failed'
    app.failure = messageOf(error)
  }
}

/** Switch local test member. Every piece of the previous member's state is dropped first. */
export async function switchLocalActor(key: string): Promise<void> {
  if (key === app.actorKey && app.phase === 'ready') return
  setLocalActorKey(key)
  for (const listener of resetListeners) listener()
  gateway?.close()
  gateway = null
  app.me = null
  app.reviewer = false
  app.blocked = []
  app.unread = 0
  app.points = null
  app.toasts = []
  app.phase = 'booting'
  await startLocal()
}

const resetListeners = new Set<() => void>()
/** Modules holding member-scoped state register here so an account switch clears them. */
export function onAccountReset(listener: () => void): () => void {
  resetListeners.add(listener)
  return () => resetListeners.delete(listener)
}


function resetSession(): number {
  const generation = ++bootGeneration
  sessionWork.abort(); sessionWork = new AbortController()
  // A sign-in or a code still on its way belongs to the session being left: it is never applied to the next one.
  accounts?.abandon()
  hostedAuthCleanup?.(); hostedAuthCleanup = null
  gateway?.close(); gateway = null
  for (const listener of resetListeners) listener()
  app.me = null; app.hosted = null; app.guest = null; app.guestEnded = null; app.claimReconnectPending = false; app.guestPersisted = false; app.claimAvailable = false; app.blocked = []; app.reviewer = false
  app.unread = 0; app.points = null; app.toasts = []; app.failure = ''; app.phase = 'booting'
  return generation
}

/** `keep`: a refusal leaves this device's storage alone (a moved guest that did not open is not this device's guest). */
async function startGuestSession(input: { token: string } | { admission?: string }, refused: 'forget' | 'keep' = 'forget'): Promise<void> {
  const config = hostedWorldConfig()
  if (!config) throw new WorldError('unavailable', 'This build has no hosted guest service.')
  const generation = resetSession()
  try {
    const session = await openGuest(config, input, sessionWork.signal)
    if (generation !== bootGeneration) return
    guestToken = session.token; guestScope = guestStorageScope(config)
    rememberSessionChoice(config, 'guest')
    app.guest = session.status; app.guestPersisted = session.persisted
    app.claimAvailable = session.claimAvailable && accountAvailable()
    const link = connectGuestService(config, session.token)
    gateway = link
    let wasOnline = false
    link.onEvent(event => { if (gateway === link) handleEvent(event) })
    link.onState((state, detail) => {
      if (gateway !== link) return
      app.link = state
      if (state === 'denied' || state === 'replaced') { app.phase = state === 'replaced' ? 'replaced' : 'guest-welcome'; app.failure = detail }
      if (state === 'online') { if (wasOnline) for (const listener of reconnectListeners) listener(); wasOnline = true }
    })
    const result = await link.call('member.me', {})
    if (generation !== bootGeneration || gateway !== link) return
    app.me = result.profile; app.blocked = result.blocked; app.reviewer = false
    const inbox = await link.call('notify.list', { includeRead: false })
    if (generation !== bootGeneration || gateway !== link) return
    app.unread = inbox.unread; app.phase = 'ready'
  } catch (error) {
    if (generation !== bootGeneration) return
    gateway?.close(); gateway = null
    // An out-of-date page is not a refused guest: the session this browser holds is kept for the reload.
    if (error instanceof UpdateRequiredError) { app.phase = 'update-required'; app.failure = error.message; return }
    if (refused === 'forget' && error instanceof WorldError && (error.code === 'expired' || error.code === 'unauthorized' || error.code === 'forbidden')) {
      guestToken = null; forgetGuest(config); rememberSessionChoice(config, 'welcome')
      // A save of this browser's guest got no answer before a reload. It may have gone through, which
      // would close this guest: say that, keep the note, and start nothing new by itself.
      if (claimRecovery()) { app.guestEnded = null; app.phase = 'guest-welcome'; app.failure = RECOVERY_REFUSED; return }
      app.guestEnded = error.code === 'expired' ? 'expired' : 'refused'
    }
    app.phase = 'guest-welcome'; app.failure = messageOf(error)
  }
}

/** Parent wires this to the explicit Play as guest action; never auto-issue on page load. */
export async function startGuest(admission?: string): Promise<void> {
  const token = currentGuest()
  await startGuestSession(token ? { token } : admission ? { admission } : {})
}

// ── A save that got no definite answer, kept across a reload ──
// Only the guest's member id is noted, under this world's guest scope: no capability, account or
// email. The guest capability itself stays where it already is. The note goes once the service gives
// a receipt for that guest, or the account opens as that character; nothing else clears it.
const RECOVERY_REFUSED = 'Your last save may have gone through before the page reloaded, so this guest can no longer be opened here. Sign in with the account you chose to open your character.'
const recoveryKey = (config: HostedWorldSetup): string => `nw:claim-uncertain:${guestStorageScope(config)}`
/** The guest an unfinished save named, if one is noted for this world. */
export function claimRecovery(): MemberId | null {
  const config = hostedWorldConfig()
  if (!config) return null
  try {
    const value = localStorage.getItem(recoveryKey(config))
    return value && /^m_guest_[A-Za-z0-9_-]+$/.test(value) ? value as MemberId : null
  } catch { return null }
}
function noteClaimRecovery(memberId: MemberId): void {
  const config = hostedWorldConfig()
  if (config) { try { localStorage.setItem(recoveryKey(config), memberId) } catch { /* not kept: the reload gate then stays closed */ } }
}
function clearClaimRecovery(): void {
  const config = hostedWorldConfig()
  if (config) { try { localStorage.removeItem(recoveryKey(config)) } catch { /* nothing to clear */ } }
}
/**
 * A reload now forgets nothing an unfinished save needs: this device stores the connected guest's
 * capability for this world, and the note names that guest. Read fresh each time; nothing is written.
 */
export function claimRecoveryKept(): boolean {
  const config = hostedWorldConfig(), memberId = app.guest?.memberId
  return Boolean(config && guestToken && memberId && storedGuest(config) === guestToken && claimRecovery() === memberId)
}

/**
 * The claim was sent and no definite answer came back. It may have been saved. The only way to know
 * is to ask again with the same guest and the same account: the service answers a repeated claim
 * with the same receipt and never saves a character twice.
 */
export class ClaimUncertainError extends WorldError {
  constructor() {
    super('unavailable', 'The world did not answer in time, so this save may already have gone through. Try again with the same account to find out; a character is never saved twice.')
    this.name = 'ClaimUncertainError'
  }
}

/**
 * The visitor chose `expected` on this screen: a fresh sign-in, or "Continue as" an account already
 * signed in here. The claim is made only for that account. Conflict keeps the current guest
 * unchanged. No account world is opened before the service's `claimed`.
 */
export async function claimGuest(expected: Pick<AccountUser, 'userId' | 'accountId'>, signal?: AbortSignal): Promise<GuestClaimResult> {
  const config = hostedWorldConfig(), api = account()
  if (!config || !api || !guestToken || !app.claimAvailable) throw new WorldError('unavailable', 'Saving to an account is not available on this host yet.')
  const issuer = api.issuer
  const generation = bootGeneration, token = guestToken, claiming = app.guest?.memberId ?? null
  const originalWork = sessionWork.signal
  const authWork = new AbortController()
  const cancellation = AbortSignal.any([originalWork, authWork.signal, ...(signal ? [signal] : [])])
  cancellation.throwIfAborted()
  let identity: AccountUser | null
  try { identity = await api.me(cancellation) }
  catch (error) {
    if (cancellation.aborted) throw error
    throw new WorldError('unavailable', 'Your account could not be confirmed. Your guest character has not changed. Sign in again and retry saving.')
  }
  cancellation.throwIfAborted()
  if (!identity) throw new WorldError('unauthorized', 'You are signed out on this device. Your guest character has not changed. Sign in and try again.')
  if (identity.userId !== expected.userId || identity.accountId !== expected.accountId) throw new WorldError('unauthorized', 'The account signed in on this device is not the one you chose, so nothing was saved. Your guest character has not changed.')
  if (generation !== bootGeneration) throw new WorldError('unauthorized', 'The current character changed.')
  const proved = identity
  const stopWatching = api.onChange(user => {
    if (user?.userId !== proved.userId || user.accountId !== proved.accountId) authWork.abort()
  })
  try {
    cancellation.throwIfAborted()
    let grant: Awaited<ReturnType<typeof openHostedWorldSession>>
    try { grant = await openHostedWorldSession(config, proved, issuer, cancellation) }
    catch (error) {
      // An out-of-date page is said as that, not as a failed sign-in. Nothing was claimed either way.
      if (cancellation.aborted || error instanceof UpdateRequiredError) throw error
      throw new WorldError('unavailable', 'The world could not verify this account. Your guest character has not changed.')
    }
    if (generation !== bootGeneration) throw new WorldError('unauthorized', 'The current character changed.')
    cancellation.throwIfAborted()
    let result: GuestClaimResult
    try { result = await submitGuestClaim(config, token, grant.token, cancellation) }
    catch (error) {
      // A definite refusal changed nothing. Anything else (no answer, cancelled, unavailable) may
      // have reached the service and been saved: nothing here can say it was not.
      if (error instanceof WorldError && error.code !== 'unavailable') throw error
      // Noted before anything else can happen, so a reload from here on still knows to check.
      if (claiming) noteClaimRecovery(claiming)
      throw new ClaimUncertainError()
    }
    if (generation !== bootGeneration) throw new WorldError('unauthorized', 'The current character changed.')
    if (result.outcome === 'claimed') {
      if (claimRecovery() === result.memberId) clearClaimRecovery()
      guestToken = null; forgetGuest(config)
      if (cancellation.aborted) {
        resetSession(); rememberSessionChoice(config, 'welcome'); app.phase = 'guest-welcome'
        app.failure = 'Your character was saved, but sign-in changed or was cancelled. Sign in again to open it.'
        return result
      }
      rememberSessionChoice(config, 'account')
      app.claimReconnectPending = true
      try { await useSavedAccount(proved) }
      catch (error) {
        if (!(error instanceof WorldError) || error.code !== 'unavailable') return result
        // The service already saved ownership. Reconnection failure cannot undo that receipt.
        app.claimReconnectPending = true
        app.failure = 'Your character was saved to your account, but the world could not reconnect. Try again to open your saved character.'
      }
    }
    return result
  } finally { stopWatching() }
}

export async function useSavedAccount(expected?: Pick<AccountUser, 'userId' | 'accountId'>): Promise<void> {
  const config = hostedWorldConfig()
  if (config) rememberSessionChoice(config, 'account')
  const generation = resetSession()
  await bootAccount(generation, expected)
  if (generation !== bootGeneration) throw new WorldError('unauthorized', 'The account session changed.')
  if (app.phase === 'update-required') throw new UpdateRequiredError()
  if (app.phase !== 'ready') throw new WorldError('unavailable', app.failure || 'The saved character could not be opened.')
}
function currentGuest(): string | null {
  const config = hostedWorldConfig()
  if (!config) return null
  return guestScope === guestStorageScope(config) && guestToken ? guestToken : storedGuest(config)
}
export function hasStoredGuest(): boolean { return currentGuest() !== null }
export async function resumeGuest(): Promise<void> {
  const token = currentGuest()
  if (!token) throw new WorldError('unauthorized', 'No guest character is saved in this browser.')
  await startGuestSession({ token })
}
export async function leaveGuest(): Promise<void> {
  const config = hostedWorldConfig(), token = currentGuest()
  if (config && token) await guestRequest(config, '/world/guest-revoke', { token }, sessionWork.signal)
  if (config) { forgetGuest(config); rememberSessionChoice(config, 'welcome') }
  guestToken = null; resetSession(); app.phase = 'guest-welcome'
}

/** Whether this page can sign anyone in: it is the hosted world's own origin. */
export function accountAvailable(): boolean { return account()?.available === true }
/** Who this device's session names, as the server records it. Null when signed out. */
export async function currentAccount(signal?: AbortSignal): Promise<AccountUser | null> {
  const api = account()
  return api ? api.me(signal) : null
}
/** Sign in or create an account. The password goes to the one request and is kept nowhere; no world is opened here. Resolves with the account the visitor just chose. */
export async function authenticate(mode: 'signin' | 'create', email: string, password: string): Promise<AccountUser> {
  const api = account()
  if (!api?.available) throw new WorldError('unavailable', 'Accounts are not available on this page.')
  return mode === 'create' ? api.signUp(email, password) : api.signIn(email, password)
}
/** Public capability only; this opens no world and claims no character. */
export async function googleAccountConfiguration(signal?: AbortSignal): Promise<{ clientId: string } | null> {
  const api = account()
  return api?.available ? api.googleConfiguration(signal) : null
}
/** Passive button readiness only. Does not hold a guest or change the current account. */
export async function prepareGoogleAuthentication(signal?: AbortSignal): Promise<GooglePreparedAttempt> {
  const api = account()
  if (!api?.available) throw new WorldError('unavailable', 'Accounts are not available on this page.')
  return api.prepareGoogle(signal)
}
/** The provider proves the chosen account. Guest possession and claim remain the controller's job. */
export async function authenticateGoogle(collect: GoogleCredentialCollector, prepared?: GooglePreparedAttempt): Promise<AccountUser> {
  const api = account()
  if (!api?.available) throw new WorldError('unavailable', 'Accounts are not available on this page.')
  return api.signInGoogle(collect, prepared)
}
/** The visitor stopped waiting. The server is asked to cancel that exact attempt; this resolves with its receipt, or without one. */
export async function cancelAuthentication(): Promise<CancelResult> {
  app.authWork++
  try { return await (accounts?.abandon() ?? Promise.resolve('none')) } finally { app.authWork-- }
}
/** Retry a cancel or sign-out the server has not confirmed. True when nothing is left owing. */
export async function settleAccount(): Promise<boolean> {
  app.authWork++
  try { return accounts ? await accounts.settle() : true } finally { app.authWork-- }
}
/** After a sign-in with no guest in this browser, for the account the visitor chose. One that holds a guest claims it first (claimGuest), so no empty account character is made beside it. */
export async function openAccount(expected: Pick<AccountUser, 'userId' | 'accountId'>): Promise<void> {
  if (hasStoredGuest()) throw new WorldError('conflict', 'This device holds a guest character. It is saved to the account before the account is opened.')
  await useSavedAccount(expected)
}

/** Local access ends before the server is asked to end this device's session; no automatic guest fallback. */
export async function signOutAccount(): Promise<void> {
  const config = hostedWorldConfig(), api = account()
  const generation = resetSession()
  if (config) rememberSessionChoice(config, 'welcome')
  app.phase = 'guest-welcome'
  if (!api) return
  app.authWork++
  let result: Awaited<ReturnType<AccountApi['signOut']>>
  try { result = await api.signOut() } finally { app.authWork-- }
  if (result === 'confirmed' || generation !== bootGeneration) return
  app.failure = result === 'unconfirmed'
    ? 'The world is closed on this device. The server could not confirm that it recorded the sign-out. Other devices are not signed out by this.'
    : 'The world is closed on this device, but the server could not be reached, so this browser may still be signed in. Sign-out is finished before the next sign-in here.'
}

// ── Moving a guest character here from the world's old address (contract 125) ──
// The order is fixed: spend the code, show what arrived, and only after the person confirms open it
// through the normal guest path, which is what stores it. A different guest or an account preference
// already on this device is never replaced without that choice. Nothing here signs anyone in or
// claims anything. A move that fails leaves this device as it was; the world still keeps the
// character and the browser it came from still holds access, but the old address may be down.

function failTransfer(message: string): void {
  received = null; askedAgainst = null; askedRecovery = null
  transfer.stage = 'failed'; transfer.message = message
}

async function receiveTransfer(moving: Exclude<CapturedTransfer, { kind: 'none' }>, generation: number): Promise<void> {
  const config = hostedWorldConfig()
  transfer.replaces = { guest: false, account: false }; transfer.changed = false; transfer.startedAt = null; transfer.message = ''
  transfer.retryFrom = config && config.audience !== (config.endpoint ?? config.audience) ? `${config.audience}/` : null
  if (app.mode !== 'hosted' || !config) { failTransfer('This page has no hosted world, so the transfer link was not used.'); return }
  if (moving.kind === 'malformed') { failTransfer(`The transfer link is incomplete, so it was not used. ${TRANSFER_KEPT}`); return }
  transfer.stage = 'receiving'
  let moved: ReceivedGuest
  try { moved = await consumeTransfer(config, moving.code, sessionWork.signal) }
  catch (error) { if (generation === bootGeneration) failTransfer(messageOf(error)); return }
  if (generation !== bootGeneration) return
  received = moved
  askedAgainst = deviceHeld(config); askedRecovery = claimRecovery()
  transfer.replaces = transferReplaces(askedAgainst, moved.token)
  transfer.startedAt = moved.status.createdAt
  transfer.stage = 'confirm'
}

/**
 * "Continue with this character". The answer counts only for exactly what this device held when it
 * was given. If the stored guest or the session choice changed in any way since (another tab), the
 * question is asked again about what is here now, and nothing is written or opened.
 */
export async function confirmTransfer(): Promise<void> {
  const config = hostedWorldConfig(), moved = received, asked = askedAgainst
  if (transfer.stage !== 'confirm' || !config || !moved || !asked) return
  const held = deviceHeld(config), recovery = claimRecovery()
  // Anything different since the question: the stored guest, the session choice, or the note of an unfinished save
  // (another tab may have written or removed it). Nothing is written or opened; the question is asked again about what is here now.
  if (held.guest !== asked.guest || held.choice !== asked.choice || recovery !== askedRecovery) {
    askedAgainst = held; askedRecovery = recovery
    transfer.replaces = transferReplaces(held, moved.token); transfer.changed = true
    return
  }
  received = null; askedAgainst = null; askedRecovery = null; transfer.changed = false
  transfer.stage = 'opening'
  await startGuestSession({ token: moved.token }, 'keep')
  if (app.phase === 'ready' && app.guest?.memberId === moved.status.memberId) {
    transfer.stage = 'none'; transfer.message = ''
    toast('Your character is here.', 'good')
    return
  }
  const reason = app.failure
  restoreDevice(config, held, moved.token)
  failTransfer(`${reason ? `${reason} ` : ''}The character did not open here, and this device was left as it was. ${TRANSFER_KEPT}`)
}

/** "Not now", "Keep what this device has", or carrying on after a failed move: the moved capability is dropped and the world opens as it would have. */
export async function leaveTransfer(): Promise<void> {
  if (transfer.stage === 'receiving' || transfer.stage === 'opening') return
  received = null; askedAgainst = null; askedRecovery = null
  transfer.stage = 'none'; transfer.message = ''; transfer.changed = false
  await boot()
}
