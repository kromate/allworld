// Server-owned account sessions behind one cookie. The browser holds a random secret and nothing else;
// state holds that secret's SHA-256 and the provider's refresh token sealed under a key that is never in state.
//
// Two times matter and they are not the same thing. A session *exists* until it is signed out, ended by the
// provider, or expires (30 days, 14 idle). A session has *authority* only for 60 seconds after the provider
// last confirmed the account, and that instant is kept in memory only: after a restart every session must be
// confirmed again before it can open the world. When the provider cannot be asked, authority runs out and
// nothing is granted; the session itself is kept.
//
// Every sign-in is an *attempt*: an id this process issued, 256 random bits, good for 30 seconds and one
// request. Only its digest is kept, in memory, so after a restart no earlier id means anything. The page can
// cancel an attempt at any moment: a cancelled attempt never makes a session, and a session it already made
// is ended, durably, and no other session is touched. The account's email address is sealed with the refresh token: it is shown back to its own browser
// and is never in a member, a name, a world token, a log or state in the clear.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { WorldError } from '../src/shared/model.ts'
import type { GuestScope } from '../src/shared/guest.ts'
import type { World } from './kernel.ts'
import { ProviderError, REFRESH_TOKEN_LIMIT } from './accountProvider.ts'
import type { AccountProvider, ProviderCredential } from './accountProvider.ts'

export const SESSION_COOKIE = '__Host-aw_session'
/** How long one confirmation by the provider is good for. Every grant and lease ends by then. */
export const VERIFIED_FOR_MS = 60_000
/** Ask again from this age on, so a full 30-second lease still fits and a slow provider has time to answer. */
const REFRESH_AFTER_MS = 30_000, RETRY_AFTER_MS = 5000
const DAY = 86_400_000, ABSOLUTE_MS = 30 * DAY, IDLE_MS = 14 * DAY, SEEN_EVERY_MS = 3_600_000
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict'
/** An issued attempt that has no saved session this long after it was issued never gets one. Not renewable. */
export const ATTEMPT_MS = 30_000
export const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`

interface SealedToken { keyId: string; nonce: string; ciphertext: string }
/**
 * `ref` and `generation` are fixed when a sign-in opens the session and are what a grant, a world token and a
 * socket lease hold on to. `revision` counts changes of the sealed token, so a refresh that lost a race is
 * dropped without the session looking signed out to its sockets.
 */
interface AccountSessionRecord {
  ref: string; generation: number; revision: number
  issuer: string; uid: string
  /** SHA-256 of the attempt id that opened this session: cancelling that attempt ends this session and no other. */
  attempt: string
  createdAt: number; absoluteExpiresAt: number
  /** Saved coarsely: never once per grant. */
  seenAt: number
  sealed: SealedToken
}
interface AccountSessionSlice { scope: string; generation: number; byHash: Record<string, AccountSessionRecord> }
/** Who a cookie is. Says nothing about whether the provider still agrees. */
export interface AccountSession { readonly ref: string; readonly generation: number; readonly issuer: string; readonly uid: string }
/** What `me` may say to the cookie's own browser. `email` is private to it. */
export interface AccountSessionView extends AccountSession { readonly email: string }
/** One sign-in in progress. Only the sessions module changes `state`. */
export interface AccountAttempt { readonly hash: string; readonly deadline: number; readonly signal: AbortSignal; state: 'issued' | 'processing' | 'cancelled' | 'done' | 'failed' }
interface Sealed { refreshToken: string; email: string }
/** A session the provider confirmed less than 60 seconds ago. Nothing may outlive `validUntil`. */
export interface SessionAuthority extends AccountSession { readonly validUntil: number }
interface Live extends AccountSession {
  hash: string; attempt: string; email: string | null; absoluteExpiresAt: number; seenAt: number; savedSeenAt: number
  verifiedAt: number; retryAt: number
  flight: { abort: AbortController; done: Promise<void> } | null
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
/** The one session secret in a Cookie header. A malformed value, or the name sent twice, is no session. */
function cookieSecret(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null
  let found: string | null = null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0 || part.slice(0, at).trim() !== SESSION_COOKIE) continue
    if (found !== null) return null
    found = part.slice(at + 1).trim()
  }
  return found !== null && /^[A-Za-z0-9_-]{43}$/.test(found) ? found : null
}
/** True when the browser sent the cookie at all, whatever it holds: such a cookie is cleared when it is not a session. */
export function carriesSessionCookie(header: string | undefined): boolean {
  return header !== undefined && header.split(';').some(part => part.split('=')[0]?.trim() === SESSION_COOKIE)
}

export function createAccountSessions(world: World, scope: GuestScope, provider: AccountProvider, key: Uint8Array, options: {
  now?: () => number
  /** Sessions held at once, across all accounts. Independent of the connection limit. */
  capacity?: number
  /** Sessions one account may hold; the least recently used is ended to make room. */
  perAccount?: number
  /** Provider confirmations in flight at once. */
  refreshCapacity?: number
  /** Unexpired attempts held at once, in any state. Each is forgotten 30 seconds after it was issued. */
  attemptCapacity?: number
  /** Attempts waiting on the provider at once. */
  processingCapacity?: number
} = {}) {
  if (key.length !== 32) throw new Error('The session key must be exactly 32 bytes.')
  const secret = Buffer.from(key)
  const keyId = createHash('sha256').update('allworld-session-key-id\n').update(secret).digest('hex').slice(0, 16)
  const scopeKey = JSON.stringify([scope.appId, scope.packageId, scope.siteId, scope.channel])
  const now = options.now ?? (() => world.now())
  const capacity = options.capacity ?? 10_000, perAccount = options.perAccount ?? 5, refreshCapacity = options.refreshCapacity ?? 64
  const attemptCapacity = options.attemptCapacity ?? 256, processingCapacity = options.processingCapacity ?? 32
  const byHash = new Map<string, Live>(), byRef = new Map<string, Live>(), byAttempt = new Map<string, Live>()
  /** Every attempt issued in the last 30 seconds, by digest, whatever became of it. Never longer, never on disk. */
  const attempts = new Map<string, AccountAttempt & { abort: AbortController }>()
  const listeners: ((ref: string) => void)[] = []
  const lifetime = new AbortController()
  let closed = false, refreshing = 0

  const slice = (): AccountSessionSlice => world.slice<AccountSessionSlice>('accountSessions', () => ({ scope: scopeKey, generation: 0, byHash: {} }))
  // Everything that makes a sealed token belong to one session of one account in one world. A ciphertext moved
  // to another record, another world or another project does not open.
  const aad = (of: AccountSession): Buffer => Buffer.from(JSON.stringify(['allworld-session', 2, keyId, of.ref, of.generation, of.issuer, of.uid, scopeKey]))
  function seal(value: Sealed, of: AccountSession): SealedToken {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', secret, nonce)
    cipher.setAAD(aad(of))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify([value.refreshToken, value.email]), 'utf8'), cipher.final(), cipher.getAuthTag()])
    return { keyId, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') }
  }
  function unseal(record: AccountSessionRecord): Sealed {
    const nonce = Buffer.from(record.sealed.nonce, 'base64url'), data = Buffer.from(record.sealed.ciphertext, 'base64url')
    if (record.sealed.keyId !== keyId || nonce.length !== 12 || data.length <= 16) throw new Error('This session was sealed with another key.')
    const decipher = createDecipheriv('aes-256-gcm', secret, nonce)
    decipher.setAAD(aad(record)); decipher.setAuthTag(data.subarray(data.length - 16))
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8'))
    if (!Array.isArray(value) || typeof value[0] !== 'string' || !value[0] || typeof value[1] !== 'string') throw new Error('This session holds no credential.')
    return { refreshToken: value[0], email: value[1] }
  }
  function index(hash: string, record: AccountSessionRecord, verifiedAt: number, email: string | null): Live {
    const live: Live = { hash, attempt: record.attempt, email, ref: record.ref, generation: record.generation, issuer: record.issuer, uid: record.uid, absoluteExpiresAt: record.absoluteExpiresAt,
      seenAt: record.seenAt, savedSeenAt: record.seenAt, verifiedAt, retryAt: 0, flight: null }
    byHash.set(hash, live); byRef.set(live.ref, live); byAttempt.set(live.attempt, live)
    return live
  }
  /** Still allowed to become a session: not cancelled, not finished, not past its deadline, service not closing. */
  const going = (attempt: AccountAttempt): boolean => !closed && attempt.state === 'processing' && attempts.get(attempt.hash) === attempt && now() < attempt.deadline
  const cancelledError = (): WorldError => new WorldError('conflict', 'This sign-in attempt is unknown, expired, cancelled or already used. Start again.')
  const attemptHash = (attemptId: string): string => digest(`allworld-attempt\n${scopeKey}\n${attemptId}`)
  function forgetExpired(): void { for (const [hash, attempt] of attempts) if (now() >= attempt.deadline) { attempts.delete(hash); if (attempt.state === 'issued' || attempt.state === 'processing') attempt.abort.abort() } }
  const expiresAt = (live: Live): number => Math.min(live.absoluteExpiresAt, live.seenAt + IDLE_MS)
  const current = (live: Live): boolean => !closed && byRef.get(live.ref) === live
  const who = (live: Live): AccountSession => ({ ref: live.ref, generation: live.generation, issuer: live.issuer, uid: live.uid })
  /** Out of memory at once: no grant, lease or late refresh can find it again. Whoever holds sockets and grants is told. */
  function drop(live: Live): void {
    if (byRef.get(live.ref) !== live) return
    byHash.delete(live.hash); byRef.delete(live.ref); if (byAttempt.get(live.attempt) === live) byAttempt.delete(live.attempt)
    live.flight?.abort.abort()
    for (const listener of listeners) { try { listener(live.ref) } catch (error) { console.error('[accounts] a session-end listener failed', error instanceof Error ? error.message : 'unknown') } }
  }
  /** Drop, then take the record out of state and wait for the disk. False when the disk did not confirm. */
  function remove(live: Live): boolean {
    drop(live)
    return erase(live.hash)
  }
  function erase(hash: string): boolean {
    world.scoped(() => { const state = slice(); if (state.byHash[hash]) { delete state.byHash[hash]; world.touch() } })
    return confirmed()
  }
  /**
   * True once everything in memory is on disk. A record already gone from memory may still be on disk, because the
   * save that removed it failed: a retried sign-out or cancel must then write again before it can say so.
   */
  function confirmed(): boolean {
    if (!world.saveStats.unsaved && world.saveStats.lastError === null) return true
    try { world.flush(); return true } catch { return false }
  }
  function find(header: string | undefined): Live | null {
    const value = cookieSecret(header)
    const live = value ? byHash.get(digest(value)) : undefined
    return live && now() < expiresAt(live) ? live : null
  }
  function assertActive(input: { ref: string; generation: number }): SessionAuthority {
    const live = byRef.get(input.ref)
    if (closed || !live || live.generation !== input.generation || now() >= expiresAt(live)) throw new WorldError('unauthorized', 'Sign in again to continue.')
    const validUntil = Math.min(expiresAt(live), live.verifiedAt + VERIFIED_FOR_MS)
    if (now() >= validUntil) throw new WorldError('unavailable', 'Your account could not be checked just now. Try again shortly.')
    return { ...who(live), validUntil }
  }
  /** One request to the provider per session at a time, shared by every caller that arrives while it is out. */
  function refresh(live: Live): Promise<void> {
    if (live.flight) return live.flight.done
    // Over the bound nothing is asked; authority then simply runs out at its 60 seconds.
    if (refreshing >= refreshCapacity) return Promise.resolve()
    const flight: NonNullable<Live['flight']> = { abort: new AbortController(), done: Promise.resolve() }
    live.flight = flight
    flight.done = (async () => {
      refreshing++
      try {
        const read = world.peek<AccountSessionSlice>('accountSessions')?.byHash[live.hash]
        if (!read || read.generation !== live.generation) { drop(live); return }
        const revision = read.revision
        let held: Sealed
        try { held = unseal(read) } catch { remove(live); return }
        const token = held.refreshToken
        // The instant before asking: the provider's answer is never taken to be newer than it can be.
        const askedAt = now()
        let credential: ProviderCredential
        try {
          credential = await provider.revalidate({ refreshToken: token, expectedIssuer: live.issuer, expectedUid: live.uid }, AbortSignal.any([flight.abort.signal, lifetime.signal]))
        } catch (error) {
          if (current(live) && error instanceof ProviderError && (error.refusal === 'revoked' || error.refusal === 'disabled')) remove(live)
          else live.retryAt = now() + RETRY_AFTER_MS
          return
        }
        // Sign-out may have won while the provider was answering. Its answer is then for a session that no longer exists.
        if (!current(live)) return
        if (credential.identity.issuer !== live.issuer || credential.identity.uid !== live.uid || credential.refreshToken.length > REFRESH_TOKEN_LIMIT) { remove(live); return }
        const email = credential.identity.email || held.email
        const rotated = credential.refreshToken !== token || email !== held.email
        if (rotated || askedAt - live.savedSeenAt >= SEEN_EVERY_MS) {
          let applied = false
          world.scoped(() => {
            const record = slice().byHash[live.hash]
            if (!record || record.generation !== live.generation || record.revision !== revision) return
            if (rotated) { record.sealed = seal({ refreshToken: credential.refreshToken, email }, live); record.revision = revision + 1 }
            record.seenAt = askedAt; world.touch(); applied = true
          })
          if (!applied) return
          live.savedSeenAt = askedAt
          // A new refresh token is on disk before anything is granted on the strength of it.
          if (rotated) { try { world.flush() } catch { live.retryAt = now() + RETRY_AFTER_MS; return } }
        }
        live.verifiedAt = askedAt; live.seenAt = askedAt; live.email = email
      } finally {
        refreshing--
        if (live.flight === flight) live.flight = null
      }
    })()
    return flight.done
  }

  world.scoped(() => {
    const created = world.peek<AccountSessionSlice>('accountSessions') === undefined
    const state = slice()
    if (state.scope !== scopeKey) throw new Error('The account sessions in this state belong to another App scope.')
    for (const [hash, record] of Object.entries(state.byHash)) {
      // A record from another project or sealed with another key is not a session here. It is left to expire, not deleted:
      // starting once with the wrong key file must not sign everyone out for good.
      if (record.issuer === provider.issuer && record.sealed.keyId === keyId) index(hash, record, 0, null)
    }
    if (created) world.touch()
  })

  /** Who a live session is, with its private email. A session whose seal does not open is ended, not shown. */
  function view(live: Live): AccountSessionView | null {
    if (live.email === null) {
      const record = world.peek<AccountSessionSlice>('accountSessions')?.byHash[live.hash]
      try { if (!record) throw new Error('gone'); live.email = unseal(record).email } catch { remove(live); return null }
    }
    return { ...who(live), email: live.email }
  }

  return {
    assertActive,
    /** A new attempt for one form submit: the id goes to the page, only its digest stays here, for 30 seconds. */
    issue(): { attemptId: string; expiresAt: number } {
      if (closed) throw new WorldError('unavailable', 'Sign-in is not available right now.')
      forgetExpired()
      if (attempts.size >= attemptCapacity) throw new WorldError('rate_limited', 'Too many people are signing in right now. Try again shortly.')
      const attemptId = randomBytes(32).toString('base64url'), hash = attemptHash(attemptId), abort = new AbortController()
      const attempt = { hash, deadline: now() + ATTEMPT_MS, abort, signal: AbortSignal.any([abort.signal, lifetime.signal]), state: 'issued' as AccountAttempt['state'] }
      attempts.set(hash, attempt)
      return { attemptId, expiresAt: attempt.deadline }
    },
    /**
     * The one request an issued attempt may make. Refused (`conflict`) for an id this process did not issue or has
     * forgotten, that expired, was cancelled or was already entered. Call `settle` when the request is over.
     */
    enter(attemptId: string): AccountAttempt {
      if (closed) throw new WorldError('unavailable', 'Sign-in is not available right now.')
      forgetExpired()
      const attempt = attempts.get(attemptHash(attemptId))
      if (!attempt || attempt.state !== 'issued' || now() >= attempt.deadline) throw cancelledError()
      let processing = 0
      for (const other of attempts.values()) if (other.state === 'processing') processing++
      // Refused before it is entered: the page may ask for a new attempt and try again.
      if (processing >= processingCapacity) throw new WorldError('rate_limited', 'Too many people are signing in right now. Try again shortly.')
      attempt.state = 'processing'
      return attempt
    },
    /** True while the attempt may still become a session. Ask after every await. */
    going,
    cancelledError,
    /** The request is over. An attempt that made no session stays spent until it is forgotten. */
    settle(attempt: AccountAttempt): void { if (attempt.state === 'processing') attempt.state = 'failed' },
    /**
     * For a runtime whose save is not durable until a later await (`storage.sync`): call after that await, before the
     * cookie leaves. True only while the session `open` made for this attempt still stands, unchanged, and the
     * attempt's absolute deadline has not passed. When false, `abandon` it and answer without the cookie.
     */
    committed(attempt: AccountAttempt, session: { ref: string; generation: number }): boolean {
      const live = byRef.get(session.ref)
      return !closed && attempt.state === 'done' && now() < attempt.deadline && live !== undefined
        && live.generation === session.generation && live.attempt === attempt.hash && now() < expiresAt(live)
    },
    /**
     * Ends exactly the session this finished attempt made, if it still exists, as `cancel` would: grants and sockets
     * with it, and removed from state. `saved` as for `end`. Nothing else is touched.
     */
    abandon(attempt: AccountAttempt): { saved: boolean } {
      if (attempt.state === 'processing' || attempt.state === 'issued') attempt.state = 'cancelled'
      const live = byAttempt.get(attempt.hash)
      if (!live) return { saved: confirmed() }
      drop(live)
      return { saved: erase(live.hash) }
    },
    /**
     * Cancels the attempt in every state it can be in. An issued or running attempt is latched and can never make a
     * session (after 30 seconds it is unknown, which is refused the same way). A session it already made is ended
     * with its grants and sockets and removed from disk: `saved` says the disk confirmed it. `clearCookie` only when
     * the request's own cookie is that session. An id never issued is refused for ever, so there is nothing to record.
     * Here and in `end`, `saved` means this process's save returned. Where that save is local and a later await makes
     * it durable (`storage.sync`), the caller must cross that barrier before any receipt.
     */
    cancel(attemptId: string, cookieHeader: string | undefined): { saved: boolean; clearCookie: boolean } {
      if (closed) throw new WorldError('unavailable', 'The world is shutting down.')
      const hash = attemptHash(attemptId)
      const running = attempts.get(hash)
      if (running && (running.state === 'issued' || running.state === 'processing')) { running.state = 'cancelled'; running.abort.abort() }
      const made = byAttempt.get(hash)
      const madeHash = made?.hash ?? Object.entries(world.peek<AccountSessionSlice>('accountSessions')?.byHash ?? {}).find(([, record]) => record.attempt === hash)?.[0]
      if (running && running.state !== 'cancelled') running.state = 'cancelled'
      if (!madeHash) return { saved: confirmed(), clearCookie: false }
      if (made) drop(made)
      const value = cookieSecret(cookieHeader)
      return { saved: erase(madeHash), clearCookie: value !== null && digest(value) === madeHash }
    },
    /**
     * Call only with what the provider just returned for a `going` attempt, and send `setCookie` only because this
     * returned: the record is on disk by then. A session the request already carried is replaced in the same write.
     */
    open(credential: ProviderCredential, previousCookie: string | undefined, verifiedAt: number, attempt: AccountAttempt): { setCookie: string; view: AccountSessionView; authority: SessionAuthority } {
      const { issuer, uid } = credential.identity
      if (closed || issuer !== provider.issuer || !uid || uid.length > 128 || !credential.refreshToken || credential.refreshToken.length > REFRESH_TOKEN_LIMIT
        || !credential.identity.email || credential.identity.email.length > 254) throw new WorldError('unavailable', 'Sign-in is not available right now.')
      if (!going(attempt)) throw cancelledError()
      const previous = find(previousCookie)
      const others = [...byHash.values()].filter(live => live.uid === uid && live !== previous).sort((a, b) => a.seenAt - b.seenAt)
      const replaced = [...(previous ? [previous] : []), ...others.slice(0, Math.max(0, others.length - perAccount + 1))]
      if (byHash.size - replaced.length >= capacity) throw new WorldError('unavailable', 'Too many people are signed in right now. Try again shortly.')
      const value = randomBytes(32).toString('base64url'), hash = digest(value), ref = `s_${randomBytes(16).toString('hex')}`
      const at = now()
      const taken: [string, AccountSessionRecord][] = []
      let record!: AccountSessionRecord
      world.scoped(() => {
        const state = slice()
        const generation = ++state.generation
        for (const old of replaced) { const held = state.byHash[old.hash]; if (held) { taken.push([old.hash, held]); delete state.byHash[old.hash] } }
        record = { ref, generation, revision: 1, issuer, uid, attempt: attempt.hash, createdAt: at, absoluteExpiresAt: at + ABSOLUTE_MS, seenAt: at,
          sealed: seal({ refreshToken: credential.refreshToken, email: credential.identity.email }, { ref, generation, issuer, uid }) }
        state.byHash[hash] = record
        world.touch()
      })
      // Nothing was promised to anyone: put state back as it was. The earlier sessions were never dropped from memory.
      const undo = (): void => { world.scoped(() => { const state = slice(); delete state.byHash[hash]; for (const [old, held] of taken) state.byHash[old] = held; world.touch() }) }
      try { world.flush() } catch {
        undo()
        throw new WorldError('unavailable', 'Your sign-in could not be saved. Try again shortly.')
      }
      // No callback can run during Node's save, but the save itself takes time and may cross the attempt's deadline,
      // and the attempt is checked again now. A runtime whose save awaits must make this same check after its own
      // durability barrier. Too late: the new session is taken back off disk before anything is answered. Its cookie
      // was never sent, so nobody can ever present it; only a confirmed undo is reported as a refusal.
      if (!going(attempt)) {
        undo()
        try { world.flush() } catch { throw new WorldError('unavailable', 'This sign-in took too long and could not be cleaned up. Try again shortly.') }
        throw cancelledError()
      }
      attempt.state = 'done'
      const live = index(hash, record, Math.min(verifiedAt, at), credential.identity.email)
      for (const old of replaced) drop(old)
      return { setCookie: `${SESSION_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${ABSOLUTE_MS / 1000}`, view: { ...who(live), email: credential.identity.email }, authority: assertActive(live) }
    },
    /** Null for no cookie, a malformed or repeated cookie, an unknown, ended, cancelled or expired session. Never asks the provider. */
    resolve(cookieHeader: string | undefined): AccountSessionView | null {
      const live = find(cookieHeader)
      return live ? view(live) : null
    },
    /**
     * Authority for a grant. Asks the provider when the last confirmation is 30 seconds old; refuses when it is 60.
     * A rotated refresh token has been saved by this process before this resolves. Where saving is local and a later
     * await makes it durable, the caller must cross that barrier and then `assertActive` again before granting.
     */
    async fresh(input: { ref: string; generation: number }): Promise<SessionAuthority> {
      const live = byRef.get(input.ref)
      if (!live || live.generation !== input.generation) return assertActive(input)
      if (now() - live.verifiedAt >= REFRESH_AFTER_MS && (live.flight || now() >= live.retryAt)) await refresh(live)
      // Checked again after the wait, from nothing but the ref: sign-out or the provider may have ended it meanwhile.
      return assertActive(input)
    },
    /**
     * This cookie's session only. It is unusable from this line on; `saved` says whether the disk confirmed the
     * removal. When it did not, a crash before the next save could bring the record back, so the caller must not
     * report a confirmed sign-out.
     */
    end(cookieHeader: string | undefined): { endedRef: string | null; saved: boolean } {
      const value = cookieSecret(cookieHeader)
      if (!value || closed) return { endedRef: null, saved: !closed && confirmed() }
      const hash = digest(value), live = byHash.get(hash)
      if (live) drop(live)
      return { endedRef: live?.ref ?? null, saved: erase(hash) }
    },
    /** Called with the ref of every session that ends, however it ends, before the call that ended it returns. */
    onEnd(listener: (ref: string) => void): void { listeners.push(listener) },
    /** Expired records leave state here, on the tick, never on a request. Marks state changed; does not wait for the disk. */
    sweep(): void {
      if (closed) return
      forgetExpired()
      world.scoped(() => {
        const state = slice()
        let changed = false
        for (const [hash, record] of Object.entries(state.byHash)) {
          const live = byHash.get(hash)
          if (now() < (live ? expiresAt(live) : Math.min(record.absoluteExpiresAt, record.seenAt + IDLE_MS))) continue
          if (live) drop(live)
          delete state.byHash[hash]; changed = true
        }
        if (changed) world.touch()
      })
    },
    get size() { return byHash.size },
    close(): void { closed = true; lifetime.abort(); for (const attempt of attempts.values()) { attempt.state = 'cancelled'; attempt.abort.abort() } attempts.clear(); byHash.clear(); byRef.clear(); byAttempt.clear() },
  }
}
export type AccountSessions = ReturnType<typeof createAccountSessions>
