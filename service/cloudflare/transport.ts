// Native Durable Object transport. Admission and frame rules track hostedServer.ts.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { WorldError } from '../../src/shared/model.ts'
import { isGuestToken } from '../../src/shared/guest.ts'
import type { MemberId } from '../../src/shared/ids.ts'
import type { OpName, ServerFrame } from '../../src/shared/protocol.ts'
import { createWorld } from '../index.ts'
import { configureStreetCheckpoints, STREET_CHECKPOINT_MAX_MS } from '../streetEntry.ts'
import type { Connection, Persistence } from '../kernel.ts'
import { ensureMember } from '../members.ts'
import { registerGuests, scopeFromHosted, principalFromHosted } from '../guests.ts'
import type { GuestActor } from '../guests.ts'
import { createHostedIdentityAdapter, createHostedLease, serverRelative } from '../hostedIdentity.ts'
import type { HostedBinding } from '../hostedIdentity.ts'
import { registerCreator } from '../creator.ts'
import type { CreatorConfig } from '../creator.ts'
import { prepareVehicleRoads } from '../vehicles.ts'
import { registerLiveCounts } from '../liveCounts.ts'
import type { AccountProvider } from '../accountProvider.ts'
import { createAccountSessions } from '../accountSessions.ts'
import { createAccountGrants } from '../accountGrants.ts'
import { createGuestTransfers, guestTransferOrigins, GUEST_TRANSFER_PATHS } from '../guestTransfers.ts'
import { ACCOUNT_PATHS, boundedText, createAccountHttp } from './accountHttp.ts'

export type GuestAdmission = { kind: 'disabled' } | { kind: 'public' } | { kind: 'invite'; hashes: readonly string[] }
export interface CloudflareServerOptions {
  binding: HostedBinding
  guestAdmission: GuestAdmission
  /**
   * Standalone accounts. Omit for a guests-only world. The 32-byte key seals provider refresh tokens and transfer
   * capabilities; it is a Worker secret, never state, a build var or a static asset.
   */
  account?: { provider: AccountProvider; sessionKey: Uint8Array; maxSessions?: number }
  /** Exact legacy page origin. Its one route is the guest transfer start; requires `account` for the seal key. */
  transfer?: { legacyOrigin: string }
  /** Optional, server-owned identity. Binding waits for this account's verified sign-in. */
  creator?: CreatorConfig
  persistence: Persistence & { sync(): Promise<void> }
  waitUntil(promise: Promise<unknown>): void
  maxConnections?: number
  now?: () => number

}
interface AdmissionState { scope: string; invitations: Record<string, string>; tokens: Record<string, MemberId> }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const BODY_LIMIT = 6144, FRAME_LIMIT = 256 * 1024, BUFFER_LIMIT = 1024 * 1024
const COHORT_FRAMES = 32, COHORT_BYTES = 64 * 1024
// Pending sign-in work is bounded on its own, never by the connection limit: players at the cap can still renew.
const PENDING_AUTH = 4096
const HTTP_PATHS = new Set(['/world/guest-session', '/world/guest-claim', '/world/guest-revoke', '/world/hosted-challenge', '/world/hosted-session', '/world/counts/snapshot', '/world/counts/view'])
function origin(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Hosted origins must be exact HTTPS origins.')
}
function reply(response: ResponseDraft, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' })
  response.end(JSON.stringify(body))
}
function failure(response: ResponseDraft, error: unknown): void {
  const code = error instanceof WorldError ? error.code : 'unavailable'
  const status = code === 'rate_limited' ? 429 : code === 'expired' ? 410 : code === 'invalid' ? 400 : code === 'unavailable' ? 503 : code === 'forbidden' ? 403 : 401
  reply(response, status, { code, message: error instanceof WorldError ? error.message : 'The service could not authorize this request.' })
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new WorldError('invalid', 'Use a JSON request.')
  const reader = request.body?.getReader()
  if (!reader) throw new WorldError('invalid', 'Use a JSON request.')
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > BODY_LIMIT) { await reader.cancel(); throw new WorldError('invalid', 'The request is too large.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)) } catch { throw new WorldError('invalid', 'Invalid JSON request.') }
  if (!object(parsed)) throw new WorldError('invalid', 'Use a request object.')
  return parsed
}

/** The size TextEncoder would report, counted in place: an encoder and a copy per frame outlive every minor collection. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}

function fields(input: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new WorldError('invalid', 'Unexpected request field.')
}

// Only the native outer Worker supplies this header to its bound Durable Object.
// It is used for rate limiting, never for identity or guest admission.
export function cloudflareRequestSource(request: Request): string {
  const value = request.headers.get('x-world-source')
  if (!value || value.length > 45 || value.includes('%')) return 'unknown'
  const family = isIP(value)
  if (family === 4) return `cf:${value}`
  if (family !== 6) return 'unknown'
  let groups: string[]
  try { groups = new URL(`http://[${value}]`).hostname.slice(1, -1).split(':') } catch { return 'unknown' }
  const gap = groups.indexOf('')
  const full = gap < 0 ? groups : [...groups.slice(0, gap), ...Array<string>(9 - groups.length).fill('0'), ...groups.slice(gap + 1)].map(group => group || '0')
  return `cf:${full.slice(0, 4).join(':')}::/64`
}

class ResponseDraft {
  readonly headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store' })
  status = 200
  data: string | null = null
  /** Run after the durable barrier, before a 200 leaves: anything that changed during the wait refuses it. */
  verify: (() => void) | null = null
  destroyed = false
  writableEnded = false
  setHeader(name: string, value: string): void { this.headers.set(name, value) }
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value)
  }
  end(data?: string): void { this.data = data ?? null; this.writableEnded = true }
  response(): Response { return new Response(this.data, { status: this.status, headers: this.headers }) }
}

/** Address limits protect unauthenticated entry; authenticated movement has its own peer bucket. */
export function limitHostedFrame(world: Pick<import('../kernel.ts').World, 'limit'>, from: string, connection: Pick<Connection, 'id' | 'memberId'> | null, capacity: number): void {
  world.limit('frames:global', capacity * 2000, 60_000)
  if (connection) world.limit(`frames:peer:${connection.id}:${connection.memberId}`, 2000, 60_000)
  else world.limit(`frames:prehello:${from}`, 60, 60_000)
}

export function createCloudflareWorldServer(options: CloudflareServerOptions) {
  const binding = Object.freeze({ ...options.binding })
  origin(binding.origin); origin(binding.audience)
  const scope = scopeFromHosted(binding)
  if (!binding.buildId || !binding.artifactId) throw new Error('An exact hosted build is required.')
  if (binding.guestAdmission !== undefined && (binding.guestAdmission !== 'public' && binding.guestAdmission !== 'invite' || options.guestAdmission.kind !== binding.guestAdmission)) throw new Error('Guest admission must match the reviewed hosted build.')
  const admission = Object.freeze(structuredClone(options.guestAdmission))
  const hashes = new Set(admission.kind === 'invite' ? admission.hashes : [])
  if ([...hashes].some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid playtest invitation hash.')
  const max = options.maxConnections ?? 4
  if (!Number.isInteger(max) || max < 1 || max > 4) throw new Error('Invalid connection limit.')
  const now = options.now ?? Date.now
  if (options.creator && !options.account) throw new Error('The creator requires configured accounts.')
  if (options.creator && options.creator.account.accountId !== options.account?.provider.issuer) throw new Error('The creator must be an account of the configured provider.')
  if (options.account && options.account.sessionKey.length !== 32) throw new Error('The session key must be exactly 32 bytes.')
  if (options.transfer && !options.account) throw new Error('Guest transfer needs the configured seal key.')
  if (options.transfer) { origin(options.transfer.legacyOrigin); if (options.transfer.legacyOrigin === binding.origin) throw new Error('The legacy origin must differ from the serving origin.') }
  const store = options.persistence
  const world = createWorld({ persistence: store, durableAcks: true, now })
  // Ordinary street movement is saved in one checkpoint per 15 s here; entries, transitions and every other change stay immediate.
  configureStreetCheckpoints(world, { periodMs: STREET_CHECKPOINT_MAX_MS })
  const runtime = { siteId: binding.siteId, packageId: binding.packageId, channel: binding.channel, buildId: binding.buildId }
  const scopeKey = JSON.stringify(scope)
  const previous = world.peek<AdmissionState>('hostedAdmission')
  if ((previous && previous.scope !== scopeKey) || (!previous && world.peek('members'))) {
    store.close?.()
    throw new Error('Use a separate world object for this App and channel.')
  }
  world.scoped(() => { world.slice<AdmissionState>('hostedAdmission', () => ({ scope: scopeKey, invitations: {}, tokens: {} })); world.touch() })
  const guests = registerGuests(world, scope, { entry: admission.kind === 'disabled' ? 'closed' : 'open' })
  // Same factories as the Node listener; pending sign-in work is bounded on its own, never by the connection limit.
  const sessions = options.account ? createAccountSessions(world, scope, options.account.provider, options.account.sessionKey, { now, ...(options.account.maxSessions ? { capacity: options.account.maxSessions } : {}) }) : null
  const grants = sessions ? createAccountGrants(binding, sessions, { now, capacity: PENDING_AUTH }) : null
  const adapter = sessions && grants ? createHostedIdentityAdapter(binding, { local: { redeem: grants.redeem, assertActive: sessions.assertActive }, now, capacity: PENDING_AUTH }) : null
  const providerCalls = new AbortController()
  if (!prepareVehicleRoads(world).available) throw new Error('Trusted vehicle roads are unavailable.')
  const counts = registerLiveCounts(world)
  const creator = registerCreator(world, options.creator ? { guests, config: options.creator } : null)
  try { world.flush() } catch (error) {
    const undo = (step: () => void): void => { try { step() } catch { /* Initial storage error remains authoritative. */ } }
    undo(() => { providerCalls.abort(); adapter?.close(); grants?.close(); sessions?.close() })
    undo(() => { try { world.close() } catch { store.close?.() } })
    throw error
  }
  
  const peers = new Map<WebSocket, { memberId(): MemberId | null; guest: () => boolean; session(): string | null; end(): void; check(): void }>()
  // However a session ends (sign-out, cancel, a newer sign-in, the provider, expiry), its codes and sockets end with it.
  sessions?.onEnd(ref => { grants?.revokeRef(ref); for (const peer of peers.values()) if (peer.session() === ref) peer.end() })
  let stopped = false
  let activeConnections = 0
  let tick: ReturnType<typeof setInterval> | null = null
  let step: ReturnType<typeof setInterval> | null = null
  let persistenceFailed = false
  const ops = new Set(world.registered())
  const isOp = (value: unknown): value is OpName => typeof value === 'string' && ops.has(value)
  const source = cloudflareRequestSource
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
  const down = (): boolean => stopped || persistenceFailed || world.superseded || world.saveStats.lastError !== null
  const accounts = sessions && grants && options.account ? createAccountHttp({ binding, world, sessions, grants, provider: options.account.provider, scopeKey, now, signal: providerCalls.signal, sync, down }) : null
  const transfers = options.transfer && options.account ? createGuestTransfers({
    world, guests, legacyOrigin: options.transfer.legacyOrigin, targetOrigin: binding.origin, sealKey: options.account.sessionKey,
    admitted: token => requireGuestAdmission(token),
    // Native durability: the local write, then the latching barrier; the module rechecks superseded/lastError and the guest after it.
    sync: async () => { world.flush(); await sync() },
  }) : null
  async function handle(request: Request, response: ResponseDraft): Promise<void> {
    try {
      const url = new URL(request.url)
      if (url.search || url.hash) { reply(response, 400, { code: 'invalid', message: 'Query parameters are not accepted.' }); return }
      if (url.pathname === '/world/health' && request.method === 'GET') {
        const healthy = !stopped && !persistenceFailed && !world.superseded && world.saveStats.lastError === null
        reply(response, healthy ? 200 : 503, { ok: healthy, mode: 'hosted', transport: 'cloudflare', buildId: binding.buildId, channel: binding.channel, guests: admission.kind, claimAvailable: adapter !== null })
        return
      }
      if (!HTTP_PATHS.has(url.pathname)) { reply(response, 404, { code: 'not_found', message: 'Not found.' }); return }
      if (stopped || persistenceFailed || world.superseded || world.saveStats.lastError !== null) throw new WorldError('unavailable', 'The world is shutting down.')
      if (request.headers.get('origin') !== binding.origin) throw new WorldError('forbidden', 'This App origin is not allowed.')
      response.setHeader('Access-Control-Allow-Origin', binding.origin)
      response.setHeader('Vary', 'Origin')
      world.limit('http:global', 600, 60_000); world.limit(`http:${source(request)}`, 180, 60_000)
      if (request.method === 'OPTIONS') {
        if (request.headers.get('access-control-request-method') !== 'POST'
          || (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').some(value => value.trim() !== 'content-type' && value.trim() !== '')) throw new WorldError('forbidden', 'Preflight is not allowed.')
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '300', 'Cache-Control': 'no-store' }); response.end(); return
      }
      if (request.method !== 'POST') { reply(response, 405, { code: 'invalid', message: 'Use POST.' }); return }
      const input = await body(request)
      if (stopped) throw new WorldError('unavailable', 'The world is shutting down.')
      const from = source(request)
      if (url.pathname === '/world/counts/snapshot') { fields(input, []); reply(response, 200, counts.snapshot()); return }
      if (url.pathname === '/world/counts/view') { fields(input, ['eventId', 'startedAt']); reply(response, 200, counts.view(input, from)); return }
      if (url.pathname === '/world/guest-session') {
        fields(input, ['token', 'admission'])
        if (admission.kind === 'disabled') throw new WorldError('forbidden', 'Guest play is closed.')
        if ('token' in input) {
          const token = input.token
          requireGuestAdmission(token)
          const resumed = guests.resume({ token, source: from })
          admittedGuest(resumed.actor); world.flush()
          response.verify = () => { requireGuestAdmission(token); admittedGuest(resumed.actor) }
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
        response.verify = () => { requireGuestAdmission(issued.session.token); admittedGuest(issued.actor) }
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
      // The ownership is committed either way; a session ended during the wait gets no receipt and the page reconciles.
      response.verify = () => { requireAdapter().assertActive(actor) }
      if (result.outcome === 'claimed') for (const peer of peers.values()) if (peer.guest() && peer.memberId() === result.memberId) peer.end()
      reply(response, 200, result)
    } catch (error) { failure(response, error) }
  }

  function accept(socket: WebSocket, request: Request): void {
    let connection: Connection | null = null
    let guest: GuestActor | null = null
    let lease: ReturnType<typeof createHostedLease> | null = null
    let sessionRef: string | null = null
    let hello = false, ended = false, lastId = 0, busy = false, counted = false, replacing = false
    let queuedBytes = 0, inFlightBytes = 0
    const outbound: { text: string; bytes: number }[] = []
    let draining = false
    let sending = Promise.resolve()
    let receiving = Promise.resolve()
    let pendingFrames = 0, incomingBytes = 0
    let deadline: ReturnType<typeof setTimeout> | null = null
    let lastSeen = now()
    const from = source(request)
    const helloTimer = setTimeout(() => end(), 8000)
    function end(): void {
      if (ended) return
      ended = true; outbound.length = 0; queuedBytes = inFlightBytes
      lease?.close(); clearTimeout(helloTimer); if (deadline) clearTimeout(deadline)
      let disconnectFailed = false
      try { if (connection) { counts.disconnected(connection); world.disconnect(connection) } } catch { disconnectFailed = true }
      peers.delete(socket)
      // Idle flushes, so never inside the domain operation that may have ended this socket (send -> end). It runs after
      // that synchronous turn returns, and only if no peer joined meanwhile and the world was not stopped.
      if (counted) { counted = false; activeConnections--; if (activeConnections === 0 && !stopped) queueMicrotask(() => { if (activeConnections === 0 && !stopped) idle() }) }
      try { socket.close(1000, 'Reconnect to continue.'); } catch { /* Already closed. */ }
      if (disconnectFailed) stop()
    }
    function replace(): void {
      replacing = true
      if (deadline) clearTimeout(deadline)
      deadline = setTimeout(end, 1000)
      options.waitUntil(sending.then(end, end))
    }
    function active(): void {
      if (ended || stopped || persistenceFailed || world.superseded || world.saveStats.lastError !== null) throw new Error('The socket is closed.')
      if (guest) admittedGuest(guest)
      else if (lease) lease.active()
      else throw new Error('Sign in first.')
    }
    async function drain(): Promise<void> {
      while (!ended && outbound.length) {
        let length = 0, bytes = 0
        for (const frame of outbound) {
          if (length >= COHORT_FRAMES || (length > 0 && bytes + frame.bytes > COHORT_BYTES)) break
          bytes += frame.bytes; length++
        }
        // Freeze before the barrier. Later captures and ACKs stay in the next cohort.
        const cohort = outbound.splice(0, length)
        inFlightBytes = bytes
        try {
          await sync()
          active()
          if (socket.readyState !== WebSocket.OPEN) throw new Error('Closed socket.')
          for (const frame of cohort) socket.send(frame.text)
        } finally {
          queuedBytes -= bytes; inFlightBytes = 0
        }
      }
    }
    function kick(): void {
      if (draining || ended || outbound.length === 0) return
      draining = true
      sending = Promise.resolve().then(drain).catch(end).finally(() => {
        draining = false
        kick()
      })
      options.waitUntil(sending)
    }
    function send(frame: ServerFrame | Record<string, unknown>): void {
      try { active() } catch { end(); return }
      const text = JSON.stringify(frame)
      const bytes = utf8Length(text)
      queuedBytes += bytes
      if (socket.readyState !== WebSocket.OPEN || queuedBytes > BUFFER_LIMIT) { end(); return }
      outbound.push({ text, bytes })
      kick()
    }
    function arm(): void {
      if (deadline) clearTimeout(deadline)
      if (lease) deadline = setTimeout(end, Math.max(0, lease.expiresAt - now()))
    }
    peers.set(socket, { memberId: () => connection?.memberId ?? null, guest: () => guest !== null, session: () => sessionRef, end, check: () => { try { if (hello) active(); if (now() - lastSeen > 65_000) end() } catch { end() } } })
    socket.addEventListener('message', event => {
      if (ended || replacing) return
      const data = event.data
      if (typeof data !== 'string') { end(); return }
      const bytes = utf8Length(data)
      incomingBytes += bytes
      if (bytes > FRAME_LIMIT || incomingBytes > BUFFER_LIMIT || ++pendingFrames > 64) { end(); return }
      receiving = receiving.then(async () => {
        if (ended || replacing) return
        if (typeof data !== 'string' || utf8Length(data) > FRAME_LIMIT) throw new Error('Invalid frame.')
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
            admittedGuest(guest); world.flush(); await sync(); active()
            connection = world.connect(guest.memberId, send, replace)
            counts.connected(connection)
          } else {
            const identity = requireAdapter(); const actor = identity.consume(frame.token, binding.origin)
            lease = createHostedLease(identity, actor, binding.origin, now)
            sessionRef = actor.subject.installationId
            const principal = principalFromHosted(actor.subject)
            const memberId = guests.memberFor(principal)
            world.scoped(() => ensureMember(world, memberId, actor.name))
            const isOwner = creator.signedIn(principal)
            world.flush(); await sync(); active(); connection = world.connect(memberId, send, replace)
            counts.connected(connection, isOwner)
            { const timed = serverRelative(lease.expiresAt, now()); if (!timed) { end(); return } arm(); send({ t: 'lease', ...timed }) }
          }
          if (ended) { if (connection) world.disconnect(connection); return }
          clearTimeout(helloTimer); counted = true; activeConnections++; wake(); return
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
      }).catch(end).finally(() => { pendingFrames--; incomingBytes -= bytes })
      options.waitUntil(receiving)
    })
    socket.addEventListener('close', end); socket.addEventListener('error', end)
  }
  async function sync(): Promise<void> {
    if (persistenceFailed) throw new WorldError('unavailable', 'World storage is unavailable.')
    try { await store.sync() } catch {
      persistenceFailed = true
      stop()
      throw new WorldError('unavailable', 'World storage is unavailable.')
    }
  }
  function wake(): void {
    if (tick || stopped || activeConnections === 0) return
    // Apply elapsed expiries once when play resumes after an idle period.
    world.tick()
    world.flush()
    options.waitUntil(sync().catch(() => undefined))
    let ticks = 0
    tick = setInterval(() => {
      try { world.tick(); for (const peer of peers.values()) peer.check(); if (++ticks % 60 === 0) sessions?.sweep() } catch { stop() }
    }, 1000)
    step = setInterval(() => { try { world.step() } catch { stop() } }, 100)
  }
  function clearTimers(): void {
    if (tick) clearInterval(tick)
    if (step) clearInterval(step)
    tick = null; step = null
  }
  function idle(): void {
    clearTimers()
    try { sessions?.sweep(); world.flush(); options.waitUntil(sync().catch(() => undefined)) } catch { stop() }
  }
  world.onSuperseded(() => stop())
  function upgrade(request: Request): Response {
    const url = new URL(request.url)
    if (stopped || persistenceFailed || world.superseded || world.saveStats.lastError !== null) throw new WorldError('unavailable', 'The world is unavailable.')
    if (url.pathname !== '/world/socket' || url.search || url.hash || request.method !== 'GET'
      || request.headers.get('origin') !== binding.origin || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new WorldError('forbidden', 'This socket request is not allowed.')
    if (peers.size >= max) throw new WorldError('rate_limited', 'This playtest is full. Retry shortly.')
    world.limit('upgrades:global', 300, 60_000); world.limit(`upgrade:${source(request)}`, 30, 60_000)
    const pair = new WebSocketPair()
    const client = pair[0], server = pair[1]
    server.accept()
    accept(server, request)
    return new Response(null, { status: 101, webSocket: client })
  }
  function stop(): void {
    if (stopped) return
    stopped = true; clearTimers()
    for (const peer of peers.values()) peer.end()
    providerCalls.abort(); adapter?.close(); grants?.close(); sessions?.close()
    // Fenced above, at once. The final write is not: stop can be reached inside a domain operation (a failing disconnect
    // hook in end), so world.close and its durable sync run after that synchronous turn returns. Any failure latches.
    options.waitUntil(new Promise<void>(resolve => queueMicrotask(resolve)).then(() => { world.close(); return store.sync() }).catch(() => { persistenceFailed = true }))
  }
  const fresh = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers } })
  /** The two transfer routes. Their answer is written as a fresh response: no target CORS header is merged into a legacy one. */
  async function transfer(request: Request, path: string): Promise<Response> {
    const legacy: Record<string, string> = path === '/world/guest-transfer/start' && options.transfer && guestTransferOrigins(options.transfer.legacyOrigin, binding.origin).includes(request.headers.get('origin') ?? '')
      ? { 'access-control-allow-origin': request.headers.get('origin')!, vary: 'Origin' } : {}
    try {
      if (new URL(request.url).search) throw new WorldError('invalid', 'Query parameters are not accepted.')
      if (!transfers || down()) throw new WorldError('unavailable', 'The world is unavailable. Retry shortly.')
      const text = request.method === 'POST' ? await boundedText(request, BODY_LIMIT) : ''
      const answer = await transfers.respond({ path, method: request.method, origin: request.headers.get('origin') ?? undefined, contentType: request.headers.get('content-type') ?? undefined,
        accessControlRequestMethod: request.headers.get('access-control-request-method') ?? undefined, accessControlRequestHeaders: request.headers.get('access-control-request-headers') ?? undefined,
        body: text, source: source(request) })
      if (!answer) return fresh(404, { code: 'not_found', message: 'Not found.' })
      // A code or capability leaves only once it is durable.
      // Start: the new code record leaves only once durable; consume then rechecks the guest when it is used.
      // Consume: the module already burned, synced and rechecked the same guest and admission after its last await.
      // Nothing is awaited after that check here, so a claim or revoke in that boundary still withholds the capability.
      if (answer.status === 200 && path === '/world/guest-transfer/start') { world.flush(); await sync(); if (down()) throw new WorldError('unavailable', 'World storage is unavailable.') }
      return new Response(answer.body, { status: answer.status, headers: answer.headers })
    } catch (error) {
      const code = error instanceof WorldError ? error.code : 'unavailable'
      const status = code === 'rate_limited' ? 429 : code === 'invalid' ? 400 : code === 'forbidden' ? 403 : code === 'unauthorized' ? 401 : 503
      return fresh(status, { code, message: error instanceof WorldError ? error.message : 'The world is unavailable. Retry shortly.' }, legacy)
    }
  }
  async function fetchRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/world/socket') {
      try { return upgrade(request) } catch (error) { const response = new ResponseDraft(); failure(response, error); return response.response() }
    }
    if (ACCOUNT_PATHS.has(path)) {
      if (new URL(request.url).search) return fresh(400, { code: 'invalid', message: 'Query parameters are not accepted.' })
      return accounts ? accounts.respond(request, path, source(request)) : fresh(503, { code: 'unavailable', message: 'Accounts are not available here yet.' })
    }
    if (GUEST_TRANSFER_PATHS.has(path)) return transfer(request, path)
    const response = new ResponseDraft()
    // A new request to a stopped or failed world is refused at once: it neither runs nor waits on a storage barrier.
    if (HTTP_PATHS.has(path) && down()) {
      if (request.headers.get('origin') === binding.origin) { response.setHeader('Access-Control-Allow-Origin', binding.origin); response.setHeader('Vary', 'Origin') }
      failure(response, new WorldError('unavailable', 'The world is shutting down.'))
      return response.response()
    }
    await handle(request, response)
    try { await sync(); if (response.status === 200) response.verify?.() } catch (error) {
      const unavailable = new ResponseDraft()
      if (request.headers.get('origin') === binding.origin) { unavailable.setHeader('Access-Control-Allow-Origin', binding.origin); unavailable.setHeader('Vary', 'Origin') }
      failure(unavailable, error)
      return unavailable.response()
    }
    return response.response()
  }
  return { world, guests, fetch: fetchRequest, stop, diagnostics: () => ({ activeConnections, pendingConnections: peers.size - activeConnections, timersRunning: tick !== null, unsaved: world.saveStats.unsaved, captures: world.saveStats.captures, persistenceFailed, stopped }) }
}
