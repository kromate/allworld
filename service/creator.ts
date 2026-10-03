// The creator connection and welcome.
//
// Every member who finishes onboarding is connected to the creator's real member and gets one
// automatic welcome message from them, in the game and nowhere else.
//
// Who the creator is: the member that a verified Goalmatic sign-in for the configured account and
// subject plays as (`guests.memberFor`, so a creator who started as a guest and claimed it is the
// same member). Never a name, never a local test actor, and never a member made here: until that
// member exists and has signed in, nothing is delivered and members who onboard simply wait.
//
// The connection is a tagged friendship (members.ts): it lets the two message each other and
// grants nothing that is for friends. A member may remove or block the creator; that is recorded
// and the connection is never made again, though the two can still become friends the usual way.
// Each member is welcomed once, by member id, whatever happens to the wording or to their account.
//
// With no configuration this module registers one read-only operation and delivers nothing. It
// still records a removal or block of a creator bound earlier, so that choice is not lost.
import { createHash } from 'node:crypto'
import { creatorWelcomeText } from '../src/shared/creator.ts'
import type { CreatorCard, CreatorHangout, CreatorLink } from '../src/shared/creator.ts'
import type { ConversationId } from '../src/shared/direct.ts'
import type { Iso, MemberId } from '../src/shared/ids.ts'
import { iso, ms } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import { conversationPeer, deliverAutomatic } from './direct.ts'
import type { GuestService, VerifiedPrincipal } from './guests.ts'
import type { World } from './kernel.ts'
import {
  addTaggedFriendship, allMemberIds, areFriends, creatorOf, exists, friendTag, isBlockedEitherWay, onBlock, onOnboarded, onUnfriend, publicMember,
  record, setCreator, tryPublicMember,
} from './members.ts'
import { empty } from './parse.ts'

export interface CreatorConfig {
  /** The creator's Goalmatic account and subject, from the server's own configuration. */
  account: { accountId: string; subjectId: string }
  /** A public place in the game to name in the welcome. Absent or null: none is named. */
  hangout?: CreatorHangout | null
  /** Welcome only members who finished onboarding at or after this instant. Absent or null: everyone who has. */
  onboardedSince?: number | null
}

export interface CreatorService {
  /** False when the module was registered with no configuration. */
  readonly enabled: boolean
  /**
   * Tell the module who just signed in, after their member exists. Binds the creator when the
   * principal is the configured account's; true when this member is now (or already was) the
   * creator. Throws for anything that is not a principal the hosted bridge verified for this world.
   */
  signedIn(principal: VerifiedPrincipal): boolean
  /** The creator as `viewer` may see them, and how the two stand. */
  card(viewer: MemberId): CreatorCard
  /** Deliver welcomes that are due, at most `limit` of them. Runs on the tick; returns how many were delivered. */
  catchUp(limit?: number): number
  status(): { enabled: boolean; ready: boolean; memberId: MemberId | null; welcomed: number; removed: number; scanning: boolean }
}

interface CreatorSlice {
  /** A digest of the account the creator was bound for. Not the account's ids. */
  account: string | null
  boundAt: Iso | null
  /** Member → their one welcome. */
  welcomed: Record<string, { at: Iso; conversationId: ConversationId }>
  /** Members who removed or blocked the creator, or were removed. They are not connected again. */
  removed: Record<string, Iso>
}

/** Welcomes delivered, and members looked at, in one tick while catching up. */
const BATCH = 25, LOOKED = 500
const NOT_READY: CreatorCard = { ready: false, member: null, link: 'none', conversationId: null, welcomedAt: null, hangout: null }

const state = (world: World): CreatorSlice => world.slice<CreatorSlice>('creator', () => ({ account: null, boundAt: null, welcomed: {}, removed: {} }))
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max

function checkedHangout(hangout: CreatorHangout | null | undefined): CreatorHangout | null {
  if (!hangout) return null
  if (!text(hangout.name, 60) || (hangout.areaLabel !== null && !text(hangout.areaLabel, 60))) throw new Error('The creator hangout needs a short place name.')
  return { name: hangout.name.trim(), areaLabel: hangout.areaLabel?.trim() ?? null }
}

/** Parse a server-owned binding. An account id alone never identifies the creator's character. */
export function checkedCreatorConfig(value: unknown): CreatorConfig {
  const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input)
  if (!object(value) || Object.keys(value).some(key => !['account', 'hangout', 'onboardedSince'].includes(key))
    || !object(value.account) || Object.keys(value.account).some(key => !['accountId', 'subjectId'].includes(key))
    || !text(value.account.accountId, 200) || !text(value.account.subjectId, 200)
    || value.account.accountId !== value.account.accountId.trim() || value.account.subjectId !== value.account.subjectId.trim()) {
    throw new Error('The creator binding requires an explicit server accountId and verified subjectId.')
  }
  const since = value.onboardedSince ?? null
  if (since !== null && (typeof since !== 'number' || !Number.isFinite(since))) throw new Error('The creator onboarding cutoff must be a finite timestamp.')
  let hangout: CreatorHangout | null = null
  if (value.hangout !== undefined && value.hangout !== null) {
    if (!object(value.hangout) || Object.keys(value.hangout).some(key => !['name', 'areaLabel'].includes(key))
      || !text(value.hangout.name, 60) || (value.hangout.areaLabel !== null && !text(value.hangout.areaLabel, 60))) {
      throw new Error('The creator hangout needs a short place name and optional area label.')
    }
    hangout = checkedHangout({ name: value.hangout.name, areaLabel: value.hangout.areaLabel })
  }
  return { account: { accountId: value.account.accountId, subjectId: value.account.subjectId }, hangout, onboardedSince: since }
}

/**
 * Once per world, after `registerGuests`. `options` comes from the server's own configuration;
 * null leaves the feature off.
 */
export function registerCreator(world: World, options: { guests: Pick<GuestService, 'memberFor' | 'isGuest' | 'status'>; config: CreatorConfig } | null): CreatorService {
  /**
   * Removing or blocking, by either of the two, is remembered once a creator is bound, welcomed yet
   * or not. It asks the stored binding and nothing about the configuration, so a choice made while
   * welcomes are off, or configured for another account, still stands when they come back. A world
   * with no stored creator is left as it is.
   */
  function ended(a: MemberId, b: MemberId): void {
    const creatorId = creatorOf(world)
    const memberId = a === creatorId ? b : b === creatorId ? a : null
    if (!creatorId || !memberId) return
    state(world).removed[memberId] ??= iso(world.now())
    world.touch()
  }
  onUnfriend((hookWorld, a, b) => { if (hookWorld === world) ended(a, b) })
  onBlock((hookWorld, blocker, blocked) => { if (hookWorld === world) ended(blocker, blocked) })

  if (!options) {
    world.register('creator.card', empty, () => ({ creator: NOT_READY }))
    return { enabled: false, signedIn: () => false, card: () => NOT_READY, catchUp: () => 0, status: () => ({ enabled: false, ready: false, memberId: null, welcomed: 0, removed: 0, scanning: false }) }
  }
  const { guests } = options
  const config = checkedCreatorConfig(options.config)
  const hangout = checkedHangout(config.hangout)
  const since = config.onboardedSince ?? null
  const welcome = creatorWelcomeText(hangout)
  const accountKey = createHash('sha256').update(JSON.stringify([config.account.accountId, config.account.subjectId])).digest('hex')
  // After a restart the members are looked through once more; anyone already welcomed is passed over.
  let scanning = true
  let cursor = 0

  const saved = (): CreatorSlice | undefined => world.peek<CreatorSlice>('creator')
  /** The bound creator member, when the binding was made for the account configured now. */
  function creator(): MemberId | null {
    const memberId = creatorOf(world)
    return memberId && saved()?.account === accountKey && exists(world, memberId) ? memberId : null
  }
  const ready = (memberId: MemberId): boolean => record(world, memberId).profile.onboardedAt !== null

  function due(memberId: MemberId, creatorId: MemberId): boolean {
    if (memberId === creatorId || !exists(world, memberId)) return false
    const { onboardedAt } = record(world, memberId).profile
    if (!onboardedAt || (since !== null && ms(onboardedAt) < since)) return false
    const data = saved()
    if (data?.welcomed[memberId] || data?.removed[memberId]) return false
    if (isBlockedEitherWay(world, memberId, creatorId)) return false
    // A guest whose capability has ended cannot be reached by anyone: nothing is left for them.
    if (guests.isGuest(memberId) && guests.status(memberId) === null) return false
    return true
  }

  /** The connection and the message, and the record that they happened, in one step. */
  function deliver(memberId: MemberId, creatorId: MemberId): void {
    // Two who are already friends stay exactly that; the welcome goes into the conversation they have.
    if (!areFriends(world, memberId, creatorId)) addTaggedFriendship(world, memberId, creatorId, 'creator')
    const { conversationId } = deliverAutomatic(world, { from: creatorId, to: memberId, text: welcome, kind: 'welcome' })
    state(world).welcomed[memberId] = { at: iso(world.now()), conversationId }
    world.touch()
    world.push(memberId, { type: 'social.changed', scope: 'friends' })
  }
  /** The creator's own friends list grew. Said once for a batch, not once per member. */
  const tellCreator = (creatorId: MemberId): void => world.push(creatorId, { type: 'social.changed', scope: 'friends' })

  function catchUp(limit = BATCH): number {
    const creatorId = creator()
    if (!scanning || !creatorId || !ready(creatorId)) return 0
    const ids = allMemberIds(world)
    let delivered = 0
    for (let looked = 0; cursor < ids.length && looked < LOOKED && delivered < limit; looked++) {
      const memberId = ids[cursor++]!
      if (!due(memberId, creatorId)) continue
      // One member's record must not stop everyone after them.
      try { deliver(memberId, creatorId); delivered++ } catch (error) { console.error(`[creator] could not welcome ${memberId}`, error) }
    }
    if (cursor >= ids.length) { scanning = false; cursor = 0 }
    if (delivered > 0) tellCreator(creatorId)
    return delivered
  }

  function welcomeMember(memberId: MemberId): void {
    const creatorId = creator()
    // No creator yet: the member waits, and is found when the creator is bound.
    if (creatorId && ready(creatorId) && due(memberId, creatorId)) { deliver(memberId, creatorId); tellCreator(creatorId) }
  }
  onOnboarded((hookWorld, memberId) => { if (hookWorld === world) welcomeMember(memberId) })
  // Reconnecting repairs an interrupted delivery without waiting for a server restart.
  world.onConnect(welcomeMember)

  world.onTick(() => { if (scanning) catchUp() })

  function card(viewer: MemberId): CreatorCard {
    const creatorId = creator()
    if (!creatorId || !ready(creatorId) || !exists(world, viewer)) return NOT_READY
    if (viewer === creatorId) return { ready: true, member: publicMember(world, viewer, viewer), link: 'self', conversationId: null, welcomedAt: null, hangout }
    const member = tryPublicMember(world, viewer, creatorId)
    const data = saved()
    const welcomed = data?.welcomed[viewer]
    const link: CreatorLink = !member ? 'removed' : areFriends(world, viewer, creatorId) ? 'friend' : friendTag(world, viewer, creatorId) ? 'automatic' : data?.removed[viewer] ? 'removed' : 'none'
    return {
      ready: true, member, link, hangout,
      conversationId: member && welcomed && conversationPeer(world, welcomed.conversationId, viewer) === creatorId ? welcomed.conversationId : null,
      welcomedAt: welcomed?.at ?? null,
    }
  }
  world.register('creator.card', empty, ctx => ({ creator: card(ctx.memberId) }))

  return {
    enabled: true,

    signedIn(principal) {
      // Refuses anything the hosted bridge did not verify for this world, before any comparison.
      const memberId = guests.memberFor(principal)
      if (principal.accountId !== config.account.accountId || principal.subjectId !== config.account.subjectId) return false
      if (principal.expiresAt <= world.now() || !exists(world, memberId)) return false
      return world.scoped(() => {
        const data = state(world)
        if (data.account !== null && data.account !== accountKey) throw new WorldError('conflict', 'This world’s creator was bound for a different account.')
        setCreator(world, memberId)
        if (data.boundAt === null) {
          data.account = accountKey
          data.boundAt = iso(world.now())
          scanning = true
          cursor = 0
          world.touch()
        }
        return true
      })
    },

    card,
    catchUp: limit => world.scoped(() => catchUp(limit)),

    status() {
      const data = saved()
      const memberId = creator()
      return { enabled: true, ready: memberId !== null && ready(memberId), memberId, welcomed: Object.keys(data?.welcomed ?? {}).length, removed: Object.keys(data?.removed ?? {}).length, scanning }
    },
  }
}
