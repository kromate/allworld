// Nearby discovery, mutual introductions, friends, communities and public-venue meetups.
import type { AreaId, CommunityId, DistrictId, IntroId, Iso, MeetupId, MemberId, PlaceId, PostId } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { neighbouringAreas, parseDistrictId } from '../src/shared/geo.ts'
import { WorldError } from '../src/shared/model.ts'
import type { PublicMember, Relation } from '../src/shared/model.ts'
import { COMMUNITY_TOPICS, INTRO_NOTE_MAX, INTRO_TTL_DAYS } from '../src/shared/social.ts'
import type {
  CommunityDetail, CommunityRole, CommunitySummary, CommunityTopic, CommunityVisibility, IntroStatus, Introduction, Meetup,
  MeetupAnswer, MeetupStatus, NearbyMember, PublicVenue,
} from '../src/shared/social.ts'
import type { World } from './kernel.ts'
import { requireFound } from './kernel.ts'
import { FRIENDS_AUTOMATIC_LISTED } from '../src/shared/creator.ts'
import {
  addFriendship, allMemberIds, areFriends, automaticFriendsOf, exists, freshArea, friendCounts, friendsOf, isBlockedEitherWay, onBlock, publicMember, record,
  removeFriendship, setIntroRelation, tryPublicMember,
} from './members.ts'
import { emit, settle } from './notify.ts'
import { bool, empty, id, isoInstant, list, obj, oneOf, str } from './parse.ts'

interface IntroRecord { id: IntroId; from: MemberId; to: MemberId; note: string; status: IntroStatus; createdAt: Iso; expiresAt: Iso; decidedAt: Iso | null }
interface PostRecord { id: PostId; author: MemberId; text: string; at: Iso; removed: boolean }
interface CommunityRecord {
  id: CommunityId; name: string; about: string; topic: CommunityTopic; areaLabel: string; visibility: CommunityVisibility
  members: { memberId: MemberId; role: CommunityRole; joinedAt: Iso }[]
  invited: MemberId[]
  posts: PostRecord[]
  createdAt: Iso
}
interface MeetupRecord {
  id: MeetupId; organiser: MemberId; venue: PublicVenue; startsAt: Iso; timezone: string; note: string
  cancelled: boolean; revision: number
  participants: { memberId: MemberId; answer: MeetupAnswer; answeredAt: Iso | null }[]
  createdAt: Iso; updatedAt: Iso
}
interface SocialState { intros: Record<string, IntroRecord>; communities: Record<string, CommunityRecord>; meetups: Record<string, MeetupRecord> }

const DAY = 86_400_000
const state = (world: World): SocialState => world.slice<SocialState>('social', () => ({ intros: {}, communities: {}, meetups: {} }))

interface NearbyIndex { byArea: Map<AreaId, Set<MemberId>>; byMember: Map<MemberId, AreaId> }
const nearbyIndexes = new WeakMap<World, NearbyIndex>()

function indexNearbyMember(world: World, index: NearbyIndex, memberId: MemberId): void {
  const previous = index.byMember.get(memberId)
  if (previous) {
    const members = index.byArea.get(previous)
    members?.delete(memberId)
    if (members?.size === 0) index.byArea.delete(previous)
    index.byMember.delete(memberId)
  }
  const { profile } = record(world, memberId)
  // Keep the stored cell even after expiry. Every read checks freshness, including clock resets.
  if (!profile.currentArea || !profile.preferences.discoverable) return
  const areaId = profile.currentArea.areaId
  let members = index.byArea.get(areaId)
  if (!members) { members = new Set(); index.byArea.set(areaId, members) }
  members.add(memberId)
  index.byMember.set(memberId, areaId)
}

function nearbyIndex(world: World): NearbyIndex {
  let index = nearbyIndexes.get(world)
  if (!index) {
    index = { byArea: new Map(), byMember: new Map() }
    for (const memberId of allMemberIds(world)) indexNearbyMember(world, index, memberId)
    nearbyIndexes.set(world, index)
  }
  return index
}

// ── Communities shared helpers (used by games for community boards) ──

export function communityMemberIds(world: World, communityId: CommunityId): MemberId[] {
  return state(world).communities[communityId]?.members.map(entry => entry.memberId) ?? []
}
export function isCommunityMember(world: World, communityId: CommunityId, memberId: MemberId): boolean {
  return communityMemberIds(world, communityId).includes(memberId)
}
export const communityName = (world: World, communityId: CommunityId): string | null => state(world).communities[communityId]?.name ?? null
export function communitiesOf(world: World, memberId: MemberId): CommunityId[] {
  return Object.values(state(world).communities).filter(c => c.members.some(m => m.memberId === memberId)).map(c => c.id)
}

function pendingIntro(world: World, a: MemberId, b: MemberId): IntroRecord | undefined {
  return Object.values(state(world).intros).find(intro => intro.status === 'pending'
    && ((intro.from === a && intro.to === b) || (intro.from === b && intro.to === a)))
}

function introView(world: World, viewer: MemberId, intro: IntroRecord): Introduction | null {
  const from = tryPublicMember(world, viewer, intro.from), to = tryPublicMember(world, viewer, intro.to)
  if (!from || !to) return null
  return { id: intro.id, from, to, note: intro.note, status: intro.status, createdAt: intro.createdAt, expiresAt: intro.expiresAt, decidedAt: intro.decidedAt }
}

function communitySummary(viewer: MemberId, community: CommunityRecord): CommunitySummary {
  return {
    id: community.id, name: community.name, about: community.about, topic: community.topic, areaLabel: community.areaLabel,
    visibility: community.visibility, memberCount: community.members.length,
    myRole: community.members.find(entry => entry.memberId === viewer)?.role ?? null, createdAt: community.createdAt,
  }
}

function communityDetail(world: World, viewer: MemberId, community: CommunityRecord): CommunityDetail {
  const summary = communitySummary(viewer, community)
  // Non-members of an invite-only community see the summary without the roster or the posts.
  const inside = summary.myRole !== null || community.visibility === 'public'
  const members = inside ? community.members.flatMap(entry => {
    const member = tryPublicMember(world, viewer, entry.memberId)
    return member ? [{ member, role: entry.role, joinedAt: entry.joinedAt }] : []
  }) : []
  const posts = summary.myRole === null ? [] : community.posts.slice(-60).flatMap(post => {
    const author = tryPublicMember(world, viewer, post.author)
    return author ? [{ id: post.id, communityId: community.id, author, text: post.removed ? '' : post.text, at: post.at, removed: post.removed }] : []
  })
  return { ...summary, members, posts }
}

function meetupStatus(world: World, meetup: MeetupRecord): MeetupStatus {
  if (meetup.cancelled) return 'cancelled'
  if (ms(meetup.startsAt) + 3 * 3_600_000 < world.now()) return 'past'
  return meetup.participants.some(entry => entry.answer === 'accepted') ? 'agreed' : 'proposed'
}

function meetupView(world: World, viewer: MemberId, meetup: MeetupRecord): Meetup {
  return {
    id: meetup.id, organiser: publicMember(world, viewer, meetup.organiser), venue: meetup.venue, startsAt: meetup.startsAt,
    timezone: meetup.timezone, note: meetup.note, status: meetupStatus(world, meetup), revision: meetup.revision,
    participants: meetup.participants.flatMap(entry => {
      const member = tryPublicMember(world, viewer, entry.memberId)
      return member ? [{ member, answer: entry.answer, answeredAt: entry.answeredAt }] : []
    }),
    createdAt: meetup.createdAt, updatedAt: meetup.updatedAt,
  }
}

function parseVenue(value: unknown): PublicVenue {
  const raw = obj(value, 'venue')
  const districtId = str(raw, 'districtId', { max: 40 }) as DistrictId
  if (!parseDistrictId(districtId)) throw new WorldError('invalid', 'venue.districtId is not a valid district')
  const placeId = str(raw, 'placeId', { min: 1, max: 80 })
  if (!/^[A-Za-z0-9:_-]+$/.test(placeId)) throw new WorldError('invalid', 'venue.placeId is not valid')
  return {
    placeId: placeId as PlaceId, districtId, name: str(raw, 'name', { min: 1, max: 100 }),
    category: str(raw, 'category', { min: 1, max: 40 }), branch: str(raw, 'branch', { max: 120 }),
  }
}

const formatWhen = (at: number, timezone: string): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(at)

export function registerSocial(world: World): void {
  world.onOperation((memberId, op) => {
    const index = nearbyIndexes.get(world)
    if (index && (op === 'member.setCurrentArea' || op === 'member.clearCurrentArea' || op === 'member.savePreferences')) indexNearbyMember(world, index, memberId)
  })
  setIntroRelation((_world, viewer, target): Relation | null => {
    const intro = pendingIntro(_world, viewer, target)
    return intro ? (intro.from === viewer ? 'intro-sent' : 'intro-received') : null
  })

  onBlock((blockWorld, blocker, blocked) => {
    if (blockWorld !== world) return
    const intro = pendingIntro(world, blocker, blocked)
    if (intro) { intro.status = 'withdrawn'; intro.decidedAt = iso(world.now()); settle(world, intro.to, `intro:${intro.id}`) }
    // The blocker's App reloads what it changed. The other side's open lists are told too, as when a friend is removed or an introduction withdrawn.
    world.push(blocked, { type: 'social.changed', scope: 'friends' })
    if (intro) for (const memberId of [blocker, blocked]) world.push(memberId, { type: 'social.changed', scope: 'intros' })
  })

  world.onTick(now => {
    for (const intro of Object.values(state(world).intros)) {
      if (intro.status === 'pending' && ms(intro.expiresAt) <= now) { intro.status = 'expired'; intro.decidedAt = iso(now); world.touch() }
    }
  })

  // ── Nearby ──
  // Listed only when both sides have a fresh confirmed area and opted in. Matching uses the
  // coarse cell and its neighbours; no distance or direction is computed or returned.
  world.register('nearby.list', empty, ctx => {
    const me = record(world, ctx.memberId)
    const mine = freshArea(world, ctx.memberId)
    const discoverable = me.profile.preferences.discoverable
    const base = { areaLabel: mine?.label ?? null, stale: Boolean(me.profile.currentArea) && !mine, discoverable }
    const sharedByMember = new Map<MemberId, string[]>()
    const candidates = new Set<MemberId>()
    for (const community of Object.values(state(world).communities)) {
      if (!community.members.some(entry => entry.memberId === ctx.memberId)) continue
      for (const { memberId } of community.members) {
        candidates.add(memberId)
        const names = sharedByMember.get(memberId) ?? []
        if (names.length < 3) names.push(community.name)
        sharedByMember.set(memberId, names)
      }
    }
    const members: NearbyMember[] = []
    const near = mine && discoverable ? new Set<AreaId>(neighbouringAreas(mine.areaId)) : new Set<AreaId>()
    if (near.size) for (const areaId of near) for (const other of nearbyIndex(world).byArea.get(areaId) ?? []) candidates.add(other)
    for (const other of candidates) {
      if (other === ctx.memberId || isBlockedEitherWay(world, ctx.memberId, other)) continue
      const theirs = freshArea(world, other)
      const sharedCommunities = sharedByMember.get(other) ?? []
      const optedIn = record(world, other).profile.preferences.discoverable
      let reason: NearbyMember['reason'] | null = null
      if (mine && discoverable && theirs && optedIn && near.has(theirs.areaId)) reason = theirs.areaId === mine.areaId ? 'same-area' : 'neighbouring-area'
      else if (sharedCommunities.length) reason = 'shared-community'
      if (!reason || !record(world, other).profile.onboardedAt) continue
      members.push({ ...publicMember(world, ctx.memberId, other), reason, sharedCommunities })
    }
    const order = { 'same-area': 0, 'neighbouring-area': 1, 'shared-community': 2 }
    members.sort((a, b) => order[a.reason] - order[b.reason] || a.displayName.localeCompare(b.displayName))
    return { members: members.slice(0, 60), ...base }
  })

  // ── Introductions ──
  world.register('intro.send', value => {
    const raw = obj(value)
    return { to: id<MemberId>(raw, 'to', 'm'), note: str(raw, 'note', { max: INTRO_NOTE_MAX }) }
  }, (ctx, input) => {
    world.limit(`intro:${ctx.memberId}`, 10, 3_600_000)
    if (input.to === ctx.memberId) throw new WorldError('invalid', 'You cannot introduce yourself to yourself.')
    const target = publicMember(world, ctx.memberId, input.to)
    if (areFriends(world, ctx.memberId, input.to)) throw new WorldError('conflict', `You and ${target.displayName} are already friends.`)
    const existing = pendingIntro(world, ctx.memberId, input.to)
    if (existing) throw new WorldError('conflict', existing.from === ctx.memberId ? 'Your introduction is still waiting for an answer.' : `${target.displayName} already sent you an introduction. Answer it instead.`)
    const intro: IntroRecord = {
      id: newId<IntroId>('i'), from: ctx.memberId, to: input.to, note: input.note, status: 'pending',
      createdAt: iso(ctx.now), expiresAt: iso(ctx.now + INTRO_TTL_DAYS * DAY), decidedAt: null,
    }
    state(world).intros[intro.id] = intro
    world.touch()
    const sender = record(world, ctx.memberId).profile.displayName
    emit(world, {
      to: input.to, category: 'social', kind: 'intro.received', title: `${sender} would like to connect`,
      body: input.note || 'Open to accept or decline.', link: '/people?tab=requests', actor: ctx.memberId,
      dedupeKey: `intro:${intro.id}`, expiresAt: ms(intro.expiresAt),
    })
    world.push(input.to, { type: 'social.changed', scope: 'intros' })
    world.push(ctx.memberId, { type: 'social.changed', scope: 'intros' })
    return { intro: introView(world, ctx.memberId, intro)! }
  })

  world.register('intro.respond', value => {
    const raw = obj(value)
    return { introId: id<IntroId>(raw, 'introId', 'i'), accept: bool(raw, 'accept') }
  }, (ctx, input) => {
    const intro = requireFound(state(world).intros[input.introId], 'That introduction')
    if (intro.to !== ctx.memberId) throw new WorldError('forbidden', 'Only the person invited can answer this introduction.')
    if (intro.status !== 'pending') throw new WorldError('conflict', `This introduction was already ${intro.status}.`)
    if (ms(intro.expiresAt) <= ctx.now) { intro.status = 'expired'; world.touch(); throw new WorldError('expired', 'This introduction expired. You can send a new one.') }
    intro.status = input.accept ? 'accepted' : 'declined'
    intro.decidedAt = iso(ctx.now)
    settle(world, ctx.memberId, `intro:${intro.id}`)
    if (input.accept) {
      addFriendship(world, intro.from, intro.to)
      emit(world, {
        to: intro.from, category: 'social', kind: 'intro.accepted', title: `${record(world, ctx.memberId).profile.displayName} accepted your introduction`,
        body: 'You are now friends. Say hello or start a game.', link: '/people?tab=friends', actor: ctx.memberId, dedupeKey: `intro-accepted:${intro.id}`,
      })
    }
    world.touch()
    for (const memberId of [intro.from, intro.to]) { world.push(memberId, { type: 'social.changed', scope: 'intros' }); if (input.accept) world.push(memberId, { type: 'social.changed', scope: 'friends' }) }
    return { intro: introView(world, ctx.memberId, intro)! }
  })

  world.register('intro.withdraw', value => ({ introId: id<IntroId>(obj(value), 'introId', 'i') }), (ctx, input) => {
    const intro = requireFound(state(world).intros[input.introId], 'That introduction')
    if (intro.from !== ctx.memberId) throw new WorldError('forbidden', 'Only the sender can withdraw an introduction.')
    if (intro.status !== 'pending') throw new WorldError('conflict', `This introduction was already ${intro.status}.`)
    intro.status = 'withdrawn'
    intro.decidedAt = iso(ctx.now)
    settle(world, intro.to, `intro:${intro.id}`)
    world.touch()
    for (const memberId of [intro.from, intro.to]) world.push(memberId, { type: 'social.changed', scope: 'intros' })
    return { intro: introView(world, ctx.memberId, intro)! }
  })

  world.register('intro.list', empty, ctx => {
    const mine = Object.values(state(world).intros).filter(intro => intro.status === 'pending' && ms(intro.expiresAt) > ctx.now)
    const view = (entries: IntroRecord[]): Introduction[] => entries.flatMap(intro => { const v = introView(world, ctx.memberId, intro); return v ? [v] : [] })
    return { incoming: view(mine.filter(intro => intro.to === ctx.memberId)), outgoing: view(mine.filter(intro => intro.from === ctx.memberId)) }
  })

  // The directory lists a friendship whoever made it: accepted by both, or made by the service
  // (each card says which). What friends are given is decided elsewhere, by `areFriends`.
  const friendList = (viewer: MemberId): { friends: PublicMember[]; total: number } => {
    const counts = friendCounts(world, viewer)
    const friends = [...friendsOf(world, viewer), ...automaticFriendsOf(world, viewer, FRIENDS_AUTOMATIC_LISTED)]
      .flatMap(friend => { const member = tryPublicMember(world, viewer, friend); return member ? [member] : [] })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName))
    return { friends, total: counts.accepted + counts.automatic }
  }

  world.register('friends.list', empty, ctx => friendList(ctx.memberId))

  world.register('friends.remove', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    removeFriendship(world, ctx.memberId, input.memberId)
    world.push(input.memberId, { type: 'social.changed', scope: 'friends' })
    return friendList(ctx.memberId)
  })

  // ── Communities ──
  const community = (communityId: CommunityId): CommunityRecord => requireFound(state(world).communities[communityId], 'That community')
  const roleOf = (entry: CommunityRecord, memberId: MemberId): CommunityRole | null => entry.members.find(m => m.memberId === memberId)?.role ?? null
  const requireRole = (entry: CommunityRecord, memberId: MemberId, allowed: CommunityRole[], action: string): CommunityRole => {
    const role = roleOf(entry, memberId)
    if (!role || !allowed.includes(role)) throw new WorldError('forbidden', `Only ${allowed.join(' or ')}s can ${action}.`)
    return role
  }
  const notifyCommunity = (entry: CommunityRecord): void => { for (const m of entry.members) world.push(m.memberId, { type: 'social.changed', scope: 'communities' }) }

  world.register('community.list', empty, ctx => {
    const all = Object.values(state(world).communities)
    const mine = all.filter(entry => roleOf(entry, ctx.memberId)).map(entry => communitySummary(ctx.memberId, entry))
    const discover = all.filter(entry => !roleOf(entry, ctx.memberId) && (entry.visibility === 'public' || entry.invited.includes(ctx.memberId)))
      .map(entry => communitySummary(ctx.memberId, entry)).sort((a, b) => b.memberCount - a.memberCount).slice(0, 40)
    return { mine: mine.sort((a, b) => a.name.localeCompare(b.name)), discover }
  })

  world.register('community.create', value => {
    const raw = obj(value)
    return {
      name: str(raw, 'name', { min: 3, max: 48 }), about: str(raw, 'about', { max: 240 }), topic: oneOf(raw, 'topic', COMMUNITY_TOPICS),
      areaLabel: str(raw, 'areaLabel', { max: 80 }), visibility: oneOf(raw, 'visibility', ['public', 'invite-only'] as const),
    }
  }, (ctx, input) => {
    world.limit(`community-create:${ctx.memberId}`, 5, 3_600_000)
    const taken = Object.values(state(world).communities).some(entry => entry.name.toLowerCase() === input.name.toLowerCase())
    if (taken) throw new WorldError('conflict', 'A community with that name already exists.')
    const created: CommunityRecord = {
      id: newId<CommunityId>('c'), ...input, areaLabel: input.areaLabel || 'Global',
      members: [{ memberId: ctx.memberId, role: 'owner', joinedAt: iso(ctx.now) }], invited: [], posts: [], createdAt: iso(ctx.now),
    }
    state(world).communities[created.id] = created
    world.touch()
    return { community: communityDetail(world, ctx.memberId, created) }
  })

  world.register('community.get', value => ({ communityId: id<CommunityId>(obj(value), 'communityId', 'c') }), (ctx, input) => {
    const entry = community(input.communityId)
    if (entry.visibility === 'invite-only' && !roleOf(entry, ctx.memberId) && !entry.invited.includes(ctx.memberId)) throw new WorldError('not_found', 'That community was not found.')
    return { community: communityDetail(world, ctx.memberId, entry) }
  })

  world.register('community.join', value => ({ communityId: id<CommunityId>(obj(value), 'communityId', 'c') }), (ctx, input) => {
    const entry = community(input.communityId)
    if (roleOf(entry, ctx.memberId)) return { community: communityDetail(world, ctx.memberId, entry) }
    if (entry.visibility === 'invite-only' && !entry.invited.includes(ctx.memberId)) throw new WorldError('forbidden', 'This community is invite-only. Ask a member to invite you.')
    if (entry.members.length >= 500) throw new WorldError('conflict', 'This community is full.')
    entry.members.push({ memberId: ctx.memberId, role: 'member', joinedAt: iso(ctx.now) })
    entry.invited = entry.invited.filter(invited => invited !== ctx.memberId)
    settle(world, ctx.memberId, `community-invite:${entry.id}`)
    world.touch()
    notifyCommunity(entry)
    return { community: communityDetail(world, ctx.memberId, entry) }
  })

  world.register('community.leave', value => ({ communityId: id<CommunityId>(obj(value), 'communityId', 'c') }), (ctx, input) => {
    const entry = community(input.communityId)
    const role = roleOf(entry, ctx.memberId)
    if (!role) return { left: true as const }
    entry.members = entry.members.filter(m => m.memberId !== ctx.memberId)
    if (entry.members.length === 0) delete state(world).communities[entry.id]
    else if (role === 'owner') {
      // Ownership passes to the longest-standing moderator, otherwise the longest-standing member.
      const heir = entry.members.find(m => m.role === 'moderator') ?? entry.members[0]!
      heir.role = 'owner'
    }
    world.touch()
    notifyCommunity(entry)
    return { left: true as const }
  })

  world.register('community.invite', value => {
    const raw = obj(value)
    return { communityId: id<CommunityId>(raw, 'communityId', 'c'), memberId: id<MemberId>(raw, 'memberId', 'm') }
  }, (ctx, input) => {
    const entry = community(input.communityId)
    if (!roleOf(entry, ctx.memberId)) throw new WorldError('forbidden', 'Join the community before inviting others.')
    publicMember(world, ctx.memberId, input.memberId)
    if (roleOf(entry, input.memberId)) throw new WorldError('conflict', 'They are already a member.')
    if (!entry.invited.includes(input.memberId)) entry.invited.push(input.memberId)
    world.touch()
    emit(world, {
      to: input.memberId, category: 'social', kind: 'community.invited', title: `You were invited to ${entry.name}`,
      body: entry.about || 'Open to see the community and join.', link: `/communities/${entry.id}`, actor: ctx.memberId,
      dedupeKey: `community-invite:${entry.id}`, expiresAt: ctx.now + 30 * DAY,
    })
    return { invited: true as const }
  })

  world.register('community.post', value => {
    const raw = obj(value)
    return { communityId: id<CommunityId>(raw, 'communityId', 'c'), text: str(raw, 'text', { min: 1, max: 500 }) }
  }, (ctx, input) => {
    world.limit(`post:${ctx.memberId}`, 12, 60_000)
    const entry = community(input.communityId)
    if (!roleOf(entry, ctx.memberId)) throw new WorldError('forbidden', 'Join the community to post.')
    entry.posts.push({ id: newId<PostId>('p'), author: ctx.memberId, text: input.text, at: iso(ctx.now), removed: false })
    if (entry.posts.length > 300) entry.posts.shift()
    world.touch()
    const author = record(world, ctx.memberId).profile.displayName
    for (const m of entry.members) {
      if (m.memberId === ctx.memberId) continue
      emit(world, {
        to: m.memberId, category: 'replies', kind: 'community.post', title: `New in ${entry.name}`,
        body: `${author}: ${input.text.slice(0, 120)}`, link: `/communities/${entry.id}`, actor: ctx.memberId, dedupeKey: `community-post:${entry.id}`,
      })
    }
    notifyCommunity(entry)
    return { community: communityDetail(world, ctx.memberId, entry) }
  })

  world.register('community.removePost', value => {
    const raw = obj(value)
    return { communityId: id<CommunityId>(raw, 'communityId', 'c'), postId: id<PostId>(raw, 'postId', 'p') }
  }, (ctx, input) => {
    const entry = community(input.communityId)
    const post = requireFound(entry.posts.find(p => p.id === input.postId), 'That post')
    if (post.author !== ctx.memberId) requireRole(entry, ctx.memberId, ['owner', 'moderator'], 'remove other members’ posts')
    post.removed = true
    world.touch()
    notifyCommunity(entry)
    return { community: communityDetail(world, ctx.memberId, entry) }
  })

  world.register('community.setRole', value => {
    const raw = obj(value)
    return {
      communityId: id<CommunityId>(raw, 'communityId', 'c'), memberId: id<MemberId>(raw, 'memberId', 'm'),
      role: oneOf(raw, 'role', ['owner', 'moderator', 'member', 'removed'] as const),
    }
  }, (ctx, input) => {
    const entry = community(input.communityId)
    const actor = requireRole(entry, ctx.memberId, ['owner', 'moderator'], 'manage members')
    const target = requireFound(entry.members.find(m => m.memberId === input.memberId), 'That member')
    if (target.memberId === ctx.memberId) throw new WorldError('invalid', 'Use Leave to remove yourself, or hand ownership to someone else first.')
    if (target.role === 'owner') throw new WorldError('forbidden', 'The owner cannot be changed by others.')
    if (actor === 'moderator' && (input.role !== 'removed' || target.role !== 'member')) throw new WorldError('forbidden', 'Moderators can only remove ordinary members.')
    if (input.role === 'removed') entry.members = entry.members.filter(m => m.memberId !== input.memberId)
    else if (input.role === 'owner') { target.role = 'owner'; entry.members.find(m => m.memberId === ctx.memberId)!.role = 'moderator' }
    else target.role = input.role
    world.touch()
    notifyCommunity(entry)
    world.push(input.memberId, { type: 'social.changed', scope: 'communities' })
    return { community: communityDetail(world, ctx.memberId, entry) }
  })

  // ── Public meetups ──
  // A meetup names a public venue from the map, a branch note and a time. It never carries a
  // participant's starting point, route or current area.
  const meetup = (meetupId: MeetupId): MeetupRecord => requireFound(state(world).meetups[meetupId], 'That meetup')
  const involved = (entry: MeetupRecord, memberId: MemberId): boolean => entry.organiser === memberId || entry.participants.some(p => p.memberId === memberId)
  const tellParticipants = (entry: MeetupRecord): void => {
    for (const memberId of [entry.organiser, ...entry.participants.map(p => p.memberId)]) world.push(memberId, { type: 'social.changed', scope: 'meetups' })
  }
  const parsePlan = (raw: Record<string, unknown>, now: number) => {
    const startsAt = isoInstant(raw, 'startsAt')
    if (startsAt < now + 10 * 60_000) throw new WorldError('invalid', 'Choose a time at least 10 minutes from now.')
    if (startsAt > now + 180 * DAY) throw new WorldError('invalid', 'Choose a time within the next six months.')
    const timezone = str(raw, 'timezone', { min: 1, max: 64 })
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw new WorldError('invalid', 'That timezone is not known.') }
    return { venue: parseVenue(raw.venue), startsAt, timezone, note: str(raw, 'note', { max: 240 }) }
  }

  world.register('meetup.list', empty, ctx => ({
    meetups: Object.values(state(world).meetups).filter(entry => involved(entry, ctx.memberId) && !isBlockedEitherWay(world, ctx.memberId, entry.organiser))
      .map(entry => meetupView(world, ctx.memberId, entry)).sort((a, b) => ms(a.startsAt) - ms(b.startsAt)),
  }))

  world.register('meetup.get', value => ({ meetupId: id<MeetupId>(obj(value), 'meetupId', 'mt') }), (ctx, input) => {
    const entry = meetup(input.meetupId)
    if (!involved(entry, ctx.memberId)) throw new WorldError('not_found', 'That meetup was not found.')
    return { meetup: meetupView(world, ctx.memberId, entry) }
  })

  world.register('meetup.propose', value => {
    const raw = obj(value)
    return { ...parsePlan(raw, world.now()), startsAt: iso(parsePlan(raw, world.now()).startsAt) as string, invite: list(raw, 'invite', entry => id<MemberId>({ entry }, 'entry', 'm'), { max: 12 }) }
  }, (ctx, input) => {
    world.limit(`meetup:${ctx.memberId}`, 10, 3_600_000)
    const invite = [...new Set(input.invite)].filter(memberId => memberId !== ctx.memberId)
    if (!invite.length) throw new WorldError('invalid', 'Invite at least one friend.')
    for (const memberId of invite) if (!areFriends(world, ctx.memberId, memberId)) throw new WorldError('forbidden', 'You can only invite friends to a meetup.')
    const created: MeetupRecord = {
      id: newId<MeetupId>('mt'), organiser: ctx.memberId, venue: input.venue, startsAt: input.startsAt as Iso, timezone: input.timezone, note: input.note,
      cancelled: false, revision: 1, participants: invite.map(memberId => ({ memberId, answer: 'invited', answeredAt: null })),
      createdAt: iso(ctx.now), updatedAt: iso(ctx.now),
    }
    state(world).meetups[created.id] = created
    world.touch()
    const organiser = record(world, ctx.memberId).profile.displayName
    for (const memberId of invite) {
      emit(world, {
        to: memberId, category: 'events', kind: 'meetup.invited', title: `${organiser} proposed a meetup`,
        body: `${created.venue.name} · ${formatWhen(ms(created.startsAt), created.timezone)}`, link: `/people/meetups/${created.id}`,
        actor: ctx.memberId, dedupeKey: `meetup:${created.id}`, expiresAt: ms(created.startsAt),
      })
    }
    tellParticipants(created)
    return { meetup: meetupView(world, ctx.memberId, created) }
  })

  world.register('meetup.respond', value => {
    const raw = obj(value)
    return { meetupId: id<MeetupId>(raw, 'meetupId', 'mt'), accept: bool(raw, 'accept'), revision: Number(raw.revision) }
  }, (ctx, input) => {
    const entry = meetup(input.meetupId)
    const participant = requireFound(entry.participants.find(p => p.memberId === ctx.memberId), 'Your invitation')
    // A blocked pair cannot see each other, so an answer is refused before anything changes, as the reply would be.
    if (isBlockedEitherWay(world, ctx.memberId, entry.organiser)) throw new WorldError('not_found', 'That member was not found.')
    if (entry.cancelled) throw new WorldError('conflict', 'This meetup was cancelled.')
    if (meetupStatus(world, entry) === 'past') throw new WorldError('expired', 'This meetup has already happened.')
    // An answer must be to the plan as it stands, not to an older venue or time.
    if (input.revision !== entry.revision) throw new WorldError('conflict', 'The plan changed. Check the new venue and time, then answer again.')
    participant.answer = input.accept ? 'accepted' : 'declined'
    participant.answeredAt = iso(ctx.now)
    entry.updatedAt = iso(ctx.now)
    settle(world, ctx.memberId, `meetup:${entry.id}`)
    world.touch()
    emit(world, {
      to: entry.organiser, category: 'events', kind: 'meetup.answered',
      title: `${record(world, ctx.memberId).profile.displayName} ${input.accept ? 'is coming' : 'can’t make it'}`,
      body: `${entry.venue.name} · ${formatWhen(ms(entry.startsAt), entry.timezone)}`, link: `/people/meetups/${entry.id}`,
      actor: ctx.memberId, dedupeKey: `meetup-answer:${entry.id}:${ctx.memberId}`, expiresAt: ms(entry.startsAt),
    })
    tellParticipants(entry)
    return { meetup: meetupView(world, ctx.memberId, entry) }
  })

  world.register('meetup.revise', value => {
    const raw = obj(value)
    const plan = parsePlan(raw, world.now())
    return { meetupId: id<MeetupId>(raw, 'meetupId', 'mt'), ...plan, startsAt: iso(plan.startsAt) as string }
  }, (ctx, input) => {
    const entry = meetup(input.meetupId)
    if (entry.organiser !== ctx.memberId) throw new WorldError('forbidden', 'Only the organiser can change the plan.')
    if (entry.cancelled) throw new WorldError('conflict', 'This meetup was cancelled.')
    entry.venue = input.venue
    entry.startsAt = input.startsAt as Iso
    entry.timezone = input.timezone
    entry.note = input.note
    entry.revision++
    entry.updatedAt = iso(ctx.now)
    for (const participant of entry.participants) {
      participant.answer = 'invited'
      participant.answeredAt = null
      emit(world, {
        to: participant.memberId, category: 'events', kind: 'meetup.revised', title: 'Meetup plan changed',
        body: `Now ${entry.venue.name} · ${formatWhen(ms(entry.startsAt), entry.timezone)}. Please answer again.`, link: `/people/meetups/${entry.id}`,
        actor: ctx.memberId, dedupeKey: `meetup:${entry.id}`, expiresAt: ms(entry.startsAt),
      })
    }
    world.touch()
    tellParticipants(entry)
    return { meetup: meetupView(world, ctx.memberId, entry) }
  })

  world.register('meetup.cancel', value => ({ meetupId: id<MeetupId>(obj(value), 'meetupId', 'mt') }), (ctx, input) => {
    const entry = meetup(input.meetupId)
    if (entry.organiser !== ctx.memberId) throw new WorldError('forbidden', 'Only the organiser can cancel. You can decline instead.')
    if (!entry.cancelled) {
      entry.cancelled = true
      entry.updatedAt = iso(ctx.now)
      for (const participant of entry.participants) {
        settle(world, participant.memberId, `meetup:${entry.id}`)
        emit(world, {
          to: participant.memberId, category: 'events', kind: 'meetup.cancelled', title: 'Meetup cancelled',
          body: `${entry.venue.name} · ${formatWhen(ms(entry.startsAt), entry.timezone)}`, link: `/people/meetups/${entry.id}`,
          actor: ctx.memberId, dedupeKey: `meetup-cancelled:${entry.id}`,
        })
      }
      world.touch()
      tellParticipants(entry)
    }
    return { meetup: meetupView(world, ctx.memberId, entry) }
  })
}

export const hasMember = exists
