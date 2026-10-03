// Vehicles: kekes, danfos and cars that members board, drive and ride together.
//
// The service owns all of it. A vehicle has an id, a place in one room instance, seats, and at
// most one thing in control: a member at the wheel, or the service on a paid route. Members send
// intents; the service decides who sits where, steps the vehicle on its own clock against road
// data it trusts (vehicleRoutes.ts), carries everyone seated with it, and takes a charter fare once.
//
// Kept in memory: where vehicles are, who is in them, invitations, offers, quotes, crossings.
// Saved: which vehicle a member has borrowed and where it was last parked, and every paid ride's
// receipt with what became of it. A restart empties the seats; it never loses or repeats a payment.
//
// Single-process service only. On a sharded service rooms live on other threads, so every
// operation here answers "unavailable" and nothing else about the world changes.
import type { DistrictId, Iso, MemberId, PlaceId, RoomKey, VehicleId, VehicleInviteId, VehicleQuoteId } from '../src/shared/ids.ts'
import { iso, newId, randomToken } from '../src/shared/ids.ts'
import { parseDistrictId, DISTRICT_HALF_SPAN_LIMIT } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { FootObstacleGrid, moveFoot, PERSON_RADIUS, vehicleFootObstacle } from '../src/shared/worldCollision.ts'
import { WorldError, roomKey } from '../src/shared/model.ts'
import type { RoomRef, RoomSnapshot } from '../src/shared/model.ts'
import type { VehicleRoadDataset } from '../src/shared/vehicleRoadData.ts'
import {
  NEUTRAL_CONTROLS, VEHICLE_ACCESS, VEHICLE_KINDS, VEHICLE_RULES, VEHICLE_SPECS, stepVehicle, vehicleCorners, vehicleFare, vehiclePoint,
} from '../src/shared/vehicles.ts'
import type {
  DriverOffer, SeatId, VehicleAccess, VehicleActions, VehicleControls, VehicleDestination, VehicleInvite, VehicleKind, VehiclePhase, VehicleQuote,
  VehicleSeat, VehicleSeatSpec, VehicleSelf, VehicleSnapshot, VehicleSpec, VehicleTransition, VehicleBookingRecovery,
} from '../src/shared/vehicles.ts'
import type { World } from './kernel.ts'
import { areFriends, exists, friendTag, isBlockedEitherWay, onBlock } from './members.ts'
import { bool, empty, id, num, obj, oneOf, optId, str } from './parse.ts'
import type { Raw } from './parse.ts'
import {
  admitTo, admitReservedTo, announce, holdPlaces, onRoomEnter, onRoomLeave, placeOccupant, placeOf, releasePlaces, setOccupancyHold, setPresenceTransport, setFootMovementGuard, snapshotFor as roomFor, standingIn,
} from './rooms.ts'
import { chargeVehicleFare, refundVehicleFare, streetAdmission } from './travel.ts'
import { RoadAuthority, boxesOverlap, pointInBox, shippedRoadAuthority } from './vehicleRoutes.ts'
import type { Blocker, RoutePoint } from './vehicleRoutes.ts'
import { careerPoints } from './work.ts'
import { holdHomeParcelsToRoads, homeObstacles, setHomeVehicleAuthority } from './homePhysical.ts'
import type { RoadSolid } from './vehicleRoutes.ts'

const SECOND = 1000, MINUTE = 60_000
const STEP = VEHICLE_RULES.stepMs
const STOPPED = VEHICLE_RULES.stoppedSpeed
const SEATED = 'You are in a vehicle. Step out of it first.'
const NO_ROADS = 'Vehicles are not available on this service yet: it has no road data. Walking and Travel work as before.'
const SHARDED = 'Vehicles are not available on this service: its rooms run on separate workers. Walking and Travel work as before.'
/** A service vehicle that cannot get past for this long has failed its trip. */
const BLOCKED_FAILS_AFTER = 45 * SECOND
/** How far apart vehicles stand at a depot, and how many places one depot has. */
const BERTH_SPACING = 12, BERTHS = 6
const BORROWED_PER_INSTANCE = 6

// ── What is saved ─────────────────────────────────────────────────────────────────────────────

interface Pose { districtId: DistrictId; pos: Vec2; heading: number }
interface LoanRec { vehicleId: VehicleId; memberId: MemberId; kind: VehicleKind; access: VehicleAccess; depotId: string; /** Where it was last parked safely. */ checkpoint: Pose; issuedAt: Iso }
interface ReceiptRec {
  id: string; memberId: MemberId; vehicleId: VehicleId; tripId: string; kind: VehicleKind
  destination: VehicleDestination; label: string; fare: number; routeMetres: number; ledgerId: string; bookedAt: Iso
  /** boarding: paid, not yet left. en-route: left. Everything else is closed. */
  state: 'boarding' | 'en-route' | 'arrived' | 'cancelled' | 'failed' | 'abandoned'
  /** Who was aboard when it left, so each can be put down safely after a restart. */
  riders: MemberId[]
  /** The last place on the route the vehicle is known to have reached. */
  checkpoint: Pose | null
  /** Set once, when coins went back. Its presence is what stops a second refund. */
  refund: { amount: number; at: Iso; reason: 'cancelled' | 'service-failure'; ledgerId: string } | null
  closedAt: Iso | null
  /** Riders already put down on foot after a failure. */
  resumed: MemberId[]
  /** When the payer ended it on the way. Saved at once, so a restart before the vehicle has stopped still closes it as cancelled, with nothing returned. */
  cancelRequestedAt?: Iso
  /** Closed by a restart with riders aboard. Each of them is stood beside where it had got to, once, when they come back. */
  interrupted?: true
}
/** The recorded outcome of a paid request, so a retry is answered and nothing is taken or given twice. */
interface RequestRec { key: string; receiptId: string; refunded: number | null; at: Iso }
interface VehicleSlice { loans: Record<string, LoanRec>; receipts: Record<string, ReceiptRec>; requests: Record<string, Record<string, RequestRec>> }
const slice = (world: World): VehicleSlice => world.slice<VehicleSlice>('vehicles', () => ({ loans: {}, receipts: {}, requests: {} }))
const saved = (world: World): VehicleSlice | undefined => world.peek<VehicleSlice>('vehicles')

// ── What is kept in memory ────────────────────────────────────────────────────────────────────

interface Place { ref: RoomRef; key: RoomKey; instance: number; districtId: DistrictId }
interface SeatState { memberId: MemberId | null; /** Kept for a member whose connection dropped. */ held: { memberId: MemberId; until: number } | null }
interface Trip {
  id: string; destination: VehicleDestination; label: string; mode: 'navigation' | 'paid-service'; fare: number
  state: 'boarding' | 'en-route' | 'arrived'
  payer: MemberId | null; receiptId: string | null
  target: { districtId: DistrictId; pos: Vec2 }
  route: RoutePoint[]
  /** The route point being driven towards, the point on the centre line reached so far, and how far to the side of it the vehicle is (left is positive). */
  index: number; along: Vec2; lane: number
  bookedAt: number; blockedSince: number | null; failedCrossings: number; savedAt: number; cancelling: boolean
}
/** How long riders may sit in a service vehicle whose ride is over before they are put down beside it. */
const LINGER = 120 * SECOND
/** Someone getting in or out: which door is open for them, and until when. */
interface Transition { id: string; kind: 'board' | 'exit'; entryId: string; seatId: SeatId; memberId: MemberId; startedAt: number; endsAt: number }
type Control = { kind: 'none' } | { kind: 'member'; driverId: MemberId; controlEpoch: string } | { kind: 'service'; bookingMemberId: MemberId }
interface Vehicle {
  id: VehicleId; kind: VehicleKind; spec: VehicleSpec; source: 'borrowed' | 'service'
  ownerId: MemberId | null; access: VehicleAccess; depotId: string
  room: Place; pos: Vec2; heading: number; speed: number; steering: number
  phase: VehiclePhase; revision: number; epoch: string; tick: number
  seats: Map<SeatId, SeatState>
  control: Control
  input: (VehicleControls & { at: number }) | null; lastSeq: number
  /** Members the borrower or payer has let in for this ride, and as what. */
  grants: Map<MemberId, 'passenger' | 'driver'>
  trip: Trip | null
  /** Members who asked to get out while it was moving, and until when the vehicle waits for them. */
  exitWanted: Map<MemberId, number>
  /** Members to be put down as soon as it has stopped (a block between two people aboard). */
  putDown: Set<MemberId>
  /** Boardings and exits under way. While there are any, the vehicle stays where it is. */
  transitions: Transition[]
  notice: string
  simAt: number; carry: number; sentAt: number; dirty: boolean; stillSince: number | null; emptySince: number | null
  /** The one crossing this vehicle is in, if any. A crossing record that is not this one can do nothing to the vehicle. */
  crossing: string | null; crossAfter: number
  /** When a service vehicle's ride last ended with people still aboard. */
  rideEndedAt: number | null
}
interface Crossing {
  id: string; vehicle: Vehicle; epoch: string; to: Place; spawn: Vec2; heading: number; dataVersion: string
  expiresAt: number; tokens: Map<MemberId, string>; acked: Set<MemberId>; places: number
  state: 'waiting' | 'committed' | 'aborted'; closedAt: number
  /** Who was taken across when it committed. */
  carried: MemberId[]
  /** For a route: where it carries on from once across. */
  resume: { index: number; along: Vec2 } | null
}
interface DriverOfferRec extends DriverOffer { controlEpoch: string }
interface QuoteRec extends VehicleQuote { memberId: MemberId; target: { districtId: DistrictId; pos: Vec2 }; route: RoutePoint[]; dataVersion: string; used: boolean }
interface Runtime {
  world: World
  boot: string; counter: number
  roads: RoadAuthority | null | undefined; roadsReason: string
  vehicles: Map<VehicleId, Vehicle>
  byInstance: Map<string, Set<Vehicle>>
  seatOf: Map<MemberId, { vehicle: Vehicle; seatId: SeatId }>
  heldOf: Map<MemberId, { vehicle: Vehicle; seatId: SeatId; place: Place }>
  /** Where a member whose seat was given up is put down when they come back. */
  foot: Map<MemberId, { pose: Pose; until: number }>
  active: Set<Vehicle>
  /** Vehicles with someone getting in or out. The step closes their doors when the time is up. */
  doors: Set<Vehicle>
  invites: Map<VehicleInviteId, VehicleInvite>
  offers: Map<string, DriverOfferRec>
  quotes: Map<VehicleQuoteId, QuoteRec>
  crossings: Map<string, Crossing>
  /** Members the service is moving between rooms itself: their leaving and entering is not a walk-out. */
  moving: Set<MemberId>
  /** Outcomes of unpaid requests, so a retry changes nothing. Paid ones are saved in the slice. */
  requests: Map<MemberId, Map<string, { key: string; result: Record<string, unknown>; at: number }>>
  /** Instances whose depots have been stocked: the service vehicles standing at each. */
  fleets: Map<string, { place: Place; standing: Map<string, VehicleId> }>
  berths: Map<string, { pos: Vec2; heading: number }[]>
}
const runtimes = new WeakMap<World, Runtime>()
const homeSolids = (rt: Runtime, districtId: DistrictId): RoadSolid[] => homeObstacles(rt.world, districtId).obstacles.map(solid => ({ kind: 'building', outer: solid.outer, holes: solid.holes, ...solid.bounds }))
const instanceKey = (place: { key: RoomKey; instance: number }): string => `${place.key}#${place.instance}`

/** For checks and for a build with its own data: give this world its road data. Only ever called by the service's own code. */
export function setVehicleRoadData(world: World, dataset: VehicleRoadDataset | null): void {
  const rt = runtimes.get(world)
  if (!rt) throw new Error('Vehicles are not registered on this world.')
  rt.roads = dataset ? new RoadAuthority(dataset) : null
  rt.roadsReason = dataset ? '' : NO_ROADS
  rt.berths.clear()
  if (dataset) holdHomeParcelsToRoads(world, dataset)
}

/** Read and index the road data now (a second or two for the full dataset) instead of on the first request that needs it. */
export function prepareVehicleRoads(world: World): { available: boolean; reason: string } {
  const rt = runtimes.get(world)
  if (!rt) throw new Error('Vehicles are not registered on this world.')
  return { available: roadsOf(rt) !== null, reason: rt.roadsReason }
}

function roadsOf(rt: Runtime): RoadAuthority | null {
  if (rt.roads === undefined) {
    const shipped = shippedRoadAuthority()
    rt.roads = shipped.authority
    rt.roadsReason = shipped.reason
    if (rt.roads) holdHomeParcelsToRoads(rt.world, rt.roads)
  }
  return rt.roads
}

// ── Small helpers ─────────────────────────────────────────────────────────────────────────────

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/
const SEAT_ID = /^(driver|passenger-\d{1,2})$/
const requestId = (raw: Raw): string => {
  const value = str(raw, 'requestId', { min: 8, max: 64 })
  if (!REQUEST_ID.test(value)) throw new WorldError('invalid', 'requestId is not valid')
  return value
}
const vehicleId = (raw: Raw): VehicleId => id<VehicleId>(raw, 'vehicleId', 'vh')
const revisionIn = (raw: Raw): number => num(raw, 'expectedRevision', { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
function seatIn(raw: Raw): SeatId {
  const value = str(raw, 'seatId', { min: 6, max: 12 })
  if (!SEAT_ID.test(value)) throw new WorldError('invalid', 'seatId is not a seat')
  return value as SeatId
}
function entryIn(raw: Raw): string {
  const value = str(raw, 'entryId', { min: 2, max: 24 })
  if (!/^[a-z-]+$/.test(value)) throw new WorldError('invalid', 'entryId is not an entry')
  return value
}
function destinationIn(value: unknown): VehicleDestination {
  const raw = obj(value, 'destination')
  const kind = oneOf(raw, 'kind', ['point', 'place'] as const)
  const districtId = str(raw, 'districtId', { max: 40 }) as DistrictId
  if (!parseDistrictId(districtId)) throw new WorldError('invalid', 'destination.districtId is not a valid district')
  if (kind === 'place') {
    const placeId = str(raw, 'placeId', { min: 1, max: 80 })
    if (!/^[A-Za-z0-9:_-]+$/.test(placeId)) throw new WorldError('invalid', 'destination.placeId is not valid')
    return { kind, districtId, placeId: placeId as PlaceId }
  }
  const pos = obj(raw.pos, 'destination.pos')
  const limit = DISTRICT_HALF_SPAN_LIMIT
  return { kind, districtId, pos: { x: num(pos, 'x', { min: -limit, max: limit }), z: num(pos, 'z', { min: -limit, max: limit }) } }
}

const moving = (vehicle: Vehicle): boolean => Math.abs(vehicle.speed) >= STOPPED
const seatSpec = (vehicle: Vehicle, seatId: SeatId): VehicleSeatSpec | undefined => vehicle.spec.seats.find(entry => entry.id === seatId)
const seatPos = (vehicle: Vehicle, spec: VehicleSeatSpec): Vec2 => vehiclePoint(vehicle.pos, vehicle.heading, spec.x, spec.z)
const seated = (vehicle: Vehicle): MemberId[] => { const out: MemberId[] = []; for (const seat of vehicle.seats.values()) if (seat.memberId) out.push(seat.memberId); return out }
const aboard = (vehicle: Vehicle): MemberId[] => { const out = seated(vehicle); for (const seat of vehicle.seats.values()) if (seat.held) out.push(seat.held.memberId); return out }
const viewers = (world: World, vehicle: Vehicle): MemberId[] => standingIn(world, vehicle.room.key, vehicle.room.instance).map(entry => entry.memberId)
const districtRef = (districtId: DistrictId): RoomRef => ({ kind: 'district', districtId })
const mutualFriends = (world: World, a: MemberId, b: MemberId): boolean => areFriends(world, a, b) && areFriends(world, b, a) && friendTag(world, a, b) === null
const WHY: Record<Blocker | 'vehicle' | 'person', string> = {
  bounds: 'This is the edge of the district and the road does not carry on here.', 'off-road': 'That is off the road.',
  building: 'A building is in the way.', water: 'That is water.', prop: 'Something on the street is in the way.',
  vehicle: 'Another vehicle is in the way.', person: 'Someone is in the way.',
}

function findVehicle(rt: Runtime, vehicleIdValue: VehicleId): Vehicle {
  const found = rt.vehicles.get(vehicleIdValue)
  if (!found) throw new WorldError('not_found', 'That vehicle is not here.')
  return found
}

function checkRevision(vehicle: Vehicle, expected: number): void {
  if (vehicle.revision !== expected) throw new WorldError('conflict', 'The vehicle has changed since you looked. Look again.')
}

/** The vehicle must be in the member's own room instance. */
function here(world: World, vehicle: Vehicle, memberId: MemberId): NonNullable<ReturnType<typeof placeOf>> {
  const place = placeOf(world, memberId)
  if (!place || place.key !== vehicle.room.key || place.instance !== vehicle.room.instance) throw new WorldError('forbidden', 'That vehicle is not where you are.')
  return place
}

// ── What a member is shown ────────────────────────────────────────────────────────────────────

function snapshotFor(world: World, vehicle: Vehicle, viewer: MemberId): VehicleSnapshot {
  const hidden = (memberId: MemberId): boolean => memberId !== viewer && isBlockedEitherWay(world, viewer, memberId)
  const seats: VehicleSeat[] = vehicle.spec.seats.map(spec => {
    const state = vehicle.seats.get(spec.id)!
    // A seat kept for someone who dropped is taken, and that person is not here to be named.
    const occupant = state.memberId ? (hidden(state.memberId) ? { kind: 'hidden' as const } : { kind: 'member' as const, memberId: state.memberId }) : state.held ? { kind: 'hidden' as const } : null
    return { id: spec.id, role: spec.role, occupant, reservedByService: vehicle.source === 'service' && spec.role === 'driver' }
  })
  const control: VehicleSnapshot['control'] = vehicle.control.kind === 'member'
    ? { kind: 'member', driverId: hidden(vehicle.control.driverId) ? null : vehicle.control.driverId, controlEpoch: vehicle.control.controlEpoch }
    : vehicle.control.kind === 'service' ? { kind: 'service', bookingMemberId: hidden(vehicle.control.bookingMemberId) ? null : vehicle.control.bookingMemberId }
    : { kind: 'none' }
  const trip = vehicle.trip
  // Only what is still under way: a door whose time is up is shut, whether or not the step has got to it yet.
  const at = world.now()
  const transitions: VehicleTransition[] = vehicle.transitions.filter(entry => entry.endsAt > at).map(entry => ({
    id: entry.id, kind: entry.kind, entryId: entry.entryId, seatId: entry.seatId,
    member: hidden(entry.memberId) ? { kind: 'hidden' } : { kind: 'member', memberId: entry.memberId }, startedAt: iso(entry.startedAt), endsAt: iso(entry.endsAt),
  }))
  return {
    id: vehicle.id, kind: vehicle.kind, source: vehicle.source, revision: vehicle.revision, epoch: vehicle.epoch,
    room: { key: vehicle.room.key, instance: vehicle.room.instance, districtId: vehicle.room.districtId },
    pos: { ...vehicle.pos }, heading: vehicle.heading, speed: vehicle.speed, steering: vehicle.steering, phase: vehicle.phase,
    ownerId: vehicle.ownerId && !hidden(vehicle.ownerId) ? vehicle.ownerId : null, access: vehicle.access, control, seats,
    openEntries: [...new Set(transitions.map(entry => entry.entryId))], transitions,
    trip: trip ? { id: trip.id, destination: trip.destination, label: trip.label, mode: trip.mode, fare: trip.fare, state: trip.state } : null,
  }
}

const driverOfferView = (offer: DriverOffer): DriverOffer => ({ id: offer.id, vehicleId: offer.vehicleId, from: offer.from, to: offer.to, expiresAt: offer.expiresAt })

function selfOf(world: World, rt: Runtime, memberId: MemberId): VehicleSelf {
  const seat = rt.seatOf.get(memberId)
  let vehicle = seat?.vehicle ?? null
  if (!vehicle) {
    // Not seated: their borrowed vehicle, when it is in the room with them.
    const loan = saved(world)?.loans[memberId]
    const mine = loan ? rt.vehicles.get(loan.vehicleId) : undefined
    const place = mine ? placeOf(world, memberId) : null
    if (mine && place && place.key === mine.room.key && place.instance === mine.room.instance) vehicle = mine
  }
  let offer: DriverOffer | null = null
  const now = world.now()
  for (const entry of rt.offers.values()) if (entry.to === memberId && Date.parse(entry.expiresAt) > now) offer = driverOfferView(entry)
  return {
    seat: seat ? { vehicleId: seat.vehicle.id, seatId: seat.seatId } : null,
    vehicle: vehicle ? snapshotFor(world, vehicle, memberId) : null,
    balance: careerPoints(world, memberId), offer, notice: seat ? seat.vehicle.notice : '',
  }
}

const pushSelf = (world: World, rt: Runtime, memberId: MemberId): void => world.push(memberId, { type: 'vehicle.self', self: selfOf(world, rt, memberId) })

/** Seats, access, control, phase or trip changed: a new revision, shown to everyone in the room and to everyone aboard. */
function publish(world: World, rt: Runtime, vehicle: Vehicle): void {
  vehicle.revision++
  for (const viewer of viewers(world, vehicle)) world.push(viewer, { type: 'vehicle.snapshot', vehicle: snapshotFor(world, vehicle, viewer) })
  for (const memberId of seated(vehicle)) pushSelf(world, rt, memberId)
}

function say(world: World, rt: Runtime, vehicle: Vehicle, notice: string): void {
  if (vehicle.notice === notice) return
  vehicle.notice = notice
  for (const memberId of seated(vehicle)) pushSelf(world, rt, memberId)
}

// ── Vehicles in rooms ─────────────────────────────────────────────────────────────────────────

function addVehicle(rt: Runtime, world: World, init: { id: VehicleId; kind: VehicleKind; source: 'borrowed' | 'service'; ownerId: MemberId | null; access: VehicleAccess; depotId: string; room: Place; pos: Vec2; heading: number }): Vehicle {
  const spec = VEHICLE_SPECS[init.kind]
  const vehicle: Vehicle = {
    ...init, spec, pos: { ...init.pos }, speed: 0, steering: 0, phase: 'parked', revision: 1, epoch: `${rt.boot}-${++rt.counter}`, tick: 0,
    seats: new Map(spec.seats.map(seat => [seat.id, { memberId: null, held: null }])), control: { kind: 'none' }, input: null, lastSeq: -1,
    grants: new Map(), trip: null, exitWanted: new Map(), putDown: new Set(), transitions: [], notice: '',
    simAt: world.now(), carry: 0, sentAt: 0, dirty: false, stillSince: null, emptySince: world.now(), crossing: null, crossAfter: 0, rideEndedAt: null,
  }
  rt.vehicles.set(vehicle.id, vehicle)
  const key = instanceKey(vehicle.room)
  const set = rt.byInstance.get(key)
  if (set) set.add(vehicle); else rt.byInstance.set(key, new Set([vehicle]))
  for (const viewer of viewers(world, vehicle)) world.push(viewer, { type: 'vehicle.snapshot', vehicle: snapshotFor(world, vehicle, viewer) })
  return vehicle
}

/** Take a vehicle out of its room. Nobody may be in it. */
function removeVehicle(world: World, rt: Runtime, vehicle: Vehicle, reason: 'returned' | 'withdrawn'): void {
  const crossing = vehicle.crossing ? rt.crossings.get(vehicle.crossing) : undefined
  if (crossing) dropCrossing(world, rt, crossing)
  for (const [memberId, held] of [...rt.heldOf]) if (held.vehicle === vehicle) releaseHeld(world, rt, memberId)
  rt.vehicles.delete(vehicle.id)
  rt.active.delete(vehicle)
  rt.doors.delete(vehicle)
  const key = instanceKey(vehicle.room)
  const set = rt.byInstance.get(key)
  set?.delete(vehicle)
  if (set?.size === 0) rt.byInstance.delete(key)
  for (const [inviteId, invite] of rt.invites) if (invite.vehicleId === vehicle.id) rt.invites.delete(inviteId)
  for (const [offerId, offer] of rt.offers) if (offer.vehicleId === vehicle.id) rt.offers.delete(offerId)
  for (const fleet of rt.fleets.values()) for (const [slot, standing] of fleet.standing) if (standing === vehicle.id) fleet.standing.delete(slot)
  world.pushMany(viewers(world, vehicle), { type: 'vehicle.removed', vehicleId: vehicle.id, epoch: vehicle.epoch, reason })
}

/** Would a vehicle of this kind standing here touch another vehicle in the instance. */
function vehicleInTheWay(rt: Runtime, place: { key: RoomKey; instance: number }, kind: VehicleKind, pos: Vec2, heading: number, except: Vehicle | null, grow = 0.1): boolean {
  const box = vehicleCorners(kind, pos, heading, grow)
  for (const other of rt.byInstance.get(instanceKey(place)) ?? []) if (other !== except && boxesOverlap(box, vehicleCorners(other.kind, other.pos, other.heading))) return true
  return false
}

/** The places vehicles stand at a depot: along the kerb to the right of the way the depot faces, clear of everything. */
function berthsOf(rt: Runtime, roads: RoadAuthority, districtId: DistrictId, depot: { id: string; pos: Vec2; heading: number }): { pos: Vec2; heading: number }[] {
  const known = rt.berths.get(depot.id)
  if (known) return known
  // Along the depot's own road, round its bends: the depot, then alternately ahead of it and behind it. Each place is hard against
  // the right-hand kerb, facing the way the depot faces, and is used only if the widest vehicle is clear of everything there.
  const widest = VEHICLE_SPECS.danfo.footprint.halfWidth
  const distances = [0]
  for (let n = 1; n <= BERTHS; n++) distances.push(n * BERTH_SPACING, -n * BERTH_SPACING)
  const out: { pos: Vec2; heading: number }[] = []
  for (const station of roads.stations(districtId, depot.pos, depot.heading, distances)) {
    if (!station || out.length >= BERTHS) continue
    const pos = vehiclePoint(station.pos, station.heading, -Math.max(0, station.half - widest), 0)
    if (roads.blockedAt('danfo', districtId, pos, station.heading, homeSolids(rt, districtId)) === null) out.push({ pos, heading: station.heading })
  }
  rt.berths.set(depot.id, out)
  return out
}

/** Stand the service's own vehicles at the depots of a room instance that has someone in it. */
function stock(world: World, rt: Runtime, place: Place): void {
  const roads = roadsOf(rt)
  if (!roads?.supports(place.districtId)) return
  const key = instanceKey(place)
  let fleet = rt.fleets.get(key)
  if (!fleet) { fleet = { place, standing: new Map() }; rt.fleets.set(key, fleet) }
  for (const depot of roads.depotsOf(place.districtId)) {
    const berths = berthsOf(rt, roads, place.districtId, depot)
    for (const [index, kind] of (['danfo', 'keke'] as const).entries()) {
      const slot = `${depot.id}:${kind}`
      const berth = berths[index]
      if (!berth || fleet.standing.has(slot) || vehicleInTheWay(rt, place, kind, berth.pos, berth.heading, null)) continue
      fleet.standing.set(slot, addVehicle(rt, world, { id: newId<VehicleId>('vh'), kind, source: 'service', ownerId: null, access: 'invite', depotId: depot.id, room: place, pos: berth.pos, heading: berth.heading }).id)
    }
  }
}

/** A free place at a depot for a borrowed vehicle: any berth the service's own vehicles do not use, else any. */
function freeBerth(rt: Runtime, roads: RoadAuthority, place: Place, depotId: string, kind: VehicleKind): { pos: Vec2; heading: number } | null {
  const found = roads.depot(depotId)
  if (!found || found.districtId !== place.districtId) return null
  const berths = berthsOf(rt, roads, place.districtId, found.depot)
  for (const berth of [...berths.slice(2), ...berths.slice(0, 2)]) if (!vehicleInTheWay(rt, place, kind, berth.pos, berth.heading, null)) return berth
  return null
}

/** Bring a member's borrowed vehicle into the room they are in, where it was parked. */
function bringLoan(world: World, rt: Runtime, memberId: MemberId): Vehicle | null {
  const loan = saved(world)?.loans[memberId]
  const roads = roadsOf(rt)
  const at = placeOf(world, memberId)
  if (!loan || !roads || !at || at.ref.kind !== 'district') return null
  const place: Place = { ref: at.ref, key: at.key, instance: at.instance, districtId: at.ref.districtId }
  const existing = rt.vehicles.get(loan.vehicleId)
  if (existing) {
    if (instanceKey(existing.room) === instanceKey(place) || aboard(existing).length > 0 || existing.room.districtId !== place.districtId) return existing
    // Parked in another instance of the same district with nobody in it: it follows its borrower.
    removeVehicle(world, rt, existing, 'withdrawn')
  }
  if (loan.checkpoint.districtId !== place.districtId || !roads.supports(place.districtId)) return null
  let pose: { pos: Vec2; heading: number } | null = loan.checkpoint
  if (roads.blockedAt(loan.kind, place.districtId, pose.pos, pose.heading, homeSolids(rt, place.districtId)) !== null || vehicleInTheWay(rt, place, loan.kind, pose.pos, pose.heading, null)) pose = freeBerth(rt, roads, place, loan.depotId, loan.kind)
  if (!pose) return null
  return addVehicle(rt, world, { id: loan.vehicleId, kind: loan.kind, source: 'borrowed', ownerId: memberId, access: loan.access, depotId: loan.depotId, room: place, pos: pose.pos, heading: pose.heading })
}

/** Remember where a borrowed vehicle is parked. Called when it comes to rest, never while it moves. */
function saveCheckpoint(world: World, vehicle: Vehicle): void {
  if (vehicle.source !== 'borrowed' || !vehicle.ownerId) return
  world.scoped(() => {
    const loan = slice(world).loans[vehicle.ownerId!]
    if (!loan || loan.vehicleId !== vehicle.id) return
    loan.checkpoint = { districtId: vehicle.room.districtId, pos: { ...vehicle.pos }, heading: vehicle.heading }
    world.touch()
  })
}

// ── Seats ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Someone starts getting in or out through an entry: its door is open until the time is up, and
 * the vehicle does not move meanwhile. The service alone opens and closes doors.
 */
function passThrough(world: World, rt: Runtime, vehicle: Vehicle, kind: 'board' | 'exit', entryId: string, seatId: SeatId, memberId: MemberId): void {
  const now = world.now()
  vehicle.transitions = vehicle.transitions.filter(entry => entry.memberId !== memberId)
  vehicle.transitions.push({ id: `vd_${randomToken(10)}`, kind, entryId, seatId, memberId, startedAt: now, endsAt: now + (kind === 'board' ? VEHICLE_RULES.boardMs : VEHICLE_RULES.exitMs) })
  rt.doors.add(vehicle)
}

/** Shut the doors whose time is up. Returns whether anything changed. */
function closeDoors(rt: Runtime, vehicle: Vehicle, now: number): boolean {
  const before = vehicle.transitions.length
  vehicle.transitions = vehicle.transitions.filter(entry => entry.endsAt > now)
  if (vehicle.transitions.length === 0) rt.doors.delete(vehicle)
  return vehicle.transitions.length !== before
}

/** Is another seat between this entry and this seat taken (a kept seat counts). */
function barred(vehicle: Vehicle, spec: VehicleSeatSpec, entryId: string): boolean {
  return (spec.across[entryId] ?? []).some(between => { const state = vehicle.seats.get(between); return Boolean(state?.memberId || state?.held) })
}

function sit(world: World, rt: Runtime, vehicle: Vehicle, spec: VehicleSeatSpec, memberId: MemberId): void {
  vehicle.seats.set(spec.id, { memberId, held: null })
  rt.seatOf.set(memberId, { vehicle, seatId: spec.id })
  takeHeldPlace(world, rt, memberId)
  rt.foot.delete(memberId)
  vehicle.emptySince = null
  placeOccupant(world, memberId, seatPos(vehicle, spec), vehicle.heading, false)
  announce(world, memberId)
}

function takeControl(rt: Runtime, vehicle: Vehicle, driverId: MemberId): void {
  vehicle.control = { kind: 'member', driverId, controlEpoch: `${rt.boot}-c${++rt.counter}` }
  vehicle.input = null
  vehicle.lastSeq = -1
}

/** Nobody is at the wheel any more: the vehicle brakes to a stop where it is. */
function dropControl(rt: Runtime, vehicle: Vehicle): void {
  if (vehicle.control.kind !== 'member') return
  vehicle.control = { kind: 'none' }
  vehicle.input = null
  vehicle.epoch = `${rt.boot}-${++rt.counter}`
  if (moving(vehicle)) { vehicle.phase = 'stopping'; rt.active.add(vehicle) }
}

/**
 * Where someone leaving this seat may stand: beside an entry of their own seat first, then any
 * other, each also tried a little forward and back. Clear of buildings and street furniture,
 * inside the district, outside every vehicle, and not where another of `taken` is being put.
 */
function exitSpot(rt: Runtime, vehicle: Vehicle, spec: VehicleSeatSpec, taken: Vec2[]): { pos: Vec2; heading: number; entryId: string } | null {
  const roads = roadsOf(rt)
  if (!roads) return null
  // Out by a door of their own seat with nobody sitting in the way; failing that, by any door of their own seat; failing that, by any door.
  // Nobody is kept in a vehicle because someone else is sitting between them and the door.
  const own = spec.entries.map(entryId => vehicle.spec.entries.find(entry => entry.id === entryId)!).filter(Boolean)
  const clear = own.filter(entry => !barred(vehicle, spec, entry.id))
  const order = [...clear, ...own.filter(entry => !clear.includes(entry)), ...vehicle.spec.entries.filter(candidate => !own.includes(candidate))]
  // Clear of every other vehicle by a quarter of a metre. Its own entries are outside its own body by design, so for itself only the body counts:
  // a rider steps out beside the door they used, not round the corner from it.
  const boxes = [...(rt.byInstance.get(instanceKey(vehicle.room)) ?? [])].map(other => vehicleCorners(other.kind, other.pos, other.heading, other === vehicle ? 0 : 0.25))
  for (const entry of order) {
    for (const shift of [0, 0.8, -0.8, 1.6, -1.6]) {
      const pos = vehiclePoint(vehicle.pos, vehicle.heading, entry.x, entry.z + shift)
      if (!roads.standable(vehicle.room.districtId, pos, 0.4, homeSolids(rt, vehicle.room.districtId))) continue
      if (boxes.some(box => pointInBox(pos, box)) || taken.some(other => Math.hypot(other.x - pos.x, other.z - pos.z) < 0.6)) continue
      // Facing away from the vehicle.
      return { pos, heading: vehicle.heading + (entry.side === 'left' ? Math.PI / 2 : -Math.PI / 2), entryId: entry.id }
    }
  }
  return null
}

/** Empty a seat. `to` stands the member in the room; without it they are no longer there to stand. */
function unsit(world: World, rt: Runtime, vehicle: Vehicle, memberId: MemberId, to: { pos: Vec2; heading: number; entryId: string } | null): void {
  const seat = rt.seatOf.get(memberId)
  if (!seat || seat.vehicle !== vehicle) return
  vehicle.seats.set(seat.seatId, { memberId: null, held: null })
  if (to) passThrough(world, rt, vehicle, 'exit', to.entryId, seat.seatId, memberId)
  else vehicle.transitions = vehicle.transitions.filter(entry => entry.memberId !== memberId)
  rt.seatOf.delete(memberId)
  vehicle.exitWanted.delete(memberId)
  vehicle.putDown.delete(memberId)
  if (vehicle.control.kind === 'member' && vehicle.control.driverId === memberId) dropControl(rt, vehicle)
  for (const [offerId, offer] of rt.offers) if (offer.vehicleId === vehicle.id && (offer.from === memberId || offer.to === memberId)) rt.offers.delete(offerId)
  if (aboard(vehicle).length === 0) vehicle.emptySince = world.now()
  if (to) { placeOccupant(world, memberId, to.pos, to.heading, false); announce(world, memberId) }
}

/** A kept seat owns one exact source-instance hold. Taking ownership releases it once. */
function takeHeldPlace(world: World, rt: Runtime, memberId: MemberId): { vehicle: Vehicle; seatId: SeatId; place: Place } | undefined {
  const held = rt.heldOf.get(memberId)
  if (!held) return undefined
  rt.heldOf.delete(memberId)
  releasePlaces(world, held.place.ref, held.place.instance, 1)
  return held
}

/** Give up a seat that was being kept for someone who dropped. They come back on foot. */
function releaseHeld(world: World, rt: Runtime, memberId: MemberId): void {
  const held = takeHeldPlace(world, rt, memberId)
  if (!held) return
  const { vehicle } = held
  const spec = seatSpec(vehicle, held.seatId)
  const spot = spec ? exitSpot(rt, vehicle, spec, []) : null
  if (spot) rt.foot.set(memberId, { pose: { districtId: vehicle.room.districtId, ...spot }, until: world.now() + 10 * MINUTE })
  vehicle.seats.set(held.seatId, { memberId: null, held: null })
  if (aboard(vehicle).length === 0) vehicle.emptySince = world.now()
  publish(world, rt, vehicle)
}

/** May this member take this seat, by the vehicle's own rules. The sentence to show when not; null when they may. */
function refusal(world: World, rt: Runtime, vehicle: Vehicle, spec: VehicleSeatSpec, memberId: MemberId): string | null {
  const state = vehicle.seats.get(spec.id)!
  if (state.memberId || state.held) return 'That seat is taken.'
  // Never into a vehicle with someone the member is blocked with, whichever of them did the blocking. The sentence names nobody.
  const party = [...aboard(vehicle), ...(vehicle.ownerId ? [vehicle.ownerId] : []), ...(vehicle.trip?.payer ? [vehicle.trip.payer] : [])]
  if (party.some(other => other !== memberId && isBlockedEitherWay(world, memberId, other))) return 'You cannot board this vehicle.'
  if (vehicle.source === 'service') {
    if (spec.role === 'driver') return 'That seat is the driver\'s.'
    const trip = vehicle.trip
    if (!trip || trip.mode !== 'paid-service') return 'Book this vehicle to ride in it.'
    if (trip.state !== 'boarding') return 'This ride has already left.'
    return trip.payer === memberId || vehicle.grants.has(memberId) ? null : 'This ride was booked by someone else. Ask them to invite you.'
  }
  if (vehicle.ownerId === memberId) return null
  if (vehicle.access === 'owner') return 'Only the member who borrowed this vehicle may use it.'
  const grant = vehicle.grants.get(memberId)
  if (spec.role === 'driver') return grant === 'driver' ? null : 'You have not been given the wheel of this vehicle.'
  if (grant || (vehicle.access === 'friends' && vehicle.ownerId !== null && mutualFriends(world, vehicle.ownerId, memberId))) return null
  return 'You need an invitation to board this vehicle.'
}

/**
 * May a member whose seat was kept come back to it? Asked afresh when they return: a block made
 * while they were away, an invitation withdrawn, access narrowed or a ride that has ended all
 * count. It is not the test for a new boarding (the seat is theirs to come back to, so it is not
 * "taken"), but nothing else is taken on trust.
 */
function mayKeepSeat(world: World, vehicle: Vehicle, spec: VehicleSeatSpec, memberId: MemberId): boolean {
  const party = [...aboard(vehicle), ...(vehicle.ownerId ? [vehicle.ownerId] : []), ...(vehicle.trip?.payer ? [vehicle.trip.payer] : [])]
  if (party.some(other => other !== memberId && isBlockedEitherWay(world, memberId, other))) return false
  if (vehicle.source === 'service') {
    const trip = vehicle.trip
    return spec.role !== 'driver' && trip?.mode === 'paid-service' && trip.state !== 'arrived' && (trip.payer === memberId || vehicle.grants.has(memberId))
  }
  if (vehicle.ownerId === memberId) return true
  if (vehicle.access === 'owner') return false
  const grant = vehicle.grants.get(memberId)
  if (spec.role === 'driver') return grant === 'driver'
  return grant !== undefined || (vehicle.access === 'friends' && vehicle.ownerId !== null && mutualFriends(world, vehicle.ownerId, memberId))
}

/** Free to be hired: the service's own, parked, with no ride and no crossing, and nobody in it or with a seat kept in it. One rule for the quote, the offer of the action and the booking. */
const hireable = (vehicle: Vehicle): boolean =>
  vehicle.source === 'service' && vehicle.trip === null && vehicle.crossing === null && vehicle.phase === 'parked' && !moving(vehicle) && aboard(vehicle).length === 0

/** Standing at this entry: within reach of the place the service knows for it, and on its side of the vehicle, not across it. */
function atEntry(vehicle: Vehicle, entryId: string, pos: Vec2): boolean {
  const entry = vehicle.spec.entries.find(candidate => candidate.id === entryId)
  if (!entry) return false
  const point = vehiclePoint(vehicle.pos, vehicle.heading, entry.x, entry.z)
  if (Math.hypot(point.x - pos.x, point.z - pos.z) > VEHICLE_RULES.boardRangeMetres) return false
  // How far to the vehicle's left the member stands (negative is its right).
  const aside = (pos.x - vehicle.pos.x) * Math.cos(vehicle.heading) - (pos.z - vehicle.pos.z) * Math.sin(vehicle.heading)
  return entry.side === 'left' ? aside > 0.2 : aside < -0.2
}

// ── Requests that must not happen twice ───────────────────────────────────────────────────────

function repeated(rt: Runtime, memberId: MemberId, request: string, key: string): Record<string, unknown> | null {
  const found = rt.requests.get(memberId)?.get(request)
  if (!found) return null
  if (found.key !== key) throw new WorldError('conflict', 'That request id was already used for something else.')
  return found.result
}
function remember(world: World, rt: Runtime, memberId: MemberId, request: string, key: string, result: Record<string, unknown>): void {
  let mine = rt.requests.get(memberId)
  if (!mine) { mine = new Map(); rt.requests.set(memberId, mine) }
  mine.set(request, { key, result, at: world.now() })
  if (mine.size > 60) for (const [name, entry] of mine) { if (mine.size <= 40) break; if (entry.at < world.now() - MINUTE) mine.delete(name) }
}

// ── Paid rides: the money ─────────────────────────────────────────────────────────────────────

/** Give a charter's fare back, once. The receipt records that it happened; a second call does nothing. */
function refund(world: World, receipt: ReceiptRec, reason: 'cancelled' | 'service-failure'): number {
  if (receipt.refund) return 0
  const text = reason === 'cancelled' ? `Refund: ride to ${receipt.label} cancelled` : `Refund: ride to ${receipt.label} could not be completed`
  const done = exists(world, receipt.memberId) ? refundVehicleFare(world, receipt.memberId, receipt.fare, text) : { ledgerId: '' }
  receipt.refund = { amount: receipt.fare, at: iso(world.now()), reason, ledgerId: done.ledgerId }
  world.touch()
  return receipt.fare
}

function closeReceipt(world: World, receiptId: string | null, state: ReceiptRec['state'], checkpoint: Pose | null = null): ReceiptRec | null {
  if (!receiptId) return null
  const receipt = slice(world).receipts[receiptId]
  if (!receipt) return null
  receipt.state = state
  receipt.closedAt = iso(world.now())
  if (checkpoint) receipt.checkpoint = checkpoint
  world.touch()
  return receipt
}

/** A paid ride ends without arriving. The vehicle stops where it is; everyone aboard stays seated until they step out. */
function endTrip(world: World, rt: Runtime, vehicle: Vehicle, outcome: 'cancelled' | 'failed' | 'abandoned', notice: string): void {
  const trip = vehicle.trip
  if (!trip) return
  // A ride that ends while its vehicle waits to cross does not cross: the crossing is called off first, and its tokens with it.
  const crossing = vehicle.crossing ? rt.crossings.get(vehicle.crossing) : undefined
  if (crossing) dropCrossing(world, rt, crossing)
  world.scoped(() => {
    const receipt = closeReceipt(world, trip.receiptId, outcome, { districtId: vehicle.room.districtId, pos: { ...vehicle.pos }, heading: vehicle.heading })
    if (receipt && outcome === 'failed') refund(world, receipt, 'service-failure')
  })
  vehicle.trip = null
  vehicle.control = { kind: 'none' }
  vehicle.grants.clear()
  for (const [memberId, held] of [...rt.heldOf]) if (held.vehicle === vehicle && !mayKeepSeat(world, vehicle, seatSpec(vehicle, held.seatId)!, memberId)) releaseHeld(world, rt, memberId)
  vehicle.rideEndedAt = world.now()
  vehicle.phase = moving(vehicle) ? 'stopping' : 'parked'
  if (moving(vehicle)) rt.active.add(vehicle)
  vehicle.notice = notice
  if (trip.payer) pushSelf(world, rt, trip.payer)
  publish(world, rt, vehicle)
}

// ── Crossing into the next district ───────────────────────────────────────────────────────────

/**
 * Take the vehicle and everyone seated in it into the next district together. Every one of them
 * must be allowed there by the travel rules, and one instance must have room for all. Each is
 * sent their own token and told which district to load; when all have answered, they move as one.
 * Returns why not, when it cannot begin.
 */
function beginCrossing(world: World, rt: Runtime, vehicle: Vehicle, toDistrict: DistrictId, spawn: Vec2, heading: number, resume: Crossing['resume']): string | null {
  // One crossing at a time. Whatever asked for another while one is waiting is told no and changes nothing.
  if (vehicle.crossing !== null) return 'The vehicle is already crossing into the next district.'
  const roads = roadsOf(rt)
  if (!roads?.supports(toDistrict)) return 'The road beyond here is not open to vehicles yet. Step out to walk on, or use Travel.'
  const party = seated(vehicle)
  if (party.length === 0) return 'Nobody is in the vehicle.'
  const ref = districtRef(toDistrict)
  // Nobody travels further in a vehicle than they could on foot: each rider's own range and trip are asked.
  if (party.some(memberId => streetAdmission(world, memberId, ref) !== null)) return 'Someone aboard cannot travel into the next district, so the vehicle has stopped at its edge. Step out here, or use Travel.'
  const instance = holdPlaces(world, ref, party.length)
  if (instance === null) return 'The next district is full right now. Try again shortly.'
  const now = world.now()
  const crossing: Crossing = {
    id: `vx_${randomToken(12)}`, vehicle, epoch: vehicle.epoch, to: { ref, key: roomKey(ref), instance, districtId: toDistrict }, spawn, heading, dataVersion: roads.dataVersion,
    expiresAt: now + VEHICLE_RULES.transferSeconds * SECOND, tokens: new Map(party.map(memberId => [memberId, randomToken(24)])), acked: new Set(), places: party.length,
    state: 'waiting', closedAt: 0, carried: [], resume,
  }
  rt.crossings.set(crossing.id, crossing)
  vehicle.crossing = crossing.id
  vehicle.speed = 0
  vehicle.input = null
  vehicle.phase = 'transferring'
  vehicle.notice = ''
  rt.active.delete(vehicle)
  publish(world, rt, vehicle)
  for (const memberId of crossing.tokens.keys()) tellCrossing(world, crossing, memberId)
  return null
}

/** Tell one rider which district to load and give them their own token for this crossing. */
function tellCrossing(world: World, crossing: Crossing, memberId: MemberId): void {
  const token = crossing.tokens.get(memberId)
  if (!token) return
  world.push(memberId, {
    type: 'vehicle.transfer', vehicleId: crossing.vehicle.id, transferId: crossing.id, token, expiresAt: iso(crossing.expiresAt),
    room: { key: crossing.to.key, instance: crossing.to.instance, districtId: crossing.to.districtId }, spawn: crossing.spawn, heading: crossing.heading,
  })
}

/** Is someone's seat in this vehicle being kept for them while their connection is down. */
const keepingSeat = (vehicle: Vehicle): boolean => { for (const seat of vehicle.seats.values()) if (seat.held) return true; return false }

/**
 * A crossing that can still happen: waiting, still the one its vehicle is in, that vehicle still
 * exists, and control of it has not been reset since. Anything else is a spent record.
 */
const pending = (rt: Runtime, crossing: Crossing): boolean =>
  crossing.state === 'waiting' && crossing.vehicle.crossing === crossing.id && rt.vehicles.get(crossing.vehicle.id) === crossing.vehicle && crossing.vehicle.epoch === crossing.epoch

/**
 * Call a waiting crossing off: its held places go back and nothing its tokens are sent with can
 * move anyone. Returns true when it was its vehicle's current crossing, and the vehicle is then
 * left stopped where it stood. A record that had been replaced leaves the vehicle exactly as it is.
 */
function dropCrossing(world: World, rt: Runtime, crossing: Crossing): boolean {
  if (crossing.state !== 'waiting') return false
  crossing.state = 'aborted'
  crossing.closedAt = world.now()
  releasePlaces(world, crossing.to.ref, crossing.to.instance, crossing.places)
  const vehicle = crossing.vehicle
  if (vehicle.crossing !== crossing.id) return false
  vehicle.crossing = null
  vehicle.crossAfter = world.now() + 2 * SECOND
  vehicle.phase = 'parked'
  return true
}

/** Call a crossing off and let its vehicle carry on as it was: a paid ride tries again shortly, a driven vehicle stays parked at the edge. */
function abortCrossing(world: World, rt: Runtime, crossing: Crossing, notice: string): void {
  if (!dropCrossing(world, rt, crossing)) return
  const vehicle = crossing.vehicle
  const trip = vehicle.trip
  if (trip?.mode === 'paid-service' && trip.state === 'en-route') {
    // A paid ride tries again shortly; three failures and the service gives up and gives the fare back.
    if (++trip.failedCrossings >= 3) { endTrip(world, rt, vehicle, 'failed', 'The ride could not carry on into the next district. Your fare has been returned.'); return }
    vehicle.phase = 'driving'
    vehicle.simAt = world.now()
    rt.active.add(vehicle)
  }
  vehicle.notice = notice
  publish(world, rt, vehicle)
}

/**
 * Has everyone answered? The party is whoever is seated now, and every one of them must have been
 * given a token for this crossing and have answered with it. While a seat is being kept for
 * someone who dropped, the vehicle waits: it neither goes on without them nor carries them unseen.
 * Their seat is theirs until its grace is up; then it is given up and this is asked again.
 */
function settleCrossing(world: World, rt: Runtime, crossing: Crossing): void {
  if (crossing.state !== 'waiting') return
  if (!pending(rt, crossing)) { abortCrossing(world, rt, crossing, 'The crossing was called off. Try again.'); return }
  const vehicle = crossing.vehicle
  if (keepingSeat(vehicle) || vehicle.putDown.size > 0) return
  const party = seated(vehicle)
  if (party.length === 0) { abortCrossing(world, rt, crossing, 'Nobody is in the vehicle.'); return }
  if (party.every(memberId => crossing.tokens.has(memberId) && crossing.acked.has(memberId))) commitCrossing(world, rt, crossing)
}

/** Move the vehicle and everyone seated in it across, in one go. False, with the crossing called off, when it can no longer be done. */
function commitCrossing(world: World, rt: Runtime, crossing: Crossing): boolean {
  const vehicle = crossing.vehicle
  const roads = roadsOf(rt)
  const party = seated(vehicle)
  if (!pending(rt, crossing) || !roads || roads.dataVersion !== crossing.dataVersion || party.length === 0 || keepingSeat(vehicle) || party.some(memberId => !crossing.tokens.has(memberId) || !crossing.acked.has(memberId))) {
    abortCrossing(world, rt, crossing, 'The crossing was called off. Try again.')
    return false
  }
  if (vehicleInTheWay(rt, crossing.to, vehicle.kind, crossing.spawn, crossing.heading, vehicle)) { abortCrossing(world, rt, crossing, 'Another vehicle is in the way on the other side. Try again shortly.'); return false }
  const old = viewers(world, vehicle).filter(memberId => !party.includes(memberId))
  world.pushMany(old, { type: 'vehicle.removed', vehicleId: vehicle.id, epoch: vehicle.epoch, reason: 'transferred' })
  const before = instanceKey(vehicle.room)
  const set = rt.byInstance.get(before)
  set?.delete(vehicle)
  if (set?.size === 0) rt.byInstance.delete(before)
  vehicle.room = crossing.to
  vehicle.pos = { ...crossing.spawn }
  vehicle.heading = crossing.heading
  vehicle.speed = 0
  vehicle.crossing = null
  vehicle.simAt = world.now()
  const after = instanceKey(vehicle.room)
  const there = rt.byInstance.get(after)
  if (there) there.add(vehicle); else rt.byInstance.set(after, new Set([vehicle]))
  const trip = vehicle.trip
  if (trip && crossing.resume) { trip.index = crossing.resume.index; trip.along = { ...crossing.resume.along }; trip.failedCrossings = 0 }
  if (trip?.mode === 'paid-service' && trip.state === 'en-route') { vehicle.phase = 'driving'; rt.active.add(vehicle) } else vehicle.phase = 'parked'
  vehicle.revision++

  for (const memberId of party) {
    rt.moving.add(memberId)
    try {
      const spec = seatSpec(vehicle, rt.seatOf.get(memberId)!.seatId)!
      admitTo(world, memberId, crossing.to.ref, crossing.to.instance, seatPos(vehicle, spec), vehicle.heading)
    } finally { rt.moving.delete(memberId) }
  }
  releasePlaces(world, crossing.to.ref, crossing.to.instance, crossing.places)
  crossing.state = 'committed'
  crossing.closedAt = world.now()
  crossing.carried = party
  stock(world, rt, crossing.to)
  for (const memberId of party) {
    // The room as it is now that everyone has arrived.
    const room = roomFor(world, memberId)
    if (room) world.push(memberId, { type: 'vehicle.transferred', transferId: crossing.id, vehicle: snapshotFor(world, vehicle, memberId), self: selfOf(world, rt, memberId), snapshot: room })
  }
  for (const viewer of viewers(world, vehicle)) if (!party.includes(viewer)) world.push(viewer, { type: 'vehicle.snapshot', vehicle: snapshotFor(world, vehicle, viewer) })
  if (vehicle.source === 'borrowed') saveCheckpoint(world, vehicle)
  return true
}

// ── The step: where every moving vehicle goes next ────────────────────────────────────────────

/** What a move from where the vehicle is to `next` would run into, apart from the road data's own answer. */
function inTheWay(world: World, rt: Runtime, vehicle: Vehicle, next: { pos: Vec2; heading: number }): 'vehicle' | 'person' | null {
  const now = vehicleCorners(vehicle.kind, vehicle.pos, vehicle.heading), then = vehicleCorners(vehicle.kind, next.pos, next.heading, 0.05)
  for (const other of rt.byInstance.get(instanceKey(vehicle.room)) ?? []) {
    if (other === vehicle) continue
    const box = vehicleCorners(other.kind, other.pos, other.heading)
    // Two vehicles already touching may still pull apart.
    if (boxesOverlap(then, box) && !boxesOverlap(now, box)) return 'vehicle'
  }
  const wide = vehicleCorners(vehicle.kind, next.pos, next.heading, 0.3), wideNow = vehicleCorners(vehicle.kind, vehicle.pos, vehicle.heading, 0.3)
  for (const person of standingIn(world, vehicle.room.key, vehicle.room.instance)) {
    if (rt.seatOf.has(person.memberId)) continue
    // A vehicle stops for a person. It does not push them, and someone already beside it does not pin it.
    if (pointInBox(person.pos, wide) && !pointInBox(person.pos, wideNow)) return 'person'
  }
  return null
}

function carry(world: World, rt: Runtime, vehicle: Vehicle): void {
  const going = moving(vehicle)
  for (const [seatId, seat] of vehicle.seats) {
    if (!seat.memberId) continue
    placeOccupant(world, seat.memberId, seatPos(vehicle, seatSpec(vehicle, seatId)!), vehicle.heading, going)
  }
}

/** Tell the room where the vehicle is, and put everyone aboard where their seats now are. */
function report(world: World, rt: Runtime, vehicle: Vehicle, now: number): void {
  vehicle.dirty = false
  vehicle.sentAt = now
  carry(world, rt, vehicle)
  world.pushMany(viewers(world, vehicle), { type: 'vehicle.move', vehicleId: vehicle.id, epoch: vehicle.epoch, tick: vehicle.tick, ackSeq: vehicle.lastSeq, pos: { ...vehicle.pos }, heading: vehicle.heading, speed: vehicle.speed, steering: vehicle.steering, room: vehicle.room.key })
}

/** The vehicle has come to rest: it leaves the step until something moves it again. */
function rest(world: World, rt: Runtime, vehicle: Vehicle): void {
  rt.active.delete(vehicle)
  vehicle.speed = 0
  vehicle.stillSince = null
  // Where it stopped is always said, however lately the last position went out.
  if (vehicle.dirty) report(world, rt, vehicle, world.now())
  if (vehicle.phase === 'driving' || vehicle.phase === 'stopping') { vehicle.phase = vehicle.trip?.mode === 'paid-service' && vehicle.trip.state === 'boarding' ? 'boarding' : 'parked'; publish(world, rt, vehicle) }
  saveCheckpoint(world, vehicle)
}

function stepDriven(world: World, rt: Runtime, vehicle: Vehicle, now: number): void {
  const roads = roadsOf(rt)!
  const fresh = vehicle.control.kind === 'member' && vehicle.input !== null && now - vehicle.input.at <= VEHICLE_RULES.inputStaleMs
  // Someone wants out, someone is to be put down, or a door is open: the vehicle is braked whatever the driver asks.
  const wanted = vehicle.exitWanted.size > 0 || vehicle.putDown.size > 0 || vehicle.transitions.length > 0
  const controls = fresh && !wanted ? vehicle.input! : NEUTRAL_CONTROLS
  const next = stepVehicle(vehicle.kind, vehicle, controls, STEP / 1000)
  vehicle.tick++
  if (next.speed === 0 && vehicle.speed === 0) {
    vehicle.steering = next.steering
    vehicle.stillSince ??= now
    // Still, and nobody is asking it to move: parked.
    if (!fresh || wanted || now - vehicle.stillSince >= SECOND) rest(world, rt, vehicle)
    return
  }
  vehicle.stillSince = null
  let stopped: Blocker | 'vehicle' | 'person' | null = roads.sweep(vehicle.kind, vehicle.room.districtId, vehicle, next, homeSolids(rt, vehicle.room.districtId))
  if (stopped === 'bounds' && now >= vehicle.crossAfter) {
    // At the edge of the district on a road that carries on: everyone goes across together.
    const front = vehiclePoint(vehicle.pos, vehicle.heading, 0, vehicle.spec.footprint.front)
    const portal = roads.portalNear(vehicle.room.districtId, front, 9)
    const across = portal ? roads.across(vehicle.room.districtId, portal.toDistrict, vehicle.pos) : null
    if (portal && across && next.speed > 0) {
      // Far enough in that the whole vehicle is on the other side.
      const spawn = vehiclePoint(across, vehicle.heading, 0, vehicle.spec.footprint.front + vehicle.spec.footprint.rear + 0.6)
      const why = keepingSeat(vehicle) ? 'Waiting for a rider whose connection dropped.'
        : roads.blockedAt(vehicle.kind, portal.toDistrict, spawn, vehicle.heading, homeSolids(rt, portal.toDistrict)) !== null ? 'The road on the other side is not clear for a vehicle.' : beginCrossing(world, rt, vehicle, portal.toDistrict, spawn, vehicle.heading, null)
      if (why === null) return
      vehicle.crossAfter = now + 2 * SECOND
      if (vehicle.speed !== 0 || vehicle.steering !== next.steering) vehicle.dirty = true
      vehicle.speed = 0; vehicle.steering = next.steering
      say(world, rt, vehicle, why)
      return
    }
  }
  stopped ??= inTheWay(world, rt, vehicle, next)
  if (stopped) {
    // It stops where it is rather than go through anything.
    if (vehicle.speed !== 0 || vehicle.steering !== next.steering) vehicle.dirty = true
    vehicle.speed = 0; vehicle.steering = next.steering
    say(world, rt, vehicle, WHY[stopped])
    return
  }
  vehicle.pos = next.pos; vehicle.heading = next.heading; vehicle.speed = next.speed; vehicle.steering = next.steering; vehicle.dirty = true
  if (vehicle.notice) say(world, rt, vehicle, '')
  if (vehicle.phase === 'parked' && moving(vehicle)) { vehicle.phase = 'driving'; publish(world, rt, vehicle) }
  const trip = vehicle.trip
  if (trip?.mode === 'navigation' && trip.state === 'en-route' && trip.target.districtId === vehicle.room.districtId && Math.hypot(trip.target.pos.x - vehicle.pos.x, trip.target.pos.z - vehicle.pos.z) <= 15) { trip.state = 'arrived'; publish(world, rt, vehicle) }
}

const turnTo = (from: number, to: number, most: number): number => {
  let delta = to - from
  if (delta > Math.PI) delta -= 2 * Math.PI
  else if (delta < -Math.PI) delta += 2 * Math.PI
  const out = from + Math.max(-most, Math.min(most, delta))
  return out > Math.PI ? out - 2 * Math.PI : out <= -Math.PI ? out + 2 * Math.PI : out
}

/**
 * A vehicle the service is driving: along the centre line of its route, keeping to the right of
 * it, and moving across to pass something standing in its lane when the road is wide enough.
 * It stops for vehicles and people it cannot pass, and for a rider who wants to get out.
 */
function stepRoute(world: World, rt: Runtime, vehicle: Vehicle, trip: Trip, now: number): void {
  const dt = STEP / 1000
  const spec = vehicle.spec
  vehicle.tick++
  // Ended by its payer and now at a standstill, wherever that is: the ride is over here. It never starts a crossing to get there.
  if (trip.cancelling && !moving(vehicle)) { endTrip(world, rt, vehicle, 'cancelled', 'The ride was cancelled. Step out when you are ready.'); return }
  const target = trip.route[trip.index]
  if (!target || target.districtId !== vehicle.room.districtId) { endTrip(world, rt, vehicle, 'failed', 'The ride lost its route. Your fare has been returned.'); return }
  const dx = target.pos.x - trip.along.x, dz = target.pos.z - trip.along.z
  const left = Math.hypot(dx, dz)
  const last = trip.index === trip.route.length - 1
  if (left < 0.05) {
    // At a point of the route: the end of it, a crossing, or a corner.
    if (last) {
      if (moving(vehicle)) vehicle.speed = 0
      vehicle.dirty = true
      trip.state = 'arrived'
      vehicle.control = { kind: 'none' }
      world.scoped(() => { closeReceipt(world, trip.receiptId, 'arrived', { districtId: vehicle.room.districtId, pos: { ...vehicle.pos }, heading: vehicle.heading }) })
      vehicle.notice = `You have arrived: ${trip.label}.`
      vehicle.rideEndedAt = now
      vehicle.phase = 'driving'
      rest(world, rt, vehicle)
      return
    }
    const after = trip.route[trip.index + 1]!
    if (target.portal) {
      if (moving(vehicle)) { vehicle.speed = 0; vehicle.dirty = true }
      if (now < vehicle.crossAfter) return
      // A rider's seat is being kept: wait for them or for the grace to run out. This is not a failed crossing.
      if (keepingSeat(vehicle)) { say(world, rt, vehicle, 'Waiting for a rider whose connection dropped.'); return }
      const beyond = trip.route[trip.index + 2] ?? after
      const way = Math.atan2(beyond.pos.x - after.pos.x, beyond.pos.z - after.pos.z)
      const heading = beyond === after ? vehicle.heading : way
      const spawn = vehiclePoint(after.pos, heading, trip.lane, 0)
      const why = beginCrossing(world, rt, vehicle, after.districtId, spawn, heading, { index: trip.index + 2 < trip.route.length ? trip.index + 2 : trip.index + 1, along: { ...after.pos } })
      if (why !== null) {
        vehicle.crossAfter = now + 5 * SECOND
        if (++trip.failedCrossings >= 3) endTrip(world, rt, vehicle, 'failed', `${why} Your fare has been returned.`)
        else say(world, rt, vehicle, why)
      }
      return
    }
    // On to the next stretch, from exactly where the vehicle is: how far along it and how far to the side of it are worked out afresh.
    trip.index++
    const length = Math.hypot(after.pos.x - target.pos.x, after.pos.z - target.pos.z)
    if (length > 0) {
      const nx = (after.pos.x - target.pos.x) / length, nz = (after.pos.z - target.pos.z) / length
      const ahead = (vehicle.pos.x - target.pos.x) * nx + (vehicle.pos.z - target.pos.z) * nz
      trip.along = { x: target.pos.x + nx * ahead, z: target.pos.z + nz * ahead }
      trip.lane = (vehicle.pos.x - trip.along.x) * nz - (vehicle.pos.z - trip.along.z) * nx
    }
    return
  }
  const ux = dx / left, uz = dz / left
  const way = Math.atan2(ux, uz)
  const room = Math.max(0, target.half - spec.footprint.halfWidth + 0.3)
  const keep = -Math.min(room, spec.footprint.halfWidth + 0.25)
  const poseAt = (forward: number, lane: number): Vec2 => ({ x: trip.along.x + ux * forward + uz * lane, z: trip.along.z + uz * forward - ux * lane })
  const others = [...(rt.byInstance.get(instanceKey(vehicle.room)) ?? [])].filter(other => other !== vehicle).map(other => vehicleCorners(other.kind, other.pos, other.heading, 0.1))
  const here = vehicleCorners(vehicle.kind, vehicle.pos, vehicle.heading)
  const roads = roadsOf(rt)!
  /** Buildings, water and street furniture. The edge of the district is where the route crosses, so it does not count here. */
  const solidAt = (at: Vec2, facing: number): boolean => { const hit = roads.blockedAt(vehicle.kind, vehicle.room.districtId, at, facing, homeSolids(rt, vehicle.room.districtId)); return hit === 'building' || hit === 'water' || hit === 'prop' }
  // It looks as far ahead as it needs to stop in, and a little more.
  const sight = Math.min(30, Math.max(7.5, (vehicle.speed * vehicle.speed) / spec.braking + 5))
  // People standing in the road are gone round like anything else, where there is room; a vehicle never pushes past them.
  const hereWide = vehicleCorners(vehicle.kind, vehicle.pos, vehicle.heading, 0.3)
  const people = standingIn(world, vehicle.room.key, vehicle.room.instance).filter(person => !rt.seatOf.has(person.memberId) && !pointInBox(person.pos, hereWide)).map(person => person.pos)
  const clearAhead = (lane: number): boolean => {
    for (let forward = 2.5; forward <= sight; forward += 2.5) {
      const at = poseAt(Math.min(forward, left), lane)
      const box = vehicleCorners(vehicle.kind, at, way)
      if (others.some(other => boxesOverlap(box, other) && !boxesOverlap(here, other)) || solidAt(at, way)) return false
      if (people.length > 0) { const wide = vehicleCorners(vehicle.kind, at, way, 0.3); if (people.some(person => pointInBox(person, wide))) return false }
    }
    return true
  }
  // The lane to be in: the usual one if it is clear ahead, else the nearest to it that is.
  let lane: number | null = null
  const tried = [keep]
  for (let step = 0.5; step <= 2 * room + 0.5; step += 0.5) tried.push(Math.min(room, keep + step), Math.max(-room, keep - step))
  for (const candidate of tried) if (clearAhead(candidate)) { lane = candidate; break }

  const stopping = vehicle.exitWanted.size > 0 || vehicle.putDown.size > 0 || vehicle.transitions.length > 0 || trip.cancelling || lane === null
  // Slow for the end of this stretch when it is the end of the route, a crossing or a real corner.
  let corner = spec.maxSpeed
  if (last || target.portal) corner = 0
  else {
    const after = trip.route[trip.index + 1]!
    // How much the road turns over the next dozen metres past the end of this stretch.
    let bend = 0, reach = 0, facing = way
    for (let n = trip.index; n + 1 < trip.route.length && reach < 12; n++) {
      const a = trip.route[n]!, b = trip.route[n + 1]!
      if (a.districtId !== b.districtId) break
      const next = Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z)
      let delta = Math.abs(next - facing)
      if (delta > Math.PI) delta = 2 * Math.PI - delta
      bend += delta
      facing = next
      reach += Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z)
    }
    if (bend > 0.45) corner = 3.5
  }
  // Pulling out past something in its own lane, it creeps until it is clear of it.
  const pullingOut = lane !== null && Math.abs(lane - trip.lane) > 0.2 && !clearAhead(trip.lane)
  const cruise = Math.min(pullingOut ? 1 : spec.maxSpeed * 0.8, Math.sqrt(corner * corner + 2 * spec.braking * 0.5 * left))
  const wantSpeed = stopping ? 0 : cruise
  let speed = vehicle.speed < wantSpeed ? Math.min(wantSpeed, vehicle.speed + spec.acceleration * dt) : Math.max(wantSpeed, vehicle.speed - spec.braking * dt)
  const sideways = lane === null ? 0 : Math.max(-0.9 * dt, Math.min(0.9 * dt, lane - trip.lane))
  const straight = turnTo(vehicle.heading, way, 2.5 * dt)
  const stuck = (at: Vec2, facing: number): 'vehicle' | 'person' | 'prop' | null => inTheWay(world, rt, vehicle, { pos: at, heading: facing }) ?? (solidAt(at, facing) && !solidAt(vehicle.pos, vehicle.heading) ? 'prop' : null)
  // What it tries, in order: on and across together; on, in its lane; across, on the spot; and squaring up to the road where it stands.
  // The first that touches nothing is what it does, so being close behind something never leaves it unable to move at all.
  const full = Math.min(left, speed * dt)
  const lean = Math.max(-0.2, Math.min(0.2, Math.atan2(sideways, Math.max(full, 0.08))))
  const moves: { forward: number; lane: number; heading: number }[] = []
  if (speed > 0) {
    if (sideways !== 0) moves.push({ forward: full, lane: trip.lane + sideways, heading: turnTo(vehicle.heading, way + lean, 2.5 * dt) })
    moves.push({ forward: full, lane: trip.lane, heading: straight })
  }
  if (!stopping && sideways !== 0) moves.push({ forward: 0, lane: trip.lane + sideways, heading: straight })
  if (!stopping && straight !== vehicle.heading) moves.push({ forward: 0, lane: trip.lane, heading: straight })
  let blocked: 'vehicle' | 'person' | 'prop' | null = null
  let move: { forward: number; lane: number; heading: number } | null = null
  for (const candidate of moves) {
    const hit = stuck(poseAt(candidate.forward, candidate.lane), candidate.heading)
    if (hit === null) { move = candidate; break }
    blocked ??= hit
  }
  if (!move) {
    if (vehicle.speed !== 0) vehicle.dirty = true
    vehicle.speed = 0
    if (trip.cancelling) { endTrip(world, rt, vehicle, 'cancelled', 'The ride was cancelled. Step out when you are ready.'); return }
    if (stopping && lane !== null) return
    // Held up by something it cannot pass.
    trip.blockedSince ??= now
    if (now - trip.blockedSince >= BLOCKED_FAILS_AFTER) endTrip(world, rt, vehicle, 'failed', 'The ride could not get through. Your fare has been returned.')
    else say(world, rt, vehicle, WHY[blocked ?? 'vehicle'])
    return
  }
  const forward = move.forward
  if (forward === 0) speed = 0
  const nextLane = move.lane
  const pos = poseAt(forward, nextLane)
  const heading = move.heading
  trip.blockedSince = null
  trip.along = { x: trip.along.x + ux * forward, z: trip.along.z + uz * forward }
  trip.lane = nextLane
  vehicle.pos = pos; vehicle.heading = heading; vehicle.speed = speed; vehicle.steering = 0; vehicle.dirty = true
  if (vehicle.notice) say(world, rt, vehicle, '')
  // The receipt keeps the last place reached, a few seconds apart: enough to put riders down safely after a restart.
  if (now - trip.savedAt >= 5 * SECOND) {
    trip.savedAt = now
    world.scoped(() => {
      const receipt = trip.receiptId ? slice(world).receipts[trip.receiptId] : undefined
      if (receipt) { receipt.checkpoint = { districtId: vehicle.room.districtId, pos: { ...vehicle.pos }, heading: vehicle.heading }; world.touch() }
    })
  }
}

function simulate(world: World, rt: Runtime, now: number): void {
  // Doors shut when the time is up, and everyone is shown it at once.
  if (rt.doors.size > 0) for (const vehicle of [...rt.doors]) if (closeDoors(rt, vehicle, now)) publish(world, rt, vehicle)
  if (rt.active.size === 0) return
  for (const vehicle of [...rt.active]) {
    // Waiting to cross: it stands still until the crossing is done or called off, whatever put it back in this list.
    if (vehicle.crossing !== null) { rt.active.delete(vehicle); continue }
    let due = Math.min(now - vehicle.simAt, VEHICLE_RULES.maxCatchUpMs) + vehicle.carry
    vehicle.simAt = now
    while (due >= STEP && rt.active.has(vehicle)) {
      due -= STEP
      const trip = vehicle.trip
      if (trip?.mode === 'paid-service' && trip.state === 'en-route') stepRoute(world, rt, vehicle, trip, now)
      else stepDriven(world, rt, vehicle, now)
    }
    vehicle.carry = rt.active.has(vehicle) ? due : 0
    if (vehicle.dirty && now - vehicle.sentAt >= 95) report(world, rt, vehicle, now)
  }
}

// ── Once a second: what has run out ───────────────────────────────────────────────────────────

function sweep(world: World, rt: Runtime, now: number): void {
  if (rt.vehicles.size === 0 && rt.fleets.size === 0 && rt.foot.size === 0 && rt.crossings.size === 0 && rt.quotes.size === 0 && rt.requests.size === 0) return
  for (const [memberId, held] of [...rt.heldOf]) {
    const seat = held.vehicle.seats.get(held.seatId)
    if (!seat?.held || seat.held.until <= now) releaseHeld(world, rt, memberId)
  }
  for (const [memberId, foot] of rt.foot) if (foot.until <= now) rt.foot.delete(memberId)
  for (const [inviteId, invite] of rt.invites) if (Date.parse(invite.expiresAt) <= now) { if (invite.status === 'pending') invite.status = 'expired'; if (Date.parse(invite.expiresAt) + 10 * MINUTE <= now) rt.invites.delete(inviteId) }
  for (const [offerId, offer] of rt.offers) if (Date.parse(offer.expiresAt) <= now) { rt.offers.delete(offerId); pushSelf(world, rt, offer.to) }
  for (const [quoteId, quote] of rt.quotes) if (Date.parse(quote.expiresAt) + MINUTE <= now) rt.quotes.delete(quoteId)
  for (const [crossingId, crossing] of [...rt.crossings]) {
    if (crossing.state !== 'waiting') { if (now - crossing.closedAt > 30 * SECOND) rt.crossings.delete(crossingId); continue }
    if (crossing.expiresAt <= now) abortCrossing(world, rt, crossing, 'Not everyone was ready to cross into the next district. Try again.')
    // A kept seat may just have been given up, or someone put down: ask again whether everyone left aboard has answered.
    else settleCrossing(world, rt, crossing)
  }
  for (const [memberId, mine] of rt.requests) { for (const [name, entry] of mine) if (now - entry.at > 10 * MINUTE) mine.delete(name); if (mine.size === 0) rt.requests.delete(memberId) }

  for (const vehicle of [...rt.vehicles.values()]) {
    // Someone to be put down, once it has stopped.
    if (!moving(vehicle)) {
      for (const memberId of [...vehicle.putDown]) {
        const seat = rt.seatOf.get(memberId)
        const spot = seat ? exitSpot(rt, vehicle, seatSpec(vehicle, seat.seatId)!, []) : null
        if (!seat) vehicle.putDown.delete(memberId)
        else if (spot) { unsit(world, rt, vehicle, memberId, spot); pushSelf(world, rt, memberId); publish(world, rt, vehicle) }
      }
    }
    for (const [memberId, until] of vehicle.exitWanted) if (until <= now) vehicle.exitWanted.delete(memberId)
    // A service vehicle whose ride is over is not somewhere to stay: after a while whoever is still sitting in it is put down beside it.
    if (vehicle.source === 'service' && (vehicle.trip === null || vehicle.trip.state === 'arrived') && !moving(vehicle) && vehicle.rideEndedAt !== null && now - vehicle.rideEndedAt >= LINGER) {
      for (const memberId of seated(vehicle)) vehicle.putDown.add(memberId)
    }
    const trip = vehicle.trip
    if (trip?.mode === 'paid-service') {
      if (trip.state === 'boarding' && now - trip.bookedAt >= VEHICLE_RULES.boardingSeconds * SECOND) {
        // Booked and never left: the charter is released and the fare goes back.
        world.scoped(() => { const receipt = closeReceipt(world, trip.receiptId, 'cancelled'); if (receipt) refund(world, receipt, 'cancelled') })
        vehicle.trip = null; vehicle.control = { kind: 'none' }; vehicle.grants.clear(); vehicle.phase = 'parked'; vehicle.rideEndedAt = now
        for (const [memberId, held] of [...rt.heldOf]) if (held.vehicle === vehicle) releaseHeld(world, rt, memberId)
        vehicle.notice = 'The ride did not leave in time, so it was released and the fare returned.'
        if (trip.payer) pushSelf(world, rt, trip.payer)
        publish(world, rt, vehicle)
      } else if (trip.state === 'en-route' && seated(vehicle).length === 0 && aboard(vehicle).length === 0) {
        endTrip(world, rt, vehicle, 'abandoned', '')
      } else if (trip.state === 'arrived' && aboard(vehicle).length === 0) {
        vehicle.trip = null; vehicle.grants.clear()
      }
    }
    if (aboard(vehicle).length === 0) vehicle.rideEndedAt = null
    const watched = viewers(world, vehicle).length > 0
    const empty = aboard(vehicle).length === 0
    if (vehicle.source === 'service') {
      // A service vehicle away from its depot with nobody in it, or one nobody can see, is withdrawn. Its depot is restocked below.
      const away = vehicle.trip === null && empty && vehicle.emptySince !== null && now - vehicle.emptySince >= 20 * SECOND && rt.fleets.get(instanceKey(vehicle.room))?.standing.get(`${vehicle.depotId}:${vehicle.kind}`) !== vehicle.id
      if ((empty && !watched && vehicle.trip?.state !== 'boarding') || away) removeVehicle(world, rt, vehicle, 'withdrawn')
    } else if (empty && !moving(vehicle)) {
      const idle = vehicle.emptySince !== null && now - vehicle.emptySince >= VEHICLE_RULES.idleReturnSeconds * SECOND
      if (idle) {
        // Left empty too long: back to its depot. It is still the member's to use from there.
        world.scoped(() => {
          const loan = vehicle.ownerId ? slice(world).loans[vehicle.ownerId] : undefined
          const depot = roadsOf(rt)?.depot(vehicle.depotId)
          const berth = depot ? berthsOf(rt, roadsOf(rt)!, depot.districtId, depot.depot)[2] ?? berthsOf(rt, roadsOf(rt)!, depot.districtId, depot.depot)[0] : undefined
          if (loan && depot && berth) { loan.checkpoint = { districtId: depot.districtId, pos: berth.pos, heading: berth.heading }; world.touch() }
        })
        removeVehicle(world, rt, vehicle, 'withdrawn')
      } else if (!watched) removeVehicle(world, rt, vehicle, 'withdrawn')
    }
  }
  for (const [key, fleet] of rt.fleets) {
    if (standingIn(world, fleet.place.key, fleet.place.instance).length === 0) { if (!rt.byInstance.has(key)) rt.fleets.delete(key); continue }
    // A service vehicle that left its depot counts as standing there until it is withdrawn.
    for (const [slot, vehicleIdValue] of fleet.standing) { const vehicle = rt.vehicles.get(vehicleIdValue); if (!vehicle || vehicle.trip) fleet.standing.delete(slot) }
    stock(world, rt, fleet.place)
  }
}

// ── After a restart ───────────────────────────────────────────────────────────────────────────

/**
 * Seats and positions did not survive, receipts did. A ride that was paid for and not finished
 * could not be completed: its fare goes back once, and it is closed where it last was. Nothing
 * here runs, and nothing is written, for a world with no open ride.
 */
function recover(world: World): void {
  const open = Object.values(saved(world)?.receipts ?? {}).some(receipt => receipt.state === 'boarding' || receipt.state === 'en-route')
  if (!open) return
  world.scoped(() => {
    for (const receipt of Object.values(slice(world).receipts)) {
      if (receipt.state !== 'boarding' && receipt.state !== 'en-route') continue
      receipt.closedAt = iso(world.now())
      receipt.interrupted = true
      // Its payer had already ended it on the way: that stands, and nothing comes back for it.
      if (receipt.cancelRequestedAt) { receipt.state = 'cancelled'; continue }
      receipt.state = 'failed'
      refund(world, receipt, 'service-failure')
    }
    world.touch()
  })
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

export function registerVehicles(world: World): void {
  const sharded = world.roomHost !== null
  const rt: Runtime = {
    world, boot: randomToken(6), counter: 0, roads: undefined, roadsReason: '', vehicles: new Map(), byInstance: new Map(), seatOf: new Map(), heldOf: new Map(), foot: new Map(),
    active: new Set(), doors: new Set(), invites: new Map(), offers: new Map(), quotes: new Map(), crossings: new Map(), moving: new Set(), requests: new Map(), fleets: new Map(), berths: new Map(),
  }
  runtimes.set(world, rt)
  setHomeVehicleAuthority(world, {
    held: memberId => rt.seatOf.has(memberId) || rt.heldOf.has(memberId) ? SEATED : null,
    blocked(districtId, instance, point, radius) {
      const key = instanceKey({ key: roomKey(districtRef(districtId)), instance })
      for (const vehicle of rt.byInstance.get(key) ?? []) {
        const box = vehicleFootObstacle(vehicle.kind, vehicle.pos, vehicle.heading)
        if (box.kind !== 'box') continue
        const dx = point.x - box.pos.x, dz = point.z - box.pos.z
        const x = dx * Math.cos(box.heading) - dz * Math.sin(box.heading), z = dx * Math.sin(box.heading) + dz * Math.cos(box.heading)
        if (Math.hypot(Math.max(0, Math.abs(x) - box.halfWidth), Math.max(0, Math.abs(z) - box.halfDepth)) < radius) return true
      }
      return false
    },
  })
  // One answer for every world in the process: each asks its own record.
  setOccupancyHold((heldWorld, memberId) => (runtimes.get(heldWorld)?.seatOf.has(memberId) ? SEATED : null))
  setPresenceTransport((seatWorld, memberId) => {
    const seat = runtimes.get(seatWorld)?.seatOf.get(memberId)
    return seat ? { vehicleId: seat.vehicle.id, seatId: seat.seatId } : undefined
  })
  setFootMovementGuard((moveWorld, _memberId, place, from, to) => {
    if (place.ref.kind !== 'district') return true
    const active = runtimes.get(moveWorld)
    if (!active) return true
    const roads = roadsOf(active), districtId = place.ref.districtId
    if (!roads?.supports(districtId)) return true
    // Admission also calls this guard with a zero-length path. Check the destination body explicitly.
    for (const vehicle of active.byInstance.get(instanceKey(place)) ?? []) {
      if (pointInBox(to, vehicleCorners(vehicle.kind, vehicle.pos, vehicle.heading, PERSON_RADIUS))) return false
    }
    // Old client-selected arrivals inside a solid may walk to clear ground within one metre.
    // A valid accepted foot position never gains this exception.
    if (!roads.standable(districtId, from, PERSON_RADIUS, homeSolids(active, districtId))) return Math.hypot(to.x - from.x, to.z - from.z) <= 1 && roads.standable(districtId, to, PERSON_RADIUS, homeSolids(active, districtId))
    const grid = new FootObstacleGrid<VehicleId>()
    for (const vehicle of active.byInstance.get(instanceKey(place)) ?? []) grid.set(vehicle.id, vehicleFootObstacle(vehicle.kind, vehicle.pos, vehicle.heading))
    const obstacles = grid.query(from, to).map(entry => entry.obstacle)
    const safe = moveFoot(from, to, obstacles, point => roads.standable(districtId, point, PERSON_RADIUS, homeSolids(active, districtId)))
    return Math.hypot(safe.x - to.x, safe.z - to.z) <= .025
  })
  recover(world)

  const districtPlace = (memberId: MemberId): Place | null => {
    const at = placeOf(world, memberId)
    return at && at.ref.kind === 'district' ? { ref: at.ref, key: at.key, instance: at.instance, districtId: at.ref.districtId } : null
  }
  /** Why vehicles cannot be used by this member here and now; '' when they can. */
  const unavailable = (memberId: MemberId): string => {
    if (sharded) return SHARDED
    const roads = roadsOf(rt)
    if (!roads) return rt.roadsReason
    const place = districtPlace(memberId)
    if (!place) return 'Vehicles are on the streets. Go outside to use one.'
    if (!roads.supports(place.districtId)) return 'Vehicles are not available in this district yet. Walking and Travel work as before.'
    return ''
  }
  const ready = (memberId: MemberId): { roads: RoadAuthority; place: Place } => {
    const reason = unavailable(memberId)
    if (reason) throw new WorldError('unavailable', reason)
    return { roads: roadsOf(rt)!, place: districtPlace(memberId)! }
  }
  /** Operations on a vehicle the member may already be in, wherever it is. */
  const roadsOrRefuse = (): RoadAuthority => {
    if (sharded) throw new WorldError('unavailable', SHARDED)
    const roads = roadsOf(rt)
    if (!roads) throw new WorldError('unavailable', rt.roadsReason)
    return roads
  }

  if (!sharded) {
    world.onStep(now => simulate(world, rt, now))
    world.onTick(now => sweep(world, rt, now))

    onRoomLeave((leftWorld, memberId) => {
      if (leftWorld !== world || rt.moving.has(memberId)) return
      const seat = rt.seatOf.get(memberId)
      if (!seat) return
      // Gone from the room (a dropped connection, usually): the seat is kept for a moment, with nobody shown in it.
      const { vehicle, seatId } = seat
      // rooms has removed this occupant already. Retain its place in this exact instance,
      // independently of any target crossing hold. No other instance can stand in for it.
      if (holdPlaces(world, vehicle.room.ref, 1, vehicle.room.instance) === null) {
        // An already overfull instance cannot promise a retained seat or force a later admission.
        const spot = exitSpot(rt, vehicle, seatSpec(vehicle, seatId)!, [])
        if (spot) rt.foot.set(memberId, { pose: { districtId: vehicle.room.districtId, ...spot }, until: world.now() + 10 * MINUTE })
        unsit(world, rt, vehicle, memberId, null)
        publish(world, rt, vehicle)
        return
      }
      rt.seatOf.delete(memberId)
      vehicle.seats.set(seatId, { memberId: null, held: { memberId, until: world.now() + VEHICLE_RULES.seatGraceMs } })
      rt.heldOf.set(memberId, { vehicle, seatId, place: { ...vehicle.room } })
      vehicle.exitWanted.delete(memberId)
      vehicle.transitions = vehicle.transitions.filter(entry => entry.memberId !== memberId)
      if (vehicle.control.kind === 'member' && vehicle.control.driverId === memberId) dropControl(rt, vehicle)
      for (const [offerId, offer] of rt.offers) if (offer.from === memberId || offer.to === memberId) rt.offers.delete(offerId)
      // With nobody at the wheel a waiting crossing cannot go ahead: it is called off now, and the vehicle stays at the edge with every seat as it was.
      // A passenger dropping leaves it waiting instead: their seat is kept for the whole grace (see settleCrossing).
      const crossing = vehicle.crossing ? rt.crossings.get(vehicle.crossing) : undefined
      if (crossing && !pending(rt, crossing)) abortCrossing(world, rt, crossing, 'The driver\'s connection dropped, so the crossing was called off.')
      publish(world, rt, vehicle)
    })
    onRoomEnter((enteredWorld, memberId, ref) => {
      if (enteredWorld !== world || rt.moving.has(memberId)) return
      // Walking into a room is giving the kept seat up.
      if (rt.heldOf.has(memberId)) releaseHeld(world, rt, memberId)
      rt.foot.delete(memberId)
      if (ref.kind !== 'district' || !roadsOf(rt)) return
      const place = districtPlace(memberId)
      if (!place) return
      stock(world, rt, place)
      bringLoan(world, rt, memberId)
      for (const vehicle of rt.byInstance.get(instanceKey(place)) ?? []) world.push(memberId, { type: 'vehicle.snapshot', vehicle: snapshotFor(world, vehicle, memberId) })
    })
    onBlock((blockWorld, blocker, blocked) => {
      if (blockWorld !== world) return
      for (const invite of rt.invites.values()) if (invite.status === 'pending' && ((invite.inviter === blocker && invite.recipient === blocked) || (invite.inviter === blocked && invite.recipient === blocker))) invite.status = 'expired'
      for (const [offerId, offer] of rt.offers) if ((offer.from === blocker && offer.to === blocked) || (offer.from === blocked && offer.to === blocker)) rt.offers.delete(offerId)
      for (const vehicle of [...rt.vehicles.values()]) {
        const lead = vehicle.ownerId ?? vehicle.trip?.payer ?? null
        for (const [a, b] of [[blocker, blocked], [blocked, blocker]] as const) if (lead === a) vehicle.grants.delete(b)
        // Aboard means seated or with a seat being kept: a block reaches someone whose connection is down as well.
        const party = aboard(vehicle)
        const hasBlocker = party.includes(blocker), hasBlocked = party.includes(blocked)
        if (!hasBlocker && !hasBlocked) continue
        // Who leaves: the other one, when the first is whoever borrowed or paid for the vehicle (in it or not); otherwise, with both aboard, the blocked one.
        const leaver = lead === blocker ? (hasBlocked ? blocked : null) : lead === blocked ? (hasBlocker ? blocker : null) : hasBlocker && hasBlocked ? blocked : null
        if (leaver) {
          // A kept seat is given up at once, so there is nothing to come back to. Someone seated is put down as soon as the vehicle has stopped.
          if (rt.heldOf.get(leaver)?.vehicle === vehicle) { releaseHeld(world, rt, leaver); continue }
          vehicle.putDown.add(leaver)
          rt.active.add(vehicle)
        }
        publish(world, rt, vehicle)
      }
    })
  }

  world.register('vehicle.state', empty, ctx => {
    const me = ctx.memberId
    const reason = unavailable(me)
    const roads = sharded ? null : roadsOf(rt)
    const data = roads ? { id: roads.id, dataVersion: roads.dataVersion, mapDataVersion: roads.mapDataVersion } : null
    const invites = sharded ? [] : [...rt.invites.values()].filter(invite => (invite.recipient === me || invite.inviter === me) && invite.status === 'pending' && Date.parse(invite.expiresAt) > ctx.now)
    if (reason || !roads) return { available: false, reason, self: sharded ? { seat: null, vehicle: null, balance: careerPoints(world, me), offer: null, notice: '' } : selfOf(world, rt, me), vehicles: [], invites, data, depots: [] }
    const place = districtPlace(me)!
    stock(world, rt, place)
    bringLoan(world, rt, me)
    return {
      available: true, reason: '', self: selfOf(world, rt, me),
      vehicles: [...(rt.byInstance.get(instanceKey(place)) ?? [])].map(vehicle => snapshotFor(world, vehicle, me)), invites, data,
      depots: roads.depotsOf(place.districtId).map(depot => ({ id: depot.id, districtId: place.districtId, pos: depot.pos, heading: depot.heading })),
    }
  })

  /**
   * A vehicle as this member may see it NOW, or null. Used wherever an answer is given from a record
   * of something done earlier: the record says what happened to the caller; it is no licence to look
   * at whatever the vehicle is doing since. Seen only from a seat in it or from its own room instance.
   */
  const shown = (vehicleIdValue: VehicleId, me: MemberId): VehicleSnapshot | null => {
    const vehicle = rt.vehicles.get(vehicleIdValue)
    if (!vehicle) return null
    const at = placeOf(world, me)
    const visible = rt.seatOf.get(me)?.vehicle === vehicle || (at !== null && at.key === vehicle.room.key && at.instance === vehicle.room.instance)
    return visible ? snapshotFor(world, vehicle, me) : null
  }

  /**
   * A retry is answered from the record of what was done the first time. If that record has not
   * reached the disk yet, the retry has to wait for it just as the first answer does: otherwise a
   * member could be told "booked" or "refunded" by the retry while the write that makes it true is
   * still pending, or failing. The kernel holds an answer until the save that follows a change it
   * was told of, so the retry tells it of one. Only while something is unsaved: with everything on
   * disk it does nothing, writes nothing and is answered at once. It records and decides nothing.
   */
  const answerAfterSave = (): void => {
    if (!world.saveStats.unsaved || !saved(world)) return
    // Naming the slice makes sure the save this answer waits for is one that will be taken.
    slice(world)
    world.touch()
  }

  const actionsFor = (vehicle: Vehicle, me: MemberId): VehicleActions => {
    const mine = rt.seatOf.get(me)
    const inIt = mine?.vehicle === vehicle
    const still = !moving(vehicle) && (vehicle.phase === 'parked' || vehicle.phase === 'boarding')
    const free = (role: 'driver' | 'passenger'): boolean => !mine && still && vehicle.spec.seats.some(spec => spec.role === role && refusal(world, rt, vehicle, spec, me) === null)
    const driving = vehicle.control.kind === 'member' && vehicle.control.driverId === me
    return {
      board: free('passenger') || free('driver'), drive: free('driver'),
      book: !mine && hireable(vehicle),
      exit: inIt, handoff: driving && !moving(vehicle) && seated(vehicle).length > 1,
    }
  }

  world.register('vehicle.inspect', value => ({ vehicleId: vehicleId(obj(value)) }), (ctx, input) => {
    roadsOrRefuse()
    const vehicle = findVehicle(rt, input.vehicleId)
    if (rt.seatOf.get(ctx.memberId)?.vehicle !== vehicle) here(world, vehicle, ctx.memberId)
    return { vehicle: snapshotFor(world, vehicle, ctx.memberId), self: selfOf(world, rt, ctx.memberId), actions: actionsFor(vehicle, ctx.memberId) }
  })

  world.register('vehicle.loan', value => {
    const raw = obj(value)
    return { depotId: str(raw, 'depotId', { min: 3, max: 120 }), kind: oneOf(raw, 'kind', VEHICLE_KINDS), requestId: requestId(raw) }
  }, (ctx, input) => {
    const me = ctx.memberId
    const { roads, place } = ready(me)
    const key = `loan|${input.depotId}|${input.kind}`
    const again = repeated(rt, me, input.requestId, key)
    const existing = saved(world)?.loans[me]
    if (again && existing && existing.vehicleId === again.vehicleId) {
      const vehicle = bringLoan(world, rt, me)
      answerAfterSave()
      // Their own vehicle, as long as it is where they can see it. Left elsewhere with riders in it, the retry is told what a new request would be.
      const seen = vehicle ? shown(vehicle.id, me) : null
      if (seen) return { vehicle: seen, self: selfOf(world, rt, me) }
    }
    if (existing) throw new WorldError('conflict', 'You already have a borrowed vehicle. Return it before borrowing another.')
    world.limit(`vehicle-loan:${me}`, 6, MINUTE)
    const depot = roads.depot(input.depotId)
    if (!depot || depot.districtId !== place.districtId) throw new WorldError('not_found', 'That depot is not in this district.')
    const at = placeOf(world, me)!
    if (Math.hypot(at.pos.x - depot.depot.pos.x, at.pos.z - depot.depot.pos.z) > VEHICLE_RULES.depotRangeMetres) throw new WorldError('forbidden', 'Go to the depot to borrow a vehicle.')
    let borrowed = 0
    for (const vehicle of rt.byInstance.get(instanceKey(place)) ?? []) if (vehicle.source === 'borrowed') borrowed++
    const berth = borrowed < BORROWED_PER_INSTANCE ? freeBerth(rt, roads, place, input.depotId, input.kind) : null
    if (!berth) throw new WorldError('unavailable', 'The depot has no vehicle free right now. Try again in a little while.')
    const loan: LoanRec = { vehicleId: newId<VehicleId>('vh'), memberId: me, kind: input.kind, access: 'invite', depotId: input.depotId, checkpoint: { districtId: place.districtId, pos: berth.pos, heading: berth.heading }, issuedAt: iso(ctx.now) }
    slice(world).loans[me] = loan
    world.touch()
    const vehicle = addVehicle(rt, world, { id: loan.vehicleId, kind: loan.kind, source: 'borrowed', ownerId: me, access: loan.access, depotId: loan.depotId, room: place, pos: berth.pos, heading: berth.heading })
    remember(world, rt, me, input.requestId, key, { vehicleId: vehicle.id })
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me) }
  })

  world.register('vehicle.return', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), expectedRevision: revisionIn(raw), requestId: requestId(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const key = `return|${input.vehicleId}`
    if (repeated(rt, me, input.requestId, key)) { answerAfterSave(); return { returned: true as const, self: selfOf(world, rt, me) } }
    const loan = saved(world)?.loans[me]
    if (!loan || loan.vehicleId !== input.vehicleId) throw new WorldError('forbidden', 'Only the member who borrowed a vehicle can return it.')
    const vehicle = rt.vehicles.get(loan.vehicleId)
    if (vehicle) {
      checkRevision(vehicle, input.expectedRevision)
      if (aboard(vehicle).length > 0) throw new WorldError('conflict', 'Someone is still in the vehicle. It can be returned once everyone has stepped out.')
      if (moving(vehicle)) throw new WorldError('conflict', 'The vehicle is still moving.')
      removeVehicle(world, rt, vehicle, 'returned')
    }
    delete slice(world).loans[me]
    world.touch()
    remember(world, rt, me, input.requestId, key, { returned: true })
    return { returned: true as const, self: selfOf(world, rt, me) }
  })

  world.register('vehicle.board', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), seatId: seatIn(raw), entryId: entryIn(raw), expectedRevision: revisionIn(raw), inviteId: optId<VehicleInviteId>(raw, 'inviteId', 'vi') ?? undefined, requestId: requestId(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const vehicle = findVehicle(rt, input.vehicleId)
    const key = `board|${input.vehicleId}|${input.seatId}|${input.entryId}`
    const mine = rt.seatOf.get(me)
    if (repeated(rt, me, input.requestId, key) && mine?.vehicle === vehicle && mine.seatId === input.seatId) return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me) }
    const at = here(world, vehicle, me)
    if (mine) throw new WorldError('conflict', SEATED)
    const spec = seatSpec(vehicle, input.seatId)
    if (!spec) throw new WorldError('invalid', 'This vehicle has no such seat.')
    if (!spec.entries.includes(input.entryId)) throw new WorldError('forbidden', 'That seat is not reached from that side of the vehicle.')
    if (moving(vehicle) || (vehicle.phase !== 'parked' && vehicle.phase !== 'boarding')) throw new WorldError('conflict', 'Wait for the vehicle to stop.')
    if (!atEntry(vehicle, input.entryId, at.pos)) throw new WorldError('forbidden', 'Go up to that side of the vehicle to get in.')
    // The first to ask gets the seat; whoever asks next is told how the vehicle now stands and loses nothing.
    const state = vehicle.seats.get(spec.id)!
    if (state.memberId || state.held) throw new WorldError('conflict', 'That seat is taken.')
    if (barred(vehicle, spec, input.entryId)) throw new WorldError('conflict', 'Someone is sitting between that door and that seat. Use the other side.')
    checkRevision(vehicle, input.expectedRevision)
    if (input.inviteId) {
      const invite = rt.invites.get(input.inviteId)
      if (!invite || invite.vehicleId !== vehicle.id || invite.recipient !== me || invite.status !== 'accepted') throw new WorldError('forbidden', 'That invitation is not for you and this vehicle.')
    }
    const why = refusal(world, rt, vehicle, spec, me)
    if (why) throw new WorldError('forbidden', why)
    sit(world, rt, vehicle, spec, me)
    passThrough(world, rt, vehicle, 'board', input.entryId, spec.id, me)
    if (spec.role === 'driver') takeControl(rt, vehicle, me)
    vehicle.notice = ''
    remember(world, rt, me, input.requestId, key, { vehicleId: vehicle.id })
    publish(world, rt, vehicle)
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me) }
  })

  world.register('vehicle.exit', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), requestId: requestId(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const key = `exit|${input.vehicleId}`
    const again = repeated(rt, me, input.requestId, key)
    if (again) { answerAfterSave(); return { vehicle: shown(input.vehicleId, me), self: selfOf(world, rt, me), pos: again.pos as Vec2, heading: again.heading as number } }
    const vehicle = findVehicle(rt, input.vehicleId)
    const mine = rt.seatOf.get(me)
    if (!mine || mine.vehicle !== vehicle) throw new WorldError('conflict', 'You are not in that vehicle.')
    if (vehicle.phase === 'transferring') throw new WorldError('conflict', 'The vehicle is crossing into the next district. Step out when it has.')
    if (moving(vehicle)) {
      // Nobody is put out of a moving vehicle. It stops; the member asks again when it has.
      vehicle.exitWanted.set(me, ctx.now + 10 * SECOND)
      rt.active.add(vehicle)
      throw new WorldError('conflict', 'The vehicle is stopping. Step out when it has stopped.')
    }
    const spot = exitSpot(rt, vehicle, seatSpec(vehicle, mine.seatId)!, [])
    if (!spot) throw new WorldError('conflict', 'There is no clear space to step out here. Try again in a moment.')
    const trip = vehicle.trip
    unsit(world, rt, vehicle, me, spot)
    // The member who paid stepping out before the ride leaves gives it up: the fare comes back.
    if (trip?.mode === 'paid-service' && trip.state === 'boarding' && trip.payer === me && seated(vehicle).length === 0) {
      const receipt = closeReceipt(world, trip.receiptId, 'cancelled')
      if (receipt) refund(world, receipt, 'cancelled')
      vehicle.trip = null; vehicle.control = { kind: 'none' }; vehicle.grants.clear(); vehicle.phase = 'parked'; vehicle.rideEndedAt = ctx.now
      for (const [memberId, held] of [...rt.heldOf]) if (held.vehicle === vehicle) releaseHeld(world, rt, memberId)
    }
    remember(world, rt, me, input.requestId, key, { pos: spot.pos, heading: spot.heading })
    publish(world, rt, vehicle)
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me), pos: spot.pos, heading: spot.heading }
  })

  world.register('vehicle.input', value => {
    const raw = obj(value)
    return {
      vehicleId: vehicleId(raw), controlEpoch: str(raw, 'controlEpoch', { min: 3, max: 40 }), seq: num(raw, 'seq', { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
      throttle: num(raw, 'throttle', { min: -1, max: 1 }), steer: num(raw, 'steer', { min: -1, max: 1 }), brake: bool(raw, 'brake'),
    }
  }, (ctx, input) => {
    roadsOrRefuse()
    const vehicle = findVehicle(rt, input.vehicleId)
    const control = vehicle.control
    if (control.kind !== 'member' || control.driverId !== ctx.memberId || rt.seatOf.get(ctx.memberId)?.vehicle !== vehicle) throw new WorldError('forbidden', 'You are not driving that vehicle.')
    // An old epoch (the wheel changed hands), an old sequence, a crossing in progress or too many a second: not applied.
    if (control.controlEpoch !== input.controlEpoch || input.seq <= vehicle.lastSeq || vehicle.phase === 'transferring') return { accepted: false, lastSeq: vehicle.lastSeq }
    try { world.limit(`vehicle-input:${ctx.memberId}`, VEHICLE_RULES.inputsPerSecond, SECOND) } catch { return { accepted: false, lastSeq: vehicle.lastSeq } }
    vehicle.lastSeq = input.seq
    vehicle.input = { throttle: input.throttle, steer: input.steer, brake: input.brake, at: ctx.now }
    if (!rt.active.has(vehicle) && (input.throttle !== 0 || moving(vehicle))) { vehicle.simAt = ctx.now; vehicle.carry = 0; rt.active.add(vehicle) }
    if (closeDoors(rt, vehicle, ctx.now)) publish(world, rt, vehicle)
    if (vehicle.transitions.length > 0 && input.throttle !== 0) say(world, rt, vehicle, 'Wait for the doors to close.')
    return { accepted: true, lastSeq: vehicle.lastSeq }
  }, { cost: 0.2, lazyAck: true })

  /** The borrower of a borrowed vehicle, or nobody. */
  const owned = (vehicle: Vehicle, me: MemberId): void => {
    if (vehicle.source !== 'borrowed' || vehicle.ownerId !== me) throw new WorldError('forbidden', 'Only the member who borrowed this vehicle can do that.')
  }

  world.register('vehicle.access', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), access: oneOf(raw, 'access', VEHICLE_ACCESS), expectedRevision: revisionIn(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const vehicle = findVehicle(rt, input.vehicleId)
    owned(vehicle, ctx.memberId)
    here(world, vehicle, ctx.memberId)
    checkRevision(vehicle, input.expectedRevision)
    vehicle.access = input.access
    if (input.access === 'owner') {
      // Nobody else: what was promised is withdrawn. Anyone already aboard stays until they step out.
      for (const invite of rt.invites.values()) if (invite.vehicleId === vehicle.id && invite.status === 'pending') invite.status = 'expired'
      vehicle.grants.clear()
      for (const [memberId, held] of [...rt.heldOf]) if (held.vehicle === vehicle && !mayKeepSeat(world, vehicle, seatSpec(vehicle, held.seatId)!, memberId)) releaseHeld(world, rt, memberId)
      for (const [offerId, offer] of rt.offers) if (offer.vehicleId === vehicle.id) {
        rt.offers.delete(offerId)
        pushSelf(world, rt, offer.to)
      }
    }
    const loan = slice(world).loans[ctx.memberId]
    if (loan) { loan.access = input.access; world.touch() }
    publish(world, rt, vehicle)
    return { vehicle: snapshotFor(world, vehicle, ctx.memberId) }
  })

  world.register('vehicle.invite', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), to: id<MemberId>(raw, 'to', 'm'), role: oneOf(raw, 'role', ['passenger', 'driver'] as const), expectedRevision: revisionIn(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const vehicle = findVehicle(rt, input.vehicleId)
    here(world, vehicle, me)
    checkRevision(vehicle, input.expectedRevision)
    const lead = vehicle.source === 'borrowed' ? vehicle.ownerId : vehicle.trip?.mode === 'paid-service' && vehicle.trip.state === 'boarding' ? vehicle.trip.payer : null
    const driving = vehicle.control.kind === 'member' && vehicle.control.driverId === me
    // The borrower or the payer invites; so may whoever they gave the wheel to, as a passenger only.
    if (lead !== me && !(driving && input.role === 'passenger')) throw new WorldError('forbidden', 'Only whoever borrowed or booked this vehicle can invite someone into it.')
    if (vehicle.source === 'service' && input.role === 'driver') throw new WorldError('forbidden', 'The service drives this vehicle.')
    if (vehicle.source === 'borrowed' && vehicle.access === 'owner') throw new WorldError('conflict', 'This vehicle is set to its borrower only. Change who may board first.')
    const them = placeOf(world, input.to)
    // Someone in the same room, and not across a block. Anyone else gets the same answer, which says nothing about them.
    if (input.to === me || !exists(world, input.to) || !them || them.key !== vehicle.room.key || them.instance !== vehicle.room.instance || isBlockedEitherWay(world, me, input.to)) throw new WorldError('forbidden', 'That member cannot be invited from here.')
    world.limit(`vehicle-invite:${me}`, 10, MINUTE)
    for (const [inviteId, invite] of rt.invites) if (invite.vehicleId === vehicle.id && invite.recipient === input.to && invite.status === 'pending') rt.invites.delete(inviteId)
    const invite: VehicleInvite = { id: newId<VehicleInviteId>('vi'), vehicleId: vehicle.id, inviter: me, recipient: input.to, role: input.role, expiresAt: iso(ctx.now + VEHICLE_RULES.inviteSeconds * SECOND), status: 'pending' }
    rt.invites.set(invite.id, invite)
    world.push(input.to, { type: 'vehicle.invite', invite })
    return { invite }
  })

  world.register('vehicle.respondInvite', value => {
    const raw = obj(value)
    return { inviteId: id<VehicleInviteId>(raw, 'inviteId', 'vi'), accept: bool(raw, 'accept') }
  }, (ctx, input) => {
    roadsOrRefuse()
    const invite = rt.invites.get(input.inviteId)
    if (!invite || invite.recipient !== ctx.memberId) throw new WorldError('not_found', 'That invitation was not found.')
    if (invite.status === 'pending' && Date.parse(invite.expiresAt) <= ctx.now) invite.status = 'expired'
    // Answering twice changes nothing.
    if (invite.status !== 'pending') {
      if (invite.status === 'expired') throw new WorldError('expired', 'That invitation has lapsed.')
      return { invite }
    }
    const vehicle = rt.vehicles.get(invite.vehicleId)
    if (!vehicle || isBlockedEitherWay(world, invite.inviter, ctx.memberId)) { invite.status = 'expired'; throw new WorldError('expired', 'That invitation has lapsed.') }
    invite.status = input.accept ? 'accepted' : 'declined'
    // Accepting is permission for this ride. It seats nobody: boarding is still done at the vehicle.
    if (input.accept) vehicle.grants.set(ctx.memberId, invite.role)
    world.push(invite.inviter, { type: 'vehicle.invite', invite })
    return { invite }
  })

  const handoffRefusal = (vehicle: Vehicle, from: MemberId, to: MemberId): string | null => {
    if (vehicle.access === 'owner' && to !== vehicle.ownerId) return 'Only the borrower can take the wheel while this vehicle is borrower-only. Reopen access before offering it to someone else.'
    const party = [...aboard(vehicle), ...(vehicle.ownerId ? [vehicle.ownerId] : [])]
    if (vehicle.putDown.has(from) || vehicle.putDown.has(to) || isBlockedEitherWay(world, from, to) || party.some(memberId => memberId !== to && isBlockedEitherWay(world, memberId, to))) return 'The wheel cannot be handed over to that member now.'
    if (vehicle.ownerId !== from && to !== vehicle.ownerId && vehicle.grants.get(to) !== 'driver') return 'Only the member who borrowed this vehicle can make someone new its driver.'
    return null
  }

  world.register('vehicle.offerDriver', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), to: id<MemberId>(raw, 'to', 'm'), expectedRevision: revisionIn(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const vehicle = findVehicle(rt, input.vehicleId)
    if (vehicle.control.kind !== 'member' || vehicle.control.driverId !== me) throw new WorldError('forbidden', 'Only the driver can hand the wheel over.')
    checkRevision(vehicle, input.expectedRevision)
    if (moving(vehicle)) throw new WorldError('conflict', 'Stop the vehicle before handing the wheel over.')
    if (vehicle.crossing !== null) throw new WorldError('conflict', 'The vehicle is crossing into the next district. Hand the wheel over when it has.')
    const theirs = rt.seatOf.get(input.to)
    if (input.to === me || theirs?.vehicle !== vehicle || isBlockedEitherWay(world, me, input.to)) throw new WorldError('forbidden', 'The wheel can only be offered to someone sitting in this vehicle.')
    // The borrower may offer it to anyone aboard. A driver who is not the borrower, only to someone the borrower already made a driver.
    const refusal = handoffRefusal(vehicle, me, input.to)
    if (refusal) throw new WorldError('forbidden', refusal)
    for (const [offerId, offer] of rt.offers) if (offer.vehicleId === vehicle.id) rt.offers.delete(offerId)
    const offer: DriverOfferRec = { id: `vo_${randomToken(12)}`, vehicleId: vehicle.id, from: me, to: input.to, expiresAt: iso(ctx.now + VEHICLE_RULES.offerSeconds * SECOND), controlEpoch: vehicle.control.controlEpoch }
    rt.offers.set(offer.id, offer)
    pushSelf(world, rt, input.to)
    return { offer: driverOfferView(offer) }
  })

  world.register('vehicle.acceptDriver', value => {
    const raw = obj(value)
    return { offerId: str(raw, 'offerId', { min: 6, max: 40 }), expectedRevision: revisionIn(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const offer = rt.offers.get(input.offerId)
    if (!offer || offer.to !== me) throw new WorldError('not_found', 'That offer was not found.')
    if (Date.parse(offer.expiresAt) <= ctx.now) { rt.offers.delete(offer.id); throw new WorldError('expired', 'That offer has lapsed.') }
    const vehicle = findVehicle(rt, offer.vehicleId)
    checkRevision(vehicle, input.expectedRevision)
    const mine = rt.seatOf.get(me), theirs = rt.seatOf.get(offer.from)
    if (vehicle.control.kind !== 'member' || vehicle.control.driverId !== offer.from || vehicle.control.controlEpoch !== offer.controlEpoch || mine?.vehicle !== vehicle || theirs?.vehicle !== vehicle) { rt.offers.delete(offer.id); throw new WorldError('conflict', 'The vehicle has changed since the wheel was offered.') }
    const refusal = handoffRefusal(vehicle, offer.from, me)
    if (refusal) { rt.offers.delete(offer.id); pushSelf(world, rt, me); throw new WorldError('forbidden', refusal) }
    if (moving(vehicle)) throw new WorldError('conflict', 'The vehicle has to be stopped for the wheel to change hands.')
    if (vehicle.crossing !== null) throw new WorldError('conflict', 'The vehicle is crossing into the next district. Take the wheel when it has.')
    closeDoors(rt, vehicle, ctx.now)
    if (vehicle.transitions.length > 0) throw new WorldError('conflict', 'Wait for the doors to close.')
    // The two change seats in one go, and the old driver's controls stop counting at the same moment.
    rt.offers.delete(offer.id)
    const passengerSeat = mine.seatId
    vehicle.seats.set('driver', { memberId: me, held: null })
    vehicle.seats.set(passengerSeat, { memberId: offer.from, held: null })
    rt.seatOf.set(me, { vehicle, seatId: 'driver' })
    rt.seatOf.set(offer.from, { vehicle, seatId: passengerSeat })
    if (vehicle.ownerId !== me) vehicle.grants.set(me, 'driver')
    takeControl(rt, vehicle, me)
    vehicle.speed = 0
    vehicle.epoch = `${rt.boot}-${++rt.counter}`
    carry(world, rt, vehicle)
    announce(world, me)
    announce(world, offer.from)
    publish(world, rt, vehicle)
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me) }
  })

  /** Turn a destination into a point on a road the service knows, with a name for it. */
  function resolve(roads: RoadAuthority, destination: VehicleDestination): { districtId: DistrictId; pos: Vec2; label: string } | string {
    if (!roads.supports(destination.districtId)) return 'That place is outside the districts vehicles can reach. Use Travel to go there.'
    if (destination.kind === 'place') {
      const place = roads.placeOf(destination.districtId, destination.placeId)
      return place ? { districtId: destination.districtId, pos: place.roadPos, label: place.name } : 'That place is not on a road a vehicle can reach.'
    }
    const near = roads.snap(destination.districtId, destination.pos, VEHICLE_RULES.destinationSnapMetres)
    if (!near) return 'That point is not near a road a vehicle can reach.'
    const named = roads.nearestPlace(destination.districtId, near.pos, 200)
    return { districtId: destination.districtId, pos: near.pos, label: named ? `Near ${named.name}` : 'The point you chose on the map' }
  }

  world.register('vehicle.quote', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), destination: destinationIn(raw.destination) }
  }, (ctx, input) => {
    const me = ctx.memberId
    const { roads } = ready(me)
    const vehicle = findVehicle(rt, input.vehicleId)
    here(world, vehicle, me)
    if (vehicle.source !== 'service') throw new WorldError('conflict', 'A borrowed vehicle is driven by a member and is free to ride in. There is nothing to book.')
    world.limit(`vehicle-quote:${me}`, 20, MINUTE)
    const balance = careerPoints(world, me)
    const base = { id: newId<VehicleQuoteId>('vq'), vehicleId: vehicle.id, expiresAt: iso(ctx.now + VEHICLE_RULES.quoteSeconds * SECOND), destination: input.destination, balance }
    const refuse = (reason: string, label = ''): { quote: VehicleQuote } => ({ quote: { ...base, label, fare: 0, routeMetres: 0, estimatedSeconds: 0, allowed: false, reason } })
    // Nobody is hired into a vehicle with someone still in it: not past a block, and not with riders who never agreed to the new ride.
    if (!hireable(vehicle)) return refuse(vehicle.trip === null && aboard(vehicle).length > 0 ? 'This vehicle is not free yet: its last ride has only just ended. Try another, or wait until it is empty.' : 'This vehicle is already taken.')
    const target = resolve(roads, input.destination)
    if (typeof target === 'string') return refuse(target)
    const route = roads.route({ districtId: vehicle.room.districtId, pos: vehicle.pos, heading: vehicle.heading }, target)
    if (!route) return refuse('There is no road from here to there that a vehicle can take.', target.label)
    if (route.metres < 30) return refuse('That is right here. It is quicker to walk.', target.label)
    const fare = vehicleFare(vehicle.kind, route.metres)
    const reach = streetAdmission(world, me, districtRef(target.districtId))
    const reason = reach ?? (balance < fare ? `The fare is ${fare} coins and you have ${balance}. Work a shift or play a game to earn more.` : '')
    const quote: QuoteRec = {
      ...base, label: target.label, fare, routeMetres: Math.round(route.metres), estimatedSeconds: Math.ceil(route.metres / (vehicle.spec.maxSpeed * 0.7)) + 5, allowed: reason === '', reason,
      memberId: me, target: { districtId: target.districtId, pos: target.pos }, route: route.points, dataVersion: roads.dataVersion, used: false,
    }
    rt.quotes.set(quote.id, quote)
    const { memberId: _member, target: _target, route: _route, dataVersion: _version, used: _used, ...shown } = quote
    return { quote: shown }
  })

  /**
   * The answer to a booking, from its saved record: the same for the first call and for every retry.
   * The receipt is the caller's own and always given. The vehicle is given only while it is still on
   * the ride this receipt paid for and the caller may see it; after that it is null, whoever has it now.
   */
  const recoveryOf = (receipt: ReceiptRec): VehicleBookingRecovery | null => {
    if (typeof receipt.vehicleId !== 'string' || !/^vh_[a-z0-9_-]{1,80}$/.test(receipt.vehicleId)
      || typeof receipt.tripId !== 'string' || !/^vt_[a-z0-9_-]{1,80}$/.test(receipt.tripId)) return null
    const identity = { vehicleId: receipt.vehicleId, tripId: receipt.tripId }
    switch (receipt.state) {
      case 'boarding': case 'en-route': {
        const trip = rt.vehicles.get(receipt.vehicleId)?.trip
        if (!trip || trip.mode !== 'paid-service' || trip.receiptId !== receipt.id || trip.id !== receipt.tripId || trip.payer !== receipt.memberId) {
          throw new WorldError('unavailable', 'Your payment is recorded, but this ride cannot be recovered right now. Check the same booking again.')
        }
        return receipt.cancelRequestedAt ? { ...identity, kind: 'stopping' } : { ...identity, kind: 'active', stage: receipt.state }
      }
      case 'arrived': case 'cancelled': case 'failed': case 'abandoned':
        return { ...identity, kind: 'ended', outcome: receipt.state, refunded: receipt.refund?.amount ?? 0 }
      default: { const exhaustive: never = receipt.state; return exhaustive }
    }
  }
  const booked = (me: MemberId, receipt: ReceiptRec) => {
    if (receipt.memberId !== me) throw new WorldError('not_found', 'That booking receipt was not found.')
    const vehicle = rt.vehicles.get(receipt.vehicleId)
    return {
      vehicle: vehicle && vehicle.trip?.receiptId === receipt.id ? shown(vehicle.id, me) : null, self: selfOf(world, rt, me),
      receipt: { id: receipt.id, fare: receipt.fare, balance: careerPoints(world, me), recovery: recoveryOf(receipt) },
    }
  }

  world.register('vehicle.book', value => {
    const raw = obj(value)
    return { quoteId: id<VehicleQuoteId>(raw, 'quoteId', 'vq'), entryId: entryIn(raw), requestId: requestId(raw) }
  }, (ctx, input) => {
    const me = ctx.memberId
    roadsOrRefuse()
    const key = `book|${input.quoteId}|${input.entryId}`
    // Asked before? Then it is answered from the record, and no coin moves.
    const done = saved(world)?.requests[me]?.[input.requestId]
    if (done) {
      if (done.key !== key) throw new WorldError('conflict', 'That request id was already used for something else.')
      const receipt = saved(world)?.receipts[done.receiptId]
      if (!receipt) throw new WorldError('expired', 'That ride is over. Your wallet shows what was paid and returned.')
      answerAfterSave()
      return booked(me, receipt)
    }
    const { roads } = ready(me)
    world.limit(`vehicle-book:${me}`, 10, MINUTE)
    const quote = rt.quotes.get(input.quoteId)
    if (!quote || quote.memberId !== me) throw new WorldError('not_found', 'That quote was not found. Ask for the fare again.')
    if (quote.used) throw new WorldError('conflict', 'That quote has already been used.')
    if (Date.parse(quote.expiresAt) <= ctx.now || quote.dataVersion !== roads.dataVersion) throw new WorldError('expired', 'That quote has lapsed. Ask for the fare again.')
    if (!quote.allowed) throw new WorldError('conflict', quote.reason)
    const vehicle = findVehicle(rt, quote.vehicleId)
    const at = here(world, vehicle, me)
    if (rt.seatOf.has(me)) throw new WorldError('conflict', SEATED)
    // The same rule as the quote, asked again now, and before a single coin moves.
    if (!hireable(vehicle)) throw new WorldError('conflict', vehicle.trip === null && aboard(vehicle).length > 0 ? 'This vehicle is not free yet: someone is still in it. Nothing was charged.' : 'This vehicle has just been taken. Ask for the fare again.')
    const reach = streetAdmission(world, me, districtRef(quote.target.districtId))
    if (reach) throw new WorldError('forbidden', reach)
    if (!atEntry(vehicle, input.entryId, at.pos)) throw new WorldError('forbidden', 'Go up to that side of the vehicle to get in.')
    // The free seat nearest that door, reached without climbing over anyone.
    const spec = vehicle.spec.seats
      .filter(candidate => candidate.role === 'passenger' && candidate.entries.includes(input.entryId) && !vehicle.seats.get(candidate.id)!.memberId && !vehicle.seats.get(candidate.id)!.held && !barred(vehicle, candidate, input.entryId))
      .sort((a, b) => a.entries.indexOf(input.entryId) - b.entries.indexOf(input.entryId))[0]
    if (!spec) throw new WorldError('conflict', 'There is no free seat on that side of the vehicle.')
    // Everything has been checked. The fare is taken whole or not at all; the receipt, the seat and the record of this request follow in the same step.
    const paid = chargeVehicleFare(world, me, quote.fare, `${vehicle.spec.label} to ${quote.label}`)
    quote.used = true
    const tripId = `vt_${randomToken(12)}`
    const receipt: ReceiptRec = {
      id: `vr_${randomToken(12)}`, memberId: me, vehicleId: vehicle.id, tripId, kind: vehicle.kind, destination: quote.destination, label: quote.label, fare: quote.fare, routeMetres: quote.routeMetres,
      ledgerId: paid.ledgerId, bookedAt: iso(ctx.now), state: 'boarding', riders: [], checkpoint: null, refund: null, closedAt: null, resumed: [],
    }
    const data = slice(world)
    data.receipts[receipt.id] = receipt
    ;(data.requests[me] ??= {})[input.requestId] = { key, receiptId: receipt.id, refunded: null, at: iso(ctx.now) }
    world.touch()
    vehicle.trip = {
      id: tripId, destination: quote.destination, label: quote.label, mode: 'paid-service', fare: quote.fare, state: 'boarding', payer: me, receiptId: receipt.id,
      target: quote.target, route: quote.route, index: 1, along: { ...quote.route[0]!.pos }, lane: 0, bookedAt: ctx.now, blockedSince: null, failedCrossings: 0, savedAt: ctx.now, cancelling: false,
    }
    vehicle.control = { kind: 'service', bookingMemberId: me }
    vehicle.phase = 'boarding'
    vehicle.grants.clear()
    vehicle.rideEndedAt = null
    vehicle.notice = ''
    sit(world, rt, vehicle, spec, me)
    passThrough(world, rt, vehicle, 'board', input.entryId, spec.id, me)
    publish(world, rt, vehicle)
    return booked(me, receipt)
  })

  /** The paid ride of this vehicle, for the member who paid for it. */
  const charter = (vehicle: Vehicle, me: MemberId): Trip => {
    const trip = vehicle.trip
    if (!trip || trip.mode !== 'paid-service') throw new WorldError('conflict', 'This vehicle has no paid ride.')
    if (trip.payer !== me) throw new WorldError('forbidden', 'Only the member who paid for this ride can do that.')
    return trip
  }

  world.register('vehicle.depart', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), expectedRevision: revisionIn(raw), requestId: requestId(raw) }
  }, (ctx, input) => {
    const roads = roadsOrRefuse()
    const me = ctx.memberId
    const key = `depart|${input.vehicleId}`
    if (repeated(rt, me, input.requestId, key)) { answerAfterSave(); return { vehicle: shown(input.vehicleId, me), self: selfOf(world, rt, me) } }
    const vehicle = findVehicle(rt, input.vehicleId)
    const trip = charter(vehicle, me)
    if (trip.state !== 'boarding') throw new WorldError('conflict', 'This ride has already left.')
    checkRevision(vehicle, input.expectedRevision)
    if (rt.seatOf.get(me)?.vehicle !== vehicle) throw new WorldError('conflict', 'Get in before the ride leaves.')
    // Nobody is left half in a doorway: it leaves when everyone getting in or out has finished and the doors are shut.
    closeDoors(rt, vehicle, ctx.now)
    if (vehicle.transitions.length > 0) throw new WorldError('conflict', 'Wait until everyone is in and the doors are shut.')
    const riders = seated(vehicle)
    // Everyone aboard has to be allowed where the ride is going. The sentence does not say who is not.
    if (riders.some(rider => streetAdmission(world, rider, districtRef(trip.target.districtId)) !== null)) throw new WorldError('conflict', 'Someone aboard cannot travel to that district. They need to step out before the ride can leave.')
    // The road data has not changed under the route.
    const first = trip.route[0]!
    if (first.districtId !== vehicle.room.districtId || !roads.supports(trip.target.districtId)) throw new WorldError('conflict', 'The route is no longer valid. Cancel the ride to get your fare back.')
    trip.state = 'en-route'
    // Set off from where the vehicle stands: beside the centre line by as much as it is parked to the side of it.
    const second = trip.route[1]!
    const length = Math.hypot(second.pos.x - first.pos.x, second.pos.z - first.pos.z) || 1
    const ux = (second.pos.x - first.pos.x) / length, uz = (second.pos.z - first.pos.z) / length
    const forward = (vehicle.pos.x - first.pos.x) * ux + (vehicle.pos.z - first.pos.z) * uz
    trip.along = { x: first.pos.x + ux * Math.max(0, forward), z: first.pos.z + uz * Math.max(0, forward) }
    trip.lane = (vehicle.pos.x - trip.along.x) * uz - (vehicle.pos.z - trip.along.z) * ux
    trip.index = 1
    const receipt = trip.receiptId ? slice(world).receipts[trip.receiptId] : undefined
    if (receipt) { receipt.state = 'en-route'; receipt.riders = riders; receipt.checkpoint = { districtId: vehicle.room.districtId, pos: { ...vehicle.pos }, heading: vehicle.heading }; world.touch() }
    vehicle.phase = 'driving'
    vehicle.simAt = ctx.now
    vehicle.carry = 0
    rt.active.add(vehicle)
    remember(world, rt, me, input.requestId, key, { vehicleId: vehicle.id })
    publish(world, rt, vehicle)
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me) }
  })

  world.register('vehicle.cancelTrip', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), tripId: str(raw, 'tripId', { min: 6, max: 40 }), requestId: requestId(raw) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const me = ctx.memberId
    const key = `cancel|${input.vehicleId}|${input.tripId}`
    const done = saved(world)?.requests[me]?.[input.requestId]
    if (done) {
      if (done.key !== key) throw new WorldError('conflict', 'That request id was already used for something else.')
      // What was decided then, from the record. The vehicle only if the caller may still see it.
      answerAfterSave()
      return { vehicle: shown(input.vehicleId, me), self: selfOf(world, rt, me), refund: done.refunded ? { receiptId: done.receiptId, amount: done.refunded } : null }
    }
    const vehicle = findVehicle(rt, input.vehicleId)
    const trip = charter(vehicle, me)
    if (trip.id !== input.tripId) throw new WorldError('conflict', 'That is not this vehicle\'s ride.')
    if (trip.state === 'arrived') throw new WorldError('conflict', 'This ride has arrived.')
    const data = slice(world)
    const receiptId = trip.receiptId ?? ''
    let refunded: number | null = null
    if (trip.state === 'boarding') {
      // Before it leaves: everyone is stood beside the vehicle, the fare comes back once, the vehicle is free again.
      // If there is not a clear place for each of them, nothing happens at all.
      const party = seated(vehicle)
      const spots: { memberId: MemberId; pos: Vec2; heading: number; entryId: string }[] = []
      for (const rider of party) {
        const spot = exitSpot(rt, vehicle, seatSpec(vehicle, rt.seatOf.get(rider)!.seatId)!, spots.map(entry => entry.pos))
        if (!spot) throw new WorldError('conflict', 'There is not clear space for everyone to step out here. Try again in a moment.')
        spots.push({ memberId: rider, ...spot })
      }
      for (const spot of spots) unsit(world, rt, vehicle, spot.memberId, spot)
      for (const seat of vehicle.seats.values()) if (seat.held) releaseHeld(world, rt, seat.held.memberId)
      const receipt = closeReceipt(world, trip.receiptId, 'cancelled')
      refunded = receipt ? refund(world, receipt, 'cancelled') : 0
      vehicle.trip = null; vehicle.control = { kind: 'none' }; vehicle.grants.clear(); vehicle.phase = 'parked'; vehicle.notice = ''
      for (const spot of spots) pushSelf(world, rt, spot.memberId)
      publish(world, rt, vehicle)
    } else {
      // On the way. Nothing comes back for a ride its payer ends, and nobody is moved. The decision is saved now,
      // so that a restart before the vehicle has stopped cannot turn it into a refund.
      const receipt = data.receipts[receiptId]
      if (receipt) receipt.cancelRequestedAt = iso(ctx.now)
      if (moving(vehicle)) {
        // It stops where it safely can, and the ride ends there.
        trip.cancelling = true
        rt.active.add(vehicle)
        publish(world, rt, vehicle)
      } else {
        // Already at a standstill, waiting to cross or held up: the ride ends here. A crossing that was waiting is called off with it,
        // in the same step, so its tokens can carry nobody over afterwards.
        endTrip(world, rt, vehicle, 'cancelled', 'The ride was cancelled. Step out when you are ready.')
      }
    }
    ;(data.requests[me] ??= {})[input.requestId] = { key, receiptId, refunded, at: iso(ctx.now) }
    world.touch()
    return { vehicle: snapshotFor(world, vehicle, me), self: selfOf(world, rt, me), refund: refunded ? { receiptId, amount: refunded } : null }
  })

  world.register('vehicle.destination', value => {
    const raw = obj(value)
    return { vehicleId: vehicleId(raw), destination: destinationIn(raw.destination), expectedRevision: revisionIn(raw) }
  }, (ctx, input) => {
    const roads = roadsOrRefuse()
    const me = ctx.memberId
    const vehicle = findVehicle(rt, input.vehicleId)
    if (vehicle.control.kind !== 'member' || vehicle.control.driverId !== me) throw new WorldError('forbidden', 'Only the driver sets where the vehicle is going.')
    checkRevision(vehicle, input.expectedRevision)
    const target = resolve(roads, input.destination)
    if (typeof target === 'string') throw new WorldError('conflict', target)
    const route = roads.route({ districtId: vehicle.room.districtId, pos: vehicle.pos }, target)
    if (!route) throw new WorldError('conflict', 'There is no road from here to there that a vehicle can take.')
    vehicle.trip = {
      id: `vt_${randomToken(12)}`, destination: input.destination, label: target.label, mode: 'navigation', fare: 0, state: 'en-route', payer: null, receiptId: null,
      target: { districtId: target.districtId, pos: target.pos }, route: route.points, index: 1, along: { ...vehicle.pos }, lane: 0, bookedAt: ctx.now, blockedSince: null, failedCrossings: 0, savedAt: ctx.now, cancelling: false,
    }
    publish(world, rt, vehicle)
    // The way to show, as far as the edge of this district.
    const shown: Vec2[] = []
    for (const point of route.points) { if (point.districtId !== vehicle.room.districtId) break; shown.push(point.pos) }
    return { vehicle: snapshotFor(world, vehicle, me), route: shown }
  })

  world.register('vehicle.ackTransfer', value => {
    const raw = obj(value)
    return { transferId: str(raw, 'transferId', { min: 6, max: 40 }), token: str(raw, 'token', { min: 12, max: 60 }) }
  }, (ctx, input) => {
    roadsOrRefuse()
    const crossing = rt.crossings.get(input.transferId)
    const me = ctx.memberId
    // One answer for an unknown crossing, another member's, and a wrong or replaced token: nothing to tell them apart by.
    if (!crossing || crossing.tokens.get(me) !== input.token) throw new WorldError('forbidden', 'That crossing is not yours to confirm.')
    const calledOff = (): never => { throw new WorldError('expired', 'That crossing was called off. The vehicle is where it was.') }
    // Answering again after it happened is answered the same way, for those it carried. It moves nobody twice.
    if (crossing.state === 'committed') return crossing.carried.includes(me) ? { accepted: true as const, status: 'committed' as const } : calledOff()
    // Called off, replaced, out of time, or the vehicle's control was reset since: this record can do nothing more.
    if (crossing.state === 'aborted') return calledOff()
    if (!pending(rt, crossing) || crossing.expiresAt <= ctx.now) { abortCrossing(world, rt, crossing, 'Not everyone was ready to cross into the next district. Try again.'); return calledOff() }
    // Only from a seat in that vehicle. Someone whose seat is being kept takes it again first (vehicle.resume), and is given a new token then.
    if (rt.seatOf.get(me)?.vehicle !== crossing.vehicle) throw new WorldError('conflict', 'Take your seat again before confirming the crossing.')
    crossing.acked.add(me)
    // When everyone still aboard has loaded the next district, they all go at once. Until then, and while a seat is being kept, it waits.
    settleCrossing(world, rt, crossing)
    const state = crossing.state as Crossing['state']
    if (state === 'aborted') return calledOff()
    return { accepted: true as const, status: state === 'committed' ? 'committed' as const : 'waiting' as const }
  })

  world.register('vehicle.resume', empty, ctx => {
    const me = ctx.memberId
    if (sharded || !roadsOf(rt)) return { self: { seat: null, vehicle: null, balance: careerPoints(world, me), offer: null, notice: '' }, snapshot: null }
    const roads = roadsOf(rt)!
    const held = rt.heldOf.get(me)
    const seat = held?.vehicle.seats.get(held.seatId)
    // Back within the grace, and still allowed there as things stand now (not as they stood when the connection dropped):
    // into the same seat, in the vehicle's room, placed by the service. Otherwise the seat is given up below and they return on foot.
    if (held && seat?.held?.memberId === me && seat.held.until > ctx.now && mayKeepSeat(world, held.vehicle, seatSpec(held.vehicle, held.seatId)!, me)) {
      const { vehicle, seatId } = held
      const spec = seatSpec(vehicle, seatId)!
      rt.moving.add(me)
      try {
        admitReservedTo(world, me, held.place.ref, held.place.instance, seatPos(vehicle, spec), vehicle.heading)
        // Admission consumed the place atomically. Remove its owner without releasing again.
        rt.heldOf.delete(me)
      } finally { rt.moving.delete(me) }
      sit(world, rt, vehicle, spec, me)
      // The wheel is theirs again only if nobody else took it, and with a new epoch: nothing sent before the drop counts.
      const mayDrive = vehicle.source === 'borrowed' && (vehicle.ownerId === me || vehicle.grants.get(me) === 'driver')
      if (seatId === 'driver' && vehicle.control.kind === 'none' && mayDrive) takeControl(rt, vehicle, me)
      publish(world, rt, vehicle)
      // The vehicle was waiting to cross with their seat kept: they are told again which district to load, with a new token.
      // The one sent before the drop is void. Had they not been part of that crossing, it is called off and tried again with them.
      const crossing = vehicle.crossing ? rt.crossings.get(vehicle.crossing) : undefined
      if (crossing && pending(rt, crossing)) {
        if (crossing.tokens.has(me)) { crossing.tokens.set(me, randomToken(24)); crossing.acked.delete(me); tellCrossing(world, crossing, me) }
        else abortCrossing(world, rt, crossing, 'A rider came back, so the crossing starts again.')
      }
      return { self: selfOf(world, rt, me), snapshot: roomFor(world, me) }
    }
    if (held) releaseHeld(world, rt, me)
    if (placeOf(world, me)) {
      // Seated callers receive the current viewer-scoped room with self from the same call.
      const self = selfOf(world, rt, me)
      return { self, snapshot: self.seat ? roomFor(world, me) : null }
    }
    // The seat is gone: on foot, where the service put them down. After a restart that is beside where their ride had got to.
    let pose: Pose | null = rt.foot.get(me)?.pose ?? null
    if (!pose) {
      // Only a ride that a restart cut short. One that ended while the service was up left its riders seated or on foot where they were.
      const receipt = Object.values(saved(world)?.receipts ?? {}).find(entry => entry.interrupted === true && entry.checkpoint !== null && entry.riders.includes(me) && !entry.resumed.includes(me) && entry.closedAt !== null && ctx.now - Date.parse(entry.closedAt) < 10 * MINUTE)
      if (receipt?.checkpoint) {
        const at = receipt.checkpoint
        const spot = VEHICLE_SPECS[receipt.kind].entries.map(entry => vehiclePoint(at.pos, at.heading, entry.x, entry.z)).find(point => roads.standable(at.districtId, point, 0.4, homeSolids(rt, at.districtId)))
        if (spot) pose = { districtId: at.districtId, pos: spot, heading: at.heading }
        slice(world).receipts[receipt.id]!.resumed.push(me)
        world.touch()
      }
    }
    rt.foot.delete(me)
    if (!pose || streetAdmission(world, me, districtRef(pose.districtId)) !== null || !roads.standable(pose.districtId, pose.pos, 0.4, homeSolids(rt, pose.districtId))) return { self: selfOf(world, rt, me), snapshot: null }
    const ref = districtRef(pose.districtId)
    const instance = holdPlaces(world, ref, 1)
    if (instance === null) return { self: selfOf(world, rt, me), snapshot: null }
    let snapshot: RoomSnapshot
    try { snapshot = admitTo(world, me, ref, instance, pose.pos, pose.heading).snapshot } finally { releasePlaces(world, ref, instance, 1) }
    return { self: selfOf(world, rt, me), snapshot }
  })
}
