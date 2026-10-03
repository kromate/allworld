// Offline builder for home parcels: the spots in the supported districts where a member's house
// may stand. Nothing here is drawn by hand and nothing comes from a client. A parcel is kept only
// where the trusted map leaves real clear ground:
//
//   node scripts/build-home-parcels.ts [--roads <yaba-vehicles.json>] [--tiles <folder of .pbf>] [--check]
//
// Inputs, all pinned by hash:
//   the vehicle road data (service/data/transport/yaba-vehicles.json): its building, water and
//     region-prop polygons, its tile hashes, scene hash and region pack hash;
//   the same source tiles (service/data/transport/source/*.pbf), decoded here with the App's own
//     decoder for what the road data leaves out: every road and path at full width, ground by
//     kind, and places;
//   the scene code itself: every file the road data lists under `sceneSources` must be, byte for
//     byte, the file in this tree, or nothing is built. Counts that happen to agree prove nothing.
// A parcel is kept only if the game's own walking routes reach its door from the district's public
// arrival point, round the region's props. Parcels are listed nearest first by that walk, so the
// default lot is the closest one that can be walked to.
// Outputs:
//   service/data/homes/yaba-homes.json       the parcels (service only)
//   src/assets/homes/yaba-home-scene.json    the versions, for the App (no parcels in it)
// `--check` builds in memory and compares with the files instead of writing them.
//
// The map data is © OpenStreetMap contributors (ODbL 1.0), tiles by OpenMapTiles / OpenFreeMap;
// the parcels are a database derived from it and carry the same terms (service/data/homes/NOTICE.md).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { areaFromPlace } from '../src/geo/areas.ts'
import { buildDistrict, chooseArrival, nearestStreetName } from '../src/geo/district.ts'
import type { District } from '../src/geo/district.ts'
import { parseDistrictId, tileToLatLon } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { HOME_PHYSICAL } from '../src/shared/homes.ts'
import type { HomeEnvelope, HomeParcelManifest } from '../src/shared/homes.ts'
import type { DistrictId } from '../src/shared/ids.ts'
import type { CoarseArea } from '../src/shared/model.ts'
import { STARTER_PLACES } from '../src/shared/places.ts'
import { TRAVEL, distanceKm } from '../src/shared/travel.ts'
import { StreetNavigator, pointInPolygon } from '../src/world/nav.ts'
import type { NavigationFootprint } from '../src/world/nav.ts'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name: string): string | null => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] ?? null : null }
const roadsPath = resolve(arg('--roads') ?? join(here, '../service/data/transport/yaba-vehicles.json'))
const tilesDir = resolve(arg('--tiles') ?? join(here, '../service/data/transport/source'))
const dataPath = join(here, '../service/data/homes/yaba-homes.json')
const manifestPath = join(here, '../src/assets/homes/yaba-home-scene.json')

// ── The rules. Every number that decides a parcel is here, and is written into the data. ──
const RULES = {
  /** Envelopes tried, biggest first: frontage by depth of the shell, metres. The last is the starter home's own shell. */
  envelopes: [[34.4, 30.4], [28.4, 24.4], [22.4, 20.4], [16.4, 16.4], [12.4, 12.4], [10.4, 10.4]] as [number, number][],
  /** At most this many parcels of one envelope in a district, so a few big lots do not take all the ground. */
  perEnvelope: 12,
  /** Roads a door may open onto. Not motorways, major roads, rail, bridges or tunnels. */
  accessKinds: ['street', 'service', 'pedestrian', 'path'],
  /** From the edge of the access road to the door, metres: the ground a character crosses to reach it. */
  setback: 3,
  /** A candidate door every this many metres along a road, on both sides. */
  step: 3,
  /** Kept clear in front of the door, each way along the front, metres: the alternates and the ground round them. */
  apronHalf: 2.2 + HOME_PHYSICAL.clearRadius,
  /** Where a character stands to go in, comes out, and may come out instead: metres out from the door, and along the front. */
  standingOut: 1, exitOut: 1.2, alternatesAlong: [-1.1, 1.1, -2.2, 2.2],
  /** Ground that is never built on, by the decoder's kinds. */
  ground: ['civic', 'park', 'pitch', 'water', 'wood', 'sand'],
  /** No part of a parcel within this of a mapped place's point, metres. */
  placeClear: 3,
  /** No part of a parcel within this of the district's public arrival point, where newcomers are stood, metres. */
  arrivalClear: 12,
  /** No part of a parcel within this of the tile's edge, or of another parcel, metres. */
  edge: 10, between: 1,
  /** Positions are rounded to this many decimals. */
  decimals: 3,
} as const

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const round = (value: number): number => { const k = 10 ** RULES.decimals; const out = Math.round(value * k) / k; return out === 0 ? 0 : out }
const point = (p: Vec2): Vec2 => ({ x: round(p.x), z: round(p.z) })
/** Keys sorted, arrays in their own order, no timestamps: the same rule as the road data's version. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  throw new Error('The data contains a value that is not JSON')
}

// ── The trusted road data ──
interface Polygon { outer: Vec2[]; holes: Vec2[][] }
interface RoadObstacle extends Polygon { id: string; kind: 'building' | 'water' | 'prop' }
interface RoadData {
  id: string; dataVersion: string; mapDataVersion: string
  source: { tiles: { districtId: DistrictId; sha256: string }[]; sceneHash: string; sceneSources: { path: string; sha256: string }[]; regionPackSha256: string; license: string; attribution: string }
  districts: { id: DistrictId; span: number; obstacles: RoadObstacle[] }[]
}
const roadText = readFileSync(roadsPath, 'utf8')
const roads = JSON.parse(roadText) as RoadData
{
  const { dataVersion, ...payload } = roads as RoadData & Record<string, unknown>
  if (sha(canonical(payload)) !== dataVersion) throw new Error('The road data does not match its own version. It is not used.')
  // The decoder, projection, navigator and region placement that made the road data's scene must be the ones in this tree.
  if (!Array.isArray(roads.source.sceneSources) || roads.source.sceneSources.length === 0 || sha(JSON.stringify(roads.source.sceneSources)) !== roads.source.sceneHash) throw new Error('The road data does not say which scene code it was built with. Nothing is built.')
  for (const source of roads.source.sceneSources) {
    let found = ''
    try { found = sha(readFileSync(join(here, '..', source.path))) } catch { /* reported below */ }
    if (found !== source.sha256) throw new Error(`${source.path} in this tree is not the file the road data's scene was built with (${found ? found.slice(0, 12) : 'missing'} here, ${source.sha256.slice(0, 12)} there). Rebuild the road data first. Nothing is built.`)
  }
}

// ── Geometry ──
interface Rect { centre: Vec2; ux: Vec2; uz: Vec2; hx: number; hz: number; corners: Vec2[]; minX: number; maxX: number; minZ: number; maxZ: number }
/** A rectangle given in a door's frame: x from `x0` to `x1` along the front, z from `z0` to `z1` out from the door. */
function rectIn(door: Vec2, facing: number, x0: number, x1: number, z0: number, z1: number): Rect {
  const ux = { x: Math.cos(facing), z: -Math.sin(facing) }, uz = { x: Math.sin(facing), z: Math.cos(facing) }
  const at = (x: number, z: number): Vec2 => ({ x: door.x + ux.x * x + uz.x * z, z: door.z + ux.z * x + uz.z * z })
  const corners = [at(x0, z0), at(x1, z0), at(x1, z1), at(x0, z1)]
  const xs = corners.map(c => c.x), zs = corners.map(c => c.z)
  return { centre: at((x0 + x1) / 2, (z0 + z1) / 2), ux, uz, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, corners, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}
const local = (rect: Rect, p: Vec2): Vec2 => ({ x: (p.x - rect.centre.x) * rect.ux.x + (p.z - rect.centre.z) * rect.ux.z, z: (p.x - rect.centre.x) * rect.uz.x + (p.z - rect.centre.z) * rect.uz.z })
/** Does the segment touch the box [-hx, hx] by [-hz, hz]? */
function segmentInBox(a: Vec2, b: Vec2, hx: number, hz: number): boolean {
  let lo = 0, hi = 1
  for (const [start, delta, half] of [[a.x, b.x - a.x, hx], [a.z, b.z - a.z, hz]] as [number, number, number][]) {
    if (delta === 0) { if (Math.abs(start) > half) return false; continue }
    const first = (-half - start) / delta, last = (half - start) / delta
    lo = Math.max(lo, Math.min(first, last)); hi = Math.min(hi, Math.max(first, last))
  }
  return lo <= hi
}
const pointToBox = (p: Vec2, hx: number, hz: number): number => Math.hypot(Math.max(0, Math.abs(p.x) - hx), Math.max(0, Math.abs(p.z) - hz))
function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t)
}
/** Distance from a segment to a rectangle. Zero when they touch. */
function segmentToRect(rect: Rect, a: Vec2, b: Vec2): number {
  const la = local(rect, a), lb = local(rect, b)
  if (segmentInBox(la, lb, rect.hx, rect.hz)) return 0
  let best = Math.min(pointToBox(la, rect.hx, rect.hz), pointToBox(lb, rect.hx, rect.hz))
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) best = Math.min(best, pointToSegment({ x: sx * rect.hx, z: sz * rect.hz }, la, lb))
  return best
}
function polygonTouchesRect(rect: Rect, polygon: Polygon): boolean {
  for (const ring of [polygon.outer, ...polygon.holes]) for (let i = 0; i < ring.length; i++) {
    if (segmentInBox(local(rect, ring[i]!), local(rect, ring[(i + 1) % ring.length]!), rect.hx, rect.hz)) return true
  }
  return pointInPolygon(rect.centre, polygon)
}
function rectsWithin(a: Rect, b: Rect, gap: number): boolean {
  if (a.minX - gap > b.maxX || b.minX - gap > a.maxX || a.minZ - gap > b.maxZ || b.minZ - gap > a.maxZ) return false
  for (let i = 0; i < 4; i++) if (segmentToRect(a, b.corners[i]!, b.corners[(i + 1) % 4]!) <= gap) return true
  return pointToBox(local(b, a.centre), b.hx, b.hz) === 0
}
function discClear(p: Vec2, radius: number, polygons: Polygon[]): boolean {
  for (const polygon of polygons) {
    if (pointInPolygon(p, polygon)) return false
    for (const ring of [polygon.outer, ...polygon.holes]) for (let i = 0; i < ring.length; i++) if (pointToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!) < radius) return false
  }
  return true
}

/** Things with a bounding box, found by 40 m cell. */
class Grid<T> {
  private readonly cells = new Map<string, T[]>()
  add(item: T, minX: number, maxX: number, minZ: number, maxZ: number): void {
    for (let x = Math.floor(minX / 40); x <= Math.floor(maxX / 40); x++) for (let z = Math.floor(minZ / 40); z <= Math.floor(maxZ / 40); z++) {
      const key = `${x}:${z}`, cell = this.cells.get(key)
      if (cell) cell.push(item); else this.cells.set(key, [item])
    }
  }
  near(minX: number, maxX: number, minZ: number, maxZ: number): T[] {
    const out = new Set<T>()
    for (let x = Math.floor(minX / 40); x <= Math.floor(maxX / 40); x++) for (let z = Math.floor(minZ / 40); z <= Math.floor(maxZ / 40); z++) for (const item of this.cells.get(`${x}:${z}`) ?? []) out.add(item)
    return [...out]
  }
}

// ── One district ──
interface Parcel {
  id: string; label: string; door: Vec2; facing: number; standing: Vec2; exit: Vec2; alternates: Vec2[]; envelope: HomeEnvelope; access: Vec2
  /** The proved walk from the district's arrival point to `standing`, by the game's own routes: its length in metres. */
  walk: { length: number; viaStreets: boolean }
}
interface ArrivalPoint { pos: Vec2; label: string; basis: string }
interface Counts { candidates: number; kept: number; byEnvelope: Record<string, number>; refused: Record<string, number>; roads: number; accessRoads: number; ground: Record<string, number>; places: number; obstacles: Record<string, number> }

function parcelsOf(scene: District, obstacles: RoadObstacle[]): { parcels: Parcel[]; counts: Counts; arrival: ArrivalPoint } {
  const eaves = HOME_PHYSICAL.eaves, clear = HOME_PHYSICAL.clearRadius
  // Where everyone arrives in the district, by the App's own rule, and the App's own walking routes with the region's props in the way.
  const arrival = chooseArrival(scene)
  const navigator = new StreetNavigator(scene)
  navigator.registerObstacles('region', obstacles.filter(obstacle => obstacle.kind === 'prop' && obstacle.outer.length === 4).map((prop): NavigationFootprint => {
    // The road data's prop rectangles list their corners (-w,-d), (-w,+d), (+w,+d), (+w,-d).
    const [c0, c1, c2, c3] = prop.outer as [Vec2, Vec2, Vec2, Vec2]
    return { pos: { x: (c0.x + c2.x) / 2, z: (c0.z + c2.z) / 2 }, angle: Math.atan2(-(c3.z - c0.z), c3.x - c0.x), width: Math.hypot(c3.x - c0.x, c3.z - c0.z), depth: Math.hypot(c1.x - c0.x, c1.z - c0.z), height: 1 }
  }))
  const polygons = new Grid<Polygon>(), ribbons = new Grid<{ a: Vec2; b: Vec2; half: number }>(), places = new Grid<Vec2>()
  const boundsOf = (ring: Vec2[]): [number, number, number, number] => [Math.min(...ring.map(p => p.x)), Math.max(...ring.map(p => p.x)), Math.min(...ring.map(p => p.z)), Math.max(...ring.map(p => p.z))]
  const solid = new Grid<Polygon>()
  for (const obstacle of obstacles) { polygons.add(obstacle, ...boundsOf(obstacle.outer)); solid.add(obstacle, ...boundsOf(obstacle.outer)) }
  const ground: Record<string, number> = {}
  for (const area of scene.ground) {
    ground[area.kind] = (ground[area.kind] ?? 0) + 1
    if ((RULES.ground as readonly string[]).includes(area.kind)) polygons.add(area, ...boundsOf(area.outer))
  }
  for (const road of scene.roads) for (let i = 1; i < road.points.length; i++) {
    const a = road.points[i - 1]!, b = road.points[i]!, half = road.width / 2
    ribbons.add({ a, b, half }, Math.min(a.x, b.x) - half, Math.max(a.x, b.x) + half, Math.min(a.z, b.z) - half, Math.max(a.z, b.z) + half)
  }
  for (const poi of scene.pois) places.add(poi.pos, poi.pos.x - RULES.placeClear, poi.pos.x + RULES.placeClear, poi.pos.z - RULES.placeClear, poi.pos.z + RULES.placeClear)

  const limit = scene.span / 2 - RULES.edge
  const refused: Record<string, number> = {}
  const no = (why: string): false => { refused[why] = (refused[why] ?? 0) + 1; return false }
  /** Is this rectangle on ground that may be built on, or walked to a door over? */
  function free(rect: Rect, what: string): boolean {
    if (rect.corners.some(c => Math.abs(c.x) > limit || Math.abs(c.z) > limit)) return no(`${what}: tile edge`)
    for (const polygon of polygons.near(rect.minX, rect.maxX, rect.minZ, rect.maxZ)) if (polygonTouchesRect(rect, polygon)) return no(`${what}: ${'kind' in polygon ? String(polygon.kind) : 'polygon'}`)
    for (const ribbon of ribbons.near(rect.minX, rect.maxX, rect.minZ, rect.maxZ)) if (segmentToRect(rect, ribbon.a, ribbon.b) < ribbon.half) return no(`${what}: road`)
    for (const place of places.near(rect.minX, rect.maxX, rect.minZ, rect.maxZ)) if (pointToBox(local(rect, place), rect.hx, rect.hz) < RULES.placeClear) return no(`${what}: place`)
    if (pointToBox(local(rect, arrival.pos), rect.hx, rect.hz) < RULES.arrivalClear) return no(`${what}: arrival point`)
    return true
  }

  const accessRoads = scene.roads.map((road, index) => ({ road, index })).filter(({ road }) => (RULES.accessKinds as readonly string[]).includes(road.kind) && !road.bridge && !road.tunnel)
  // Stretches of road are tried nearest the arrival point first, so the lots that are kept are the ones a newcomer can reach.
  const stretches = accessRoads.flatMap(({ road, index }) => road.points.slice(1).map((b, i) => {
    const a = road.points[i]!
    return { road, a, b, order: [Math.hypot((a.x + b.x) / 2 - arrival.pos.x, (a.z + b.z) / 2 - arrival.pos.z), index, i] as [number, number, number] }
  })).sort((p, q) => p.order[0] - q.order[0] || p.order[1] - q.order[1] || p.order[2] - q.order[2])
  const kept: { parcel: Parcel; house: Rect; apron: Rect }[] = []
  const byEnvelope: Record<string, number> = {}
  let candidates = 0
  for (const [width, depth] of RULES.envelopes) {
    const name = `${width}x${depth}`
    byEnvelope[name] = 0
    for (const { road, a, b } of stretches) {
      if (byEnvelope[name]! >= RULES.perEnvelope) break
      const length = Math.hypot(b.x - a.x, b.z - a.z)
      if (length < 0.05) continue
      const dir = { x: (b.x - a.x) / length, z: (b.z - a.z) / length }
      for (let t = RULES.step / 2; t < length && byEnvelope[name]! < RULES.perEnvelope; t += RULES.step) for (const side of [1, -1]) {
        if (byEnvelope[name]! >= RULES.perEnvelope) break
        candidates++
        const access = { x: a.x + dir.x * t, z: a.z + dir.z * t }
        const normal = { x: -dir.z * side, z: dir.x * side }
        const out = road.width / 2 + RULES.setback
        // Rounded first: everything below is judged on the numbers that are written down.
        const door = point({ x: access.x + normal.x * out, z: access.z + normal.z * out })
        const facing = round(Math.atan2(-normal.x, -normal.z))
        const house = rectIn(door, facing, -width / 2 - eaves, width / 2 + eaves, -depth - eaves, eaves)
        const apron = rectIn(door, facing, -RULES.apronHalf, RULES.apronHalf, eaves, RULES.setback - 0.1)
        if (kept.some(other => rectsWithin(house, other.house, RULES.between) || rectsWithin(house, other.apron, RULES.between) || rectsWithin(apron, other.house, RULES.between) || rectsWithin(apron, other.apron, RULES.between))) { no('another parcel'); continue }
        if (!free(house, 'house') || !free(apron, 'apron')) continue
        const frame = (x: number, z: number): Vec2 => point({ x: door.x + house.ux.x * x + house.uz.x * z, z: door.z + house.ux.z * x + house.uz.z * z })
        const standing = frame(0, RULES.standingOut), exit = frame(0, RULES.exitOut), alternates = RULES.alternatesAlong.map(x => frame(x, RULES.exitOut))
        const nearby = solid.near(apron.minX - 12, apron.maxX + 12, apron.minZ - 12, apron.maxZ + 12)
        if (![standing, exit, ...alternates].every(p => discClear(p, clear, nearby))) { no('standing ground: obstacle'); continue }
        // The way from the road to the door: a straight walk with a character's width clear all along it.
        const reach = Math.hypot(access.x - standing.x, access.z - standing.z), steps = Math.ceil(reach / 0.25)
        let open = true
        for (let s = 0; s <= steps && open; s++) open = discClear({ x: standing.x + (access.x - standing.x) * s / steps, z: standing.z + (access.z - standing.z) * s / steps }, clear, nearby)
        if (!open) { no('way from the road: obstacle'); continue }
        // And the whole walk: the game's own route from where everyone arrives to this door, or the lot is not kept.
        const route = navigator.walkingRoute(arrival.pos, standing)
        const end = route.points[route.points.length - 1]
        if (!end || Math.hypot(end.x - standing.x, end.z - standing.z) > 0.05) { no('no walking route from the arrival point'); continue }
        const street = nearestStreetName(scene, access, 30)
        kept.push({ house, apron, parcel: { id: '', label: street ? `Lot on ${street}` : 'Lot beside a path', door, facing, standing, exit, alternates, envelope: { xMin: -width / 2, xMax: width / 2, depth }, access: point(access), walk: { length: round(route.length), viaStreets: route.viaStreets } } })
        byEnvelope[name]!++
      }
    }
  }
  const obstacleCounts: Record<string, number> = {}
  for (const obstacle of obstacles) obstacleCounts[obstacle.kind] = (obstacleCounts[obstacle.kind] ?? 0) + 1
  // Nearest first by the proved walk. The order is the data's, and the default lot is the first that is free and fits.
  const parcels = kept.map((entry, index) => ({ entry, index })).sort((p, q) => p.entry.parcel.walk.length - q.entry.parcel.walk.length || p.index - q.index)
    .map(({ entry }, index) => ({ ...entry.parcel, id: `p${String(index + 1).padStart(3, '0')}`, label: `${entry.parcel.label}, lot ${index + 1}` }))
  return { arrival: { pos: point(arrival.pos), label: arrival.label, basis: arrival.basis }, parcels, counts: { candidates, kept: kept.length, byEnvelope, refused, roads: scene.roads.length, accessRoads: accessRoads.length, ground, places: scene.pois.length, obstacles: obstacleCounts } }
}

// ── All districts ──
const districts: { districtId: DistrictId; tileSha256: string; span: number; area: CoarseArea; arrival: ArrivalPoint; parcels: Parcel[] }[] = []
const report: Record<string, Counts> = {}
for (const tile of roads.source.tiles) {
  const parsed = parseDistrictId(tile.districtId)
  if (!parsed) throw new Error('The road data names a district that is not one')
  const bytes = readFileSync(join(tilesDir, `${parsed.z}-${parsed.x}-${parsed.y}.pbf`))
  if (sha(bytes) !== tile.sha256) throw new Error(`The tile for ${tile.districtId} is not the one the road data was built from. It is not used.`)
  const scene = buildDistrict(tile.districtId, bytes, roads.mapDataVersion)
  const trusted = roads.districts.find(entry => entry.id === tile.districtId)
  if (!trusted) throw new Error(`The road data has no district ${tile.districtId}`)
  // The decode here must be the decode the road data was made from: same buildings, same water.
  const count = (kind: string): number => trusted.obstacles.filter(entry => entry.kind === kind).length
  if (count('building') !== scene.buildings.length || count('water') !== scene.ground.filter(entry => entry.kind === 'water').length || Math.abs(trusted.span - scene.span) > 1e-6) throw new Error(`The decoder does not reproduce the road data's scene for ${tile.districtId}. Nothing is built.`)
  // Where a trip to this district is booked to: the nearest place of the public gazetteer, never anyone's
  // location. It must be within the range the travel rules let a character walk from that place.
  const centre = tileToLatLon(parsed)
  const place = [...STARTER_PLACES].sort((a, b) => distanceKm(centre, a.anchor) - distanceKm(centre, b.anchor))[0]
  if (!place || distanceKm(centre, place.anchor) > TRAVEL.localRangeKm) throw new Error(`No gazetteer place is within walking range of ${tile.districtId}, so nobody could be sent there. Nothing is built.`)
  const { parcels, counts, arrival } = parcelsOf(scene, trusted.obstacles)
  districts.push({ districtId: tile.districtId, tileSha256: tile.sha256, span: round(scene.span), area: areaFromPlace(place), arrival, parcels })
  report[tile.districtId] = counts
}

const payload = {
  schemaVersion: 1 as const, id: 'yaba-lagos-homes-v1', mapDataVersion: roads.mapDataVersion, coordinateSystem: 'district-metres-east-south' as const,
  derivedFrom: {
    roadData: { id: roads.id, dataVersion: roads.dataVersion }, sceneHash: roads.source.sceneHash, regionPackSha256: roads.source.regionPackSha256,
    license: roads.source.license, attribution: roads.source.attribution, rules: RULES, physical: HOME_PHYSICAL,
  },
  districts,
}
const data = { ...payload, dataVersion: sha(canonical(payload)) }
const manifest: HomeParcelManifest = {
  schemaVersion: 1, id: data.id, dataVersion: data.dataVersion, mapDataVersion: data.mapDataVersion, sceneHash: roads.source.sceneHash, regionPackSha256: roads.source.regionPackSha256,
  districts: districts.map(entry => ({ districtId: entry.districtId, tileSha256: entry.tileSha256, parcels: entry.parcels.length })),
}
const dataText = `${JSON.stringify(data)}\n`, manifestText = `${JSON.stringify(manifest)}\n`
if (process.argv.includes('--check')) {
  const same = readFileSync(dataPath, 'utf8') === dataText && readFileSync(manifestPath, 'utf8') === manifestText
  console.log(same ? `HOME PARCELS MATCH THE TRUSTED MAP (${data.dataVersion})` : 'HOME PARCELS DO NOT MATCH: build them again')
  process.exit(same ? 0 : 1)
}
mkdirSync(dirname(dataPath), { recursive: true }); mkdirSync(dirname(manifestPath), { recursive: true })
writeFileSync(dataPath, dataText); writeFileSync(manifestPath, manifestText)
// The service loads only the version named in service/homePhysical.ts (HOME_PARCEL_DATA_VERSION): set it to the `dataVersion` printed here.
console.log(JSON.stringify({ dataVersion: data.dataVersion, dataSha256: sha(dataText), manifestSha256: sha(manifestText), bytes: dataText.length, report }, null, 1))
