// Roads, as the service knows them for vehicles: where a vehicle may be, what it would hit, and
// the way from one place to another.
//
// The data is made offline from the same map tiles the App draws (src/shared/vehicleRoadData.ts
// is its shape; the builder and the file are the road producer's). This module only reads it:
// it checks the file against its own hash, indexes it, and answers questions. Nothing a member's
// App sends is a road, a wall or a route. Where there is no data there are no vehicles.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DistrictId } from '../src/shared/ids.ts'
import { parseDistrictId } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { canonicalVehicleRoadJson, vehicleDistrictPoint } from '../src/shared/vehicleRoadData.ts'
import type { VehicleDepot, VehicleRoadDataset, VehicleRoadPlace } from '../src/shared/vehicleRoadData.ts'
import { vehicleCorners, vehiclePoint, VEHICLE_SPECS } from '../src/shared/vehicles.ts'
import type { VehicleKind } from '../src/shared/vehicles.ts'

/** What stops a vehicle. `bounds` is the edge of the district; `off-road` is ground that is not a road. */
export type Blocker = 'bounds' | 'off-road' | 'building' | 'water' | 'prop'
/** One point of a route: a place in one district's metres. */
export interface RoutePoint {
  districtId: DistrictId; pos: Vec2
  /** The next point is the same place in the next district. */
  portal: boolean
  /** Half the width of the road that leads to this point. */
  half: number
}
export interface Route { points: RoutePoint[]; metres: number }

/** The side of a broad-phase cell, in metres. Every road segment, solid and node is filed under the cells its own box touches, once, when the data is loaded. */
const CELL = 40
/** A corner may be this far off the edge of the road ribbon (kerbs and junction mouths are not exact). */
const ROAD_SLACK = 0.75
/** A swept move is checked at least this often along its length. */
const SWEEP_STEP = 0.3

interface Segment { ax: number; az: number; bx: number; bz: number; half: number }
export interface RoadSolid { kind: 'building' | 'water' | 'prop'; outer: Vec2[]; holes: Vec2[][]; minX: number; maxX: number; minZ: number; maxZ: number }
interface Link { to: number; length: number; portal: boolean; half: number }
interface Node { id: number; districtId: DistrictId; pos: Vec2; links: Link[] }
interface District {
  id: DistrictId; span: number; half: number; tileX: number; tileY: number
  segments: Segment[]; segmentCells: Map<number, number[]>
  solids: RoadSolid[]; solidCells: Map<number, number[]>
  /** Road edges of the graph inside this district (two node ids and half the road's width), for snapping a point to the graph. */
  edges: [number, number, number][]; edgeCells: Map<number, number[]>
  nodeCells: Map<number, number[]>
  places: Map<string, VehicleRoadPlace>
  depots: VehicleDepot[]
}

const cellKey = (cx: number, cz: number): number => (cx + 512) * 1024 + (cz + 512)
const cellOf = (value: number): number => Math.floor(value / CELL)
function addToCells(cells: Map<number, number[]>, minX: number, maxX: number, minZ: number, maxZ: number, index: number): void {
  for (let cx = cellOf(minX); cx <= cellOf(maxX); cx++) for (let cz = cellOf(minZ); cz <= cellOf(maxZ); cz++) {
    const key = cellKey(cx, cz)
    const list = cells.get(key)
    if (list) list.push(index); else cells.set(key, [index])
  }
}
function inCells(cells: Map<number, number[]>, minX: number, maxX: number, minZ: number, maxZ: number): number[] {
  const x0 = cellOf(minX), x1 = cellOf(maxX), z0 = cellOf(minZ), z1 = cellOf(maxZ)
  if (x0 === x1 && z0 === z1) return cells.get(cellKey(x0, z0)) ?? []
  const seen = new Set<number>()
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (const index of cells.get(cellKey(cx, cz)) ?? []) seen.add(index)
  return [...seen]
}

/** The nearest point of segment a–b to p, and how far it is. */
function nearestOnSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { x: number; z: number; distance: number; t: number } {
  const dx = bx - ax, dz = bz - az
  const lengthSquared = dx * dx + dz * dz
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared))
  const x = ax + dx * t, z = az + dz * t
  return { x, z, distance: Math.hypot(px - x, pz - z), t }
}

function inRing(px: number, pz: number, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if ((a.z > pz) !== (b.z > pz) && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}
const inSolid = (px: number, pz: number, solid: RoadSolid): boolean => inRing(px, pz, solid.outer) && !solid.holes.some(hole => inRing(px, pz, hole))

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2): number => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
  const d1 = side(c, d, a), d2 = side(c, d, b), d3 = side(a, b, c), d4 = side(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Does the four-cornered box touch this solid: a corner inside it, the solid inside the box, or their edges crossing. */
function boxHitsSolid(corners: readonly Vec2[], solid: RoadSolid): boolean {
  for (const corner of corners) if (inSolid(corner.x, corner.z, solid)) return true
  const first = solid.outer[0]
  if (first && inRing(first.x, first.z, corners as Vec2[])) return true
  for (const ring of [solid.outer, ...solid.holes]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      for (let k = 0, l = corners.length - 1; k < corners.length; l = k++) if (segmentsCross(ring[j]!, ring[i]!, corners[l]!, corners[k]!)) return true
    }
  }
  return false
}

/** Two vehicles' boxes overlapping (separating axes of two rectangles). */
export function boxesOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const box of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const p = box[i]!, q = box[i + 1]!
      const nx = q.z - p.z, nz = p.x - q.x
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity
      for (const c of a) { const s = c.x * nx + c.z * nz; if (s < minA) minA = s; if (s > maxA) maxA = s }
      for (const c of b) { const s = c.x * nx + c.z * nz; if (s < minB) minB = s; if (s > maxB) maxB = s }
      if (maxA < minB || maxB < minA) return false
    }
  }
  return true
}
export const pointInBox = (p: Vec2, box: readonly Vec2[]): boolean => inRing(p.x, p.z, box as Vec2[])

export class RoadAuthority {
  readonly id: string
  readonly dataVersion: string
  readonly mapDataVersion: string
  readonly source: VehicleRoadDataset['source']
  private readonly districts = new Map<string, District>()
  private readonly nodes = new Map<number, Node>()
  /** Road edges whose recorded length is not the straight distance between their ends. The service drives the straight line. */
  readonly bentEdges: number

  constructor(dataset: VehicleRoadDataset) {
    if (dataset.schemaVersion !== 1 || dataset.coordinateSystem !== 'district-metres-east-south') throw new Error('Unknown vehicle road data format.')
    if (!dataset.id || !dataset.dataVersion || !dataset.mapDataVersion) throw new Error('Vehicle road data carries no version.')
    const { dataVersion, ...rest } = dataset
    if (createHash('sha256').update(canonicalVehicleRoadJson(rest)).digest('hex') !== dataVersion) throw new Error('Vehicle road data does not match its own hash.')
    this.id = dataset.id
    this.dataVersion = dataVersion
    this.mapDataVersion = dataset.mapDataVersion
    this.source = dataset.source
    const finite = (point: Vec2): boolean => Number.isFinite(point?.x) && Number.isFinite(point?.z)

    for (const source of dataset.districts) {
      const tile = parseDistrictId(source.id)
      if (!tile || !(source.span > 100) || this.districts.has(source.id)) throw new Error(`Vehicle road data names a district it cannot use: ${String(source.id)}`)
      const district: District = {
        id: source.id, span: source.span, half: source.span / 2, tileX: tile.x, tileY: tile.y,
        segments: [], segmentCells: new Map(), solids: [], solidCells: new Map(), edges: [], edgeCells: new Map(), nodeCells: new Map(),
        places: new Map(), depots: [],
      }
      for (const road of source.roads) {
        if (!(road.width > 0) || !road.points.every(finite)) throw new Error(`Road ${road.id} is not usable.`)
        const half = road.width / 2
        for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1]!, b = road.points[i]!
          const reach = half + ROAD_SLACK
          addToCells(district.segmentCells, Math.min(a.x, b.x) - reach, Math.max(a.x, b.x) + reach, Math.min(a.z, b.z) - reach, Math.max(a.z, b.z) + reach, district.segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, half }) - 1)
        }
      }
      for (const obstacle of source.obstacles) {
        if (obstacle.outer.length < 3 || !obstacle.outer.every(finite) || !obstacle.holes.every(hole => hole.every(finite))) throw new Error(`Obstacle ${obstacle.id} is not usable.`)
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
        for (const point of obstacle.outer) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z) }
        addToCells(district.solidCells, minX, maxX, minZ, maxZ, district.solids.push({ kind: obstacle.kind, outer: obstacle.outer, holes: obstacle.holes, minX, maxX, minZ, maxZ }) - 1)
      }
      for (const place of source.places) if (finite(place.roadPos)) district.places.set(place.id, place)
      for (const depot of source.depots) if (finite(depot.pos) && Number.isFinite(depot.heading)) district.depots.push(depot)
      this.districts.set(source.id, district)
    }

    for (const node of dataset.nodes) {
      const district = this.districts.get(node.districtId)
      if (!Number.isInteger(node.id) || !district || !finite(node.pos) || this.nodes.has(node.id)) throw new Error(`Road node ${String(node.id)} is not usable.`)
      this.nodes.set(node.id, { id: node.id, districtId: node.districtId, pos: node.pos, links: [] })
      addToCells(district.nodeCells, node.pos.x, node.pos.x, node.pos.z, node.pos.z, node.id)
    }
    let bent = 0
    for (const edge of dataset.edges) {
      const a = this.nodes.get(edge.a), b = this.nodes.get(edge.b)
      if (!a || !b || !(edge.length >= 0)) throw new Error(`Road edge ${edge.id} is not usable.`)
      const portal = edge.kind === 'portal'
      if (portal !== (a.districtId !== b.districtId)) throw new Error(`Road edge ${edge.id} joins the wrong districts.`)
      const length = portal ? 0 : Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)
      if (!portal && Math.abs(length - edge.length) > 0.5) bent++
      if (!(edge.width > 0)) throw new Error(`Road edge ${edge.id} has no width.`)
      const half = edge.width / 2
      a.links.push({ to: b.id, length, portal, half })
      b.links.push({ to: a.id, length, portal, half })
      if (!portal) {
        const district = this.districts.get(a.districtId)!
        addToCells(district.edgeCells, Math.min(a.pos.x, b.pos.x), Math.max(a.pos.x, b.pos.x), Math.min(a.pos.z, b.pos.z), Math.max(a.pos.z, b.pos.z), district.edges.push([a.id, b.id, half]) - 1)
      }
    }
    this.bentEdges = bent
  }

  supports(districtId: DistrictId): boolean { return this.districts.has(districtId) }
  /** What was loaded, for diagnostics. */
  describe(): { id: string; dataVersion: string; districts: number; nodes: number; solids: number; segments: number; bentEdges: number } {
    let solids = 0, segments = 0
    for (const district of this.districts.values()) { solids += district.solids.length; segments += district.segments.length }
    return { id: this.id, dataVersion: this.dataVersion, districts: this.districts.size, nodes: this.nodes.size, solids, segments, bentEdges: this.bentEdges }
  }
  spanOf(districtId: DistrictId): number | null { return this.districts.get(districtId)?.span ?? null }
  depotsOf(districtId: DistrictId): readonly VehicleDepot[] { return this.districts.get(districtId)?.depots ?? [] }
  depot(depotId: string): { districtId: DistrictId; depot: VehicleDepot } | null {
    for (const district of this.districts.values()) for (const depot of district.depots) if (depot.id === depotId) return { districtId: district.id, depot }
    return null
  }
  placeOf(districtId: DistrictId, placeId: string): VehicleRoadPlace | null { return this.districts.get(districtId)?.places.get(placeId) ?? null }
  nodePos(nodeId: number): { districtId: DistrictId; pos: Vec2 } | null {
    const node = this.nodes.get(nodeId)
    return node ? { districtId: node.districtId, pos: node.pos } : null
  }

  private onRoad(district: District, x: number, z: number, slack: number): boolean {
    for (const index of district.segmentCells.get(cellKey(cellOf(x), cellOf(z))) ?? []) {
      const s = district.segments[index]!
      if (nearestOnSegment(x, z, s.ax, s.az, s.bx, s.bz).distance <= s.half + slack) return true
    }
    return false
  }

  /** One pose against the road surface, the district's edge and the given solids (already narrowed to those near it). */
  private poseBlocked(district: District, kind: VehicleKind, pos: Vec2, heading: number, near: readonly RoadSolid[] | null): Blocker | null {
    const corners = vehicleCorners(kind, pos, heading)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const c of corners) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z) }
    if (minX < -district.half || maxX > district.half || minZ < -district.half || maxZ > district.half) return 'bounds'
    const { front, rear } = VEHICLE_SPECS[kind].footprint
    // The middle of the vehicle and of its ends must be on the road proper; its corners may overhang by the slack.
    if (!this.onRoad(district, pos.x, pos.z, 0)) return 'off-road'
    for (const z of [front, -rear]) { const p = vehiclePoint(pos, heading, 0, z); if (!this.onRoad(district, p.x, p.z, ROAD_SLACK)) return 'off-road' }
    for (const c of corners) if (!this.onRoad(district, c.x, c.z, ROAD_SLACK)) return 'off-road'
    const solids = near ?? inCells(district.solidCells, minX, maxX, minZ, maxZ).map(index => district.solids[index]!)
    for (const solid of solids) {
      // Box against box first; the exact polygon only for what is left.
      if (solid.maxX < minX || solid.minX > maxX || solid.maxZ < minZ || solid.minZ > maxZ) continue
      if (boxHitsSolid(corners, solid)) return solid.kind
    }
    return null
  }

  /** What a vehicle standing exactly here would be in, if anything. */
  blockedAt(kind: VehicleKind, districtId: DistrictId, pos: Vec2, heading: number, extra: readonly RoadSolid[] = []): Blocker | null {
    const district = this.districts.get(districtId)
    const { front, rear, halfWidth } = VEHICLE_SPECS[kind].footprint
    const reach = Math.hypot(Math.max(front, rear), halfWidth)
    const near = district ? [...inCells(district.solidCells, pos.x - reach, pos.x + reach, pos.z - reach, pos.z + reach).map(index => district.solids[index]!), ...extra] : []
    return district ? this.poseBlocked(district, kind, pos, heading, near) : 'bounds'
  }

  /**
   * Move a vehicle from one pose to another: the first thing in the way, checked all along the
   * move, or null. The cells are asked once, for the box of the whole move; each solid found is
   * looked at once however many cells it lies in, and only those are tested pose by pose.
   */
  sweep(kind: VehicleKind, districtId: DistrictId, from: { pos: Vec2; heading: number }, to: { pos: Vec2; heading: number }, extra: readonly RoadSolid[] = []): Blocker | null {
    const district = this.districts.get(districtId)
    if (!district) return 'bounds'
    const distance = Math.hypot(to.pos.x - from.pos.x, to.pos.z - from.pos.z)
    let turn = to.heading - from.heading
    if (turn > Math.PI) turn -= 2 * Math.PI
    else if (turn < -Math.PI) turn += 2 * Math.PI
    const steps = Math.max(1, Math.ceil(distance / SWEEP_STEP), Math.ceil(Math.abs(turn) / 0.08))
    const { front, rear, halfWidth } = VEHICLE_SPECS[kind].footprint
    const reach = Math.hypot(Math.max(front, rear), halfWidth)
    const near = [...inCells(district.solidCells, Math.min(from.pos.x, to.pos.x) - reach, Math.max(from.pos.x, to.pos.x) + reach, Math.min(from.pos.z, to.pos.z) - reach, Math.max(from.pos.z, to.pos.z) + reach).map(index => district.solids[index]!), ...extra]
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      const hit = this.poseBlocked(district, kind, { x: from.pos.x + (to.pos.x - from.pos.x) * t, z: from.pos.z + (to.pos.z - from.pos.z) * t }, from.heading + turn * t, near)
      if (hit) return hit
    }
    return null
  }

  /** May a person stand here: inside the district and clear of every solid by `radius`. */
  standable(districtId: DistrictId, pos: Vec2, radius = 0.4, extra: readonly RoadSolid[] = []): boolean {
    const district = this.districts.get(districtId)
    if (!district) return false
    const edge = district.half - radius
    if (Math.abs(pos.x) > edge || Math.abs(pos.z) > edge) return false
    for (const solid of [...inCells(district.solidCells, pos.x - radius, pos.x + radius, pos.z - radius, pos.z + radius).map(index => district.solids[index]!), ...extra]) {
      if (solid.maxX < pos.x - radius || solid.minX > pos.x + radius || solid.maxZ < pos.z - radius || solid.minZ > pos.z + radius) continue
      if (inSolid(pos.x, pos.z, solid)) return false
      for (const ring of [solid.outer, ...solid.holes]) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (nearestOnSegment(pos.x, pos.z, ring[j]!.x, ring[j]!.z, ring[i]!.x, ring[i]!.z).distance < radius) return false
      }
    }
    return true
  }

  nearestNode(districtId: DistrictId, pos: Vec2, within: number): number | null {
    const district = this.districts.get(districtId)
    if (!district) return null
    let best: number | null = null, bestDistance = within
    for (const id of inCells(district.nodeCells, pos.x - within, pos.x + within, pos.z - within, pos.z + within)) {
      const node = this.nodes.get(id)!
      const distance = Math.hypot(node.pos.x - pos.x, node.pos.z - pos.z)
      if (distance <= bestDistance) { best = id; bestDistance = distance }
    }
    return best
  }

  /** The nearest point of the road graph to a map point, the two nodes whose road it lies on, and half that road's width. */
  snap(districtId: DistrictId, pos: Vec2, within: number): { pos: Vec2; a: number; b: number; half: number; distance: number } | null {
    const district = this.districts.get(districtId)
    if (!district) return null
    let best: { pos: Vec2; a: number; b: number; half: number; distance: number } | null = null
    for (const index of inCells(district.edgeCells, pos.x - within, pos.x + within, pos.z - within, pos.z + within)) {
      const [a, b, half] = district.edges[index]!
      const from = this.nodes.get(a)!.pos, to = this.nodes.get(b)!.pos
      const near = nearestOnSegment(pos.x, pos.z, from.x, from.z, to.x, to.z)
      if (near.distance <= within && (!best || near.distance < best.distance)) best = { pos: { x: near.x, z: near.z }, a, b, half, distance: near.distance }
    }
    return best
  }

  /**
   * Places along the road that runs through a point, at the given distances from it (ahead is
   * positive, behind is negative), following the road round its bends. Each is on the centre line,
   * facing the way `heading` faces along the road, with half the width of the road there. Null
   * where the road ends or forks too sharply to say which way it goes.
   */
  stations(districtId: DistrictId, pos: Vec2, heading: number, distances: readonly number[]): ({ pos: Vec2; heading: number; half: number } | null)[] {
    const start = this.snap(districtId, pos, 15)
    if (!start) return distances.map(() => null)
    const at = (nodeId: number): Vec2 => this.nodes.get(nodeId)!.pos
    const faces = (nodeId: number): number => (at(nodeId).x - start.pos.x) * Math.sin(heading) + (at(nodeId).z - start.pos.z) * Math.cos(heading)
    const [ahead, behind] = faces(start.a) >= faces(start.b) ? [start.a, start.b] : [start.b, start.a]
    const reach = Math.max(0, ...distances.map(Math.abs)) + 1
    /** The road from the start through `first`, as legs: where each begins, its direction, its length and its half-width. */
    const walk = (first: number, from: number): { from: Vec2; ux: number; uz: number; length: number; half: number }[] => {
      const legs: { from: Vec2; ux: number; uz: number; length: number; half: number }[] = []
      let here = start.pos, half = start.half, previous = from, next = first, total = 0
      for (let guard = 0; guard < 200 && total < reach; guard++) {
        const to = at(next)
        const length = Math.hypot(to.x - here.x, to.z - here.z)
        const ux = length ? (to.x - here.x) / length : 0, uz = length ? (to.z - here.z) / length : 0
        if (length > 0) { legs.push({ from: here, ux, uz, length, half }); total += length }
        // Carry on along whichever road leaves this node most nearly straight ahead; stop at a dead end, a seam or a sharp fork.
        let best: { to: number; half: number; straight: number } | null = null
        for (const link of this.nodes.get(next)!.links) {
          if (link.portal || link.to === previous || link.length === 0) continue
          const target = at(link.to)
          const straight = length ? ((target.x - to.x) * ux + (target.z - to.z) * uz) / link.length : 1
          if (!best || straight > best.straight) best = { to: link.to, half: link.half, straight }
        }
        if (!best || best.straight < 0.5) break
        here = to; previous = next; next = best.to; half = best.half
      }
      return legs
    }
    const forward = walk(ahead, behind), backward = walk(behind, ahead)
    return distances.map(distance => {
      let left = Math.abs(distance)
      for (const leg of distance >= 0 ? forward : backward) {
        if (left <= leg.length) {
          const facing = distance >= 0 ? Math.atan2(leg.ux, leg.uz) : Math.atan2(-leg.ux, -leg.uz)
          return { pos: { x: leg.from.x + leg.ux * left, z: leg.from.z + leg.uz * left }, heading: facing, half: leg.half }
        }
        left -= leg.length
      }
      // The start itself, on a road too short to have a leg either way.
      return distance === 0 ? { pos: start.pos, heading, half: start.half } : null
    })
  }

  /** The named place nearest a point, for a label. */
  nearestPlace(districtId: DistrictId, pos: Vec2, within: number): VehicleRoadPlace | null {
    let best: VehicleRoadPlace | null = null, bestDistance = within
    for (const place of this.districts.get(districtId)?.places.values() ?? []) {
      const distance = Math.hypot(place.roadPos.x - pos.x, place.roadPos.z - pos.z)
      if (distance <= bestDistance) { best = place; bestDistance = distance }
    }
    return best
  }

  /** A crossing into the next district near this point: the node on this side and the same place on the other. */
  portalNear(districtId: DistrictId, pos: Vec2, within: number): { from: number; to: number; toDistrict: DistrictId } | null {
    const district = this.districts.get(districtId)
    if (!district) return null
    let best: { from: number; to: number; toDistrict: DistrictId } | null = null, bestDistance = within
    for (const id of inCells(district.nodeCells, pos.x - within, pos.x + within, pos.z - within, pos.z + within)) {
      const node = this.nodes.get(id)!
      const link = node.links.find(entry => entry.portal)
      if (!link) continue
      const distance = Math.hypot(node.pos.x - pos.x, node.pos.z - pos.z)
      if (distance <= bestDistance) { best = { from: id, to: link.to, toDistrict: this.nodes.get(link.to)!.districtId }; bestDistance = distance }
    }
    return best
  }

  /** The same spot on the map, in the next district's metres. */
  across(from: DistrictId, to: DistrictId, pos: Vec2): Vec2 | null {
    const a = this.districts.get(from), b = this.districts.get(to)
    return a && b ? vehicleDistrictPoint(pos, { span: a.span, tileX: a.tileX, tileY: a.tileY }, { span: b.span, tileX: b.tileX, tileY: b.tileY }) : null
  }

  /** The shortest way along the roads between two nodes. */
  private path(from: number, to: number, notFirst: number | null = null): { nodes: number[]; metres: number } | null {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return null
    const best = new Map<number, number>([[from, 0]])
    const previous = new Map<number, number>()
    // A binary heap of [distance, node].
    const heap: [number, number][] = [[0, from]]
    const push = (entry: [number, number]): void => {
      heap.push(entry)
      for (let i = heap.length - 1; i > 0;) { const parent = (i - 1) >> 1; if (heap[parent]![0] <= heap[i]![0]) break; [heap[parent], heap[i]] = [heap[i]!, heap[parent]!]; i = parent }
    }
    const pop = (): [number, number] => {
      const top = heap[0]!, last = heap.pop()!
      if (heap.length > 0) {
        heap[0] = last
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1
          let smallest = i
          if (l < heap.length && heap[l]![0] < heap[smallest]![0]) smallest = l
          if (r < heap.length && heap[r]![0] < heap[smallest]![0]) smallest = r
          if (smallest === i) break
          ;[heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!]
          i = smallest
        }
      }
      return top
    }
    while (heap.length > 0) {
      const [distance, id] = pop()
      if (id === to) break
      if (distance > (best.get(id) ?? Infinity)) continue
      for (const link of this.nodes.get(id)!.links) {
        if (id === from && link.to === notFirst) continue
        const next = distance + link.length
        if (next < (best.get(link.to) ?? Infinity)) { best.set(link.to, next); previous.set(link.to, id); push([next, link.to]) }
      }
    }
    const metres = best.get(to)
    if (metres === undefined) return null
    const nodes = [to]
    for (let id = to; id !== from;) { id = previous.get(id)!; nodes.push(id) }
    return { nodes: nodes.reverse(), metres }
  }

  /**
   * The way from where a vehicle stands to a point on the road graph. Both ends are snapped to the
   * graph (see `snap`). With `heading`, the vehicle sets off the way it faces and does not turn
   * round on the spot: it joins the graph at the node ahead of it and may not come straight back.
   */
  route(from: { districtId: DistrictId; pos: Vec2; heading?: number }, to: { districtId: DistrictId; pos: Vec2 }): Route | null {
    const start = this.snap(from.districtId, from.pos, 40), end = this.snap(to.districtId, to.pos, 40)
    if (!start || !end) return null
    const at = (nodeId: number): Vec2 => this.nodes.get(nodeId)!.pos
    const gap = (p: Vec2, nodeId: number): number => Math.hypot(p.x - at(nodeId).x, p.z - at(nodeId).z)
    const ahead = (nodeId: number): boolean => from.heading === undefined || (at(nodeId).x - start.pos.x) * Math.sin(from.heading) + (at(nodeId).z - start.pos.z) * Math.cos(from.heading) > 0
    const sameRoad = from.districtId === to.districtId && ((start.a === end.a && start.b === end.b) || (start.a === end.b && start.b === end.a))
    // On the same stretch of road, and the way the vehicle faces: straight along it.
    if (sameRoad && (from.heading === undefined || (end.pos.x - start.pos.x) * Math.sin(from.heading) + (end.pos.z - start.pos.z) * Math.cos(from.heading) > 0)) {
      return { points: [{ districtId: from.districtId, pos: start.pos, portal: false, half: start.half }, { districtId: to.districtId, pos: end.pos, portal: false, half: start.half }], metres: Math.hypot(start.pos.x - end.pos.x, start.pos.z - end.pos.z) }
    }
    let best: { nodes: number[]; metres: number } | null = null
    for (const [first, behind] of [[start.a, start.b], [start.b, start.a]] as const) {
      if (!ahead(first)) continue
      for (const last of [end.a, end.b]) {
        // Coming to the end of the route along its own road, not past it and back.
        const found = this.path(first, last, from.heading === undefined ? null : behind)
        if (!found) continue
        const metres = gap(start.pos, first) + found.metres + gap(end.pos, last)
        if (!best || metres < best.metres) best = { nodes: found.nodes, metres }
      }
    }
    if (!best) return null
    const points: RoutePoint[] = [{ districtId: from.districtId, pos: start.pos, portal: false, half: start.half }]
    let half = start.half
    for (let i = 0; i < best.nodes.length; i++) {
      const node = this.nodes.get(best.nodes[i]!)!
      const next = i + 1 < best.nodes.length ? this.nodes.get(best.nodes[i + 1]!)! : null
      points.push({ districtId: node.districtId, pos: node.pos, portal: next !== null && next.districtId !== node.districtId, half })
      if (next) half = node.links.find(link => link.to === next.id)?.half ?? half
    }
    points.push({ districtId: to.districtId, pos: end.pos, portal: false, half: end.half })
    return { points: rounded(points), metres: best.metres }
  }
}

/**
 * A route with its corners rounded: a vehicle drives round a junction, it does not turn on the
 * spot. Each corner inside a district is replaced by a short curve that leaves the road it is on
 * a few metres before the corner and joins the next a few metres after, cut into small straight
 * pieces. Seams and the two ends are left exactly where they are.
 */
function rounded(points: RoutePoint[]): RoutePoint[] {
  const out: RoutePoint[] = []
  for (let i = 0; i < points.length; i++) {
    const at = points[i]!, before = points[i - 1], after = points[i + 1]
    if (!before || !after || at.portal || before.portal || before.districtId !== at.districtId || after.districtId !== at.districtId) { out.push(at); continue }
    const inLength = Math.hypot(at.pos.x - before.pos.x, at.pos.z - before.pos.z), outLength = Math.hypot(after.pos.x - at.pos.x, after.pos.z - at.pos.z)
    if (inLength < 0.5 || outLength < 0.5) { out.push(at); continue }
    const ix = (at.pos.x - before.pos.x) / inLength, iz = (at.pos.z - before.pos.z) / inLength, ox = (after.pos.x - at.pos.x) / outLength, oz = (after.pos.z - at.pos.z) / outLength
    const turn = Math.acos(Math.max(-1, Math.min(1, ix * ox + iz * oz)))
    if (turn < 0.15) { out.push(at); continue }
    const reach = Math.min(7, 0.45 * inLength, 0.45 * outLength)
    const from = { x: at.pos.x - ix * reach, z: at.pos.z - iz * reach }, to = { x: at.pos.x + ox * reach, z: at.pos.z + oz * reach }
    const pieces = Math.max(3, Math.ceil(turn / 0.12))
    for (let n = 0; n <= pieces; n++) {
      const t = n / pieces, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t
      out.push({ districtId: at.districtId, pos: { x: a * from.x + b * at.pos.x + c * to.x, z: a * from.z + b * at.pos.z + c * to.z }, portal: false, half: t <= 0.5 ? at.half : after.half })
    }
  }
  return out
}

/** The road producer's dataset. It stays on the service: the App is given a small scene manifest, never this. */
const DATA_FILE = './data/transport/yaba-vehicles.json'
export interface ShippedRoads { authority: RoadAuthority | null; reason: string }
let fromFile: ShippedRoads | null = null
let roadLoader: (() => ShippedRoads) | null = null

/** The file beside this module, or null where the runtime gives the module no file URL (a bundled Worker). */
function dataPath(): string | null {
  const base: unknown = import.meta.url
  if (typeof base !== 'string' || !base.startsWith('file:')) return null
  try { return fileURLToPath(new URL(DATA_FILE, base)) } catch { return null }
}

/**
 * Trusted server bootstrap only, before the first world asks for roads: a runtime with no file
 * beside this module hands over its reviewed, hash-checked copy. A request never supplies road data.
 * Without it the file is read as before.
 */
export function configureShippedRoads(loader: () => ShippedRoads): void {
  if (fromFile) throw new Error('Vehicle roads were already prepared.')
  if (typeof loader !== 'function') throw new Error('Vehicle roads need a loader.')
  roadLoader = loader
}

/** The road data this build ships, read once for the process. With none, or one that fails its checks, vehicles are unavailable and the reason says why. */
export function shippedRoadAuthority(): ShippedRoads {
  if (fromFile) return fromFile
  if (roadLoader) {
    try {
      const given = roadLoader()
      if (!given || (given.authority !== null && !(given.authority instanceof RoadAuthority)) || typeof given.reason !== 'string') throw new Error('the loader did not return checked road data')
      fromFile = given.authority ? { authority: given.authority, reason: '' } : { authority: null, reason: given.reason || 'Vehicles are not available right now: the road data did not pass its checks. Walking and Travel work as before.' }
    } catch (error) {
      console.error('[vehicles] the road data could not be used', error)
      fromFile = { authority: null, reason: 'Vehicles are not available right now: the road data did not pass its checks. Walking and Travel work as before.' }
    }
    return fromFile
  }
  const path = dataPath()
  if (!path || !existsSync(path)) return (fromFile = { authority: null, reason: 'Vehicles are not available on this service yet: it has no road data. Walking and Travel work as before.' })
  const started = Date.now()
  try {
    fromFile = { authority: new RoadAuthority(JSON.parse(readFileSync(path, 'utf8')) as VehicleRoadDataset), reason: '' }
    console.log(`[vehicles] road data ${fromFile.authority!.id} ${fromFile.authority!.dataVersion.slice(0, 12)} read and indexed in ${Date.now() - started} ms`)
  } catch (error) {
    console.error('[vehicles] the road data could not be used', error)
    fromFile = { authority: null, reason: 'Vehicles are not available right now: the road data did not pass its checks. Walking and Travel work as before.' }
  }
  return fromFile
}
