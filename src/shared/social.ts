// Introductions, friends, communities, public meetups and virtual homes.
import type { CommunityId, DistrictId, HomeId, IntroId, Iso, MeetupId, MemberId, PlaceId, PostId } from './ids.ts'
import type { PublicMember } from './model.ts'
import type { HomeBuilding } from './homes.ts'

// ── Introductions and friends ─────────────────────────────────────────────────────────────────

export type IntroStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired'

/** A friendship only exists after the recipient accepts. */
export interface Introduction {
  id: IntroId
  from: PublicMember
  to: PublicMember
  note: string
  status: IntroStatus
  createdAt: Iso
  expiresAt: Iso
  decidedAt: Iso | null
}

export const INTRO_TTL_DAYS = 14
export const INTRO_NOTE_MAX = 200

export interface NearbyMember extends PublicMember {
  /** Why this member is listed. Never a distance. */
  reason: 'same-area' | 'neighbouring-area' | 'shared-community'
  sharedCommunities: string[]
}

// ── Communities ───────────────────────────────────────────────────────────────────────────────

export type CommunityRole = 'owner' | 'moderator' | 'member'
export type CommunityVisibility = 'public' | 'invite-only'

export interface CommunitySummary {
  id: CommunityId
  name: string
  about: string
  topic: string
  /** Public label only, for example "Ibadan" or "Global". */
  areaLabel: string
  visibility: CommunityVisibility
  memberCount: number
  myRole: CommunityRole | null
  createdAt: Iso
}

export interface CommunityMember { member: PublicMember; role: CommunityRole; joinedAt: Iso }

export interface CommunityPost {
  id: PostId
  communityId: CommunityId
  author: PublicMember
  text: string
  at: Iso
  /** Set when a moderator removed the post. The text is then withheld. */
  removed: boolean
}

export interface CommunityDetail extends CommunitySummary {
  members: CommunityMember[]
  posts: CommunityPost[]
}

export const COMMUNITY_TOPICS = ['neighbours', 'games', 'makers', 'food', 'sport', 'music', 'work', 'study', 'families', 'other'] as const
export type CommunityTopic = (typeof COMMUNITY_TOPICS)[number]

// ── Public meetups ────────────────────────────────────────────────────────────────────────────

/** A public place from the map. Only public venues can be meetup destinations. */
export interface PublicVenue {
  placeId: PlaceId
  districtId: DistrictId
  name: string
  category: string
  /** Branch or entrance note the proposer typed, for example "Ring Road branch, main gate". */
  branch: string
}

export type MeetupStatus = 'proposed' | 'agreed' | 'cancelled' | 'past'
export type MeetupAnswer = 'invited' | 'accepted' | 'declined'

export interface MeetupParticipant { member: PublicMember; answer: MeetupAnswer; answeredAt: Iso | null }

export interface Meetup {
  id: MeetupId
  organiser: PublicMember
  venue: PublicVenue
  /** Start instant plus the venue's timezone so every participant reads the same local time. */
  startsAt: Iso
  timezone: string
  note: string
  status: MeetupStatus
  /** Bumped on every revision. Answers given to an older revision are reset to "invited". */
  revision: number
  participants: MeetupParticipant[]
  createdAt: Iso
  updatedAt: Iso
}

// ── Virtual homes ─────────────────────────────────────────────────────────────────────────────

export type VisitPolicy = 'private' | 'friends' | 'public'

export interface PlacedItem {
  /** Stable within one home. */
  key: string
  /** Furniture model name from the furniture pack. */
  model: string
  /** Cell position on the room grid (0.5 m steps) and quarter-turn rotation. */
  x: number
  z: number
  turns: 0 | 1 | 2 | 3
  /** Catalog link, when the piece represents a real product variant. Placement is not a purchase. */
  productId: string | null
  variantId: string | null
  /** Material colour overrides chosen through a variant, keyed by material name. */
  tints: Record<string, string>
}

export interface HomeLayout {
  width: number
  depth: number
  floor: string
  wall: string
  items: PlacedItem[]
}

export interface Home {
  id: HomeId
  owner: PublicMember
  name: string
  /** Fictional district the home sits in. Independent of the owner's current area. */
  districtLabel: string
  policy: VisitPolicy
  /** The main room's size and colours, and every placed piece in every room. */
  layout: HomeLayout
  /** Rises with every saved layout and every change to the rooms. */
  revision: number
  updatedAt: Iso
  /** The kind of house, its rooms and doors, and where it stands (homes.ts). */
  building: HomeBuilding
}

export const HOME_ITEM_LIMIT = 80
export const HOME_SIZE = { minWidth: 8, maxWidth: 16, minDepth: 8, maxDepth: 16 } as const
