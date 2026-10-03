// Separate hosted HTTP/WebSocket listener. No imports from local identity or local transport.
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { WorldError } from '../src/shared/model.ts'
import { isGuestToken } from '../src/shared/guest.ts'
import type { MemberId } from '../src/shared/ids.ts'
import type { OpName, ServerFrame } from '../src/shared/protocol.ts'
import { createWorld } from './index.ts'
import type { Connection, Persistence } from './kernel.ts'
import { filePersistence } from './persist.ts'
import { ensureMember } from './members.ts'
import { registerGuests, scopeFromHosted, principalFromHosted } from './guests.ts'
import type { GuestActor } from './guests.ts'
import { createHostedIdentityAdapter, createHostedLease, serverRelative } from './hostedIdentity.ts'
import type { HostedBinding } from './hostedIdentity.ts'
import { ProviderError } from './accountProvider.ts'
import type { AccountProvider, ProviderCredential } from './accountProvider.ts'
import { CLEAR_SESSION_COOKIE, carriesSessionCookie, createAccountSessions } from './accountSessions.ts'
import type { AccountAttempt } from './accountSessions.ts'
import type { AccountSessionView } from './accountSessions.ts'
import { createAccountGrants } from './accountGrants.ts'
import { registerCreator } from './creator.ts'
import { prepareVehicleRoads } from './vehicles.ts'
import type { CreatorConfig } from './creator.ts'
import { registerLiveCounts } from './liveCounts.ts'

export type GuestAdmission = { kind: 'disabled' } | { kind: 'public' } | { kind: 'invite'; hashes: readonly string[] }
export interface HostedServerOptions {
  binding: HostedBinding
  guestAdmission: GuestAdmission
  /**
   * Omit for a guests-only host. The provider is the only way an account is ever proved, and the 32-byte
   * key seals each provider refresh token; the key must come from outside the state this world saves.
   */
  account?: { provider: AccountProvider; sessionKey: Uint8Array; maxSessions?: number }
  /** Optional, server-owned identity. Binding waits for this account's verified sign-in. */
  creator?: CreatorConfig
  state: { path: string } | { persistence: Persistence }
  maxConnections?: number
  now?: () => number
  /**
   * Off unless set. Only for a listener bound to loopback whose single way in is a separately
   * protected Cloudflare tunnel: rate buckets are then keyed by CF-Connecting-IP. See `hostedRequestSource`.
   */
  trustCloudflareLoopback?: boolean
}
interface AdmissionState { scope: string; invitations: Record<string, string>; tokens: Record<string, MemberId> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const BODY_LIMIT = 6144, FRAME_LIMIT = 256 * 1024, BUFFER_LIMIT = 1024 * 1024
const HTTP_PATHS = new Set(['/world/guest-session', '/world/guest-claim', '/world/guest-revoke', '/world/hosted-challenge', '/world/hosted-session', '/world/counts/snapshot', '/world/counts/view'])
// The only routes that read the session cookie. Same origin only: none of them ever answers with a CORS header.
const ACCOUNT_PATHS = new Set(['/world/account/attempt', '/world/account/signup', '/world/account/signin', '/world/account/cancel', '/world/account/google-config', '/world/account/google', '/world/account/me', '/world/account/grant', '/world/account/signout'])
// Root policy: a new password is 12 to 128 characters. Sign-in asks only for 1 to 128, so a password that was valid when it was set still works.
const NEW_PASSWORD_MIN = 12, PASSWORD_MAX = 128
// Pending sign-in work is bounded on its own, never by the connection limit: two players at a two-player cap can still renew.
const PENDING_AUTH = 4096
/** Shown to the page as `name`. The provider gives an email address and nothing else, and that is never a display name. */
const ACCOUNT_NAME = 'Allworld member'
function origin(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Hosted origins must be exact HTTPS origins.')
}
function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
  response.end(JSON.stringify(body))
}
function failure(response: ServerResponse, error: unknown): void {
  const code = error instanceof WorldError ? error.code : 'unavailable'
  const status = code === 'rate_limited' ? 429 : code === 'expired' ? 410 : code === 'invalid' ? 400 : code === 'unavailable' ? 503 : code === 'forbidden' ? 403 : 401
  reply(response, status, { code, message: error instanceof WorldError ? error.message : 'The service could not authorize this request.' })
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new WorldError('invalid', 'Use a JSON request.')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > BODY_LIMIT) throw new WorldError('invalid', 'The request is too large.')
    chunks.push(buffer)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new WorldError('invalid', 'Invalid JSON request.') }
  if (!object(parsed)) throw new WorldError('invalid', 'Use a request object.')
  return parsed
}
function fields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new WorldError('invalid', 'Unexpected request field.')
}

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * The key a request's rate buckets are counted under. It is a rate key and nothing else: no
 * header is identity, and authentication, Origin and admission never look at it.
 *
 * By default it is the socket's peer address and every forwarded header is ignored. Behind a
 * loopback tunnel that makes every visitor one caller, so with `trustCloudflare` set, a request
 * whose peer is loopback is keyed by its CF-Connecting-IP instead: exactly one value, a valid IP
 * address by `isIP`. Anything else (no header, a repeated header, a list, a zone id, a name)
 * keeps the peer's shared bucket, which is the conservative answer. A peer that is not loopback
 * never has its header read. X-Forwarded-For and every other forwarded header are never read.
 *
 * IPv6 addresses share a /64 bucket so address rotation within that prefix does not create
 * fresh allowances. This is a rate policy, not proof that a prefix belongs to one person.
 */
export function hostedRequestSource(request: Pick<IncomingMessage, 'headers' | 'socket'> & { headersDistinct?: IncomingMessage['headersDistinct'] }, trustCloudflare: boolean): string {
  const peer = request.socket.remoteAddress ?? 'unknown'
  if (!trustCloudflare || !LOOPBACK_PEERS.has(peer)) return peer
  const value = request.headers['cf-connecting-ip']
  const sent = request.headersDistinct?.['cf-connecting-ip']
  if (typeof value !== 'string' || (sent !== undefined && sent.length !== 1) || value.length > 45 || value.includes('%')) return peer
  const family = isIP(value)
  if (family === 4) return `cf:${value}`
  if (family !== 6) return peer
  // The URL parser writes an IPv6 address one way only, however it was spelled.
  let groups: string[]
  try { groups = new URL(`http://[${value}]`).hostname.slice(1, -1).split(':') } catch { return peer }
  const gap = groups.indexOf('')
  const full = gap < 0 ? groups : [...groups.slice(0, gap), ...Array<string>(9 - groups.length).fill('0'), ...groups.slice(gap + 1)].map(group => group || '0')
  return `cf:${full.slice(0, 4).join(':')}::/64`
}

/** Address limits protect unauthenticated entry; authenticated movement has its own peer bucket. */
export function limitHostedFrame(world: Pick<import('./kernel.ts').World, 'limit'>, from: string, connection: Pick<Connection, 'id' | 'memberId'> | null, capacity: number): void {
  world.limit('frames:global', capacity * 2000, 60_000)
  if (connection) world.limit(`frames:peer:${connection.id}:${connection.memberId}`, 2000, 60_000)
  else world.limit(`frames:prehello:${from}`, 60, 60_000)
}

export function createHostedWorldServer(options: HostedServerOptions) {
  const binding = Object.freeze({ ...options.binding })
  origin(binding.origin); origin(binding.audience)
  const scope = scopeFromHosted(binding)
  if (!binding.buildId || !binding.artifactId) throw new Error('An exact hosted build is required.')
  if (binding.guestAdmission !== undefined && (binding.guestAdmission !== 'public' && binding.guestAdmission !== 'invite' || options.guestAdmission.kind !== binding.guestAdmission)) throw new Error('Guest admission must match the reviewed hosted build.')
  const admission = Object.freeze(structuredClone(options.guestAdmission))
  const hashes = new Set(admission.kind === 'invite' ? admission.hashes : [])
  if ([...hashes].some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid playtest invitation hash.')
  const max = options.maxConnections ?? 1000
  if (!Number.isInteger(max) || max < 1 || max > 6000) throw new Error('Invalid connection limit.')
  const now = options.now ?? Date.now
  if (options.creator && !options.account) throw new Error('The creator requires configured accounts.')
  if (options.creator && options.creator.account.accountId !== options.account?.provider.issuer) throw new Error('The creator must be an account of the configured provider.')
  if (options.account && options.account.sessionKey.length !== 32) throw new Error('The session key must be exactly 32 bytes.')
  const store = 'path' in options.state ? filePersistence(options.state.path) : options.state.persistence
  const world = createWorld({ persistence: store, durableAcks: true, now })
  const runtime = { siteId: binding.siteId, packageId: binding.packageId, channel: binding.channel, buildId: binding.buildId }
  const scopeKey = JSON.stringify(scope)
  const previous = world.peek<AdmissionState>('hostedAdmission')
  if ((previous && previous.scope !== scopeKey) || (!previous && world.peek('members'))) {
    store.close?.()
    throw new Error('Use a separate hosted state file for this exact App and channel.')
  }
  world.scoped(() => { world.slice<AdmissionState>('hostedAdmission', () => ({ scope: scopeKey, invitations: {}, tokens: {} })); world.touch() })
  const guests = registerGuests(world, scope, { entry: admission.kind === 'disabled' ? 'closed' : 'open' })
  const sessions = options.account ? createAccountSessions(world, scope, options.account.provider, options.account.sessionKey, { now, ...(options.account.maxSessions ? { capacity: options.account.maxSessions } : {}) }) : null
  const grants = sessions ? createAccountGrants(binding, sessions, { now, capacity: PENDING_AUTH }) : null
  const adapter = sessions && grants ? createHostedIdentityAdapter(binding, { local: { redeem: grants.redeem, assertActive: sessions.assertActive }, now, capacity: PENDING_AUTH }) : null
  const provider = options.account?.provider ?? null
  const providerCalls = new AbortController()
  // The road data for vehicles is read and indexed here, once, before anything listens: no member's first request waits for it.
  // With no data, or data that fails its own checks, the world still starts; vehicles then say they are unavailable and why.
  const vehicleRoads = prepareVehicleRoads(world)
  if (!vehicleRoads.available) console.warn(`[hosted-world] vehicles are unavailable: ${vehicleRoads.reason}`)
  const creator = registerCreator(world, options.creator ? { guests, config: options.creator } : null)
  const counts = registerLiveCounts(world)
  try { world.flush() } catch (error) {
    // Nothing is published yet: no socket, no timer of this listener, no answer. A host that catches
    // this must be left with nothing alive, so the start is undone: the identity adapter is closed,
    // and the world is closed, which ends its save retries and tries the write once more; if that
    // fails as well, the store nobody ever used is let go directly. The first error is the one thrown.
    const undo = (step: () => void): void => { try { step() } catch (failure) { console.error('[world] undoing a start that failed also failed', failure) } }
    undo(() => { providerCalls.abort(); adapter?.close(); grants?.close(); sessions?.close() })
    undo(() => { try { world.close() } catch { store.close?.() } })
    throw error
  }
  const sockets = new WebSocketServer({ noServer: true, maxPayload: FRAME_LIMIT, perMessageDeflate: false })
  const peers = new Map<WebSocket, { memberId(): MemberId | null; guest: () => boolean; session(): string | null; end(): void; check(): void }>()
  // However a session ends (sign-out, a newer sign-in on the same cookie, the provider, expiry), its codes and sockets end with it.
  sessions?.onEnd(ref => { grants?.revokeRef(ref); for (const peer of peers.values()) if (peer.session() === ref) peer.end() })
  let stopped = false
  let attached: Server | null = null
  const ops = new Set(world.registered())
  const isOp = (value: unknown): value is OpName => typeof value === 'string' && ops.has(value)
  // Forwarded headers are ignored unless the deployment opted in; then one of them is read, from a loopback peer only.
  const trustCloudflare = options.trustCloudflareLoopback === true
  const source = (request: IncomingMessage): string => hostedRequestSource(request, trustCloudflare)
  function requireGuestAdmission(token: unknown): void {
    if (!isGuestToken(token)) throw new WorldError('unauthorized', 'This guest capability is invalid.')
    const memberId = world.peek<AdmissionState>('hostedAdmission')?.tokens[digest(token)]
    if (!memberId || admission.kind === 'disabled' || (admission.kind === 'invite' && !hashes.has(world.peek<AdmissionState>('hostedAdmission')?.invitations[memberId] ?? ''))) throw new WorldError('forbidden', 'This guest admission is no longer active.')
  }
  const admittedGuest = (actor: GuestActor): void => {
    if (admission.kind === 'disabled') throw new WorldError('forbidden', 'Guest play is closed.')
    if (admission.kind === 'invite') {
      const hash = world.peek<AdmissionState>('hostedAdmission')?.invitations[actor.memberId]
      if (!hash || !hashes.has(hash)) throw new WorldError('forbidden', 'This playtest invitation is no longer active.')
    }
    guests.assertActive(actor)
  }
  const requireAdapter = () => {
    if (!adapter) throw new WorldError('unavailable', 'Saving to an account is not available here yet.')
    return adapter
  }
  /** For the session's own browser only. `email` is private: it never reaches a member, a name, a world token or a log. */
  const accountUser = (session: AccountSessionView): { userId: string; accountId: string; name: string; email: string } => ({ userId: session.uid, accountId: session.issuer, name: ACCOUNT_NAME, email: session.email })
  const down = (): boolean => stopped || world.superseded || world.saveStats.lastError !== null
  /** One answer per kind of request whatever the address is: which addresses have accounts is not said here. */
  function accountRefusal(creating: boolean, error: unknown): WorldError {
    const refusal = error instanceof ProviderError ? error.refusal : 'unavailable'
    if (refusal === 'throttled') return new WorldError('rate_limited', 'Too many attempts. Wait a few minutes and try again.')
    if (refusal === 'unavailable') return new WorldError('unavailable', 'Accounts cannot be reached right now. Try again shortly.')
    if (!creating) return new WorldError('unauthorized', 'That email and password do not match an account.')
    if (refusal === 'weak-password') return new WorldError('invalid', 'Choose a longer, less common password.')
    return new WorldError('unauthorized', 'An account could not be created with that email. If you already have one, sign in instead.')
  }
  /**
   * The seven account routes. Nothing here creates a member: a sign-up makes a session, and the character is
   * decided later, at claim or at the socket's hello, exactly as before.
   */
  async function account(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.headers.origin !== binding.origin) throw new WorldError('forbidden', 'This App origin is not allowed.')
    const site = request.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin') throw new WorldError('forbidden', 'This request did not come from the App.')
    if (request.method !== 'POST') { reply(response, 405, { code: 'invalid', message: 'Use POST.' }); return }
    const cookie = request.headers.cookie
    // Whatever the server manages next, this browser is left without the cookie.
    if (path === '/world/account/signout') response.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
    const attemptId = (value: unknown): string => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new WorldError('invalid', 'Invalid sign-in attempt.')
      return value
    }
    if (stopped || world.superseded) throw new WorldError('unavailable', 'The world is shutting down.')
    if (!sessions || !grants || !provider) throw new WorldError('unavailable', 'Accounts are not available here yet.')
    const from = source(request)
    world.limit('http:global', 600, 60_000); world.limit(`http:${from}`, 180, 60_000)
    const input = await body(request)
    if (stopped) throw new WorldError('unavailable', 'The world is shutting down.')
    if (path === '/world/account/signout') {
      fields(input, [])
      // Tried even while an earlier save is failing: the session is unusable either way, and only a confirmed write is reported as done.
      if (!sessions.end(cookie).saved) throw new WorldError('unavailable', 'You are signed out on this device, but the server could not confirm it. Try again shortly.')
      reply(response, 200, { signedOut: true }); return
    }
    if (path === '/world/account/cancel') {
      fields(input, ['attemptId'])
      const id = attemptId(input.attemptId)
      world.limit(`account:cancel:${from}`, 60, 60_000)
      // Like sign-out, tried even while an earlier save is failing: the attempt and its session stop here either way.
      const cancelled = sessions.cancel(id, cookie)
      if (cancelled.clearCookie) response.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
      if (!cancelled.saved) throw new WorldError('unavailable', 'This sign-in is cancelled on this server, but it could not confirm it. Try again shortly.')
      reply(response, 200, { cancelled: true }); return
    }
    if (down()) throw new WorldError('unavailable', 'The world is shutting down.')
    if (path === '/world/account/me') {
      fields(input, [])
      const session = sessions.resolve(cookie)
      if (!session && carriesSessionCookie(cookie)) response.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
      reply(response, 200, session ? accountUser(session) : null); return
    }
    if (path === '/world/account/grant') {
      fields(input, ['challenge'])
      if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw new WorldError('invalid', 'Invalid sign-in challenge.')
      try {
        const session = sessions.resolve(cookie)
        if (!session) throw new WorldError('unauthorized', 'Sign in to continue.')
        world.limit(`account:grant:${session.ref}`, 30, 60_000)
        const authority = await sessions.fresh(session)
        if (down()) throw new WorldError('unavailable', 'The world is shutting down.')
        reply(response, 200, grants.issue({ authority, challenge: input.challenge })); return
      } catch (error) {
        if (error instanceof WorldError && error.code === 'unauthorized' && carriesSessionCookie(cookie)) response.setHeader('Set-Cookie', CLEAR_SESSION_COOKIE)
        throw error
      }
    }
    if (path === '/world/account/attempt') {
      fields(input, [])
      world.limit(`account:attempt:${from}`, 30, 60_000)
      reply(response, 200, sessions.issue()); return
    }
    if (path === '/world/account/google-config') {
      fields(input, [])
      world.limit(`account:google-config:${from}`, 30, 60_000)
      reply(response, 200, provider.google ? { clientId: provider.google.clientId } : null); return
    }
    fields(input, path === '/world/account/google' ? ['idToken', 'attemptId'] : ['email', 'password', 'attemptId'])
    // Spent by this request whatever happens next: an attempt makes one request, ever.
    const attempt = sessions.enter(attemptId(input.attemptId))
    try { await signIn(request, response, path, input, cookie, from, attempt) } finally { sessions.settle(attempt) }
  }
  async function signIn(request: IncomingMessage, response: ServerResponse, path: string, input: Record<string, unknown>, cookie: string | undefined, from: string, attempt: AccountAttempt): Promise<void> {
    if (!sessions || !provider) throw new WorldError('unavailable', 'Accounts are not available here yet.')
    const creating = path === '/world/account/signup'
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    // The password lives in this call and in the one request to the provider. It is never stored, logged or echoed.
    const password = input.password
    const google = path === '/world/account/google'
    const idToken = input.idToken
    if (google && (!provider.google || typeof idToken !== 'string' || idToken.length > 4096 || idToken.length < 100)) throw new WorldError('invalid', 'Google sign-in is not available or the credential is invalid.')
    if (!google && (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email))) throw new WorldError('invalid', 'Enter a valid email address.')
    if (!google && (typeof password !== 'string' || password.length < (creating ? NEW_PASSWORD_MIN : 1) || password.length > PASSWORD_MAX)) throw new WorldError('invalid', creating ? `Use a password of ${NEW_PASSWORD_MIN} to ${PASSWORD_MAX} characters.` : 'Enter your password.')
    // All before the provider is asked: every sign-up and sign-in leaves from this server's one address.
    world.limit(google ? `account:google:${from}` : creating ? `account:signup:${from}` : `account:signin:${from}`, creating ? 6 : 20, 5 * 60_000)
    if (!google) world.limit(`account:email:${digest(`${scopeKey}\n${email}`)}`, 8, 5 * 60_000)
    else world.limit(`account:google-token:${digest(typeof idToken === 'string' ? idToken : '')}`, 8, 5 * 60_000)
    world.limit('account:provider', 300, 60_000)
    const askedAt = now()
    let credential: ProviderCredential
    // The provider's own 8-second deadline applies; cancelling the attempt or stopping the world aborts it sooner.
    const signal = AbortSignal.any([providerCalls.signal, attempt.signal])
    try {
      if (google) {
        if (!provider.google || typeof idToken !== 'string') throw new WorldError('invalid', 'Google sign-in is not available.')
        credential = await provider.google.signIn({ idToken, nonce: typeof input.attemptId === 'string' ? input.attemptId : '', requestUri: binding.origin }, signal)
        world.limit(`account:google-uid:${digest(`${scopeKey}\n${credential.identity.uid}`)}`, 8, 5 * 60_000)
      } else {
        if (typeof password !== 'string') throw new WorldError('invalid', 'Enter your password.')
        credential = await (creating ? provider.signUp({ email, password }, signal) : provider.signIn({ email, password }, signal))
      }
    }
    catch (error) {
      if (!sessions.going(attempt)) throw sessions.cancelledError()
      if (error instanceof WorldError) throw error
      if (google && error instanceof ProviderError && error.refusal !== 'throttled' && error.refusal !== 'unavailable') throw new WorldError('unauthorized', 'Google sign-in was refused. You can try again or sign in with your password.')
      throw accountRefusal(creating, error)
    }
    // Cancelled, expired or closed while the provider answered: the answer opens nothing. A provider account that
    // sign-up created stays; it is not deleted and nothing here says it was undone.
    if (!sessions.going(attempt)) throw sessions.cancelledError()
    if (down()) throw new WorldError('unavailable', 'The world is shutting down.')
    // The page gave up while the provider was answering: no session is made for an answer nobody is waiting for.
    if (response.destroyed || request.socket.destroyed) return
    // `open` checks the attempt once more and saves before it returns; nothing awaits between it and the cookie.
    const opened = sessions.open(credential, cookie, askedAt, attempt)
    response.setHeader('Set-Cookie', opened.setCookie)
    reply(response, 200, accountUser(opened.view))
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'https://world.invalid')
      if (url.search || url.hash) { reply(response, 400, { code: 'invalid', message: 'Query parameters are not accepted.' }); return }
      if (url.pathname === '/world/health' && request.method === 'GET') {
        const healthy = !stopped && !world.superseded && world.saveStats.lastError === null
        reply(response, healthy ? 200 : 503, { ok: healthy, mode: 'hosted', buildId: binding.buildId, channel: binding.channel, guests: admission.kind, claimAvailable: adapter !== null })
        return
      }
      if (ACCOUNT_PATHS.has(url.pathname)) {
        try { await account(request, response, url.pathname) } catch (error) {
          // Account routes only: an unusable attempt is its own answer, so the page never mistakes it for a wrong password.
          if (error instanceof WorldError && error.code === 'conflict') { reply(response, 409, { code: 'conflict', message: error.message }); return }
          throw error
        }
        return
      }
      if (!HTTP_PATHS.has(url.pathname)) { reply(response, 404, { code: 'not_found', message: 'Not found.' }); return }
      if (stopped || world.superseded || world.saveStats.lastError !== null) throw new WorldError('unavailable', 'The world is shutting down.')
      if (request.headers.origin !== binding.origin) throw new WorldError('forbidden', 'This App origin is not allowed.')
      response.setHeader('Access-Control-Allow-Origin', binding.origin)
      response.setHeader('Vary', 'Origin')
      world.limit('http:global', 600, 60_000); world.limit(`http:${source(request)}`, 180, 60_000)
      if (request.method === 'OPTIONS') {
        if (request.headers['access-control-request-method'] !== 'POST'
          || (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').some(value => value.trim() !== 'content-type' && value.trim() !== '')) throw new WorldError('forbidden', 'Preflight is not allowed.')
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '300', 'Cache-Control': 'no-store' }); response.end(); return
      }
      if (request.method !== 'POST') { reply(response, 405, { code: 'invalid', message: 'Use POST.' }); return }
      const input = await body(request)
      if (stopped) throw new WorldError('unavailable', 'The world is shutting down.')
      const from = source(request)
      if (url.pathname === '/world/counts/snapshot') {
        fields(input, []); reply(response, 200, counts.snapshot()); return
      }
      if (url.pathname === '/world/counts/view') {
        fields(input, ['eventId', 'startedAt']); reply(response, 200, counts.view(input, from)); return
      }
      if (url.pathname === '/world/guest-session') {
        fields(input, ['token', 'admission'])
        if (admission.kind === 'disabled') throw new WorldError('forbidden', 'Guest play is closed.')
        if ('token' in input) {
          requireGuestAdmission(input.token)
          const resumed = guests.resume({ token: input.token, source: from })
          admittedGuest(resumed.actor); world.flush()
          reply(response, 200, { runtime, status: resumed.status, claimAvailable: adapter !== null }); return
        }
        let passHash = ''
        if (admission.kind === 'invite') {
          if (typeof input.admission !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.admission)) throw new WorldError('forbidden', 'A private playtest pass is required.')
          passHash = digest(input.admission)
          if (!hashes.has(passHash)) throw new WorldError('forbidden', 'This playtest pass is not valid.')
        }
        const issued = guests.issue({ source: from })
        world.scoped(() => {
          const state = world.slice<AdmissionState>('hostedAdmission', () => ({ scope: scopeKey, invitations: {}, tokens: {} }))
          if (passHash) state.invitations[issued.actor.memberId] = passHash
          state.tokens[digest(issued.session.token)] = issued.actor.memberId
          world.touch()
        })
        world.flush(); reply(response, 200, { runtime, ...issued.session, claimAvailable: adapter !== null }); return
      }
      if (url.pathname === '/world/guest-revoke') {
        fields(input, ['token']); const result = guests.revoke({ token: input.token, source: from })
        world.flush(); for (const peer of peers.values()) peer.check()
        reply(response, 200, result); return
      }
      if (url.pathname === '/world/hosted-challenge') {
        fields(input, []); reply(response, 200, { ...requireAdapter().challenge(binding.origin), runtime }); return
      }
      if (url.pathname === '/world/hosted-session') {
        fields(input, ['challengeId', 'code'])
        if (typeof input.challengeId !== 'string' || typeof input.code !== 'string') throw new WorldError('invalid', 'Incomplete identity exchange.')
        const result = await requireAdapter().exchange({ origin: binding.origin, challengeId: input.challengeId, code: input.code })
        if (stopped) throw new WorldError('unavailable', 'The world is shutting down.')
        // `serverTime`: this server's clock as the reply is built, so the page measures the token's lifetime against it.
        const timed = serverRelative(result.expiresAt, now())
        if (!timed) throw new WorldError('expired', 'The world session ran out before it could be sent. Sign in again.')
        reply(response, 200, { ...result, runtime, serverTime: timed.serverTime }); return
      }
      fields(input, ['token', 'accountToken'])
      if (!isGuestToken(input.token) || typeof input.accountToken !== 'string') throw new WorldError('invalid', 'Guest possession and account proof are required.')
      requireGuestAdmission(input.token)
      const actor = requireAdapter().consume(input.accountToken, binding.origin)
      // No ensureMember here: creating an account character before claiming causes a false conflict.
      const principal = principalFromHosted(actor.subject)
      const result = guests.claim({ token: input.token, principal, source: from })
      if (result.outcome === 'claimed') creator.signedIn(principal)
      world.flush()
      if (result.outcome === 'claimed') for (const peer of peers.values()) if (peer.guest() && peer.memberId() === result.memberId) peer.end()
      reply(response, 200, result)
    } catch (error) { failure(response, error) }
  }

  sockets.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    let connection: Connection | null = null
    let guest: GuestActor | null = null
    let lease: ReturnType<typeof createHostedLease> | null = null
    let hello = false, ended = false, lastId = 0, busy = false
    let sessionRef: string | null = null
    let deadline: ReturnType<typeof setTimeout> | null = null
    let lastSeen = now()
    const from = source(request)
    const helloTimer = setTimeout(() => end(), 8000)
    function end(): void {
      if (ended) return
      ended = true; lease?.close(); clearTimeout(helloTimer); if (deadline) clearTimeout(deadline)
      if (connection) { counts.disconnected(connection); world.disconnect(connection) }
      peers.delete(socket); socket.terminate()
    }
    function active(): void {
      if (ended || stopped || world.superseded || world.saveStats.lastError !== null) throw new Error('The socket is closed.')
      if (guest) admittedGuest(guest)
      else if (lease) lease.active()
      else throw new Error('Sign in first.')
    }
    function send(frame: ServerFrame | Record<string, unknown>): void {
      try { active() } catch { end(); return }
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > BUFFER_LIMIT) { end(); return }
      socket.send(JSON.stringify(frame))
    }
    function arm(): void {
      if (deadline) clearTimeout(deadline)
      if (lease) deadline = setTimeout(end, Math.max(0, lease.expiresAt - now()))
    }
    peers.set(socket, { memberId: () => connection?.memberId ?? null, guest: () => guest !== null, session: () => sessionRef, end, check: () => { try { if (hello) active(); if (now() - lastSeen > 65_000) end() } catch { end() } } })
    socket.on('message', (data, binary) => {
      if (ended) return
      void (async () => {
        if (binary || Buffer.byteLength(String(data)) > FRAME_LIMIT) throw new Error('Invalid frame.')
        limitHostedFrame(world, from, connection, max)
        let frame: unknown
        try { frame = JSON.parse(String(data)) } catch { throw new Error('Invalid frame.') }
        if (!object(frame) || typeof frame.t !== 'string') throw new Error('Invalid frame.')
        lastSeen = now()
        if (frame.t === 'hello') {
          if (hello || typeof frame.token !== 'string') throw new Error('Hello is accepted only once.')
          fields(frame, ['t', 'token', 'resume', 'caps']); hello = true
          if (isGuestToken(frame.token)) {
            requireGuestAdmission(frame.token)
            guest = guests.resume({ token: frame.token, source: from }).actor
            admittedGuest(guest); world.flush()
            connection = world.connect(guest.memberId, send, () => { setImmediate(end) })
            counts.connected(connection)
          } else {
            const identity = requireAdapter(); const actor = identity.consume(frame.token, binding.origin)
            lease = createHostedLease(identity, actor, binding.origin, now)
            sessionRef = actor.subject.installationId
            const principal = principalFromHosted(actor.subject)
            const memberId = guests.memberFor(principal)
            world.scoped(() => ensureMember(world, memberId, actor.name))
            const isOwner = creator.signedIn(principal)
            world.flush(); connection = world.connect(memberId, send, () => { setImmediate(end) })
            counts.connected(connection, isOwner)
            { const timed = serverRelative(lease.expiresAt, now()); if (!timed) { end(); return } arm(); send({ t: 'lease', ...timed }) }
          }
          clearTimeout(helloTimer); return
        }
        active()
        if (!connection) throw new Error('Hello is required.')
        if (frame.t === 'logout') { end(); return }
        if (frame.t === 'renew-begin') {
          fields(frame, ['t']); if (!lease || busy) throw new Error('Cannot renew this session.')
          world.limit(`renew:${connection.id}`, 6, 60_000)
          send({ t: 'renew-challenge', ...lease.begin() }); return
        }
        if (frame.t === 'renew') {
          fields(frame, ['t', 'challengeId', 'code'])
          if (!lease || busy || typeof frame.challengeId !== 'string' || typeof frame.code !== 'string') throw new Error('Invalid renewal.')
          busy = true
          try {
            const actor = await lease.renew(frame.challengeId, frame.code)
            active()
            if (guests.memberFor(principalFromHosted(actor.subject)) !== connection.memberId) throw new Error('Renewal changed the character.')
            { const timed = serverRelative(lease.expiresAt, now()); if (!timed) { end(); return } arm(); send({ t: 'lease', ...timed }) }
          } finally { busy = false }
          return
        }
        if (frame.t === 'ping') { fields(frame, ['t']); counts.seen(connection); if (guest) guests.receive(connection, guest, { t: 'ping' }); else world.receive(connection, { t: 'ping' }); return }
        if (frame.t !== 'req' || !Number.isSafeInteger(frame.id) || typeof frame.id !== 'number' || frame.id <= lastId || !isOp(frame.op)) throw new Error('Invalid operation frame.')
        fields(frame, ['t', 'id', 'op', 'input']); lastId = frame.id
        counts.seen(connection)
        const operation = { t: 'req', id: frame.id, op: frame.op, input: frame.input } as const
        if (guest) guests.receive(connection, guest, operation); else world.receive(connection, operation)
      })().catch(() => end())
    })
    socket.on('close', end); socket.on('error', end)
  })
  let ticks = 0
  const tick = setInterval(() => { if (!stopped) { world.tick(); for (const peer of peers.values()) peer.check(); if (++ticks % 60 === 0) sessions?.sweep() } }, 1000)
  const step = setInterval(() => { if (!stopped) world.step() }, 100)
  tick.unref(); step.unref()
  world.onSuperseded(() => stop())
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (stopped || world.superseded || world.saveStats.lastError !== null || request.url !== '/world/socket' || request.headers.origin !== binding.origin || sockets.clients.size >= max) { socket.destroy(); return }
      world.limit('upgrades:global', 300, 60_000); world.limit(`upgrade:${source(request)}`, 30, 60_000)
      sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
    } catch { socket.destroy() }
  }
  function stop(): void {
    if (stopped) return
    stopped = true; clearInterval(tick); clearInterval(step)
    if (attached) attached.off('upgrade', upgrade)
    for (const peer of peers.values()) peer.end()
    providerCalls.abort(); adapter?.close(); grants?.close(); sessions?.close(); sockets.close(); world.close()
  }
  return { world, guests, handle, stop, attach(server: Server) { if (attached) throw new Error('Hosted server already attached.'); attached = server; server.on('upgrade', upgrade) } }
}
