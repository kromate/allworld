// One-use account grants, in process: what the remote issue/redeem pair used to do. A grant ties one live
// cookie session to one S256 challenge of this exact hosted binding for at most 30 seconds, and is kept by
// hash in memory only. Nothing from a request body names the account: it comes from the session.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { WorldError } from '../src/shared/model.ts'
import { serverRelative } from './hostedIdentity.ts'
import type { HostedBinding, HostedSubject } from './hostedIdentity.ts'
import type { AccountSessions, SessionAuthority } from './accountSessions.ts'

const TTL = 30_000
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

export function createAccountGrants(binding: HostedBinding, sessions: Pick<AccountSessions, 'assertActive'>, options: {
  now?: () => number
  /** Grants waiting to be redeemed, across all sessions. Independent of the connection limit. */
  capacity?: number
  perSession?: number
} = {}) {
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? 4096, perSession = options.perSession ?? 8
  const grants = new Map<string, { ref: string; generation: number; challenge: string; expiresAt: number }>()
  let closed = false
  function sweep(): void { for (const [key, grant] of grants) if (grant.expiresAt <= now()) grants.delete(key) }
  return {
    /**
     * `serverTime` is the one clock sample `expiresAt` was computed from, so a page can measure the code's lifetime
     * (`expiresAt - serverTime`, at most 30 s) without comparing this server's clock with its own.
     */
    issue(input: { authority: SessionAuthority; challenge: string }): { code: string; expiresAt: number; serverTime: number } {
      if (closed) throw new WorldError('unavailable', 'The world is shutting down.')
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw new WorldError('invalid', 'Invalid sign-in challenge.')
      // Asked again here, by ref: the authority handed in may be from before an await.
      const authority = sessions.assertActive(input.authority)
      sweep()
      let held = 0
      for (const grant of grants.values()) if (grant.ref === authority.ref) held++
      if (held >= perSession) throw new WorldError('rate_limited', 'You are doing that too quickly. Wait a moment and try again.')
      if (grants.size >= capacity) throw new WorldError('unavailable', 'Too many pending sign-ins. Retry shortly.')
      const serverTime = now()
      const expiresAt = Math.min(serverTime + TTL, authority.validUntil)
      // The authority may have run out between its check and this sample: then there is nothing left to grant.
      if (!serverRelative(expiresAt, serverTime)) throw new WorldError('unavailable', 'Your account could not be checked just now. Try again shortly.')
      const code = `gmc_${randomBytes(32).toString('base64url')}`
      grants.set(digest(code), { ref: authority.ref, generation: authority.generation, challenge: input.challenge, expiresAt })
      return { code, expiresAt, serverTime }
    },
    /** Burns the code whatever happens next. The subject is made here from the live session, and only here. */
    redeem(input: { code: string; verifier: string }): { subject: HostedSubject; generation: number } {
      const key = digest(input.code), grant = grants.get(key)
      grants.delete(key)
      if (closed || !grant || grant.expiresAt <= now()) throw new WorldError('expired', 'The sign-in code expired or was already used.')
      const proved = createHash('sha256').update(input.verifier).digest(), expected = Buffer.from(grant.challenge, 'base64url')
      if (expected.length !== proved.length || !timingSafeEqual(proved, expected)) throw new WorldError('unauthorized', 'The sign-in code does not belong to this challenge.')
      const authority = sessions.assertActive(grant)
      // The code's own expiry, fixed when it was issued, or sooner if the session's authority now ends sooner. Never
      // later: the page refuses a world session that outlives the code it exchanged, and so must the server.
      return { subject: { ...binding, subjectId: authority.uid, accountId: authority.issuer, installationId: authority.ref, expiresAt: Math.min(grant.expiresAt, authority.validUntil) }, generation: authority.generation }
    },
    revokeRef(ref: string): void { for (const [key, grant] of grants) if (grant.ref === ref) grants.delete(key) },
    get size() { return grants.size },
    close(): void { closed = true; grants.clear() },
  }
}
