// Guest sessions and later claim.
//
// A guest is a member like any other, made without an account and reached through one opaque
// capability the service issued. Only the capability's SHA-256 is stored. The capability is bound
// to this service's scope (App, package, site, channel), expires, and can be revoked.
//
// A claim hands the guest's character to a Goalmatic account. It needs the capability and a
// principal the hosted bridge has already verified — an internal value, never something read
// from a request. The member id does not change, so every record keyed by it (avatar, coins,
// ledger, shifts, home, travel) is the claimed character's without being copied, and nothing can
// be granted twice. The claim itself is two writes in one slice: the record becomes `claimed`
// and `owners` maps the account to that member. Hosted sign-in reads that map (`memberFor`).
// An account that already has a character gets a conflict and nothing is changed.
//
// What an unclaimed guest may do is src/shared/guest.ts; `receive` and `call` apply it before
// the kernel reaches any handler. Nothing here falls back to a local test actor.
//
// Guests play each other and accounts in casual games. Two things keep that from becoming a way
// into rated play: the hall asks this module who may be rated (`setRatedRule`), so no match with
// a guest in it is ever rated; and an operation on an existing match is checked against the
// match's own record (`matchTerms`), not against what the request says.
import { createHash, randomBytes } from 'node:crypto'
import type { Iso, MemberId } from '../src/shared/ids.ts'
import { iso, ms, randomToken } from '../src/shared/ids.ts'
import { GUEST, GUEST_CREATOR_OPS, GUEST_GATE_MESSAGE, GUEST_MATCH_OPS, guestAccess, guestMayEnterMatch, isGuestToken } from '../src/shared/guest.ts'
import type { GuestClaimResult, GuestScope, GuestSession, GuestStatus, SavedCharacter } from '../src/shared/guest.ts'
import { WorldError } from '../src/shared/model.ts'
import type { ClientFrame, OpName, Ops } from '../src/shared/protocol.ts'
import { matchTerms, setRatedRule } from './arena/index.ts'
import type { HostedBinding, HostedSubject } from './hostedIdentity.ts'
import { hostedMemberId } from './hostedIdentity.ts'
import type { Connection, World } from './kernel.ts'
import { conversationPeer } from './direct.ts'
import { automaticFriendsOf, creatorOf, ensureMember, exists, record, removeFriendship } from './members.ts'

/** Who the transport is serving once a guest capability has been accepted. Same shape as the other actors. */
export interface GuestActor { memberId: MemberId; name: string; reviewer: false; guest: true }

declare const verified: unique symbol
/**
 * A Goalmatic identity the hosted bridge has already verified. It can only be made by
 * `principalFromHosted`; an object parsed from a request is refused by `claim` and `memberFor`.
 */
export type VerifiedPrincipal = Readonly<GuestScope & { accountId: string; subjectId: string; expiresAt: number }> & { readonly [verified]: true }

export interface GuestServiceOptions {
  /**
   * Whether new guests may be made here. There is no default: opening guest entry is a decision
   * about a host, made in its configuration. 'closed' still serves, claims and revokes the guests
   * that exist.
   */
  entry: 'open' | 'closed'
  /** Guests this world holds at a time. Default GUEST.maxActive. */
  maxActive?: number
}

export interface GuestService {
  readonly scope: GuestScope
  /** Create a guest member and its capability. `source` is the transport's own rate key for the caller. */
  issue(request: { source: string }): { session: GuestSession; actor: GuestActor }
  /** Accept a capability again (every connect). Moves `expiresAt` forward. */
  resume(request: { token: unknown; source: string }): { status: GuestStatus; actor: GuestActor }
  /** Null for anyone who is not an unclaimed, live guest. */
  status(memberId: MemberId): GuestStatus | null
  /** True for a member created as a guest and not yet claimed, whatever became of the capability. */
  isGuest(memberId: MemberId): boolean
  /** Throws `unauthorized` or `expired` once the guest's capability has no authority. Call before every frame. */
  assertActive(actor: GuestActor): void
  /** Throws `forbidden` when `memberId` is an unclaimed guest and the policy refuses `op`. Nothing for anyone else. */
  assertAllowed(memberId: MemberId, op: string, input: unknown): void
  /** `world.call` for a guest: active capability, then policy, then the operation. */
  call<K extends OpName>(actor: GuestActor, op: K, input: Ops[K]['in']): Ops[K]['out']
  /** `world.receive` for a guest connection: a refused request is answered and never reaches its handler. */
  receive(connection: Connection, actor: GuestActor, frame: ClientFrame): void
  /** Move the guest's character to the account. Needs the capability and a verified principal for this scope. */
  claim(request: { token: unknown; principal: VerifiedPrincipal; source: string }): GuestClaimResult
  /** The member a verified account plays as: its claimed guest, else `accountMemberId(principal)`. */
  memberFor(principal: VerifiedPrincipal): MemberId
  /** The guest gives the capability up. Never touches a claimed character. */
  revoke(request: { token: unknown; source: string }): { revoked: true }
  /** Operator or moderation: end an unclaimed guest's capability. False when there was nothing to end. */
  revokeMember(memberId: MemberId, reason: string): boolean
  counts(): { active: number; claimed: number; ended: number; foreign: number; capacity: number }
}

interface GuestRecord {
  memberId: MemberId
  scope: GuestScope
  /** SHA-256 of the capability. The capability itself is never stored. Null once nothing can be asked with it. */
  tokenHash: string | null
  state: 'active' | 'claimed' | 'revoked' | 'expired'
  createdAt: Iso
  lastSeenAt: Iso
  expiresAt: Iso
  endsAt: Iso
  /** When it was claimed, revoked or found expired. */
  endedAt: Iso | null
  /** `accountMemberId` of the principal that claimed it: a digest, not an account id. */
  owner: string | null
  reason: string | null
}
interface GuestSlice {
  guests: Record<string, GuestRecord>
  /** Capability hash → member. */
  tokens: Record<string, MemberId>
  /** `accountMemberId` → the member that account plays as. */
  owners: Record<string, { memberId: MemberId; claimedAt: Iso }>
}

const DAY = 86_400_000, HOUR = 3_600_000
const SWEEP_EVERY_MS = 60_000
const GUEST_NAME = 'Guest'
const GUEST_ID_PREFIX = 'm_guest_'
// One answer for every capability that proves nothing: unknown, malformed, revoked, or issued for another scope.
const REFUSED = 'This guest session is not valid. Start again as a guest, or sign in.'

const state = (world: World): GuestSlice => world.slice<GuestSlice>('guests', () => ({ guests: {}, tokens: {}, owners: {} }))
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
const sameScope = (a: GuestScope, b: GuestScope): boolean => a.appId === b.appId && a.packageId === b.packageId && a.siteId === b.siteId && a.channel === b.channel

function checkedScope(scope: GuestScope): GuestScope {
  if (!text(scope.appId) || !text(scope.packageId) || !text(scope.siteId) || (scope.channel !== 'test' && scope.channel !== 'store')) throw new Error('Incomplete guest scope.')
  return { appId: scope.appId, packageId: scope.packageId, siteId: scope.siteId, channel: scope.channel }
}

/** The guest scope of a hosted binding: `appId` is the binding's audience. */
export const scopeFromHosted = (binding: HostedBinding): GuestScope =>
  checkedScope({ appId: binding.audience, packageId: binding.packageId, siteId: binding.siteId, channel: binding.channel })

// Principals this process made from a verified hosted subject. Nothing parsed from a request can be in here.
const minted = new WeakSet<object>()

/** Call with `HostedActor.subject` from `createHostedIdentityAdapter(...).consume()`, nothing else. */
export function principalFromHosted(subject: HostedSubject): VerifiedPrincipal {
  if (!text(subject.accountId) || !text(subject.subjectId) || !Number.isSafeInteger(subject.expiresAt)) throw new Error('Incomplete Goalmatic service identity.')
  const principal = Object.freeze({ ...scopeFromHosted(subject), accountId: subject.accountId, subjectId: subject.subjectId, expiresAt: subject.expiresAt }) as VerifiedPrincipal
  minted.add(principal)
  return principal
}

/** The member id the hosted adapter derives for an account with no claimed guest. Same formula as `consume()`. */
export const accountMemberId = (principal: VerifiedPrincipal): MemberId =>
  hostedMemberId(principal)

const MATCH_OPS: ReadonlySet<string> = new Set(GUEST_MATCH_OPS)
const CREATOR_OPS: ReadonlySet<string> = new Set(GUEST_CREATOR_OPS)

/** Each world's own answer to "is this member an unclaimed guest?". A world with no guest service has none. */
const registered = new WeakMap<World, (memberId: MemberId) => boolean>()
// A rating belongs to an account. The hall asks this wherever a match is created or seated, so
// a guest is never in a rated game however they came to it, and earns no rating.
const ratedRule = (world: World, memberId: MemberId): boolean => registered.get(world)?.(memberId) !== true

/** Once per world, after `createWorld`. `scope` and `options.entry` come from the server's own configuration. */
export function registerGuests(world: World, scope: GuestScope, options: GuestServiceOptions): GuestService {
  if (registered.has(world)) throw new Error('Guests registered twice on one world.')
  if (options.entry !== 'open' && options.entry !== 'closed') throw new Error('Say whether guest entry is open or closed.')
  const bound = checkedScope(scope)
  registered.set(world, memberId => isGuest(memberId))
  setRatedRule(ratedRule)
  const capacity = options.maxActive ?? GUEST.maxActive
  let lastSweep = -Infinity
  let reconciled = false

  const refused = (): WorldError => new WorldError('unauthorized', REFUSED)
  function rateKey(source: string): string {
    if (!text(source)) throw new Error('A rate key for the caller is required.')
    return source
  }
  const attempt = (source: string): void => world.limit(`guest-attempt:${source}`, GUEST.attempts.perSource, GUEST.attempts.windowMs)

  const view = (rec: GuestRecord): GuestStatus => ({
    state: 'guest', memberId: rec.memberId, createdAt: rec.createdAt, lastSeenAt: rec.lastSeenAt, expiresAt: rec.expiresAt, endsAt: rec.endsAt,
  })
  const actorOf = (rec: GuestRecord): GuestActor => ({
    memberId: rec.memberId, name: exists(world, rec.memberId) ? record(world, rec.memberId).profile.displayName : GUEST_NAME, reviewer: false, guest: true,
  })
  function saved(memberId: MemberId): SavedCharacter {
    const { profile } = record(world, memberId)
    return { memberId, displayName: profile.displayName, look: { ...profile.look, face: null }, createdAt: profile.createdAt, onboarded: profile.onboardedAt !== null }
  }

  /**
   * Nobody can reach an ended guest, so the friendships the service made for them end too, the way
   * any removal does: off both members' lists and counts, and no new message either way. The
   * conversation and everything else kept for the member stay. A claim never comes here.
   */
  function unlink(memberId: MemberId): void {
    if (!exists(world, memberId)) return
    for (const other of automaticFriendsOf(world, memberId, Infinity)) {
      removeFriendship(world, memberId, other)
      world.push(other, { type: 'social.changed', scope: 'friends' })
    }
  }
  function finish(rec: GuestRecord, to: 'revoked' | 'expired', now: number, reason: string | null): void {
    rec.state = to
    rec.endedAt = iso(now)
    rec.reason = reason
    unlink(rec.memberId)
    world.touch()
  }
  /** Bring one record up to date with the clock. Expiry never waits for a tick. */
  function settle(rec: GuestRecord, now: number): void {
    if (rec.state === 'active' && ms(rec.expiresAt) <= now) finish(rec, 'expired', now, null)
  }
  function requireActive(rec: GuestRecord, now: number): void {
    settle(rec, now)
    if (rec.state === 'active') return
    if (rec.state === 'expired') throw new WorldError('expired', 'This guest session has expired and its character cannot be recovered. Start again as a guest, or sign in.')
    if (rec.state === 'claimed') throw new WorldError('unauthorized', 'This character was saved to an account. Sign in to carry on with it.')
    throw refused()
  }

  /** The record a capability belongs to, in whatever state. Throws for anything that is not one of this scope's capabilities. */
  function find(token: unknown): GuestRecord {
    if (!isGuestToken(token)) throw refused()
    const slice = state(world)
    const hash = digest(token)
    const memberId = slice.tokens[hash]
    const rec = memberId ? slice.guests[memberId] : undefined
    if (!rec || rec.tokenHash !== hash || !sameScope(rec.scope, bound)) throw refused()
    return rec
  }

  function trusted(principal: VerifiedPrincipal): VerifiedPrincipal {
    if (typeof principal !== 'object' || principal === null || !minted.has(principal)) throw new WorldError('unauthorized', 'A verified Goalmatic sign-in is required.')
    if (!sameScope(principal, bound)) throw new WorldError('forbidden', 'That sign-in is for a different App or channel.')
    return principal
  }

  function forget(slice: GuestSlice, rec: GuestRecord): void {
    if (rec.tokenHash) delete slice.tokens[rec.tokenHash]
    rec.tokenHash = null
  }

  /** Expire what is due, stop answering old claim retries, and drop records nobody can use. Of the member's own data only a service-made friendship ends (`unlink`). */
  function sweep(now: number): void {
    const slice = state(world)
    let changed = false
    for (const rec of Object.values(slice.guests)) {
      if (rec.state === 'active') {
        if (ms(rec.expiresAt) <= now) finish(rec, 'expired', now, null)
        continue
      }
      const ended = rec.endedAt ? ms(rec.endedAt) : now
      // Once after a start: a guest saved as ended with a friendship still standing loses it now.
      if (!reconciled && rec.state !== 'claimed') unlink(rec.memberId)
      if (rec.state === 'claimed') {
        // The claim stays for good; only the answer to a repeated claim with the old capability stops.
        if (rec.tokenHash && now - ended >= GUEST.claimRetryHours * HOUR) { forget(slice, rec); changed = true }
      } else if (now - ended >= GUEST.recordKeptDays * DAY) {
        forget(slice, rec)
        delete slice.guests[rec.memberId]
        changed = true
      }
    }
    reconciled = true
    if (changed) world.touch()
  }
  world.onTick(now => {
    if (now - lastSweep < SWEEP_EVERY_MS) return
    lastSweep = now
    sweep(now)
  })

  // Asked for every operation of every member, so it only looks: the slice is not counted as changed.
  function isGuest(memberId: MemberId): boolean {
    const rec = world.peek<GuestSlice>('guests')?.guests[memberId]
    // A guest whose record has been dropped is still not an account member.
    return rec ? rec.state !== 'claimed' : memberId.startsWith(GUEST_ID_PREFIX)
  }
  function assertActive(actor: GuestActor): void {
    world.scoped(() => {
      const rec = state(world).guests[actor.memberId]
      if (!rec || !sameScope(rec.scope, bound)) throw refused()
      requireActive(rec, world.now())
    })
  }
  function assertAllowed(memberId: MemberId, op: string, input: unknown): void {
    if (!isGuest(memberId)) return
    const access = guestAccess(op, input)
    if (!access.allowed) throw new WorldError('forbidden', access.message)
    if (CREATOR_OPS.has(op)) assertCreatorOnly(memberId, op, input)
    if (!MATCH_OPS.has(op)) return
    // The match as the hall recorded it decides, not anything the request says about it. A match
    // that does not exist is left to the operation, which answers "not found".
    const matchId = typeof input === 'object' && input !== null ? (input as { matchId?: unknown }).matchId : undefined
    const terms = typeof matchId === 'string' ? matchTerms(world, matchId) : null
    if (terms && !guestMayEnterMatch(terms)) throw new WorldError('forbidden', GUEST_GATE_MESSAGE.competition)
  }
  /**
   * A guest's messaging reaches one member: the creator this world has verified. Which member that
   * is, and whose conversation an id names, are read from the service's own records. With no
   * creator bound, or for anyone and anything else, the answer is the one a guest always got.
   */
  function assertCreatorOnly(memberId: MemberId, op: string, input: unknown): void {
    const creator = creatorOf(world)
    const named = typeof input === 'object' && input !== null ? input as { memberId?: unknown; conversationId?: unknown } : {}
    const target = op === 'direct.open' || op === 'friends.remove' ? named.memberId
      : typeof named.conversationId === 'string' ? conversationPeer(world, named.conversationId, memberId) : null
    if (!creator || target !== creator) throw new WorldError('forbidden', GUEST_GATE_MESSAGE[op === 'friends.remove' ? 'social' : 'messaging'])
  }
  function call<K extends OpName>(actor: GuestActor, op: K, input: Ops[K]['in']): Ops[K]['out'] {
    assertActive(actor)
    assertAllowed(actor.memberId, op, input)
    return world.call(actor.memberId, op, input)
  }

  return {
    scope: bound,

    issue(request) {
      const source = rateKey(request.source)
      if (options.entry !== 'open') throw new WorldError('forbidden', 'Guest play is not open here. Sign in to play.')
      return world.scoped(() => {
        world.limit(`guest-issue:${source}`, GUEST.issue.perSource, GUEST.issue.perSourceWindowMs)
        world.limit('guest-issue', GUEST.issue.overall, GUEST.issue.overallWindowMs)
        const now = world.now()
        sweep(now)
        const slice = state(world)
        if (Object.values(slice.guests).filter(rec => rec.state === 'active').length >= capacity) {
          throw new WorldError('unavailable', 'Guest play is full right now. Try again in a little while, or sign in.')
        }
        let memberId: MemberId
        do { memberId = `${GUEST_ID_PREFIX}${randomToken(20)}` as MemberId } while (slice.guests[memberId] || exists(world, memberId))
        const token = `gst_${randomBytes(32).toString('base64url')}`
        const tokenHash = digest(token)
        ensureMember(world, memberId, GUEST_NAME)
        const ends = now + GUEST.maxDays * DAY
        const rec: GuestRecord = {
          memberId, scope: { ...bound }, tokenHash, state: 'active', createdAt: iso(now), lastSeenAt: iso(now),
          expiresAt: iso(Math.min(ends, now + GUEST.idleDays * DAY)), endsAt: iso(ends), endedAt: null, owner: null, reason: null,
        }
        slice.guests[memberId] = rec
        slice.tokens[tokenHash] = memberId
        world.touch()
        return { session: { token, status: view(rec) }, actor: actorOf(rec) }
      })
    },

    resume(request) {
      const source = rateKey(request.source)
      return world.scoped(() => {
        attempt(source)
        const rec = find(request.token)
        const now = world.now()
        requireActive(rec, now)
        ensureMember(world, rec.memberId, GUEST_NAME)
        rec.lastSeenAt = iso(now)
        rec.expiresAt = iso(Math.min(ms(rec.endsAt), now + GUEST.idleDays * DAY))
        world.touch()
        return { status: view(rec), actor: actorOf(rec) }
      })
    },

    status(memberId) {
      return world.scoped(() => {
        const rec = state(world).guests[memberId]
        if (!rec || !sameScope(rec.scope, bound)) return null
        settle(rec, world.now())
        return rec.state === 'active' ? view(rec) : null
      })
    },

    isGuest, assertActive, assertAllowed, call,

    receive(connection, actor, frame) {
      if (connection.memberId !== actor.memberId) throw new Error('That connection does not belong to this guest.')
      try {
        assertActive(actor)
        if (frame.t === 'req') assertAllowed(actor.memberId, frame.op, frame.input)
      } catch (error) {
        if (!(error instanceof WorldError)) throw error
        if (frame.t === 'req') connection.send({ t: 'res', id: frame.id, ok: false, code: error.code, message: error.message })
        // A capability with no authority ends the connection; a refused operation does not.
        if (error.code !== 'forbidden') {
          connection.send({ t: 'denied', code: error.code, message: error.message })
          connection.close()
        }
        return
      }
      world.receive(connection, frame)
    },

    claim(request) {
      const source = rateKey(request.source)
      return world.scoped((): GuestClaimResult => {
        attempt(source)
        const principal = trusted(request.principal)
        const now = world.now()
        if (principal.expiresAt <= now) throw new WorldError('expired', 'That sign-in has expired. Sign in again to save your character.')
        const rec = find(request.token)
        const key = accountMemberId(principal)
        if (rec.state === 'claimed') {
          // The same account asking again gets the same answer. Anyone else holds a capability that proves nothing.
          if (rec.owner !== key || !rec.endedAt) throw refused()
          return { outcome: 'claimed', memberId: rec.memberId, claimedAt: rec.endedAt, repeated: true }
        }
        requireActive(rec, now)
        const slice = state(world)
        // The account's character: a guest it claimed earlier, or the member it made by signing in directly.
        const owned = slice.owners[key]?.memberId ?? (exists(world, key) ? key : null)
        if (owned) return { outcome: 'conflict', existing: saved(owned), choices: ['use-saved', 'keep-guest'] }
        if (!exists(world, rec.memberId)) throw new WorldError('not_found', 'That guest character was not found.')
        const claimedAt = iso(now)
        rec.state = 'claimed'
        rec.owner = key
        rec.endedAt = claimedAt
        slice.owners[key] = { memberId: rec.memberId, claimedAt }
        world.touch()
        return { outcome: 'claimed', memberId: rec.memberId, claimedAt, repeated: false }
      })
    },

    memberFor(principal) {
      const key = accountMemberId(trusted(principal))
      return world.peek<GuestSlice>('guests')?.owners[key]?.memberId ?? key
    },

    revoke(request) {
      const source = rateKey(request.source)
      return world.scoped(() => {
        attempt(source)
        const rec = find(request.token)
        const now = world.now()
        settle(rec, now)
        // A claimed character is the account's: the old capability cannot end it.
        if (rec.state === 'claimed') throw refused()
        if (rec.state === 'active') finish(rec, 'revoked', now, 'given up by the guest')
        return { revoked: true as const }
      })
    },

    revokeMember(memberId, reason) {
      return world.scoped(() => {
        const rec = state(world).guests[memberId]
        if (!rec) return false
        const now = world.now()
        settle(rec, now)
        if (rec.state !== 'active') return false
        finish(rec, 'revoked', now, reason.slice(0, 120))
        return true
      })
    },

    counts() {
      const out = { active: 0, claimed: 0, ended: 0, foreign: 0, capacity }
      for (const rec of Object.values(world.peek<GuestSlice>('guests')?.guests ?? {})) {
        if (!sameScope(rec.scope, bound)) out.foreign++
        if (rec.state === 'active') out.active++
        else if (rec.state === 'claimed') out.claimed++
        else out.ended++
      }
      return out
    },
  }
}
