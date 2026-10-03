import * as THREE from 'three'
import type { District } from '../../geo/district.ts'
import type { AvatarLook } from '../../shared/model.ts'
import type { Vec2 } from '../../shared/geo.ts'
import { moveFoot, PERSON_RADIUS } from '../../shared/worldCollision.ts'
import type { FootObstacleGrid } from '../../shared/worldCollision.ts'
import { AvatarActor } from '../avatars.ts'
import type { StreetNavigator } from '../nav.ts'
import { arrivalDirection } from './placement.ts'

export interface StreetLifePlacement {
  model: string
  pos: Vec2
  angle: number
  seed: number
}

export interface StreetLifeInput {
  district: District
  navigator: StreetNavigator
  placements: readonly StreetLifePlacement[]
  quality: 'low' | 'medium' | 'high'
  countryCode: string
  hour: number
  focus: Vec2
  enabled: boolean
  maxActors?: number
}

type StreetRole = 'trader' | 'vendor' | 'passenger' | 'mechanic' | 'walker'

interface StationaryCandidate {
  kind: 'stationary'
  id: string
  role: Exclude<StreetRole, 'walker'>
  pos: Vec2
  angle: number
  seed: number
}

interface WalkingCandidate {
  kind: 'walking'
  id: string
  role: 'walker'
  pos: Vec2
  from: Vec2
  to: Vec2
  seed: number
}

type Candidate = StationaryCandidate | WalkingCandidate

interface WalkingState {
  from: Vec2
  to: Vec2
  progress: number
  direction: -1 | 1
  speed: number
}

interface LiveActor {
  candidate: Candidate
  actor: AvatarActor
  walking: WalkingState | null
  accumulator: number
  updateHz: number
  yielding: boolean
}

interface PendingActor {
  candidate: Candidate
  actor: AvatarActor
}

export interface StreetLifeDiagnostics {
  supported: boolean
  enabled: boolean
  active: boolean
  district: string
  countryCode: string
  hour: number
  cap: number
  candidates: number
  nearby: number
  pending: number
  ready: number
  failedLoads: number
  reselections: number
  playerYields: number
  bodies: readonly ['f11', 'm12']
  outfits: readonly ['wax-ochre', 'kaftan-sand']
  roles: Record<StreetRole, number>
  positions: { role: StreetRole; x: number; z: number; moving: boolean }[]
  visibleArrival: number
  visibleArrivalRoles: Record<StreetRole, number>
  movement: { walkers: number; yielding: number; staticHz: string; walkerHz: number }
  schoolchildGap: string
}

export interface StreetLife {
  root: THREE.Group
  update(dt: number, player: Vec2, active?: boolean, obstacles?: FootObstacleGrid<string>): void
  positions(): Vec2[]
  setActive(active: boolean): void
  dispose(): void
  stats: { instances: number; triangles: number; textureBytes: number }
  diagnostics: StreetLifeDiagnostics
}

const QUALITY_CAP = { low: 2, medium: 4, high: 5 } satisfies Record<StreetLifeInput['quality'], number>
const LOAD_RADIUS = 35
const RESELECT_DISTANCE = 15
const ARRIVAL_VISIBLE_NEAR = 12
const ARRIVAL_VISIBLE_RADIUS = 35
const PLAYER_CLEARANCE = 1.45
const ACTOR_Y = 0.08
const ROAD_SIDES: readonly (-1 | 1)[] = [-1, 1]
const LOOKS = [
  { body: 'f11', skin: null, outfitHue: 0, height: 1, outfit: 'wax-ochre', face: null },
  { body: 'm12', skin: null, outfitHue: 0, height: 1, outfit: 'kaftan-sand', face: null },
] satisfies readonly AvatarLook[]

const PROP_SIZE: Readonly<Record<string, { width: number; depth: number }>> = {
  stall: { width: 3.4, depth: 3.4 }, 'stall-red': { width: 3.4, depth: 3.4 }, 'stall-green': { width: 3.4, depth: 3.4 },
  food: { width: 2.15, depth: .85 }, kiosk: { width: 3.05, depth: 2.227 }, 'container-shop': { width: 3.9, depth: 3.369 },
  'pos-kiosk': { width: 1.52, depth: 1.655 }, vulcanizer: { width: 3.05, depth: 1.823 }, tyres: { width: 2.269, depth: 1.072 },
  'produce-goods': { width: 2.71, depth: 1.148 }, 'shop-goods': { width: 3.09, depth: .92 }, shelter: { width: 3.65, depth: 1.35 },
  gate: { width: 7.6, depth: .552 }, danfo: { width: 2.2, depth: 4.28 }, bus: { width: 2.755, depth: 7.55 },
  car: { width: 2.099, depth: 4.09 }, keke: { width: 1.605, depth: 2.59 }, okada: { width: .84, depth: 2.67 },
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function hash(a: number, b: number, c: number): number {
  let value = Math.imul(Math.round(a * 5.3), 73_856_093) ^ Math.imul(Math.round(b * 5.3), 19_349_663) ^ Math.imul(c + 1, 83_492_791)
  value = Math.imul(value ^ (value >>> 13), 0x5bd1e995)
  return (value ^ (value >>> 15)) >>> 0
}

function rotatedOffset(placement: StreetLifePlacement, x: number, z: number): Vec2 {
  const sin = Math.sin(placement.angle), cos = Math.cos(placement.angle)
  return { x: placement.pos.x + x * cos + z * sin, z: placement.pos.z - x * sin + z * cos }
}

function stationaryRole(model: string): Exclude<StreetRole, 'walker'> | null {
  if (model === 'food') return 'vendor'
  if (model === 'vulcanizer' || model === 'tyres') return 'mechanic'
  if (model === 'shelter') return 'passenger'
  if (['stall', 'stall-red', 'stall-green', 'container-shop', 'kiosk', 'pos-kiosk', 'produce-goods', 'shop-goods'].includes(model)) return 'trader'
  return null
}

function actorOffset(model: string, copy: number): { x: number; z: number } {
  if (model === 'food') return { x: 0.54, z: -0.52 }
  if (model === 'vulcanizer') return { x: 0.65, z: 0.22 }
  if (model === 'tyres') return { x: 0.58, z: 0.18 }
  if (model === 'shelter') return { x: copy ? 0.7 : -0.7, z: 0.22 }
  if (model === 'container-shop') return { x: 0.25, z: 0.62 }
  if (model === 'kiosk') return { x: 0, z: 0.34 }
  if (model === 'pos-kiosk') return { x: 0, z: 0.18 }
  if (model === 'produce-goods' || model === 'shop-goods') return { x: 0, z: -0.72 }
  return { x: 0, z: -0.64 }
}

function safeStandingPoint(point: Vec2, navigator: StreetNavigator): Vec2 | null {
  if (navigator.walkable(point)) return point
  return navigator.nearestWalkable(point, 3)
}

function stationaryCandidates(placements: readonly StreetLifePlacement[], navigator: StreetNavigator): StationaryCandidate[] {
  const candidates: StationaryCandidate[] = []
  placements.forEach((placement, index) => {
    const role = stationaryRole(placement.model)
    if (!role) return
    const copies = placement.model === 'shelter' ? 2 : 1
    for (let copy = 0; copy < copies; copy++) {
      const offset = actorOffset(placement.model, copy)
      const pos = safeStandingPoint(rotatedOffset(placement, offset.x, offset.z), navigator)
      if (!pos) continue
      candidates.push({
        kind: 'stationary', id: `prop:${index}:${placement.seed}:${copy}`, role, pos,
        angle: placement.angle, seed: placement.seed + copy * 97,
      })
    }
  })
  return candidates
}

function clearOfProps(point: Vec2, placements: readonly StreetLifePlacement[]): boolean {
  return placements.every(placement => {
    const size = PROP_SIZE[placement.model] ?? { width: 1.4, depth: 1.4 }
    const dx = point.x - placement.pos.x, dz = point.z - placement.pos.z
    const sin = Math.sin(placement.angle), cos = Math.cos(placement.angle)
    const localX = dx * cos - dz * sin, localZ = dx * sin + dz * cos
    return Math.abs(localX) > size.width / 2 + .28 || Math.abs(localZ) > size.depth / 2 + .28
  })
}

function walkingCandidates(input: StreetLifeInput, focus: Vec2, arrival: { pos: Vec2; x: number; z: number }): WalkingCandidate[] {
  const proposals: { roadIndex: number; segment: number; sample: number; side: -1 | 1; band: number; seed: number; from: Vec2; to: Vec2; distance: number; arrivalVisible: boolean }[] = []
  const nearArrival = distance(focus, arrival.pos) <= LOAD_RADIUS
  for (let roadIndex = 0; roadIndex < input.district.roads.length; roadIndex++) {
    const road = input.district.roads[roadIndex]!
    if (road.tunnel || road.kind === 'motorway' || road.kind === 'rail') continue
    for (let segment = 0; segment < road.points.length - 1; segment++) {
      const a = road.points[segment]!, b = road.points[segment + 1]!
      const length = distance(a, b)
      if (length < 5) continue
      const seed = hash(a.x, a.z, roadIndex * 71 + segment)
      const tx = (b.x - a.x) / length, tz = (b.z - a.z) / length
      const projected = THREE.MathUtils.clamp((focus.x - a.x) * tx + (focus.z - a.z) * tz, 0, length)
      const projectedPoint = { x: a.x + tx * projected, z: a.z + tz * projected }
      if (distance(projectedPoint, focus) > 100) continue
      const first = Math.max(1, Math.ceil((projected - 100) / 6))
      const last = Math.min(Math.floor((length - 2) / 6), Math.floor((projected + 100) / 6))
      for (let sample = first; sample <= last; sample++) for (const side of ROAD_SIDES) for (const [band, verge] of [.45, .65, .85].entries()) {
          const along = sample * 6, offset = (road.width / 2 + verge) * side
          const middle = { x: a.x + tx * along - tz * offset, z: a.z + tz * along + tx * offset }
          const fromFocus = distance(middle, focus)
          if (fromFocus > 100) continue
          const half = Math.min(1.8, along - .5, length - along - .5)
          if (half < 1.1) continue
          const from = { x: middle.x - tx * half, z: middle.z - tz * half }
          const to = { x: middle.x + tx * half, z: middle.z + tz * half }
          proposals.push({
            roadIndex, segment, sample, side, band, seed: hash(seed, side, sample * 7 + band), distance: fromFocus,
            from, to, arrivalVisible: nearArrival && visibleAtArrival(from, arrival) && visibleAtArrival(to, arrival),
          })
        }
    }
  }
  proposals.sort((a, b) => Number(b.arrivalVisible) - Number(a.arrivalVisible) || a.distance - b.distance || a.band - b.band || a.roadIndex - b.roadIndex || a.segment - b.segment || a.sample - b.sample || a.side - b.side)
  const candidates: WalkingCandidate[] = []
  for (const proposal of proposals) {
    if (candidates.length >= 64) break
    const { roadIndex, segment, sample, side, band, seed, from, to } = proposal
    const steps = Math.max(2, Math.ceil(distance(from, to) / .35))
    const safe = Array.from({ length: steps + 1 }, (_, index) => index / steps).every(amount => {
      const point = { x: from.x + (to.x - from.x) * amount, z: from.z + (to.z - from.z) * amount }
      return input.navigator.standable(point) && clearOfProps(point, input.placements)
    })
    if (!safe) continue
    const middle = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
    candidates.push({ kind: 'walking', id: `walk:${roadIndex}:${segment}:${sample}:${side}:${band}`, role: 'walker', pos: middle, from, to, seed })
  }
  return candidates
}

function emptyRoles(): Record<StreetRole, number> {
  return { trader: 0, vendor: 0, passenger: 0, mechanic: 0, walker: 0 }
}

function visibleAtArrival(pos: Vec2, arrival: { pos: Vec2; x: number; z: number }): boolean {
  const dx = pos.x - arrival.pos.x, dz = pos.z - arrival.pos.z
  const range = Math.hypot(dx, dz), forward = dx * arrival.x + dz * arrival.z
  const lateral = Math.abs(dx * arrival.z - dz * arrival.x)
  return range >= ARRIVAL_VISIBLE_NEAR && range <= ARRIVAL_VISIBLE_RADIUS
    && forward > 8 && lateral <= (forward + 4.5) * .23
}

function candidateVisibleAtArrival(candidate: Candidate, arrival: { pos: Vec2; x: number; z: number }): boolean {
  return candidate.kind === 'walking'
    ? visibleAtArrival(candidate.from, arrival) && visibleAtArrival(candidate.to, arrival)
    : visibleAtArrival(candidate.pos, arrival)
}

function makeDiagnostics(input: StreetLifeInput, supported: boolean, cap: number): StreetLifeDiagnostics {
  return {
    supported, enabled: input.enabled, active: input.enabled, district: String(input.district.id),
    countryCode: input.countryCode, hour: input.hour, cap, candidates: 0, nearby: 0,
    pending: 0, ready: 0, failedLoads: 0, reselections: 0, playerYields: 0,
    bodies: ['f11', 'm12'], outfits: ['wax-ochre', 'kaftan-sand'], roles: emptyRoles(), positions: [],
    visibleArrival: 0, visibleArrivalRoles: emptyRoles(),
    movement: { walkers: 0, yielding: 0, staticHz: '2-5', walkerHz: 12 },
    schoolchildGap: 'No child cast or child rig is available; this system intentionally renders adults only.',
  }
}

function emptyStreetLife(input: StreetLifeInput, supported: boolean): StreetLife {
  const root = new THREE.Group()
  root.name = 'street-life:empty'
  root.visible = false
  const stats = { instances: 0, triangles: 0, textureBytes: 0 }
  const diagnostics = makeDiagnostics(input, supported, 0)
  return {
    root, stats, diagnostics,
    update() {}, positions: () => [],
    setActive(active) { diagnostics.active = active },
    dispose() { root.removeFromParent(); root.clear() },
  }
}

function triangleCount(root: THREE.Object3D): number {
  let triangles = 0
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return
    const geometry = object.geometry
    triangles += (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3
  })
  return triangles
}

function sharedTextureBytes(actors: Iterable<LiveActor>): number {
  const textures = new Set<THREE.Texture>()
  for (const live of actors) live.actor.group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
  })
  let bytes = 0
  for (const texture of textures) {
    const image: unknown = texture.image
    if (typeof image !== 'object' || image === null || !('width' in image) || !('height' in image)) continue
    if (typeof image.width !== 'number' || typeof image.height !== 'number') continue
    bytes += image.width * image.height * 4 * 4 / 3
  }
  return Math.ceil(bytes)
}

function disablePicking(root: THREE.Object3D): void {
  root.traverse(object => {
    if (object instanceof THREE.Mesh) object.raycast = () => {}
  })
}

function rolePriority(role: StreetRole): number {
  if (role === 'vendor') return 0
  if (role === 'mechanic') return 1
  if (role === 'trader') return 2
  if (role === 'passenger') return 3
  return 4
}

/** Lightweight ambient adults. They are scenery, never members or social/contact participants. */
export async function createStreetLife(input: StreetLifeInput): Promise<StreetLife> {
  const supported = input.countryCode.trim().toUpperCase() === 'NG'
  if (!input.enabled || !supported) return emptyStreetLife(input, supported)

  const cap = Math.min(QUALITY_CAP[input.quality], Math.max(1, input.maxActors ?? 99))
  const root = new THREE.Group()
  root.name = 'street-life'
  const stats = { instances: 0, triangles: 0, textureBytes: 0 }
  const diagnostics = makeDiagnostics(input, true, cap)
  const arrival = arrivalDirection(input.district)
  const stationary = stationaryCandidates(input.placements, input.navigator)
  let candidates: Candidate[] = stationary
  const ready = new Map<string, LiveActor>()
  const pending = new Map<string, PendingActor>()
  const failed = new Set<string>()
  const disposedActors = new Set<AvatarActor>()
  let wanted = new Set<string>()
  let disposed = false
  let active = true
  let lastSelection = { ...input.focus }
  let statsClock = 0

  const disposeActor = (actor: AvatarActor): void => {
    if (disposedActors.has(actor)) return
    disposedActors.add(actor)
    actor.dispose()
  }

  const updateStats = (): void => {
    stats.instances = ready.size
    stats.triangles = 0
    for (const live of ready.values()) stats.triangles += triangleCount(live.actor.group)
    stats.textureBytes = sharedTextureBytes(ready.values())
    diagnostics.pending = pending.size
    diagnostics.ready = ready.size
    diagnostics.roles = emptyRoles()
    diagnostics.visibleArrival = 0
    diagnostics.visibleArrivalRoles = emptyRoles()
    diagnostics.movement.walkers = 0
    diagnostics.movement.yielding = 0
    diagnostics.positions = []
    for (const live of ready.values()) {
      diagnostics.roles[live.candidate.role]++
      if (visibleAtArrival({ x: live.actor.group.position.x, z: live.actor.group.position.z }, arrival)) {
        diagnostics.visibleArrival++
        diagnostics.visibleArrivalRoles[live.candidate.role]++
      }
      if (live.walking) diagnostics.movement.walkers++
      if (live.yielding) diagnostics.movement.yielding++
      diagnostics.positions.push({
        role: live.candidate.role, x: live.actor.group.position.x, z: live.actor.group.position.z,
        moving: live.walking !== null,
      })
    }
  }

  const spawn = (candidate: Candidate): void => {
    const look = LOOKS[Math.abs(Math.trunc(candidate.seed)) % LOOKS.length]!
    const actor = new AvatarActor(look)
    actor.setDetail('reduced')
    pending.set(candidate.id, { candidate, actor })
    diagnostics.pending = pending.size
    void actor.ready.then(() => {
      if (disposed || pending.get(candidate.id)?.actor !== actor || !wanted.has(candidate.id)) {
        pending.delete(candidate.id)
        disposeActor(actor)
        updateStats()
        return
      }
      pending.delete(candidate.id)
      disablePicking(actor.group)
      actor.group.name = `street-life:${candidate.role}`
      actor.group.position.set(candidate.kind === 'walking' ? candidate.from.x : candidate.pos.x, ACTOR_Y, candidate.kind === 'walking' ? candidate.from.z : candidate.pos.z)
      let walking: WalkingState | null = null
      if (candidate.kind === 'walking') {
        walking = {
          from: candidate.from, to: candidate.to, progress: 0, direction: 1,
          speed: look.body === 'f11' ? 1.2946 : 1.4024,
        }
        actor.setMotion('walk')
        actor.setTravelSpeed(walking.speed)
        actor.group.rotation.y = Math.atan2(walking.to.x - walking.from.x, walking.to.z - walking.from.z)
      } else {
        const motion = candidate.role === 'passenger'
          ? (candidate.seed % 3 === 0 ? 'talk' : 'idle')
          : candidate.role === 'trader' && candidate.seed % 3 === 0 ? 'idle' : 'work'
        actor.setMotion(motion)
        actor.setTravelSpeed(null)
        actor.group.rotation.y = candidate.angle
      }
      ready.set(candidate.id, {
        candidate, actor, walking, accumulator: 0,
        updateHz: walking ? 12 : 2 + Math.abs(candidate.seed % 4), yielding: false,
      })
      root.add(actor.group)
      updateStats()
    }).catch(() => {
      if (pending.get(candidate.id)?.actor === actor) pending.delete(candidate.id)
      failed.add(candidate.id)
      diagnostics.failedLoads++
      disposeActor(actor)
      updateStats()
      if (!disposed) reconcile(lastSelection)
    })
  }

  const reconcile = (player: Vec2): void => {
    lastSelection = { ...player }
    diagnostics.reselections++
    candidates = [...stationary, ...walkingCandidates(input, player, arrival)]
    diagnostics.candidates = candidates.length
    const marketOpen = input.hour >= 5 && input.hour < 23
    const arrivalFocused = distance(player, arrival.pos) <= LOAD_RADIUS
    const nearby = candidates
      .filter(candidate => marketOpen || candidate.role === 'passenger' || candidate.role === 'walker')
      .map(candidate => ({ candidate, distance: distance(candidate.pos, player), arrivalVisible: candidateVisibleAtArrival(candidate, arrival) }))
      .filter(entry => entry.distance <= LOAD_RADIUS)
      .sort((a, b) => {
        const retainedA = ready.has(a.candidate.id) || pending.has(a.candidate.id) ? -2 : 0
        const retainedB = ready.has(b.candidate.id) || pending.has(b.candidate.id) ? -2 : 0
        const visibleA = arrivalFocused && a.arrivalVisible ? -30 : 0
        const visibleB = arrivalFocused && b.arrivalVisible ? -30 : 0
        return a.distance + rolePriority(a.candidate.role) * 0.3 + retainedA + visibleA
          - (b.distance + rolePriority(b.candidate.role) * 0.3 + retainedB + visibleB)
      })
    diagnostics.nearby = nearby.length
    const selectionCap = marketOpen ? cap : Math.min(2, cap)
    const selected: typeof nearby = []
    const selectRole = (role: StreetRole): void => {
      const visible = arrivalFocused ? nearby.find(entry => entry.candidate.role === role && entry.arrivalVisible && !selected.includes(entry)) : undefined
      const match = visible ?? nearby.find(entry => entry.candidate.role === role && !selected.includes(entry))
      if (match && selected.length < selectionCap) selected.push(match)
    }
    if (selectionCap >= 2) { selectRole('walker'); selectRole('trader') }
    if (selectionCap >= 3) selectRole('passenger')
    if (selectionCap >= 4) selectRole('vendor')
    if (selectionCap >= 5) selectRole('mechanic')
    for (const entry of nearby) {
      if (selected.length >= selectionCap) break
      if (!selected.includes(entry)) selected.push(entry)
    }
    wanted = new Set(selected.map(entry => entry.candidate.id))
    for (const [id, live] of ready) if (!wanted.has(id)) {
      ready.delete(id)
      disposeActor(live.actor)
    }
    for (const [id, loading] of pending) if (!wanted.has(id)) {
      pending.delete(id)
      disposeActor(loading.actor)
    }
    for (const { candidate } of selected) {
      if (ready.size + pending.size >= selectionCap) break
      if (!wanted.has(candidate.id) || ready.has(candidate.id) || pending.has(candidate.id) || failed.has(candidate.id)) continue
      spawn(candidate)
    }
    updateStats()
  }

  const updateWalking = (live: LiveActor, elapsed: number, player: Vec2, obstacles?: FootObstacleGrid<string>): void => {
    const walking = live.walking
    if (!walking) return
    const actor = live.actor
    if (distance({ x: actor.group.position.x, z: actor.group.position.z }, player) < PLAYER_CLEARANCE) {
      live.yielding = true
      actor.setMotion('idle')
      diagnostics.playerYields++
      return
    }
    live.yielding = false
    const length = distance(walking.from, walking.to)
    if (length <= 0) return
    const previousProgress = walking.progress
    walking.progress += walking.direction * walking.speed * elapsed / length
    if (walking.progress >= 1) { walking.progress = 1; walking.direction = -1 }
    else if (walking.progress <= 0) { walking.progress = 0; walking.direction = 1 }
    const next = {
      x: walking.from.x + (walking.to.x - walking.from.x) * walking.progress,
      z: walking.from.z + (walking.to.z - walking.from.z) * walking.progress,
    }
    const from = { x: actor.group.position.x, z: actor.group.position.z }
    const nearby = obstacles?.query(from, next).filter(entry => !entry.key.startsWith('scenery:')).map(entry => entry.obstacle) ?? []
    nearby.push({ kind: 'disc', pos: player, radius: PERSON_RADIUS })
    const safe = moveFoot(from, next, nearby, point => input.navigator.standable(point) && clearOfProps(point, input.placements))
    if (distance(safe, next) > .01) {
      walking.progress = previousProgress
      live.yielding = true
      actor.setMotion('idle'); actor.setTravelSpeed(0)
      return
    }
    if (!input.navigator.walkable(next) || !clearOfProps(next, input.placements)) {
      walking.direction = walking.direction === 1 ? -1 : 1
      actor.setMotion('idle')
      return
    }
    actor.group.position.set(next.x, ACTOR_Y, next.z)
    const direction = walking.direction
    actor.group.rotation.y = Math.atan2((walking.to.x - walking.from.x) * direction, (walking.to.z - walking.from.z) * direction)
    actor.setMotion('walk')
    actor.setTravelSpeed(walking.speed)
  }

  const setActive = (next: boolean): void => {
    active = next
    diagnostics.active = next
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    wanted.clear()
    for (const live of ready.values()) disposeActor(live.actor)
    for (const loading of pending.values()) disposeActor(loading.actor)
    ready.clear(); pending.clear()
    root.removeFromParent(); root.clear()
    updateStats()
  }

  reconcile(input.focus)

  return {
    root, stats, diagnostics, setActive, dispose,
    positions: () => [...ready.values()].filter(live => live.actor.group.visible).map(live => ({ x: live.actor.group.position.x, z: live.actor.group.position.z })),
    update(dt, player, frameActive = true, obstacles) {
      if (disposed || !active || !frameActive) return
      if (distance(player, lastSelection) >= RESELECT_DISTANCE) reconcile(player)
      const elapsed = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.12) : 0
      if (elapsed <= 0) return
      for (const live of ready.values()) {
        live.accumulator += elapsed
        if (live.accumulator < 1 / live.updateHz) continue
        const step = Math.min(.5, live.accumulator)
        live.accumulator = 0
        updateWalking(live, step, player)
        live.actor.update(step)
      }
      statsClock += elapsed
      if (statsClock >= 1) { statsClock = 0; updateStats() }
    },
  }
}
