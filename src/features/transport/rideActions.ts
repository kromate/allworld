// What is worth offering to a member who is walking about on foot: the one vehicle or depot they are standing
// next to. Plain functions over the service's own snapshots, so the rules can be run without a browser.
//
// This decides what to SHOW. It never decides whether a member may board, drive, pay or borrow: the
// service checks the seat, the access, the range (VEHICLE_RULES.boardRangeMetres, depotRangeMetres) and the
// fare, and its answer is shown as it is. The distances here are kept inside the service's so that an offer
// is not made when the answer would be "too far", and have a gap between taking an offer and letting it go
// so that standing on the edge cannot make the button come and go.
import type { MemberId, VehicleId, VehicleInviteId } from '../../shared/ids.ts'
import type { Vec2 } from '../../shared/geo.ts'
import { VEHICLE_RULES, VEHICLE_SPECS, vehiclePoint } from '../../shared/vehicles.ts'
import type { SeatId, VehicleDepotView, VehicleInvite, VehicleSnapshot } from '../../shared/vehicles.ts'

export const RIDE_REACH = {
  /** Offer a vehicle when an entry's standing point is this close. The service allows VEHICLE_RULES.boardRangeMetres (2). */
  take: 1.6,
  /** Keep offering it until the nearest entry is this far: exactly the service's own range, never beyond it. */
  keep: VEHICLE_RULES.boardRangeMetres,
  /** Offer a depot's loans this close. The service allows VEHICLE_RULES.depotRangeMetres (30). */
  depotTake: 14,
  depotKeep: 18,
} as const

export type RideTarget = { kind: 'vehicle'; id: VehicleId } | { kind: 'depot'; id: string }

export interface BoardPlan {
  seatId: SeatId
  role: 'driver' | 'passenger'
  /** The entry nearest the member that reaches this seat: the service measures the range from this entry. */
  entryId: string
  distance: number
  inviteId?: VehicleInviteId
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z)
const free = (vehicle: VehicleSnapshot, seatId: SeatId): boolean => vehicle.seats.some(seat => seat.id === seatId && !seat.occupant && !seat.reservedByService)

/** Every entry of a vehicle with where a member stands to use it, nearest first. */
export function entriesNear(vehicle: VehicleSnapshot, at: Vec2): { id: string; distance: number }[] {
  return VEHICLE_SPECS[vehicle.kind].entries
    .map(entry => ({ id: entry.id, distance: dist(at, vehiclePoint(vehicle.pos, vehicle.heading, entry.x, entry.z)) }))
    .sort((a, b) => a.distance - b.distance)
}

export interface PlanOptions {
  me: MemberId | null
  invites: readonly VehicleInvite[]
  /** A paid ride: the member is a passenger and the service keeps the driver's seat. */
  paid?: boolean
}

/**
 * The seat to ask for from where the member stands: the free seat whose nearest usable entry is nearest,
 * the driver's first for the borrower (or someone invited to drive). Null when no seat is free to ask for.
 * A seat behind an occupied one (`across`) is not offered from that side.
 */
export function planBoarding(vehicle: VehicleSnapshot, at: Vec2, options: PlanOptions): BoardPlan | null {
  const spec = VEHICLE_SPECS[vehicle.kind]
  const accepted = (role: 'driver' | 'passenger'): VehicleInvite | undefined => options.invites.find(invite => invite.vehicleId === vehicle.id && invite.recipient === options.me && invite.status === 'accepted' && invite.role === role)
  const mayDrive = !options.paid && vehicle.source === 'borrowed' && (vehicle.ownerId === options.me || Boolean(accepted('driver')))
  const near = entriesNear(vehicle, at)
  const candidates: BoardPlan[] = []
  for (const seat of spec.seats) {
    if (!free(vehicle, seat.id)) continue
    if (seat.role === 'driver' && !mayDrive) continue
    for (const entry of near) {
      if (!seat.entries.includes(entry.id)) continue
      if ((seat.across[entry.id] ?? []).some(other => !free(vehicle, other))) continue
      const invite = accepted(seat.role)
      candidates.push({ seatId: seat.id, role: seat.role, entryId: entry.id, distance: entry.distance, ...(invite ? { inviteId: invite.id } : {}) })
      break
    }
  }
  // The borrower drives before riding; otherwise nearest wins, and the seat order of the model breaks a tie.
  const rank = (plan: BoardPlan): number => (plan.role === 'driver' && mayDrive ? -1000 : 0) + plan.distance
  return candidates.reduce<BoardPlan | null>((best, plan) => (!best || rank(plan) < rank(best) - 1e-9 ? plan : best), null)
}

export interface TargetInput {
  at: Vec2
  vehicles: readonly VehicleSnapshot[]
  depots: readonly VehicleDepotView[]
  me: MemberId | null
  invites: readonly VehicleInvite[]
  /** What was offered a moment ago: it is kept until it is further than the keep distance. */
  previous: RideTarget | null
}

/** A vehicle is offered only while it is standing still with nobody getting in or out through a door in the way. */
const standing = (vehicle: VehicleSnapshot): boolean => (vehicle.phase === 'parked' || vehicle.phase === 'boarding') && Math.abs(vehicle.speed) <= VEHICLE_RULES.stoppedSpeed

/** The one thing to offer: the nearest boardable vehicle, else a depot, else nothing. */
export function nearestRideTarget(input: TargetInput): RideTarget | null {
  let best: { target: RideTarget; distance: number } | null = null
  for (const vehicle of input.vehicles) {
    if (!standing(vehicle)) continue
    const plan = planBoarding(vehicle, input.at, { me: input.me, invites: input.invites, paid: vehicle.source === 'service' })
    if (!plan) continue
    const kept = input.previous?.kind === 'vehicle' && input.previous.id === vehicle.id
    if (plan.distance > (kept ? RIDE_REACH.keep : RIDE_REACH.take)) continue
    if (!best || plan.distance < best.distance) best = { target: { kind: 'vehicle', id: vehicle.id }, distance: plan.distance }
  }
  if (best) return best.target
  for (const depot of input.depots) {
    const distance = dist(input.at, depot.pos)
    const kept = input.previous?.kind === 'depot' && input.previous.id === depot.id
    if (distance > (kept ? RIDE_REACH.depotKeep : RIDE_REACH.depotTake)) continue
    if (!best || distance < best.distance) best = { target: { kind: 'depot', id: depot.id }, distance }
  }
  return best?.target ?? null
}

export const sameTarget = (a: RideTarget | null, b: RideTarget | null): boolean => a === b || (a !== null && b !== null && a.kind === b.kind && a.id === b.id)

export interface RideWords { verb: string; target: string; label: string }
/**
 * What the one button says. A paid vehicle never says "Enter": pressing it only asks where to, and the fare
 * appears for confirmation before anything is paid, so the words say that.
 */
export function rideWords(vehicle: VehicleSnapshot, plan: BoardPlan): RideWords {
  const name = `${vehicle.source === 'borrowed' ? 'borrowed ' : ''}${VEHICLE_SPECS[vehicle.kind].label.toLowerCase()}`
  if (vehicle.source === 'service') return { verb: 'Ride', target: 'see fare first', label: `Choose a destination for this ${name} and see the fare before you pay` }
  if (plan.role === 'driver') return { verb: 'Drive', target: VEHICLE_SPECS[vehicle.kind].label, label: `Get in the ${name} and drive` }
  return { verb: 'Get in', target: VEHICLE_SPECS[vehicle.kind].label, label: `Get in the ${name} as a passenger` }
}
