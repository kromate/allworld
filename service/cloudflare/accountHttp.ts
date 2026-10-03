// Native account routes. Same rules as the seven routes in hostedServer.ts, but storage.sync is awaited here:
// no success, cookie or receipt leaves before the durable barrier, and every one is checked again after it.
import { createHash } from 'node:crypto'
import { WorldError } from '../../src/shared/model.ts'
import type { World } from '../kernel.ts'
import type { HostedBinding } from '../hostedIdentity.ts'
import { ProviderError } from '../accountProvider.ts'
import type { AccountProvider, ProviderCredential } from '../accountProvider.ts'
import { CLEAR_SESSION_COOKIE, carriesSessionCookie } from '../accountSessions.ts'
import type { AccountAttempt, AccountSessionView, AccountSessions } from '../accountSessions.ts'
import type { createAccountGrants } from '../accountGrants.ts'

export const ACCOUNT_PATHS: ReadonlySet<string> = new Set(['/world/account/attempt', '/world/account/signup', '/world/account/signin', '/world/account/cancel', '/world/account/me', '/world/account/grant', '/world/account/signout'])
const BODY_LIMIT = 6144
// Root policy: a new password is 12 to 128 characters; sign-in accepts 1 to 128.
const NEW_PASSWORD_MIN = 12, PASSWORD_MAX = 128
const ACCOUNT_NAME = 'Allworld member'
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The body as UTF-8 text, refused before buffering past `limit` bytes. */
export async function boundedText(request: Request, limit: number): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) { await reader.cancel(); throw new WorldError('invalid', 'The request is too large.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const data = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } catch { throw new WorldError('invalid', 'Invalid request text.') }
}

export interface AccountHttpOptions {
  binding: HostedBinding
  world: World
  sessions: AccountSessions
  grants: ReturnType<typeof createAccountGrants>
  provider: AccountProvider
  scopeKey: string
  now: () => number
  /** Aborted when the world stops: every provider call ends with it. */
  signal: AbortSignal
  /** The transport's latching durable barrier. Throws once storage could not confirm; it never succeeds after that. */
  sync(): Promise<void>
  /** Stopped, superseded, storage failed or latched. */
  down(): boolean
}

export function createAccountHttp(options: AccountHttpOptions) {
  const { binding, world, sessions, grants, provider, scopeKey, now } = options
  const json = (status: number, body: unknown, cookie?: string): Response => {
    const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store' })
    if (cookie) headers.set('Set-Cookie', cookie)
    return new Response(JSON.stringify(body), { status, headers })
  }
  const failure = (error: unknown, cookie?: string): Response => {
    const code = error instanceof WorldError ? error.code : 'unavailable'
    const status = code === 'conflict' ? 409 : code === 'rate_limited' ? 429 : code === 'expired' ? 410 : code === 'invalid' ? 400 : code === 'unavailable' ? 503 : code === 'forbidden' ? 403 : 401
    return json(status, { code, message: error instanceof WorldError ? error.message : 'The service could not authorize this request.' }, cookie)
  }
  const user = (session: AccountSessionView) => ({ userId: session.uid, accountId: session.issuer, name: ACCOUNT_NAME, email: session.email })
  const durable = async (): Promise<void> => {
    try { await options.sync() } catch { throw new WorldError('unavailable', 'The server could not confirm this just now. Try again shortly.') }
    if (options.down()) throw new WorldError('unavailable', 'The world is shutting down.')
  }
  function refusal(creating: boolean, error: unknown): WorldError {
    const kind = error instanceof ProviderError ? error.refusal : 'unavailable'
    if (kind === 'throttled') return new WorldError('rate_limited', 'Too many attempts. Wait a few minutes and try again.')
    if (kind === 'unavailable') return new WorldError('unavailable', 'Accounts cannot be reached right now. Try again shortly.')
    if (!creating) return new WorldError('unauthorized', 'That email and password do not match an account.')
    if (kind === 'weak-password') return new WorldError('invalid', 'Choose a longer, less common password.')
    return new WorldError('unauthorized', 'An account could not be created with that email. If you already have one, sign in instead.')
  }
  const attemptId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new WorldError('invalid', 'Invalid sign-in attempt.')
    return value
  }
  const fields = (input: Record<string, unknown>, allowed: string[]): void => {
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new WorldError('invalid', 'Unexpected request field.')
  }

  async function signIn(path: string, input: Record<string, unknown>, cookie: string | undefined, from: string, attempt: AccountAttempt): Promise<Response> {
    const creating = path === '/world/account/signup'
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    // The password lives in this call and in the one provider request. It is never stored, logged or echoed.
    const password = input.password
    if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new WorldError('invalid', 'Enter a valid email address.')
    if (typeof password !== 'string' || password.length < (creating ? NEW_PASSWORD_MIN : 1) || password.length > PASSWORD_MAX) throw new WorldError('invalid', creating ? `Use a password of ${NEW_PASSWORD_MIN} to ${PASSWORD_MAX} characters.` : 'Enter your password.')
    world.limit(creating ? `account:signup:${from}` : `account:signin:${from}`, creating ? 6 : 20, 5 * 60_000)
    world.limit(`account:email:${digest(`${scopeKey}\n${email}`)}`, 8, 5 * 60_000)
    world.limit('account:provider', 300, 60_000)
    const askedAt = now()
    let credential: ProviderCredential
    const signal = AbortSignal.any([options.signal, attempt.signal])
    try { credential = await (creating ? provider.signUp({ email, password }, signal) : provider.signIn({ email, password }, signal)) }
    catch (error) {
      if (!sessions.going(attempt)) throw sessions.cancelledError()
      throw refusal(creating, error)
    }
    if (!sessions.going(attempt)) throw sessions.cancelledError()
    if (options.down()) throw new WorldError('unavailable', 'The world is shutting down.')
    // `open` checks `going` and writes locally; the cookie waits for the durable barrier below.
    const opened = sessions.open(credential, cookie, askedAt, attempt)
    try { await durable() } catch (error) {
      // Nothing was promised: the session stops here. The latched store means no later success either.
      sessions.abandon(attempt)
      throw error
    }
    // The central post-durable check: attempt deadline, exact ref+generation+attempt, not closed or expired.
    if (options.down() || !sessions.committed(attempt, opened.authority)) {
      // Cancelled, signed out, replaced or expired during the wait: end exactly this session, durably, and send no cookie.
      sessions.abandon(attempt)
      await durable()
      throw sessions.cancelledError()
    }
    return json(200, user(opened.view), opened.setCookie)
  }

  async function route(request: Request, path: string, from: string): Promise<Response> {
    if (request.headers.get('origin') !== binding.origin) throw new WorldError('forbidden', 'This App origin is not allowed.')
    const site = request.headers.get('sec-fetch-site')
    if (site !== null && site !== 'same-origin') throw new WorldError('forbidden', 'This request did not come from the App.')
    if (request.method !== 'POST') return json(405, { code: 'invalid', message: 'Use POST.' })
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new WorldError('invalid', 'Use a JSON request.')
    const cookie = request.headers.get('cookie') ?? undefined
    world.limit('http:global', 600, 60_000); world.limit(`http:${from}`, 180, 60_000)
    let input: unknown
    try { input = JSON.parse(await boundedText(request, BODY_LIMIT)) } catch (error) { throw error instanceof WorldError ? error : new WorldError('invalid', 'Invalid JSON request.') }
    if (!object(input)) throw new WorldError('invalid', 'Use a request object.')
    if (path === '/world/account/signout') {
      fields(input, [])
      // Unusable in memory from here on; tried even while saves fail, but only a durable removal is reported as done.
      const ended = sessions.end(cookie)
      if (!ended.saved) throw new WorldError('unavailable', 'You are signed out on this device, but the server could not confirm it. Try again shortly.')
      await durable()
      return json(200, { signedOut: true }, CLEAR_SESSION_COOKIE)
    }
    if (path === '/world/account/cancel') {
      fields(input, ['attemptId'])
      const id = attemptId(input.attemptId)
      world.limit(`account:cancel:${from}`, 60, 60_000)
      const cancelled = sessions.cancel(id, cookie)
      if (!cancelled.saved) throw new WorldError('unavailable', 'This sign-in is cancelled on this server, but it could not confirm it. Try again shortly.')
      await durable()
      return json(200, { cancelled: true }, cancelled.clearCookie ? CLEAR_SESSION_COOKIE : undefined)
    }
    if (options.down()) throw new WorldError('unavailable', 'The world is shutting down.')
    if (path === '/world/account/me') {
      fields(input, [])
      sessions.resolve(cookie)
      await durable()
      // Asked again after the wait: a session ended meanwhile is not shown.
      const session = sessions.resolve(cookie)
      return json(200, session ? user(session) : null, !session && carriesSessionCookie(cookie) ? CLEAR_SESSION_COOKIE : undefined)
    }
    if (path === '/world/account/grant') {
      fields(input, ['challenge'])
      if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw new WorldError('invalid', 'Invalid sign-in challenge.')
      try {
        const session = sessions.resolve(cookie)
        if (!session) throw new WorldError('unauthorized', 'Sign in to continue.')
        world.limit(`account:grant:${session.ref}`, 30, 60_000)
        await sessions.fresh(session)
        // A rotated refresh token is durable before anything is granted on its strength.
        await durable()
        const authority = sessions.assertActive(session)
        return json(200, grants.issue({ authority, challenge: input.challenge }))
      } catch (error) {
        // Shutting down closes the sessions first, so a valid session reads as unauthorized here: it is not, and must keep its cookie.
        if (options.down()) throw new WorldError('unavailable', 'The world is shutting down.')
        if (error instanceof WorldError && error.code === 'unauthorized' && carriesSessionCookie(cookie)) return failure(error, CLEAR_SESSION_COOKIE)
        throw error
      }
    }
    if (path === '/world/account/attempt') {
      fields(input, [])
      world.limit(`account:attempt:${from}`, 30, 60_000)
      return json(200, sessions.issue())
    }
    fields(input, ['email', 'password', 'attemptId'])
    // Spent by this request whatever happens next: an attempt makes one request, ever.
    const attempt = sessions.enter(attemptId(input.attemptId))
    try { return await signIn(path, input, cookie, from, attempt) } finally { sessions.settle(attempt) }
  }

  return {
    async respond(request: Request, path: string, from: string): Promise<Response> {
      // Sign-out clears the browser cookie whatever the server could confirm: local access is closed either way.
      try { return await route(request, path, from) } catch (error) { return failure(error, path === '/world/account/signout' ? CLEAR_SESSION_COOKIE : undefined) }
    },
  }
}
