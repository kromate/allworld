// Social presence beyond the street: direct messages, waves, invitations to join, who is around.
// Owned by its track. Operations and events declared here are merged into the protocol.
//
// Privacy rules every record below keeps:
//   - A person's whereabouts are WORDS: an area name ("in Yaba, Lagos") or a venue name
//     ("at Bodija Market"). No record that names a person carries coordinates, an area cell, a
//     district cell or a distance.
//   - A district or place id only ever leaves the service as a `Way`: the answer to "how do I get
//     there?", given to a member who was invited, or who asked about a public gathering spot, or
//     about a friend who allows friends to come to them. A `Way` never moves an avatar; the App
//     walks there, and the travel rules still decide whether it may.
//   - A `Way` to a person in a street also carries a meeting point. Decided by the coordinator:
//     a friend you invited, or a friend who taps "Go to them" when you allow it, may receive your
//     position in the game scene — the virtual position everyone in that room already sees, never
//     a real-world coordinate. It is only ever sent to a friend, for a room that friend may
//     enter, and no list carries it.
//   - Counts are real: members connected right now, minus anyone blocked in either direction.
import type { DistrictId, HomeId, Id, Iso, MatchId, MemberId, PlaceId, RoomKey } from './ids.ts'
import type { Vec2 } from './geo.ts'
import type { CoarseArea, PublicMember, ReportReason } from './model.ts'

export type ConversationId = Id<'conversation'>
export type WaveId = Id<'wave'>
export type JoinInviteId = Id<'join-invite'>
export type HangoutId = Id<'hangout'>

type Empty = Record<string, never>

// ── Whereabouts, in words ─────────────────────────────────────────────────────────────────────

export type WhereState =
  /** In a street of a named area. */
  | 'street'
  /** Inside a public venue. */
  | 'venue'
  /** In their own virtual home. */
  | 'home'
  /** In somebody else's virtual home. */
  | 'visiting'
  /** At a game table, playing or watching. */
  | 'table'
  | 'travelling'
  /** Connected, but not standing anywhere (a window is open, or the scene is loading). */
  | 'online'
  | 'offline'

export interface Whereabouts {
  state: WhereState
  /** A ready sentence fragment: "in Yaba, Lagos", "at Bodija Market in Bodija, Ibadan", "offline". */
  words: string
  /** Area name only. Null when the member does not share where they are. */
  areaLabel: string | null
  venueName: string | null
  /** True when the member switched sharing off: only online or offline is known. */
  hidden: boolean
  /** Whether the viewer's avatar could walk there without a trip. Null when hidden or unknown. */
  sameCity: boolean | null
  /** The viewer may ask for the way to this member (`around.wayToFriend`). */
  canJoin: boolean
  /** When the member was last connected. Only for friends who share where they are. */
  lastSeenAt: Iso | null
}

export interface SocialSettings {
  /** Friends see where my character is, in words. On by default; off shows only online or offline. */
  shareWhereabouts: boolean
  /** Friends may walk to where my character is without asking first. Needs shareWhereabouts. */
  allowJoin: boolean
}
export const DEFAULT_SOCIAL_SETTINGS: SocialSettings = { shareWhereabouts: true, allowJoin: true }

// ── Who is around ─────────────────────────────────────────────────────────────────────────────

export interface FriendPresence {
  member: PublicMember
  where: Whereabouts
  conversationId: ConversationId | null
  /** Unread direct messages from this friend. */
  unread: number
}

/** A member in the viewer's city who chose to be discoverable. Area name only. */
export interface CityMember {
  member: PublicMember
  areaLabel: string | null
  /** A wave between the two that is still waiting, and who sent it. */
  wave: 'none' | 'sent' | 'received'
}

/** A public place in the viewer's city where people are now, or came by in the last day. */
export interface Spot {
  /** Opaque handle. Ask `around.wayToSpot` for the way there. */
  id: string
  kind: 'street' | 'venue'
  name: string
  category: string | null
  areaLabel: string
  /** People there right now whom the viewer could meet (never counts the viewer). */
  now: number
  /** Different people who came by in the last 24 hours (never counts the viewer). */
  today: number
  /** Friends there now who share where they are. */
  friends: PublicMember[]
  /** The viewer is standing in it. */
  here: boolean
}

export interface Around {
  settings: SocialSettings
  discoverable: boolean
  me: Whereabouts
  friends: FriendPresence[]
  city: {
    /** The area name of the viewer's avatar, or null before they have arrived anywhere. */
    label: string | null
    /** Members connected in the viewer's city right now, the viewer not counted. */
    online: number
    /** Those among them who opted into discovery. Empty unless the viewer opted in too. */
    people: CityMember[]
    /** True when the list is withheld because the viewer is not discoverable. */
    listWithheld: boolean
  }
  spots: Spot[]
  /** Other cities with people connected right now, busiest first. Names and counts only. */
  elsewhere: { areaLabel: string; online: number }[]
  /** Members connected anywhere, the viewer not counted. */
  worldOnline: number
  waves: Wave[]
  invites: JoinInvite[]
  /** Open hangouts in the viewer's city: going on now, then coming up, soonest first. */
  hangouts: Hangout[]
  unreadDirect: number
}

// ── Getting there ─────────────────────────────────────────────────────────────────────────────

export type Destination =
  | { kind: 'street'; districtId: DistrictId; areaLabel: string; /** Where to walk to inside the district scene, when the way leads to a person. Null for a public spot. */ meet: Vec2 | null }
  | { kind: 'venue'; districtId: DistrictId; placeId: PlaceId; name: string; areaLabel: string }
  | { kind: 'home'; homeId: HomeId; name: string }
  | { kind: 'table'; matchId: MatchId }

/** How the viewer could get somewhere. Asking for it moves nobody. */
export interface Way {
  /** walk: same city, the App can walk there. door: a home or table, open from anywhere. travel: another city, a trip is needed first. */
  reach: 'walk' | 'door' | 'travel' | 'unavailable'
  /** Present for 'walk' and 'door' only. */
  destination: Destination | null
  areaLabel: string | null
  /** One plain sentence for the interface. */
  text: string
}

// ── Waves ─────────────────────────────────────────────────────────────────────────────────────

export type WaveContext = 'same-room' | 'same-city' | 'community' | 'friend'
export type WaveStatus = 'pending' | 'returned' | 'expired'

/** A wordless hello. It carries no text, so it cannot carry abuse. */
export interface Wave {
  id: WaveId
  from: PublicMember
  to: PublicMember
  context: WaveContext
  /** Why the two could see each other: "You were both at Bodija Market." */
  contextText: string
  status: WaveStatus
  createdAt: Iso
  expiresAt: Iso
  /** The viewer sent it. */
  mine: boolean
}

export const WAVE = {
  /** A wave waits this long for an answer. */
  ttlHours: 24,
  /** After waving at someone, the same sender waits this long before waving at them again. */
  pairCooldownHours: 24,
  /** Two unanswered waves in a row to one person lengthen the wait to this. */
  ignoredCooldownDays: 7,
  /** Waves one member may send in a day. */
  perDay: 20,
} as const

// ── Join me ───────────────────────────────────────────────────────────────────────────────────

export type JoinStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired'

export interface JoinInvite {
  id: JoinInviteId
  from: PublicMember
  to: PublicMember
  /** Where the invitation leads, in words. */
  place: { kind: 'street' | 'venue' | 'home' | 'table'; name: string; areaLabel: string | null }
  note: string
  status: JoinStatus
  createdAt: Iso
  expiresAt: Iso
  answeredAt: Iso | null
  /** The viewer sent it. */
  mine: boolean
  /** For the invited member only: what accepting would take. Null in the sender's view. */
  reach: Way['reach'] | null
}

export const JOIN = {
  /** An invitation to where someone is standing goes stale quickly. */
  hereMinutes: 15,
  homeMinutes: 45,
  noteMax: 120,
  /** Invitations one member may send to the same friend in an hour. */
  perPairPerHour: 4,
} as const

// ── Invite links: bringing someone you already know ───────────────────────────────────────────
//
// The member sends the link themselves, through their own WhatsApp or SMS. The App sends
// nothing. The link carries a random id and a signature — no name, no place, no member id.

export const INVITE_LINK = {
  /** A link works for this long. */
  days: 7,
  /** Links one member may have open at once, and may make in a day. */
  open: 5,
  perDay: 8,
  /** The query parameter the link carries: <App address>/?invite=<token>. */
  param: 'invite',
} as const

export interface InviteLink {
  id: string
  /** The secret part of the address. Only its maker ever gets it back. */
  token: string
  /** Where the maker's character was when the link was made: "Come find me in Yaba, Lagos". */
  areaLabel: string | null
  createdAt: Iso
  expiresAt: Iso
  /** Members who opened it and now exist in the world, as the maker may see them. */
  joined: PublicMember[]
}

/** What someone who opens a link is shown. */
export interface InviteLanding {
  inviter: PublicMember
  areaLabel: string | null
  /**
   * The public place the link was made in (a named area from the gazetteer, the same record a
   * member picks in onboarding), so a new member can start in the same city. Not a position.
   */
  area: CoarseArea | null
  expiresAt: Iso
  /** The viewer made this link themselves. */
  own: boolean
}

// ── Open hangouts: a time and a public place in the game, for anyone in the city ───────────────
//
// A hangout is in the game: characters meet in a venue's room or a street. It is not a real-world
// meetup (those stay between friends, see social.ts). Same care as a meetup: a public place from
// the map, a time at least ten minutes ahead, the place's own clock.

export type HangoutStatus = 'upcoming' | 'now' | 'over' | 'cancelled'

export interface Hangout {
  id: HangoutId
  host: PublicMember
  place: { kind: 'street' | 'venue'; name: string; areaLabel: string | null }
  startsAt: Iso
  /** The place's timezone, so everyone reads the same clock. */
  timezone: string
  note: string
  status: HangoutStatus
  /** Members who said they are coming, the host included. */
  going: number
  /** Friends among them. */
  friendsGoing: PublicMember[]
  iAmGoing: boolean
  /** The viewer is the host. */
  mine: boolean
}

export const HANGOUT = {
  minMinutesAhead: 10,
  maxDaysAhead: 14,
  /** A hangout counts as going on for this long after it starts. */
  lastsMinutes: 120,
  /** People who said they are coming are reminded this long before. */
  remindMinutes: 15,
  noteMax: 120,
  /** Upcoming hangouts one member may host at once. */
  perHost: 2,
} as const

// ── Emotes ────────────────────────────────────────────────────────────────────────────────────

export const EMOTES = ['wave', 'nod', 'clap', 'cheer', 'dance', 'talk'] as const
export type EmoteKind = (typeof EMOTES)[number]

// ── Direct messages ───────────────────────────────────────────────────────────────────────────

export const DIRECT_MAX_LENGTH = 500
export const DIRECT_PAGE = 40
/** Messages kept per conversation. Older ones are dropped. */
export const DIRECT_KEPT = 400

export interface DirectMessage {
  id: string
  conversationId: ConversationId
  /** Position in the conversation, starting at 1. Read and delivered marks are a seq. */
  seq: number
  from: MemberId
  text: string
  at: Iso
  /** Set by the service on a message it wrote for the sender (the creator's welcome). Nothing sent with `direct.send` carries it. */
  automatic?: 'welcome'
}

export interface Conversation {
  id: ConversationId
  peer: PublicMember
  peerWhere: Whereabouts
  last: DirectMessage | null
  /** Messages from the peer the viewer has not read. */
  unread: number
  updatedAt: Iso
  /** The viewer's own read mark. */
  readSeq: number
  /** Highest seq the peer's App has received, and has read. Drives the ticks under the viewer's messages. */
  peerDeliveredSeq: number
  peerReadSeq: number
  /** False once the two are no longer friends (or the creator connection was removed): the history stays readable, nothing new is sent. */
  canSend: boolean
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

export interface DirectOps {
  // Who is around
  'around.get': { in: Empty; out: { around: Around } }
  'around.settings': { in: { settings: SocialSettings }; out: { settings: SocialSettings } }
  /** The App names the public venue the avatar is standing in (the map is loaded on the device). The service checks the avatar is really in that venue's room. */
  'around.place': { in: { name: string; category: string }; out: { recorded: boolean } }
  'around.wayToSpot': { in: { spotId: string }; out: { way: Way } }
  'around.wayToFriend': { in: { memberId: MemberId }; out: { way: Way } }

  // Waves
  'wave.send': { in: { to: MemberId }; out: { wave: Wave; returned: boolean } }
  'wave.back': { in: { waveId: WaveId }; out: { wave: Wave } }
  'wave.dismiss': { in: { waveId: WaveId }; out: { dismissed: true } }

  // Join me
  'join.send': { in: { to: MemberId; place: 'here' | 'home'; note: string }; out: { invite: JoinInvite } }
  'join.get': { in: { inviteId: JoinInviteId }; out: { invite: JoinInvite } }
  /** Accepting returns the way there. The avatar is not moved. */
  'join.respond': { in: { inviteId: JoinInviteId; accept: boolean }; out: { invite: JoinInvite; way: Way | null } }
  'join.cancel': { in: { inviteId: JoinInviteId }; out: { invite: JoinInvite } }

  // Emotes
  'emote.send': { in: { kind: EmoteKind }; out: { reached: number } }

  // Invite links
  'link.create': { in: Empty; out: { link: InviteLink; links: InviteLink[] } }
  'link.mine': { in: Empty; out: { links: InviteLink[] } }
  'link.revoke': { in: { id: string }; out: { links: InviteLink[] } }
  /** Who invited me? Remembers that this member came through the link. */
  'link.open': { in: { token: string }; out: { landing: InviteLanding } }
  /** The one-tap introduction to the member who made the link. */
  'link.hello': { in: { token: string }; out: { state: 'sent' | 'waiting' | 'friends'; inviter: PublicMember } }

  // Open hangouts
  /** At the public place the host's character is standing in. */
  'hangout.create': { in: { startsAt: string; note: string }; out: { hangout: Hangout } }
  'hangout.get': { in: { hangoutId: HangoutId }; out: { hangout: Hangout } }
  'hangout.rsvp': { in: { hangoutId: HangoutId; going: boolean }; out: { hangout: Hangout } }
  'hangout.cancel': { in: { hangoutId: HangoutId }; out: { hangout: Hangout } }
  'hangout.way': { in: { hangoutId: HangoutId }; out: { way: Way } }

  // Direct messages
  'direct.list': { in: Empty; out: { conversations: Conversation[]; unread: number } }
  /** The conversation with a friend, created on first use. */
  'direct.open': { in: { memberId: MemberId }; out: { conversation: Conversation } }
  /** One page, oldest first. `before` is a seq to page backwards from, or null for the newest page. */
  'direct.get': { in: { conversationId: ConversationId; before: number | null }; out: { conversation: Conversation; messages: DirectMessage[]; more: boolean } }
  'direct.send': { in: { conversationId: ConversationId; text: string; clientId: string }; out: { message: DirectMessage; conversation: Conversation } }
  'direct.read': { in: { conversationId: ConversationId; upTo: number }; out: { unread: number } }
  'direct.readAll': { in: Empty; out: { unread: number } }
  /** Report the peer with the recent messages attached for a reviewer. */
  'direct.report': { in: { conversationId: ConversationId; reason: ReportReason; detail: string }; out: { received: true } }
}

// ── Events ────────────────────────────────────────────────────────────────────────────────────

export type DirectEvent =
  | { type: 'direct.message'; message: DirectMessage; conversation: Conversation; unread: number }
  /** To the sender: the peer's App received or read up to these marks. */
  | { type: 'direct.state'; conversationId: ConversationId; peerDeliveredSeq: number; peerReadSeq: number }
  /** The conversation list changed for another reason (a block, a friendship ending or starting). */
  | { type: 'direct.changed'; unread: number }
  | { type: 'wave.received'; wave: Wave }
  | { type: 'wave.returned'; wave: Wave }
  | { type: 'join.changed'; invite: JoinInvite }
  /** A friend connected. Sent at most once every few minutes per friend. */
  | { type: 'friend.online'; member: PublicMember; where: Whereabouts }
  /** Something in `around.get` changed for this member; reload it when it is on screen. */
  | { type: 'around.changed' }
  /**
   * A member in the same room played a gesture. Sent to everyone in that room who can see them.
   * The App plays it on that member's avatar once the engine can (see docs/SOCIAL.md).
   */
  | { type: 'social.emote'; room: RoomKey; memberId: MemberId; kind: EmoteKind; at: Iso }
  /** A hangout the member hosts or is going to changed, or starts soon. */
  | { type: 'hangout.changed'; hangout: Hangout }
