import { WorldError } from '../shared/model.ts'
import { worldEndpoint, worldSocketUrl } from './worldEndpoint.ts'
import { monotonicNow, serverRelativeLifetime } from './sessionTiming.ts'
export interface HostedWorldConfig {
  /** Stable logical scope: storage, identity and the service binding. Never rewritten. */
  audience: string
  /** Where network requests go. Defaults to `audience`. */
  endpoint?: string
  siteId: string
  packageId: string
  channel: 'test' | 'store'
  buildId: string
  guestAdmission?: 'public' | 'invite'
}
/**
 * A one-use world token. `clientDeadline` is a reading of this page's monotonic clock
 * (`performance.now()`), not a server epoch: the token must be presented before it. It is the moment
 * taken before the whole challenge, grant and exchange chain began, plus the lifetime the server gave,
 * so it never outlasts the server's own expiry. `lifetime` is that server-relative lifetime.
 */
export interface HostedWorldSession { token: string; socketUrl: string; clientDeadline: number; lifetime: number }
export type IdentityIssuer = (input: { audience: string; challenge: string }, options: { signal: AbortSignal }) => Promise<unknown>
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

/**
 * The service is this App on this channel, running a different build: this page is out of date.
 * Trying again cannot help; a reload the member chooses can. Never raised for another App, package
 * or channel, and never a reason to drop a session or pick another one.
 */
export class UpdateRequiredError extends WorldError {
  constructor() {
    super('unavailable', 'The game was updated. Reload to get the new version. Your saved character and progress are kept; anything not saved yet may be lost.')
    this.name = 'UpdateRequiredError'
  }
}

export function assertHostedRuntime(raw: unknown, config: HostedWorldConfig): void {
  const sameApp = record(raw) && raw.siteId === config.siteId && raw.packageId === config.packageId && raw.channel === config.channel
  if (sameApp && raw.buildId === config.buildId) return
  // Only a named build of this very App is an update. Anything else is not this App's service at all.
  if (sameApp && typeof raw.buildId === 'string' && raw.buildId) throw new UpdateRequiredError()
  throw new WorldError('unavailable', 'This world service belongs to another App build. Reopen the playtest link.')
}

/** No platform credential leaves the App host. Only a single-use code goes to the declared service. */
export async function openHostedWorldSession(config: HostedWorldConfig, identity: { userId: string; accountId: string }, issue: IdentityIssuer, signal: AbortSignal): Promise<HostedWorldSession> {
  const endpoint = worldEndpoint(config)
  // Taken before the first request: every local deadline below discounts the whole chain.
  const chainStart = monotonicNow()
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: bounded,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : 'unavailable'
      throw new WorldError(code, response.status === 429 ? 'The world service is busy. Try again later.' : 'The hosted world service could not confirm your session.')
    }
    try { return await response.json() }
    catch (error) {
      if (bounded.aborted) throw error
      throw new WorldError('unavailable', 'The world service returned an invalid reply. Try again.')
    }
  }
  const challenge = await post('/world/hosted-challenge', {})
  if (!record(challenge) || !opaque(challenge.challengeId) || !opaque(challenge.challenge)) throw new WorldError('unavailable', 'The world sign-in challenge was invalid.')
  // A service that names its build is checked before any identity code is asked for: a code from an
  // out-of-date page would only be refused. An older service names none, and is checked at the session below.
  if (challenge.runtime !== undefined) assertHostedRuntime(challenge.runtime, config)
  const handoff = await issue({ audience: config.audience, challenge: challenge.challenge }, { signal: bounded })
  // The code's lifetime is the server's own: two readings of its clock. This page's wall clock is never compared with them.
  const codeLifetime = record(handoff) ? serverRelativeLifetime(handoff) : null
  if (!record(handoff) || typeof handoff.code !== 'string' || !/^gmc_[A-Za-z0-9_-]{43}$/.test(handoff.code) || codeLifetime === null
    || typeof handoff.expiresAt !== 'number') throw new WorldError('unauthorized', 'Sign-in expired or could not be verified. Sign in again.')
  // Counted from before the chain began, so already used up if the chain itself took that long: nothing is sent then.
  if (monotonicNow() >= chainStart + codeLifetime) throw new WorldError('unavailable', 'The world sign-in took too long. Trying again.')
  const session = await post('/world/hosted-session', { code: handoff.code, challengeId: challenge.challengeId })
  const lifetime = record(session) ? serverRelativeLifetime(session) : null
  // Identity, runtime and "the session never outlives its handoff" are compared exactly, both expiries on the server's clock.
  if (!record(session) || !opaque(session.token) || session.subjectId !== identity.userId || session.accountId !== identity.accountId
    || lifetime === null || typeof session.expiresAt !== 'number' || session.expiresAt > handoff.expiresAt) throw new WorldError('unauthorized', 'Your account changed or the world session expired.')
  assertHostedRuntime(session.runtime, config)
  bounded.throwIfAborted()
  const clientDeadline = chainStart + lifetime
  if (monotonicNow() >= clientDeadline) throw new WorldError('unavailable', 'The world session expired before it could be used. Trying again.')
  return { token: session.token, clientDeadline, lifetime, socketUrl: worldSocketUrl(config) }
}

/** Issue only an identity code for a challenge supplied by the current socket. */
export async function renewHostedWorld(config: HostedWorldConfig, challenge: string, issue: IdentityIssuer, signal: AbortSignal): Promise<string> {
  if (!opaque(challenge)) throw new WorldError('unauthorized', 'Invalid renewal challenge.')
  const result = await issue({ audience: config.audience, challenge }, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  signal.throwIfAborted()
  // The same server-relative bound as at sign-in; the server decides whether the code is still good.
  if (!record(result) || typeof result.code !== 'string' || !/^gmc_[A-Za-z0-9_-]{43}$/.test(result.code)
    || serverRelativeLifetime(result) === null) throw new WorldError('unauthorized', 'Allworld could not renew this session.')
  return result.code
}
