// Offline builder. Source tiles are pinned, redistributable ODbL data, never client input.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Box3, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { buildDistrict, chooseArrival } from '../src/geo/district.ts'
import type { District } from '../src/geo/district.ts'
import { parseDistrictId, districtIdOf } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import type { DistrictId } from '../src/shared/ids.ts'
import type { VehicleRoadDataset, VehicleRoadDistrict, VehicleRoadEdge, VehicleRoadNode, VehicleObstacle } from '../src/shared/vehicleRoadData.ts'
import { vehicleDistrictPoint, canonicalVehicleRoadJson } from '../src/shared/vehicleRoadData.ts'
import { regionKitFor } from '../src/world/regions/kits.ts'
import type { ModelName } from '../src/world/regions/kits.ts'
import { regionPlacements } from '../src/world/regions/placement.ts'
import type { ModelFootprint } from '../src/world/regions/placement.ts'
import { StreetNavigator, pointInPolygon } from '../src/world/nav.ts'

const root = new URL('../', import.meta.url)
const version = '20260927_080001_pt'
const template = `https://tiles.openfreemap.org/planet/${version}/{z}/{x}/{y}.pbf`
// Public starter locations only. Coverage stays finite and provider URLs remain allowlisted.
const coverage = [
  { label: 'Yaba, Lagos', ids: ['d:14/8345/7895', 'd:14/8345/7896', 'd:14/8346/7895', 'd:14/8346/7896'] },
  { label: 'Wuse, Abuja', ids: [districtIdOf({ lat: 9.0765, lon: 7.476 })] },
]
const ids: DistrictId[] = coverage.flatMap(group => group.ids.map(id => {
  if (!parseDistrictId(id)) throw new Error('Invalid coverage district')
  return id as DistrictId
}))
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const round = (value: number): number => Math.round(value * 1e6) / 1e6
const point = (p: Vec2): Vec2 => ({ x: round(p.x), z: round(p.z) })
const bounds = (outer: Vec2[]): VehicleObstacle['bounds'] => ({ minX: round(Math.min(...outer.map(p => p.x))), maxX: round(Math.max(...outer.map(p => p.x))), minZ: round(Math.min(...outer.map(p => p.z))), maxZ: round(Math.max(...outer.map(p => p.z))) })
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z)
const along = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
const projection = (p: Vec2, a: Vec2, b: Vec2): { pos: Vec2; t: number; distance: number } => {
  const length2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / length2)) : 0
  const pos = along(a, b, t)
  return { pos, t, distance: dist(p, pos) }
}
interface Segment { a: Vec2; b: Vec2; road: number; width: number; splits: number[] }
function clip(a: Vec2, b: Vec2, half: number): [Vec2, Vec2] | null {
  let lo = 0, hi = 1
  for (const [start, delta] of [[a.x, b.x - a.x], [a.z, b.z - a.z]]) {
    if (start === undefined || delta === undefined) throw new Error('Invalid segment')
    if (delta === 0) { if (Math.abs(start) > half) return null; continue }
    const first = (-half - start) / delta, last = (half - start) / delta
    lo = Math.max(lo, Math.min(first, last)); hi = Math.min(hi, Math.max(first, last))
  }
  return lo < hi ? [along(a, b, lo), along(a, b, hi)] : null
}
const obstacleGrids = new WeakMap<VehicleObstacle[], Map<string, VehicleObstacle[]>>()
function obstacleClear(p: Vec2, obstacles: VehicleObstacle[], radius: number): boolean {
  let grid = obstacleGrids.get(obstacles)
  if (!grid) {
    grid = new Map()
    for (const obstacle of obstacles) {
      const xs = obstacle.outer.map(point => point.x), zs = obstacle.outer.map(point => point.z)
      for (let x = Math.floor((Math.min(...xs) - 2) / 40); x <= Math.floor((Math.max(...xs) + 2) / 40); x++) for (let z = Math.floor((Math.min(...zs) - 2) / 40); z <= Math.floor((Math.max(...zs) + 2) / 40); z++) {
        const key = `${x}:${z}`, entries = grid.get(key)
        if (entries) entries.push(obstacle); else grid.set(key, [obstacle])
      }
    }
    obstacleGrids.set(obstacles, grid)
  }
  for (const obstacle of grid.get(`${Math.floor(p.x / 40)}:${Math.floor(p.z / 40)}`) ?? []) {
    if (pointInPolygon(p, obstacle)) return false
    for (const ring of [obstacle.outer, ...obstacle.holes]) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]
      if (a && b && projection(p, a, b).distance < radius) return false
    }
  }
  return true
}
function segmentClear(a: Vec2, b: Vec2, obstacles: VehicleObstacle[], radius: number): boolean {
  const steps = Math.max(1, Math.ceil(dist(a, b) / 0.5))
  for (let step = 0; step <= steps; step++) if (!obstacleClear(along(a, b, step / steps), obstacles, radius)) return false
  return true
}

// Measure the same pack scenes used by buildRegionLayer, without a renderer or DOM.
const packCompressed = await readFile(new URL('public/regions/nigeria.pack.gz', root))
const pack = gunzipSync(packCompressed)
if (pack.subarray(0, 4).toString() !== 'NWPK') throw new Error('Invalid region pack')
const indexLength = pack.readUInt32LE(4), base = 8 + indexLength
const index: unknown = JSON.parse(pack.subarray(8, base).toString())
if (!index || typeof index !== 'object' || !('entries' in index) || !Array.isArray(index.entries)) throw new Error('Invalid pack index')
const kit = regionKitFor('NG', 'Yaba, Lagos')
if (!kit) throw new Error('Missing Lagos kit')
const footprints = new Map<ModelName, ModelFootprint>()
const loader = new GLTFLoader()
for (const name of kit.models.filter(name => name !== 'bump' && name !== 'beacon')) {
  const entry: unknown = index.entries.find((raw: unknown) => raw && typeof raw === 'object' && 'name' in raw && raw.name === name)
  if (!entry || typeof entry !== 'object' || !('offset' in entry) || !('length' in entry) || typeof entry.offset !== 'number' || typeof entry.length !== 'number') throw new Error(`Missing ${name}`)
  const bytes = new Uint8Array(pack.subarray(base + entry.offset, base + entry.offset + entry.length))
  const gltf = await loader.parseAsync(bytes.buffer, '')
  gltf.scene.updateMatrixWorld(true)
  const size = new Box3().setFromObject(gltf.scene).getSize(new Vector3())
  footprints.set(name, { width: size.x, depth: size.z, height: size.y })
  gltf.scene.traverse(object => { if ('geometry' in object && object.geometry && typeof object.geometry === 'object' && 'dispose' in object.geometry && typeof object.geometry.dispose === 'function') object.geometry.dispose() })
}
const sceneSources = await Promise.all(['src/geo/district.ts', 'src/geo/mvt.ts', 'src/shared/geo.ts', 'src/world/nav.ts', 'src/world/cameraCollision.ts', 'src/world/regions/placement.ts', 'src/world/regions/kits.ts', 'src/world/regions/index.ts', 'src/world/regionMount.ts', 'src/shared/worldCollision.ts', 'src/world/regions/streetLife.ts', 'src/world/facadeDetails.ts', 'src/world/regions/frontages.ts'].map(async path => ({ path, sha256: sha(await readFile(new URL(path, root))) })))
const tiles: VehicleRoadDataset['source']['tiles'] = []
const districts: VehicleRoadDistrict[] = [], sceneDistricts = new Map<DistrictId, District>()
const nodes: VehicleRoadNode[] = [], edges: VehicleRoadEdge[] = []
const addEdge = (a: number, b: number, width: number, kind: 'road' | 'portal', length: number): void => {
  if (a === b || edges.some(edge => edge.kind === kind && ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)))) return
  edges.push({ id: `${kind}:${Math.min(a, b)}:${Math.max(a, b)}`, a, b, length: round(length), width, bridge: false, kind, bidirectional: true, directionSource: 'inferred-game-two-way' })
}
for (const id of ids) {
  const tile = parseDistrictId(id)
  if (!tile) throw new Error('Invalid supported district')
  const relative = `service/data/transport/source/${tile.z}-${tile.x}-${tile.y}.pbf`
  const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
  // --fetch refreshes only this fixed allowlist and fixed provider revision.
  if (process.argv.includes('--fetch')) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Source unavailable: ${response.status}`)
    await writeFile(new URL(relative, root), new Uint8Array(await response.arrayBuffer()))
  }
  const bytes = await readFile(new URL(relative, root))
  tiles.push({ districtId: id, url, sha256: sha(bytes) })
  const scene = buildDistrict(id, bytes, version); sceneDistricts.set(id, scene)
  const obstacles: VehicleObstacle[] = [
    ...scene.buildings.map((polygon, i) => ({ id: `${id}:building:${i}`, kind: 'building' as const, outer: polygon.outer.map(point), holes: polygon.holes.map(ring => ring.map(point)), bounds: bounds(polygon.outer) })),
    ...scene.ground.filter(ground => ground.kind === 'water').map((polygon, i) => ({ id: `${id}:water:${i}`, kind: 'water' as const, outer: polygon.outer.map(point), holes: polygon.holes.map(ring => ring.map(point)), bounds: bounds(polygon.outer) })),
  ]
  const area = coverage.find(group => group.ids.includes(id))
  const districtKit = area && regionKitFor('NG', area.label)
  if (!districtKit) throw new Error(`Missing region kit for ${id}`)
  const placements = regionPlacements(scene, new StreetNavigator(scene), districtKit, footprints)
  for (const [i, placement] of placements.entries()) {
    const footprint = footprints.get(placement.model)
    if (!footprint || footprint.height < 0.18) continue
    const cos = Math.cos(placement.angle), sin = Math.sin(placement.angle)
    const outer = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([sx, sz]) => {
      if (sx === undefined || sz === undefined) throw new Error('Invalid footprint')
      const x = sx * footprint.width / 2, z = sz * footprint.depth / 2
      return point({ x: placement.pos.x + x * cos + z * sin, z: placement.pos.z - x * sin + z * cos })
    })
    obstacles.push({ id: `${id}:prop:${i}:${placement.model}`, kind: 'prop', outer, holes: [], bounds: bounds(outer) })
  }
  const roads: VehicleRoadDistrict['roads'] = []
  const segments: Segment[] = []
  for (const [i, road] of scene.roads.entries()) {
    // Bridge/tunnel connectivity and legal access are not established by the scene source.
    if (road.tunnel || road.bridge || !['motorway', 'major', 'street', 'service'].includes(road.kind)) continue
    const kind = road.kind
    if (kind !== 'motorway' && kind !== 'major' && kind !== 'street' && kind !== 'service') continue
    for (let part = 1; part < road.points.length; part++) {
      const a = road.points[part - 1], b = road.points[part]
      if (!a || !b) continue
      const clipped = clip(a, b, scene.span / 2)
      if (!clipped || dist(clipped[0], clipped[1]) < 0.05) continue
      roads.push({ id: `${id}:road:${i}:${part}`, kind, width: road.width, bridge: false, points: clipped.map(point) })
      segments.push({ a: clipped[0], b: clipped[1], road: i, width: road.width, splits: [0, 1] })
    }
  }
  // Split real surface junctions; bridges/tunnels are already excluded. Short gaps from vector
  // simplification may join only within 1.5m, with a collision-clear connecting segment.
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const first = segments[i], second = segments[j]
    if (!first || !second) continue
    if (Math.max(first.a.x, first.b.x) + 1.5 < Math.min(second.a.x, second.b.x) || Math.max(second.a.x, second.b.x) + 1.5 < Math.min(first.a.x, first.b.x) || Math.max(first.a.z, first.b.z) + 1.5 < Math.min(second.a.z, second.b.z) || Math.max(second.a.z, second.b.z) + 1.5 < Math.min(first.a.z, first.b.z)) continue
    const dx = first.b.x - first.a.x, dz = first.b.z - first.a.z, ex = second.b.x - second.a.x, ez = second.b.z - second.a.z
    const denominator = dx * ez - dz * ex
    if (Math.abs(denominator) > 1e-8) {
      const px = second.a.x - first.a.x, pz = second.a.z - first.a.z
      const t = (px * ez - pz * ex) / denominator, u = (px * dz - pz * dx) / denominator
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { first.splits.push(t); second.splits.push(u) }
    }
    for (const endpoint of [first.a, first.b]) {
      const onto = projection(endpoint, second.a, second.b)
      if (onto.distance <= 1.5 && segmentClear(endpoint, onto.pos, obstacles, 1.1)) second.splits.push(onto.t)
    }
    for (const endpoint of [second.a, second.b]) {
      const onto = projection(endpoint, first.a, first.b)
      if (onto.distance <= 1.5 && segmentClear(endpoint, onto.pos, obstacles, 1.1)) first.splits.push(onto.t)
    }
  }
  const localNodes: VehicleRoadNode[] = []
  const addNode = (pos: Vec2): number => {
    const existing = localNodes.find(node => dist(node.pos, pos) < 0.05)
    if (existing) return existing.id
    const node = { id: nodes.length, districtId: id, pos: point(pos) }
    nodes.push(node); localNodes.push(node); return node.id
  }
  for (const segment of segments) {
    const splits = [...new Set(segment.splits.map(t => round(t)))].sort((a, b) => a - b)
    for (let i = 1; i < splits.length; i++) {
      const start = splits[i - 1], end = splits[i]
      if (start === undefined || end === undefined || end - start < 1e-7) continue
      const a = along(segment.a, segment.b, start), b = along(segment.a, segment.b, end)
      if (segmentClear(a, b, obstacles, 1.1)) addEdge(addNode(a), addNode(b), segment.width, 'road', dist(a, b))
    }
  }
  // Joins remain inside a road ribbon; no courtyard/off-road shortcuts are synthesized.
  for (let i = 0; i < localNodes.length; i++) for (let j = i + 1; j < localNodes.length; j++) {
    const a = localNodes[i], b = localNodes[j]
    if (a && b && dist(a.pos, b.pos) <= 1.5 && segmentClear(a.pos, b.pos, obstacles, 1.1)) addEdge(a.id, b.id, 4.5, 'road', dist(a.pos, b.pos))
  }
  districts.push({ id, span: scene.span, roads, obstacles, places: [], depots: [] })
}
// Only link matching mapped roads on adjacent boundaries. The portal coordinate is normalized
// to the shared map fraction; subtracting local metre positions across tiles would be wrong.
for (const first of districts) for (const second of districts) {
  const aTile = parseDistrictId(first.id), bTile = parseDistrictId(second.id)
  if (!aTile || !bTile) throw new Error('Invalid district')
  const dx = bTile.x - aTile.x, dy = bTile.y - aTile.y
  if (!((dx === 1 && dy === 0) || (dx === 0 && dy === 1))) continue
  const aNodes = nodes.filter(node => node.districtId === first.id && Math.abs((dx ? node.pos.x : node.pos.z) - first.span / 2) < 0.01)
  const bNodes = nodes.filter(node => node.districtId === second.id && Math.abs((dx ? node.pos.x : node.pos.z) + second.span / 2) < 0.01)
  for (const a of aNodes) {
    const mapped = vehicleDistrictPoint(a.pos, { span: first.span, tileX: aTile.x, tileY: aTile.y }, { span: second.span, tileX: bTile.x, tileY: bTile.y })
    const b = bNodes.map(node => ({ node, distance: dist(mapped, node.pos) })).sort((x, y) => x.distance - y.distance)[0]
    if (!b || b.distance > 1.5) continue
    const widths = edges.filter(edge => edge.kind === 'road' && (edge.a === a.id || edge.b === a.id || edge.a === b.node.id || edge.b === b.node.id)).map(edge => edge.width)
    // Exact seams have zero distance. Rounding/simplification offsets keep their measured
    // geographic length, never a long fictitious within-tile chord.
    addEdge(a.id, b.node.id, Math.min(...widths), 'portal', b.distance)
  }
}
// Depots and reachable POIs attach to the largest connected road component, with safe exits.
const adjacency = new Map<number, number[]>()
for (const edge of edges) { adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b]); adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a]) }
const visited = new Set<number>(), components: number[][] = []
for (const node of nodes) {
  if (visited.has(node.id)) continue
  const queue = [node.id]; visited.add(node.id)
  for (let i = 0; i < queue.length; i++) for (const next of adjacency.get(queue[i] ?? -1) ?? []) if (!visited.has(next)) { visited.add(next); queue.push(next) }
  components.push(queue)
}
components.sort((a, b) => b.length - a.length)
// A distant public district cannot connect to Lagos. Select the largest real road component
// in each bounded coverage group, without a fabricated cross-city link.
const main = new Set(coverage.flatMap(group => components.find(component => component.some(id => {
  const node = nodes[id]
  return node && group.ids.includes(node.districtId)
})) ?? []))
function attachToMain(districtId: DistrictId, target: Vec2, maxDistance: number): VehicleRoadNode | null {
  let best: { edge: VehicleRoadEdge; index: number; pos: Vec2; t: number; distance: number } | null = null
  for (const [index, edge] of edges.entries()) {
    const a = nodes[edge.a], b = nodes[edge.b]
    if (edge.kind !== 'road' || !a || !b || a.districtId !== districtId || b.districtId !== districtId || !main.has(a.id) || !main.has(b.id)) continue
    const projected = projection(target, a.pos, b.pos)
    if (!best || projected.distance < best.distance) best = { edge, index, ...projected }
  }
  if (!best || best.distance > maxDistance) return null
  if (best.t < 1e-7) return nodes[best.edge.a] ?? null
  if (best.t > 1 - 1e-7) return nodes[best.edge.b] ?? null
  const node = { id: nodes.length, districtId, pos: point(best.pos) }
  nodes.push(node); main.add(node.id)
  edges.splice(best.index, 1)
  addEdge(best.edge.a, node.id, best.edge.width, 'road', best.edge.length * best.t)
  addEdge(node.id, best.edge.b, best.edge.width, 'road', best.edge.length * (1 - best.t))
  return node
}
for (const district of districts) {
  const scene = sceneDistricts.get(district.id)
  if (!scene) throw new Error('Missing scene')
  const local = nodes.filter(node => node.districtId === district.id && main.has(node.id))
  const arrival = chooseArrival(scene)
  for (const node of [...local].sort((a, b) => dist(a.pos, arrival.pos) - dist(b.pos, arrival.pos))) {
    const edge = edges.find(edge => edge.kind === 'road' && (edge.a === node.id || edge.b === node.id) && edge.length >= 8 && edge.width >= 7)
    if (!edge || Math.abs(node.pos.x) > district.span / 2 - 8 || Math.abs(node.pos.z) > district.span / 2 - 8) continue
    const other = nodes[edge.a === node.id ? edge.b : edge.a]
    if (!other) continue
    const heading = Math.atan2(other.pos.x - node.pos.x, other.pos.z - node.pos.z)
    const pos = along(node.pos, other.pos, Math.min(0.5, 5 / edge.length))
    const footprint: Vec2[] = []
    for (let x = -1.2; x <= 1.201; x += 0.4) for (let z = -3; z <= 3.001; z += 0.4) footprint.push({ x: pos.x + x * Math.cos(heading) + z * Math.sin(heading), z: pos.z - x * Math.sin(heading) + z * Math.cos(heading) })
    const clear = footprint.every(p => obstacleClear(p, district.obstacles, 0.2))
    const exits = [-1, 1].map(side => point({ x: pos.x + Math.cos(heading) * side * 2.1, z: pos.z - Math.sin(heading) * side * 2.1 })).filter(exit => obstacleClear(exit, district.obstacles, 0.55))
    if (clear && exits.length === 2) {
      const attached = attachToMain(district.id, pos, 0.001)
      if (!attached) continue
      district.depots.push({ id: `${district.id}:depot:public-road`, pos: attached.pos, heading: round(heading), nodeId: attached.id, exits }); break
    }
  }
  for (const poi of scene.pois) {
    const attached = attachToMain(district.id, poi.pos, 100)
    if (attached) district.places.push({ id: poi.placeId, name: poi.name, pos: point(poi.pos), roadPos: attached.pos, nodeId: attached.id })
  }
}
const payload: Omit<VehicleRoadDataset, 'dataVersion'> = {
  schemaVersion: 1, id: 'yaba-wuse-vehicles-v1', mapDataVersion: version, coordinateSystem: 'district-metres-east-south',
  source: { provider: 'OpenFreeMap / OpenMapTiles / OpenStreetMap', tileTemplate: template, license: 'ODbL-1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/', attribution: 'Map data © OpenStreetMap contributors · Tiles © OpenMapTiles, served by OpenFreeMap', tiles, sceneHash: sha(JSON.stringify(sceneSources)), sceneSources, regionPackSha256: sha(packCompressed) }, districts, nodes, edges,
}
const dataset: VehicleRoadDataset = { ...payload, dataVersion: sha(canonicalVehicleRoadJson(payload)) }
const output = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length)
await writeFile(output ?? fileURLToPath(new URL('service/data/transport/yaba-vehicles.json', root)), JSON.stringify(dataset) + '\n')
if (!output) await writeFile(new URL('src/assets/transport/yaba-vehicle-scene.json', root), JSON.stringify({ schemaVersion: dataset.schemaVersion, id: dataset.id, dataVersion: dataset.dataVersion, mapDataVersion: dataset.mapDataVersion, source: dataset.source }) + '\n')
console.log(JSON.stringify({ dataVersion: dataset.dataVersion, nodes: nodes.length, edges: edges.length, portals: edges.filter(edge => edge.kind === 'portal').length, mainComponent: main.size, districts: districts.map(district => ({ id: district.id, roads: district.roads.length, obstacles: district.obstacles.length, depots: district.depots.length, places: district.places.length })) }))
