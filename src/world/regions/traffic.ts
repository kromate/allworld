import * as THREE from 'three'
import type { District, Road, RoadKind } from '../../geo/district.ts'
import type { Vec2 } from '../../shared/geo.ts'
import type { StreetNavigator } from '../nav.ts'
import { arrivalDirection } from './placement.ts'

export type TrafficModelName = 'danfo' | 'keke' | 'okada' | 'car' | 'bus' | 'carUK'

export interface TrafficTemplatePart {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

export interface RegionTrafficInput {
  district: District
  navigator: StreetNavigator
  quality: 'low' | 'medium' | 'high'
  hour: number
  focus: Vec2
  countryCode: string
  areaLabel: string
  templates: Map<string, readonly TrafficTemplatePart[]>
}

export interface TrafficDiagnosticPosition extends Vec2 {
  model: TrafficModelName
  speed: number
  distance: number
  forwardDot: number
  movedDistance: number
  stoppedTime: number
}

export interface TrafficDiagnostics {
  counter: number
  reselections: number
  playerYields: number
  gapYields: number
  wraps: number
  danfoStops: number
  visibleAhead: number
  movingAhead: number
  movedDistance: number
  stoppedTime: number
  positions: TrafficDiagnosticPosition[]
}

export interface RegionTraffic {
  root: THREE.Group
  update(dt: number, player: Vec2, active?: boolean): void
  setNight(amount: number): void
  setActive(active: boolean): void
  dispose(): void
  stats: { instances: number; triangles: number; textureBytes: number }
  diagnostics: TrafficDiagnostics
}

interface ModelMetrics {
  width: number
  height: number
  depth: number
  triangles: number
}

interface LanePoint extends Vec2 {
  distance: number
  tx: number
  tz: number
}

interface Lane {
  id: number
  kind: RoadKind
  roadWidth: number
  laneOffset: number
  driveSide: -1 | 1
  points: LanePoint[]
  length: number
}

interface Vehicle {
  id: number
  model: TrafficModelName
  lane: Lane
  progress: number
  speed: number
  cruiseSpeed: number
  clock: number
  seed: number
  ended: boolean
  x: number
  z: number
  tx: number
  tz: number
  pullIn: number
  movedDistance: number
  stoppedTime: number
  danfoStopping: boolean
  laneBias: number
}

interface ModelPool {
  model: TrafficModelName
  parts: THREE.InstancedMesh[]
  metrics: ModelMetrics
}

const TRAFFIC_MODELS: readonly TrafficModelName[] = ['danfo', 'keke', 'okada', 'car', 'bus', 'carUK']
const QUALITY_CAP = { low: 2, medium: 4, high: 6 } satisfies Record<RegionTrafficInput['quality'], number>
const QUALITY_RADIUS = { low: 110, medium: 175, high: 250 } satisfies Record<RegionTrafficInput['quality'], number>
const TRIANGLE_BUDGET = 30_000
const SAMPLE_SPACING = 2.5
const END_MARGIN = 6
const RESELECT_DISTANCE = 45
const RESET_CLEARANCE = 48
const UP = new THREE.Vector3(0, 1, 0)

const FALLBACK_METRICS: Record<TrafficModelName, Omit<ModelMetrics, 'triangles'>> = {
  danfo: { width: 2.2, height: 2.31, depth: 4.28 },
  keke: { width: 1.605, height: 2.03, depth: 2.59 },
  okada: { width: 0.84, height: 1.25, depth: 2.67 },
  car: { width: 2.099, height: 1.485, depth: 4.09 },
  bus: { width: 2.755, height: 2.925, depth: 7.55 },
  carUK: { width: 2.05, height: 1.5, depth: 4.1 },
}

function hash(text: string): number {
  let value = 2166136261
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0
  return value
}

function unit(seed: number, salt: number): number {
  let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return ((value ^ (value >>> 15)) >>> 0) / 0x1_0000_0000
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function polylineLength(points: readonly Vec2[]): number {
  let length = 0
  for (let index = 1; index < points.length; index++) length += distance(points[index - 1]!, points[index]!)
  return length
}

function pointOnPolyline(points: readonly Vec2[], target: number): Vec2 {
  let travelled = 0
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!, b = points[index]!, segment = distance(a, b)
    if (segment > 0 && travelled + segment >= target) {
      const amount = (target - travelled) / segment
      return { x: a.x + (b.x - a.x) * amount, z: a.z + (b.z - a.z) * amount }
    }
    travelled += segment
  }
  const last = points[points.length - 1]
  return last ? { x: last.x, z: last.z } : { x: 0, z: 0 }
}

function stitchedRoads(roads: readonly Road[]): Road[] {
  const maximumLength = 320, joinDistance = 2.2
  const extend = (points: Vec2[], road: Road, visited: Set<number>): void => {
    while (polylineLength(points) < maximumLength && visited.size < 18) {
      const end = points[points.length - 1]!, before = points[points.length - 2]!
      const length = distance(before, end) || 1
      const tx = (end.x - before.x) / length, tz = (end.z - before.z) / length
      let best: { index: number; points: readonly Vec2[]; score: number } | null = null
      for (let index = 0; index < roads.length; index++) {
        if (visited.has(index)) continue
        const candidate = roads[index]!
        if (candidate.kind !== road.kind || candidate.bridge !== road.bridge || Math.abs(candidate.width - road.width) > 0.6 || candidate.points.length < 2) continue
        for (const reverse of [false, true]) {
          const oriented = reverse ? candidate.points.toReversed() : candidate.points
          const first = oriented[0]!, second = oriented[1]!, gap = distance(end, first)
          if (gap > joinDistance) continue
          const nextLength = distance(first, second) || 1
          const dot = tx * ((second.x - first.x) / nextLength) + tz * ((second.z - first.z) / nextLength)
          if (dot < -0.15) continue
          const score = dot * 4 - gap
          if (!best || score > best.score) best = { index, points: oriented, score }
        }
      }
      if (!best) return
      visited.add(best.index)
      points.push(...best.points.slice(1))
    }
  }
  return roads.map((road, index) => {
    const points = [...road.points], visited = new Set([index])
    extend(points, road, visited)
    points.reverse(); extend(points, road, visited); points.reverse()
    return { ...road, points }
  })
}

function buildLane(road: Road, driveSide: -1 | 1, direction: 1 | -1, id: number): Lane | null {
  const source = road.points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.z))
  const points = direction === 1 ? source : source.toReversed()
  const centerLength = polylineLength(points)
  if (points.length < 2 || centerLength < 34 || road.width < 3.2) return null
  const laneOffset = Math.min(road.width * 0.23, Math.max(0.72, road.width / 2 - 1.45))
  const count = Math.max(2, Math.ceil(centerLength / SAMPLE_SPACING) + 1)
  const lanePoints: LanePoint[] = []
  let laneLength = 0
  for (let index = 0; index < count; index++) {
    const along = (index / (count - 1)) * centerLength
    const center = pointOnPolyline(points, along)
    const before = pointOnPolyline(points, Math.max(0, along - 1.25))
    const after = pointOnPolyline(points, Math.min(centerLength, along + 1.25))
    const dx = after.x - before.x, dz = after.z - before.z, magnitude = Math.hypot(dx, dz)
    if (magnitude < 0.01) continue
    const tx = dx / magnitude, tz = dz / magnitude
    const point = { x: center.x - tz * laneOffset * driveSide, z: center.z + tx * laneOffset * driveSide }
    const previous = lanePoints[lanePoints.length - 1]
    if (previous) laneLength += distance(previous, point)
    lanePoints.push({ ...point, distance: laneLength, tx, tz })
  }
  if (lanePoints.length < 2 || laneLength < 30) return null
  return { id, kind: road.kind, roadWidth: road.width, laneOffset, driveSide, points: lanePoints, length: laneLength }
}

function sampleLane(lane: Lane, progress: number, pullIn = 0): LanePoint {
  const target = THREE.MathUtils.clamp(progress, 0, lane.length)
  let high = lane.points.length - 1, low = 0
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (lane.points[middle]!.distance < target) low = middle + 1
    else high = middle
  }
  const next = lane.points[low]!
  const previous = lane.points[Math.max(0, low - 1)]!
  const span = next.distance - previous.distance
  const amount = span > 0 ? (target - previous.distance) / span : 0
  let tx = previous.tx + (next.tx - previous.tx) * amount
  let tz = previous.tz + (next.tz - previous.tz) * amount
  const magnitude = Math.hypot(tx, tz) || 1
  tx /= magnitude; tz /= magnitude
  return {
    x: previous.x + (next.x - previous.x) * amount - tz * pullIn * lane.driveSide,
    z: previous.z + (next.z - previous.z) * amount + tx * pullIn * lane.driveSide,
    distance: target, tx, tz,
  }
}

function longestWalkableSection(lane: Lane, navigator: StreetNavigator): Lane | null {
  let bestStart = 0, bestEnd = -1, currentStart = 0
  for (let index = 0; index <= lane.points.length; index++) {
    const walkable = index < lane.points.length && navigator.walkable(lane.points[index]!)
    if (walkable) continue
    if (index - currentStart > bestEnd - bestStart + 1) { bestStart = currentStart; bestEnd = index - 1 }
    currentStart = index + 1
  }
  if (bestEnd - bestStart < 1) return null
  const source = lane.points.slice(bestStart, bestEnd + 1)
  const points: LanePoint[] = []
  let length = 0
  for (const point of source) {
    const previous = points[points.length - 1]
    if (previous) length += distance(previous, point)
    points.push({ ...point, distance: length })
  }
  return length >= 30 ? { ...lane, points, length } : null
}

function modelMetrics(model: TrafficModelName, parts: readonly TrafficTemplatePart[]): ModelMetrics {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  let triangles = 0
  for (const part of parts) {
    const position = part.geometry.getAttribute('position')
    if (position) for (let index = 0; index < position.count; index++) {
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }
    triangles += (part.geometry.index?.count ?? position?.count ?? 0) / 3
  }
  const fallback = FALLBACK_METRICS[model]
  return {
    width: Number.isFinite(maxX - minX) && maxX > minX ? maxX - minX : fallback.width,
    height: Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : fallback.height,
    depth: Number.isFinite(maxZ - minZ) && maxZ > minZ ? maxZ - minZ : fallback.depth,
    triangles,
  }
}

function availableModels(country: 'NG' | 'GB', kind: RoadKind): readonly TrafficModelName[] {
  if (country === 'GB') return ['carUK']
  if (kind === 'motorway') return ['car', 'bus']
  if (kind === 'major') return ['car', 'danfo', 'bus']
  if (kind === 'street') return ['car', 'keke', 'okada']
  return ['okada']
}

function cruiseSpeed(model: TrafficModelName, kind: RoadKind, seed: number): number {
  const variation = unit(seed, 71)
  if (kind === 'service') return 2 + variation * 2
  if (model === 'bus') return 4 + variation * 2
  if (kind === 'major' || kind === 'motorway') return 5 + variation * 3
  return 4 + variation * 2.2
}

function hourDensity(hour: number): number {
  const localHour = ((Math.floor(hour) % 24) + 24) % 24
  if (localHour < 5) return 0.3
  if (localHour < 7) return 0.55
  if (localHour < 10 || localHour >= 16 && localHour < 20) return 1
  if (localHour < 16) return 0.82
  if (localHour < 23) return 0.62
  return 0.35
}

function classWeight(kind: RoadKind): number {
  if (kind === 'motorway' || kind === 'major') return 1.3
  if (kind === 'street') return 1
  return 0.55
}

function nearestProgress(lane: Lane, target: Vec2): { distance: number; progress: number } {
  let bestDistance = Infinity, progress = 0
  for (const point of lane.points) {
    const candidate = distance(point, target)
    if (candidate < bestDistance) { bestDistance = candidate; progress = point.distance }
  }
  return { distance: bestDistance, progress }
}

function progressAhead(lane: Lane, origin: Vec2, forward: Vec2): { distance: number; progress: number; score: number } | null {
  let best: { distance: number; progress: number; score: number } | null = null
  const start = lane.points[0]!, end = lane.points[lane.points.length - 1]!
  const loopsOffscreen = distance(start, origin) > RESET_CLEARANCE && distance(end, origin) > RESET_CLEARANCE
  for (const point of lane.points) {
    if (point.distance < END_MARGIN + 1 || lane.length - point.distance < END_MARGIN + 1) continue
    const dx = point.x - origin.x, dz = point.z - origin.z, range = Math.hypot(dx, dz)
    const dot = dx * forward.x + dz * forward.z
    if (range < 12 || range > 45 || dot < 8 || dot / range < 0.28) continue
    const remaining = lane.length - point.distance
    if (remaining < 60) continue
    const score = Math.abs(range - 27) - Math.min(remaining, 90) * 0.035 - (loopsOffscreen ? 100 : 0)
    if (!best || score < best.score) best = { distance: range, progress: point.distance, score }
  }
  return best
}

function upstreamProgress(lane: Lane, player: Vec2): { distance: number; progress: number } | null {
  let best: { distance: number; progress: number } | null = null
  for (const point of lane.points) {
    const dx = player.x - point.x, dz = player.z - point.z, range = Math.hypot(dx, dz)
    if (range < 55 || range > 88 || dx * point.tx + dz * point.tz <= 12) continue
    if (!best || Math.abs(range - 70) < Math.abs(best.distance - 70)) best = { distance: range, progress: point.distance }
  }
  return best
}

function curbBias(lane: Lane, metrics: ModelMetrics): number {
  const desired = Math.max(0, metrics.width / 2 + 0.82 - lane.laneOffset)
  const room = Math.max(0, lane.roadWidth / 2 - lane.laneOffset - metrics.width / 2 - 0.15)
  return Math.min(desired, room)
}

function supportsVehicle(lane: Lane, metrics: ModelMetrics, navigator: StreetNavigator): boolean {
  const reserve = lane.kind === 'major' || lane.kind === 'motorway' ? 0.6 : 0.2
  const bias = curbBias(lane, metrics)
  if (lane.laneOffset + bias + metrics.width / 2 + reserve > lane.roadWidth / 2) return false
  const halfWidth = metrics.width / 2 + 0.08, halfDepth = metrics.depth / 2 + 0.08
  for (let index = 0; index < lane.points.length; index += 2) {
    const lanePoint = lane.points[index]!
    const point = sampleLane(lane, lanePoint.distance, bias), rx = point.tz, rz = -point.tx
    if (point.distance < END_MARGIN || lane.length - point.distance < END_MARGIN) continue
    for (const longitudinal of [-halfDepth, 0, halfDepth]) for (const lateral of [-halfWidth, 0, halfWidth]) {
      if (!navigator.walkable({ x: point.x + point.tx * longitudinal + rx * lateral, z: point.z + point.tz * longitudinal + rz * lateral })) return false
    }
  }
  return true
}

export function createRegionTraffic(input: RegionTrafficInput): RegionTraffic {
  const root = new THREE.Group()
  root.name = 'region:traffic'
  const stats = { instances: 0, triangles: 0, textureBytes: 0 }
  const diagnostics: TrafficDiagnostics = {
    counter: 0, reselections: 0, playerYields: 0, gapYields: 0, wraps: 0, danfoStops: 0,
    visibleAhead: 0, movingAhead: 0, movedDistance: 0, stoppedTime: 0, positions: [],
  }
  root.userData.diagnostics = diagnostics
  const rawCountry = input.countryCode.trim().toUpperCase()
  const country = rawCountry === 'UK' ? 'GB' : rawCountry
  if (country !== 'NG' && country !== 'GB') {
    return { root, stats, diagnostics, update() {}, setNight() {}, setActive() {}, dispose() { root.removeFromParent(); root.clear() } }
  }

  const maxVehicles = QUALITY_CAP[input.quality]
  const seed = hash(`${input.district.id}|${country}|${input.areaLabel.toLowerCase()}`)
  const arrival = arrivalDirection(input.district)
  const pools = new Map<TrafficModelName, ModelPool>()
  for (const model of TRAFFIC_MODELS) {
    if ((country === 'NG' && model === 'carUK') || (country === 'GB' && model !== 'carUK')) continue
    const parts = input.templates.get(model)
    if (!parts?.length) continue
    const metrics = modelMetrics(model, parts)
    const meshes = parts.map((part, index) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, maxVehicles)
      mesh.name = `traffic:${model}:${index}`
      mesh.count = 0
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.castShadow = input.quality === 'high'
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      root.add(mesh)
      return mesh
    })
    pools.set(model, { model, parts: meshes, metrics })
  }

  const headGeometry = new THREE.PlaneGeometry(1, 1)
  const tailGeometry = new THREE.PlaneGeometry(1, 1)
  const headMaterial = new THREE.MeshBasicMaterial({ color: '#fff4ca', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
  const tailMaterial = new THREE.MeshBasicMaterial({ color: '#ff3027', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, toneMapped: false })
  const headlights = new THREE.InstancedMesh(headGeometry, headMaterial, maxVehicles * 2)
  const taillights = new THREE.InstancedMesh(tailGeometry, tailMaterial, maxVehicles * 2)
  headlights.name = 'traffic:headlights'; taillights.name = 'traffic:taillights'
  headlights.count = 0; taillights.count = 0
  headlights.instanceMatrix.setUsage(THREE.DynamicDrawUsage); taillights.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  headlights.frustumCulled = false; taillights.frustumCulled = false
  root.add(headlights, taillights)

  const driveSide: -1 | 1 = country === 'GB' ? -1 : 1
  const lanes: Lane[] = []
  let laneId = 0
  const mappedRoads = input.district.roads.filter(road => !road.tunnel && road.kind !== 'path' && road.kind !== 'pedestrian' && road.kind !== 'rail')
  for (const road of stitchedRoads(mappedRoads)) {
    for (const direction of [1, -1] as const) {
      const lane = buildLane(road, driveSide, direction, laneId++)
      if (lane) {
        const safeLane = longestWalkableSection(lane, input.navigator)
        if (safeLane) lanes.push(safeLane)
      }
    }
  }

  const safety = new Map<string, boolean>()
  const safeFor = (lane: Lane, pool: ModelPool): boolean => {
    const key = `${lane.id}:${pool.model}`
    const cached = safety.get(key)
    if (cached !== undefined) return cached
    const safe = supportsVehicle(lane, pool.metrics, input.navigator)
    safety.set(key, safe)
    return safe
  }

  let vehicles: Vehicle[] = []
  let lastSelection = { ...arrival.pos }
  let diagnosticPlayer = { ...arrival.pos }
  let selectionElapsed = 0
  let disposed = false, enabled = true, initialSelection = true, nextVehicleId = 1, night = 0
  let baseTriangles = 0
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), position3 = new THREE.Vector3(), scale3 = new THREE.Vector3()

  const choosePool = (lane: Lane, remainingTriangles: number, usedModels: ReadonlySet<TrafficModelName>): ModelPool | null => {
    const choices = availableModels(country, lane.kind).map(model => pools.get(model))
      .filter((pool): pool is ModelPool => pool !== undefined)
      .filter(pool => pool.metrics.triangles <= remainingTriangles && safeFor(lane, pool))
    if (!choices.length) return null
    const unused = choices.filter(pool => !usedModels.has(pool.model))
    const source = unused.length ? unused : choices
    const priority: readonly TrafficModelName[] = ['danfo', 'keke', 'car', 'okada', 'bus', 'carUK']
    return source.toSorted((a, b) => priority.indexOf(a.model) - priority.indexOf(b.model))[0] ?? null
  }

  const updateStats = (): void => {
    stats.instances = vehicles.length
    stats.triangles = Math.round(baseTriangles + (night > 0.03 ? vehicles.length * 8 : 0))
  }

  const reselect = (player: Vec2, replenish = false): void => {
    diagnostics.reselections++
    selectionElapsed = 0
    lastSelection = { ...player }
    const minimum = input.quality === 'low' ? 1 : 2
    const target = Math.min(maxVehicles, Math.max(minimum, Math.round(maxVehicles * hourDensity(input.hour))))
    const radius = QUALITY_RADIUS[input.quality]
    const retained = initialSelection ? [] : vehicles.filter(vehicle => distance(vehicle, player) < (replenish ? 90 : radius * 0.72)).slice(0, target)
    const usedLanes = new Set(retained.map(vehicle => vehicle.lane.id))
    const usedModels = new Set(retained.map(vehicle => vehicle.model))
    let triangles = retained.reduce((sum, vehicle) => sum + (pools.get(vehicle.model)?.metrics.triangles ?? 0), 0)
    const candidates = lanes.map(lane => ({ lane, nearest: nearestProgress(lane, player), front: progressAhead(lane, arrival.pos, arrival), feed: upstreamProgress(lane, player) }))
      .filter(candidate => candidate.nearest.distance < radius && !usedLanes.has(candidate.lane.id) && (!replenish || candidate.feed !== null))
      .sort((a, b) => {
        if (initialSelection && !!a.front !== !!b.front) return a.front ? -1 : 1
        const blockedScore = (lane: Lane, progress: number): number => {
          const point = sampleLane(lane, progress)
          const toArrivalX = arrival.pos.x - point.x, toArrivalZ = arrival.pos.z - point.z
          const ahead = toArrivalX * point.tx + toArrivalZ * point.tz
          const lateral = Math.abs(toArrivalX * point.tz - toArrivalZ * point.tx)
          return ahead > 0 && lateral < 2.1 ? 80 : 0
        }
        const aScore = initialSelection && a.front ? a.front.score + blockedScore(a.lane, a.front.progress) : a.nearest.distance / classWeight(a.lane.kind) + unit(seed, a.lane.id) * 22
        const bScore = initialSelection && b.front ? b.front.score + blockedScore(b.lane, b.front.progress) : b.nearest.distance / classWeight(b.lane.kind) + unit(seed, b.lane.id) * 22
        return aScore - bScore
      })
    const selected = [...retained]
    for (const candidate of candidates) {
      if (selected.length >= target) break
      const pool = choosePool(candidate.lane, TRIANGLE_BUDGET - triangles, usedModels)
      if (!pool) continue
      if (initialSelection && !candidate.front) continue
      const jitter = initialSelection ? 0 : (unit(seed, candidate.lane.id + 311) - 0.5) * 34
      const intendedProgress = replenish ? candidate.feed!.progress : initialSelection && candidate.front ? candidate.front.progress : candidate.nearest.progress + jitter
      const progress = THREE.MathUtils.clamp(intendedProgress, END_MARGIN + 1, candidate.lane.length - END_MARGIN - 1)
      const bias = curbBias(candidate.lane, pool.metrics)
      const point = sampleLane(candidate.lane, progress, bias)
      const playerClearance = Math.max(12, Math.hypot(pool.metrics.width / 2, pool.metrics.depth / 2) + 3)
      if (distance(point, player) < playerClearance) continue
      if (!initialSelection && distance(point, player) < 18) continue
      const vehicleSeed = hash(`${seed}:${candidate.lane.id}:${nextVehicleId}`)
      const speed = cruiseSpeed(pool.model, candidate.lane.kind, vehicleSeed)
      selected.push({
        id: nextVehicleId++, model: pool.model, lane: candidate.lane, progress, speed, cruiseSpeed: speed, clock: 0,
        seed: vehicleSeed, ended: false, x: point.x, z: point.z, tx: point.tx, tz: point.tz, pullIn: 0,
        movedDistance: 0, stoppedTime: 0, danfoStopping: false, laneBias: bias,
      })
      usedLanes.add(candidate.lane.id)
      usedModels.add(pool.model)
      triangles += pool.metrics.triangles
    }
    vehicles = selected
    baseTriangles = triangles
    initialSelection = false
    updateStats()
  }

  const render = (): void => {
    const byModel = new Map<TrafficModelName, Vehicle[]>()
    for (const vehicle of vehicles) {
      const list = byModel.get(vehicle.model)
      if (list) list.push(vehicle); else byModel.set(vehicle.model, [vehicle])
    }
    for (const pool of pools.values()) {
      const list = byModel.get(pool.model) ?? []
      for (const mesh of pool.parts) {
        mesh.count = list.length
        for (let index = 0; index < list.length; index++) {
          const vehicle = list[index]!
          position3.set(vehicle.x, 0.025, vehicle.z)
          quaternion.setFromAxisAngle(UP, Math.atan2(vehicle.tx, vehicle.tz))
          scale3.setScalar(1)
          matrix.compose(position3, quaternion, scale3)
          mesh.setMatrixAt(index, matrix)
        }
        mesh.instanceMatrix.needsUpdate = true
      }
    }

    let lightIndex = 0
    for (const vehicle of vehicles) {
      const metrics = pools.get(vehicle.model)?.metrics
      if (!metrics) continue
      const rx = vehicle.tz, rz = -vehicle.tx, angle = Math.atan2(vehicle.tx, vehicle.tz)
      quaternion.setFromAxisAngle(UP, angle)
      for (const side of [-1, 1]) {
        const lateral = side * metrics.width * 0.3
        position3.set(vehicle.x + rx * lateral + vehicle.tx * (metrics.depth / 2 + 0.025), Math.min(0.72, metrics.height * 0.42), vehicle.z + rz * lateral + vehicle.tz * (metrics.depth / 2 + 0.025))
        scale3.set(0.17, 0.105, 1)
        matrix.compose(position3, quaternion, scale3); headlights.setMatrixAt(lightIndex, matrix)
        position3.set(vehicle.x + rx * lateral - vehicle.tx * (metrics.depth / 2 + 0.025), Math.min(0.68, metrics.height * 0.38), vehicle.z + rz * lateral - vehicle.tz * (metrics.depth / 2 + 0.025))
        scale3.set(0.14, 0.09, 1)
        matrix.compose(position3, quaternion, scale3); taillights.setMatrixAt(lightIndex, matrix)
        lightIndex++
      }
    }
    headlights.count = lightIndex; taillights.count = lightIndex
    headlights.instanceMatrix.needsUpdate = true; taillights.instanceMatrix.needsUpdate = true
    const positions = vehicles.map(vehicle => {
      const dx = vehicle.x - diagnosticPlayer.x, dz = vehicle.z - diagnosticPlayer.z
      return {
        model: vehicle.model, x: vehicle.x, z: vehicle.z, speed: vehicle.speed,
        distance: Math.hypot(dx, dz), forwardDot: dx * arrival.x + dz * arrival.z,
        movedDistance: vehicle.movedDistance, stoppedTime: vehicle.stoppedTime,
      }
    })
    diagnostics.positions.splice(0, diagnostics.positions.length, ...positions)
    diagnostics.visibleAhead = positions.filter(position => position.forwardDot > 0 && position.distance <= 60).length
    diagnostics.movingAhead = positions.filter(position => position.forwardDot > 0 && position.distance <= 60 && position.speed > 0.6).length
  }

  const setNight = (amount: number): void => {
    night = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0
    headMaterial.opacity = night * 0.95; tailMaterial.opacity = night * 0.82
    headlights.visible = night > 0.03; taillights.visible = night > 0.03
    updateStats()
  }

  const setActive = (active: boolean): void => {
    enabled = active
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    root.removeFromParent()
    for (const pool of pools.values()) for (const mesh of pool.parts) mesh.dispose()
    headlights.dispose(); taillights.dispose()
    headGeometry.dispose(); tailGeometry.dispose(); headMaterial.dispose(); tailMaterial.dispose()
    root.clear(); vehicles = []; diagnostics.positions.length = 0
  }

  reselect(input.focus)
  setNight(input.hour < 6 || input.hour >= 19 ? 1 : 0)
  render()

  return {
    root, stats, diagnostics, setNight, setActive, dispose,
    update(dt, player, active = true) {
      if (disposed || !enabled || !active) return
      diagnosticPlayer = { ...player }
      if (distance(player, lastSelection) >= RESELECT_DISTANCE) reselect(player)
      const elapsed = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.12) : 0
      if (elapsed <= 0) return
      selectionElapsed += elapsed
      if (selectionElapsed >= 6) reselect(player, true)
      diagnostics.counter++
      for (const vehicle of vehicles) {
        const pool = pools.get(vehicle.model)
        if (!pool) continue
        vehicle.clock += elapsed
        const current = sampleLane(vehicle.lane, vehicle.progress, vehicle.laneBias + vehicle.pullIn)
        let targetSpeed = vehicle.ended ? 0 : vehicle.cruiseSpeed
        const toPlayerX = player.x - current.x, toPlayerZ = player.z - current.z
        const ahead = toPlayerX * current.tx + toPlayerZ * current.tz
        const lateral = Math.abs(toPlayerX * current.tz - toPlayerZ * current.tx)
        const playerClearance = 0.55 + 0.15
        const stoppingDistance = pool.metrics.depth / 2 + playerClearance + Math.max(1.2, vehicle.speed * vehicle.speed / 12)
        const footprintConflict = lateral < pool.metrics.width / 2 + playerClearance
          && ahead > -(pool.metrics.depth / 2 + playerClearance) && ahead < stoppingDistance
        if (footprintConflict) { targetSpeed = 0; diagnostics.playerYields++ }
        for (const other of vehicles) {
          if (other === vehicle || other.lane.id !== vehicle.lane.id) continue
          const gap = other.progress - vehicle.progress - (pool.metrics.depth + (pools.get(other.model)?.metrics.depth ?? 4)) / 2
          if (gap > 0 && gap < 8) { targetSpeed = Math.min(targetSpeed, vehicle.cruiseSpeed * Math.max(0, (gap - 2.5) / 5.5)); diagnostics.gapYields++ }
        }
        let pullTarget = 0
        let danfoStopping = false
        if (vehicle.model === 'danfo' && vehicle.lane.roadWidth >= 10) {
          const period = 38 + unit(vehicle.seed, 29) * 18, duration = 5 + unit(vehicle.seed, 31) * 2
          const firstStop = 2.5 + unit(vehicle.seed, 33) * 1.5
          const phase = vehicle.clock >= firstStop ? (vehicle.clock - firstStop) % period : Infinity
          if (!vehicle.ended && phase < duration) {
            danfoStopping = true
            targetSpeed = 0
            const room = Math.max(0, vehicle.lane.roadWidth / 2 - vehicle.lane.laneOffset - vehicle.laneBias - pool.metrics.width / 2 - 0.22)
            pullTarget = Math.min(0.55, room) * Math.sin(Math.PI * phase / duration)
          }
        }
        if (danfoStopping && !vehicle.danfoStopping) diagnostics.danfoStops++
        vehicle.danfoStopping = danfoStopping
        vehicle.pullIn += (pullTarget - vehicle.pullIn) * Math.min(1, elapsed * 2.4)
        const acceleration = targetSpeed < vehicle.speed ? 6 : 2
        vehicle.speed += THREE.MathUtils.clamp(targetSpeed - vehicle.speed, -acceleration * elapsed, acceleration * elapsed)
        if (vehicle.ended) {
          const start = vehicle.lane.points[0]!, end = vehicle.lane.points[vehicle.lane.points.length - 1]!
          if (distance(start, player) > RESET_CLEARANCE && distance(end, player) > RESET_CLEARANCE) {
            vehicle.progress = END_MARGIN; vehicle.speed = vehicle.cruiseSpeed; vehicle.ended = false; diagnostics.wraps++
          }
        } else {
          const travelled = Math.max(0, vehicle.speed) * elapsed
          vehicle.progress += travelled
          vehicle.movedDistance += travelled
          diagnostics.movedDistance += travelled
          if (vehicle.progress >= vehicle.lane.length - END_MARGIN) {
            const start = vehicle.lane.points[0]!, end = vehicle.lane.points[vehicle.lane.points.length - 1]!
            if (distance(start, player) > RESET_CLEARANCE && distance(end, player) > RESET_CLEARANCE) {
              vehicle.progress = END_MARGIN; vehicle.speed = vehicle.cruiseSpeed; diagnostics.wraps++
            } else {
              vehicle.progress = Math.max(END_MARGIN, vehicle.lane.length - pool.metrics.depth / 2 - 0.5)
              vehicle.speed = 0; vehicle.ended = true
            }
          }
        }
        if (vehicle.speed < 0.25) { vehicle.stoppedTime += elapsed; diagnostics.stoppedTime += elapsed }
        const next = sampleLane(vehicle.lane, vehicle.progress, vehicle.laneBias + vehicle.pullIn)
        vehicle.x = next.x; vehicle.z = next.z; vehicle.tx = next.tx; vehicle.tz = next.tz
      }
      render()
    },
  }
}
