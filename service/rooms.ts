// Rooms: presence, movement, proximity text and voice signalling.
//
// Audience rule for text and voice: same room instance, within PROXIMITY_RADIUS of the sender's
// service-tracked virtual position, and not blocked in either direction. Physical location is
// never an input. Presence lives in memory only; a restart empties every room.
//
// Nothing here is city-wide. A room is split into instances of at most ROOM_CAPACITY members, a
// member is in one instance at a time, and inside a district instance a member is only told
// about avatars within INTEREST_RADIUS. Every loop below is over one instance.
//
// Movement is not sent the moment it arrives. A move updates the avatar's position at once (so
// chat and voice range are always judged on the latest position) and marks it as moved; ten
// times a second each instance sends every member one write holding what changed around them.
// That turns "one socket write per mover per watcher" into "one socket write per watcher".
import type { DistrictId, HomeId, MatchId, MemberId, PlaceId, RoomKey } from '../src/shared/ids.ts'
import { iso, randomToken } from '../src/shared/ids.ts'
import { DISTRICT_HALF_SPAN_LIMIT, areaOfDistrict, distance, parseDistrictId } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { FootObstacleGrid, moveFoot, PERSON_RADIUS } from '../src/shared/worldCollision.ts'
import {
  CHAT_MAX_LENGTH, INTEREST_RADIUS, MAX_SPEED, PROXIMITY_RADIUS, ROOM_CAPACITY, WorldError, roomKey,
} from '../src/shared/model.ts'
import type { ChatMessage, PresenceMember, RoomRef, RoomSnapshot } from '../src/shared/model.ts'
import type { ServerEvent } from '../src/shared/protocol.ts'
import { STEP_PHASES } from './kernel.ts'
import type { MovementStep, World } from './kernel.ts'
import { creatorOf, friendTag, freshArea, lookFor, onBlock, onLookChange, record, relation } from './members.ts'
import { bool, empty, num, obj, oneOf, str } from './parse.ts'

type MemberRecord = ReturnType<typeof record>

/** How movement is paced. Changed only at start-up, from the environment (configureMovement). */
export const MOVEMENT = {
  /** Avatars this close are updated every step. */
  nearRadius: 40,
  /** Avatars further away (still inside INTEREST_RADIUS) are updated every this-many steps. 1 switches the saving off. */
  farEvery: 3,
}

/** Each room is sent out this often, in milliseconds. */
export const STEP_MS = 100

/** Apply the movement settings from the environment (start-up only). */
export function configureMovement(): void {
  const farEvery = Number(process.env.WORLD_FAR_EVERY)
  if (Number.isInteger(farEvery) && farEvery >= 1 && farEvery <= 10) MOVEMENT.farEvery = farEvery
  const nearRadius = Number(process.env.WORLD_NEAR_RADIUS)
  if (Number.isFinite(nearRadius) && nearRadius > 0) MOVEMENT.nearRadius = nearRadius
}

interface Occupant {
  memberId: MemberId
  /** The member's record, held so a visibility check is two array reads rather than two lookups. */
  record: MemberRecord
  pos: Vec2
  heading: number
  moving: boolean
  movedAt: number
  voice: 'off' | 'live' | 'muted'
  voicePeers: MemberId[]
  /** Who this member has been told is here. Join, leave and move are all decided against it. */
  sees: Set<Occupant>
  /** Moved since the last step. */
  moved: boolean
  /** Moved since far-away watchers were last told. */
  movedFar: boolean
  /** Which steps this avatar's far-away watchers are updated on. */
  slot: number
  /** Movement was held back because the socket was not keeping up; resend positions when it is. */
  lagging: boolean
  stepIndex: number
}
interface Instance {
  id: string
  key: RoomKey
  ref: RoomRef
  number: number
  occupants: Map<MemberId, Occupant>
  footGrid: FootObstacleGrid<MemberId>
  movers: Occupant[]
  voiceUsers: Set<Occupant>
  voiceStale: boolean
  steps: number
  slots: number
  /** Which tenth of the step interval this instance is sent out in. */
  phase: number
  /** Places held for members the service is about to bring in together (a vehicle crossing into this room). */
  reserved: number
}
interface RoomRuntime {
  instances: Map<string, Instance>
  byKey: Map<RoomKey, Instance[]>
  where: Map<MemberId, Instance>
  /** Instances with movement to send or a watcher to catch up. Steps only visit these. */
  active: Set<Instance>
  /** Messages a member actually received, kept briefly so a reconnect does not lose them. */
  received: Map<MemberId, { room: RoomKey; messages: ChatMessage[] }>
  heldBack: number
  created: number
}

const runtimes = new WeakMap<World, RoomRuntime>()
const runtime = (world: World): RoomRuntime => {
  let found = runtimes.get(world)
  if (!found) { found = { instances: new Map(), byKey: new Map(), where: new Map(), active: new Set(), received: new Map(), heldBack: 0, created: 0 }; runtimes.set(world, found) }
  return found
}

/** Other modules decide who may enter homes and game tables. */
type Guard = (world: World, memberId: MemberId, ref: RoomRef) => void
const guards: { home: Guard; table: Guard; street: Guard } = {
  home: () => { throw new WorldError('unavailable', 'Homes are not available.') },
  table: () => { throw new WorldError('unavailable', 'Tables are not available.') },
  // Districts and venues: the travel module decides whether the avatar can be there.
  street: () => undefined,
}
export function setRoomGuard(kind: 'home' | 'table' | 'street', guard: Guard): void { guards[kind] = guard }

/**
 * Other modules hear when a member's room actually changes: once on entering a room they were
 * not in, once on leaving it (by walking out, disconnecting, travelling or being shown out).
 * Entering the room a member is already in — a reconnect, a refresh — fires neither.
 */
type RoomListener = (world: World, memberId: MemberId, ref: RoomRef, now: number) => void
const enterListeners: RoomListener[] = []
const leaveListeners: RoomListener[] = []
export function onRoomEnter(listener: RoomListener): void { enterListeners.push(listener) }
export function onRoomLeave(listener: RoomListener): void { leaveListeners.push(listener) }
function tell(listeners: RoomListener[], world: World, memberId: MemberId, ref: RoomRef): void {
  if (listeners.length === 0) return
  const now = world.now()
  for (const listener of listeners) { try { listener(world, memberId, ref, now) } catch (error) { console.error('[world] a room listener failed', error) } }
}

/**
 * A member the service itself is carrying (seated in a vehicle) is not moved by their own App.
 * The module that carries them says so here, with the sentence to show; `room.move`, `room.enter`
 * and a travel booking ask before doing anything.
 */
type Hold = (world: World, memberId: MemberId) => string | null
let occupancyHold: Hold = () => null
export function setOccupancyHold(hold: Hold): void { occupancyHold = hold }
export const heldReason = (world: World, memberId: MemberId): string | null => occupancyHold(world, memberId)
/** What a member is riding in, for their presence record. */
let presenceTransport: (world: World, memberId: MemberId) => PresenceMember['transport'] = () => undefined
export function setPresenceTransport(resolver: typeof presenceTransport): void { presenceTransport = resolver }

/** Existing shared geometry owners install their authoritative foot rule; no geometry comes from a client. */
let footMovementGuard: (world: World, memberId: MemberId, place: { ref: RoomRef; key: RoomKey; instance: number }, from: Vec2, to: Vec2) => boolean = () => true
export function setFootMovementGuard(guard: typeof footMovementGuard): void { footMovementGuard = guard }

// ── For homes (unit 058): the four hooks this file lacked ─────────────────────────────────────

/**
 * A further rule for a step on foot, asked beside the single guard above. Any rule may refuse.
 * Homes add theirs here: the buildings that stand in the street. No geometry comes from a client.
 */
type FootRule = (world: World, memberId: MemberId, place: { ref: RoomRef; key: RoomKey; instance: number }, from: Vec2, to: Vec2) => boolean
const footRules: FootRule[] = []
export function addFootRule(rule: FootRule): void { footRules.push(rule) }

/**
 * Asked of every `room.enter` after the room's own guard, with what the request asks for. A gate
 * throws to refuse. Homes use it: a member whose stay in a home is open leaves by its door, and
 * nobody arrives inside a building.
 */
type EnterGate = (world: World, memberId: MemberId, input: { ref: RoomRef; pos: Vec2; heading: number }) => void
const enterGates: EnterGate[] = []
export function addEnterGate(gate: EnterGate): void { enterGates.push(gate) }

/**
 * Told after an accepted `room.move`, `room.enter`, or authoritative `placeOccupant` pose update.
 * Never for a service room admission (`admitTo`) or a refused attempt. It runs on every accepted
 * step and transported pose, so a listener must be cheap.
 */
type StoodListener = (world: World, memberId: MemberId, place: { ref: RoomRef; key: RoomKey; instance: number }, pos: Vec2) => void
const stoodListeners: StoodListener[] = []
export function onStood(listener: StoodListener): void { stoodListeners.push(listener) }

export interface PublicEntryPose { pos: Vec2; heading: number; instance: number }
interface StreetEntryPolicy {
  resolve(memberId: MemberId, input: { ref: RoomRef; pos: Vec2; heading: number }, suggestedInstance: number): PublicEntryPose | null
  accepted(memberId: MemberId): void
}
const streetEntryPolicies = new WeakMap<World, StreetEntryPolicy>()
/** Only public room admission uses resolve. Vehicle and home owners keep their service-chosen admission. */
export function setStreetEntryPolicy(world: World, policy: StreetEntryPolicy): void { streetEntryPolicies.set(world, policy) }

/** Static geometry, houses, vehicles and visible people in the exact destination instance. */
export function entryPathClear(world: World, memberId: MemberId, ref: RoomRef, number: number, from: Vec2, to: Vec2): boolean {
  const place = { ref, key: roomKey(ref), instance: number }
  if (!footMovementGuard(world, memberId, place, from, to) || footRules.some(rule => !rule(world, memberId, place, from, to))) return false
  const member = record(world, memberId)
  const occupants = runtime(world).instances.get(`${place.key}#${number}`)?.occupants
  const obstacles = [...occupants?.values() ?? []].filter(other => other.memberId !== memberId && !presenceTransport(world, other.memberId)
    && !member.blocked.includes(other.memberId) && !other.record.blocked.includes(memberId))
    .map(other => ({ kind: 'disc' as const, pos: other.pos, radius: PERSON_RADIUS }))
  // moveFoot permits escape from overlap; admission must also reject an occupied endpoint.
  if (obstacles.some(other => distance(to, other.pos) < PERSON_RADIUS * 2)) return false
  return distance(moveFoot(from, to, obstacles), to) <= .025
}

function parseRef(value: unknown): RoomRef {
  const raw = obj(value, 'ref')
  const kind = oneOf(raw, 'kind', ['district', 'venue', 'home', 'table'] as const)
  if (kind === 'district' || kind === 'venue') {
    const districtId = str(raw, 'districtId', { max: 40 }) as DistrictId
    if (!parseDistrictId(districtId)) throw new WorldError('invalid', 'ref.districtId is not a valid district')
    if (kind === 'district') return { kind, districtId }
    const placeId = str(raw, 'placeId', { min: 1, max: 80 })
    if (!/^[A-Za-z0-9:_-]+$/.test(placeId)) throw new WorldError('invalid', 'ref.placeId is not valid')
    return { kind, districtId, placeId: placeId as PlaceId }
  }
  if (kind === 'home') return { kind, homeId: str(raw, 'homeId', { min: 3, max: 60 }) as HomeId }
  return { kind, matchId: str(raw, 'matchId', { min: 3, max: 60 }) as MatchId }
}

const parseVec = (value: unknown, what: string): Vec2 => {
  const raw = obj(value, what)
  const limit = DISTRICT_HALF_SPAN_LIMIT
  return { x: num(raw, 'x', { min: -limit, max: limit }), z: num(raw, 'z', { min: -limit, max: limit }) }
}
const parseEnter = (value: unknown): { ref: RoomRef; pos: Vec2; heading: number } => {
  const raw = obj(value)
  return { ref: parseRef(raw.ref), pos: parseVec(raw.pos, 'pos'), heading: num(raw, 'heading', { min: -7, max: 7 }) }
}
const parseMove = (value: unknown): { pos: Vec2; heading: number; moving: boolean } => {
  const raw = obj(value)
  return { pos: parseVec(raw.pos, 'pos'), heading: num(raw, 'heading', { min: -7, max: 7 }), moving: bool(raw, 'moving') }
}

function presenceOf(world: World, viewer: MemberId, instance: Instance, occupant: Occupant): PresenceMember {
  const { profile } = occupant.record
  const transport = presenceTransport(world, occupant.memberId)
  let context: PresenceMember['context'] = 'exploring'
  if (instance.ref.kind === 'district' || instance.ref.kind === 'venue') {
    const area = freshArea(world, occupant.memberId)
    if (area && profile.preferences.discoverable && area.areaId === areaOfDistrict(instance.ref.districtId)) context = 'current-area'
  }
  return {
    id: occupant.memberId, displayName: profile.displayName, look: lookFor(world, viewer, occupant.memberId), pos: occupant.pos, heading: occupant.heading,
    moving: occupant.moving, relation: relation(world, viewer, occupant.memberId), voice: occupant.voice, context,
    ...(friendTag(world, viewer, occupant.memberId) ? { automatic: 'creator' as const } : {}),
    ...(creatorOf(world) === occupant.memberId ? { verified: 'creator' as const } : {}),
    ...(transport ? { transport } : {}),
  }
}

/** Blocked in either direction. Almost nobody has a block list, so this is usually two length checks. */
const blockedPair = (a: Occupant, b: Occupant): boolean =>
  (a.record.blocked.length > 0 && a.record.blocked.includes(b.memberId)) || (b.record.blocked.length > 0 && b.record.blocked.includes(a.memberId))

const INTEREST_SQUARED = INTEREST_RADIUS * INTEREST_RADIUS
const squared = (a: Vec2, b: Vec2): number => { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz }

/** May `viewer` be shown `other`: not blocked, and inside the interest radius on a street. */
const inView = (instance: Instance, viewer: Occupant, other: Occupant): boolean =>
  !blockedPair(viewer, other) && (instance.ref.kind !== 'district' || squared(viewer.pos, other.pos) <= INTEREST_SQUARED)

/** The members who have been shown `occupant`. */
function watchers(instance: Instance, occupant: Occupant): MemberId[] {
  const out: MemberId[] = []
  for (const other of instance.occupants.values()) if (other !== occupant && other.sees.has(occupant)) out.push(other.memberId)
  return out
}

function removeInstance(rt: RoomRuntime, instance: Instance): void {
  rt.instances.delete(instance.id)
  rt.active.delete(instance)
  const siblings = rt.byKey.get(instance.key)
  if (!siblings) return
  const at = siblings.indexOf(instance)
  if (at >= 0) siblings.splice(at, 1)
  if (siblings.length === 0) rt.byKey.delete(instance.key)
}

/** `staying` is set when the member is about to re-enter the same room, which is not a change of room. */
function leave(world: World, memberId: MemberId, staying = false): void {
  const rt = runtime(world)
  const instance = rt.where.get(memberId)
  if (!instance) return
  const occupant = instance.occupants.get(memberId)!
  instance.occupants.delete(memberId)
  instance.footGrid.remove(memberId)
  rt.where.delete(memberId)
  if (!staying) tell(leaveListeners, world, memberId, instance.ref)
  if (world.roomHost) {
    // Sharded: this process only keeps the register of who is where. The shard tells the room.
    world.roomHost.leave(memberId, instance.key)
    if (instance.occupants.size === 0 && instance.reserved === 0) removeInstance(rt, instance)
    return
  }
  const told: MemberId[] = []
  for (const other of instance.occupants.values()) if (other.sees.delete(occupant)) told.push(other.memberId)
  world.pushMany(told, { type: 'presence.leave', room: instance.key, memberId })
  const at = instance.movers.indexOf(occupant)
  if (at >= 0) instance.movers.splice(at, 1)
  const hadVoice = instance.voiceUsers.delete(occupant)
  if (instance.occupants.size === 0 && instance.reserved === 0) removeInstance(rt, instance)
  else if (hadVoice) refreshVoice(world, instance)
}

function instanceFor(rt: RoomRuntime, ref: RoomRef, key: RoomKey, number: number): Instance {
  const id = `${key}#${number}`
  let found = rt.instances.get(id)
  if (found) return found
  found = { id, key, ref, number, occupants: new Map(), footGrid: new FootObstacleGrid(), movers: [], voiceUsers: new Set(), voiceStale: false, steps: 0, slots: 0, phase: rt.created++ % STEP_PHASES, reserved: 0 }
  rt.instances.set(id, found)
  const siblings = rt.byKey.get(key)
  if (siblings) siblings.push(found); else rt.byKey.set(key, [found])
  return found
}

/** Put the member in the least-numbered instance with space, preferring one that holds a friend. */
function pickInstance(world: World, memberId: MemberId, ref: RoomRef): Instance {
  const rt = runtime(world)
  const key = roomKey(ref)
  const capacity = ROOM_CAPACITY[ref.kind]
  const siblings = rt.byKey.get(key) ?? []
  const candidates = siblings.filter(instance => instance.occupants.size + instance.reserved < capacity).sort((a, b) => a.number - b.number)
  const friends = record(world, memberId).friends
  if (friends.length > 0 && candidates.length > 1) {
    const mine = new Set(friends)
    const withFriend = candidates.find(instance => { for (const other of instance.occupants.keys()) if (mine.has(other)) return true; return false })
    if (withFriend) return withFriend
  }
  if (candidates[0]) return candidates[0]
  let number = 1
  while (rt.instances.has(`${key}#${number}`)) number++
  return instanceFor(rt, ref, key, number)
}

function voicePeersOf(instance: Instance, occupant: Occupant): MemberId[] {
  if (occupant.voice === 'off') return []
  const radius = PROXIMITY_RADIUS[instance.ref.kind]
  const peers: MemberId[] = []
  for (const other of instance.voiceUsers) {
    if (other === occupant || blockedPair(occupant, other)) continue
    if (distance(other.pos, occupant.pos) <= radius) peers.push(other.memberId)
  }
  return peers.sort()
}

/** Recompute who may hear whom and tell members whose audience changed. Only voice users are visited. */
function refreshVoice(world: World, instance: Instance): void {
  instance.voiceStale = false
  for (const occupant of instance.voiceUsers) {
    const peers = voicePeersOf(instance, occupant)
    if (peers.join() === occupant.voicePeers.join()) continue
    occupant.voicePeers = peers
    world.push(occupant.memberId, { type: 'voice.peers', room: instance.key, peers })
  }
}

function snapshotOf(world: World, instance: Instance, me: Occupant): RoomSnapshot {
  const members: PresenceMember[] = []
  // Listed in the order members arrived, the member themselves included.
  for (const occupant of instance.occupants.values()) if (occupant === me || me.sees.has(occupant)) members.push(presenceOf(world, me.memberId, instance, occupant))
  return { room: instance.key, ref: instance.ref, instance: instance.number, capacity: ROOM_CAPACITY[instance.ref.kind], members }
}

export function snapshotFor(world: World, memberId: MemberId): RoomSnapshot | null {
  const instance = runtime(world).where.get(memberId)
  const me = instance?.occupants.get(memberId)
  return instance && me ? snapshotOf(world, instance, me) : null
}

export const roomOf = (world: World, memberId: MemberId): { key: RoomKey; ref: RoomRef; pos: Vec2 } | null => {
  const instance = runtime(world).where.get(memberId)
  const occupant = instance?.occupants.get(memberId)
  return instance && occupant ? { key: instance.key, ref: instance.ref, pos: occupant.pos } : null
}

/** Members sharing a room instance with `memberId`, regardless of distance. */
export function roomMates(world: World, memberId: MemberId): MemberId[] {
  const instance = runtime(world).where.get(memberId)
  return instance ? [...instance.occupants.keys()].filter(other => other !== memberId) : []
}

// ── For the module that carries members (vehicles): one instance, named exactly ──────────────
// Single-process rooms only. On a sharded service positions live on the shards and none of this
// is true here, so that module reports itself unavailable instead of calling these.

/** Where a member is, with the instance. `roomOf` leaves the instance out. */
export function placeOf(world: World, memberId: MemberId): { key: RoomKey; ref: RoomRef; instance: number; pos: Vec2; heading: number } | null {
  const instance = runtime(world).where.get(memberId)
  const occupant = instance?.occupants.get(memberId)
  return instance && occupant ? { key: instance.key, ref: instance.ref, instance: instance.number, pos: occupant.pos, heading: occupant.heading } : null
}

/**
 * How many more members one named instance can take, counting the places held for a group that
 * is on its way (`holdPlaces`). An instance that does not exist yet has the room's whole capacity.
 */
export function spaceIn(world: World, ref: RoomRef, number: number): number {
  const instance = runtime(world).instances.get(`${roomKey(ref)}#${number}`)
  return ROOM_CAPACITY[ref.kind] - (instance ? instance.occupants.size + instance.reserved : 0)
}

/** Everyone in one instance, with where they stand. */
export function standingIn(world: World, key: RoomKey, number: number): { memberId: MemberId; pos: Vec2 }[] {
  const instance = runtime(world).instances.get(`${key}#${number}`)
  const out: { memberId: MemberId; pos: Vec2 }[] = []
  if (instance) for (const occupant of instance.occupants.values()) out.push({ memberId: occupant.memberId, pos: occupant.pos })
  return out
}

/**
 * Put a member where the service says they are: in a seat that moved, or stepping out of one. It is
 * not held to walking speed, and it goes out with the room's next step like any other movement.
 */
export function placeOccupant(world: World, memberId: MemberId, pos: Vec2, heading: number, moving: boolean): boolean {
  const rt = runtime(world)
  const instance = rt.where.get(memberId)
  const occupant = instance?.occupants.get(memberId)
  if (!instance || !occupant) return false
  occupant.pos = { x: pos.x, z: pos.z }
  instance.footGrid.set(memberId, { kind: 'disc', pos: occupant.pos, radius: PERSON_RADIUS })
  occupant.heading = heading
  occupant.moving = moving
  occupant.movedAt = world.now()
  if (!occupant.moved) { occupant.moved = true; instance.movers.push(occupant) }
  occupant.movedFar = true
  rt.active.add(instance)
  if (occupant.voice !== 'off' && instance.voiceUsers.size > 1) instance.voiceStale = true
  for (const listener of stoodListeners) listener(world, memberId, { ref: instance.ref, key: instance.key, instance: instance.number }, occupant.pos)
  streetEntryPolicies.get(world)?.accepted(memberId)
  return true
}

/**
 * Hold `count` places in one instance of a room for a group that must arrive together, and say
 * which instance. An instance that already holds one of the group's friends is not preferred:
 * the lowest-numbered one with room for all of them is taken, or a new one. Null when even a new
 * instance could not hold the group. With `exactInstance`, only that instance may be held.
 * Every hold is given back with `releasePlaces`.
 */
export function holdPlaces(world: World, ref: RoomRef, count: number, exactInstance?: number): number | null {
  const rt = runtime(world)
  const key = roomKey(ref)
  const capacity = ROOM_CAPACITY[ref.kind]
  if (count < 1 || count > capacity) return null
  if (exactInstance !== undefined) {
    if (spaceIn(world, ref, exactInstance) < count) return null
    instanceFor(rt, ref, key, exactInstance).reserved += count
    return exactInstance
  }
  const fits = (rt.byKey.get(key) ?? []).filter(instance => instance.occupants.size + instance.reserved + count <= capacity).sort((a, b) => a.number - b.number)[0]
  let number = fits?.number ?? 1
  if (!fits) while (rt.instances.has(`${key}#${number}`)) number++
  instanceFor(rt, ref, key, number).reserved += count
  return number
}

export function releasePlaces(world: World, ref: RoomRef, number: number, count: number): void {
  const rt = runtime(world)
  const instance = rt.instances.get(`${roomKey(ref)}#${number}`)
  if (!instance) return
  instance.reserved = Math.max(0, instance.reserved - count)
  if (instance.occupants.size === 0 && instance.reserved === 0) removeInstance(rt, instance)
}

/**
 * Bring a member into a named instance at a place the service chose. The caller has decided they
 * may be there (the travel guard for the room, and a held place); nothing from the member's App is
 * used. Other modules hear the change of room exactly as they do for `room.enter`.
 */
export function admitTo(world: World, memberId: MemberId, ref: RoomRef, number: number, pos: Vec2, heading: number): { snapshot: RoomSnapshot; history: ChatMessage[] } {
  const same = runtime(world).where.get(memberId)?.key === roomKey(ref)
  leave(world, memberId, same)
  const entered = enterInstance(world, memberId, ref, number, { x: pos.x, z: pos.z }, heading, world.now())
  if (!same) tell(enterListeners, world, memberId, ref)
  streetEntryPolicies.get(world)?.accepted(memberId)
  return entered
}

/** Convert one held place to its occupant before presence callbacks can inspect capacity. */
export function admitReservedTo(world: World, memberId: MemberId, ref: RoomRef, number: number, pos: Vec2, heading: number): { snapshot: RoomSnapshot; history: ChatMessage[] } {
  if ((runtime(world).instances.get(`${roomKey(ref)}#${number}`)?.reserved ?? 0) < 1) throw new WorldError('conflict', 'Your kept street place is no longer available.')
  const same = runtime(world).where.get(memberId)?.key === roomKey(ref)
  leave(world, memberId, same)
  const entered = enterInstance(world, memberId, ref, number, { x: pos.x, z: pos.z }, heading, world.now(), true)
  if (!same) tell(enterListeners, world, memberId, ref)
  streetEntryPolicies.get(world)?.accepted(memberId)
  return entered
}

/** Push an event to everyone present in any instance of a room. */
export function pushToRoom(world: World, key: RoomKey, event: ServerEvent): void {
  world.pushMany(occupantsOfRoom(world, key), event)
}

export function occupantsOfRoom(world: World, key: RoomKey): MemberId[] {
  const out: MemberId[] = []
  for (const instance of runtime(world).byKey.get(key) ?? []) for (const memberId of instance.occupants.keys()) out.push(memberId)
  return out
}

/** Remove a member from a room they may no longer be in (home made private, access revoked). */
export function evict(world: World, memberId: MemberId): void { leave(world, memberId) }

/** Rooms and members in them, for /world/health diagnostics. */
export function roomCounts(world: World): { rooms: number; instances: number; members: number; busiest: number; movementHeldBack: number } {
  const rt = runtime(world)
  let busiest = 0
  for (const instance of rt.instances.values()) if (instance.occupants.size > busiest) busiest = instance.occupants.size
  return { rooms: rt.byKey.size, instances: rt.instances.size, members: rt.where.size, busiest, movementHeldBack: rt.heldBack }
}

function newOccupant(world: World, instance: Instance, memberId: MemberId, pos: Vec2, heading: number, now: number): Occupant {
  return {
    memberId, record: record(world, memberId), pos, heading, moving: false, movedAt: now, voice: 'off', voicePeers: [], sees: new Set(),
    moved: false, movedFar: false, slot: instance.slots++ % Math.max(1, MOVEMENT.farEvery), lagging: false, stepIndex: -1,
  }
}

/**
 * Put a member into a given instance and tell the room. The caller has already decided they may
 * enter (the guards) and which instance (pickInstance); a room shard is handed both.
 */
export function enterInstance(world: World, memberId: MemberId, ref: RoomRef, number: number, pos: Vec2, heading: number, now: number, consumeReserved = false): { snapshot: RoomSnapshot; history: ChatMessage[] } {
  const rt = runtime(world)
  leave(world, memberId)
  const instance = instanceFor(rt, ref, roomKey(ref), number)
  const occupant = newOccupant(world, instance, memberId, pos, heading, now)
  if (consumeReserved) instance.reserved--
  instance.occupants.set(memberId, occupant)
  instance.footGrid.set(memberId, { kind: 'disc', pos: occupant.pos, radius: PERSON_RADIUS })
  rt.where.set(memberId, instance)
  for (const other of instance.occupants.values()) {
    if (other === occupant || !inView(instance, other, occupant)) continue
    occupant.sees.add(other)
    other.sees.add(occupant)
    world.push(other.memberId, { type: 'presence.join', room: instance.key, member: presenceOf(world, other.memberId, instance, occupant) })
  }
  const kept = rt.received.get(memberId)
  const history = kept && kept.room === instance.key ? kept.messages.filter(message => now - Date.parse(message.at) < 600_000) : []
  if (!kept || kept.room !== instance.key) rt.received.set(memberId, { room: instance.key, messages: [] })
  return { snapshot: snapshotOf(world, instance, occupant), history }
}

/** A block takes effect in the room at once: each stops seeing the other and any voice path is withdrawn. */
export function applyBlock(world: World, blocker: MemberId, blocked: MemberId): void {
  const rt = runtime(world)
  const instance = rt.where.get(blocker)
  if (!instance || rt.where.get(blocked) !== instance) return
  const a = instance.occupants.get(blocker)!, b = instance.occupants.get(blocked)!
  a.sees.delete(b)
  b.sees.delete(a)
  world.push(blocker, { type: 'presence.leave', room: instance.key, memberId: blocked })
  world.push(blocked, { type: 'presence.leave', room: instance.key, memberId: blocker })
  refreshVoice(world, instance)
}

/** Re-announce a member whose look or voice state changed to the members who can see them. */
export function announce(world: World, memberId: MemberId): void {
  const instance = runtime(world).where.get(memberId)
  const occupant = instance?.occupants.get(memberId)
  if (!instance || !occupant) return
  for (const viewer of watchers(instance, occupant)) world.push(viewer, { type: 'presence.update', room: instance.key, member: presenceOf(world, viewer, instance, occupant) })
}

/** Operations after which two members may stand differently to each other: an introduction sent, answered or withdrawn, a friendship ended. */
export const RELATION_OPS: ReadonlySet<string> = new Set(['intro.send', 'intro.respond', 'intro.withdraw', 'friends.remove'])

/**
 * After a friendship or introduction changed for `memberId`: show the room the change at once,
 * without anyone re-entering. Everyone who can see the member gets them afresh (their mark, and
 * their photo face if that is for friends), and the member gets afresh everyone they can see.
 */
export function refreshRelations(world: World, memberId: MemberId): void {
  const instance = runtime(world).where.get(memberId)
  const occupant = instance?.occupants.get(memberId)
  if (!instance || !occupant) return
  announce(world, memberId)
  for (const other of occupant.sees) world.push(memberId, { type: 'presence.update', room: instance.key, member: presenceOf(world, memberId, instance, other) })
}

// ── The step: send out what moved ─────────────────────────────────────────────────────────────

function stepInstance(world: World, rt: RoomRuntime, instance: Instance): boolean {
  const farEvery = Math.max(1, MOVEMENT.farEvery)
  const nearSquared = MOVEMENT.nearRadius * MOVEMENT.nearRadius
  const tick = instance.steps++
  const step: MovementStep = { room: instance.key, moved: [], memo: {} }
  const listed: Occupant[] = []
  const indexOf = (occupant: Occupant): number => {
    if (occupant.stepIndex < 0) {
      occupant.stepIndex = step.moved.push({ memberId: occupant.memberId, x: occupant.pos.x, z: occupant.pos.z, heading: occupant.heading, moving: occupant.moving }) - 1
      listed.push(occupant)
    }
    return occupant.stepIndex
  }
  // Candidates this step: whoever moved since the last one, and whoever moved earlier and is now
  // due for its slower update to far-away watchers.
  const movers = instance.movers
  const candidates: Occupant[] = movers.slice()
  let pendingFar = false
  if (farEvery > 1) {
    for (const occupant of instance.occupants.values()) {
      if (!occupant.movedFar) continue
      if ((tick + occupant.slot) % farEvery !== 0) { pendingFar = true; continue }
      if (!occupant.moved) candidates.push(occupant)
    }
  }
  const farDue = (occupant: Occupant): boolean => farEvery === 1 || (tick + occupant.slot) % farEvery === 0
  let stillLagging = false

  for (const viewer of instance.occupants.values()) {
    if (candidates.length === 0 && !viewer.lagging) continue
    if (world.congested(viewer.memberId)) {
      // A socket that is not keeping up gets no movement until it drains. What it missed is not
      // queued: when it recovers it is sent where everyone is now. Chat and answers are never held.
      if (candidates.length > 0) rt.heldBack += candidates.length
      viewer.lagging = true
      stillLagging = true
      continue
    }
    const indices: number[] = []
    const events: ServerEvent[] = []
    // Someone who moved (or is catching up) is checked against everyone; everyone else only against those who moved.
    const everyone = viewer.moved || viewer.lagging
    const others = everyone ? instance.occupants.values() : candidates
    for (const other of others) {
      if (other === viewer) continue
      const apart = squared(viewer.pos, other.pos)
      const visible = !blockedPair(viewer, other) && (instance.ref.kind !== 'district' || apart <= INTEREST_SQUARED)
      if (visible) {
        if (!viewer.sees.has(other)) {
          viewer.sees.add(other)
          events.push({ type: 'presence.join', room: instance.key, member: presenceOf(world, viewer.memberId, instance, other) })
        } else if (viewer.lagging || (other.moved && apart <= nearSquared) || (other.movedFar && farDue(other))) {
          indices.push(indexOf(other))
        }
      } else if (viewer.sees.delete(other)) {
        events.push({ type: 'presence.leave', room: instance.key, memberId: other.memberId })
      }
    }
    viewer.lagging = false
    if (indices.length > 0 || events.length > 0) world.pushStep(viewer.memberId, step, indices, events)
  }

  for (const occupant of movers) occupant.moved = false
  movers.length = 0
  for (const occupant of candidates) if (farDue(occupant)) occupant.movedFar = false
  for (const occupant of listed) occupant.stepIndex = -1
  if (instance.voiceStale) refreshVoice(world, instance)
  return pendingFar || stillLagging
}

/** Send active instances their movement: those in one phase, or all of them when no phase is given. */
export function stepRooms(world: World, phase: number | null = null): void {
  const rt = runtime(world)
  for (const instance of rt.active) {
    if (phase !== null && instance.phase !== phase) continue
    if (!stepInstance(world, rt, instance)) rt.active.delete(instance)
  }
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

function footStepAllowed(world: World, instance: Instance, occupant: Occupant, pos: Vec2, now: number): boolean {
  // Refreshing the accepted position is harmless, including a legacy overlapping arrival.
  const metres = distance(pos, occupant.pos)
  if (metres < 1e-6) return true
  const seconds = Math.max(0.05, (now - occupant.movedAt) / 1000)
  if (metres > Math.min(64, MAX_SPEED * seconds + 2)) return false
  const place = { ref: instance.ref, key: instance.key, instance: instance.number }
  if (!footMovementGuard(world, occupant.memberId, place, occupant.pos, pos)) return false
  if (footRules.some(rule => !rule(world, occupant.memberId, place, occupant.pos, pos))) return false
  const obstacles = instance.footGrid.query(occupant.pos, pos).filter(entry => {
    const other = instance.occupants.get(entry.key)
    return other && other !== occupant && inView(instance, occupant, other) && !presenceTransport(world, other.memberId)
  }).map(entry => entry.obstacle)
  return distance(moveFoot(occupant.pos, pos, obstacles), pos) <= 0.025
}

function registerHotOps(world: World): void {
  world.onStep((_now, phase) => stepRooms(world, phase))

  world.register('room.move', parseMove, (ctx, input) => {
    const rt = runtime(world)
    const instance = rt.where.get(ctx.memberId)
    const occupant = instance?.occupants.get(ctx.memberId)
    if (!instance || !occupant) throw new WorldError('conflict', 'You are not in a room.')
    // Seated in a vehicle: the service moves the member. The App is given the seat's place, as for any refused step.
    if (occupancyHold(world, ctx.memberId)) return { accepted: false, pos: occupant.pos }
    if (!footStepAllowed(world, instance, occupant, input.pos, ctx.now)) return { accepted: false, pos: occupant.pos }
    occupant.pos = input.pos
    instance.footGrid.set(ctx.memberId, { kind: 'disc', pos: occupant.pos, radius: PERSON_RADIUS })
    occupant.heading = input.heading
    occupant.moving = input.moving
    occupant.movedAt = ctx.now
    if (!occupant.moved) { occupant.moved = true; instance.movers.push(occupant) }
    occupant.movedFar = true
    rt.active.add(instance)
    // Who can hear whom only changes when a voice user moves, and only matters with two or more.
    if (occupant.voice !== 'off' && instance.voiceUsers.size > 1) instance.voiceStale = true
    for (const listener of stoodListeners) listener(world, ctx.memberId, { ref: instance.ref, key: instance.key, instance: instance.number }, occupant.pos)
    streetEntryPolicies.get(world)?.accepted(ctx.memberId)
    return { accepted: true, pos: occupant.pos }
  }, { cost: 0.2, lazyAck: true })

  world.register('chat.send', value => {
    const raw = obj(value)
    return { text: str(raw, 'text', { min: 1, max: CHAT_MAX_LENGTH }), clientId: str(raw, 'clientId', { min: 1, max: 40 }) }
  }, (ctx, input) => {
    world.limit(`chat:${ctx.memberId}`, 8, 10_000)
    const rt = runtime(world)
    const instance = rt.where.get(ctx.memberId)
    const occupant = instance?.occupants.get(ctx.memberId)
    if (!instance || !occupant) throw new WorldError('conflict', 'Enter a room before sending a message.')
    const message: ChatMessage = {
      id: `c_${randomToken(10)}`, room: instance.key, from: ctx.memberId, fromName: occupant.record.profile.displayName,
      text: input.text, at: iso(ctx.now), audience: 0,
    }
    const keep = (memberId: MemberId): void => {
      const kept = rt.received.get(memberId)
      if (!kept || kept.room !== instance.key) { rt.received.set(memberId, { room: instance.key, messages: [message] }); return }
      kept.messages.push(message)
      if (kept.messages.length > 40) kept.messages.shift()
    }
    const radius = PROXIMITY_RADIUS[instance.ref.kind]
    const recipients: MemberId[] = []
    for (const other of instance.occupants.values()) {
      if (other !== occupant && !blockedPair(other, occupant) && distance(other.pos, occupant.pos) <= radius) recipients.push(other.memberId)
    }
    message.audience = recipients.length
    for (const memberId of recipients) keep(memberId)
    world.pushMany(recipients, { type: 'chat.message', message })
    keep(ctx.memberId)
    return { message }
  })

  world.register('voice.set', value => ({ state: oneOf(obj(value), 'state', ['off', 'live', 'muted'] as const) }), (ctx, input) => {
    const instance = runtime(world).where.get(ctx.memberId)
    const occupant = instance?.occupants.get(ctx.memberId)
    if (!instance || !occupant) throw new WorldError('conflict', 'Enter a room before using voice.')
    occupant.voice = input.state
    if (input.state === 'off') instance.voiceUsers.delete(occupant); else instance.voiceUsers.add(occupant)
    announce(world, ctx.memberId)
    occupant.voicePeers = voicePeersOf(instance, occupant)
    const peers = occupant.voicePeers
    refreshVoice(world, instance)
    return { state: occupant.voice, peers }
  })

  world.register('voice.signal', value => {
    const raw = obj(value)
    return { to: str(raw, 'to', { min: 3, max: 60 }) as MemberId, data: raw.data }
  }, (ctx, input) => {
    const instance = runtime(world).where.get(ctx.memberId)
    const occupant = instance?.occupants.get(ctx.memberId)
    // Signalling is relayed only between members the service currently counts as voice peers,
    // so a connection cannot be opened across rooms, out of range, or past a block. The check
    // uses positions as they are now, not as they were at the last step.
    if (!instance || !occupant || !voicePeersOf(instance, occupant).includes(input.to)) return { relayed: false }
    if (JSON.stringify(input.data ?? null).length > 16_000) throw new WorldError('invalid', 'Signal payload is too large.')
    world.push(input.to, { type: 'voice.signal', from: ctx.memberId, data: input.data })
    return { relayed: true }
  }, { cost: 0.3 })
}

function admit(world: World, memberId: MemberId, ref: RoomRef): void {
  if (ref.kind === 'district' || ref.kind === 'venue') guards.street(world, memberId, ref)
  if (ref.kind === 'home') guards.home(world, memberId, ref)
  if (ref.kind === 'table') guards.table(world, memberId, ref)
}

export function registerRooms(world: World): void {
  if (world.roomHost) { registerDirectory(world); return }
  world.onDisconnect(memberId => leave(world, memberId))
  onBlock((blockWorld, blocker, blocked) => { if (blockWorld === world) applyBlock(world, blocker, blocked) })
  onLookChange((lookWorld, memberId) => { if (lookWorld === world) announce(world, memberId) })
  world.onOperation((memberId, op) => { if (RELATION_OPS.has(op)) refreshRelations(world, memberId) })

  world.register('room.enter', parseEnter, (ctx, input) => {
    const held = occupancyHold(world, ctx.memberId)
    if (held) throw new WorldError('conflict', held)
    admit(world, ctx.memberId, input.ref)
    const current = runtime(world).where.get(ctx.memberId)
    const same = current?.key === roomKey(input.ref)
    const suggested = same && current ? current : pickInstance(world, ctx.memberId, input.ref)
    const resolved = streetEntryPolicies.get(world)?.resolve(ctx.memberId, input, suggested.number)
    const admission = resolved ? { ref: input.ref, pos: resolved.pos, heading: resolved.heading } : input
    // Gates see the final authoritative pose, and run before leaving the old room.
    for (const gate of enterGates) gate(world, ctx.memberId, admission)
    const occupant = current?.occupants.get(ctx.memberId)
    if (same && current && occupant && !footStepAllowed(world, current, occupant, admission.pos, ctx.now)) throw new WorldError('conflict', 'That position cannot be reached. Walk to a clear place first.')
    const number = resolved?.instance ?? suggested.number
    if (!(same && current?.number === number) && spaceIn(world, input.ref, number) < 1) throw new WorldError('conflict', 'That street instance is full. Try again in a moment.')
    leave(world, ctx.memberId, same)
    const entered = enterInstance(world, ctx.memberId, admission.ref, number, admission.pos, admission.heading, ctx.now)
    if (!same) tell(enterListeners, world, ctx.memberId, input.ref)
    for (const listener of stoodListeners) listener(world, ctx.memberId, { ref: input.ref, key: roomKey(input.ref), instance: number }, admission.pos)
    streetEntryPolicies.get(world)?.accepted(ctx.memberId)
    return entered
  })
  world.register('room.leave', empty, ctx => { leave(world, ctx.memberId); return { left: true as const } })
  registerHotOps(world)
}

/**
 * A room shard: holds the instances it is given and runs movement, chat and voice for them.
 * Entering and leaving are decided by the state process, which calls enterInstance and evict.
 */
export function registerRoomShard(world: World): void {
  world.onDisconnect(memberId => leave(world, memberId))
  registerHotOps(world)
}

/**
 * The state process of a sharded service. It decides who may enter and which instance they
 * join, and keeps the register that homes, games and travel ask (who is in which room). The
 * room itself — positions, movement, chat, voice — is on the shard that owns the room.
 */
function registerDirectory(world: World): void {
  const host = world.roomHost!
  world.onDisconnect(memberId => leave(world, memberId))
  onBlock((blockWorld, blocker, blocked) => {
    if (blockWorld !== world) return
    const rt = runtime(world)
    const instance = rt.where.get(blocker)
    if (instance && rt.where.get(blocked) === instance) host.changed(blocker, instance.key, { blocked })
  })
  onLookChange((lookWorld, memberId) => {
    if (lookWorld !== world) return
    const instance = runtime(world).where.get(memberId)
    if (instance) host.changed(memberId, instance.key, 'look')
  })

  world.register('room.enter', parseEnter, (ctx, input) => {
    admit(world, ctx.memberId, input.ref)
    const reply = world.deferReply()
    if (!reply) throw new WorldError('unavailable', 'Rooms are on room shards: enter over a connection.')
    const rt = runtime(world)
    const same = rt.where.get(ctx.memberId)?.key === roomKey(input.ref)
    leave(world, ctx.memberId, same)
    const instance = pickInstance(world, ctx.memberId, input.ref)
    instance.occupants.set(ctx.memberId, newOccupant(world, instance, ctx.memberId, input.pos, input.heading, ctx.now))
    rt.where.set(ctx.memberId, instance)
    if (!same) tell(enterListeners, world, ctx.memberId, input.ref)
    host.enter({ memberId: ctx.memberId, ref: input.ref, key: instance.key, instance: instance.number, pos: input.pos, heading: input.heading, now: ctx.now, reply })
    return { snapshot: { room: instance.key, ref: instance.ref, instance: instance.number, capacity: ROOM_CAPACITY[instance.ref.kind], members: [] }, history: [] }
  })
  world.register('room.leave', empty, ctx => { leave(world, ctx.memberId); return { left: true as const } })

  // These reach the state process only when the member is in no room: the edge sends them
  // straight to the shard otherwise.
  const elsewhere = (memberId: MemberId, message: string): never => {
    throw new WorldError(runtime(world).where.has(memberId) ? 'unavailable' : 'conflict', runtime(world).where.has(memberId) ? 'The room is busy. Try again.' : message)
  }
  world.register('room.move', parseMove, ctx => elsewhere(ctx.memberId, 'You are not in a room.'), { cost: 0.2 })
  world.register('chat.send', value => ({ text: str(obj(value), 'text', { min: 1, max: CHAT_MAX_LENGTH }), clientId: str(obj(value), 'clientId', { min: 1, max: 40 }) }),
    ctx => elsewhere(ctx.memberId, 'Enter a room before sending a message.'))
  world.register('voice.set', value => ({ state: oneOf(obj(value), 'state', ['off', 'live', 'muted'] as const) }), ctx => elsewhere(ctx.memberId, 'Enter a room before using voice.'))
  world.register('voice.signal', value => ({ to: str(obj(value), 'to', { min: 3, max: 60 }) as MemberId, data: obj(value).data }), () => ({ relayed: false }), { cost: 0.3 })
}
