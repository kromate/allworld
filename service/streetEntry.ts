// Public admission is authoritative only where compiled street geometry is shipped.
import { createHash } from 'node:crypto'
import streetArrivals from './data/transport/street-arrivals.json' with { type: 'json' }
import type { DistrictId, MemberId } from '../src/shared/ids.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { distance, parseDistrictId } from '../src/shared/geo.ts'
import { WorldError } from '../src/shared/model.ts'
import type { RoomRef } from '../src/shared/model.ts'
import { canonicalVehicleRoadJson, vehicleDistrictPoint } from '../src/shared/vehicleRoadData.ts'
import { PERSON_RADIUS } from '../src/shared/worldCollision.ts'
import type { World } from './kernel.ts'
import { entryPathClear, placeOf, setStreetEntryPolicy } from './rooms.ts'
import type { PublicEntryPose } from './rooms.ts'
import { shippedRoadAuthority } from './vehicleRoutes.ts'
import type { RoadAuthority } from './vehicleRoutes.ts'

interface Arrival { districtId: DistrictId; span: number; pos: Vec2; heading: number; tileSha256: string; label: string }
interface Catalogue { dataVersion: string; roadDataVersion: string; districts: Arrival[] }
interface SavedStreet extends PublicEntryPose { districtId: DistrictId; dataVersion: string }
interface StreetState { members: Record<string, SavedStreet> }
const state = (world: World): StreetState => world.slice('streetEntry', () => ({ members: {} }))
const authorities = new WeakMap<World, { catalogue: Catalogue | null; roads: RoadAuthority | null }>()
/**
 * The latest accepted street pose of each member, in memory and never the saved slice itself.
 * Live entry and reconnect read this first. `periodMs` null saves every change at once (the
 * default); a host may instead save ordinary movement in one coalesced checkpoint per period.
 */
interface Latest { poses: Map<MemberId, SavedStreet>; pending: Set<MemberId>; periodMs: number | null; checkpointAt: number }
const latest = new WeakMap<World, Latest>()
/**
 * The longest checkpoint period a host may configure. It is a target interval, not a crash bound:
 * a crash can also lose the tick delay, the kernel's capture window and the storage write and sync after it.
 */
export const STREET_CHECKPOINT_MAX_MS = 15_000
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const point = (value: unknown): value is Vec2 => !!value && typeof value === 'object' && 'x' in value && 'z' in value && finite(value.x) && finite(value.z)
function readCatalogue(): Catalogue | null {
  try {
    // Bundled with the module so a Worker has it too; a fresh copy, through the same checks.
    const raw: unknown = JSON.parse(JSON.stringify(streetArrivals))
    if (!raw || typeof raw !== 'object' || !('dataVersion' in raw) || !('roadDataVersion' in raw) || !('districts' in raw) || !('schemaVersion' in raw) || raw.schemaVersion !== 1
      || typeof raw.dataVersion !== 'string' || typeof raw.roadDataVersion !== 'string' || !Array.isArray(raw.districts)) return null
    const { dataVersion, ...payload } = raw
    if (createHash('sha256').update(canonicalVehicleRoadJson(payload)).digest('hex') !== dataVersion) return null
    const districts: Arrival[] = []
    for (const entry of raw.districts) {
      if (!entry || typeof entry !== 'object' || typeof entry.districtId !== 'string' || !parseDistrictId(entry.districtId) || !point(entry.pos) || !finite(entry.heading)
        || !finite(entry.span) || entry.span <= 100 || typeof entry.tileSha256 !== 'string' || typeof entry.label !== 'string') return null
      districts.push({ districtId: entry.districtId as DistrictId, span: entry.span, pos: entry.pos, heading: entry.heading, tileSha256: entry.tileSha256, label: entry.label })
    }
    if (new Set(districts.map(entry => entry.districtId)).size !== districts.length) return null
    return { dataVersion, roadDataVersion: raw.roadDataVersion, districts }
  } catch { return null }
}

/** Homes may depend on this authority; unsupported street play keeps its existing admission. */
export function trustedStreetAvailable(world: World, districtId: DistrictId): boolean {
  const authority = authorities.get(world)
  return !world.roomHost && !!authority?.roads?.supports(districtId) && authority.catalogue?.roadDataVersion === authority.roads.dataVersion
    && !!authority.catalogue.districts.some(entry => entry.districtId === districtId)
}

function clearLine(roads: RoadAuthority, districtId: DistrictId, from: Vec2, to: Vec2): boolean {
  const count = Math.max(1, Math.ceil(distance(from, to) / .2))
  for (let i = 0; i <= count; i++) if (!roads.standable(districtId, { x: from.x + (to.x - from.x) * i / count, z: from.z + (to.z - from.z) * i / count }, PERSON_RADIUS)) return false
  return true
}

/** Same point first, then a bounded spread in the public arrival area, never a client target. */
function clearPose(world: World, memberId: MemberId, roads: RoadAuthority, ref: Extract<RoomRef, { kind: 'district' }>, pose: PublicEntryPose): PublicEntryPose {
  const candidates = [pose.pos]
  for (const radius of [1, 2, 3]) for (let i = 0; i < 12; i++) candidates.push({ x: pose.pos.x + Math.cos(i * Math.PI / 6) * radius, z: pose.pos.z + Math.sin(i * Math.PI / 6) * radius })
  for (const pos of candidates) if (clearLine(roads, ref.districtId, pose.pos, pos) && entryPathClear(world, memberId, ref, pose.instance, pose.pos, pos)) return { ...pose, pos }
  throw new WorldError('conflict', 'There is no clear place to arrive. Try again when the street has cleared.')
}

/** The engine offers the edge action eight metres before its own inset navigation bounds. */
const EDGE_REACH = 10
function crossing(world: World, memberId: MemberId, roads: RoadAuthority, from: Arrival, to: Arrival, old: SavedStreet, instance: number): PublicEntryPose | null {
  const a = parseDistrictId(from.districtId)!, b = parseDistrictId(to.districtId)!
  const dx = b.x - a.x, dz = b.y - a.y
  if (a.z !== b.z || Math.abs(dx) + Math.abs(dz) !== 1) return null
  const outward = dx ? old.pos.x * dx : old.pos.z * dz
  if (outward < from.span / 2 - EDGE_REACH || outward > from.span / 2 - PERSON_RADIUS + .025) return null
  const edge = { ...old.pos }
  if (dx) edge.x = dx * (from.span / 2 - PERSON_RADIUS)
  else edge.z = dz * (from.span / 2 - PERSON_RADIUS)
  if (!clearLine(roads, from.districtId, old.pos, edge) || !entryPathClear(world, memberId, { kind: 'district', districtId: from.districtId }, old.instance, old.pos, edge)) throw new WorldError('conflict', 'The way across this edge is blocked.')
  const mapped = vehicleDistrictPoint(edge, { span: from.span, tileX: a.x, tileY: a.y }, { span: to.span, tileX: b.x, tileY: b.y })
  // The adjacent representation is outside by one body radius. Start just inside that same seam.
  const entry = { ...mapped }, pos = { ...mapped }
  if (dx) { entry.x = -dx * (to.span / 2 - PERSON_RADIUS); pos.x = -dx * (to.span / 2 - 14) }
  else { entry.z = -dz * (to.span / 2 - PERSON_RADIUS); pos.z = -dz * (to.span / 2 - 14) }
  if (!clearLine(roads, to.districtId, entry, pos) || !entryPathClear(world, memberId, { kind: 'district', districtId: to.districtId }, instance, entry, pos)) throw new WorldError('conflict', 'The street on the other side is blocked.')
  return { pos, heading: old.heading, instance }
}

/**
 * Trusted server bootstrap only, once per world before play: save ordinary street movement
 * together at most every `periodMs` (1 to 15 seconds) instead of on every step. First entry and
 * a new district, instance or data version are still saved at once; a member's disconnect saves
 * their latest pose. Never driven by a request.
 */
export function configureStreetCheckpoints(world: World, options: { periodMs: number }): void {
  const live = latest.get(world)
  if (!live) throw new Error('Street entry is not registered on this world.')
  if (live.periodMs !== null) throw new Error('Street checkpoints were already configured.')
  const periodMs = options?.periodMs
  if (!Number.isInteger(periodMs) || periodMs < 1000 || periodMs > STREET_CHECKPOINT_MAX_MS) throw new Error(`Street checkpoints need a whole period from 1000 to ${STREET_CHECKPOINT_MAX_MS} ms.`)
  live.periodMs = periodMs
  live.checkpointAt = world.now()
}

export function registerStreetEntry(world: World): void {
  const catalogue = readCatalogue(), roads = shippedRoadAuthority().authority
  authorities.set(world, { catalogue, roads })
  if (world.roomHost) return
  const live: Latest = { poses: new Map(), pending: new Set(), periodMs: null, checkpointAt: 0 }
  latest.set(world, live)
  const same = (a: SavedStreet | undefined, b: SavedStreet): boolean => a?.districtId === b.districtId && a.instance === b.instance && a.heading === b.heading && distance(a.pos, b.pos) < 1e-9 && a.dataVersion === b.dataVersion
  const copy = (pose: SavedStreet): SavedStreet => ({ ...pose, pos: { ...pose.pos } })
  /** Every pending pose into the saved slice, as one change. */
  const checkpoint = (): void => {
    live.checkpointAt = world.now()
    if (live.pending.size === 0) return
    const saved = state(world).members
    for (const memberId of live.pending) { const pose = live.poses.get(memberId); if (pose) saved[memberId] = copy(pose) }
    live.pending.clear()
    world.touch()
  }
  /** Forget a member's street pose everywhere: memory, pending and saved. */
  const forget = (memberId: MemberId): void => {
    live.poses.delete(memberId); live.pending.delete(memberId)
    const saved = state(world).members
    if (saved[memberId]) { delete saved[memberId]; world.touch() }
  }
  const remember = (memberId: MemberId): void => {
    const at = placeOf(world, memberId)
    if (!at || at.ref.kind !== 'district') return
    if (!catalogue || !trustedStreetAvailable(world, at.ref.districtId)) return forget(memberId)
    const next: SavedStreet = { districtId: at.ref.districtId, instance: at.instance, pos: { ...at.pos }, heading: at.heading, dataVersion: catalogue.dataVersion }
    // An unchanged pose changes nothing, in memory or on disk.
    if (same(live.poses.get(memberId) ?? state(world).members[memberId], next)) return
    live.poses.set(memberId, next)
    const saved = state(world).members, previous = saved[memberId]
    // First entry, another district, instance or data version, or a host that saves every step: now.
    if (live.periodMs === null || !previous || previous.districtId !== next.districtId || previous.instance !== next.instance || previous.dataVersion !== next.dataVersion) {
      saved[memberId] = copy(next)
      live.pending.delete(memberId)
      world.touch()
      return
    }
    live.pending.add(memberId)
    if (world.now() - live.checkpointAt >= live.periodMs) checkpoint()
  }
  setStreetEntryPolicy(world, {
    accepted: remember,
    resolve(memberId, input, suggestedInstance) {
      if (input.ref.kind !== 'district') return null
      const districtId = input.ref.districtId
      // Known compiled streets fail closed on missing or incompatible arrivals; other areas still work.
      if (!roads?.supports(districtId) && !catalogue?.districts.some(entry => entry.districtId === districtId)) return null
      if (!roads || !catalogue || !trustedStreetAvailable(world, districtId)) throw new WorldError('unavailable', 'Trusted street arrival data is unavailable. Try another area or reload when it is restored.')
      const target = catalogue.districts.find(entry => entry.districtId === districtId)!
      const at = placeOf(world, memberId)
      // The latest accepted pose, else the last saved checkpoint (after a restart).
      const saved = live.poses.get(memberId) ?? state(world).members[memberId]
      const validSaved = saved && saved.dataVersion === catalogue.dataVersion && point(saved.pos) && finite(saved.heading) && Number.isInteger(saved.instance) && saved.instance > 0 ? saved : null
      // Rejoining the current street never turns a client-requested coordinate into movement.
      if (at?.ref.kind === 'district' && at.ref.districtId === districtId) return { pos: at.pos, heading: at.heading, instance: at.instance }
      const old = at?.ref.kind === 'district' ? { districtId: at.ref.districtId, pos: at.pos, heading: at.heading, instance: at.instance, dataVersion: catalogue.dataVersion } : validSaved
      if (old?.districtId === districtId) {
        try { return clearPose(world, memberId, roads, input.ref, old) } catch (error) {
          // A stored or retained pose the street no longer admits (a home placed over it, a crowd, a vehicle):
          // the same district's trusted public arrival below, checked the same way. Never a live place, a client point or another district.
          if (at?.ref.kind === 'district' || !(error instanceof WorldError) || error.code !== 'conflict') throw error
        }
        return clearPose(world, memberId, roads, input.ref, { pos: target.pos, heading: target.heading, instance: suggestedInstance })
      }
      if (old) {
        const source = catalogue.districts.find(entry => entry.districtId === old.districtId)
        if (source) {
          const crossed = crossing(world, memberId, roads, source, target, old, suggestedInstance)
          if (crossed) return crossed
        }
      }
      return clearPose(world, memberId, roads, input.ref, { pos: target.pos, heading: target.heading, instance: suggestedInstance })
    },
  })
  world.onTick(() => { if (live.periodMs !== null && world.now() - live.checkpointAt >= live.periodMs) checkpoint() })
  // A member who leaves has their latest pose put in the saved slice (copied and touched, never flushed here: the host's
  // idle and stop paths write and sync it). The latest map then forgets them, so it holds only members still present.
  world.onDisconnect(memberId => {
    const pose = live.poses.get(memberId), pending = live.pending.delete(memberId)
    if (pending && pose) { state(world).members[memberId] = copy(pose); world.touch() }
    live.poses.delete(memberId)
  })
  world.onOperation((memberId, op) => {
    if (op !== 'travel.book' && op !== 'member.setBrowsing') return
    forget(memberId)
  })
}
