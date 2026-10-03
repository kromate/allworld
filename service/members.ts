// Members: profile, avatar look, the coarse current area, blocks and reports.
import { parseAvatarAppearance } from '../src/shared/appearance.ts'
import type { AreaId, HomeId, Iso, MemberId, ReportId, RoomKey } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { areaIdOf, areaOfDistrict, districtIdOf, parseAreaId, parseDistrictId } from '../src/shared/geo.ts'
import {
  AVATAR_BODIES, AVATAR_HEIGHT, CURRENT_AREA_TTL_DAYS, FACE_LANDMARKS, FACE_TEXTURE_MAX_BYTES, REPORT_REASONS,
  WorldError,
} from '../src/shared/model.ts'
import type {
  AvatarLook, CoarseArea, FaceScan, MemberPreferences, MemberProfile, PublicMember, Relation, ReportReason,
} from '../src/shared/model.ts'
import type { World } from './kernel.ts'
import { bool, empty, hexColor, id, num, obj, oneOf, optStr, str } from './parse.ts'
import type { Raw } from './parse.ts'

/** Why the service connected two members itself. Today only the creator's welcome does. */
export type FriendTag = 'creator'
interface MemberRecord {
  profile: MemberProfile
  blocked: MemberId[]
  /** Friendships both members accepted. Everything that is "for friends" asks this list and no other. */
  friends: MemberId[]
  reviewer: boolean
  /**
   * Friendships the service made, by the other member's id, kept on both members' records so each
   * can list the other. They are listed and can be messaged; nothing that is "for friends" is shared through them.
   */
  tagged?: Record<string, FriendTag>
}
interface ReportRecord { id: ReportId; by: MemberId; about: MemberId; reason: ReportReason; detail: string; room: RoomKey | null; at: Iso }
interface MemberState {
  members: Record<string, MemberRecord>; reports: ReportRecord[]; faces?: Record<string, FaceScan>
  /** The member bound to the creator's verified account. Written by service/creator.ts only. */
  creator?: MemberId
}

const DAY = 86_400_000
const state = (world: World): MemberState => world.slice<MemberState>('members', () => ({ members: {}, reports: [] }))

export const DEFAULT_LOOK: AvatarLook = { body: 'f11', skin: null, outfitHue: 0, height: 1, face: null }
const faces = (world: World): Record<string, FaceScan> => (state(world).faces ??= {})

/** A member's look as `viewer` may see it: the photo face is withheld outside its audience. */
export function lookFor(world: World, viewer: MemberId, target: MemberId): AvatarLook {
  const look = record(world, target).profile.look
  if (!look.face || viewer === target || look.face.audience === 'everyone' || areFriends(world, viewer, target)) return look
  return { ...look, face: null }
}
const DEFAULT_PREFERENCES: MemberPreferences = { language: 'en', units: 'metric', discoverable: false, reducedMotion: false, quality: 'auto', powerMode: 'balanced' }

/** Create the member on first sign-in. Identity comes from the session, never from the request. */
export function ensureMember(world: World, memberId: MemberId, displayName: string, options: { reviewer?: boolean } = {}): MemberRecord {
  const members = state(world).members
  const existing = members[memberId]
  if (existing) {
    // A profile saved before a preference existed gets that preference's default.
    if (existing.profile.preferences.powerMode === undefined) existing.profile.preferences = { ...DEFAULT_PREFERENCES, ...existing.profile.preferences }
    return existing
  }
  const created: MemberRecord = {
    profile: {
      id: memberId, displayName, bio: '', look: structuredClone(DEFAULT_LOOK), preferences: { ...DEFAULT_PREFERENCES },
      currentArea: null, browsing: null, homeId: `h_${memberId.slice(2)}` as HomeId, onboardedAt: null,
      createdAt: iso(world.now()), revision: 1,
    },
    blocked: [], friends: [], reviewer: options.reviewer ?? false,
  }
  members[memberId] = created
  world.touch()
  return created
}

export function record(world: World, memberId: MemberId): MemberRecord {
  const found = state(world).members[memberId]
  if (!found) throw new WorldError('not_found', 'That member was not found.')
  // Looks saved against an earlier character set fall back to the default body.
  if (!(AVATAR_BODIES as readonly string[]).includes(found.profile.look.body)) found.profile.look = { ...DEFAULT_LOOK, face: found.profile.look.face ?? null }
  return found
}

export const exists = (world: World, memberId: MemberId): boolean => memberId in state(world).members
export const allMemberIds = (world: World): MemberId[] => Object.keys(state(world).members) as MemberId[]

export function isBlockedEitherWay(world: World, a: MemberId, b: MemberId): boolean {
  if (a === b) return false
  const members = state(world).members
  return Boolean(members[a]?.blocked.includes(b) || members[b]?.blocked.includes(a))
}

export const areFriends = (world: World, a: MemberId, b: MemberId): boolean => Boolean(state(world).members[a]?.friends.includes(b))

export function addFriendship(world: World, a: MemberId, b: MemberId): void {
  const first = record(world, a), second = record(world, b)
  if (!first.friends.includes(b)) first.friends.push(b)
  if (!second.friends.includes(a)) second.friends.push(a)
  // Accepted by both now: the pair is one friendship, not two, so a service-made one between them goes.
  if (first.tagged) delete first.tagged[b]
  if (second.tagged) delete second.tagged[a]
  world.touch()
}

export function removeFriendship(world: World, a: MemberId, b: MemberId): void {
  const members = state(world).members
  if (members[a]) members[a].friends = members[a].friends.filter(friend => friend !== b)
  if (members[b]) members[b].friends = members[b].friends.filter(friend => friend !== a)
  // A connection the service made ends the same way, and the same listeners hear of it.
  if (members[a]?.tagged) delete members[a].tagged[b]
  if (members[b]?.tagged) delete members[b].tagged[a]
  world.touch()
  for (const hook of unfriendHooks) hook(world, a, b)
}

/**
 * A friendship the service made between two members. Listing a friendship and sharing what is
 * "for friends" are two decisions, and this is only the first: each member's friends list shows
 * the other (`automaticFriendsOf`, marked `automatic` on the card) and the two can message each
 * other (`mayMessage`). `areFriends` and `friendsOf` still mean accepted by both, and every grant
 * of a photo face, a home, whereabouts, a way to someone or a friends-only game asks those, so
 * none of it follows. It ends with `removeFriendship` or a block, like any friendship. Two who
 * are already friends are left as they are.
 */
export function addTaggedFriendship(world: World, a: MemberId, b: MemberId, tag: FriendTag): void {
  if (a === b) throw new WorldError('invalid', 'A member cannot be connected to themselves.')
  const first = record(world, a), second = record(world, b)
  if (first.friends.includes(b)) return
  const mine = (first.tagged ??= {}), theirs = (second.tagged ??= {})
  mine[b] = tag
  theirs[a] = tag
  world.touch()
}
/** The tag on a service-made friendship between the two. Null when there is none. */
export function friendTag(world: World, a: MemberId, b: MemberId): FriendTag | null {
  const members = state(world).members
  return members[a]?.tagged?.[b] ?? members[b]?.tagged?.[a] ?? null
}
/** How many friends a member has: accepted by both, and made by the service. Read from the member's own record. */
export function friendCounts(world: World, memberId: MemberId): { accepted: number; automatic: number } {
  const entry = record(world, memberId)
  let automatic = 0
  for (const other in entry.tagged) if (!entry.friends.includes(other as MemberId)) automatic++
  return { accepted: entry.friends.length, automatic }
}
/** A member's service-made friends, newest first, at most `limit`. The creator has one per member, so a list takes a bound. */
export function automaticFriendsOf(world: World, memberId: MemberId, limit: number): MemberId[] {
  const entry = record(world, memberId)
  const ids = Object.keys(entry.tagged ?? {}) as MemberId[]
  const out: MemberId[] = []
  for (let index = ids.length - 1; index >= 0 && out.length < limit; index--) if (!entry.friends.includes(ids[index]!)) out.push(ids[index]!)
  return out
}
/** Direct messages are between friends, accepted or service-made. Blocks are checked by the caller, as for friends. */
export const mayMessage = (world: World, a: MemberId, b: MemberId): boolean => areFriends(world, a, b) || friendTag(world, a, b) !== null

/** The member bound to the creator's verified account, or null. Read-only: it does not count as a change to the slice. */
export const creatorOf = (world: World): MemberId | null => world.peek<MemberState>('members')?.creator ?? null
/** For service/creator.ts, once it has verified who the creator is. The member must exist, and the binding does not move. */
export function setCreator(world: World, memberId: MemberId): void {
  const data = state(world)
  record(world, memberId)
  if (data.creator && data.creator !== memberId) throw new WorldError('conflict', 'This world already has a creator.')
  if (data.creator === memberId) return
  data.creator = memberId
  world.touch()
}

/** Homes and photo faces are friend-scoped, so they react when a friendship ends. */
const unfriendHooks: ((world: World, a: MemberId, b: MemberId) => void)[] = []
export function onUnfriend(hook: (world: World, a: MemberId, b: MemberId) => void): void { unfriendHooks.push(hook) }

export const friendsOf = (world: World, memberId: MemberId): MemberId[] => [...record(world, memberId).friends]

/** Fresh, confirmed coarse area — or null when unset or stale. */
export function freshArea(world: World, memberId: MemberId): MemberProfile['currentArea'] {
  const area = state(world).members[memberId]?.profile.currentArea
  return area && ms(area.expiresAt) > world.now() ? area : null
}

/** Hook so the social module can report pending introductions without a circular import. */
let introRelation: (world: World, viewer: MemberId, target: MemberId) => Relation | null = () => null
export function setIntroRelation(resolver: typeof introRelation): void { introRelation = resolver }

/** What the two are to each other, for display. 'friend' covers a service-made friendship too; it is not a grant (see `areFriends`). */
export function relation(world: World, viewer: MemberId, target: MemberId): Relation {
  if (viewer === target) return 'self'
  if (areFriends(world, viewer, target) || friendTag(world, viewer, target) !== null) return 'friend'
  return introRelation(world, viewer, target) ?? 'none'
}

/**
 * The projection of a member that another member may see. Area label is included only when the
 * target opted into discovery and their area is fresh, or the viewer is a friend. Never a cell id.
 */
export function publicMember(world: World, viewer: MemberId, target: MemberId): PublicMember {
  if (isBlockedEitherWay(world, viewer, target)) throw new WorldError('not_found', 'That member was not found.')
  const { profile } = record(world, target)
  const rel = relation(world, viewer, target)
  const area = freshArea(world, target)
  // The area is for the member, for friends they accepted, and for anyone once they chose to be discoverable.
  const accepted = areFriends(world, viewer, target)
  const mayShowArea = rel === 'self' || accepted || profile.preferences.discoverable
  const tag = accepted ? null : friendTag(world, viewer, target)
  return {
    id: profile.id, displayName: profile.displayName, bio: profile.bio, look: lookFor(world, viewer, target),
    areaLabel: area && mayShowArea ? area.label : null, relation: rel, online: world.isOnline(target),
    ...(tag ? { automatic: tag } : {}),
    ...(state(world).creator === target ? { verified: 'creator' as const } : {}),
  }
}

/** Same as publicMember, but returns null instead of throwing when the pair is blocked. */
export function tryPublicMember(world: World, viewer: MemberId, target: MemberId): PublicMember | null {
  if (!exists(world, target) || isBlockedEitherWay(world, viewer, target)) return null
  return publicMember(world, viewer, target)
}

// ── Input parsing ──

export function parseLook(value: unknown): AvatarLook {
  const raw = obj(value, 'look')
  return {
    body: oneOf(raw, 'body', AVATAR_BODIES),
    skin: raw.skin === null || raw.skin === undefined ? null : hexColor(raw.skin, 'look.skin'),
    outfitHue: num(raw, 'outfitHue', { integer: true, min: -180, max: 180 }),
    height: num(raw, 'height', { min: AVATAR_HEIGHT.min, max: AVATAR_HEIGHT.max }),
    outfit: raw.outfit === null || raw.outfit === undefined ? null : str(raw, 'outfit', { min: 1, max: 40 }),
    // Out-of-range numbers are pulled back inside their bounds; unknown choices fall back to automatic.
    ...(raw.appearance === null || raw.appearance === undefined ? {} : { appearance: parseAvatarAppearance(raw.appearance) }),
    // The face pointer is owned by member.setFace / member.clearFace, never by a profile save.
    face: null,
  }
}

function parseFaceScan(value: unknown): FaceScan {
  const raw = obj(value, 'scan')
  const texture = str(raw, 'texture', { min: 30, max: FACE_TEXTURE_MAX_BYTES * 1.4, trim: false })
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(texture)) throw new WorldError('invalid', 'The face picture must be a JPEG.')
  if (texture.length * 0.75 > FACE_TEXTURE_MAX_BYTES) throw new WorldError('invalid', 'The face picture is too large.')
  const mesh = str(raw, 'mesh', { min: 8, max: 12_000, trim: false })
  if (!/^[A-Za-z0-9+/=]+$/.test(mesh) || Buffer.from(mesh, 'base64').length !== FACE_LANDMARKS * 6) throw new WorldError('invalid', 'The face shape data is not valid.')
  const views: { left?: string; right?: string } = {}
  if (raw.views !== undefined && raw.views !== null) {
    const sides = obj(raw.views, 'scan.views')
    for (const side of ['left', 'right'] as const) {
      if (sides[side] === undefined || sides[side] === null) continue
      const turned = str(sides, side, { min: 8, max: 12_000, trim: false })
      if (!/^[A-Za-z0-9+/=]+$/.test(turned) || Buffer.from(turned, 'base64').length !== FACE_LANDMARKS * 6) throw new WorldError('invalid', 'The side view shape data is not valid.')
      views[side] = turned
    }
  }
  return views.left || views.right ? { texture, mesh, views } : { texture, mesh }
}

export function parseCoarseArea(value: unknown): CoarseArea {
  const raw = obj(value, 'area')
  const anchorRaw = obj(raw.anchor, 'area.anchor')
  const anchor = { lat: num(anchorRaw, 'lat', { min: -85, max: 85 }), lon: num(anchorRaw, 'lon', { min: -180, max: 180 }) }
  const areaId = str(raw, 'areaId', { max: 40 }) as AreaId
  if (!parseAreaId(areaId)) throw new WorldError('invalid', 'area.areaId is not a valid area')
  // The cell must be the one the public anchor falls in, so a client cannot claim an unrelated cell.
  if (areaIdOf(anchor) !== areaId) throw new WorldError('invalid', 'area.anchor does not belong to area.areaId')
  const arrivalDistrict = str(raw, 'arrivalDistrict', { max: 40 }) as CoarseArea['arrivalDistrict']
  if (!parseDistrictId(arrivalDistrict) || areaOfDistrict(arrivalDistrict) !== areaId) throw new WorldError('invalid', 'area.arrivalDistrict is outside the area')
  if (districtIdOf(anchor) !== arrivalDistrict) throw new WorldError('invalid', 'area.arrivalDistrict does not contain the anchor')
  const timezone = str(raw, 'timezone', { max: 64, min: 1 })
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw new WorldError('invalid', 'area.timezone is not a known timezone') }
  // Optional and short: the first-level administrative area ("Lagos", "Texas"). Areas saved before it existed have none.
  const region = optStr(raw, 'region', { max: 60 }) || null
  return {
    areaId, label: str(raw, 'label', { min: 1, max: 120 }), countryCode: str(raw, 'countryCode', { max: 2 }).toUpperCase(),
    timezone, anchor, arrivalDistrict, ...(region ? { region } : {}),
  }
}

function parsePreferences(value: unknown): MemberPreferences {
  const raw: Raw = obj(value, 'preferences')
  return {
    language: str(raw, 'language', { min: 2, max: 12 }), units: oneOf(raw, 'units', ['metric', 'imperial'] as const),
    discoverable: bool(raw, 'discoverable'), reducedMotion: bool(raw, 'reducedMotion'),
    quality: oneOf(raw, 'quality', ['auto', 'low', 'medium', 'high'] as const),
    powerMode: raw.powerMode === undefined ? 'balanced' : oneOf(raw, 'powerMode', ['battery', 'balanced', 'quality'] as const),
  }
}

// ── Operations ──

export function registerMembers(world: World): void {
  const blockedList = (viewer: MemberId): PublicMember[] => record(world, viewer).blocked
    .filter(target => exists(world, target))
    .map(target => {
      const { profile } = record(world, target)
      return { id: profile.id, displayName: profile.displayName, bio: '', look: { ...profile.look, face: null }, areaLabel: null, relation: 'none' as const, online: false }
    })
  const bump = (memberId: MemberId): MemberProfile => {
    const entry = record(world, memberId)
    entry.profile.revision++
    world.touch()
    return entry.profile
  }

  world.register('member.me', empty, ctx => {
    const entry = record(world, ctx.memberId)
    return { profile: entry.profile, blocked: blockedList(ctx.memberId), reviewer: entry.reviewer }
  })

  world.register('member.saveProfile', value => {
    const raw = obj(value)
    return {
      displayName: str(raw, 'displayName', { min: 2, max: 32 }), bio: str(raw, 'bio', { max: 160 }),
      clearFace: raw.clearFace === undefined ? false : bool(raw, 'clearFace'),
      look: parseLook(raw.look), expectedRevision: num(raw, 'expectedRevision', { integer: true, min: 0 }),
    }
  }, (ctx, input) => {
    const entry = record(world, ctx.memberId)
    if (input.expectedRevision !== entry.profile.revision) throw new WorldError('conflict', 'Your profile changed on another device. Reload it and try again.')
    entry.profile.displayName = input.displayName
    entry.profile.bio = input.bio
    entry.profile.look = { ...input.look, face: input.clearFace ? null : entry.profile.look.face }
    if (input.clearFace) delete faces(world)[ctx.memberId]
    for (const hook of lookHooks) hook(world, ctx.memberId)
    return { profile: bump(ctx.memberId) }
  })

  const audience = (raw: Raw) => oneOf(raw, 'audience', ['friends', 'everyone'] as const)

  world.register('member.setFace', value => {
    const raw = obj(value)
    return { scan: parseFaceScan(raw.scan), audience: audience(raw), look: parseLook(raw.look), expectedRevision: num(raw, 'expectedRevision', { integer: true, min: 0 }) }
  }, (ctx, input) => {
    const entry = record(world, ctx.memberId)
    // Everything is refused before anything is kept, so a photo never lands on a look it was not chosen with.
    if (input.expectedRevision !== entry.profile.revision) throw new WorldError('conflict', 'Your profile changed on another device. The photo was not kept. Reload it and try again.')
    world.limit(`face:${ctx.memberId}`, 12, 3_600_000)
    faces(world)[ctx.memberId] = input.scan
    entry.profile.look = { ...input.look, face: { version: entry.profile.revision + 1, audience: input.audience } }
    for (const hook of lookHooks) hook(world, ctx.memberId)
    return { profile: bump(ctx.memberId) }
  }, { cost: 4 })

  world.register('member.setFaceAudience', value => ({ audience: audience(obj(value)) }), (ctx, input) => {
    const entry = record(world, ctx.memberId)
    if (!entry.profile.look.face) throw new WorldError('conflict', 'Add a photo face first.')
    entry.profile.look = { ...entry.profile.look, face: { ...entry.profile.look.face, audience: input.audience } }
    for (const hook of lookHooks) hook(world, ctx.memberId)
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.clearFace', empty, ctx => {
    const entry = record(world, ctx.memberId)
    delete faces(world)[ctx.memberId]
    entry.profile.look = { ...entry.profile.look, face: null }
    for (const hook of lookHooks) hook(world, ctx.memberId)
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.face', value => {
    const raw = obj(value)
    return { memberId: id<MemberId>(raw, 'memberId', 'm'), version: num(raw, 'version', { integer: true, min: 0 }) }
  }, (ctx, input) => {
    // lookFor applies blocks (via publicMember) and the audience rule; outsiders get "not found".
    publicMember(world, ctx.memberId, input.memberId)
    const face = lookFor(world, ctx.memberId, input.memberId).face
    const scan = face && face.version === input.version ? faces(world)[input.memberId] : undefined
    if (!scan) throw new WorldError('not_found', 'That member has no photo face you can see.')
    return { scan }
  })

  world.register('member.savePreferences', value => ({ preferences: parsePreferences(obj(value).preferences) }), (ctx, input) => {
    record(world, ctx.memberId).profile.preferences = input.preferences
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.setCurrentArea', value => {
    const raw = obj(value)
    return { area: parseCoarseArea(raw.area), source: oneOf(raw, 'source', ['manual', 'device-suggested'] as const) }
  }, (ctx, input) => {
    record(world, ctx.memberId).profile.currentArea = {
      ...input.area, source: input.source, confirmedAt: iso(ctx.now), expiresAt: iso(ctx.now + CURRENT_AREA_TTL_DAYS * DAY),
    }
    areaRules.currentAreaSet(world, ctx.memberId, input.area)
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.clearCurrentArea', empty, ctx => {
    record(world, ctx.memberId).profile.currentArea = null
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.setBrowsing', value => {
    const raw = obj(value)
    return { area: raw.area === null || raw.area === undefined ? null : parseCoarseArea(raw.area) }
  }, (ctx, input) => {
    areaRules.relocate(world, ctx.memberId, input.area)
    record(world, ctx.memberId).profile.browsing = input.area
    return { profile: bump(ctx.memberId) }
  })

  world.register('member.completeOnboarding', empty, ctx => {
    const entry = record(world, ctx.memberId)
    const first = entry.profile.onboardedAt === null
    entry.profile.onboardedAt ??= iso(ctx.now)
    const profile = bump(ctx.memberId)
    // Told once per member. A listener that fails is logged and does not undo the onboarding.
    if (first) for (const hook of onboardedHooks) { try { hook(world, ctx.memberId) } catch (error) { console.error('[members] an onboarding listener failed', error) } }
    return { profile }
  })

  world.register('member.block', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    if (input.memberId === ctx.memberId) throw new WorldError('invalid', 'You cannot block yourself.')
    if (!exists(world, input.memberId)) throw new WorldError('not_found', 'That member was not found.')
    const entry = record(world, ctx.memberId)
    if (!entry.blocked.includes(input.memberId)) entry.blocked.push(input.memberId)
    removeFriendship(world, ctx.memberId, input.memberId)
    for (const hook of blockHooks) hook(world, ctx.memberId, input.memberId)
    world.touch()
    return { blocked: blockedList(ctx.memberId) }
  })

  world.register('member.unblock', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    const entry = record(world, ctx.memberId)
    entry.blocked = entry.blocked.filter(target => target !== input.memberId)
    world.touch()
    return { blocked: blockedList(ctx.memberId) }
  })

  world.register('member.report', value => {
    const raw = obj(value)
    return {
      memberId: id<MemberId>(raw, 'memberId', 'm'), reason: oneOf(raw, 'reason', REPORT_REASONS),
      detail: str(raw, 'detail', { max: 500 }), room: optStr(raw, 'room', { max: 120 }) as RoomKey | null,
    }
  }, (ctx, input) => {
    world.limit(`report:${ctx.memberId}`, 5, 600_000)
    if (!exists(world, input.memberId)) throw new WorldError('not_found', 'That member was not found.')
    state(world).reports.push({ id: newId<ReportId>('rp'), by: ctx.memberId, about: input.memberId, reason: input.reason, detail: input.detail, room: input.room, at: iso(ctx.now) })
    world.touch()
    return { received: true as const }
  })

  world.register('member.public', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => ({
    member: publicMember(world, ctx.memberId, input.memberId),
  }))
}

/**
 * The travel module owns where an avatar may be. It vets a requested move (throwing when a trip
 * or documents are needed) and is told when a member confirms their current area.
 */
export interface AreaRules {
  relocate(world: World, memberId: MemberId, area: CoarseArea | null): void
  currentAreaSet(world: World, memberId: MemberId, area: CoarseArea): void
}
let areaRules: AreaRules = { relocate: () => undefined, currentAreaSet: () => undefined }
export function setAreaRules(rules: AreaRules): void { areaRules = rules }

/** Told the first time a member completes onboarding, inside that operation. */
const onboardedHooks: ((world: World, memberId: MemberId) => void)[] = []
export function onOnboarded(hook: (world: World, memberId: MemberId) => void): void { onboardedHooks.push(hook) }

/** Rooms re-announce a member whose look changed. */
const lookHooks: ((world: World, memberId: MemberId) => void)[] = []
export function onLookChange(hook: (world: World, memberId: MemberId) => void): void { lookHooks.push(hook) }

/** Other modules clean up after a block: drop pending intros, leave shared voice, and so on. */
const blockHooks: ((world: World, blocker: MemberId, blocked: MemberId) => void)[] = []
export function onBlock(hook: (world: World, blocker: MemberId, blocked: MemberId) => void): void { blockHooks.push(hook) }

export const reportCount = (world: World): number => state(world).reports.length
