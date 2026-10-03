// Core domain records: members, areas, rooms, presence and chat.
import type { AvatarAppearance } from './appearance.ts'
import type { AreaId, DistrictId, HomeId, Iso, MatchId, MemberId, PlaceId, RoomKey, VehicleId } from './ids.ts'
import type { LatLon, Vec2 } from './geo.ts'

// ── Avatar ────────────────────────────────────────────────────────────────────────────────────

/** The cast a member chooses from. Ids match the packs in public/avatars. */
export const AVATAR_BODIES = ['f01', 'f03', 'f06', 'f08', 'f11', 'f12', 'f17', 'm01', 'm04', 'm08', 'm10', 'm12', 'm15', 'm18'] as const
export type AvatarBody = (typeof AVATAR_BODIES)[number]
export const AVATAR_HEIGHT = { min: 0.92, max: 1.08 } as const

export type FaceAudience = 'friends' | 'everyone'

/**
 * Pointer to a face the member made from their own photo. The scan itself is fetched separately
 * (member.face) so presence stays small and the service can refuse viewers outside the audience.
 */
export interface FaceRef { version: number; audience: FaceAudience }

/**
 * Photo texture and landmarks sampled on the member's device for an approximate face projection.
 * Only the cropped face region is kept; the original photo is never uploaded.
 */
export interface FaceScan {
  /** JPEG data URL of the face region, at most FACE_TEXTURE_SIZE pixels square. */
  texture: string
  /** FACE_LANDMARKS points as base64 little-endian Int16 triples in face-local units. */
  mesh: string
  /** Optional landmark meshes from a guided turn to each side, same encoding. Shapes only: side pictures are never kept. */
  views?: { left?: string; right?: string }
}
export const FACE_LANDMARKS = 468
/** Largest crop accepted. Crops saved at the earlier 256 px size remain valid. */
export const FACE_TEXTURE_SIZE = 512
export const FACE_TEXTURE_MAX_BYTES = 90_000

/** Chosen by the member. Nothing here is derived from where they are. */
export interface AvatarLook {
  body: AvatarBody
  /** Skin tone as #rrggbb, or null to keep the model's own. */
  skin: string | null
  /** Clothing hue turn in degrees, −180 to 180. 0 keeps the original colours. */
  outfitHue: number
  /** Height multiplier within AVATAR_HEIGHT. */
  height: number
  /** Outfit id from the wardrobe (src/world/wardrobe.ts), or null/absent for the model's own clothes. */
  outfit?: string | null
  /** The member's own corrections to face shape, hair, beard and build. Absent means untouched. */
  appearance?: AvatarAppearance | null
  /** Present when the member uses a photo face and the viewer is inside its audience. */
  face: FaceRef | null
}

// ── Areas ─────────────────────────────────────────────────────────────────────────────────────

export interface CoarseArea {
  areaId: AreaId
  /** Public gazetteer name, for example "Bodija, Ibadan". */
  label: string
  countryCode: string
  timezone: string
  /** Centre of the named public place, never a device reading. */
  anchor: LatLon
  /** District that holds the public arrival point. */
  arrivalDistrict: DistrictId
  /**
   * First-level administrative area from the public gazetteer: "Lagos", "Oyo", "England", "Texas".
   * Absent or null on areas saved before it existed, and where the gazetteer names none.
   */
  region?: string | null
}

export type AreaSource = 'manual' | 'device-suggested'

/** The coarse physical area a member says they are in. Self-reported unless device-suggested. */
export interface CurrentArea extends CoarseArea {
  source: AreaSource
  confirmedAt: Iso
  /** After this the area is stale: the member drops out of nearby discovery until they reconfirm. */
  expiresAt: Iso
}

/** How long a confirmed current area counts as fresh. */
export const CURRENT_AREA_TTL_DAYS = 14

export interface MemberPreferences {
  language: string
  units: 'metric' | 'imperial'
  /** Appear to members in the same or neighbouring area. Off by default. */
  discoverable: boolean
  reducedMotion: boolean
  quality: 'auto' | 'low' | 'medium' | 'high'
  /** How hard the device may work: frame rate, sharpness and shadows. */
  powerMode: 'battery' | 'balanced' | 'quality'
}

export interface MemberProfile {
  id: MemberId
  displayName: string
  bio: string
  look: AvatarLook
  preferences: MemberPreferences
  currentArea: CurrentArea | null
  /** Last district the member browsed. Asserts nothing about physical presence. */
  browsing: CoarseArea | null
  homeId: HomeId
  onboardedAt: Iso | null
  createdAt: Iso
  revision: number
}

/** What another member may see. No coordinates, no area cell, no expiry timestamps. */
export interface PublicMember {
  id: MemberId
  displayName: string
  bio: string
  look: AvatarLook
  /** Present only when the viewer is allowed to see it (discoverable + fresh, or a friend). */
  areaLabel: string | null
  relation: Relation
  online: boolean
  /**
   * Present when `relation` is 'friend' because the service made the friendship (the creator's
   * welcome) and the two did not both accept it. Such a friend is in the friends list, can be
   * messaged, removed and blocked. What is shared with friends is not shared through it: no
   * friends-only photo face, home, area or whereabouts, no way to them, no join or meetup
   * invitation, no friend challenge. A window offers those only when this is absent.
   */
  automatic?: 'creator'
  /** Set by the service for the one member bound to the creator's verified account. A name or a bio cannot earn it. */
  verified?: 'creator'
}

export type Relation = 'self' | 'friend' | 'intro-sent' | 'intro-received' | 'none'

// ── Rooms, presence, proximity ────────────────────────────────────────────────────────────────

export type RoomRef =
  | { kind: 'district'; districtId: DistrictId }
  | { kind: 'venue'; districtId: DistrictId; placeId: PlaceId }
  | { kind: 'home'; homeId: HomeId }
  | { kind: 'table'; matchId: MatchId }

export function roomKey(ref: RoomRef): RoomKey {
  switch (ref.kind) {
    case 'district': return `district|${ref.districtId}` as RoomKey
    case 'venue': return `venue|${ref.districtId}|${ref.placeId}` as RoomKey
    case 'home': return `home|${ref.homeId}` as RoomKey
    case 'table': return `table|${ref.matchId}` as RoomKey
  }
}

/** Text and voice reach avatars within this many metres in the same room. */
export const PROXIMITY_RADIUS = { district: 14, venue: 9, home: 30, table: 30 } as const
/** A member only receives movement for avatars within this distance (district rooms). */
export const INTEREST_RADIUS = 160
/** Rooms split into numbered instances beyond this many members. */
export const ROOM_CAPACITY = { district: 40, venue: 24, home: 12, table: 30 } as const
/** Fastest plausible avatar speed in metres per second, with slack for network jitter. */
export const MAX_SPEED = 9

export interface PresenceMember {
  id: MemberId
  displayName: string
  look: AvatarLook
  pos: Vec2
  heading: number
  moving: boolean
  relation: Relation
  automatic?: PublicMember['automatic']
  verified?: PublicMember['verified']
  voice: 'off' | 'live' | 'muted'
  /** 'current-area' when this district is inside the member's confirmed area and they opted in. */
  context: 'current-area' | 'exploring'
  /**
   * Present while the member sits in a vehicle. `pos` is then the seat's place in the room, kept by
   * the service for range rules; the scene puts the avatar in the seat instead of standing it there.
   * `seatId` is a SeatId from vehicles.ts.
   */
  transport?: { vehicleId: VehicleId; seatId: string }
}

export interface RoomSnapshot {
  room: RoomKey
  ref: RoomRef
  instance: number
  capacity: number
  members: PresenceMember[]
}

export interface ChatMessage {
  id: string
  room: RoomKey
  from: MemberId
  fromName: string
  text: string
  at: Iso
  /** How many members were in range and received it, excluding the sender. */
  audience: number
}

export const CHAT_MAX_LENGTH = 280

export const REPORT_REASONS = ['harassment', 'spam', 'impersonation', 'unsafe-meetup', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

export const ERROR_CODES = ['unauthorized', 'forbidden', 'not_found', 'invalid', 'conflict', 'rate_limited', 'expired', 'unavailable'] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export class WorldError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'WorldError'
  }
}
