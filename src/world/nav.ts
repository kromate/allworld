import { moveFoot } from '../shared/worldCollision.ts'
// Walking rules for a district: what blocks an avatar, and how to route along real streets.
import type { Vec2 } from '../shared/geo.ts'
import type { District, Polygon, Road } from '../geo/district.ts'

const CELL = 40
const GRAPH_CELL = 32
const JOIN_DISTANCE = 1.5
const AVATAR_RADIUS = 0.55
const CLEARANCE_STEP = 0.75
const MIN_BLOCKING_HEIGHT = 0.18
const ROUTE_CACHE_LIMIT = 96
const ENDPOINTS: readonly (0 | 1)[] = [0, 1]

interface Blocker { polygon: Polygon; minX: number; maxX: number; minZ: number; maxZ: number; water: boolean }
interface GraphNode { pos: Vec2; edges: { to: number; cost: number; length: number }[] }
interface GraphLink { a: Vec2; b: Vec2; from: number; to: number; bridge: boolean; kind: Road['kind']; width: number }
interface GraphAttachment { node: number; distance: number; offset: number; projection: Vec2; link: number; t: number }
interface Split { t: number; vertex: number; pos: Vec2 }
interface RoadSegment {
  id: number
  road: number
  part: number
  a: Vec2
  b: Vec2
  start: number
  end: number
  bridge: boolean
  weight: number
  splits: Split[]
}

export interface NavigationFootprint {
  pos: Vec2
  angle: number
  width: number
  depth: number
  /** Flat markings and paint may report zero height and do not block an avatar. */
  height?: number
}

export interface WalkingRoute { points: Vec2[]; viaStreets: boolean; length: number }

interface ObstacleSet { signature: string; blockers: Blocker[] }

class VertexSets {
  private readonly parents: number[] = []

  add(): number {
    const vertex = this.parents.length
    this.parents.push(vertex)
    return vertex
  }

  find(vertex: number): number {
    const parent = this.parents[vertex]!
    if (parent === vertex) return vertex
    const root = this.find(parent)
    this.parents[vertex] = root
    return root
  }

  join(a: number, b: number): number {
    const rootA = this.find(a), rootB = this.find(b)
    if (rootA !== rootB) this.parents[rootB] = rootA
    return rootA
  }
}

function pointInRing(point: Vec2, ring: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if ((a.z > point.z) !== (b.z > point.z) && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

export function pointInPolygon(point: Vec2, polygon: Polygon): boolean {
  if (!pointInRing(point, polygon.outer)) return false
  return !polygon.holes.some(hole => pointInRing(point, hole))
}

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): { distance: number; t: number } {
  const dx = b.x - a.x, dz = b.z - a.z
  const length2 = dx * dx + dz * dz || 1
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2))
  return { distance: Math.hypot(a.x + dx * t - point.x, a.z + dz * t - point.z), t }
}

function pointAlong(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
}

function intersection(first: RoadSegment, second: RoadSegment): { firstT: number; secondT: number; pos: Vec2 } | null {
  const firstX = first.b.x - first.a.x, firstZ = first.b.z - first.a.z
  const secondX = second.b.x - second.a.x, secondZ = second.b.z - second.a.z
  const denominator = firstX * secondZ - firstZ * secondX
  if (Math.abs(denominator) < 1e-8) return null
  const offsetX = second.a.x - first.a.x, offsetZ = second.a.z - first.a.z
  const firstT = (offsetX * secondZ - offsetZ * secondX) / denominator
  const secondT = (offsetX * firstZ - offsetZ * firstX) / denominator
  if (firstT < -1e-6 || firstT > 1 + 1e-6 || secondT < -1e-6 || secondT > 1 + 1e-6) return null
  const boundedFirst = Math.max(0, Math.min(1, firstT))
  const boundedSecond = Math.max(0, Math.min(1, secondT))
  return { firstT: boundedFirst, secondT: boundedSecond, pos: pointAlong(first.a, first.b, boundedFirst) }
}

function routeLength(from: Vec2, points: Vec2[]): number {
  let length = 0, previous = from
  for (const point of points) {
    length += Math.hypot(point.x - previous.x, point.z - previous.z)
    previous = point
  }
  return length
}

export class StreetNavigator {
  private readonly grid = new Map<string, Blocker[]>()
  private readonly nodes: GraphNode[] = []
  private readonly links: GraphLink[] = []
  private readonly components: number[] = []
  private readonly obstacleSets = new Map<string, ObstacleSet>()
  private readonly routeCache = new Map<string, WalkingRoute>()
  private readonly edgeClearance = new Map<string, boolean>()
  private readonly attachmentCache = new Map<string, GraphAttachment[]>()
  private readonly publicPointCache = new Map<string, { pos: Vec2; distance: number } | null>()
  private _revision = 0
  private mainComponent = -1
  private readonly bridges: Road[]
  private readonly walkRoads: Road[]
  readonly half: number

  constructor(district: District) {
    this.half = district.span / 2 - 1.5
    this.bridges = district.roads.filter(road => road.bridge)
    this.walkRoads = district.roads.filter(road => road.kind !== 'rail' && road.kind !== 'motorway' && !road.tunnel)
    for (const building of district.buildings) this.index(building, false)
    for (const ground of district.ground) if (ground.kind === 'water') this.index(ground, true)
    this.buildGraph()
    let largest = 0, component = 0
    for (let start = 0; start < this.nodes.length; start++) {
      if (this.components[start] !== undefined) continue
      const queue = [start]; this.components[start] = component
      for (let head = 0; head < queue.length; head++) for (const edge of this.nodes[queue[head]!]!.edges) {
        if (this.components[edge.to] !== undefined) continue
        this.components[edge.to] = component; queue.push(edge.to)
      }
      if (queue.length > largest) { largest = queue.length; this.mainComponent = component }
      component++
    }
  }

  private index(polygon: Polygon, water: boolean): Blocker {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const p of polygon.outer) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z) }
    const blocker: Blocker = { polygon, minX, maxX, minZ, maxZ, water }
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const key = `${cx}:${cz}`
        const list = this.grid.get(key)
        if (list) list.push(blocker); else this.grid.set(key, [blocker])
      }
    }
    return blocker
  }

  private unindex(blocker: Blocker): void {
    for (let cx = Math.floor(blocker.minX / CELL); cx <= Math.floor(blocker.maxX / CELL); cx++) {
      for (let cz = Math.floor(blocker.minZ / CELL); cz <= Math.floor(blocker.maxZ / CELL); cz++) {
        const key = `${cx}:${cz}`
        const list = this.grid.get(key)
        if (!list) continue
        const index = list.indexOf(blocker)
        if (index >= 0) list.splice(index, 1)
        if (!list.length) this.grid.delete(key)
      }
    }
  }

  private invalidateRoutes(): void {
    this._revision++
    this.routeCache.clear()
    this.edgeClearance.clear()
    this.attachmentCache.clear()
  }

  /** Replace one owner's complete obstacle set. Equal normalized sets are a no-op. */
  registerObstacles(key: string, footprints: readonly NavigationFootprint[]): void {
    const normalized = footprints
      .filter(footprint => Number.isFinite(footprint.pos.x) && Number.isFinite(footprint.pos.z)
        && Number.isFinite(footprint.angle) && Number.isFinite(footprint.width) && footprint.width > 0
        && Number.isFinite(footprint.depth) && footprint.depth > 0
        && (footprint.height === undefined || Number.isFinite(footprint.height)))
      .filter(footprint => footprint.height === undefined || footprint.height > MIN_BLOCKING_HEIGHT)
      .map(footprint => ({
        x: footprint.pos.x, z: footprint.pos.z, angle: footprint.angle,
        width: footprint.width, depth: footprint.depth, height: footprint.height,
      }))
      .sort((a, b) => a.x - b.x || a.z - b.z || a.angle - b.angle || a.width - b.width || a.depth - b.depth || (a.height ?? 0) - (b.height ?? 0))
    const signature = JSON.stringify(normalized)
    const previous = this.obstacleSets.get(key)
    if (previous?.signature === signature) return
    if (previous) for (const blocker of previous.blockers) this.unindex(blocker)
    const blockers = normalized.map(footprint => {
      const cos = Math.cos(footprint.angle), sin = Math.sin(footprint.angle)
      const corner = (x: number, z: number): Vec2 => ({
        x: footprint.x + x * cos + z * sin,
        z: footprint.z - x * sin + z * cos,
      })
      const halfWidth = footprint.width / 2, halfDepth = footprint.depth / 2
      return this.index({ outer: [
        corner(-halfWidth, -halfDepth), corner(halfWidth, -halfDepth),
        corner(halfWidth, halfDepth), corner(-halfWidth, halfDepth),
      ], holes: [] }, false)
    })
    this.obstacleSets.set(key, { signature, blockers })
    this.invalidateRoutes()
  }

  unregisterObstacles(key: string): void {
    const previous = this.obstacleSets.get(key)
    if (!previous) return
    for (const blocker of previous.blockers) this.unindex(blocker)
    this.obstacleSets.delete(key)
    this.invalidateRoutes()
  }

  private onBridge(point: Vec2): boolean {
    for (const road of this.bridges) {
      for (let i = 0; i < road.points.length - 1; i++) {
        if (distanceToSegment(point, road.points[i]!, road.points[i + 1]!).distance <= road.width / 2 + 1.5) return true
      }
    }
    return false
  }

  /** True when an avatar may stand at `point`: inside the district, outside buildings, not in open water. */
  walkable(point: Vec2): boolean {
    if (Math.abs(point.x) > this.half || Math.abs(point.z) > this.half) return false
    const blockers = this.grid.get(`${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`)
    if (!blockers) return true
    for (const blocker of blockers) {
      if (point.x < blocker.minX || point.x > blocker.maxX || point.z < blocker.minZ || point.z > blocker.maxZ) continue
      if (!pointInPolygon(point, blocker.polygon)) continue
      if (blocker.water && this.onBridge(point)) continue
      return false
    }
    return true
  }

  /** Check the avatar's footprint, not just its centre, so it does not clip through corners. */
  standable(point: Vec2): boolean {
    if (!this.walkable(point)) return false
    const r = AVATAR_RADIUS
    return this.walkable({ x: point.x + r, z: point.z }) && this.walkable({ x: point.x - r, z: point.z })
      && this.walkable({ x: point.x, z: point.z + r }) && this.walkable({ x: point.x, z: point.z - r })
  }

  private clearLine(from: Vec2, to: Vec2): boolean {
    const distance = Math.hypot(to.x - from.x, to.z - from.z)
    const steps = Math.max(1, Math.ceil(distance / CLEARANCE_STEP))
    for (let step = 0; step <= steps; step++) if (!this.standable(pointAlong(from, to, step / steps))) return false
    return true
  }

  private graphEdgeClear(from: number, to: number): boolean {
    const key = from < to ? `${from}:${to}` : `${to}:${from}`
    const cached = this.edgeClearance.get(key)
    if (cached !== undefined) return cached
    const clear = this.clearLine(this.nodes[from]!.pos, this.nodes[to]!.pos)
    this.edgeClearance.set(key, clear)
    return clear
  }

  /** Move from `from` by a step, sliding along whatever is in the way. */
  step(from: Vec2, dx: number, dz: number): { pos: Vec2; blocked: boolean; atEdge: boolean } {
    const target = { x: from.x + dx, z: from.z + dz }
    const atEdge = Math.abs(target.x) > this.half || Math.abs(target.z) > this.half
    const pos = moveFoot(from, target, [], point => this.standable(point))
    return { pos, blocked: Math.hypot(pos.x - from.x, pos.z - from.z) < 1e-5, atEdge }
  }

  /** Closest standable point to `point`, searching outwards. Used to rescue a stuck avatar. */
  nearestWalkable(point: Vec2, maxRadius = 120): Vec2 | null {
    if (this.standable(point)) return point
    for (let radius = 2; radius <= maxRadius; radius += 2) {
      const steps = Math.max(8, Math.round(radius * 1.5))
      for (let i = 0; i < steps; i++) {
        const angle = (i / steps) * Math.PI * 2
        const candidate = { x: point.x + Math.cos(angle) * radius, z: point.z + Math.sin(angle) * radius }
        if (this.standable(candidate)) return candidate
      }
    }
    return null
  }

  // ── Street graph ──

  private buildGraph(): void {
    const vertices = new VertexSets()
    const roadVertices: number[][] = this.walkRoads.map(road => road.points.map(() => vertices.add()))
    const segments: RoadSegment[] = []
    for (let roadIndex = 0; roadIndex < this.walkRoads.length; roadIndex++) {
      const road = this.walkRoads[roadIndex]!, ids = roadVertices[roadIndex]!
      const weight = road.kind === 'major' ? 1.15 : road.kind === 'path' || road.kind === 'pedestrian' ? 0.95 : 1
      for (let part = 0; part < road.points.length - 1; part++) {
        const a = road.points[part]!, b = road.points[part + 1]!
        if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-4) {
          vertices.join(ids[part]!, ids[part + 1]!)
          continue
        }
        segments.push({
          id: segments.length, road: roadIndex, part, a, b, start: ids[part]!, end: ids[part + 1]!, bridge: road.bridge, weight,
          splits: [{ t: 0, vertex: ids[part]!, pos: a }, { t: 1, vertex: ids[part + 1]!, pos: b }],
        })
      }
    }

    const endpointVertex = (segment: RoadSegment, t: number): number | null => {
      const point = pointAlong(segment.a, segment.b, t)
      if (Math.hypot(point.x - segment.a.x, point.z - segment.a.z) <= JOIN_DISTANCE) return segment.start
      if (Math.hypot(point.x - segment.b.x, point.z - segment.b.z) <= JOIN_DISTANCE) return segment.end
      return null
    }
    const addSplit = (segment: RoadSegment, t: number, vertex: number, pos = pointAlong(segment.a, segment.b, t)): void => {
      segment.splits.push({ t, vertex, pos })
    }
    const connect = (first: RoadSegment, firstT: number, second: RoadSegment, secondT: number, pos: Vec2): void => {
      const firstEndpoint = endpointVertex(first, firstT), secondEndpoint = endpointVertex(second, secondT)
      const vertex = firstEndpoint ?? secondEndpoint ?? vertices.add()
      if (firstEndpoint !== null && secondEndpoint !== null) vertices.join(firstEndpoint, secondEndpoint)
      addSplit(first, firstT, vertex, pos)
      addSplit(second, secondT, vertex, pos)
    }
    const connectEndpoint = (source: RoadSegment, sourceT: 0 | 1, target: RoadSegment): void => {
      const point = sourceT === 0 ? source.a : source.b
      const projected = distanceToSegment(point, target.a, target.b)
      if (projected.distance > JOIN_DISTANCE) return
      connect(source, sourceT, target, projected.t, pointAlong(target.a, target.b, projected.t))
    }

    const buckets = new Map<string, RoadSegment[]>()
    for (const segment of segments) {
      const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - JOIN_DISTANCE) / GRAPH_CELL)
      const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + JOIN_DISTANCE) / GRAPH_CELL)
      const minZ = Math.floor((Math.min(segment.a.z, segment.b.z) - JOIN_DISTANCE) / GRAPH_CELL)
      const maxZ = Math.floor((Math.max(segment.a.z, segment.b.z) + JOIN_DISTANCE) / GRAPH_CELL)
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = `${x}:${z}`, list = buckets.get(key)
        if (list) list.push(segment); else buckets.set(key, [segment])
      }
    }
    const compared = new Set<string>()
    for (const list of buckets.values()) {
      for (let firstIndex = 0; firstIndex < list.length; firstIndex++) for (let secondIndex = firstIndex + 1; secondIndex < list.length; secondIndex++) {
        const first = list[firstIndex]!, second = list[secondIndex]!
        if (first.road === second.road && Math.abs(first.part - second.part) <= 1) continue
        const key = first.id < second.id ? `${first.id}:${second.id}` : `${second.id}:${first.id}`
        if (compared.has(key)) continue
        compared.add(key)
        if (first.bridge || second.bridge) {
          for (const firstT of ENDPOINTS) for (const secondT of ENDPOINTS) {
            const firstPoint = firstT === 0 ? first.a : first.b, secondPoint = secondT === 0 ? second.a : second.b
            if (Math.hypot(firstPoint.x - secondPoint.x, firstPoint.z - secondPoint.z) <= JOIN_DISTANCE) connect(first, firstT, second, secondT, firstPoint)
          }
          continue
        }
        const crossing = intersection(first, second)
        if (crossing) connect(first, crossing.firstT, second, crossing.secondT, crossing.pos)
        connectEndpoint(first, 0, second)
        connectEndpoint(first, 1, second)
        connectEndpoint(second, 0, first)
        connectEndpoint(second, 1, first)
      }
    }

    const positions = new Map<number, Vec2[]>()
    for (const segment of segments) for (const split of segment.splits) {
      const root = vertices.find(split.vertex), list = positions.get(root)
      if (list) list.push(split.pos); else positions.set(root, [split.pos])
    }
    const nodeByVertex = new Map<number, number>()
    for (const [vertex, choices] of positions) {
      const average = choices.reduce((sum, point) => ({ x: sum.x + point.x / choices.length, z: sum.z + point.z / choices.length }), { x: 0, z: 0 })
      const pos = this.standable(average) ? average : choices.find(point => this.standable(point))
      if (!pos) continue
      nodeByVertex.set(vertex, this.nodes.length)
      this.nodes.push({ pos, edges: [] })
    }
    const connected = new Set<string>()
    for (const segment of segments) {
      const splits = segment.splits
        .map(split => ({ ...split, vertex: vertices.find(split.vertex) }))
        .sort((a, b) => a.t - b.t)
      for (let splitIndex = 1; splitIndex < splits.length; splitIndex++) {
        const from = nodeByVertex.get(splits[splitIndex - 1]!.vertex), to = nodeByVertex.get(splits[splitIndex]!.vertex)
        if (from === undefined || to === undefined || from === to) continue
        const edgeKey = from < to ? `${from}:${to}` : `${to}:${from}`
        if (connected.has(edgeKey)) continue
        const fromPos = this.nodes[from]!.pos, toPos = this.nodes[to]!.pos
        if (!this.clearLine(fromPos, toPos)) continue
        connected.add(edgeKey)
        const length = Math.hypot(toPos.x - fromPos.x, toPos.z - fromPos.z)
        const cost = length * segment.weight
        this.nodes[from]!.edges.push({ to, cost, length })
        this.nodes[to]!.edges.push({ to: from, cost, length })
        this.links.push({ a: fromPos, b: toPos, from, to, bridge: segment.bridge, kind: this.walkRoads[segment.road]!.kind, width: this.walkRoads[segment.road]!.width })
      }
    }
  }

  private nearestNodes(point: Vec2): GraphAttachment[] {
    const cacheKey = `${point.x}:${point.z}`
    const cached = this.attachmentCache.get(cacheKey)
    if (cached) return cached
    let best: { link: GraphLink; index: number; distance: number; projection: Vec2; t: number } | null = null
    for (let index = 0; index < this.links.length; index++) {
      const link = this.links[index]!
      const nearest = distanceToSegment(point, link.a, link.b)
      if (best && (nearest.distance > best.distance || nearest.distance === best.distance && Number(link.bridge) >= Number(best.link.bridge))) continue
      const projection = pointAlong(link.a, link.b, nearest.t)
      if (!this.clearLine(point, projection)) continue
      best = { link, index, distance: nearest.distance, projection, t: nearest.t }
    }
    if (!best) return []
    const attachments = [best.link.from, best.link.to].map(node => ({
      node,
      distance: best.distance + Math.hypot(this.nodes[node]!.pos.x - best.projection.x, this.nodes[node]!.pos.z - best.projection.z),
      offset: best.distance,
      projection: best.projection,
      link: best.index,
      t: best.t,
    }))
    this.attachmentCache.set(cacheKey, attachments)
    return attachments
  }

  /** Closest standable point on any walkable street. */
  nearestStreetPoint(point: Vec2): Vec2 | null {
    let best: Vec2 | null = null, bestDistance = Infinity
    for (const road of this.walkRoads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = road.points[i]!, b = road.points[i + 1]!
        const { distance, t } = distanceToSegment(point, a, b)
        if (distance >= bestDistance) continue
        const candidate = pointAlong(a, b, t)
        if (!this.standable(candidate)) continue
        bestDistance = distance
        best = candidate
      }
    }
    return best
  }

  /** Prefer a collision-clear segment in the main walking network over isolated courtyards. */
  connectedStreetPoint(target: Vec2, publicRoad = false): Vec2 | null {
    let best: Vec2 | null = null, distance = Infinity
    for (const link of this.links) {
      if (this.components[link.from] !== this.mainComponent || publicRoad && link.kind === 'path') continue
      const projected = distanceToSegment(target, link.a, link.b)
      if (projected.distance >= distance) continue
      distance = projected.distance; best = pointAlong(link.a, link.b, projected.t)
    }
    return best ?? (publicRoad ? this.connectedStreetPoint(target) : this.nearestStreetPoint(target))
  }

  /** A point on the connected public-way graph, with its straight offset from the mapped place. */
  publicStreetPoint(target: Vec2, maxOffset = 150): { pos: Vec2; distance: number } | null {
    const cacheKey = `${maxOffset}:${target.x}:${target.z}`
    if (this.publicPointCache.has(cacheKey)) return this.publicPointCache.get(cacheKey) ?? null
    let best: { pos: Vec2; distance: number } | null = null
    let bestLink: GraphLink | null = null
    let bestLinkIndex = -1, bestT = 0
    for (let index = 0; index < this.links.length; index++) {
      const link = this.links[index]!
      if (this.components[link.from] !== this.mainComponent || link.kind === 'path') continue
      const projected = distanceToSegment(target, link.a, link.b)
      if (projected.distance > maxOffset || best && projected.distance >= best.distance) continue
      best = { pos: pointAlong(link.a, link.b, projected.t), distance: projected.distance }
      bestLink = link
      bestLinkIndex = index
      bestT = projected.t
    }
    this.publicPointCache.set(cacheKey, best)
    if (best && bestLink) {
      const projection = best.pos
      this.attachmentCache.set(`${projection.x}:${projection.z}`, [bestLink.from, bestLink.to].map(node => ({
        node,
        distance: Math.hypot(this.nodes[node]!.pos.x - projection.x, this.nodes[node]!.pos.z - projection.z),
        offset: 0,
        projection,
        link: bestLinkIndex,
        t: bestT,
      })))
    }
    return best
  }

  /** Count destinations reachable from each origin with one bounded graph search per origin. */
  walkingCoverage(origins: readonly Vec2[], destinations: readonly Vec2[], maxDistance: number): number[] {
    const goals = destinations.map(point => this.nearestNodes(point))
    return origins.map(origin => {
      const starts = this.nearestNodes(origin)
      if (!starts.length) return 0
      const costs = new Float64Array(this.nodes.length)
      costs.fill(Infinity)
      const heap: { node: number; cost: number }[] = []
      const push = (entry: { node: number; cost: number }): void => {
        heap.push(entry)
        for (let index = heap.length - 1; index > 0;) {
          const parent = Math.floor((index - 1) / 2)
          if (heap[parent]!.cost <= entry.cost) break
          heap[index] = heap[parent]!
          index = parent
          heap[index] = entry
        }
      }
      const pop = (): { node: number; cost: number } | undefined => {
        const first = heap[0], last = heap.pop()
        if (!first || !last || !heap.length) return first
        heap[0] = last
        for (let index = 0;;) {
          const left = index * 2 + 1, right = left + 1
          if (left >= heap.length) break
          const child = right < heap.length && heap[right]!.cost < heap[left]!.cost ? right : left
          if (heap[index]!.cost <= heap[child]!.cost) break
          const swap = heap[index]!
          heap[index] = heap[child]!
          heap[child] = swap
          index = child
        }
        return first
      }
      for (const start of starts) {
        if (start.distance > maxDistance || start.distance >= costs[start.node]!) continue
        costs[start.node] = start.distance
        push({ node: start.node, cost: start.distance })
      }
      for (let current = pop(); current; current = pop()) {
        if (current.cost !== costs[current.node] || current.cost > maxDistance) continue
        for (const edge of this.nodes[current.node]!.edges) {
          if (!this.graphEdgeClear(current.node, edge.to)) continue
          const next = current.cost + edge.length
          if (next > maxDistance || next >= costs[edge.to]!) continue
          costs[edge.to] = next
          push({ node: edge.to, cost: next })
        }
      }
      let count = 0
      for (const attachments of goals) {
        let distance = Infinity
        for (const attachment of attachments) distance = Math.min(distance, costs[attachment.node]! + attachment.distance)
        const start = starts[0], goal = attachments[0]
        if (start && goal && start.link === goal.link && this.clearLine(start.projection, goal.projection)) {
          const link = this.links[start.link]!
          const length = Math.hypot(link.b.x - link.a.x, link.b.z - link.a.z)
          distance = Math.min(distance, start.offset + Math.abs(start.t - goal.t) * length + goal.offset)
        }
        if (distance <= maxDistance) count++
      }
      return count
    })
  }

  /** An inferred public approach connected to the road, never an isolated courtyard. */
  venueApproach(target: Vec2): Vec2 | null {
    const street = this.connectedStreetPoint(target, true)
    if (!street) return this.nearestWalkable(target, 36)
    let best: { distance: number; dx: number; dz: number; width: number } | null = null
    for (const road of this.walkRoads) for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, dx = b.x - a.x, dz = b.z - a.z
      const length = Math.hypot(dx, dz)
      if (!length) continue
      const distance = distanceToSegment(street, a, b).distance
      if (!best || distance < best.distance) best = { distance, dx: dx / length, dz: dz / length, width: road.width }
    }
    if (best) {
      const candidates = [-1, 1].flatMap(side => [best!.width / 2 + 0.7, best!.width / 2 - 0.8].map(offset => ({ x: street.x - best!.dz * offset * side, z: street.z + best!.dx * offset * side })))
      candidates.sort((a, b) => Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(b.x - target.x, b.z - target.z))
      for (const point of candidates) if (this.clearLine(street, point)) return point
    }
    return street
  }

  /** Keep an arriving person clear of geometry and occupied spawn positions. */
  arrivalPosition(at: Vec2, seed: string, occupied: Vec2[] = []): Vec2 {
    let hash = 2166136261
    for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
    for (let attempt = 0; attempt < 32; attempt++) {
      const angle = ((hash % 32 + attempt) / 32) * Math.PI * 2
      const radius = 1.8 + Math.floor(attempt / 8) * 0.7
      const point = { x: at.x + Math.sin(angle) * radius, z: at.z + Math.cos(angle) * radius }
      if (this.clearLine(at, point) && occupied.every(other => Math.hypot(other.x - point.x, other.z - point.z) >= 1.3)) return point
    }
    return this.nearestWalkable(at) ?? at
  }

  private calculateRoute(from: Vec2, to: Vec2): WalkingRoute {
    const directLength = Math.hypot(to.x - from.x, to.z - from.z)
    const direct = (): { points: Vec2[]; viaStreets: boolean; length: number } => this.clearLine(from, to)
      ? { points: [to], viaStreets: false, length: directLength }
      : { points: [], viaStreets: false, length: 0 }
    if (directLength < 25 || this.nodes.length < 2) return direct()
    const starts = this.nearestNodes(from), goals = this.nearestNodes(to)
    if (!starts.length || !goals.length) return direct()
    const startOnLink = starts[0]!, goalOnLink = goals[0]!
    if (startOnLink.link === goalOnLink.link
      && this.clearLine(from, startOnLink.projection)
      && this.clearLine(startOnLink.projection, goalOnLink.projection)
      && this.clearLine(goalOnLink.projection, to)) {
      const points = [startOnLink.projection, goalOnLink.projection, to]
        .filter((point, index, all) => index === 0 || Math.hypot(point.x - all[index - 1]!.x, point.z - all[index - 1]!.z) > 0.05)
      return { points, viaStreets: true, length: routeLength(from, points) }
    }
    const goalByNode = new Map(goals.map(goal => [goal.node, goal]))
    const cost = new Map<number, number>()
    const cameFrom = new Map<number, number>()
    const open: { node: number; score: number }[] = []
    for (const start of starts) {
      if (start.distance >= (cost.get(start.node) ?? Infinity)) continue
      cost.set(start.node, start.distance)
      open.push({ node: start.node, score: start.distance })
    }
    const closed = new Set<number>()
    let reached = -1, bestTotal = Infinity, expanded = 0
    while (open.length && expanded < 50_000) {
      let bestIndex = 0
      for (let i = 1; i < open.length; i++) if (open[i]!.score < open[bestIndex]!.score) bestIndex = i
      const current = open.splice(bestIndex, 1)[0]!.node
      if (closed.has(current)) continue
      closed.add(current)
      expanded++
      const currentCost = cost.get(current)!
      const finalLeg = goalByNode.get(current)
      if (finalLeg && currentCost + finalLeg.distance < bestTotal) {
        reached = current
        bestTotal = currentCost + finalLeg.distance
      }
      if (currentCost >= bestTotal) continue
      for (const edge of this.nodes[current]!.edges) {
        if (!this.graphEdgeClear(current, edge.to)) continue
        const next = currentCost + edge.cost
        if (next >= (cost.get(edge.to) ?? Infinity)) continue
        cost.set(edge.to, next)
        cameFrom.set(edge.to, current)
        const pos = this.nodes[edge.to]!.pos
        let heuristic = Infinity
        for (const goal of goals) heuristic = Math.min(heuristic, goal.distance + Math.hypot(pos.x - this.nodes[goal.node]!.pos.x, pos.z - this.nodes[goal.node]!.pos.z) * 0.95)
        open.push({ node: edge.to, score: next + heuristic })
      }
    }
    if (reached < 0) return direct()
    const reversed: number[] = []
    for (let node: number | undefined = reached; node !== undefined; node = cameFrom.get(node)) reversed.push(node)
    const path = reversed.reverse()
    const start = starts.find(candidate => candidate.node === path[0])
    const goal = goalByNode.get(reached)
    if (!start || !goal) return direct()
    const points = [start.projection, ...path.map(node => this.nodes[node]!.pos), goal.projection, to]
    const deduped = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1]!.x, point.z - points[index - 1]!.z) > 0.05)
    if (!this.clearLine(from, deduped[0]!) || deduped.some((point, index) => index > 0 && !this.clearLine(deduped[index - 1]!, point))) return direct()
    return { points: deduped, viaStreets: true, length: routeLength(from, deduped) }
  }

  /** Pure cached route cost and waypoints. Obstacles invalidate the cache through `revision`. */
  walkingRoute(from: Vec2, to: Vec2): WalkingRoute {
    const key = `${this._revision}:${from.x}:${from.z}:${to.x}:${to.z}`
    const cached = this.routeCache.get(key)
    if (cached) return { ...cached, points: cached.points.map(point => ({ ...point })) }
    const route = this.calculateRoute(from, to)
    this.routeCache.set(key, route)
    while (this.routeCache.size > ROUTE_CACHE_LIMIT) {
      const oldest = this.routeCache.keys().next().value
      if (oldest !== undefined) this.routeCache.delete(oldest)
    }
    return { ...route, points: route.points.map(point => ({ ...point })) }
  }

  /** Route along collision-safe street edges. A safe open-ground line is the only fallback. */
  route(from: Vec2, to: Vec2): WalkingRoute { return this.walkingRoute(from, to) }

  get streetNodeCount(): number { return this.nodes.length }
  get revision(): number { return this._revision }
  get obstacleCount(): number {
    let count = 0
    for (const set of this.obstacleSets.values()) count += set.blockers.length
    return count
  }
}

const navigationCache = new WeakMap<District, StreetNavigator>()

/** The immutable map navigation graph is shared by arrival selection and rendering. */
export function navigationFor(district: District): StreetNavigator {
  let navigator = navigationCache.get(district)
  if (!navigator) { navigator = new StreetNavigator(district); navigationCache.set(district, navigator) }
  return navigator
}
