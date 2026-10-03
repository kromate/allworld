import * as THREE from 'three'
import type { District, Ground, Road } from '../geo/district.ts'
import type { Vec2 } from '../shared/geo.ts'
import { pointInPolygon } from './nav.ts'
import type { StreetNavigator } from './nav.ts'
import { createFacadeDetailSystem } from './facadeDetails.ts'
import type { FacadeStyle } from './facadeStyles.ts'
import { createVegetationGeometrySet } from './vegetationStyles.ts'
import { loadPack } from './packs.ts'

type DetailQuality = 'low' | 'medium' | 'high'

interface DetailBudget {
  radius: number
  step: number
  trees: number
  lamps: number
  benches: number
  bins: number
}

const BUDGETS: Record<DetailQuality, DetailBudget> = {
  low: { radius: 135, step: 34, trees: 72, lamps: 26, benches: 12, bins: 14 },
  medium: { radius: 220, step: 48, trees: 150, lamps: 54, benches: 24, bins: 30 },
  high: { radius: 310, step: 62, trees: 240, lamps: 88, benches: 42, bins: 48 },
}

const MAX = BUDGETS.high

interface FixtureSpot {
  pos: Vec2
  angle: number
  tone: number
}

export interface StreetDetailStats {
  quality: DetailQuality
  generation: number
  focus: Vec2
  refreshMs: number
  triangles: number
  trees: number
  windows: number
  doors: number
  shopfronts: number
  frontageDetails: number
  lamps: number
  furniture: number
  foliage: { status: 'loading' | 'ready' | 'failed'; error: string | null }
  pools: { trees: number; windows: number; doors: number; shopfronts: number; frontageDetails: number; lamps: number; furniture: number }
}

export interface StreetDetailStream {
  group: THREE.Group
  stats: StreetDetailStats
  setNight(amount: number): void
  setQuality(quality: DetailQuality): void
  update(position: Vec2): void
  dispose(): void
}

function hash(a: number, b: number, c = 0): number {
  let value = Math.imul(Math.round(a * 7.1), 73_856_093) ^ Math.imul(Math.round(b * 7.1), 19_349_663) ^ Math.imul(c + 1, 83_492_791)
  value = Math.imul(value ^ (value >>> 13), 0x5bd1e995)
  return (value ^ (value >>> 15)) >>> 0
}

function unit(seed: number): number {
  let value = seed >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return ((value ^ (value >>> 15)) >>> 0) / 4_294_967_296
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  // Instance colours are separate; absent vertex colours default to black.
  if (!geometry.hasAttribute('color')) material.vertexColors = false
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = name
  mesh.count = 0
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  return mesh
}

function segmentDistance(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dz = b.z - a.z
  const length2 = dx * dx + dz * dz
  if (length2 === 0) return Math.hypot(point.x - a.x, point.z - a.z)
  const along = THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / length2, 0, 1)
  return Math.hypot(point.x - (a.x + dx * along), point.z - (a.z + dz * along))
}

function roadSpots(
  roads: Road[], focus: Vec2, radius: number, limit: number,
  accepts: (road: Road) => boolean, spacingOf: (road: Road) => number, offsetOf: (road: Road) => number,
): FixtureSpot[] {
  const spots: FixtureSpot[] = []
  for (let roadIndex = 0; roadIndex < roads.length && spots.length < limit; roadIndex++) {
    const road = roads[roadIndex]!
    if (road.tunnel || !accepts(road)) continue
    for (let index = 0; index < road.points.length - 1 && spots.length < limit; index++) {
      const a = road.points[index]!, b = road.points[index + 1]!
      if (segmentDistance(focus, a, b) > radius + 16) continue
      const length = Math.hypot(b.x - a.x, b.z - a.z)
      if (length < 8) continue
      const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length
      const seed = hash(a.x, a.z, roadIndex * 31 + index)
      const spacing = spacingOf(road)
      const first = Math.min(length * 0.5, 7 + unit(seed) * spacing * 0.65)
      for (let along = first; along < length - 4 && spots.length < limit; along += spacing) {
        const tone = unit(seed + Math.floor(along) * 13)
        const side = tone < 0.5 ? -1 : 1
        const offset = offsetOf(road) * side
        const pos = { x: a.x + ux * along - uz * offset, z: a.z + uz * along + ux * offset }
        if (Math.hypot(pos.x - focus.x, pos.z - focus.z) > radius) continue
        spots.push({ pos, angle: Math.atan2(ux, uz), tone })
      }
    }
  }
  return spots
}

function vegetationSpots(district: District, navigator: StreetNavigator, focus: Vec2, radius: number, limit: number): FixtureSpot[] {
  const spots = roadSpots(
    district.roads, focus, radius, limit,
    road => road.kind === 'street' || road.kind === 'major',
    road => road.kind === 'major' ? 39 : 48,
    road => road.width / 2 + 2.7,
  ).filter(spot => navigator.walkable(spot.pos))
  const density: Partial<Record<Ground['kind'], number>> = { wood: 13, park: 21, grass: 34 }
  for (let groundIndex = 0; groundIndex < district.ground.length && spots.length < limit; groundIndex++) {
    const ground = district.ground[groundIndex]!
    const spacing = density[ground.kind]
    if (!spacing) continue
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const point of ground.outer) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z)
    }
    minX = Math.max(minX, focus.x - radius); maxX = Math.min(maxX, focus.x + radius)
    minZ = Math.max(minZ, focus.z - radius); maxZ = Math.min(maxZ, focus.z + radius)
    if (minX > maxX || minZ > maxZ) continue
    const fromX = Math.floor(minX / spacing), toX = Math.ceil(maxX / spacing)
    const fromZ = Math.floor(minZ / spacing), toZ = Math.ceil(maxZ / spacing)
    for (let cellX = fromX; cellX <= toX && spots.length < limit; cellX++) {
      for (let cellZ = fromZ; cellZ <= toZ && spots.length < limit; cellZ++) {
        const seed = hash(cellX, cellZ, groundIndex)
        const pos = {
          x: (cellX + 0.18 + unit(seed) * 0.64) * spacing,
          z: (cellZ + 0.18 + unit(seed + 1) * 0.64) * spacing,
        }
        if (Math.hypot(pos.x - focus.x, pos.z - focus.z) > radius || !pointInPolygon(pos, ground) || !navigator.walkable(pos)) continue
        if (spots.some(spot => Math.hypot(spot.pos.x - pos.x, spot.pos.z - pos.z) < 6)) continue
        spots.push({ pos, angle: unit(seed + 2) * Math.PI * 2, tone: unit(seed + 3) })
      }
    }
  }
  return spots
}

function setTransform(
  mesh: THREE.InstancedMesh, index: number, position: THREE.Vector3, angle: number, scale: THREE.Vector3,
  matrix: THREE.Matrix4, quaternion: THREE.Quaternion,
): void {
  quaternion.setFromEuler(new THREE.Euler(0, angle, 0))
  matrix.compose(position, quaternion, scale)
  mesh.setMatrixAt(index, matrix)
}

function finish(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count
  mesh.visible = count > 0
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

function meshTriangles(mesh: THREE.InstancedMesh): number {
  const vertices = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0
  return vertices / 3 * mesh.count
}

function packedFoliageTexture(): {
  texture: THREE.Texture
  state: StreetDetailStats['foliage']
  ready: Promise<boolean>
} {
  const texture = new THREE.Texture()
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const state: StreetDetailStats['foliage'] = { status: 'loading', error: null }
  let disposed = false
  const ready = loadPack('/packs/vegetation.pack.gz').then(async pack => {
    const entry = pack.entries.get('tree-small-02-leaves-512.png')
    if (!entry) throw new Error('Missing packed vegetation texture tree-small-02-leaves-512.png')
    const bytes = Uint8Array.from(pack.bytes.slice(pack.base + entry.offset, pack.base + entry.offset + entry.length))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { imageOrientation: 'flipY', colorSpaceConversion: 'none' })
    if (disposed) { bitmap.close(); return false }
    texture.image = bitmap
    texture.needsUpdate = true
    state.status = 'ready'
    return true
  }).catch((error: unknown) => {
    state.status = 'failed'
    state.error = error instanceof Error ? error.message : String(error)
    return false
  })
  texture.addEventListener('dispose', () => {
    disposed = true
    const image: unknown = texture.image
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
  })
  return { texture, state, ready }
}

function lampPoolTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,214,132,0.72)')
  gradient.addColorStop(0.38, 'rgba(255,188,92,0.28)')
  gradient.addColorStop(1, 'rgba(255,170,70,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function createStreetDetailStream(
  district: District,
  navigator: StreetNavigator,
  initialPosition: Vec2,
  initialQuality: DetailQuality,
  colourOf: (category: string) => string,
  facadeStyle: FacadeStyle,
): StreetDetailStream {
  const group = new THREE.Group()
  group.name = 'moving street detail'
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion()

  const facadeDetails = createFacadeDetailSystem(district, facadeStyle, colourOf)
  group.add(facadeDetails.group)
  const vegetation = createVegetationGeometrySet(facadeStyle.vegetation)
  const foliage = packedFoliageTexture()
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#76513b', roughness: 0.98 })
  const broadTint = new THREE.Color(vegetation.broadColour).lerp(new THREE.Color('#ffffff'), 0.58)
  const broadMaterial = new THREE.MeshStandardMaterial({ map: foliage.texture, color: broadTint, alphaTest: 0.52, side: THREE.DoubleSide, roughness: 0.92 })
  const palmMaterial = new THREE.MeshStandardMaterial({ color: vegetation.palmColour, roughness: 0.92, side: THREE.DoubleSide })
  const broadTrunks = instanced(vegetation.broadTrunk, trunkMaterial, MAX.trees, 'regional broad tree trunks')
  const broadCrowns = instanced(vegetation.broadCrown, broadMaterial, MAX.trees, 'regional broad tree crowns')
  const palmTrunks = instanced(vegetation.palmTrunk, trunkMaterial, MAX.trees, 'regional palm trunks')
  const palmCrowns = instanced(vegetation.palmCrown, palmMaterial, MAX.trees, 'regional palm crowns')
  broadCrowns.visible = false
  void foliage.ready.then(ready => { broadCrowns.visible = ready && broadCrowns.count > 0 })

  const metal = new THREE.MeshStandardMaterial({ color: '#333b40', roughness: 0.5, metalness: 0.42 })
  const bulbMaterial = new THREE.MeshStandardMaterial({ color: '#fff2c9', emissive: '#ffc864', emissiveIntensity: 0 })
  const lampPoles = instanced(new THREE.CylinderGeometry(0.065, 0.095, 4.8, 7).translate(0, 2.4, 0), metal, MAX.lamps, 'lamp poles')
  const lampHeads = instanced(new THREE.SphereGeometry(0.27, 10, 7).translate(0, 4.98, 0), bulbMaterial, MAX.lamps, 'lamp bulbs')
  const poolTexture = lampPoolTexture()
  const poolMaterial = new THREE.MeshBasicMaterial({ map: poolTexture, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
  const lampPools = instanced(new THREE.PlaneGeometry(7.5, 7.5).rotateX(-Math.PI / 2), poolMaterial, MAX.lamps, 'soft lamp ground pools')
  lampPools.renderOrder = 2
  lampPools.visible = false

  const wood = new THREE.MeshStandardMaterial({ color: '#735038', roughness: 0.86 })
  const benchSeats = instanced(new THREE.BoxGeometry(1.9, 0.12, 0.5), wood, MAX.benches, 'bench seats')
  const benchBacks = instanced(new THREE.BoxGeometry(1.9, 0.56, 0.1), wood, MAX.benches, 'bench backs')
  const benchFrames = instanced(new THREE.BoxGeometry(1.5, 0.48, 0.1), metal, MAX.benches, 'bench frames')
  const bins = instanced(new THREE.CylinderGeometry(0.29, 0.32, 0.84, 10), metal, MAX.bins, 'street bins')

  const meshes = [
    broadTrunks, broadCrowns, palmTrunks, palmCrowns,
    lampPoles, lampHeads, lampPools, benchSeats, benchBacks, benchFrames, bins,
  ]
  for (const mesh of meshes) group.add(mesh)

  const stats: StreetDetailStats = {
    quality: initialQuality,
    generation: 0,
    focus: { ...initialPosition },
    refreshMs: 0,
    triangles: 0,
    trees: 0,
    windows: 0,
    doors: 0,
    shopfronts: 0,
    frontageDetails: 0,
    lamps: 0,
    furniture: 0,
    foliage: foliage.state,
    pools: { trees: 0, windows: 0, doors: 0, shopfronts: 0, frontageDetails: 0, lamps: 0, furniture: 0 },
  }
  let quality = initialQuality
  let position = { x: initialPosition.x, z: initialPosition.z }
  let force = true
  let night = 0

  const updateTrees = (budget: DetailBudget): void => {
    const spots = vegetationSpots(district, navigator, position, budget.radius, budget.trees)
    let broadCount = 0, palmCount = 0
    for (const spot of spots) {
      const scale = 0.82 + spot.tone * 0.54
      if (unit(hash(spot.pos.x, spot.pos.z, 307)) < vegetation.palmRate) {
        setTransform(palmTrunks, palmCount, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(scale, scale, scale), matrix, quaternion)
        setTransform(palmCrowns, palmCount, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(scale, scale, scale), matrix, quaternion)
        palmCount++
      } else {
        setTransform(broadTrunks, broadCount, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(scale, scale, scale), matrix, quaternion)
        setTransform(broadCrowns, broadCount, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(scale, scale * (0.92 + spot.tone * 0.12), scale), matrix, quaternion)
        broadCount++
      }
    }
    finish(broadTrunks, broadCount); finish(broadCrowns, broadCount); finish(palmTrunks, palmCount); finish(palmCrowns, palmCount)
    broadCrowns.visible = broadCount > 0 && foliage.state.status === 'ready'
    stats.trees = spots.length
  }

  const updateFixtures = (budget: DetailBudget): void => {
    const lamps = roadSpots(
      district.roads, position, budget.radius, budget.lamps,
      road => road.kind === 'major' || road.kind === 'street',
      road => road.kind === 'major' ? 48 : 68,
      road => road.width / 2 + 1.25,
    ).filter(spot => navigator.walkable(spot.pos))
    lamps.forEach((spot, index) => {
      setTransform(lampPoles, index, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion)
      setTransform(lampHeads, index, new THREE.Vector3(spot.pos.x, 0, spot.pos.z), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion)
      setTransform(lampPools, index, new THREE.Vector3(spot.pos.x, 0.13, spot.pos.z), 0, new THREE.Vector3(1, 1, 1), matrix, quaternion)
    })
    finish(lampPoles, lamps.length); finish(lampHeads, lamps.length); finish(lampPools, lamps.length)
    lampPools.visible = lamps.length > 0 && night > 0.05

    const benches = roadSpots(
      district.roads, position, budget.radius, budget.benches,
      road => road.kind === 'path' || road.kind === 'pedestrian',
      () => 52,
      road => road.width / 2 + 1.2,
    ).filter(spot => navigator.walkable(spot.pos))
    benches.forEach((spot, index) => {
      setTransform(benchSeats, index, new THREE.Vector3(spot.pos.x, 0.55, spot.pos.z), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion)
      setTransform(benchBacks, index, new THREE.Vector3(spot.pos.x - Math.sin(spot.angle) * 0.22, 0.88, spot.pos.z - Math.cos(spot.angle) * 0.22), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion)
      setTransform(benchFrames, index, new THREE.Vector3(spot.pos.x, 0.3, spot.pos.z), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion)
    })
    finish(benchSeats, benches.length); finish(benchBacks, benches.length); finish(benchFrames, benches.length)

    const binSpots = roadSpots(
      district.roads, position, budget.radius, budget.bins,
      road => road.kind === 'street' || road.kind === 'service' || road.kind === 'pedestrian',
      () => 112,
      road => road.width / 2 + 1.35,
    ).filter(spot => navigator.walkable(spot.pos))
    binSpots.forEach((spot, index) => setTransform(bins, index, new THREE.Vector3(spot.pos.x, 0.46, spot.pos.z), spot.angle, new THREE.Vector3(1, 1, 1), matrix, quaternion))
    finish(bins, binSpots.length)

    stats.lamps = lamps.length
    stats.furniture = benches.length + binSpots.length
  }

  const rebuild = (): void => {
    const started = performance.now()
    const budget = BUDGETS[quality]
    facadeDetails.update(position, quality)
    stats.windows = facadeDetails.stats.windows
    stats.doors = facadeDetails.stats.doors
    stats.shopfronts = facadeDetails.stats.shopfronts
    stats.frontageDetails = facadeDetails.stats.frontageDetails
    updateTrees(budget)
    updateFixtures(budget)
    broadTrunks.castShadow = broadCrowns.castShadow = palmTrunks.castShadow = palmCrowns.castShadow = quality !== 'low'
    lampPoles.castShadow = benchSeats.castShadow = quality === 'high'
    stats.triangles = Math.round(meshes.reduce((sum, mesh) => sum + meshTriangles(mesh), 0) + facadeDetails.stats.triangles)
    stats.quality = quality
    stats.generation++
    stats.focus = { ...position }
    stats.refreshMs = performance.now() - started
    Object.assign(stats.pools, {
      trees: stats.trees,
      windows: stats.windows,
      doors: stats.doors,
      shopfronts: stats.shopfronts,
      frontageDetails: stats.frontageDetails,
      lamps: stats.lamps,
      furniture: stats.furniture,
    })
    force = false
  }

  const stream: StreetDetailStream = {
    group,
    stats,
    setNight(amount) {
      const next = THREE.MathUtils.clamp(amount, 0, 1)
      const changedBand = (next > 0.45) !== (night > 0.45)
      night = next
      facadeDetails.setNight(night)
      bulbMaterial.emissiveIntensity = night * 2.8
      poolMaterial.opacity = night * 0.32
      lampPools.visible = night > 0.05
      if (changedBand) { force = true; rebuild() }
    },
    setQuality(nextQuality) {
      if (quality === nextQuality) return
      quality = nextQuality
      force = true
      rebuild()
    },
    update(nextPosition) {
      const budget = BUDGETS[quality]
      if (!force && Math.hypot(nextPosition.x - position.x, nextPosition.z - position.z) < budget.step) return
      position = { x: nextPosition.x, z: nextPosition.z }
      rebuild()
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      for (const mesh of meshes) {
        geometries.add(mesh.geometry)
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        list.forEach(material => materials.add(material))
      }
      geometries.forEach(geometry => geometry.dispose())
      materials.forEach(material => material.dispose())
      facadeDetails.dispose()
      foliage.texture.dispose()
      poolTexture.dispose()
      group.removeFromParent()
    },
  }
  stream.update(initialPosition)
  return stream
}
