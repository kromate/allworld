// Hosted transport adapter. The local listener must never import this to bypass loopback checks.
import { createHash, randomBytes } from 'node:crypto'
import type { MemberId } from '../src/shared/ids.ts'

export interface HostedBinding {
  siteId: string; packageId: string; channel: 'test' | 'store'; buildId: string; artifactId: string
  audience: string; origin: string
  guestAdmission?: 'public' | 'invite'
}
export interface HostedSubject extends HostedBinding {
  subjectId: string; accountId: string; installationId: string; expiresAt: number
}
/** `generation` is the account session's, kept beside the subject so a lease can ask whether that exact sign-in still stands. */
export interface HostedActor { memberId: MemberId; subject: HostedSubject; name: string; reviewer: false; generation?: number }
/** In-process redemption of a `gmc_` code. The answer still goes through `parseHostedSubject` like any other. */
export interface LocalIdentity {
  redeem(input: { code: string; verifier: string }): { subject: unknown; generation: number }
  /** Throws unless this session exists and the provider confirmed it within the allowed time. */
  assertActive(session: { ref: string; generation: number }): unknown
}
const TTL = 30_000
/**
 * A lifetime the page can measure against this server's own clock (contract 135): both safe integers, from one sample,
 * with `0 < expiresAt - serverTime <= 30 s`. Null otherwise (already over, or the wall clock stepped back): the caller
 * then refuses or ends the socket. Nothing is ever widened or clamped to fit.
 */
export function serverRelative(expiresAt: number, serverTime: number): { expiresAt: number; serverTime: number } | null {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(serverTime)) return null
  const remaining = expiresAt - serverTime
  return remaining > 0 && remaining <= TTL ? { expiresAt, serverTime } : null
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
/** One stable account character key, within the world's existing member-ID parser limit. */
export function hostedMemberId(subject: Pick<HostedSubject, 'siteId' | 'packageId' | 'channel' | 'accountId' | 'subjectId'>): MemberId {
  return `m_gm_${digest(JSON.stringify([subject.siteId, subject.packageId, subject.channel, subject.accountId, subject.subjectId])).slice(0, 32)}` as MemberId
}
const opaque = (): string => randomBytes(32).toString('base64url')
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
function httpsOrigin(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('An exact HTTPS origin is required.')
}
export function parseHostedSubject(raw: unknown, binding: HostedBinding, now = Date.now()): HostedSubject {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Goalmatic service identity.')
  if (!('siteId' in raw) || raw.siteId !== binding.siteId || !('packageId' in raw) || raw.packageId !== binding.packageId
    || !('channel' in raw) || raw.channel !== binding.channel || !('buildId' in raw) || raw.buildId !== binding.buildId
    || !('artifactId' in raw) || raw.artifactId !== binding.artifactId || !('audience' in raw) || raw.audience !== binding.audience
    || !('origin' in raw) || raw.origin !== binding.origin || !('subjectId' in raw) || !text(raw.subjectId)
    || !('accountId' in raw) || !text(raw.accountId) || !('installationId' in raw) || !text(raw.installationId)
    || !('expiresAt' in raw) || typeof raw.expiresAt !== 'number' || !Number.isSafeInteger(raw.expiresAt)
    || raw.expiresAt <= now || raw.expiresAt > now + TTL) throw new Error('Goalmatic service identity does not match this world.')
  return { ...binding, subjectId: raw.subjectId, accountId: raw.accountId, installationId: raw.installationId, expiresAt: raw.expiresAt }
}

/**
 * Keep one instance per hosted edge. Call consume only after an exact WebSocket Origin check.
 * The standalone service passes `local`. `redeemUrl` is the earlier remote exchange: the hosted listener
 * no longer offers it, and it stays only for the guest probe that drives this adapter directly.
 */
export function createHostedIdentityAdapter(binding: HostedBinding, options: ({ redeemUrl: string; fetch?: typeof fetch } | { local: LocalIdentity }) & {
  now?: () => number
  /** Challenges and world tokens waiting at once. A bound on pending sign-ins, not on connections. */
  capacity?: number
}) {
  httpsOrigin(binding.audience); httpsOrigin(binding.origin)
  for (const value of [binding.siteId, binding.packageId, binding.buildId, binding.artifactId]) if (!text(value)) throw new Error('Incomplete hosted binding.')
  const local = 'local' in options ? options.local : null
  const redeem = 'redeemUrl' in options ? new URL(options.redeemUrl) : null
  if (redeem && (redeem.origin !== binding.origin || redeem.pathname !== '/api/app-runtime/service-identity/redeem'
    || redeem.search || redeem.hash || redeem.username || redeem.password)) throw new Error('Use the App host identity redemption endpoint.')
  const request = ('fetch' in options ? options.fetch : undefined) ?? fetch
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? 1000
  const lifetime = new AbortController()
  let closed = false
  let inFlight = 0
  const challenges = new Map<string, { verifier: string; expiresAt: number }>()
  const sessions = new Map<string, { subject: HostedSubject; generation: number | null }>()
  function sweep(): void {
    for (const [key, value] of challenges) if (value.expiresAt <= now()) challenges.delete(key)
    for (const [key, value] of sessions) if (value.subject.expiresAt <= now()) sessions.delete(key)
  }
  /** With local accounts, the account session behind a token or lease must still stand, and be freshly confirmed. */
  function sessionActive(subject: HostedSubject, generation: number | null | undefined): void {
    if (!local) return
    if (typeof generation !== 'number') throw new Error('This world session has no account session.')
    local.assertActive({ ref: subject.installationId, generation })
  }
  function requireOrigin(origin: string): void { if (closed) throw new Error('The identity adapter is closed.'); if (origin !== binding.origin) throw new Error('This App origin is not allowed.') }
  return {
    challenge(origin: string): { challengeId: string; challenge: string } {
      requireOrigin(origin); sweep()
      if (challenges.size + sessions.size + inFlight >= capacity) throw new Error('Too many pending sign-ins. Retry shortly.')
      const challengeId = opaque(), verifier = opaque()
      challenges.set(digest(challengeId), { verifier, expiresAt: now() + TTL })
      return { challengeId, challenge: createHash('sha256').update(verifier).digest('base64url') }
    },
    async exchange(input: { origin: string; challengeId: string; code: string }): Promise<{ token: string; expiresAt: number; subjectId: string; accountId: string }> {
      requireOrigin(input.origin); sweep()
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.challengeId) || !/^gmc_[A-Za-z0-9_-]{43}$/.test(input.code)) throw new Error('Invalid service handoff.')
      const key = digest(input.challengeId), pending = challenges.get(key)
      challenges.delete(key)
      if (!pending || pending.expiresAt <= now()) throw new Error('The sign-in challenge expired or was already used.')
      inFlight++
      try {
        let raw: unknown, generation: number | null = null
        if (local) {
          const redeemed = local.redeem({ code: input.code, verifier: pending.verifier })
          raw = redeemed.subject; generation = redeemed.generation
        } else {
          if (!redeem) throw new Error('No identity exchange is configured.')
          const response = await request(redeem, {
            method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ siteId: binding.siteId, audience: binding.audience, origin: binding.origin, code: input.code, verifier: pending.verifier }),
          })
          if (!response.ok) throw new Error('Goalmatic refused the service identity.')
          raw = await response.json()
        }
        requireOrigin(input.origin)
        const subject = parseHostedSubject(raw, binding, now())
        sessionActive(subject, generation)
        sweep()
        if (sessions.size + challenges.size + inFlight > capacity) throw new Error('Too many pending sign-ins. Retry shortly.')
        const token = opaque()
        sessions.set(digest(token), { subject, generation })
        return { token, expiresAt: subject.expiresAt, subjectId: subject.subjectId, accountId: subject.accountId }
      } finally { inFlight-- }
    },
    consume(token: string, origin: string): HostedActor {
      requireOrigin(origin); sweep()
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid world session.')
      const key = digest(token), held = sessions.get(key)
      sessions.delete(key)
      if (!held || held.subject.expiresAt <= now()) throw new Error('The world session expired or was already used.')
      // Signed out, or ended by the provider, between the exchange and now: the token is worth nothing.
      sessionActive(held.subject, held.generation)
      const memberId = hostedMemberId(held.subject)
      return { memberId, subject: held.subject, name: local ? 'Allworld member' : 'Goalmatic member', reviewer: false, ...(held.generation === null ? {} : { generation: held.generation }) }
    },
    /** The hosted listener must call this before every incoming frame and outgoing private event. */
    assertActive(actor: HostedActor): void {
      if (closed || actor.subject.expiresAt <= now()) throw new Error('The world session expired. Sign in again.')
      sessionActive(actor.subject, actor.generation)
    },
    close(): void { closed = true; lifetime.abort(); challenges.clear(); sessions.clear() },
  }
}

/** One account socket's lease. Renewal changes only expiry after a fresh verified grant. */
export function createHostedLease(adapter: ReturnType<typeof createHostedIdentityAdapter>, initial: HostedActor, origin: string, now: () => number = Date.now) {
  let actor = initial
  let pending: string | null = null
  let renewing = false
  let closed = false
  function active(): HostedActor {
    if (closed || actor.subject.expiresAt <= now()) throw new Error('The account lease expired.')
    adapter.assertActive(actor)
    return actor
  }
  return {
    active,
    get expiresAt() { return actor.subject.expiresAt },
    begin() {
      active()
      if (pending || renewing) throw new Error('A renewal is already pending.')
      const challenge = adapter.challenge(origin)
      pending = challenge.challengeId
      return challenge
    },
    async renew(challengeId: string, code: string): Promise<HostedActor> {
      const previous = active()
      if (!pending || pending !== challengeId || renewing) throw new Error('This renewal does not belong to this socket.')
      pending = null; renewing = true
      try {
        const session = await adapter.exchange({ origin, challengeId, code })
        active()
        const next = adapter.consume(session.token, origin)
        for (const key of ['subjectId', 'accountId', 'installationId', 'siteId', 'packageId', 'channel', 'buildId', 'artifactId', 'audience', 'origin'] as const) {
          if (next.subject[key] !== previous.subject[key]) throw new Error('The renewal changed the account identity.')
        }
        if (next.generation !== previous.generation) throw new Error('The renewal came from another sign-in.')
        if (next.subject.expiresAt <= previous.subject.expiresAt) throw new Error('The renewal did not provide a fresh lease.')
        actor = next
        return actor
      } finally { renewing = false }
    },
    close() { closed = true; pending = null },
  }
}
