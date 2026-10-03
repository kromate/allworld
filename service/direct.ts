// Social presence beyond the street: who is around, direct messages between friends, waves,
// invitations to join, emotes.
//
// The rules this module holds to:
//   - Blocks win everywhere. A blocked pair never sees, messages, waves at, invites or is counted
//     for each other, and their conversation is closed to both for good.
//   - A person's whereabouts leave here as words (an area name, a venue name). District and place
//     ids leave only as a `Way`, and only to someone who was invited, who asked about a public
//     spot, or whose friend allows friends to come.
//   - Nothing here moves an avatar. A `Way` is an answer; the App walks, and the travel and room
//     rules decide whether it may.
//   - Counts are of members connected right now. Nobody is invented.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DistrictId, HomeId, Iso, MatchId, MemberId, PlaceId, RoomKey } from '../src/shared/ids.ts'
import { iso, newId, randomToken } from '../src/shared/ids.ts'
import { distance, parseDistrictId, tileToLatLon } from '../src/shared/geo.ts'
import type { LatLon } from '../src/shared/geo.ts'
import { INTEREST_RADIUS, REPORT_REASONS, WorldError, roomKey } from '../src/shared/model.ts'
import type { CoarseArea, ReportReason, RoomRef } from '../src/shared/model.ts'
import { TRAVEL, distanceKm } from '../src/shared/travel.ts'
import {
  DEFAULT_SOCIAL_SETTINGS, DIRECT_KEPT, DIRECT_MAX_LENGTH, DIRECT_PAGE, EMOTES, HANGOUT, INVITE_LINK, JOIN, WAVE,
} from '../src/shared/direct.ts'
import type {
  Around, CityMember, Conversation, ConversationId, Destination, DirectMessage, FriendPresence, Hangout, HangoutId, InviteLanding,
  InviteLink, JoinInvite, JoinInviteId, JoinStatus, SocialSettings, Spot, Wave, WaveContext, WaveId, Way, Whereabouts,
} from '../src/shared/direct.ts'
import type { HomeApproach } from '../src/shared/homes.ts'
import { approachTo } from './homes.ts'
import type { World } from './kernel.ts'
import { requireFound } from './kernel.ts'
import { areFriends, automaticFriendsOf, exists, friendsOf, isBlockedEitherWay, mayMessage, onBlock, onUnfriend, publicMember, record, tryPublicMember } from './members.ts'
import { emit, settle } from './notify.ts'
import { bool, empty, id, isoInstant, obj, oneOf, optNum, str } from './parse.ts'
import { onRoomEnter, onRoomLeave, roomMates, roomOf } from './rooms.ts'
import { communitiesOf, communityName } from './social.ts'

// ── Stored state ──────────────────────────────────────────────────────────────────────────────

interface MessageRecord {
  id: string; seq: number; from: MemberId; text: string; at: Iso
  /** Written by the service for the sender (`deliverAutomatic`). `direct.send` never sets it. */
  auto?: 'welcome'
}
interface ConversationRecord {
  id: ConversationId
  /** The pair, in sorted order. Index 0 is `a`, index 1 is `b` in the pairs below. */
  a: MemberId
  b: MemberId
  messages: MessageRecord[]
  nextSeq: number
  /** Highest seq each side has read, and has received on a device. */
  read: [number, number]
  delivered: [number, number]
  /** The client id of each side's latest message, so a retried send is not stored twice. */
  lastClient: [string, string]
  /** When an unread message should become an inbox entry for a side that was connected when it came. */
  notifyDue: [number | null, number | null]
  createdAt: Iso
  updatedAt: Iso
  /** Closed to both for good after a block. Kept only so a reviewer can still read a report. */
  sealed: boolean
}
interface WaveRecord {
  id: WaveId; from: MemberId; to: MemberId; context: WaveContext; contextText: string
  status: 'pending' | 'returned' | 'dismissed' | 'expired'; createdAt: number; expiresAt: number
  /** Either side may put an answered wave away without it changing for the other. */
  hiddenFor?: MemberId[]
}
interface InviteRecord {
  id: JoinInviteId; from: MemberId; to: MemberId
  place: JoinInvite['place']
  target: Destination
  note: string; status: JoinStatus; createdAt: number; expiresAt: number; answeredAt: number | null
}
interface PlaceRecord {
  key: RoomKey
  kind: 'street' | 'venue'
  districtId: DistrictId
  placeId: PlaceId | null
  /** Names the App reported for a venue, with who reported each. The most reported one is shown. */
  names: { name: string; by: MemberId[] }[]
  category: string
  areaLabel: string
  /** One entry per member: their latest visit. Pruned after a day. */
  visits: { m: MemberId; at: number }[]
}
/** A link a member made to bring in someone they know. The address carries only `id` and a signature. */
interface LinkRecord {
  id: string; by: MemberId; areaLabel: string | null; area: CoarseArea | null; createdAt: number; expiresAt: number; revoked: boolean
  /** Members who opened it, and those the maker has been told about. */
  opened: MemberId[]; announced: MemberId[]
}
interface HangoutRecord {
  id: HangoutId; host: MemberId; place: Hangout['place']; target: Destination; districtId: DistrictId
  startsAt: number; timezone: string; note: string; going: MemberId[]; cancelled: boolean; reminded: boolean; createdAt: number
}
interface DirectReport { id: string; by: MemberId; about: MemberId; conversationId: ConversationId; reason: ReportReason; detail: string; at: Iso; messages: MessageRecord[] }
interface DirectState {
  conversations: Record<string, ConversationRecord>
  /** "a|b" (sorted) → the pair's open conversation. */
  byPair: Record<string, ConversationId>
  waves: Record<string, WaveRecord>
  /** "from>to" → when they last waved, and how many in a row went unanswered. */
  waveHistory: Record<string, { last: number; ignored: number }>
  invites: Record<string, InviteRecord>
  settings: Record<string, SocialSettings>
  places: Record<string, PlaceRecord>
  lastSeen: Record<string, number>
  reports: DirectReport[]
  /** Signs invite links, so a made-up address is refused before anything is looked up. Never leaves the service. */
  linkSecret?: string
  links: Record<string, LinkRecord>
  /** Member → the invite link they came through, until its maker has been told. */
  cameThrough: Record<string, string>
  hangouts: Record<string, HangoutRecord>
}

const HOUR = 3_600_000, DAY = 86_400_000
/** A district's centre can sit this far beyond the anchor of the area that holds it (as in travel). */
const CITY_SLACK_KM = 2
/** A message to someone who is connected becomes an inbox entry only if still unread after this. */
const ONLINE_NOTIFY_DELAY_MS = 90_000
const FRIEND_COOLDOWN_MS = 30 * 60_000
const FRIEND_ONLINE_EVERY_MS = 5 * 60_000
/** Service-made friends shown in `around.get`, newest first. The creator has one per member. */
const AROUND_AUTOMATIC_FRIENDS = 50

function state(world: World): DirectState {
  const data = world.slice<DirectState>('direct', () => ({
    conversations: {}, byPair: {}, waves: {}, waveHistory: {}, invites: {}, settings: {}, places: {}, lastSeen: {}, reports: [], links: {}, cameThrough: {}, hangouts: {},
  }))
  // A state file written by an earlier build of this module may lack newer parts.
  data.conversations ??= {}; data.byPair ??= {}; data.waves ??= {}; data.waveHistory ??= {}; data.invites ??= {}
  data.settings ??= {}; data.places ??= {}; data.lastSeen ??= {}; data.reports ??= []
  data.links ??= {}; data.cameThrough ??= {}; data.hangouts ??= {}
  return data
}

// ── Runtime (memory only) ─────────────────────────────────────────────────────────────────────

interface Presence { id: MemberId; point: LatLon | null; areaLabel: string | null; room: { key: RoomKey; ref: RoomRef } | null }
interface PresenceIndex { at: number; byCell: Map<string, Presence[]>; areas: Map<string, { count: number; point: LatLon }>; total: number }
interface Runtime {
  online: Set<MemberId>
  byMember: Map<MemberId, Set<ConversationId>>
  /** Conversations with an inbox entry still to be raised. */
  pendingNotify: Set<ConversationId>
  placeCells: Map<string, Set<string>>
  index: PresenceIndex | null
  lastSweep: number
  friendOnlineAt: Map<string, number>
}
const runtimes = new WeakMap<World, Runtime>()
function runtime(world: World): Runtime {
  let found = runtimes.get(world)
  if (!found) {
    found = { online: new Set(), byMember: new Map(), pendingNotify: new Set(), placeCells: new Map(), index: null, lastSweep: 0, friendOnlineAt: new Map() }
    runtimes.set(world, found)
    const data = state(world)
    for (const conversation of Object.values(data.conversations)) {
      indexConversation(found, conversation)
      if (conversation.notifyDue.some(due => due !== null)) found.pendingNotify.add(conversation.id)
    }
    for (const place of Object.values(data.places)) indexPlace(found, place)
  }
  return found
}
function indexConversation(rt: Runtime, conversation: ConversationRecord): void {
  for (const memberId of [conversation.a, conversation.b]) {
    let set = rt.byMember.get(memberId)
    if (!set) { set = new Set(); rt.byMember.set(memberId, set) }
    set.add(conversation.id)
  }
}

/**
 * How long the list of who is connected where may be reused, in milliseconds of world time. City
 * and spot counts can be this stale; a friend's own whereabouts never are. Evidence probes set 0.
 */
let presenceCacheMs = 1500
export function setPresenceCacheMs(value: number): void { presenceCacheMs = Math.max(0, value) }

// ── Where someone is ──────────────────────────────────────────────────────────────────────────

/** A read-only look at the travel module's record of where an avatar is. Travel owns it; nothing here writes it. */
interface TravelPeek { location: CoarseArea | null; centre: LatLon | null; trip: { to: CoarseArea; arrivesAt: Iso } | null }
function travelOf(world: World, memberId: MemberId): TravelPeek | null {
  const slice = world.slice<{ members: Record<string, TravelPeek | undefined> }>('travel', () => ({ members: {} }))
  return slice.members?.[memberId] ?? null
}
const tripOf = (world: World, memberId: MemberId): TravelPeek['trip'] => {
  const trip = travelOf(world, memberId)?.trip
  return trip && Date.parse(trip.arrivesAt) > world.now() ? trip : null
}
function areaOf(world: World, memberId: MemberId): CoarseArea | null {
  const travel = travelOf(world, memberId)
  if (travel?.location) return travel.location
  const { profile } = record(world, memberId)
  return profile.browsing ?? profile.currentArea ?? null
}
const districtPoint = (districtId: DistrictId): LatLon | null => {
  const tile = parseDistrictId(districtId)
  return tile ? tileToLatLon(tile) : null
}
/** The point a member's avatar counts as being at, for grouping people into cities. Never sent to a client. */
function pointOf(world: World, memberId: MemberId): LatLon | null {
  if (tripOf(world, memberId)) return null
  const room = roomOf(world, memberId)
  if (room && (room.ref.kind === 'district' || room.ref.kind === 'venue')) { const point = districtPoint(room.ref.districtId); if (point) return point }
  return areaOf(world, memberId)?.anchor ?? null
}
/** Where walking range is measured from: the same point the travel rules use. */
const originOf = (world: World, memberId: MemberId): LatLon | null => travelOf(world, memberId)?.centre ?? areaOf(world, memberId)?.anchor ?? null
const inRange = (from: LatLon, to: LatLon): boolean => distanceKm(from, to) <= TRAVEL.localRangeKm + CITY_SLACK_KM

const cellOf = (point: LatLon): string => `${Math.floor(point.lat)}:${Math.floor(point.lon)}`
/** The one-degree cells that can hold a point within walking range of `point`. */
function cellsAround(point: LatLon): string[] {
  const reach = TRAVEL.localRangeKm + CITY_SLACK_KM
  const dLat = Math.ceil(reach / 111), dLon = Math.ceil(reach / (111 * Math.max(0.05, Math.cos((point.lat * Math.PI) / 180))))
  const out: string[] = []
  const lat0 = Math.floor(point.lat), lon0 = Math.floor(point.lon)
  for (let y = -dLat; y <= dLat; y++) for (let x = -Math.min(dLon, 180); x <= Math.min(dLon, 180); x++) {
    out.push(`${lat0 + y}:${((((lon0 + x + 180) % 360) + 360) % 360) - 180}`)
  }
  return [...new Set(out)]
}

function indexPlace(rt: Runtime, place: PlaceRecord): void {
  const point = districtPoint(place.districtId)
  if (!point) return
  const cell = cellOf(point)
  let set = rt.placeCells.get(cell)
  if (!set) { set = new Set(); rt.placeCells.set(cell, set) }
  set.add(place.key)
}

const settingsOf = (world: World, memberId: MemberId): SocialSettings => state(world).settings[memberId] ?? DEFAULT_SOCIAL_SETTINGS
const placeName = (place: PlaceRecord | undefined): string | null =>
  place?.names.length ? [...place.names].sort((x, y) => y.by.length - x.by.length)[0]!.name : null
const fresh = (place: PlaceRecord, now: number): PlaceRecord['visits'] => place.visits.filter(visit => now - visit.at < DAY)

function presenceOf(world: World, memberId: MemberId): Presence {
  const room = roomOf(world, memberId)
  return { id: memberId, point: pointOf(world, memberId), areaLabel: areaOf(world, memberId)?.label ?? null, room: room ? { key: room.key, ref: room.ref } : null }
}

/** Everyone connected and onboarded, bucketed by coarse cell, with per-area totals. */
function presenceIndex(world: World): PresenceIndex {
  const rt = runtime(world)
  const now = world.now()
  if (rt.index && presenceCacheMs > 0 && now - rt.index.at < presenceCacheMs && now >= rt.index.at) return rt.index
  const index: PresenceIndex = { at: now, byCell: new Map(), areas: new Map(), total: 0 }
  for (const memberId of rt.online) {
    if (!exists(world, memberId) || !record(world, memberId).profile.onboardedAt) continue
    const presence = presenceOf(world, memberId)
    index.total++
    if (!presence.point) continue
    const cell = cellOf(presence.point)
    const list = index.byCell.get(cell)
    if (list) list.push(presence); else index.byCell.set(cell, [presence])
    if (presence.areaLabel) {
      const area = index.areas.get(presence.areaLabel)
      if (area) area.count++; else index.areas.set(presence.areaLabel, { count: 1, point: presence.point })
    }
  }
  rt.index = index
  return index
}

/** Members connected in walking range of `origin`: the viewer's city. */
function inCity(world: World, origin: LatLon): Presence[] {
  const index = presenceIndex(world)
  const out: Presence[] = []
  for (const cell of cellsAround(origin)) for (const presence of index.byCell.get(cell) ?? []) if (presence.point && inRange(origin, presence.point)) out.push(presence)
  return out
}

/**
 * Where `target` is, in words, for `viewer`. Only the member themselves and friends get more than
 * online or offline, and a friend who switched sharing off gives nobody more than that.
 */
function whereOf(world: World, viewer: MemberId, target: MemberId): Whereabouts {
  const online = world.isOnline(target)
  const self = viewer === target
  const settings = settingsOf(world, target)
  if (!self && (!areFriends(world, viewer, target) || !settings.shareWhereabouts)) {
    return { state: online ? 'online' : 'offline', words: online ? 'online' : 'offline', areaLabel: null, venueName: null, hidden: true, sameCity: null, canJoin: false, lastSeenAt: null }
  }
  const area = areaOf(world, target)?.label ?? null
  const base = { areaLabel: area, venueName: null as string | null, hidden: false, canJoin: false }
  const viewerOrigin = originOf(world, viewer)
  const targetPoint = pointOf(world, target)
  const sameCity = self ? true : viewerOrigin && targetPoint ? inRange(viewerOrigin, targetPoint) : null
  if (!online) {
    const seen = state(world).lastSeen[target]
    return { ...base, state: 'offline', words: area ? `offline · last in ${area}` : 'offline', sameCity, lastSeenAt: seen ? iso(seen) : null }
  }
  const trip = tripOf(world, target)
  if (trip) return { ...base, state: 'travelling', words: `travelling to ${trip.to.label}`, areaLabel: trip.to.label, sameCity: null, lastSeenAt: null }
  const room = roomOf(world, target)
  const mayJoin = !self && settings.allowJoin
  if (!room) return { ...base, state: 'online', words: area ? `online in ${area}` : 'online', sameCity, lastSeenAt: null }
  if (room.ref.kind === 'district') return { ...base, state: 'street', words: area ? `in ${area}` : 'out in the streets', sameCity, canJoin: mayJoin, lastSeenAt: null }
  if (room.ref.kind === 'venue') {
    const name = placeName(state(world).places[room.key])
    return { ...base, state: 'venue', venueName: name, words: `at ${name ?? 'a venue'}${area ? ` in ${area}` : ''}`, sameCity, canJoin: mayJoin, lastSeenAt: null }
  }
  if (room.ref.kind === 'home') {
    const own = room.ref.homeId === record(world, target).profile.homeId
    return { ...base, state: own ? 'home' : 'visiting', words: own ? 'at home' : 'visiting a home', sameCity, canJoin: mayJoin && own, lastSeenAt: null }
  }
  return { ...base, state: 'table', words: 'at a game table', sameCity, lastSeenAt: null }
}

// ── Getting there ─────────────────────────────────────────────────────────────────────────────

function wayTo(world: World, viewer: MemberId, destination: Destination, areaLabel: string | null): Way {
  const trip = tripOf(world, viewer)
  if (trip) return { reach: 'unavailable', destination: null, areaLabel, text: `You are travelling to ${trip.to.label}. Try again when you arrive.` }
  if (destination.kind === 'home') return wayToHome(world, viewer, destination)
  if (destination.kind === 'table') return { reach: 'door', destination, areaLabel, text: 'Open the table to watch or play.' }
  const origin = originOf(world, viewer)
  const point = districtPoint(destination.districtId)
  if (!origin || !point) return { reach: 'unavailable', destination: null, areaLabel, text: 'Choose where you are first. Then you can go and meet people.' }
  if (!inRange(origin, point)) {
    return { reach: 'travel', destination: null, areaLabel, text: `${destination.areaLabel} is in another city. Book a trip there from Travel, then come back to this.` }
  }
  return { reach: 'walk', destination, areaLabel, text: destination.kind === 'venue' ? `${destination.name} is within walking range.` : `${destination.areaLabel} is within walking range.` }
}

/**
 * A home is reached on foot, to its front door, by the same answer `home.approach` gives. Asked of the
 * homes module as the viewer, so its own rules (private, friends, block, placed, where they are) decide,
 * now and not as they were when the invitation was made. It is a plain read: no operation is called, so
 * no member's request budget is spent. Nobody is moved and no fare is skipped.
 */
function wayToHome(world: World, viewer: MemberId, destination: Extract<Destination, { kind: 'home' }>): Way {
  const none = (text: string, areaLabel: string | null = null): Way => ({ reach: 'unavailable', destination: null, areaLabel, text })
  let approach: HomeApproach
  try { approach = approachTo(world, viewer, destination.homeId) }
  catch (error) {
    if (error instanceof WorldError && (error.code === 'forbidden' || error.code === 'not_found')) return none(`${destination.name} is not open to you right now.`)
    throw error
  }
  if (approach.kind === 'unavailable') return none(approach.message)
  if (approach.kind === 'travel') {
    return originOf(world, viewer) ? { reach: 'travel', destination: null, areaLabel: approach.to.label, text: approach.message } : none(approach.message)
  }
  return { reach: 'walk', destination, areaLabel: approach.site.areaLabel, text: `${destination.name} is open to you. Walk to its front door in ${approach.site.areaLabel}, then step in.` }
}

/** The place a member is standing in, as somewhere another member could be sent. Null when it is not a place to send anyone. */
function standingAt(world: World, memberId: MemberId): { target: Destination; place: JoinInvite['place'] } | null {
  const room = roomOf(world, memberId)
  if (!room) return null
  const area = areaOf(world, memberId)?.label ?? null
  if (room.ref.kind === 'district') {
    const label = area ?? 'this district'
    // The meeting point is where the avatar stands in the scene: the walking target for someone they asked to come.
    return { target: { kind: 'street', districtId: room.ref.districtId, areaLabel: label, meet: { x: room.pos.x, z: room.pos.z } }, place: { kind: 'street', name: `the streets of ${label}`, areaLabel: area } }
  }
  if (room.ref.kind === 'venue') {
    const name = placeName(state(world).places[room.key]) ?? 'a venue'
    return { target: { kind: 'venue', districtId: room.ref.districtId, placeId: room.ref.placeId, name, areaLabel: area ?? 'this district' }, place: { kind: 'venue', name, areaLabel: area } }
  }
  if (room.ref.kind === 'table') return { target: { kind: 'table', matchId: room.ref.matchId as MatchId }, place: { kind: 'table', name: 'a game table', areaLabel: null } }
  return null
}

/**
 * The member's own home, when friends may come in and a street holds it. Asked as the member, so the
 * homes module answers by its own rules. A friend can only walk to a placed home's front door, so an
 * unplaced (or otherwise unreachable) home is not offered.
 */
function ownHome(world: World, memberId: MemberId): { target: Destination; place: JoinInvite['place'] } {
  const { home } = world.call(memberId, 'home.get', { homeId: null })
  if (home.policy === 'private') throw new WorldError('conflict', 'Your home is private. Open it to friends from Home first, then invite them.')
  const approach = approachTo(world, memberId, null)
  if (approach.kind === 'unavailable') {
    throw new WorldError('conflict', approach.reason === 'unplaced'
      ? 'Place your home on a street first. Open Home, choose a plot, then invite friends to its front door.'
      : `Your home cannot be gone to yet, so friends cannot be invited. ${approach.message}`)
  }
  return { target: { kind: 'home', homeId: home.id as HomeId, name: home.name }, place: { kind: 'home', name: home.name, areaLabel: null } }
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────

const pairKey = (x: MemberId, y: MemberId): string => (x < y ? `${x}|${y}` : `${y}|${x}`)
const sideOf = (conversation: ConversationRecord, memberId: MemberId): 0 | 1 => (conversation.a === memberId ? 0 : 1)
const peerOf = (conversation: ConversationRecord, memberId: MemberId): MemberId => (conversation.a === memberId ? conversation.b : conversation.a)
const lastSeq = (conversation: ConversationRecord): number => conversation.nextSeq - 1

function unreadIn(conversation: ConversationRecord, memberId: MemberId): number {
  const read = conversation.read[sideOf(conversation, memberId)]
  let count = 0
  for (let index = conversation.messages.length - 1; index >= 0; index--) {
    const message = conversation.messages[index]!
    if (message.seq <= read) break
    if (message.from !== memberId) count++
  }
  return count
}

const messageView = (conversation: ConversationRecord, message: MessageRecord): DirectMessage =>
  ({ id: message.id, conversationId: conversation.id, seq: message.seq, from: message.from, text: message.text, at: message.at, ...(message.auto ? { automatic: message.auto } : {}) })

/** A thread that holds nothing but the viewer's own automatic message is not one they ever opened or wrote in. */
const onlyOwnAutomatic = (conversation: ConversationRecord, viewer: MemberId): boolean =>
  conversation.messages.length > 0 && conversation.messages.every(message => message.auto !== undefined && message.from === viewer)

/** Null when the viewer may no longer reach the conversation: it was sealed by a block, or the peer is gone. */
function conversationView(world: World, viewer: MemberId, conversation: ConversationRecord): Conversation | null {
  if (conversation.sealed) return null
  const peerId = peerOf(conversation, viewer)
  const peer = tryPublicMember(world, viewer, peerId)
  if (!peer) return null
  const side = sideOf(conversation, viewer), other = side === 0 ? 1 : 0
  const last = conversation.messages.at(-1)
  return {
    id: conversation.id, peer, peerWhere: whereOf(world, viewer, peerId), last: last ? messageView(conversation, last) : null,
    unread: unreadIn(conversation, viewer), updatedAt: conversation.updatedAt, readSeq: conversation.read[side],
    peerDeliveredSeq: conversation.delivered[other], peerReadSeq: conversation.read[other], canSend: mayMessage(world, viewer, peerId),
  }
}

function conversationsOf(world: World, memberId: MemberId): ConversationRecord[] {
  const data = state(world)
  const out: ConversationRecord[] = []
  for (const conversationId of runtime(world).byMember.get(memberId) ?? []) {
    const conversation = data.conversations[conversationId]
    if (conversation && !conversation.sealed && !isBlockedEitherWay(world, memberId, peerOf(conversation, memberId)) && exists(world, peerOf(conversation, memberId))) out.push(conversation)
  }
  return out
}
const unreadTotal = (world: World, memberId: MemberId): number => conversationsOf(world, memberId).reduce((sum, conversation) => sum + unreadIn(conversation, memberId), 0)

function waveView(world: World, viewer: MemberId, wave: WaveRecord): Wave | null {
  const from = tryPublicMember(world, viewer, wave.from), to = tryPublicMember(world, viewer, wave.to)
  if (!from || !to) return null
  const now = world.now()
  // The sender never learns that a wave was dismissed: it simply stays unanswered until it lapses.
  const status = wave.status === 'returned' ? 'returned' : wave.status === 'expired' || wave.expiresAt <= now ? 'expired' : 'pending'
  return { id: wave.id, from, to, context: wave.context, contextText: wave.contextText, status, createdAt: iso(wave.createdAt), expiresAt: iso(wave.expiresAt), mine: wave.from === viewer }
}

function inviteView(world: World, viewer: MemberId, invite: InviteRecord): JoinInvite | null {
  const from = tryPublicMember(world, viewer, invite.from), to = tryPublicMember(world, viewer, invite.to)
  if (!from || !to) return null
  const status: JoinStatus = (invite.status === 'pending' || invite.status === 'accepted') && invite.expiresAt <= world.now() ? 'expired' : invite.status
  const live = status === 'pending' || status === 'accepted'
  return {
    id: invite.id, from, to, place: invite.place, note: invite.note, status, createdAt: iso(invite.createdAt), expiresAt: iso(invite.expiresAt),
    answeredAt: invite.answeredAt ? iso(invite.answeredAt) : null, mine: invite.from === viewer,
    reach: invite.to === viewer && live ? wayTo(world, viewer, invite.target, invite.place.areaLabel).reach : null,
  }
}


/** The pair's open conversation, made the first time it is needed. Who may have one is the caller's to decide. */
function ensureConversation(world: World, x: MemberId, y: MemberId, now: number): ConversationRecord {
  const data = state(world)
  const key = pairKey(x, y)
  const existing = data.conversations[data.byPair[key] ?? '']
  if (existing) return existing
  const [first, second] = x < y ? [x, y] : [y, x]
  const conversation: ConversationRecord = {
    id: newId<ConversationId>('dm'), a: first, b: second, messages: [], nextSeq: 1, read: [0, 0], delivered: [0, 0], lastClient: ['', ''],
    notifyDue: [null, null], createdAt: iso(now), updatedAt: iso(now), sealed: false,
  }
  data.conversations[conversation.id] = conversation
  data.byPair[key] = conversation.id
  indexConversation(runtime(world), conversation)
  world.touch()
  return conversation
}

/**
 * A message the service writes on a member's behalf, marked as automatic. Only another service
 * module can call this: no operation reaches it, so the mark cannot be asked for. The two must be
 * allowed to message each other and not blocked. It is an in-game message and nothing more: no
 * inbox entry is raised for it, so nothing is queued for email, WhatsApp or push, and nothing
 * about it says the sender is here. A connected recipient's App is told, as for any message.
 */
export function deliverAutomatic(world: World, input: { from: MemberId; to: MemberId; text: string; kind: 'welcome' }): { conversationId: ConversationId; messageId: string } {
  const { from, to } = input
  if (from === to || !exists(world, from) || !exists(world, to) || isBlockedEitherWay(world, from, to) || !mayMessage(world, from, to)) {
    throw new WorldError('forbidden', 'An automatic message can only go between two connected members.')
  }
  const text = input.text.trim()
  if (!text || text.length > DIRECT_MAX_LENGTH) throw new WorldError('invalid', 'That automatic message is empty or too long.')
  const now = world.now()
  const conversation = ensureConversation(world, from, to, now)
  // A failed live push may have left the stored welcome ahead of the creator's delivery stamp.
  const existing = conversation.messages.find(message => message.from === from && message.auto === input.kind)
  if (existing) return { conversationId: conversation.id, messageId: existing.id }
  const side = sideOf(conversation, from), other = side === 0 ? 1 : 0
  const message: MessageRecord = { id: `dmm_${randomToken(12)}`, seq: conversation.nextSeq++, from, text, at: iso(now), auto: input.kind }
  conversation.messages.push(message)
  if (conversation.messages.length > DIRECT_KEPT) conversation.messages.shift()
  conversation.updatedAt = message.at
  // The sender's own marks only say this message is theirs; they read nothing by it.
  conversation.delivered[side] = Math.max(conversation.delivered[side], message.seq)
  world.touch()
  if (world.isOnline(to)) {
    conversation.delivered[other] = message.seq
    const seen = conversationView(world, to, conversation)
    if (seen) world.push(to, { type: 'direct.message', message: messageView(conversation, message), conversation: seen, unread: unreadTotal(world, to) })
  }
  return { conversationId: conversation.id, messageId: message.id }
}

/** The other member of a conversation `memberId` is in and may still open. Null otherwise. Read-only. */
export function conversationPeer(world: World, conversationId: string, memberId: MemberId): MemberId | null {
  const conversations = world.peek<DirectState>('direct')?.conversations
  const conversation = conversations && Object.hasOwn(conversations, conversationId) ? conversations[conversationId] : undefined
  if (!conversation || conversation.sealed || (conversation.a !== memberId && conversation.b !== memberId)) return null
  return peerOf(conversation, memberId)
}

const nameOf = (world: World, memberId: MemberId): string => record(world, memberId).profile.displayName
const tellAround = (world: World, ...members: MemberId[]): void => { for (const memberId of members) world.push(memberId, { type: 'around.changed' }) }

function hangoutView(world: World, viewer: MemberId, hangout: HangoutRecord): Hangout | null {
  const host = tryPublicMember(world, viewer, hangout.host)
  if (!host) return null
  const now = world.now()
  const status = hangout.cancelled ? 'cancelled' : now < hangout.startsAt ? 'upcoming' : now < hangout.startsAt + HANGOUT.lastsMinutes * 60_000 ? 'now' : 'over'
  const friendsGoing = hangout.going.filter(memberId => memberId !== viewer && areFriends(world, viewer, memberId))
    .flatMap(memberId => { const friend = tryPublicMember(world, viewer, memberId); return friend ? [friend] : [] }).slice(0, 6)
  return {
    id: hangout.id, host, place: hangout.place, startsAt: iso(hangout.startsAt), timezone: hangout.timezone, note: hangout.note, status,
    going: hangout.going.length, friendsGoing, iAmGoing: hangout.going.includes(viewer), mine: hangout.host === viewer,
  }
}
const whenIn = (at: number, timezone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(at)

// ── Invite links ──────────────────────────────────────────────────────────────────────────────

const TOKEN = /^([a-z0-9]{16})\.([A-Za-z0-9_-]{22})$/
function signLink(world: World, linkId: string): string {
  const data = state(world)
  data.linkSecret ??= randomBytes(32).toString('hex')
  return createHmac('sha256', data.linkSecret).update(linkId).digest('base64url').slice(0, 22)
}
/** The link behind a token, when the signature is right and the link still works. */
function linkFor(world: World, token: string): LinkRecord {
  const gone = (): never => { throw new WorldError('not_found', 'This invite link does not work any more. Ask them for a new one.') }
  const match = TOKEN.exec(token)
  if (!match) return gone()
  const expected = Buffer.from(signLink(world, match[1]!)), given = Buffer.from(match[2]!)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return gone()
  const link = state(world).links[match[1]!]
  if (!link || link.revoked || !exists(world, link.by)) return gone()
  if (link.expiresAt <= world.now()) throw new WorldError('expired', 'This invite link has run out. Ask them for a new one.')
  return link
}
function linkView(world: World, link: LinkRecord): InviteLink {
  return {
    id: link.id, token: `${link.id}.${signLink(world, link.id)}`, areaLabel: link.areaLabel, createdAt: iso(link.createdAt), expiresAt: iso(link.expiresAt),
    joined: link.opened.flatMap(memberId => { const member = exists(world, memberId) && record(world, memberId).profile.onboardedAt ? tryPublicMember(world, link.by, memberId) : null; return member ? [member] : [] }),
  }
}
const linksOf = (world: World, memberId: MemberId): InviteLink[] => Object.values(state(world).links)
  .filter(link => link.by === memberId && !link.revoked && link.expiresAt > world.now()).sort((x, y) => y.createdAt - x.createdAt).map(link => linkView(world, link))
/** Tell the maker of a link, once, that someone who came through it is now in the world. */
function announceJoined(world: World, link: LinkRecord, memberId: MemberId): void {
  if (link.announced.includes(memberId) || memberId === link.by || !record(world, memberId).profile.onboardedAt) return
  link.announced.push(memberId)
  delete state(world).cameThrough[memberId]
  world.touch()
  emit(world, {
    to: link.by, category: 'social', kind: 'social.invite-joined', title: `${nameOf(world, memberId)} came through your invite link`,
    body: 'They can introduce themselves to you, or you can introduce yourself to them.', link: '/people?tab=nearby', actor: memberId,
    dedupeKey: `link-joined:${link.id}:${memberId}`,
  })
  world.push(link.by, { type: 'around.changed' })
}

// ── Spots ─────────────────────────────────────────────────────────────────────────────────────

function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) { value ^= text.charCodeAt(index); value = Math.imul(value, 0x01000193) }
  return (value >>> 0).toString(36)
}

interface SpotDraft { spot: Spot; now: Set<MemberId>; today: Set<MemberId>; districts: Map<DistrictId, number>; placeId: PlaceId | null; latest: number }

/** Public places in the viewer's city where people are now or came by today, with where each one leads. */
function spotsFor(world: World, viewer: MemberId, origin: LatLon, city: Presence[]): SpotDraft[] {
  const data = state(world), rt = runtime(world), now = world.now()
  const drafts = new Map<string, SpotDraft>()
  const draft = (key: string, make: () => Omit<Spot, 'id' | 'now' | 'today' | 'friends' | 'here'>, placeId: PlaceId | null): SpotDraft => {
    let found = drafts.get(key)
    if (!found) {
      found = { spot: { id: `sp_${hash(key)}`, ...make(), now: 0, today: 0, friends: [], here: false }, now: new Set(), today: new Set(), districts: new Map(), placeId, latest: 0 }
      drafts.set(key, found)
    }
    return found
  }
  const streetLabel = (key: RoomKey, fallback: string | null): string | null => data.places[key]?.areaLabel || fallback
  const visible = (other: MemberId): boolean => other !== viewer && !isBlockedEitherWay(world, viewer, other)

  for (const presence of city) {
    const room = presence.room
    if (!room || (room.ref.kind !== 'district' && room.ref.kind !== 'venue')) continue
    const districtId = room.ref.districtId
    let entry: SpotDraft
    if (room.ref.kind === 'venue') {
      const place = data.places[room.key]
      const area = place?.areaLabel || presence.areaLabel
      if (!area) continue
      entry = draft(room.key, () => ({ kind: 'venue', name: placeName(place) ?? 'A venue', category: place?.category || null, areaLabel: area }), room.ref.placeId)
    } else {
      const label = streetLabel(room.key, presence.areaLabel)
      if (!label) continue
      entry = draft(`street|${label}`, () => ({ kind: 'street', name: `Streets of ${label}`, category: null, areaLabel: label }), null)
    }
    if (presence.id === viewer) entry.spot.here = true
    else if (visible(presence.id)) { entry.now.add(presence.id); entry.today.add(presence.id) }
    entry.districts.set(districtId, (entry.districts.get(districtId) ?? 0) + (presence.id === viewer ? 0 : 1))
  }

  for (const cell of cellsAround(origin)) for (const key of rt.placeCells.get(cell) ?? []) {
    const place = data.places[key]
    const point = place ? districtPoint(place.districtId) : null
    if (!place || !point || !inRange(origin, point)) continue
    const visits = fresh(place, now).filter(visit => visible(visit.m) && exists(world, visit.m))
    if (!visits.length || !place.areaLabel) continue
    const entry = place.kind === 'venue'
      ? draft(place.key, () => ({ kind: 'venue', name: placeName(place) ?? 'A venue', category: place.category || null, areaLabel: place.areaLabel }), place.placeId)
      : draft(`street|${place.areaLabel}`, () => ({ kind: 'street', name: `Streets of ${place.areaLabel}`, category: null, areaLabel: place.areaLabel }), null)
    for (const visit of visits) { entry.today.add(visit.m); entry.latest = Math.max(entry.latest, visit.at) }
    if (!entry.districts.has(place.districtId)) entry.districts.set(place.districtId, 0)
  }

  const out = [...drafts.values()]
  for (const entry of out) {
    entry.spot.now = entry.now.size
    entry.spot.today = entry.today.size
    for (const memberId of entry.now) {
      if (!areFriends(world, viewer, memberId) || !settingsOf(world, memberId).shareWhereabouts) continue
      const friend = tryPublicMember(world, viewer, memberId)
      if (friend) entry.spot.friends.push(friend)
    }
  }
  return out.filter(entry => entry.spot.now > 0 || entry.spot.today > 0 || entry.spot.here)
    .sort((x, y) => y.spot.now - x.spot.now || y.spot.today - x.spot.today || y.latest - x.latest || x.spot.name.localeCompare(y.spot.name))
}

function spotTarget(entry: SpotDraft): Destination | null {
  const districtId = [...entry.districts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0]
  if (!districtId) return null
  if (entry.spot.kind === 'venue' && entry.placeId) return { kind: 'venue', districtId, placeId: entry.placeId, name: entry.spot.name, areaLabel: entry.spot.areaLabel }
  return { kind: 'street', districtId, areaLabel: entry.spot.areaLabel, meet: null }
}

// ── Waves: who may wave at whom ───────────────────────────────────────────────────────────────

function pendingWave(world: World, from: MemberId, to: MemberId): WaveRecord | undefined {
  const now = world.now()
  // A dismissed wave still holds the pair's one slot until it lapses, so dismissing never invites another.
  return Object.values(state(world).waves).find(wave => wave.from === from && wave.to === to && (wave.status === 'pending' || wave.status === 'dismissed') && wave.expiresAt > now)
}

/** Why the sender can see the target at all. Null means they have no way to, so no wave. */
function waveContext(world: World, from: MemberId, to: MemberId): { context: WaveContext; text: string } | null {
  if (roomMates(world, from).includes(to)) {
    const at = standingAt(world, from)
    const where = at?.place.kind === 'venue' ? `at ${at.place.name}` : at?.place.kind === 'street' ? `on ${at.place.name}` : 'in the same room'
    return { context: 'same-room', text: `You were both ${where}.` }
  }
  if (areFriends(world, from, to)) return { context: 'friend', text: 'Your friend is saying hello.' }
  const discoverable = (memberId: MemberId): boolean => record(world, memberId).profile.preferences.discoverable
  if (discoverable(from) && discoverable(to) && world.isOnline(to)) {
    const origin = originOf(world, from), point = pointOf(world, to)
    const area = areaOf(world, from)?.label
    if (origin && point && inRange(origin, point)) return { context: 'same-city', text: area ? `You are both around ${area}.` : 'You are both in the same city.' }
  }
  const mine = new Set(communitiesOf(world, from))
  const shared = communitiesOf(world, to).find(communityId => mine.has(communityId))
  if (shared) return { context: 'community', text: `You are both in ${communityName(world, shared) ?? 'a community'}.` }
  return null
}

function returnWave(world: World, wave: WaveRecord, by: MemberId): void {
  wave.status = 'returned'
  const history = state(world).waveHistory[`${wave.from}>${wave.to}`]
  if (history) history.ignored = 0
  settle(world, by, `wave:${wave.id}`)
  world.touch()
  const toSender = waveView(world, wave.from, wave)
  if (toSender) world.push(wave.from, { type: 'wave.returned', wave: toSender })
  const friends = areFriends(world, wave.from, wave.to)
  emit(world, {
    to: wave.from, category: 'social', kind: 'social.wave-back', title: `${nameOf(world, by)} waved back`,
    body: friends ? 'Say hello.' : 'You both waved. You can introduce yourself now.',
    link: friends ? `/messages?to=${by}` : `/people?tab=nearby&wave=${wave.id}`, actor: by, dedupeKey: `wave-back:${wave.id}`, expiresAt: world.now() + 7 * DAY,
  })
  tellAround(world, wave.from, wave.to)
}

// ── Registration ──────────────────────────────────────────────────────────────────────────────

export function registerDirect(world: World): void {
  const rt = runtime(world)

  // ── Connections: who is online, last seen, and telling friends ──
  world.onConnect(memberId => {
    rt.online.add(memberId)
    rt.index = null
    if (!exists(world, memberId) || !record(world, memberId).profile.onboardedAt) return
    const now = world.now()
    for (const friend of friendsOf(world, memberId)) {
      if (!world.isOnline(friend) || isBlockedEitherWay(world, memberId, friend)) continue
      world.push(friend, { type: 'around.changed' })
      const key = `${memberId}>${friend}`
      if (now - (rt.friendOnlineAt.get(key) ?? -Infinity) < FRIEND_ONLINE_EVERY_MS) continue
      rt.friendOnlineAt.set(key, now)
      const member = tryPublicMember(world, friend, memberId)
      if (member) world.push(friend, { type: 'friend.online', member, where: whereOf(world, friend, memberId) })
    }
  })
  world.onDisconnect(memberId => {
    rt.online.delete(memberId)
    rt.index = null
    if (!exists(world, memberId)) return
    state(world).lastSeen[memberId] = world.now()
    world.touch()
    for (const friend of friendsOf(world, memberId)) if (world.isOnline(friend)) world.push(friend, { type: 'around.changed' })
  })

  // ── A block closes everything between the two, for good ──
  onBlock((blockWorld, blocker, blocked) => {
    if (blockWorld !== world) return
    const data = state(world)
    const key = pairKey(blocker, blocked)
    const conversation = data.conversations[data.byPair[key] ?? '']
    if (conversation) {
      conversation.sealed = true
      conversation.notifyDue = [null, null]
      rt.pendingNotify.delete(conversation.id)
      delete data.byPair[key]
      for (const memberId of [blocker, blocked]) settle(world, memberId, `direct:${conversation.id}`)
    }
    for (const wave of Object.values(data.waves)) {
      if (!((wave.from === blocker && wave.to === blocked) || (wave.from === blocked && wave.to === blocker))) continue
      settle(world, wave.to, `wave:${wave.id}`)
      settle(world, wave.from, `wave-back:${wave.id}`)
      delete data.waves[wave.id]
    }
    cancelInvitesBetween(blocker, blocked)
    world.touch()
    for (const memberId of [blocker, blocked]) { world.push(memberId, { type: 'direct.changed', unread: unreadTotal(world, memberId) }); world.push(memberId, { type: 'around.changed' }) }
  })

  // ── A friendship ending stops new messages and open invitations; the history stays readable ──
  onUnfriend((friendWorld, first, second) => {
    if (friendWorld !== world) return
    cancelInvitesBetween(first, second)
    for (const memberId of [first, second]) { world.push(memberId, { type: 'direct.changed', unread: unreadTotal(world, memberId) }); world.push(memberId, { type: 'around.changed' }) }
  })

  function cancelInvitesBetween(first: MemberId, second: MemberId): void {
    for (const invite of Object.values(state(world).invites)) {
      if (!((invite.from === first && invite.to === second) || (invite.from === second && invite.to === first))) continue
      if (invite.status !== 'pending' && invite.status !== 'accepted') continue
      invite.status = 'cancelled'
      settle(world, invite.to, `join:${invite.id}`)
      settle(world, invite.from, `join-answer:${invite.id}`)
    }
  }

  // ── Time: inbox entries for unread messages, expiries, pruning ──
  world.onTick(now => {
    const data = state(world)
    for (const conversationId of [...rt.pendingNotify]) {
      const conversation = data.conversations[conversationId]
      if (!conversation || conversation.sealed) { rt.pendingNotify.delete(conversationId); continue }
      for (const side of [0, 1] as const) {
        const due = conversation.notifyDue[side]
        if (due === null || due > now) continue
        conversation.notifyDue[side] = null
        const memberId = side === 0 ? conversation.a : conversation.b
        if (unreadIn(conversation, memberId) > 0) notifyMessage(conversation, memberId)
      }
      if (conversation.notifyDue.every(due => due === null)) rt.pendingNotify.delete(conversationId)
    }
    if (now - rt.lastSweep < 20_000 && now >= rt.lastSweep) return
    rt.lastSweep = now
    let changed = false
    for (const wave of Object.values(data.waves)) {
      if ((wave.status === 'pending' || wave.status === 'dismissed') && wave.expiresAt <= now) {
        wave.status = 'expired'
        // Unanswered: the sender waits longer before the next one.
        const history = data.waveHistory[`${wave.from}>${wave.to}`]
        if (history) history.ignored++
        changed = true
      }
      if (wave.status !== 'pending' && wave.status !== 'dismissed' && now - wave.expiresAt > 6 * DAY) { delete data.waves[wave.id]; changed = true }
    }
    for (const [key, history] of Object.entries(data.waveHistory)) if (now - history.last > 30 * DAY) { delete data.waveHistory[key]; changed = true }
    for (const invite of Object.values(data.invites)) {
      if ((invite.status === 'pending' || invite.status === 'accepted') && invite.expiresAt <= now) {
        const wasPending = invite.status === 'pending'
        invite.status = 'expired'
        changed = true
        if (wasPending) for (const memberId of [invite.from, invite.to]) { const view = inviteView(world, memberId, invite); if (view) world.push(memberId, { type: 'join.changed', invite: view }) }
      }
      if (invite.status !== 'pending' && invite.status !== 'accepted' && now - invite.expiresAt > DAY) { delete data.invites[invite.id]; changed = true }
    }
    for (const hangout of Object.values(data.hangouts)) {
      const ends = hangout.startsAt + HANGOUT.lastsMinutes * 60_000
      if (!hangout.cancelled && !hangout.reminded && now >= hangout.startsAt - HANGOUT.remindMinutes * 60_000 && now < ends) {
        hangout.reminded = true
        changed = true
        const minutes = Math.max(0, Math.round((hangout.startsAt - now) / 60_000))
        for (const memberId of hangout.going) {
          emit(world, {
            to: memberId, category: 'events', kind: 'hangout.soon', title: minutes > 1 ? `${hangout.place.name}: the hangout starts in ${minutes} minutes` : `${hangout.place.name}: the hangout is starting`,
            body: memberId === hangout.host ? `${hangout.going.length - 1} other ${hangout.going.length === 2 ? 'person is' : 'people are'} coming. Be there to welcome them.` : `Hosted by ${nameOf(world, hangout.host)}. Go there to join in.`,
            link: `/people?tab=nearby&hangout=${hangout.id}`, actor: memberId === hangout.host ? null : hangout.host, dedupeKey: `hangout:${hangout.id}`, expiresAt: ends,
          })
          const view = hangoutView(world, memberId, hangout)
          if (view) world.push(memberId, { type: 'hangout.changed', hangout: view })
        }
      }
      if (now > ends + DAY) { delete data.hangouts[hangout.id]; changed = true }
    }
    for (const link of Object.values(data.links)) if (now > link.expiresAt + 7 * DAY) { delete data.links[link.id]; changed = true }
    for (const place of Object.values(data.places)) {
      const kept = fresh(place, now)
      if (kept.length !== place.visits.length) { place.visits = kept; changed = true }
    }
    if (changed) world.touch()
  })

  // ── Who is around ──

  world.register('around.get', empty, ctx => {
    const viewer = ctx.memberId
    const { profile } = record(world, viewer)
    const data = state(world)
    const origin = originOf(world, viewer)
    const here = pointOf(world, viewer) ?? origin
    const index = presenceIndex(world)
    const connected = world.isOnline(viewer) && Boolean(profile.onboardedAt)
    const cityAll = here ? inCity(world, here) : []
    const cityOthers = cityAll.filter(presence => presence.id !== viewer && !isBlockedEitherWay(world, viewer, presence.id))

    // Friends the service made are listed too, a bounded number of them. `whereOf` gives them online or offline and no more.
    const friends: FriendPresence[] = [...friendsOf(world, viewer), ...automaticFriendsOf(world, viewer, AROUND_AUTOMATIC_FRIENDS)].flatMap(friend => {
      const member = tryPublicMember(world, viewer, friend)
      if (!member) return []
      const conversation = data.conversations[data.byPair[pairKey(viewer, friend)] ?? '']
      return [{ member, where: whereOf(world, viewer, friend), conversationId: conversation?.id ?? null, unread: conversation ? unreadIn(conversation, viewer) : 0 }]
    }).sort((x, y) => Number(y.member.online) - Number(x.member.online) || y.unread - x.unread || x.member.displayName.localeCompare(y.member.displayName))

    const people: CityMember[] = []
    if (profile.preferences.discoverable) {
      for (const presence of cityOthers) {
        if (people.length >= 40) break
        // Anyone already in the friends list above, however the friendship came about, is not listed again here.
        if (mayMessage(world, viewer, presence.id) || !record(world, presence.id).profile.preferences.discoverable) continue
        const member = tryPublicMember(world, viewer, presence.id)
        if (!member) continue
        const wave = pendingWave(world, viewer, presence.id) ? 'sent' : pendingWave(world, presence.id, viewer)?.status === 'pending' ? 'received' : 'none'
        people.push({ member, areaLabel: presence.areaLabel, wave })
      }
      people.sort((x, y) => x.member.displayName.localeCompare(y.member.displayName))
    }

    const spots = here ? spotsFor(world, viewer, here, cityAll).slice(0, 12).map(entry => entry.spot) : []

    const elsewhere: Around['elsewhere'] = []
    const myArea = areaOf(world, viewer)?.label ?? null
    for (const [areaLabel, area] of index.areas) {
      if (here && inRange(here, area.point)) continue
      elsewhere.push({ areaLabel, online: area.count })
    }
    elsewhere.sort((x, y) => y.online - x.online || x.areaLabel.localeCompare(y.areaLabel))

    const now = ctx.now
    const waves = Object.values(data.waves).filter(wave => (wave.to === viewer && wave.status === 'pending' && wave.expiresAt > now)
      // A wave that was answered stays for a day, on both sides, so the two can take the next step.
      || (wave.status === 'returned' && (wave.to === viewer || wave.from === viewer) && now - wave.createdAt < 2 * DAY && !wave.hiddenFor?.includes(viewer)))
      .sort((x, y) => y.createdAt - x.createdAt).flatMap(wave => { const view = waveView(world, viewer, wave); return view ? [view] : [] })
      // Once the two are friends the wave has done its job.
      .filter(wave => wave.status === 'pending' || (wave.mine ? wave.to.relation : wave.from.relation) !== 'friend').slice(0, 20)
    const invites = Object.values(data.invites).filter(invite => (invite.to === viewer || invite.from === viewer) && (invite.status === 'pending' || invite.status === 'accepted') && invite.expiresAt > now)
      .sort((x, y) => y.createdAt - x.createdAt).flatMap(invite => { const view = inviteView(world, viewer, invite); return view ? [view] : [] })

    const hangouts = here ? Object.values(data.hangouts).flatMap(hangout => {
      const point = districtPoint(hangout.districtId)
      const view = point && inRange(here, point) ? hangoutView(world, viewer, hangout) : null
      return view && (view.status === 'upcoming' || view.status === 'now') ? [view] : []
    }).sort((x, y) => Number(y.status === 'now') - Number(x.status === 'now') || Date.parse(x.startsAt) - Date.parse(y.startsAt)).slice(0, 10) : []

    const around: Around = {
      settings: { ...settingsOf(world, viewer) }, discoverable: profile.preferences.discoverable, me: whereOf(world, viewer, viewer), friends,
      city: { label: myArea, online: cityOthers.length, people, listWithheld: !profile.preferences.discoverable },
      spots, elsewhere: elsewhere.slice(0, 5), worldOnline: Math.max(0, index.total - (connected ? 1 : 0)), waves, invites, hangouts, unreadDirect: unreadTotal(world, viewer),
    }
    return { around }
  }, { cost: 2 })

  world.register('around.settings', value => {
    const raw = obj(obj(value).settings, 'settings')
    return { settings: { shareWhereabouts: bool(raw, 'shareWhereabouts'), allowJoin: bool(raw, 'allowJoin') } }
  }, (ctx, input) => {
    // Nobody can come to a place they cannot be told about.
    const settings: SocialSettings = { shareWhereabouts: input.settings.shareWhereabouts, allowJoin: input.settings.shareWhereabouts && input.settings.allowJoin }
    state(world).settings[ctx.memberId] = settings
    world.touch()
    for (const friend of friendsOf(world, ctx.memberId)) if (world.isOnline(friend)) world.push(friend, { type: 'around.changed' })
    return { settings: { ...settings } }
  })

  /** The record of a public place, made the first time anyone steps into it. */
  function placeAt(key: RoomKey, ref: RoomRef, memberId: MemberId): PlaceRecord | null {
    if (ref.kind !== 'district' && ref.kind !== 'venue') return null
    const data = state(world)
    const area = areaOf(world, memberId)?.label ?? ''
    let place = data.places[key]
    if (!place) {
      place = { key, kind: ref.kind === 'venue' ? 'venue' : 'street', districtId: ref.districtId, placeId: ref.kind === 'venue' ? ref.placeId : null, names: [], category: '', areaLabel: area, visits: [] }
      data.places[key] = place
      indexPlace(rt, place)
    }
    if (!place.areaLabel) place.areaLabel = area
    return place
  }

  // The rooms module says when a member really changes room: that is a visit, and the counts moved.
  onRoomEnter((hookWorld, memberId, ref, now) => {
    if (hookWorld !== world) return
    rt.index = null
    const place = exists(world, memberId) ? placeAt(roomKey(ref), ref, memberId) : null
    if (!place) return
    place.visits = fresh(place, now).filter(visit => visit.m !== memberId)
    place.visits.push({ m: memberId, at: now })
    if (place.visits.length > 80) place.visits.shift()
    world.touch()
  })
  onRoomLeave(hookWorld => { if (hookWorld === world) rt.index = null })

  // Only the name of a venue still comes from the App: the map is on the device, not here.
  world.register('around.place', value => {
    const raw = obj(value)
    return { name: str(raw, 'name', { max: 80 }).replace(/\s+/g, ' '), category: str(raw, 'category', { max: 40 }) }
  }, (ctx, input) => {
    world.limit(`place:${ctx.memberId}`, 40, 60_000)
    const room = roomOf(world, ctx.memberId)
    const place = room && room.ref.kind === 'venue' ? placeAt(room.key, room.ref, ctx.memberId) : null
    if (!place || !input.name) return { recorded: false }
    // One name per reporter; the name most reporters agree on is the one shown.
    for (const entry of place.names) entry.by = entry.by.filter(memberId => memberId !== ctx.memberId)
    place.names = place.names.filter(entry => entry.by.length)
    const entry = place.names.find(item => item.name === input.name)
    if (entry) { if (entry.by.length < 12) entry.by.push(ctx.memberId) }
    else if (place.names.length < 6) place.names.push({ name: input.name, by: [ctx.memberId] })
    if (input.category) place.category = input.category
    world.touch()
    return { recorded: true }
  }, { cost: 0.5 })

  world.register('around.wayToSpot', value => ({ spotId: str(obj(value), 'spotId', { min: 4, max: 24 }) }), (ctx, input) => {
    const here = pointOf(world, ctx.memberId) ?? originOf(world, ctx.memberId)
    if (!here) throw new WorldError('conflict', 'Choose where you are first. Then you can go and meet people.')
    const entry = spotsFor(world, ctx.memberId, here, inCity(world, here)).find(item => item.spot.id === input.spotId)
    const target = entry ? spotTarget(entry) : null
    if (!entry || !target) throw new WorldError('not_found', 'Nobody is at that place any more. Look at who is around again.')
    return { way: wayTo(world, ctx.memberId, target, entry.spot.areaLabel) }
  })

  world.register('around.wayToFriend', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    const friend = publicMember(world, ctx.memberId, input.memberId)
    if (!areFriends(world, ctx.memberId, input.memberId)) throw new WorldError('forbidden', `You can only go to friends. Wave at ${friend.displayName} or introduce yourself first.`)
    const where = whereOf(world, ctx.memberId, input.memberId)
    const none = (text: string): { way: Way } => ({ way: { reach: 'unavailable', destination: null, areaLabel: where.areaLabel, text } })
    if (where.hidden) return none(`${friend.displayName} is not sharing where they are. Send a message instead.`)
    if (where.state === 'offline') return none(`${friend.displayName} is offline. Leave a message and they will see it when they are back.`)
    if (where.state === 'travelling') return none(`${friend.displayName} is ${where.words}. Try again when they arrive.`)
    if (!where.canJoin) {
      return none(where.state === 'street' || where.state === 'venue' || where.state === 'home'
        ? `${friend.displayName} prefers to be asked first. Send a message and ask them to invite you.`
        : `${friend.displayName} is ${where.words}. There is nowhere to walk to right now.`)
    }
    const at = where.state === 'home' ? null : standingAt(world, input.memberId)
    if (where.state === 'home') {
      const home = roomOf(world, input.memberId)
      if (home?.ref.kind !== 'home') return none(`${friend.displayName} has just left.`)
      // The homes module decides who may come in; asked as the viewer, so its own rules answer.
      try { world.call(ctx.memberId, 'home.get', { homeId: home.ref.homeId }) } catch { return none(`${friend.displayName} is at home, and their home is not open to visitors right now.`) }
      return { way: wayTo(world, ctx.memberId, { kind: 'home', homeId: home.ref.homeId, name: `${friend.displayName}’s home` }, null) }
    }
    if (!at) return none(`${friend.displayName} has just left.`)
    return { way: wayTo(world, ctx.memberId, at.target, at.place.areaLabel) }
  })

  // ── Waves ──

  world.register('wave.send', value => ({ to: id<MemberId>(obj(value), 'to', 'm') }), (ctx, input) => {
    const from = ctx.memberId, to = input.to
    if (to === from) throw new WorldError('invalid', 'You cannot wave at yourself.')
    const target = publicMember(world, from, to)
    const incoming = pendingWave(world, to, from)
    if (incoming && incoming.status === 'pending') {
      // They waved first: this is the wave back.
      returnWave(world, incoming, from)
      return { wave: waveView(world, from, incoming)!, returned: true }
    }
    if (pendingWave(world, from, to)) throw new WorldError('conflict', `You already waved at ${target.displayName}. Give them time to answer.`)
    const reason = waveContext(world, from, to)
    if (!reason) throw new WorldError('forbidden', 'You can wave at people in the same place as you, at friends, at people in your city when you are both discoverable, and at people in a community you share.')
    const data = state(world)
    const history = data.waveHistory[`${from}>${to}`]
    if (history) {
      const wait = reason.context === 'friend' ? FRIEND_COOLDOWN_MS : history.ignored >= 2 ? WAVE.ignoredCooldownDays * DAY : WAVE.pairCooldownHours * HOUR
      if (ctx.now - history.last < wait) throw new WorldError('rate_limited', `You waved at ${target.displayName} not long ago. Give it some time before waving again.`)
    }
    world.limit(`wave-burst:${from}`, 5, 60_000)
    world.limit(`wave:${from}`, WAVE.perDay, DAY)
    const wave: WaveRecord = {
      id: newId<WaveId>('wv'), from, to, context: reason.context, contextText: reason.text, status: 'pending', createdAt: ctx.now, expiresAt: ctx.now + WAVE.ttlHours * HOUR,
    }
    data.waves[wave.id] = wave
    data.waveHistory[`${from}>${to}`] = { last: ctx.now, ignored: history?.ignored ?? 0 }
    world.touch()
    const seen = waveView(world, to, wave)
    if (seen) world.push(to, { type: 'wave.received', wave: seen })
    emit(world, {
      to, category: 'social', kind: 'social.wave', title: `${nameOf(world, from)} waved at you`, body: `${reason.text} Wave back to say hello.`,
      link: `/people?tab=nearby&wave=${wave.id}`, actor: from, dedupeKey: `wave:${wave.id}`, expiresAt: wave.expiresAt,
    })
    return { wave: waveView(world, from, wave)!, returned: false }
  })

  const incomingWave = (waveId: WaveId, memberId: MemberId): WaveRecord => {
    const wave = requireFound(state(world).waves[waveId], 'That wave')
    if (wave.to !== memberId || isBlockedEitherWay(world, wave.from, wave.to)) throw new WorldError('not_found', 'That wave was not found.')
    return wave
  }

  world.register('wave.back', value => ({ waveId: id<WaveId>(obj(value), 'waveId', 'wv') }), (ctx, input) => {
    const wave = incomingWave(input.waveId, ctx.memberId)
    if (wave.status === 'returned') return { wave: waveView(world, ctx.memberId, wave)! }
    if (wave.expiresAt <= ctx.now || wave.status === 'expired') throw new WorldError('expired', 'That wave is from a while ago. You can wave at them yourself.')
    world.limit(`wave-burst:${ctx.memberId}`, 5, 60_000)
    returnWave(world, wave, ctx.memberId)
    return { wave: waveView(world, ctx.memberId, wave)! }
  })

  world.register('wave.dismiss', value => ({ waveId: id<WaveId>(obj(value), 'waveId', 'wv') }), (ctx, input) => {
    const found = requireFound(state(world).waves[input.waveId], 'That wave')
    // An answered wave can be put away by either of the two; a waiting one only by the person waved at.
    if (found.status === 'returned' && found.from === ctx.memberId) {
      found.hiddenFor = [...new Set([...(found.hiddenFor ?? []), ctx.memberId])]
      settle(world, ctx.memberId, `wave-back:${found.id}`)
      world.touch()
      return { dismissed: true as const }
    }
    const wave = incomingWave(input.waveId, ctx.memberId)
    if (wave.status === 'pending') wave.status = 'dismissed'
    else if (wave.status === 'returned') wave.hiddenFor = [...new Set([...(wave.hiddenFor ?? []), ctx.memberId])]
    settle(world, ctx.memberId, `wave:${wave.id}`)
    world.touch()
    return { dismissed: true as const }
  })

  // ── Join me ──

  world.register('join.send', value => {
    const raw = obj(value)
    return { to: id<MemberId>(raw, 'to', 'm'), place: oneOf(raw, 'place', ['here', 'home'] as const), note: str(raw, 'note', { max: JOIN.noteMax }) }
  }, (ctx, input) => {
    const from = ctx.memberId
    if (input.to === from) throw new WorldError('invalid', 'You are already where you are.')
    const friend = publicMember(world, from, input.to)
    if (!areFriends(world, from, input.to)) throw new WorldError('forbidden', `You can only invite friends to join you. Wave at ${friend.displayName} or introduce yourself first.`)
    if (tripOf(world, from)) throw new WorldError('conflict', 'You are travelling. Invite them once you have arrived.')
    let resolved: { target: Destination; place: JoinInvite['place'] } | null
    if (input.place === 'home') resolved = ownHome(world, from)
    else {
      const room = roomOf(world, from)
      if (room?.ref.kind === 'home') {
        if (room.ref.homeId !== record(world, from).profile.homeId) throw new WorldError('conflict', 'You are a guest here. Only the host can invite people in.')
        resolved = ownHome(world, from)
      } else resolved = standingAt(world, from)
    }
    if (!resolved) throw new WorldError('conflict', 'Step into a street, a venue or your home first, then invite them.')
    world.limit(`join:${from}`, 12, 600_000)
    world.limit(`join:${from}:${input.to}`, JOIN.perPairPerHour, HOUR)
    const data = state(world)
    // One open invitation per friend: a new one replaces the last, answered or not, because the place has changed.
    for (const earlier of Object.values(data.invites)) {
      if (earlier.from !== from || earlier.to !== input.to || (earlier.status !== 'pending' && earlier.status !== 'accepted')) continue
      earlier.status = 'cancelled'
      settle(world, earlier.to, `join:${earlier.id}`)
      settle(world, from, `join-answer:${earlier.id}`)
      const view = inviteView(world, earlier.to, earlier)
      if (view) world.push(earlier.to, { type: 'join.changed', invite: view })
    }
    const minutes = resolved.target.kind === 'home' ? JOIN.homeMinutes : JOIN.hereMinutes
    const invite: InviteRecord = {
      id: newId<JoinInviteId>('ji'), from, to: input.to, place: resolved.place, target: resolved.target, note: input.note, status: 'pending',
      createdAt: ctx.now, expiresAt: ctx.now + minutes * 60_000, answeredAt: null,
    }
    data.invites[invite.id] = invite
    world.touch()
    const where = invite.place.kind === 'home' ? `at ${invite.place.name}` : invite.place.kind === 'table' ? 'at a game table'
      : `${invite.place.kind === 'venue' ? `at ${invite.place.name}` : `on ${invite.place.name}`}${invite.place.kind === 'venue' && invite.place.areaLabel ? ` in ${invite.place.areaLabel}` : ''}`
    emit(world, {
      to: input.to, category: 'events', kind: 'social.join-me', title: `${nameOf(world, from)} invites you to join them`,
      body: `${invite.place.kind === 'home' ? `${invite.place.name} is open to you. Walk to its front door to join them.` : `They are ${where}.`}${invite.note ? ` “${invite.note}”` : ''}`, link: `/people?tab=nearby&invite=${invite.id}`, actor: from,
      dedupeKey: `join:${invite.id}`, expiresAt: invite.expiresAt,
    })
    const seen = inviteView(world, input.to, invite)
    if (seen) world.push(input.to, { type: 'join.changed', invite: seen })
    return { invite: inviteView(world, from, invite)! }
  })

  const inviteFor = (inviteId: JoinInviteId, memberId: MemberId): InviteRecord => {
    const invite = requireFound(state(world).invites[inviteId], 'That invitation')
    if ((invite.from !== memberId && invite.to !== memberId) || isBlockedEitherWay(world, invite.from, invite.to)) throw new WorldError('not_found', 'That invitation was not found.')
    return invite
  }

  world.register('join.get', value => ({ inviteId: id<JoinInviteId>(obj(value), 'inviteId', 'ji') }), (ctx, input) => (
    { invite: requireFound(inviteView(world, ctx.memberId, inviteFor(input.inviteId, ctx.memberId)), 'That invitation') }
  ))

  world.register('join.respond', value => {
    const raw = obj(value)
    return { inviteId: id<JoinInviteId>(raw, 'inviteId', 'ji'), accept: bool(raw, 'accept') }
  }, (ctx, input) => {
    const invite = inviteFor(input.inviteId, ctx.memberId)
    if (invite.to !== ctx.memberId) throw new WorldError('forbidden', 'Only the person invited can answer this invitation.')
    const open = invite.status === 'pending' || invite.status === 'accepted'
    if (open && invite.expiresAt <= ctx.now) {
      invite.status = 'expired'
      world.touch()
      throw new WorldError('expired', 'This invitation has expired. Ask them where they are now.')
    }
    // The way can hold the sender's place in the scene: it is only ever given to someone who is still their friend.
    if (!areFriends(world, invite.from, invite.to)) throw new WorldError('forbidden', 'You are no longer friends, so this invitation has ended.')
    // A home is judged as it is now, not as it was when the invitation was made: it may since have been taken off the map, closed to friends or moved.
    const homeWay = input.accept && invite.target.kind === 'home' ? wayTo(world, ctx.memberId, invite.target, invite.place.areaLabel) : null
    // Asking again after accepting gives the way again; it does not change the answer.
    if (invite.status === 'accepted' && input.accept) return { invite: inviteView(world, ctx.memberId, invite)!, way: homeWay ?? wayTo(world, ctx.memberId, invite.target, invite.place.areaLabel) }
    if (invite.status !== 'pending') throw new WorldError('conflict', `This invitation was already ${invite.status}.`)
    // Nothing is promised to the sender that the invited member cannot do: it stays open to try again, or to decline.
    if (homeWay?.reach === 'unavailable') throw new WorldError('conflict', homeWay.text)
    invite.status = input.accept ? 'accepted' : 'declined'
    invite.answeredAt = ctx.now
    settle(world, ctx.memberId, `join:${invite.id}`)
    world.touch()
    const way = input.accept ? homeWay ?? wayTo(world, ctx.memberId, invite.target, invite.place.areaLabel) : null
    if (way) {
      const name = nameOf(world, ctx.memberId)
      emit(world, {
        to: invite.from, category: 'events', kind: 'social.join-accepted',
        title: way.reach === 'travel' ? `${name} wants to join you, and needs a trip first` : `${name} is coming to join you`,
        body: invite.place.kind === 'home' && way.reach === 'walk' ? `They are walking to the front door of ${invite.place.name}.` : way.reach === 'travel' ? 'They are in another city. It may take a while.' : 'Stay where you are so they can find you.',
        link: '/people?tab=nearby', actor: ctx.memberId, dedupeKey: `join-answer:${invite.id}`, expiresAt: invite.expiresAt + 15 * 60_000,
      })
    }
    const toSender = inviteView(world, invite.from, invite)
    if (toSender) world.push(invite.from, { type: 'join.changed', invite: toSender })
    return { invite: inviteView(world, ctx.memberId, invite)!, way }
  })

  world.register('join.cancel', value => ({ inviteId: id<JoinInviteId>(obj(value), 'inviteId', 'ji') }), (ctx, input) => {
    const invite = inviteFor(input.inviteId, ctx.memberId)
    if (invite.from !== ctx.memberId) throw new WorldError('forbidden', 'Only the sender can take an invitation back. You can decline instead.')
    if (invite.status === 'pending' || invite.status === 'accepted') {
      invite.status = 'cancelled'
      settle(world, invite.to, `join:${invite.id}`)
      settle(world, invite.from, `join-answer:${invite.id}`)
      world.touch()
      const seen = inviteView(world, invite.to, invite)
      if (seen) world.push(invite.to, { type: 'join.changed', invite: seen })
    }
    return { invite: inviteView(world, ctx.memberId, invite)! }
  })

  // ── Invite links ──

  world.onOperation(memberId => {
    // Someone who opened a link before making their character: their inviter hears once they exist.
    const linkId = state(world).cameThrough[memberId]
    const link = linkId ? state(world).links[linkId] : undefined
    if (link && exists(world, memberId) && !isBlockedEitherWay(world, memberId, link.by)) announceJoined(world, link, memberId)
  })

  world.register('link.create', empty, ctx => {
    if (!record(world, ctx.memberId).profile.onboardedAt) throw new WorldError('conflict', 'Finish making your character first.')
    if (linksOf(world, ctx.memberId).length >= INVITE_LINK.open) throw new WorldError('conflict', `You have ${INVITE_LINK.open} invite links open. Take one back before making another.`)
    world.limit(`link:${ctx.memberId}`, INVITE_LINK.perDay, DAY)
    const area = areaOf(world, ctx.memberId)
    const link: LinkRecord = {
      id: randomToken(16), by: ctx.memberId, areaLabel: area?.label ?? null,
      // The named public place, copied as it is now: the link keeps saying "Yaba" after the maker moves on.
      area: area ? { areaId: area.areaId, label: area.label, countryCode: area.countryCode, timezone: area.timezone, anchor: { ...area.anchor }, arrivalDistrict: area.arrivalDistrict } : null,
      createdAt: ctx.now, expiresAt: ctx.now + INVITE_LINK.days * DAY, revoked: false, opened: [], announced: [],
    }
    state(world).links[link.id] = link
    world.touch()
    return { link: linkView(world, link), links: linksOf(world, ctx.memberId) }
  })

  world.register('link.mine', empty, ctx => ({ links: linksOf(world, ctx.memberId) }))

  world.register('link.revoke', value => ({ id: str(obj(value), 'id', { min: 16, max: 16 }) }), (ctx, input) => {
    const link = state(world).links[input.id]
    if (!link || link.by !== ctx.memberId) throw new WorldError('not_found', 'That invite link was not found.')
    link.revoked = true
    world.touch()
    return { links: linksOf(world, ctx.memberId) }
  })

  const parseToken = (value: unknown): { token: string } => ({ token: str(obj(value), 'token', { min: 10, max: 60 }) })

  world.register('link.open', parseToken, (ctx, input) => {
    // Guessing addresses gets nowhere: the signature fails first, and tries are limited.
    world.limit(`link-open:${ctx.memberId}`, 30, HOUR)
    const link = linkFor(world, input.token)
    const inviter = publicMember(world, ctx.memberId, link.by)
    if (link.by !== ctx.memberId) {
      if (!link.opened.includes(ctx.memberId) && link.opened.length < 200) { link.opened.push(ctx.memberId); world.touch() }
      state(world).cameThrough[ctx.memberId] = link.id
      announceJoined(world, link, ctx.memberId)
    }
    const landing: InviteLanding = { inviter, areaLabel: link.areaLabel, area: link.area, expiresAt: iso(link.expiresAt), own: link.by === ctx.memberId }
    return { landing }
  })

  world.register('link.hello', parseToken, (ctx, input) => {
    world.limit(`link-open:${ctx.memberId}`, 30, HOUR)
    const link = linkFor(world, input.token)
    if (link.by === ctx.memberId) throw new WorldError('invalid', 'This is your own invite link.')
    if (!record(world, ctx.memberId).profile.onboardedAt) throw new WorldError('conflict', 'Finish making your character first. Then you can say hello.')
    let outcome: 'sent' | 'waiting' | 'friends' = 'friends'
    if (!areFriends(world, ctx.memberId, link.by)) {
      // The introduction itself belongs to the social module; it is asked for as this member, so its rules apply.
      try { world.call(ctx.memberId, 'intro.send', { to: link.by, note: 'I came through your invite link.' }); outcome = 'sent' }
      catch (error) { if (error instanceof WorldError && error.code === 'conflict') outcome = 'waiting'; else throw error }
    }
    return { state: outcome, inviter: publicMember(world, ctx.memberId, link.by) }
  })

  // ── Open hangouts ──

  const hangoutFor = (hangoutId: HangoutId, memberId: MemberId): HangoutRecord => {
    const hangout = state(world).hangouts[hangoutId]
    if (!hangout || !exists(world, hangout.host) || isBlockedEitherWay(world, memberId, hangout.host)) throw new WorldError('not_found', 'That hangout was not found.')
    return hangout
  }
  const hangoutLine = (hangout: HangoutRecord): string => `${hangout.place.name} · ${whenIn(hangout.startsAt, hangout.timezone)}`
  const hangoutLink = (hangout: HangoutRecord): string => `/people?tab=nearby&hangout=${hangout.id}`
  const tellGoing = (hangout: HangoutRecord): void => {
    for (const memberId of hangout.going) { const view = hangoutView(world, memberId, hangout); if (view) world.push(memberId, { type: 'hangout.changed', hangout: view }) }
  }

  world.register('hangout.create', value => {
    const raw = obj(value)
    return { startsAt: iso(isoInstant(raw, 'startsAt')) as string, note: str(raw, 'note', { max: HANGOUT.noteMax }) }
  }, (ctx, input) => {
    const host = ctx.memberId
    if (!record(world, host).profile.onboardedAt) throw new WorldError('conflict', 'Finish making your character first.')
    const startsAt = Date.parse(input.startsAt)
    if (startsAt < ctx.now + HANGOUT.minMinutesAhead * 60_000) throw new WorldError('invalid', `Choose a time at least ${HANGOUT.minMinutesAhead} minutes from now.`)
    if (startsAt > ctx.now + HANGOUT.maxDaysAhead * DAY) throw new WorldError('invalid', `Choose a time within the next ${HANGOUT.maxDaysAhead} days.`)
    // A hangout is held where the host is standing, and only in a public place: the service reads it from their room.
    const at = standingAt(world, host)
    if (!at || (at.target.kind !== 'street' && at.target.kind !== 'venue')) throw new WorldError('conflict', 'Hangouts are held in public places. Step into a street or a venue, then set the time.')
    const data = state(world)
    const upcoming = Object.values(data.hangouts).filter(hangout => hangout.host === host && !hangout.cancelled && hangout.startsAt + HANGOUT.lastsMinutes * 60_000 > ctx.now)
    if (upcoming.length >= HANGOUT.perHost) throw new WorldError('conflict', `You are already hosting ${HANGOUT.perHost} hangouts. Cancel one, or wait until one is over.`)
    world.limit(`hangout:${host}`, 4, DAY)
    // Open to strangers, so it leads to the place, never to where the host stood in it.
    const target: Destination = at.target.kind === 'street' ? { ...at.target, meet: null } : at.target
    const hangout: HangoutRecord = {
      id: newId<HangoutId>('hg'), host, place: { kind: at.target.kind, name: at.place.kind === 'street' ? `Streets of ${at.place.areaLabel ?? 'this district'}` : at.place.name, areaLabel: at.place.areaLabel },
      target, districtId: at.target.districtId, startsAt, timezone: areaOf(world, host)?.timezone ?? 'UTC', note: input.note, going: [host], cancelled: false, reminded: false, createdAt: ctx.now,
    }
    data.hangouts[hangout.id] = hangout
    world.touch()
    const point = districtPoint(hangout.districtId)
    if (point) for (const presence of inCity(world, point)) if (presence.id !== host && !isBlockedEitherWay(world, host, presence.id)) world.push(presence.id, { type: 'around.changed' })
    return { hangout: hangoutView(world, host, hangout)! }
  })

  world.register('hangout.get', value => ({ hangoutId: id<HangoutId>(obj(value), 'hangoutId', 'hg') }), (ctx, input) => (
    { hangout: requireFound(hangoutView(world, ctx.memberId, hangoutFor(input.hangoutId, ctx.memberId)), 'That hangout') }
  ))

  world.register('hangout.rsvp', value => {
    const raw = obj(value)
    return { hangoutId: id<HangoutId>(raw, 'hangoutId', 'hg'), going: bool(raw, 'going') }
  }, (ctx, input) => {
    const hangout = hangoutFor(input.hangoutId, ctx.memberId)
    if (hangout.cancelled) throw new WorldError('conflict', 'This hangout was cancelled.')
    if (ctx.now >= hangout.startsAt + HANGOUT.lastsMinutes * 60_000) throw new WorldError('expired', 'This hangout is over.')
    if (hangout.host === ctx.memberId) throw new WorldError('invalid', 'You are the host. Cancel the hangout if you cannot make it.')
    world.limit(`hangout-rsvp:${ctx.memberId}`, 20, HOUR)
    const was = hangout.going.includes(ctx.memberId)
    if (input.going && !was) {
      if (hangout.going.length >= 200) throw new WorldError('conflict', 'This hangout is full.')
      hangout.going.push(ctx.memberId)
      emit(world, {
        to: hangout.host, category: 'events', kind: 'hangout.going', title: `${nameOf(world, ctx.memberId)} is coming to your hangout`, body: hangoutLine(hangout),
        link: hangoutLink(hangout), actor: ctx.memberId, dedupeKey: `hangout-going:${hangout.id}`, expiresAt: hangout.startsAt + HANGOUT.lastsMinutes * 60_000,
      })
    } else if (!input.going && was) {
      hangout.going = hangout.going.filter(memberId => memberId !== ctx.memberId)
      settle(world, ctx.memberId, `hangout:${hangout.id}`)
    }
    world.touch()
    tellGoing(hangout)
    return { hangout: hangoutView(world, ctx.memberId, hangout)! }
  })

  world.register('hangout.cancel', value => ({ hangoutId: id<HangoutId>(obj(value), 'hangoutId', 'hg') }), (ctx, input) => {
    const hangout = hangoutFor(input.hangoutId, ctx.memberId)
    if (hangout.host !== ctx.memberId) throw new WorldError('forbidden', 'Only the host can cancel. You can say you are not coming instead.')
    if (!hangout.cancelled) {
      hangout.cancelled = true
      world.touch()
      for (const memberId of hangout.going) {
        settle(world, memberId, `hangout:${hangout.id}`)
        if (memberId !== hangout.host) emit(world, {
          to: memberId, category: 'events', kind: 'hangout.cancelled', title: 'A hangout you were going to was cancelled', body: hangoutLine(hangout),
          link: hangoutLink(hangout), actor: hangout.host, dedupeKey: `hangout-cancelled:${hangout.id}`, expiresAt: hangout.startsAt,
        })
      }
      settle(world, hangout.host, `hangout-going:${hangout.id}`)
      tellGoing(hangout)
    }
    return { hangout: hangoutView(world, ctx.memberId, hangout)! }
  })

  world.register('hangout.way', value => ({ hangoutId: id<HangoutId>(obj(value), 'hangoutId', 'hg') }), (ctx, input) => {
    const hangout = hangoutFor(input.hangoutId, ctx.memberId)
    if (hangout.cancelled || ctx.now >= hangout.startsAt + HANGOUT.lastsMinutes * 60_000) throw new WorldError('expired', 'This hangout is over.')
    return { way: wayTo(world, ctx.memberId, hangout.target, hangout.place.areaLabel) }
  })

  // ── Emotes ──

  world.register('emote.send', value => ({ kind: oneOf(obj(value), 'kind', EMOTES) }), (ctx, input) => {
    const room = roomOf(world, ctx.memberId)
    if (!room) throw new WorldError('conflict', 'Step into a street or a room first.')
    world.limit(`emote:${ctx.memberId}`, 8, 10_000)
    let reached = 0
    for (const other of roomMates(world, ctx.memberId)) {
      if (isBlockedEitherWay(world, ctx.memberId, other)) continue
      const theirs = roomOf(world, other)
      // In a street a gesture is seen as far as avatars are drawn; indoors, by the whole room.
      if (!theirs || (room.ref.kind === 'district' && distance(theirs.pos, room.pos) > INTEREST_RADIUS)) continue
      world.push(other, { type: 'social.emote', room: room.key, memberId: ctx.memberId, kind: input.kind, at: iso(ctx.now) })
      reached++
    }
    return { reached }
  }, { cost: 0.5 })

  // ── Direct messages ──

  const conversationFor = (conversationId: ConversationId, memberId: MemberId): ConversationRecord => {
    const conversation = state(world).conversations[conversationId]
    if (!conversation || conversation.sealed || (conversation.a !== memberId && conversation.b !== memberId)
      || !exists(world, peerOf(conversation, memberId)) || isBlockedEitherWay(world, conversation.a, conversation.b)) {
      throw new WorldError('not_found', 'That conversation was not found.')
    }
    return conversation
  }

  /** The member's App now holds everything up to the latest message. Tells the peer when that is news. */
  function markDelivered(conversation: ConversationRecord, memberId: MemberId): void {
    const side = sideOf(conversation, memberId)
    const latest = lastSeq(conversation)
    if (conversation.delivered[side] >= latest) return
    conversation.delivered[side] = latest
    world.touch()
    world.push(peerOf(conversation, memberId), { type: 'direct.state', conversationId: conversation.id, peerDeliveredSeq: latest, peerReadSeq: conversation.read[side] })
  }

  function markRead(conversation: ConversationRecord, memberId: MemberId, upTo: number): void {
    const side = sideOf(conversation, memberId)
    const mark = Math.min(lastSeq(conversation), Math.max(conversation.read[side], upTo))
    if (mark === conversation.read[side]) return
    conversation.read[side] = mark
    conversation.delivered[side] = Math.max(conversation.delivered[side], mark)
    conversation.notifyDue[side] = null
    settle(world, memberId, `direct:${conversation.id}`)
    world.touch()
    world.push(peerOf(conversation, memberId), { type: 'direct.state', conversationId: conversation.id, peerDeliveredSeq: conversation.delivered[side], peerReadSeq: mark })
  }

  function notifyMessage(conversation: ConversationRecord, to: MemberId): void {
    const latest = [...conversation.messages].reverse().find(message => message.from !== to)
    if (!latest) return
    emit(world, {
      to, category: 'replies', kind: 'direct.message', title: `${nameOf(world, latest.from)} sent you a message`, body: latest.text.slice(0, 140),
      link: `/messages/${conversation.id}`, actor: latest.from, dedupeKey: `direct:${conversation.id}`,
    })
  }

  world.register('direct.list', empty, ctx => {
    const conversations = conversationsOf(world, ctx.memberId).filter(conversation => conversation.messages.length && !onlyOwnAutomatic(conversation, ctx.memberId))
    for (const conversation of conversations) markDelivered(conversation, ctx.memberId)
    return {
      conversations: conversations.flatMap(conversation => { const view = conversationView(world, ctx.memberId, conversation); return view ? [view] : [] })
        .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt)).slice(0, 100),
      unread: unreadTotal(world, ctx.memberId),
    }
  })

  world.register('direct.open', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    if (input.memberId === ctx.memberId) throw new WorldError('invalid', 'You cannot message yourself.')
    const peer = publicMember(world, ctx.memberId, input.memberId)
    const data = state(world)
    // Old history stays readable after a friendship ends, but a conversation only starts between friends.
    if (!data.byPair[pairKey(ctx.memberId, input.memberId)] && !mayMessage(world, ctx.memberId, input.memberId)) {
      throw new WorldError('forbidden', `Messages are between friends. Wave at ${peer.displayName} or introduce yourself first.`)
    }
    const conversation = ensureConversation(world, ctx.memberId, input.memberId, ctx.now)
    return { conversation: conversationView(world, ctx.memberId, conversation)! }
  })

  world.register('direct.get', value => {
    const raw = obj(value)
    return { conversationId: id<ConversationId>(raw, 'conversationId', 'dm'), before: optNum(raw, 'before', { integer: true, min: 1 }) }
  }, (ctx, input) => {
    const conversation = conversationFor(input.conversationId, ctx.memberId)
    markDelivered(conversation, ctx.memberId)
    const older = input.before === null ? conversation.messages : conversation.messages.filter(message => message.seq < input.before!)
    const page = older.slice(-DIRECT_PAGE)
    return {
      conversation: conversationView(world, ctx.memberId, conversation)!, messages: page.map(message => messageView(conversation, message)),
      more: older.length > page.length,
    }
  })

  world.register('direct.send', value => {
    const raw = obj(value)
    return {
      conversationId: id<ConversationId>(raw, 'conversationId', 'dm'), text: str(raw, 'text', { min: 1, max: DIRECT_MAX_LENGTH }),
      clientId: str(raw, 'clientId', { min: 1, max: 40 }),
    }
  }, (ctx, input) => {
    const conversation = conversationFor(input.conversationId, ctx.memberId)
    const peerId = peerOf(conversation, ctx.memberId)
    const side = sideOf(conversation, ctx.memberId), other = side === 0 ? 1 : 0
    if (!mayMessage(world, ctx.memberId, peerId)) throw new WorldError('forbidden', `You and ${nameOf(world, peerId)} are no longer friends, so new messages are not sent. Send an introduction to talk again.`)
    // A retried send (the answer was lost on the way back) returns the message already stored.
    if (conversation.lastClient[side] === input.clientId) {
      const stored = [...conversation.messages].reverse().find(message => message.from === ctx.memberId)
      if (stored) return { message: messageView(conversation, stored), conversation: conversationView(world, ctx.memberId, conversation)! }
    }
    world.limit(`dm-burst:${ctx.memberId}`, 6, 5_000)
    world.limit(`dm:${ctx.memberId}`, 30, 60_000)
    const message: MessageRecord = { id: `dmm_${randomToken(12)}`, seq: conversation.nextSeq++, from: ctx.memberId, text: input.text, at: iso(ctx.now) }
    conversation.messages.push(message)
    if (conversation.messages.length > DIRECT_KEPT) conversation.messages.shift()
    conversation.lastClient[side] = input.clientId
    conversation.updatedAt = message.at
    // Writing a reply means the sender has seen what came before it.
    conversation.read[side] = message.seq
    conversation.delivered[side] = message.seq
    conversation.notifyDue[side] = null
    settle(world, ctx.memberId, `direct:${conversation.id}`)
    world.touch()
    if (world.isOnline(peerId)) {
      conversation.delivered[other] = message.seq
      const seen = conversationView(world, peerId, conversation)
      if (seen) world.push(peerId, { type: 'direct.message', message: messageView(conversation, message), conversation: seen, unread: unreadTotal(world, peerId) })
      // Connected is not the same as looking: if it is still unread shortly, it becomes an inbox entry too.
      if (conversation.notifyDue[other] === null) { conversation.notifyDue[other] = ctx.now + ONLINE_NOTIFY_DELAY_MS; rt.pendingNotify.add(conversation.id) }
    } else notifyMessage(conversation, peerId)
    return { message: messageView(conversation, message), conversation: conversationView(world, ctx.memberId, conversation)! }
  })

  world.register('direct.read', value => {
    const raw = obj(value)
    return { conversationId: id<ConversationId>(raw, 'conversationId', 'dm'), upTo: Number(raw.upTo) }
  }, (ctx, input) => {
    if (!Number.isInteger(input.upTo) || input.upTo < 0) throw new WorldError('invalid', 'upTo must be a whole number')
    markRead(conversationFor(input.conversationId, ctx.memberId), ctx.memberId, input.upTo)
    return { unread: unreadTotal(world, ctx.memberId) }
  }, { cost: 0.5 })

  world.register('direct.readAll', empty, ctx => {
    for (const conversation of conversationsOf(world, ctx.memberId)) markRead(conversation, ctx.memberId, lastSeq(conversation))
    return { unread: unreadTotal(world, ctx.memberId) }
  })

  world.register('direct.report', value => {
    const raw = obj(value)
    return { conversationId: id<ConversationId>(raw, 'conversationId', 'dm'), reason: oneOf(raw, 'reason', REPORT_REASONS), detail: str(raw, 'detail', { max: 400 }) }
  }, (ctx, input) => {
    const conversation = conversationFor(input.conversationId, ctx.memberId)
    const about = peerOf(conversation, ctx.memberId)
    // The members module keeps the report (and its rate limit); the recent messages are kept here for the reviewer.
    world.call(ctx.memberId, 'member.report', { memberId: about, reason: input.reason, detail: `[Direct messages ${conversation.id}] ${input.detail}`.slice(0, 500), room: null })
    const data = state(world)
    data.reports.unshift({ id: `dr_${randomToken(10)}`, by: ctx.memberId, about, conversationId: conversation.id, reason: input.reason, detail: input.detail, at: iso(ctx.now), messages: conversation.messages.slice(-30) })
    if (data.reports.length > 300) data.reports.length = 300
    world.touch()
    return { received: true as const }
  })
}
