import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Building, District, Poi } from '../geo/district.ts'
import type { Vec2 } from '../shared/geo.ts'
import { pointInPolygon } from './nav.ts'
import type { FacadeStyle } from './facadeStyles.ts'

export type FacadeDetailQuality = 'low' | 'medium' | 'high'

interface FacadeBudget {
  radius: number
  windows: number
  doors: number
  shopfronts: number
  balconies: number
  roofDetails: number
  signs: number
  frontagePanels: number
  cornices: number
}

const BUDGETS: Record<FacadeDetailQuality, FacadeBudget> = {
  low: { radius: 105, windows: 440, doors: 58, shopfronts: 18, balconies: 0, roofDetails: 12, signs: 14, frontagePanels: 48, cornices: 12 },
  medium: { radius: 170, windows: 1_150, doors: 125, shopfronts: 40, balconies: 38, roofDetails: 58, signs: 28, frontagePanels: 80, cornices: 20 },
  high: { radius: 245, windows: 2_100, doors: 220, shopfronts: 68, balconies: 76, roofDetails: 110, signs: 40, frontagePanels: 96, cornices: 24 },
}

const MAX = BUDGETS.high
const SHOPFRONT_CATEGORIES = new Set([
  'art_gallery', 'bakery', 'bank', 'bar', 'beer', 'cafe', 'cinema', 'clothing_store', 'fast_food', 'grocery', 'hairdresser',
  'lodging', 'mall', 'museum', 'music', 'office', 'pharmacy', 'post', 'restaurant', 'shop', 'theatre',
])

interface Edge {
  a: Vec2
  b: Vec2
  length: number
  ux: number
  uz: number
  nx: number
  nz: number
  angle: number
}

interface Shopfront {
  pos: Vec2
  edge: number
  width: number
  colour: string
  name: string
}

interface BuildingInfo {
  building: Building
  center: Vec2
  radius: number
  edges: Edge[]
  fronts: Shopfront[]
}

interface SignFixture {
  pos: Vec2
  edge: Edge
  width: number
  y: number
  name: string
  colour: string
}

interface EdgeBoxFixture {
  pos: THREE.Vector3
  angle: number
  scale: THREE.Vector3
  colour: string
}

export interface FacadeDetailStats {
  windows: number
  doors: number
  shopfronts: number
  signs: number
  balconies: number
  roofDetails: number
  compounds: number
  frontageDetails: number
  triangles: number
}

export interface FacadeDetailSystem {
  group: THREE.Group
  stats: FacadeDetailStats
  update(position: Vec2, quality: FacadeDetailQuality): void
  setNight(amount: number): void
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

function boundsOf(building: Building): { center: Vec2; radius: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const point of building.outer) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z)
  }
  return { center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }, radius: Math.hypot(maxX - minX, maxZ - minZ) / 2 }
}

function edgesOf(building: Building): Edge[] {
  let area = 0
  for (let index = 0; index < building.outer.length; index++) {
    const point = building.outer[index]!, next = building.outer[(index + 1) % building.outer.length]!
    area += point.x * next.z - next.x * point.z
  }
  const flip = area > 0 ? 1 : -1
  const edges: Edge[] = []
  for (let index = 0; index < building.outer.length; index++) {
    const a = building.outer[index]!, b = building.outer[(index + 1) % building.outer.length]!
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    if (length < 0.4) continue
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length
    const nx = flip * uz, nz = -flip * ux
    edges.push({ a, b, length, ux, uz, nx, nz, angle: Math.atan2(nx, nz) })
  }
  return edges
}

function nearestOnEdge(point: Vec2, edge: Edge): { pos: Vec2; distance: number; along: number } {
  const along = THREE.MathUtils.clamp((point.x - edge.a.x) * edge.ux + (point.z - edge.a.z) * edge.uz, 0, edge.length)
  const pos = { x: edge.a.x + edge.ux * along, z: edge.a.z + edge.uz * along }
  return { pos, distance: Math.hypot(point.x - pos.x, point.z - pos.z), along }
}

function nearestFacadeDistance(info: BuildingInfo, point: Vec2): number {
  return info.edges.reduce((distance, edge) => Math.min(distance, nearestOnEdge(point, edge).distance), Infinity)
}

function supportsRoofPoint(building: Building, point: Vec2, radius: number): boolean {
  const samples = [
    point,
    { x: point.x + radius, z: point.z }, { x: point.x - radius, z: point.z },
    { x: point.x, z: point.z + radius }, { x: point.x, z: point.z - radius },
    { x: point.x + radius * 0.7, z: point.z + radius * 0.7 }, { x: point.x - radius * 0.7, z: point.z + radius * 0.7 },
    { x: point.x + radius * 0.7, z: point.z - radius * 0.7 }, { x: point.x - radius * 0.7, z: point.z - radius * 0.7 },
  ]
  return samples.every(sample => pointInPolygon(sample, building))
}

function supportedRoofPoint(building: Building, preferred: Vec2, radius: number): Vec2 | null {
  if (supportsRoofPoint(building, preferred, radius)) return preferred
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const point of building.outer) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z)
  }
  const candidates: Vec2[] = []
  for (let xi = 1; xi < 7; xi++) for (let zi = 1; zi < 7; zi++) {
    candidates.push({ x: THREE.MathUtils.lerp(minX, maxX, xi / 7), z: THREE.MathUtils.lerp(minZ, maxZ, zi / 7) })
  }
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.z - preferred.z) - Math.hypot(b.x - preferred.x, b.z - preferred.z))
  return candidates.find(candidate => supportsRoofPoint(building, candidate, radius)) ?? null
}

function roofRectangleFits(building: Building, center: Vec2, angle: number, width: number, depth: number): boolean {
  const ux = Math.cos(angle), uz = -Math.sin(angle), nx = Math.sin(angle), nz = Math.cos(angle)
  for (const along of [-0.46, 0, 0.46]) for (const across of [-0.46, 0, 0.46]) {
    const point = {
      x: center.x + ux * width * along + nx * depth * across,
      z: center.z + uz * width * along + nz * depth * across,
    }
    if (!pointInPolygon(point, building)) return false
  }
  return true
}

const PITCHED_ROOFS = new Set(['gable', 'gabled', 'hip', 'hipped', 'pyramidal', 'skillion', 'shed'])

function mappedRoofKind(building: Building): 'pitched' | 'flat' | 'unknown' {
  const shape = building.roofShape?.trim().toLocaleLowerCase()
  if (!shape) return 'unknown'
  if (PITCHED_ROOFS.has(shape)) return 'pitched'
  if (shape === 'flat') return 'flat'
  return 'unknown'
}

const MATERIAL_ROOF_COLOURS: Record<string, string> = {
  metal: '#65717b', aluminium: '#818a91', steel: '#65717b', slate: '#48505a', tile: '#8c4e42', tiles: '#8c4e42', concrete: '#807b72',
}

const NIGERIA_FRONTAGE_COLOURS = ['#b94f35', '#d9902f', '#26776f', '#315c82', '#d2a52d', '#8b4938'] as const

function roofColour(building: Building, style: FacadeStyle): string {
  const material = building.roofMaterial?.trim().toLocaleLowerCase() ?? ''
  return MATERIAL_ROOF_COLOURS[material] ?? style.roofColours[building.seed % style.roofColours.length]!
}

function buildingIndex(buildings: Building[], pois: Poi[], colourOf: (category: string) => string): BuildingInfo[] {
  const infos = buildings.map((building): BuildingInfo => ({ building, ...boundsOf(building), edges: edgesOf(building), fronts: [] }))
  for (const poi of pois) {
    if (!SHOPFRONT_CATEGORIES.has(poi.category)) continue
    let best: { info: BuildingInfo; edge: number; pos: Vec2; distance: number; along: number } | null = null
    for (const info of infos) {
      if (Math.hypot(info.center.x - poi.pos.x, info.center.z - poi.pos.z) - info.radius > 24) continue
      const inside = pointInPolygon(poi.pos, info.building)
      for (let edgeIndex = 0; edgeIndex < info.edges.length; edgeIndex++) {
        const edge = info.edges[edgeIndex]!
        if (edge.length < 3.2) continue
        const nearest = nearestOnEdge(poi.pos, edge)
        const distance = inside ? nearest.distance * 0.35 : nearest.distance
        if (!best || distance < best.distance) best = { info, edge: edgeIndex, pos: nearest.pos, distance, along: nearest.along }
      }
    }
    if (!best || best.distance > 18 || best.info.fronts.length >= 2) continue
    const edge = best.info.edges[best.edge]!
    if (best.info.fronts.some(front => front.edge === best.edge && Math.hypot(front.pos.x - best.pos.x, front.pos.z - best.pos.z) < 5)) continue
    const width = Math.min(5.2, Math.max(2.8, edge.length * 0.56), Math.max(2.8, Math.min(best.along, edge.length - best.along) * 1.8))
    best.info.fronts.push({ pos: best.pos, edge: best.edge, width, colour: colourOf(poi.category), name: poi.name })
  }
  return infos
}

function merged(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false)
  parts.forEach(part => part.dispose())
  if (!geometry) throw new Error(`Could not create ${label}`)
  return geometry
}

function windowRevealGeometry(): THREE.BufferGeometry {
  return merged([
    new THREE.PlaneGeometry(1, 0.12).rotateX(Math.PI / 2).translate(0, 0.5, 0),
    new THREE.PlaneGeometry(1, 0.12).rotateX(Math.PI / 2).translate(0, -0.5, 0),
    new THREE.PlaneGeometry(0.12, 1).rotateY(Math.PI / 2).translate(0.5, 0, 0),
    new THREE.PlaneGeometry(0.12, 1).rotateY(Math.PI / 2).translate(-0.5, 0, 0),
  ], 'open window reveals')
}

function frameGeometry(): THREE.BufferGeometry {
  return merged([
    new THREE.PlaneGeometry(1, 0.09).rotateX(-0.62).translate(0, 0.455, 0.024),
    new THREE.PlaneGeometry(1, 0.09).rotateX(0.62).translate(0, -0.455, 0.024),
    new THREE.PlaneGeometry(0.075, 0.82).rotateY(-0.62).translate(-0.4625, 0, 0.024),
    new THREE.PlaneGeometry(0.075, 0.82).rotateY(0.62).translate(0.4625, 0, 0.024),
    new THREE.PlaneGeometry(0.032, 0.84).translate(0, 0, 0.02),
    new THREE.PlaneGeometry(0.86, 0.032).translate(0, 0, 0.02),
  ], 'window frame')
}

function barsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let index = -2; index <= 2; index++) parts.push(new THREE.PlaneGeometry(0.018, 0.86).translate(index * 0.17, 0, 0))
  for (let index = -1; index <= 1; index++) parts.push(new THREE.PlaneGeometry(0.86, 0.018).translate(0, index * 0.26, 0))
  return merged(parts, 'window bars')
}

function balconyRailGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(1, 0.055, 0.055).translate(0, 0.92, 0.48)]
  for (let index = -4; index <= 4; index++) parts.push(new THREE.BoxGeometry(0.025, 0.9, 0.035).translate(index * 0.11, 0.46, 0.48))
  parts.push(new THREE.BoxGeometry(0.04, 0.9, 1).translate(-0.49, 0.46, 0))
  parts.push(new THREE.BoxGeometry(0.04, 0.9, 1).translate(0.49, 0.46, 0))
  return merged(parts, 'balcony rail')
}

function gableGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
    -0.5, 1, 0, 0.5, 1, 0, 0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, -0.5, 0, 0.5,
    -0.5, 0, -0.5, -0.5, 1, 0, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0,
  ])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

function roofRibGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const colours: number[] = []
  for (let rib = -4; rib <= 4; rib++) {
    const x = rib / 9
    for (const side of [-1, 1]) {
      // Folded metal ribs have two lit faces. Closed box undersides add no visible roof detail.
      const left = [x - 0.002, 0.012, side * 0.5], right = [x + 0.002, 0.012, side * 0.5]
      const peak = [x, 0.025, side * 0.5], ridgeLeft = [x - 0.002, 1.012, 0], ridgeRight = [x + 0.002, 1.012, 0], ridgePeak = [x, 1.025, 0]
      positions.push(...left, ...peak, ...ridgePeak, ...left, ...ridgePeak, ...ridgeLeft, ...peak, ...right, ...ridgeRight, ...peak, ...ridgeRight, ...ridgePeak)
      for (let vertex = 0; vertex < 12; vertex++) {
        const shade = vertex < 6 ? 0.82 : 1
        colours.push(shade, shade, shade)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  geometry.computeVertexNormals()
  return geometry
}

function corrugatedRoofGeometry(): THREE.BufferGeometry {
  const base = gableGeometry()
  const colours = new Float32Array(base.getAttribute('position').count * 3)
  for (let vertex = 0; vertex < base.getAttribute('position').count; vertex++) {
    const shade = vertex < 6 ? 0.58 : vertex >= 18 ? 0.76 : 0.94
    colours.set([shade, shade, shade], vertex * 3)
  }
  base.setAttribute('color', new THREE.BufferAttribute(colours, 3))
  const ribs = roofRibGeometry()
  return merged([base, ribs], 'corrugated pitched roof')
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  // Instance colours are independent of per-vertex colour attributes. Leaving vertexColors on
  // without a colour attribute multiplies otherwise valid instance colours against missing data.
  if (!geometry.hasAttribute('color')) material.vertexColors = false
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = name
  mesh.count = 0
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  return mesh
}

function setTransform(
  mesh: THREE.InstancedMesh,
  index: number,
  position: THREE.Vector3,
  angle: number,
  scale: THREE.Vector3,
  matrix: THREE.Matrix4,
  quaternion: THREE.Quaternion,
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

function triangleCount(mesh: THREE.InstancedMesh): number {
  const vertices = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0
  return vertices / 3 * mesh.count
}

function createSignAtlas(capacity: number): {
  mesh: THREE.Mesh
  update(signs: SignFixture[]): void
  dispose(): void
} {
  const columns = 8, rows = 5
  const canvas = document.createElement('canvas')
  canvas.width = 1024; canvas.height = 256
  const context = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  const positions = new Float32Array(capacity * 4 * 3)
  const uvs = new Float32Array(capacity * 4 * 2)
  const indices = new Uint16Array(capacity * 6)
  for (let index = 0; index < capacity; index++) {
    const vertex = index * 4, at = index * 6
    indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], at)
  }
  const geometry = new THREE.BufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
  const uvAttribute = new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('uv', uvAttribute)
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.setDrawRange(0, 0)
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'mapped POI fascia names'
  mesh.frustumCulled = false

  return {
    mesh,
    update(signs) {
      context.clearRect(0, 0, canvas.width, canvas.height)
      const cellWidth = canvas.width / columns, cellHeight = canvas.height / rows
      signs.slice(0, capacity).forEach((sign, index) => {
        const column = index % columns, row = Math.floor(index / columns)
        const px = column * cellWidth, py = row * cellHeight
        context.fillStyle = sign.colour
        context.fillRect(px + 1, py + 1, cellWidth - 2, cellHeight - 2)
        context.fillStyle = '#fffdf5'
        context.font = '700 18px system-ui, sans-serif'
        context.textAlign = 'center'; context.textBaseline = 'middle'
        const name = sign.name.length > 22 ? `${sign.name.slice(0, 21)}…` : sign.name
        context.fillText(name, px + cellWidth / 2, py + cellHeight / 2, cellWidth - 12)

        const width = Math.min(sign.width, Math.max(2.2, sign.name.length * 0.17 + 1.1)), half = width / 2, halfHeight = 0.25
        const outward = 0.22
        const cx = sign.pos.x + sign.edge.nx * outward, cz = sign.pos.z + sign.edge.nz * outward
        const leftX = cx - sign.edge.ux * half, leftZ = cz - sign.edge.uz * half
        const rightX = cx + sign.edge.ux * half, rightZ = cz + sign.edge.uz * half
        const p = index * 12
        positions.set([leftX, sign.y - halfHeight, leftZ, rightX, sign.y - halfHeight, rightZ, rightX, sign.y + halfHeight, rightZ, leftX, sign.y + halfHeight, leftZ], p)
        const u0 = column / columns, u1 = (column + 1) / columns
        const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows
        uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], index * 8)
      })
      geometry.setDrawRange(0, Math.min(signs.length, capacity) * 6)
      mesh.visible = signs.length > 0
      positionAttribute.needsUpdate = true; uvAttribute.needsUpdate = true; texture.needsUpdate = true
      geometry.computeBoundingSphere()
    },
    dispose() { geometry.dispose(); material.dispose(); texture.dispose(); mesh.removeFromParent() },
  }
}

export function createFacadeDetailSystem(
  district: District,
  style: FacadeStyle,
  colourOf: (category: string) => string,
): FacadeDetailSystem {
  const group = new THREE.Group()
  group.name = `${style.id} illustrative facade detail`
  group.userData.facadeBasis = style.basis
  group.userData.facadeStyle = style.id
  const infos = buildingIndex(district.buildings, district.pois, colourOf)
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), colour = new THREE.Color()

  const recessMaterial = new THREE.MeshStandardMaterial({ color: '#18252a', roughness: 0.26, metalness: 0.2, side: THREE.DoubleSide })
  const darkWindowMaterial = new THREE.MeshStandardMaterial({ color: '#71909a', roughness: 0.13, metalness: 0.28 })
  const litWindowMaterial = new THREE.MeshStandardMaterial({ color: '#fff0c7', emissive: '#ef9f3d', emissiveIntensity: 0.1, roughness: 0.28, vertexColors: true })
  const frameMaterial = new THREE.MeshStandardMaterial({ color: style.frameColour, roughness: 0.72 })
  const sillMaterial = new THREE.MeshStandardMaterial({ color: style.sillColour, roughness: 0.84 })
  const metalMaterial = new THREE.MeshStandardMaterial({ color: '#30363a', roughness: 0.52, metalness: 0.48 })
  const doorMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.58, metalness: 0.04, vertexColors: true })
  const shopGlassMaterial = new THREE.MeshStandardMaterial({ color: '#668993', roughness: 0.12, metalness: 0.24 })
  const accentMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.62, metalness: 0.04, vertexColors: true })
  const roofMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.76, metalness: 0.14, vertexColors: true, side: THREE.DoubleSide })
  const concreteMaterial = new THREE.MeshStandardMaterial({ color: '#c4b9a8', roughness: 0.9 })
  const tankMaterial = new THREE.MeshStandardMaterial({ color: '#20272b', roughness: 0.64, metalness: 0.22 })

  const windowRecesses = instanced(windowRevealGeometry(), recessMaterial, MAX.windows, 'recessed window openings')
  const windowsDark = instanced(new THREE.PlaneGeometry(1, 1), darkWindowMaterial, MAX.windows, 'dark human-scale windows')
  const windowsLit = instanced(new THREE.PlaneGeometry(1, 1), litWindowMaterial, MAX.windows, 'lit human-scale windows')
  const frames = instanced(frameGeometry(), frameMaterial, MAX.windows, 'window outer frames')
  const sills = instanced(new THREE.BoxGeometry(1, 0.09, 0.2), sillMaterial, MAX.windows, 'window sills at human height')
  const bars = instanced(barsGeometry(), metalMaterial, MAX.windows, 'illustrative burglar bars')
  const doors = instanced(new THREE.BoxGeometry(1, 1, 0.09), doorMaterial, MAX.doors, 'building doors')
  const shopGlass = instanced(new THREE.BoxGeometry(1, 1, 0.1), shopGlassMaterial, MAX.shopfronts, 'mapped venue shopfront glass')
  const shopTrim = instanced(new THREE.BoxGeometry(1, 1, 0.16), accentMaterial, MAX.shopfronts + MAX.frontagePanels, 'shopfront trim and near frontage panels')
  const shopAwnings = instanced(new THREE.BoxGeometry(1, 0.12, 1), accentMaterial, MAX.shopfronts, 'mapped venue awnings')
  const shopFascias = instanced(new THREE.BoxGeometry(1, 0.62, 0.14), accentMaterial, MAX.shopfronts, 'mapped venue fascia bands')
  const balconySlabs = instanced(new THREE.BoxGeometry(1, 0.13, 1), concreteMaterial, MAX.balconies, 'balcony slabs')
  const balconyRails = instanced(balconyRailGeometry(), metalMaterial, MAX.balconies, 'balcony rails')
  const parapets = instanced(new THREE.BoxGeometry(1, 0.52, 0.16), concreteMaterial, MAX.roofDetails * 4 + MAX.cornices, 'roof parapets and near frontage cornices')
  const pitchedRoofs = instanced(corrugatedRoofGeometry(), roofMaterial, MAX.roofDetails, 'footprint-checked corrugated roof forms')
  const waterTanks = instanced(new THREE.CylinderGeometry(0.72, 0.72, 1.45, 12), tankMaterial, MAX.roofDetails, 'roof water tanks')
  const signAtlas = createSignAtlas(MAX.signs)

  const meshes = [
    windowRecesses, windowsDark, windowsLit, frames, sills, bars, doors,
    shopGlass, shopTrim, shopAwnings, shopFascias, balconySlabs, balconyRails,
    parapets, pitchedRoofs, waterTanks,
  ]
  meshes.forEach(mesh => group.add(mesh))
  group.add(signAtlas.mesh)

  const stats: FacadeDetailStats = { windows: 0, doors: 0, shopfronts: 0, signs: 0, balconies: 0, roofDetails: 0, compounds: 0, frontageDetails: 0, triangles: 0 }
  let night = 0

  const update = (position: Vec2, quality: FacadeDetailQuality): void => {
    const budget = BUDGETS[quality]
    const nearby = infos
      .filter(info => Math.hypot(info.center.x - position.x, info.center.z - position.z) - info.radius <= budget.radius)
      .sort((a, b) => nearestFacadeDistance(a, position) - nearestFacadeDistance(b, position))
    let darkCount = 0, litCount = 0, windowCount = 0, barsCount = 0, doorCount = 0, shopCount = 0
    let balconyCount = 0, parapetCount = 0, pitchedCount = 0, roofDetailCount = 0, tankCount = 0
    const signs: SignFixture[] = []
    const frontagePanels: EdgeBoxFixture[] = []
    const cornices: EdgeBoxFixture[] = []

    for (const info of nearby) {
      const building = info.building
      const mappedRoof = mappedRoofKind(building)
      const mappedRoofRise = mappedRoof === 'pitched' && building.roofHeight && building.roofHeight > 0
        ? Math.min(building.roofHeight, Math.max(0, building.height - building.base - 2.4)) : 0
      const roofBase = building.height - mappedRoofRise
      const buildingHeight = roofBase - building.base
      if (buildingHeight < 2.2 || info.edges.length === 0) continue
      const heightFloors = 1 + Math.max(0, Math.floor((buildingHeight - style.groundFloorHeight + 0.18) / style.storeyHeight))
      const maximumFloors = Math.max(1, Math.floor(buildingHeight / 2.45))
      const floors = building.levels && building.levels > 0 ? Math.min(maximumFloors, Math.max(1, Math.round(building.levels))) : heightFloors
      const upperFloors = floors - 1
      const groundFloor = floors === 1 ? buildingHeight : Math.min(style.groundFloorHeight + unit(building.seed) * 0.18, buildingHeight - upperFloors * 2.45)
      const upperStorey = upperFloors > 0 ? (buildingHeight - groundFloor) / upperFloors : style.storeyHeight
      const frontEdges = new Set(info.fronts.map(front => front.edge))
      const edgeOrder = info.edges.map((_, index) => index)
        .sort((a, b) => nearestOnEdge(position, info.edges[a]!).distance - nearestOnEdge(position, info.edges[b]!).distance)
      let reservedDoor: { edgeIndex: number; edge: Edge; center: Vec2; along: number } | null = null
      if (doorCount < budget.doors && building.base < 0.35) {
        const front = info.fronts[0]
        const edgeIndex = front?.edge ?? edgeOrder[0]!
        const edge = info.edges[edgeIndex]!
        if (edge.length > 2.5) {
          const doorBays = Math.max(1, Math.floor(edge.length / style.baySpacing))
          const doorBay = Math.floor(unit(hash(building.seed, edgeIndex, 701)) * doorBays)
          const doorAlong = edge.length / doorBays * (doorBay + 0.5)
          const center = front
            ? { x: front.pos.x + edge.ux * (front.width / 2 - 0.58), z: front.pos.z + edge.uz * (front.width / 2 - 0.58) }
            : { x: edge.a.x + edge.ux * doorAlong, z: edge.a.z + edge.uz * doorAlong }
          reservedDoor = { edgeIndex, edge, center, along: nearestOnEdge(center, edge).along }
        }
      }

      for (const edgeIndex of edgeOrder) {
        if (windowCount >= budget.windows) break
        const edge = info.edges[edgeIndex]!
        const bays = Math.max(1, Math.floor(edge.length / style.baySpacing))
        const bayWidth = edge.length / bays
        for (let floor = 0; floor < floors && windowCount < budget.windows; floor++) {
          if (floor === 0 && frontEdges.has(edgeIndex)) continue
          const floorBase = floor === 0 ? building.base : building.base + groundFloor + (floor - 1) * upperStorey
          const floorTop = floor === 0 ? building.base + groundFloor : floorBase + upperStorey
          const sill = THREE.MathUtils.lerp(style.sillHeight[0], style.sillHeight[1], unit(hash(building.seed, floor, edgeIndex)))
          const height = Math.min(style.windowHeight, floorTop - floorBase - sill - 0.28)
          if (height < 0.82) continue
          for (let bay = 0; bay < bays && windowCount < budget.windows; bay++) {
            const along = bayWidth * (bay + 0.5)
            const x = edge.a.x + edge.ux * along, z = edge.a.z + edge.uz * along
            const width = Math.min(bayWidth * 0.62, THREE.MathUtils.lerp(style.windowWidth[0], style.windowWidth[1], unit(hash(building.seed + bay, floor, edgeIndex))))
            if (width < 0.72) continue
            if (floor === 0 && reservedDoor?.edgeIndex === edgeIndex && Math.abs(along - reservedDoor.along) < width / 2 + 0.62) continue
            const y = floorBase + sill + height / 2
            const lit = ((building.seed + bay * 7 + floor * 11) & 7) < (night > 0.45 ? 3 : 1)
            const target = lit ? windowsLit : windowsDark
            const targetIndex = lit ? litCount++ : darkCount++
            const nearDepth = nearestOnEdge(position, edge).distance < 58 ? 1.45 : 1
            setTransform(windowRecesses, windowCount, new THREE.Vector3(x + edge.nx * 0.035, y, z + edge.nz * 0.035), edge.angle, new THREE.Vector3(width + 0.12, height + 0.12, nearDepth), matrix, quaternion)
            const glassDepth = nearDepth > 1 ? 0.055 : 0.105
            setTransform(target, targetIndex, new THREE.Vector3(x + edge.nx * glassDepth, y, z + edge.nz * glassDepth), edge.angle, new THREE.Vector3(width, height, 1), matrix, quaternion)
            setTransform(frames, windowCount, new THREE.Vector3(x + edge.nx * 0.13, y, z + edge.nz * 0.13), edge.angle, new THREE.Vector3(width + 0.18, height + 0.18, 1), matrix, quaternion)
            setTransform(sills, windowCount, new THREE.Vector3(x + edge.nx * 0.15, floorBase + sill - 0.055, z + edge.nz * 0.15), edge.angle, new THREE.Vector3(width + 0.3, 1, 1), matrix, quaternion)
            if (unit(hash(building.seed + bay, floor, edgeIndex + 91)) < style.barredWindowRate && barsCount < MAX.windows) {
              setTransform(bars, barsCount++, new THREE.Vector3(x + edge.nx * 0.17, y, z + edge.nz * 0.17), edge.angle, new THREE.Vector3(width, height, 1), matrix, quaternion)
            }
            if (lit) {
              const warmth = unit(hash(building.seed + bay, floor, edgeIndex))
              windowsLit.setColorAt(targetIndex, colour.setHSL(0.085 + warmth * 0.04, 0.45 + warmth * 0.18, 0.76 + warmth * 0.1))
            } else {
              const reflection = unit(hash(building.seed + bay, floor, edgeIndex + 137))
              windowsDark.setColorAt(targetIndex, colour.setRGB(0.78 + reflection * 0.22, 0.84 + reflection * 0.16, 0.88 + reflection * 0.12))
            }
            windowCount++
          }
        }
      }

      if (reservedDoor) {
        const { edge, center } = reservedDoor
        setTransform(doors, doorCount, new THREE.Vector3(center.x + edge.nx * 0.15, building.base + 1.15, center.z + edge.nz * 0.15), edge.angle, new THREE.Vector3(1.02, 2.3, 1), matrix, quaternion)
        doors.setColorAt(doorCount, colour.set(style.doorColours[(building.seed + doorCount) % style.doorColours.length]!))
        doorCount++
      }

      for (const front of info.fronts) {
        if (shopCount >= budget.shopfronts) break
        const edge = info.edges[front.edge]!
        const x = front.pos.x + edge.nx * 0.12, z = front.pos.z + edge.nz * 0.12
        const shopRhythm = unit(hash(building.seed, front.edge, shopCount + 809))
        const shopHeight = Math.min(2.28 + shopRhythm * 0.34, groundFloor - 0.55)
        const y = building.base + 0.16 + shopHeight / 2
        setTransform(shopTrim, shopCount, new THREE.Vector3(x - edge.nx * 0.045, y, z - edge.nz * 0.045), edge.angle, new THREE.Vector3(front.width + 0.3, shopHeight + 0.28, 1), matrix, quaternion)
        setTransform(shopGlass, shopCount, new THREE.Vector3(x + edge.nx * 0.02, y, z + edge.nz * 0.02), edge.angle, new THREE.Vector3(front.width, shopHeight, 1), matrix, quaternion)
        setTransform(shopAwnings, shopCount, new THREE.Vector3(x + edge.nx * style.awningDepth * 0.48, building.base + groundFloor - 0.28 - shopRhythm * 0.16, z + edge.nz * style.awningDepth * 0.48), edge.angle, new THREE.Vector3(front.width + 0.22, 1, style.awningDepth * (0.9 + shopRhythm * 0.16)), matrix, quaternion)
        setTransform(shopFascias, shopCount, new THREE.Vector3(x + edge.nx * 0.02, building.base + groundFloor - 0.08, z + edge.nz * 0.02), edge.angle, new THREE.Vector3(front.width + 0.28, 1, 1), matrix, quaternion)
        colour.set(front.colour)
        shopTrim.setColorAt(shopCount, colour.clone().offsetHSL(0, 0, -0.08))
        shopAwnings.setColorAt(shopCount, colour)
        shopFascias.setColorAt(shopCount, colour.clone().offsetHSL(0, 0, -0.04))
        if (signs.length < budget.signs) signs.push({ pos: front.pos, edge, width: front.width, y: building.base + groundFloor - 0.08, name: front.name, colour: front.colour })
        shopCount++
      }

      const isNigerian = style.id === 'nigeria' || style.id === 'nigeria-lagos'
      if (isNigerian && frontagePanels.length < budget.frontagePanels) {
        const nearEdges = edgeOrder
          .filter(edgeIndex => info.edges[edgeIndex]!.length >= 7 && nearestOnEdge(position, info.edges[edgeIndex]!).distance < 58)
          .slice(0, 2)
        for (const edgeIndex of nearEdges) {
          const edge = info.edges[edgeIndex]!
          const bays = Math.max(3, Math.floor(edge.length / Math.max(2.4, style.baySpacing)))
          const bayWidth = edge.length / bays
          const paletteBase = hash(building.seed, edgeIndex, 941) % NIGERIA_FRONTAGE_COLOURS.length
          for (let bay = 0; bay < bays && frontagePanels.length < budget.frontagePanels; bay++) {
            const along = bayWidth * (bay + 0.5)
            const blocksDoor = reservedDoor?.edgeIndex === edgeIndex && Math.abs(along - reservedDoor.along) < bayWidth * 0.58
            const blocksShop = info.fronts.some(front => front.edge === edgeIndex && Math.abs(along - nearestOnEdge(front.pos, edge).along) < front.width / 2 + bayWidth * 0.28)
            if (blocksDoor || blocksShop) continue
            const tone = unit(hash(building.seed + bay, edgeIndex, 911))
            const pilaster = bay % 4 === (building.seed & 3)
            const width = pilaster ? Math.min(0.34, bayWidth * 0.18) : Math.max(0.72, bayWidth - 0.18)
            const height = Math.min(groundFloor - 0.12, pilaster ? groundFloor - 0.08 : 2.32 + tone * 0.52)
            const x = edge.a.x + edge.ux * along + edge.nx * 0.018
            const z = edge.a.z + edge.uz * along + edge.nz * 0.018
            frontagePanels.push({
              pos: new THREE.Vector3(x, building.base + height / 2, z),
              angle: edge.angle,
              scale: new THREE.Vector3(width, height, 0.25),
              colour: NIGERIA_FRONTAGE_COLOURS[(paletteBase + (pilaster ? 1 : bay % 5 === 0 ? 2 : 0)) % NIGERIA_FRONTAGE_COLOURS.length]!,
            })
          }
          if (cornices.length < budget.cornices) {
            const tone = unit(hash(building.seed, edgeIndex, 977))
            const stepWidth = edge.length * (0.72 + tone * 0.22)
            const along = edge.length * (0.46 + (tone - 0.5) * 0.08)
            cornices.push({
              pos: new THREE.Vector3(edge.a.x + edge.ux * along + edge.nx * 0.09, building.base + groundFloor - 0.04 - tone * 0.12, edge.a.z + edge.uz * along + edge.nz * 0.09),
              angle: edge.angle,
              scale: new THREE.Vector3(stepWidth, 0.28 + tone * 0.12, 0.58),
              colour: NIGERIA_FRONTAGE_COLOURS[(paletteBase + 1) % NIGERIA_FRONTAGE_COLOURS.length]!,
            })
          }
        }
      }

      const longest = info.edges.reduce((best, next) => next.length > best.length ? next : best)
      if (balconyCount < budget.balconies && upperFloors > 0 && unit(building.seed + 41) < style.balconyRate) {
        const width = Math.min(4.8, Math.max(2.5, longest.length * 0.46))
        const x = (longest.a.x + longest.b.x) / 2 + longest.nx * 0.58
        const z = (longest.a.z + longest.b.z) / 2 + longest.nz * 0.58
        const y = building.base + groundFloor + 0.04
        setTransform(balconySlabs, balconyCount, new THREE.Vector3(x, y, z), longest.angle, new THREE.Vector3(width, 1, 1.05), matrix, quaternion)
        setTransform(balconyRails, balconyCount, new THREE.Vector3(x, y + 0.08, z), longest.angle, new THREE.Vector3(width, 1, 1.05), matrix, quaternion)
        balconyCount++
      }

      const roofChoice = unit(building.seed + 67)
      const wantsPitch = mappedRoof === 'pitched' || (mappedRoof === 'unknown' && roofChoice < style.pitchedRoofRate)
      const roofWidth = Math.min(longest.length * 0.78, 12)
      const roofDepth = Math.min(Math.max(3.2, info.radius * 0.68), 7)
      const roofCenter = supportedRoofPoint(building, info.center, 0.15)
      const direction = building.roofDirection === undefined ? longest.angle : THREE.MathUtils.degToRad(building.roofDirection) + Math.PI / 2
      if (roofDetailCount < budget.roofDetails && buildingHeight <= 18 && wantsPitch && roofCenter && roofRectangleFits(building, roofCenter, direction, roofWidth, roofDepth)) {
        const rise = mappedRoofRise || 0.65 + unit(building.seed + 11) * 0.55
        setTransform(pitchedRoofs, pitchedCount, new THREE.Vector3(roofCenter.x, roofBase + 0.025, roofCenter.z), direction, new THREE.Vector3(roofWidth, rise, roofDepth), matrix, quaternion)
        pitchedRoofs.setColorAt(pitchedCount, colour.set(roofColour(building, style)))
        pitchedCount++
        roofDetailCount++
      } else if (mappedRoof !== 'pitched' && parapetCount + info.edges.length <= MAX.roofDetails * 4 && roofDetailCount < budget.roofDetails) {
        for (const edge of info.edges) {
          const x = (edge.a.x + edge.b.x) / 2, z = (edge.a.z + edge.b.z) / 2
          setTransform(parapets, parapetCount, new THREE.Vector3(x, building.height + 0.26, z), edge.angle, new THREE.Vector3(edge.length, 1, 1), matrix, quaternion)
          parapets.setColorAt(parapetCount++, colour.set('#c4b9a8'))
        }
        roofDetailCount++
      }

      if (tankCount < budget.roofDetails && quality !== 'low' && !wantsPitch && unit(building.seed + 89) < style.waterTankRate) {
        const preferred = { x: info.center.x + Math.min(1.2, info.radius * 0.18), z: info.center.z - Math.min(0.7, info.radius * 0.1) }
        const support = supportedRoofPoint(building, preferred, 0.82)
        if (support) {
          setTransform(waterTanks, tankCount++, new THREE.Vector3(support.x, building.height + 0.74, support.z), 0, new THREE.Vector3(1, 1, 1), matrix, quaternion)
        }
      }
    }


    frontagePanels.forEach((fixture, index) => {
      const target = shopCount + index
      setTransform(shopTrim, target, fixture.pos, fixture.angle, fixture.scale, matrix, quaternion)
      shopTrim.setColorAt(target, colour.set(fixture.colour))
    })
    cornices.forEach((fixture, index) => {
      const target = parapetCount + index
      setTransform(parapets, target, fixture.pos, fixture.angle, fixture.scale, matrix, quaternion)
      parapets.setColorAt(target, colour.set(fixture.colour))
    })
    const trimCount = shopCount + frontagePanels.length
    const parapetAndCorniceCount = parapetCount + cornices.length

    finish(windowRecesses, windowCount); finish(windowsDark, darkCount); finish(windowsLit, litCount)
    finish(frames, windowCount); finish(sills, windowCount); finish(bars, barsCount)
    finish(doors, doorCount); finish(shopGlass, shopCount); finish(shopTrim, trimCount); finish(shopAwnings, shopCount); finish(shopFascias, shopCount)
    finish(balconySlabs, balconyCount); finish(balconyRails, balconyCount); finish(parapets, parapetAndCorniceCount)
    finish(pitchedRoofs, pitchedCount); finish(waterTanks, tankCount)
    signAtlas.update(signs)
    stats.windows = windowCount; stats.doors = doorCount; stats.shopfronts = shopCount; stats.signs = signs.length
    stats.balconies = balconyCount; stats.roofDetails = roofDetailCount + tankCount; stats.compounds = 0
    stats.frontageDetails = frontagePanels.length + cornices.length
    stats.triangles = Math.round(meshes.reduce((sum, mesh) => sum + triangleCount(mesh), 0) + signs.length * 2)
  }

  return {
    group,
    stats,
    update,
    setNight(amount) {
      night = THREE.MathUtils.clamp(amount, 0, 1)
      litWindowMaterial.emissiveIntensity = 0.08 + night * 0.58
      darkWindowMaterial.color.set('#79949b').lerp(new THREE.Color('#263f49'), night * 0.76)
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
      for (const mesh of meshes) {
        geometries.add(mesh.geometry)
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        list.forEach(material => materials.add(material))
      }
      geometries.forEach(geometry => geometry.dispose())
      materials.forEach(material => material.dispose())
      signAtlas.dispose()
      group.removeFromParent()
    },
  }
}
