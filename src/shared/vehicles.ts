// Vehicles: the contract between the App and the world service for kekes, danfos and cars.
//
// The service owns every vehicle: who is in which seat, who drives, where it is, what a ride costs.
// The App sends intents (board this seat, steer this much, take me there) and shows what it is told.
// Nothing here is a position, a fare or a seat chosen by the browser. Pure data and pure maths:
// no three.js, no service code. See docs/transport/VEHICLE-SYSTEM-PLAN.md (v0.3).
import type { DistrictId, Iso, MemberId, PlaceId, RoomKey, VehicleId, VehicleInviteId, VehicleQuoteId } from './ids.ts'
import type { Vec2 } from './geo.ts'
import type { RoomSnapshot } from './model.ts'

export const VEHICLE_KINDS = ['keke', 'danfo', 'car'] as const
export type VehicleKind = (typeof VEHICLE_KINDS)[number]
export type SeatId = 'driver' | `passenger-${number}`
export const VEHICLE_ACCESS = ['owner', 'friends', 'invite'] as const
/**
 * Who may board a borrowed vehicle besides its borrower.
 *   'owner'   — nobody. Invitations cannot be made and earlier ones are not honoured.
 *   'invite'  — members who accepted an invitation to this vehicle.
 *   'friends' — those, and friends both sides accepted (never a friendship the service made).
 */
export type VehicleAccess = (typeof VEHICLE_ACCESS)[number]
export type VehiclePhase = 'parked' | 'boarding' | 'driving' | 'stopping' | 'transferring'

/** A place on the map to go to. The service resolves it to a point on a road it knows; nothing else is trusted. */
export type VehicleDestination =
  | { kind: 'point'; districtId: DistrictId; pos: Vec2 }
  | { kind: 'place'; districtId: DistrictId; placeId: PlaceId }

/**
 * Who is in a seat, as this viewer may know it. `hidden` is someone the viewer is blocked with in
 * either direction: the seat is taken and cannot be boarded, and no identity is given.
 */
export type VehicleSeatOccupant = { kind: 'member'; memberId: MemberId } | { kind: 'hidden' } | null
export interface VehicleSeat {
  id: SeatId
  role: 'driver' | 'passenger'
  occupant: VehicleSeatOccupant
  /** A seat the service keeps for itself (the driver's seat of a paid vehicle). Nobody can take it. */
  reservedByService: boolean
}

/** `driverId` and `bookingMemberId` are null when that member is hidden from the viewer. Null never means "free to drive". */
export type VehicleControl =
  | { kind: 'member'; driverId: MemberId | null; controlEpoch: string }
  | { kind: 'service'; bookingMemberId: MemberId | null }
  | { kind: 'none' }

export interface VehicleTrip {
  id: string
  destination: VehicleDestination
  label: string
  /** 'navigation' is a driver's own destination and costs nothing. 'paid-service' is a charter. */
  mode: 'navigation' | 'paid-service'
  fare: number
  state: 'boarding' | 'en-route' | 'arrived'
}

/**
 * Someone getting in or out through one entry. The service starts it and says when it ends; the
 * scene opens that entry's door and moves the avatar through it between the two times. While any
 * transition is under way the vehicle does not move.
 */
export interface VehicleTransition {
  id: string
  kind: 'board' | 'exit'
  /** The entry actually used: the one named in the request for boarding, the one the service chose for leaving. */
  entryId: string
  seatId: SeatId
  /** Who, as this viewer may know it. A hidden member's transition is still shown: the door opens for everyone. */
  member: { kind: 'member'; memberId: MemberId } | { kind: 'hidden' }
  /** Service time. */
  startedAt: Iso
  endsAt: Iso
}

export interface VehicleSnapshot {
  id: VehicleId
  kind: VehicleKind
  /** 'borrowed' is a vehicle the service lent to one member; 'service' is a paid vehicle the service drives. Nobody owns either. */
  source: 'borrowed' | 'service'
  /** Rises with every change to seats, access, control, phase or trip. Movement does not change it. */
  revision: number
  /** Changes when the service restarts or the vehicle's control is reset. Movement from an older epoch is void. */
  epoch: string
  room: { key: RoomKey; instance: number; districtId: DistrictId }
  pos: Vec2
  heading: number
  speed: number
  /** Road-wheel angle in radians, positive to the left. */
  steering: number
  phase: VehiclePhase
  /** The borrower. Null for a service vehicle, and when the borrower is hidden from the viewer. */
  ownerId: MemberId | null
  access: VehicleAccess
  control: VehicleControl
  seats: VehicleSeat[]
  /**
   * Entry ids whose doors are open now. Decided by the service alone: an entry is open exactly
   * while someone is getting in or out through it. Every viewer is sent the same list.
   */
  openEntries: readonly string[]
  /** The boardings and exits under way, oldest first. */
  transitions: readonly VehicleTransition[]
  trip: VehicleTrip | null
}

export interface VehicleQuote {
  id: VehicleQuoteId
  vehicleId: VehicleId
  expiresAt: Iso
  destination: VehicleDestination
  label: string
  /** For the whole vehicle, in game coins. Whoever books pays it once; nobody else pays. */
  fare: number
  balance: number
  routeMetres: number
  estimatedSeconds: number
  allowed: boolean
  /** Why not, when `allowed` is false. Empty otherwise. */
  reason: string
}

export interface VehicleInvite {
  id: VehicleInviteId
  vehicleId: VehicleId
  inviter: MemberId
  recipient: MemberId
  role: 'passenger' | 'driver'
  expiresAt: Iso
  status: 'pending' | 'accepted' | 'declined' | 'expired'
}

/** A stopped driver offering the wheel to one seated member. It is control of this ride, not the vehicle. */
export interface DriverOffer { id: string; vehicleId: VehicleId; from: MemberId; to: MemberId; expiresAt: Iso }

export interface VehicleSelf {
  seat: null | { vehicleId: VehicleId; seatId: SeatId }
  /** The vehicle the member sits in, else the one they have borrowed if it is in their room. */
  vehicle: VehicleSnapshot | null
  balance: number
  /** An offer of the wheel waiting for this member's answer. (Added to the plan's shape: an offer had no other way to reach its recipient.) */
  offer: DriverOffer | null
  /** Why the vehicle last stopped or refused something, in a sentence. Empty when there is nothing to say. (Added to the plan's shape.) */
  notice: string
}

export interface VehicleActions { board: boolean; drive: boolean; book: boolean; exit: boolean; handoff: boolean }
/** The payer's original transaction identity. It does not grant visibility or authority over a vehicle. */
export type VehicleBookingRecovery = { vehicleId: VehicleId; tripId: string } & (
  | { kind: 'active'; stage: 'boarding' | 'en-route' }
  | { kind: 'stopping' }
  | { kind: 'ended'; outcome: 'arrived' | 'cancelled' | 'failed' | 'abandoned'; refunded: number }
)
export interface VehicleReceipt {
  id: string; fare: number; balance: number
  /** Null for historical records without their original trip identity. No identity is inferred from wallet text. */
  recovery: VehicleBookingRecovery | null
}
/** Which road data the service is using. The App compares it with the scene it loaded (vehicleRoadData.ts). */
export interface VehicleDataVersion { id: string; dataVersion: string; mapDataVersion: string }
export interface VehicleDepotView { id: string; districtId: DistrictId; pos: Vec2; heading: number }

type Op<In, Out> = { in: In; out: Out }
type Nothing = Record<string, never>

export interface VehicleOps {
  /**
   * Everything about vehicles around the member. `available` is false, with the reason, where the
   * service has no road data, on a sharded service, or outside a street room. `data` and `depots`
   * are added to the plan's shape: the App needs the data version to compare, and a depot to borrow at.
   */
  'vehicle.state': Op<Nothing, {
    available: boolean; reason: string; self: VehicleSelf; vehicles: VehicleSnapshot[]; invites: VehicleInvite[]
    data: VehicleDataVersion | null; depots: VehicleDepotView[]
  }>
  'vehicle.inspect': Op<{ vehicleId: VehicleId }, { vehicle: VehicleSnapshot; self: VehicleSelf; actions: VehicleActions }>
  /** Borrow a vehicle at a depot. One at a time for each member. */
  'vehicle.loan': Op<{ depotId: string; kind: VehicleKind; requestId: string }, { vehicle: VehicleSnapshot; self: VehicleSelf }>
  'vehicle.return': Op<{ vehicleId: VehicleId; expectedRevision: number; requestId: string }, { returned: true; self: VehicleSelf }>
  'vehicle.board': Op<{ vehicleId: VehicleId; seatId: SeatId; entryId: string; expectedRevision: number; inviteId?: VehicleInviteId; requestId: string }, { vehicle: VehicleSnapshot; self: VehicleSelf }>
  /**
   * `pos` and `heading` are where the service stood the member. The App uses them and nothing of its own.
   * `vehicle` is null only in the answer to a repeated request, when the caller may no longer see that vehicle.
   */
  'vehicle.exit': Op<{ vehicleId: VehicleId; requestId: string }, { vehicle: VehicleSnapshot | null; self: VehicleSelf; pos: Vec2; heading: number }>
  /**
   * The driver's controls, at most 20 a second. Never a position, a speed or a time.
   * `steer` is the driver's hand: -1 full left, +1 full right. `throttle` is -1 (reverse) to 1.
   */
  'vehicle.input': Op<{ vehicleId: VehicleId; controlEpoch: string; seq: number; throttle: number; steer: number; brake: boolean }, { accepted: boolean; lastSeq: number }>
  'vehicle.access': Op<{ vehicleId: VehicleId; access: VehicleAccess; expectedRevision: number }, { vehicle: VehicleSnapshot }>
  'vehicle.invite': Op<{ vehicleId: VehicleId; to: MemberId; role: 'passenger' | 'driver'; expectedRevision: number }, { invite: VehicleInvite }>
  'vehicle.respondInvite': Op<{ inviteId: VehicleInviteId; accept: boolean }, { invite: VehicleInvite }>
  'vehicle.offerDriver': Op<{ vehicleId: VehicleId; to: MemberId; expectedRevision: number }, { offer: DriverOffer }>
  'vehicle.acceptDriver': Op<{ offerId: string; expectedRevision: number }, { vehicle: VehicleSnapshot; self: VehicleSelf }>
  'vehicle.quote': Op<{ vehicleId: VehicleId; destination: VehicleDestination }, { quote: VehicleQuote }>
  /**
   * Pays the quoted fare once and takes a seat. The same `requestId` again answers the same receipt and takes nothing.
   *
   * In `book`, `depart`, `cancelTrip` and `exit`, `vehicle` is the live vehicle when the request is
   * first carried out. In the answer to a REPEATED request it is given only while the caller may
   * still see it (seated in it, or in its room instance) and, for `book`, only while it is still on
   * that ride; otherwise it is null. The receipt, the refund and the exit position are the caller's
   * own record and are always given. A record never shows what someone else is doing with the vehicle now.
   */
  'vehicle.book': Op<{ quoteId: VehicleQuoteId; entryId: string; requestId: string }, { vehicle: VehicleSnapshot | null; self: VehicleSelf; receipt: VehicleReceipt }>
  'vehicle.depart': Op<{ vehicleId: VehicleId; expectedRevision: number; requestId: string }, { vehicle: VehicleSnapshot | null; self: VehicleSelf }>
  /** Only the member who paid. Before departure the fare comes back once; after it, the vehicle stops and nothing comes back. */
  'vehicle.cancelTrip': Op<{ vehicleId: VehicleId; tripId: string; requestId: string }, { vehicle: VehicleSnapshot | null; self: VehicleSelf; refund: { receiptId: string; amount: number } | null }>
  /** A driver's own destination: the route to show, in the current district's metres. Free. */
  'vehicle.destination': Op<{ vehicleId: VehicleId; destination: VehicleDestination; expectedRevision: number }, { vehicle: VehicleSnapshot; route: Vec2[] }>
  /**
   * "I have loaded the district you sent me to." Carries no position. `waiting` until everyone still
   * aboard has answered; a rider whose connection dropped keeps their seat for the grace, and the
   * vehicle waits for them. Answered `expired` once the crossing has been called off or replaced:
   * load nothing, the vehicle is where it was. A token is void after `vehicle.resume` sends a new one.
   */
  'vehicle.ackTransfer': Op<{ transferId: string; token: string }, { accepted: true; status: 'waiting' | 'committed' }>
  /** After a reconnect: back into the seat the service kept, or on foot where it says. Takes no claim from the App. */
  'vehicle.resume': Op<Nothing, { self: VehicleSelf; snapshot: RoomSnapshot | null }>
}

export type VehicleRemovedReason = 'returned' | 'transferred' | 'withdrawn'

export type VehicleEvent =
  /** A vehicle came into view, or its seats, access, control, phase or trip changed. Filtered for the member it is sent to. */
  | { type: 'vehicle.snapshot'; vehicle: VehicleSnapshot }
  /** Where a vehicle is now. `tick` rises with every step of the service's simulation; the latest wins. `ackSeq` is the last driver input applied. */
  | { type: 'vehicle.move'; vehicleId: VehicleId; epoch: string; tick: number; ackSeq: number; pos: Vec2; heading: number; speed: number; steering: number; room: RoomKey }
  | { type: 'vehicle.removed'; vehicleId: VehicleId; epoch: string; reason: VehicleRemovedReason }
  | { type: 'vehicle.self'; self: VehicleSelf }
  | { type: 'vehicle.invite'; invite: VehicleInvite }
  /**
   * To one seated member: load this district, then answer with `vehicle.ackTransfer`. The token is
   * the service's, for this member, this crossing and this vehicle epoch only, once, until `expiresAt`.
   */
  | { type: 'vehicle.transfer'; vehicleId: VehicleId; transferId: string; token: string; expiresAt: Iso; room: { key: RoomKey; instance: number; districtId: DistrictId }; spawn: Vec2; heading: number }
  /** The whole party has moved. `snapshot` is the new room as this member may see it. */
  | { type: 'vehicle.transferred'; transferId: string; vehicle: VehicleSnapshot; self: VehicleSelf; snapshot: RoomSnapshot }

// ── The vehicles themselves ───────────────────────────────────────────────────────────────────
// One frame for every number below, the models' own (src/world/vehicles): metres, origin on the
// ground halfway between the axles, +z forward, +x the vehicle's LEFT. A heading `h` is the scene's
// rotation.y: forward is (sin h, cos h) in the district's (x east, z south), left is (cos h, −sin h).

export interface VehicleSeatSpec {
  id: SeatId; role: 'driver' | 'passenger'; x: number; z: number
  /** Entries this seat is reached from, nearest first. */
  entries: readonly string[]
  /** By entry: the seats climbed across to reach this one from there. An occupied one of them bars that way in. */
  across: Readonly<Record<string, readonly SeatId[]>>
}
export interface VehicleEntrySpec { id: string; side: 'left' | 'right'; /** Where a member stands to board, and steps out to. */ x: number; z: number }
export interface VehicleSpec {
  kind: VehicleKind
  label: string
  /** The box the service keeps clear of buildings, kerbs, vehicles and people: metres ahead of and behind the origin, and to each side. */
  footprint: { front: number; rear: number; halfWidth: number }
  wheelbase: number
  /** Largest road-wheel angle, radians. */
  maxSteer: number
  /** How fast the road wheels can be turned, radians a second. */
  steerRate: number
  maxSpeed: number
  reverseSpeed: number
  acceleration: number
  braking: number
  /** Slowing with no throttle. */
  coasting: number
  /** Sideways acceleration the vehicle will take: the steering is held inside it at speed. */
  lateral: number
  /** Whole-vehicle charter fare: `base` coins plus `perKm` for each kilometre, rounded up. Game policy, not a real price. */
  fare: { base: number; perKm: number }
  seats: readonly VehicleSeatSpec[]
  entries: readonly VehicleEntrySpec[]
}

/** How far the service's box stands outside the rendered body on every side, in metres. */
export const VEHICLE_FOOTPRINT_PADDING = 0.05

const seat = (id: SeatId, x: number, z: number, entries: readonly string[], across: Readonly<Record<string, readonly SeatId[]>> = {}): VehicleSeatSpec => ({ id, role: id === 'driver' ? 'driver' : 'passenger', x, z, entries, across })
const entry = (id: string, side: 'left' | 'right', out: number, z: number): VehicleEntrySpec => ({ id, side, x: side === 'left' ? out : -out, z })

/**
 * Seats, entries, wheelbase and steering limit are the models' own exported layout
 * (`vehicleLayout` in src/world/vehicles/models.ts), in its final frame: origin on the ground
 * halfway between the axles. The footprint is the box of the closed rendered body plus
 * VEHICLE_FOOTPRINT_PADDING. These numbers are copied, not imported: the models need three.js and
 * this file must not. They are checked against the models by a build-time comparison; a change to
 * a model has to be copied here before it ships. Speeds and fares are the plan's.
 */
export const VEHICLE_SPECS: Readonly<Record<VehicleKind, VehicleSpec>> = {
  keke: {
    // Rendered body: 1.300 ahead, 1.500 behind, 0.805 to each side.
    kind: 'keke', label: 'Keke', footprint: { front: 1.35, rear: 1.55, halfWidth: 0.855 }, wheelbase: 1.98, maxSteer: 0.5, steerRate: 1.6,
    maxSpeed: 8, reverseSpeed: 3, acceleration: 2, braking: 5, coasting: 0.8, lateral: 3, fare: { base: 3, perKm: 1 },
    seats: [
      seat('driver', 0, 0.11, ['left-front', 'right-front']),
      seat('passenger-1', 0.43, -0.83, ['left-rear', 'right-rear'], { 'right-rear': ['passenger-2', 'passenger-3'] }),
      seat('passenger-2', 0, -0.83, ['left-rear', 'right-rear'], { 'left-rear': ['passenger-1'], 'right-rear': ['passenger-3'] }),
      seat('passenger-3', -0.43, -0.83, ['right-rear', 'left-rear'], { 'left-rear': ['passenger-1', 'passenger-2'] }),
    ],
    entries: [entry('left-rear', 'left', 1, -0.37), entry('right-rear', 'right', 1, -0.37), entry('left-front', 'left', 1, 0.11), entry('right-front', 'right', 1, 0.11)],
  },
  danfo: {
    // Rendered body: 2.400 ahead, 3.045 behind, 1.160 to the wider side.
    kind: 'danfo', label: 'Danfo', footprint: { front: 2.45, rear: 3.095, halfWidth: 1.21 }, wheelbase: 3.65, maxSteer: 0.5, steerRate: 1.2,
    maxSpeed: 10, reverseSpeed: 3, acceleration: 1.6, braking: 4.5, coasting: 0.7, lateral: 2.5, fare: { base: 6, perKm: 1 },
    seats: [
      seat('driver', 0.47, 0.855, ['cab-left']),
      seat('passenger-1', -0.47, 0.855, ['cab-right']),
      seat('passenger-2', 0, 0.855, ['cab-right', 'cab-left'], { 'cab-right': ['passenger-1'], 'cab-left': ['driver'] }),
      seat('passenger-3', 0.62, -0.025, ['side']),
      seat('passenger-4', 0.62, -0.885, ['side']),
      seat('passenger-5', -0.62, -0.885, ['side']),
      seat('passenger-6', 0.62, -1.745, ['side']),
      seat('passenger-7', -0.62, -1.745, ['side']),
      seat('passenger-8', 0.45, -2.605, ['side']),
      seat('passenger-9', 0, -2.605, ['side']),
      seat('passenger-10', -0.45, -2.605, ['side']),
    ],
    entries: [entry('cab-left', 'left', 1.55, 0.775), entry('cab-right', 'right', 1.55, 0.775), entry('side', 'right', 1.55, -0.125)],
  },
  car: {
    // Rendered body: 2.160 ahead, 2.250 behind, 1.040 to each side.
    kind: 'car', label: 'Car', footprint: { front: 2.21, rear: 2.3, halfWidth: 1.09 }, wheelbase: 2.68, maxSteer: 0.6, steerRate: 1.8,
    maxSpeed: 12, reverseSpeed: 3, acceleration: 2.6, braking: 6, coasting: 0.9, lateral: 4, fare: { base: 5, perKm: 2 },
    seats: [
      seat('driver', 0.4, 0.01, ['front-left']),
      seat('passenger-1', -0.4, 0.01, ['front-right']),
      seat('passenger-2', 0.42, -0.86, ['rear-left']),
      seat('passenger-3', -0.42, -0.86, ['rear-right']),
    ],
    entries: [entry('front-left', 'left', 1.45, -0.14), entry('front-right', 'right', 1.45, -0.14), entry('rear-left', 'left', 1.45, -1.06), entry('rear-right', 'right', 1.45, -1.06)],
  },
}

/** The numbers both sides use. The service enforces them; the App explains them and paces itself by them. */
export const VEHICLE_RULES = {
  /** A member boards from within this many metres of an entry's standing point. */
  boardRangeMetres: 2,
  /** A member borrows a vehicle from within this many metres of the depot. */
  depotRangeMetres: 30,
  /** Below this the vehicle counts as stopped: boarding, leaving and handing over need it. */
  stoppedSpeed: 0.25,
  /** The service steps the simulation this often, and takes this much lateness in one go at most. */
  stepMs: 50,
  maxCatchUpMs: 100,
  /** Driver input: at most this many a second, and void after this long without a fresh one. */
  inputsPerSecond: 20,
  inputStaleMs: 250,
  /** A seat is kept this long for a member whose connection dropped. */
  seatGraceMs: 5000,
  /** How long getting in and getting out take. The door of the entry used is open for that long, and the vehicle stays still. */
  boardMs: 1500,
  exitMs: 1200,
  quoteSeconds: 30,
  transferSeconds: 15,
  inviteSeconds: 120,
  offerSeconds: 30,
  /** A paid vehicle that has not left this long after booking is released and the fare returned. */
  boardingSeconds: 300,
  /** An empty borrowed vehicle goes back to its depot after this long. */
  idleReturnSeconds: 600,
  /** A map point is taken as a destination only this close to a road the service knows. */
  destinationSnapMetres: 60,
} as const

/** The charter fare for a route of this length. */
export const vehicleFare = (kind: VehicleKind, routeMetres: number): number => {
  const { base, perKm } = VEHICLE_SPECS[kind].fare
  return Math.ceil(base + (perKm * Math.max(0, routeMetres)) / 1000)
}

/** A point given in the vehicle's frame (x left, z forward), in the district's metres. */
export function vehiclePoint(pos: Vec2, heading: number, x: number, z: number): Vec2 {
  const sin = Math.sin(heading), cos = Math.cos(heading)
  return { x: pos.x + sin * z + cos * x, z: pos.z + cos * z - sin * x }
}

/** The four corners of the footprint: front-left, front-right, rear-right, rear-left. */
export function vehicleCorners(kind: VehicleKind, pos: Vec2, heading: number, grow = 0): [Vec2, Vec2, Vec2, Vec2] {
  const { front, rear, halfWidth } = VEHICLE_SPECS[kind].footprint
  return [
    vehiclePoint(pos, heading, halfWidth + grow, front + grow), vehiclePoint(pos, heading, -halfWidth - grow, front + grow),
    vehiclePoint(pos, heading, -halfWidth - grow, -rear - grow), vehiclePoint(pos, heading, halfWidth + grow, -rear - grow),
  ]
}

/** `steering` is the road-wheel angle in radians, positive to the LEFT, as in the snapshot and the model. `speed` is negative in reverse. */
export interface VehicleMotion { pos: Vec2; heading: number; speed: number; steering: number }
/**
 * What a driver asks for. `steer` is -1 full left to +1 full right, as a driver thinks of it.
 * It is NOT the sign of `VehicleMotion.steering`, which is the road-wheel angle and positive to
 * the left: `stepVehicle` turns one into the other, once. Nothing else should flip a sign.
 */
export interface VehicleControls { throttle: number; steer: number; brake: boolean }
export const NEUTRAL_CONTROLS: VehicleControls = { throttle: 0, steer: 0, brake: true }

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const towards = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step))

/**
 * One step of the kinematic bicycle model, `dt` seconds long. The service runs it to decide where
 * a vehicle is; the driver's App may run the same function to predict, and then takes the service's
 * answer. It knows no walls: the service checks the result against its road data before using it.
 */
export function stepVehicle(kind: VehicleKind, motion: VehicleMotion, controls: VehicleControls, dt: number): VehicleMotion {
  const spec = VEHICLE_SPECS[kind]
  const throttle = controls.brake ? 0 : clamp(controls.throttle, -1, 1)
  let speed = motion.speed
  if (controls.brake) speed = towards(speed, 0, spec.braking * dt)
  else if (throttle > 0) speed = speed < 0 ? towards(speed, 0, spec.braking * dt) : Math.min(spec.maxSpeed, speed + spec.acceleration * throttle * dt)
  else if (throttle < 0) speed = speed > 0 ? towards(speed, 0, spec.braking * dt) : Math.max(-spec.reverseSpeed, speed + spec.acceleration * 0.6 * throttle * dt)
  else speed = towards(speed, 0, spec.coasting * dt)

  // The faster it goes, the less the wheels may be turned: the turn stays inside `lateral`.
  const fastest = Math.abs(speed) > 1 ? Math.atan((spec.lateral * spec.wheelbase) / (speed * speed)) : spec.maxSteer
  const limit = Math.min(spec.maxSteer, fastest)
  // The one place the driver's left/right becomes the road wheels' angle: input right (+1) is a negative, rightward, angle.
  const steering = clamp(towards(motion.steering, (0 - clamp(controls.steer, -1, 1)) * limit, spec.steerRate * dt), -limit, limit)

  // The origin is halfway between the axles, so it slips by `beta` towards the turn.
  const beta = Math.atan(0.5 * Math.tan(steering))
  const travel = motion.heading + beta
  const pos = { x: motion.pos.x + speed * Math.sin(travel) * dt, z: motion.pos.z + speed * Math.cos(travel) * dt }
  let heading = motion.heading + ((speed * Math.sin(beta)) / (spec.wheelbase / 2)) * dt
  if (heading > Math.PI) heading -= 2 * Math.PI
  else if (heading <= -Math.PI) heading += 2 * Math.PI
  return { pos, heading, speed, steering }
}
