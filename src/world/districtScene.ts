// Build the 3D street scene for a district from real map geometry.
//
// What is real: street lines and classes, street names, building outlines and provider render heights,
// water, parks and named public places. What is stylised: colours, windows, roofs, trees, lamps
// and any building height the map does not record. The interface says so (see coverage summary).
import * as THREE from 'three'
import type { Vec2 } from '../shared/geo.ts'
import type { Building, District, Ground, GroundKind, Poi, Polygon, Road, RoadKind } from '../geo/district.ts'
import type { StreetNavigator } from './nav.ts'
import { createStreetDetailStream } from './streetDetail.ts'
import type { StreetDetailStats } from './streetDetail.ts'
import { resolveFacadeStyle } from './facadeStyles.ts'
import type { DistrictSceneContext, FacadeStyle } from './facadeStyles.ts'
import { acquireSurface } from './surfaceMaterials.ts'
import type { SurfaceName } from './surfaceMaterials.ts'

export type { DistrictSceneContext } from './facadeStyles.ts'

export type Quality = 'low' | 'medium' | 'high'

const GROUND_COLOR: Record<GroundKind, string> = {
  residential: '#d9d2c3', commercial: '#ddd2c3', industrial: '#cfd0d2', civic: '#dfd4bc', park: '#8eb878', grass: '#a8c98a',
  wood: '#719c68', sand: '#d9c69d', pitch: '#79aa72', water: '#4f91ad',
}
const GROUND_HEIGHT: Record<GroundKind, number> = {
  residential: 0.01, commercial: 0.012, industrial: 0.014, civic: 0.016, grass: 0.03, park: 0.034, wood: 0.038, sand: 0.042, pitch: 0.046, water: 0.055,
}
const ROAD_COLOR: Record<RoadKind, string> = {
  motorway: '#d0d2d3', major: '#d6d7d7', street: '#dcdddc', service: '#e2e2df', path: '#e9ddc8', pedestrian: '#e5dfd2', rail: '#c3c4c4',
}
const ROAD_HEIGHT: Record<RoadKind, number> = { path: 0.095, pedestrian: 0.105, service: 0.097, street: 0.099, major: 0.101, motorway: 0.103, rail: 0.107 }
// Broad underlays sit below asphalt; their exposed edges read as pavements and kerbs without
// coplanar junction seams covering the mapped road surface.
const SIDEWALK_HEIGHT = 0.085
const KERB_HEIGHT = 0.13
const BUILDING_CHUNK = 320

export { CATEGORY_STYLE, categoryStyle } from '../geo/categoryStyle.ts'
import { categoryStyle } from '../geo/categoryStyle.ts'

/** Collects triangles with per-vertex colour for one merged mesh. */
class Batch {
  readonly positions: number[] = []
  readonly colors: number[] = []
  readonly normals: number[] = []
  readonly uvs: number[] = []
  private readonly colour = new THREE.Color()

  tri(a: number[], b: number[], c: number[], colour: string, normal: number[] = [0, 1, 0]): void {
    this.positions.push(...a, ...b, ...c)
    this.colour.set(colour)
    for (let i = 0; i < 3; i++) { this.colors.push(this.colour.r, this.colour.g, this.colour.b); this.normals.push(...normal) }
  }

  /** An upright quad between two ground points, shaded from `foot` at the bottom edge to `head` at the top. */
  wall(a: Vec2, b: Vec2, from: number, to: number, foot: THREE.Color, head: THREE.Color, normal: number[]): void {
    this.positions.push(a.x, from, a.z, b.x, from, b.z, b.x, to, b.z, a.x, from, a.z, b.x, to, b.z, a.x, to, a.z)
    for (const colour of [foot, foot, head, foot, head, head]) { this.colors.push(colour.r, colour.g, colour.b); this.normals.push(...normal) }
  }

  geometry(withUv = false): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3))
    if (withUv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2))
    return geometry
  }
}

function triangulate(polygon: Polygon): [Vec2, Vec2, Vec2][] {
  const contour = polygon.outer.map(p => new THREE.Vector2(p.x, p.z))
  const holes = polygon.holes.map(hole => hole.map(p => new THREE.Vector2(p.x, p.z)))
  // Earcut wants a counter-clockwise outline and clockwise holes.
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse()
  for (const hole of holes) if (!THREE.ShapeUtils.isClockWise(hole)) hole.reverse()
  const all = [...contour, ...holes.flat()]
  let faces: number[][]
  try { faces = THREE.ShapeUtils.triangulateShape(contour, holes) } catch { return [] }
  return faces.map(face => face.map(index => ({ x: all[index]!.x, z: all[index]!.y })) as [Vec2, Vec2, Vec2])
}

function addFlat(batch: Batch, polygon: Polygon, y: number, colour: string): void {
  for (const [a, b, c] of triangulate(polygon)) batch.tri([a.x, y, a.z], [c.x, y, c.z], [b.x, y, b.z], colour)
}

/** A flat ribbon along a polyline, with a small fan at each vertex so bends have no gaps. */
function addRibbon(batch: Batch, points: Vec2[], width: number, y: number, colour: string): void {
  const half = width / 2
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!
    const dx = b.x - a.x, dz = b.z - a.z
    const length = Math.hypot(dx, dz)
    if (length < 0.05) continue
    const nx = (-dz / length) * half, nz = (dx / length) * half
    batch.tri([a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz], [b.x - nx, y, b.z - nz], colour)
    batch.tri([a.x + nx, y, a.z + nz], [b.x - nx, y, b.z - nz], [a.x - nx, y, a.z - nz], colour)
  }
  for (const p of points) {
    for (let s = 0; s < 8; s++) {
      const a0 = (s / 8) * Math.PI * 2, a1 = ((s + 1) / 8) * Math.PI * 2
      batch.tri([p.x, y, p.z], [p.x + Math.sin(a1) * half, y, p.z + Math.cos(a1) * half], [p.x + Math.sin(a0) * half, y, p.z + Math.cos(a0) * half], colour)
    }
  }
}

function addDashes(batch: Batch, points: Vec2[], y: number): void {
  let carried = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!, b = points[i + 1]!
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    if (length < 0.1) continue
    const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length
    for (let at = -carried; at < length; at += 9) {
      const from = Math.max(0, at), to = Math.min(length, at + 3.2)
      if (to - from < 0.4) continue
      addRibbonSegment(batch, { x: a.x + ux * from, z: a.z + uz * from }, { x: a.x + ux * to, z: a.z + uz * to }, 0.28, y, '#f2efe6')
    }
    carried = (carried + length) % 9
  }
}

function addRibbonSegment(batch: Batch, a: Vec2, b: Vec2, width: number, y: number, colour: string): void {
  const dx = b.x - a.x, dz = b.z - a.z
  const length = Math.hypot(dx, dz) || 1
  const nx = (-dz / length) * (width / 2), nz = (dx / length) * (width / 2)
  batch.tri([a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz], [b.x - nx, y, b.z - nz], colour)
  batch.tri([a.x + nx, y, a.z + nz], [b.x - nx, y, b.z - nz], [a.x - nx, y, a.z - nz], colour)
}

function addRoadEdges(batch: Batch, road: Road, offset: number, width: number, y: number, colour: string): void {
  for (let index = 0; index < road.points.length - 1; index++) {
    const a = road.points[index]!, b = road.points[index + 1]!
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz)
    if (length < 0.5) continue
    const nx = -dz / length, nz = dx / length
    for (const side of [-1, 1]) {
      addRibbonSegment(
        batch,
        { x: a.x + nx * offset * side, z: a.z + nz * offset * side },
        { x: b.x + nx * offset * side, z: b.z + nz * offset * side },
        width,
        y,
        colour,
      )
    }
  }
}

interface JunctionArm { road: number; point: Vec2; direction: Vec2; width: number; kind: RoadKind }

function addCrossings(batch: Batch, roads: Road[], limit: number): number {
  const cells = new Map<string, JunctionArm[]>()
  roads.forEach((road, roadIndex) => {
    if (road.tunnel || (road.kind !== 'street' && road.kind !== 'major')) return
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!
      const neighbour = index + 1 < road.points.length ? road.points[index + 1]! : road.points[index - 1]
      if (!neighbour) continue
      const length = Math.hypot(neighbour.x - point.x, neighbour.z - point.z)
      if (length < 0.5) continue
      const arm = { road: roadIndex, point, direction: { x: (neighbour.x - point.x) / length, z: (neighbour.z - point.z) / length }, width: road.width, kind: road.kind }
      const key = `${Math.round(point.x / 3)}:${Math.round(point.z / 3)}`
      const list = cells.get(key)
      if (list) list.push(arm)
      else cells.set(key, [arm])
    }
  })

  let count = 0
  const used: Vec2[] = []
  for (const arms of cells.values()) {
    if (count >= limit) break
    let crossing: { primary: JunctionArm; secondary: JunctionArm } | null = null
    for (let i = 0; i < arms.length && !crossing; i++) {
      for (let j = i + 1; j < arms.length; j++) {
        const a = arms[i]!, b = arms[j]!
        const turn = Math.abs(a.direction.x * b.direction.z - a.direction.z * b.direction.x)
        if (a.road !== b.road && turn > 0.38) { crossing = { primary: a.width >= b.width ? a : b, secondary: a.width >= b.width ? b : a }; break }
      }
    }
    if (!crossing) continue
    const center = crossing.primary.point
    if (used.some(point => Math.hypot(point.x - center.x, point.z - center.z) < 22)) continue
    const direction = crossing.primary.direction
    const normal = { x: -direction.z, z: direction.x }
    const halfWidth = crossing.primary.width * 0.42
    const offset = Math.min(5.5, crossing.secondary.width * 0.5 + 1.7)
    for (let stripe = 0; stripe < 5; stripe++) {
      const along = offset + stripe * 0.72
      const stripeCenter = { x: center.x + direction.x * along, z: center.z + direction.z * along }
      addRibbonSegment(
        batch,
        { x: stripeCenter.x - normal.x * halfWidth, z: stripeCenter.z - normal.z * halfWidth },
        { x: stripeCenter.x + normal.x * halfWidth, z: stripeCenter.z + normal.z * halfWidth },
        0.38,
        ROAD_HEIGHT[crossing.primary.kind] + 0.012,
        '#ddd9cd',
      )
    }
    used.push(center)
    count++
  }
  return count
}

function shade(colour: string, amount: number): string {
  return `#${new THREE.Color(colour).offsetHSL(0, 0, amount).getHexString()}`
}

const NAMED_FACADE_COLOURS: Record<string, string> = {
  white: '#e8e5dc', cream: '#e6d8bd', beige: '#d8c6a9', yellow: '#d9bd69', orange: '#ce8d55', red: '#ad6557',
  brown: '#8f6a58', grey: '#a9aaa5', gray: '#a9aaa5', green: '#9eb59b', blue: '#9eb4c2', pink: '#d8aaa9',
}

function mappedFacadeColour(value: string | undefined): string | null {
  const colour = value?.trim().toLocaleLowerCase()
  if (!colour) return null
  if (/^#?[0-9a-f]{6}$/.test(colour)) return colour.startsWith('#') ? colour : `#${colour}`
  return NAMED_FACADE_COLOURS[colour] ?? null
}

function mappedSurface(building: Building, fallback: FacadeStyle['surfaces'][number]): FacadeStyle['surfaces'][number] {
  const material = building.facadeMaterial?.trim().toLocaleLowerCase() ?? ''
  if (material.includes('brick')) return 'brick'
  if (material.includes('concrete') || material.includes('cement') || material.includes('block')) return 'concrete'
  if (material.includes('plaster') || material.includes('render') || material.includes('stucco')) return 'plaster'
  return fallback
}

function mappedRoofColour(building: Building, fallback: string): string {
  const material = building.roofMaterial?.trim().toLocaleLowerCase() ?? ''
  if (material.includes('slate')) return '#48505a'
  if (material.includes('metal') || material.includes('steel') || material.includes('aluminium')) return '#69747c'
  if (material.includes('tile')) return '#8c4e42'
  if (material.includes('concrete')) return '#817d75'
  return fallback
}

function mappedPitchedRoofRise(building: Building): number {
  const shape = building.roofShape?.trim().toLocaleLowerCase() ?? ''
  if (!['gable', 'gabled', 'hip', 'hipped', 'pyramidal', 'skillion', 'shed'].includes(shape)) return 0
  if (!building.roofHeight || building.roofHeight <= 0) return 0
  return Math.min(building.roofHeight, Math.max(0, building.height - building.base - 2.4))
}

function polygonBounds(building: Building): { center: Vec2; radius: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const point of building.outer) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
  }
  const center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 }
  return { center, radius: Math.hypot(maxX - minX, maxZ - minZ) / 2 }
}

function addWall(batch: Batch, a: Vec2, b: Vec2, from: number, to: number, foot: THREE.Color, head: THREE.Color, normal: number[]): void {
  if (to <= from) return
  batch.wall(a, b, from, to, foot, head, normal)
}

type BuildingSurface = 'plaster' | 'brick' | 'concrete' | 'roof'

interface StyledBuildingChunk {
  batches: Record<BuildingSurface, Batch>
  center: Vec2
  radius: number
}

interface StyledBuildingScene {
  group: THREE.Group
  shown: number
  chunks: { object: THREE.Group; center: Vec2; radius: number }[]
  drawCalls: number
  triangles: number
  setQuality(quality: Quality): void
}

function buildingMaterials(quality: Quality): Record<BuildingSurface, THREE.MeshStandardMaterial> {
  const plaster = acquireSurface('plaster', quality)
  const brick = acquireSurface('brick', quality)
  const concrete = acquireSurface('concrete', quality)
  const roof = acquireSurface('roof', quality)
  for (const material of [plaster, brick, concrete]) {
    material.vertexColors = true
    material.side = THREE.DoubleSide
    material.roughness = 0.88
    material.normalScale.setScalar(0.14)
  }
  roof.vertexColors = true
  roof.roughness = 0.86
  roof.normalScale.setScalar(0.18)
  return { plaster, brick, concrete, roof }
}

function buildStyledBuildings(buildings: Building[], center: Vec2, radius: number, quality: Quality, facadeStyle: FacadeStyle): StyledBuildingScene {
  const group = new THREE.Group()
  group.name = 'mapped building shells'
  const chunks = new Map<string, StyledBuildingChunk>()
  const styles = facadeStyle.surfaces
  let shown = 0

  for (const building of buildings) {
    const bounds = polygonBounds(building)
    if (Math.hypot(bounds.center.x - center.x, bounds.center.z - center.z) - bounds.radius <= radius) shown++
    const chunkX = Math.floor(bounds.center.x / BUILDING_CHUNK), chunkZ = Math.floor(bounds.center.z / BUILDING_CHUNK)
    const key = `${chunkX}:${chunkZ}`
    let chunk = chunks.get(key)
    if (!chunk) {
      chunk = {
        batches: { plaster: new Batch(), brick: new Batch(), concrete: new Batch(), roof: new Batch() },
        center: { x: (chunkX + 0.5) * BUILDING_CHUNK, z: (chunkZ + 0.5) * BUILDING_CHUNK },
        radius: 0,
      }
      chunks.set(key, chunk)
    }
    chunk.radius = Math.max(chunk.radius, Math.hypot(bounds.center.x - chunk.center.x, bounds.center.z - chunk.center.z) + bounds.radius)
    const style = mappedSurface(building, styles[building.seed % styles.length]!)
    const walls = chunk.batches[style]
    const wallColour = mappedFacadeColour(building.facadeColor) ?? facadeStyle.wallColours[building.seed % facadeStyle.wallColours.length]!
    const roofColour = mappedRoofColour(building, facadeStyle.roofColours[(building.seed >> 4) % facadeStyle.roofColours.length]!)
    const roofRise = mappedPitchedRoofRise(building)
    const wallTop = building.height - roofRise
    const groundTop = Math.min(wallTop, building.base + Math.min(facadeStyle.groundFloorHeight, Math.max(2.7, wallTop - building.base)))
    const corniceBottom = Math.max(groundTop, wallTop - 0.24)
    // The ground floor darkens towards the pavement, so a pale wall still meets a pale street with a
    // readable edge. It is a vertex-colour ramp on the existing band: no added triangles.
    const footColour = new THREE.Color(shade(wallColour, -0.115)), groundColour = new THREE.Color(shade(wallColour, -0.045))
    const bodyColour = new THREE.Color(wallColour), corniceColour = new THREE.Color(shade(wallColour, 0.035))
    for (const ring of [building.outer, ...building.holes]) {
      let area = 0
      for (let index = 0; index < ring.length; index++) {
        const point = ring[index]!, next = ring[(index + 1) % ring.length]!
        area += point.x * next.z - next.x * point.z
      }
      const flip = (area > 0) === (ring === building.outer) ? 1 : -1
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index]!, b = ring[(index + 1) % ring.length]!
        const length = Math.hypot(b.x - a.x, b.z - a.z)
        if (length < 0.1) continue
        const normal = [flip * (b.z - a.z) / length, 0, -flip * (b.x - a.x) / length]
        addWall(walls, a, b, building.base, groundTop, footColour, groundColour, normal)
        addWall(walls, a, b, groundTop, corniceBottom, bodyColour, bodyColour, normal)
        addWall(walls, a, b, corniceBottom, wallTop, corniceColour, corniceColour, normal)
      }
    }
    addFlat(chunk.batches.roof, building, wallTop, roofColour)
  }

  let materials = buildingMaterials(quality)
  const meshes: Record<BuildingSurface, THREE.Mesh[]> = { plaster: [], brick: [], concrete: [], roof: [] }
  const chunksOut: { object: THREE.Group; center: Vec2; radius: number }[] = []
  let drawCalls = 0, triangles = 0
  for (const [key, chunk] of chunks) {
    const object = new THREE.Group()
    object.name = `building chunk ${key}`
    // Palette weights choose materials; each material batch must render only once.
    for (const style of ['plaster', 'brick', 'concrete', 'roof'] as const) {
      const batch = chunk.batches[style]
      if (batch.positions.length === 0) continue
      const geometry = batch.geometry()
      geometry.computeBoundingSphere()
      const mesh = new THREE.Mesh(geometry, materials[style])
      mesh.name = `${style} ${key}`
      mesh.castShadow = mesh.receiveShadow = true
      meshes[style].push(mesh)
      object.add(mesh)
      drawCalls++
      triangles += geometry.attributes.position?.count ? geometry.attributes.position.count / 3 : 0
    }
    chunksOut.push({ object, center: chunk.center, radius: chunk.radius })
    group.add(object)
  }

  return {
    group,
    shown,
    chunks: chunksOut,
    drawCalls,
    triangles: Math.round(triangles),
    setQuality(nextQuality) {
      const previous = materials
      materials = buildingMaterials(nextQuality)
      for (const style of [...styles, 'roof'] as const) for (const mesh of meshes[style]) mesh.material = materials[style]
      for (const material of Object.values(previous)) material.dispose()
    },
  }
}

interface VenueFixture { anchor: Vec2; colour: string }
// Closer than this, two marker posts read as one muddled post.
const FIXTURE_SPACING = 1.5

function venueAnchor(poi: Poi, navigator: StreetNavigator): Vec2 {
  return navigator.venueApproach(poi.pos) ?? poi.pos
}

/**
 * One marker post per approach. Places that share a doorway keep their own labels and stay
 * walkable; only the duplicate post, cap and ground ring are left out. Place order, not distance
 * from the player, decides which post stays, so it does not swap as the player walks.
 */
function distinctFixtures(venues: VenueMarker[], colourOf: (category: string) => string): VenueFixture[] {
  const fixtures: VenueFixture[] = []
  for (const venue of [...venues].sort((a, b) => a.poi.placeId < b.poi.placeId ? -1 : a.poi.placeId > b.poi.placeId ? 1 : 0)) {
    if (fixtures.some(fixture => Math.hypot(fixture.anchor.x - venue.anchor.x, fixture.anchor.z - venue.anchor.z) < FIXTURE_SPACING)) continue
    fixtures.push({ anchor: venue.anchor, colour: colourOf(venue.poi.category) })
  }
  return fixtures
}

function buildVenueFixtures(capacity: number): {
  group: THREE.Group
  material: THREE.MeshStandardMaterial
  ringGeometry: THREE.RingGeometry
  ringMaterial: THREE.MeshBasicMaterial
  update(fixtures: VenueFixture[]): void
} {
  const group = new THREE.Group()
  const ringGeometry = new THREE.RingGeometry(0.46, 0.62, 24)
  const ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.78, depthWrite: false })
  const postMaterial = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.18, emissive: '#30251f', emissiveIntensity: 0.08 })
  const rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, capacity)
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 2.8, 6), postMaterial, capacity)
  const caps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.38, 0.5, 0.16, 8), postMaterial, capacity)
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion(), colour = new THREE.Color()
  quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0))
  const update = (fixtures: VenueFixture[]): void => {
    fixtures.forEach((fixture, index) => {
      matrix.compose(new THREE.Vector3(fixture.anchor.x, 0.155, fixture.anchor.z), quaternion, new THREE.Vector3(1, 1, 1))
      rings.setMatrixAt(index, matrix)
      posts.setMatrixAt(index, matrix.makeTranslation(fixture.anchor.x, 1.48, fixture.anchor.z))
      caps.setMatrixAt(index, matrix.makeTranslation(fixture.anchor.x, 2.92, fixture.anchor.z))
      colour.set(fixture.colour)
      rings.setColorAt(index, colour)
      posts.setColorAt(index, colour)
      caps.setColorAt(index, colour)
    })
    for (const mesh of [rings, posts, caps]) {
      mesh.count = fixtures.length
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }
  update([])
  posts.castShadow = caps.castShadow = true
  group.add(rings, posts, caps)
  return { group, material: postMaterial, ringGeometry, ringMaterial, update }
}

function labelSprite(text: string, icon: string, colour: string): { sprite: THREE.Sprite; aspect: number } {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const font = '600 30px ui-rounded, "SF Pro Rounded", system-ui, sans-serif'
  context.font = font
  const label = text.length > 26 ? `${text.slice(0, 25)}…` : text
  const width = Math.ceil(context.measureText(label).width) + 86
  canvas.width = width
  canvas.height = 64
  context.font = font
  context.fillStyle = 'rgba(255,255,255,0.96)'
  context.beginPath()
  context.roundRect(1, 1, width - 2, 62, 31)
  context.fill()
  context.fillStyle = colour
  context.beginPath()
  context.arc(32, 32, 25, 0, Math.PI * 2)
  context.fill()
  context.font = '28px system-ui, "Apple Color Emoji", sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(icon, 32, 34)
  context.font = font
  context.textAlign = 'left'
  context.fillStyle = '#231f2e'
  context.fillText(label, 66, 34)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }))
  sprite.renderOrder = 5
  return { sprite, aspect: width / 64 }
}

function streetLabel(name: string): { mesh: THREE.Mesh; width: number } {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const font = '700 40px ui-rounded, "SF Pro Rounded", system-ui, sans-serif'
  context.font = font
  const width = Math.ceil(context.measureText(name).width) + 24
  canvas.width = width
  canvas.height = 56
  context.font = font
  context.textBaseline = 'middle'
  context.lineWidth = 7
  context.strokeStyle = 'rgba(40,44,54,0.55)'
  context.strokeText(name, 12, 30)
  context.fillStyle = '#ffffff'
  context.fillText(name, 12, 30)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  const metres = width / 56 * 2.4
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(metres, 2.4), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }))
  mesh.rotation.x = -Math.PI / 2
  return { mesh, width: metres }
}

export interface VenueMarker {
  poi: Poi
  /** Standable visual anchor; the mapped POI coordinate remains unchanged on `poi`. */
  anchor: Vec2
  sprite: THREE.Sprite
  ring: THREE.Mesh
  aspect: number
}

export interface DistrictScene {
  root: THREE.Group
  venues: VenueMarker[]
  /** Night lighting: 0 by day, 1 at night. */
  setNight(amount: number): void
  /** Adjust draw distance and decorative detail without rebuilding geometry. */
  setQuality(quality: Quality): void
  setVisibilityRange(metres: number): void
  /** Move chunk culling with the player. Call only after meaningful movement. */
  updatePosition(position: Vec2): void
  stats: {
    facadeStyle: FacadeStyle['id']
    facadeBasis: FacadeStyle['basis']
    triangles: number
    buildingsShown: number
    buildingTriangles: number
    buildingDrawCalls: number
    buildingMeshPools: number
    surfaceMaterials: number
    trees: number
    venues: number
    streetLabels: number
    /** Street names within reading distance of the player; the rest are built but not drawn. */
    streetLabelsShown: number
  }
  /** Bounded moving-detail diagnostics for long-walk and quality verification. */
  streaming: StreetDetailStats
  dispose(): void
}

// `labelRadius` is how far a street name laid on the road is drawn: each is its own draw call and
// texture, and from the follow camera it stops being readable well inside these distances.
const QUALITY = {
  low: { buildingRadius: 520, detailRadius: 240, decorationRadius: 420, windows: 1800, trees: 420, lamps: 70, furniture: 45, crossings: 30, venues: 60, labels: 30, labelRadius: 150 },
  medium: { buildingRadius: 900, detailRadius: 520, decorationRadius: 760, windows: 6000, trees: 1200, lamps: 240, furniture: 130, crossings: 80, venues: 110, labels: 60, labelRadius: 230 },
  high: { buildingRadius: 4000, detailRadius: 900, decorationRadius: 1500, windows: 14_000, trees: 2600, lamps: 520, furniture: 260, crossings: 150, venues: 180, labels: 90, labelRadius: 320 },
} as const
const LABEL_STEP = 24

export function buildDistrictScene(
  district: District,
  navigator: StreetNavigator,
  focus: Vec2,
  quality: Quality,
  context: DistrictSceneContext = {},
): DistrictScene {
  const settings = QUALITY[quality]
  const facadeStyle = resolveFacadeStyle(context)
  const root = new THREE.Group()
  root.name = `district ${district.id}`
  root.userData.facadeStyle = facadeStyle.id
  root.userData.facadeBasis = facadeStyle.basis
  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(item: T): T => { disposables.push(item); return item }
  interface SurfaceBinding {
    name: SurfaceName
    material: THREE.MeshStandardMaterial
    mesh: THREE.Mesh
    configure(material: THREE.MeshStandardMaterial): void
  }
  const surfaceBindings: SurfaceBinding[] = []
  const surfacedMesh = (
    geometry: THREE.BufferGeometry,
    name: SurfaceName,
    configure: (material: THREE.MeshStandardMaterial) => void = () => undefined,
  ): THREE.Mesh => {
    const material = acquireSurface(name, quality)
    configure(material)
    const mesh = new THREE.Mesh(track(geometry), material)
    surfaceBindings.push({ name, material, mesh, configure })
    return mesh
  }
  const setSurfaceQuality = (nextQuality: Quality): void => {
    for (const binding of surfaceBindings) {
      const previous = binding.material
      const next = acquireSurface(binding.name, nextQuality)
      binding.configure(next)
      binding.material = next
      binding.mesh.material = next
      previous.dispose()
    }
  }

  // Ground
  const base = surfacedMesh(new THREE.PlaneGeometry(district.span * 1.6, district.span * 1.6), 'soil', material => material.color.set('#ded8c9'))
  base.rotation.x = -Math.PI / 2
  base.receiveShadow = true
  root.add(base)

  const green = new Batch()
  const paved = new Batch()
  const soil = new Batch()
  const water = new Batch()
  const order = (ground: Ground): number => GROUND_HEIGHT[ground.kind]
  for (const ground of [...district.ground].sort((a, b) => order(a) - order(b))) {
    const batch = ground.kind === 'water' ? water
      : ground.kind === 'park' || ground.kind === 'grass' || ground.kind === 'wood' || ground.kind === 'pitch' ? green
        : ground.kind === 'sand' ? soil : paved
    addFlat(batch, ground, GROUND_HEIGHT[ground.kind], GROUND_COLOR[ground.kind])
  }
  const withVertexColours = (material: THREE.MeshStandardMaterial): void => { material.vertexColors = true }
  const greenMesh = surfacedMesh(green.geometry(), 'grass', withVertexColours)
  const pavedMesh = surfacedMesh(paved.geometry(), 'concrete', withVertexColours)
  const soilMesh = surfacedMesh(soil.geometry(), 'soil', withVertexColours)
  greenMesh.receiveShadow = pavedMesh.receiveShadow = soilMesh.receiveShadow = true
  const waterMaterial = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.1 }))
  const waterMesh = new THREE.Mesh(track(water.geometry()), waterMaterial)
  root.add(greenMesh, pavedMesh, soilMesh, waterMesh)

  // Streets
  const sidewalks = new Batch()
  const kerbs = new Batch()
  const drains = new Batch()
  const asphalt = new Batch()
  const pathSurface = new Batch()
  const marks = new Batch()
  for (const road of district.roads) {
    if (road.tunnel) continue
    const y = ROAD_HEIGHT[road.kind]
    if (road.kind === 'street' || road.kind === 'major' || road.kind === 'service') {
      addRibbon(sidewalks, road.points, road.width + 4.2, SIDEWALK_HEIGHT, '#e3e1dc')
      addRoadEdges(kerbs, road, road.width / 2 + 0.12, 0.24, KERB_HEIGHT, '#d8d4c8')
      const open = facadeStyle.drainage === 'open'
      addRoadEdges(drains, road, road.width / 2 + (open ? 0.62 : 0.38), open ? 0.5 : 0.2, open ? 0.092 : 0.09, open ? '#545a55' : '#777872')
    }
    addRibbon(road.kind === 'path' || road.kind === 'pedestrian' ? pathSurface : asphalt, road.points, road.width, y, ROAD_COLOR[road.kind])
    if (road.kind === 'major' || road.kind === 'motorway') addDashes(marks, road.points, y + 0.012)
  }
  addCrossings(marks, district.roads, settings.crossings)
  const streetBatches: [Batch, SurfaceName | null][] = [
    [sidewalks, 'paving'],
    [kerbs, 'concrete'],
    [drains, null],
    [asphalt, 'asphalt'],
    [pathSurface, 'paving'],
    [marks, null],
  ]
  for (const [batch, surfaceName] of streetBatches) {
    const mesh = surfaceName
      ? surfacedMesh(batch.geometry(), surfaceName, withVertexColours)
      : new THREE.Mesh(track(batch.geometry()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 })))
    mesh.receiveShadow = true
    root.add(mesh)
  }

  // Buildings
  const buildingScene = buildStyledBuildings(district.buildings, focus, settings.buildingRadius, quality, facadeStyle)
  root.add(buildingScene.group)
  const buildingsShown = buildingScene.shown

  // Bounded eye-level detail follows the player while mapped shells persist.
  const streetDetail = createStreetDetailStream(district, navigator, focus, quality, category => categoryStyle(category).color, facadeStyle)
  root.add(streetDetail.group)

  // Street names, laid flat along the street.
  let streetLabels = 0
  const labelMeshes: { mesh: THREE.Mesh; at: Vec2 }[] = []
  const labelled = new Map<string, Vec2[]>()
  for (const street of [...district.streetNames].sort((a, b) => Number(b.major) - Number(a.major))) {
    if (streetLabels >= settings.labels) break
    let longest = 0, at = 0
    for (let i = 0; i < street.points.length - 1; i++) {
      const length = Math.hypot(street.points[i + 1]!.x - street.points[i]!.x, street.points[i + 1]!.z - street.points[i]!.z)
      if (length > longest) { longest = length; at = i }
    }
    const a = street.points[at]!, b = street.points[at + 1]!
    const middle = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    const previous = labelled.get(street.name) ?? []
    if (longest < 14 || previous.some(p => Math.hypot(p.x - middle.x, p.z - middle.z) < 260)) continue
    const { mesh, width } = streetLabel(street.name)
    if (width > longest * 1.4) { mesh.geometry.dispose(); if (mesh.material instanceof THREE.MeshBasicMaterial) { mesh.material.map?.dispose(); mesh.material.dispose() }; continue }
    let angle = Math.atan2(-(b.z - a.z), b.x - a.x)
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI
    mesh.rotation.z = angle
    mesh.position.set(middle.x, 0.16, middle.z)
    track(mesh.geometry); track(mesh.material as THREE.Material)
    if (mesh.material instanceof THREE.MeshBasicMaterial && mesh.material.map) track(mesh.material.map)
    root.add(mesh)
    labelMeshes.push({ mesh, at: middle })
    labelled.set(street.name, [...previous, middle])
    streetLabels++
  }

  let currentQuality: Quality = quality
  let surfaceTier: 'low' | 'standard' = quality === 'low' ? 'low' : 'standard'
  let currentPosition = focus
  // Public places are a stable bounded array whose contents follow the player.
  const venues: VenueMarker[] = []
  const venueAnchors = new Map<Poi['placeId'], Vec2>()
  const fixtureScene = buildVenueFixtures(QUALITY.high.venues)
  const venueRefreshStep = 100
  let venueFocus = { x: focus.x, z: focus.z }
  root.add(fixtureScene.group)
  const disposeVenue = (venue: VenueMarker): void => {
    venue.sprite.removeFromParent()
    venue.sprite.material.map?.dispose()
    venue.sprite.material.dispose()
    venue.ring.removeFromParent()
  }
  const makeVenue = (poi: Poi, anchor: Vec2): VenueMarker => {
    const style = categoryStyle(poi.category)
    const { sprite, aspect } = labelSprite(poi.name, style.icon, style.color)
    sprite.position.set(anchor.x, 7.5, anchor.z)
    sprite.visible = false
    const ring = new THREE.Mesh(fixtureScene.ringGeometry, fixtureScene.ringMaterial)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(anchor.x, 0.2, anchor.z)
    ring.visible = false
    root.add(sprite)
    return { poi, anchor, sprite, ring, aspect }
  }
  const refreshVenues = (position: Vec2, force = false): void => {
    if (!force && Math.hypot(position.x - venueFocus.x, position.z - venueFocus.z) < venueRefreshStep) return
    venueFocus = { x: position.x, z: position.z }
    const retained = new Map(venues.map(venue => [venue.poi.placeId, venue]))
    const ranked = [...district.pois]
      .sort((a, b) => Math.hypot(a.pos.x - position.x, a.pos.z - position.z) - Math.hypot(b.pos.x - position.x, b.pos.z - position.z))
      .slice(0, QUALITY[currentQuality].venues)
    const next = ranked.map(poi => {
      const existing = retained.get(poi.placeId)
      if (existing) { retained.delete(poi.placeId); return existing }
      let anchor = venueAnchors.get(poi.placeId)
      if (!anchor) { anchor = venueAnchor(poi, navigator); venueAnchors.set(poi.placeId, anchor) }
      return makeVenue(poi, anchor)
    })
    retained.forEach(disposeVenue)
    venues.splice(0, venues.length, ...next)
    fixtureScene.update(distinctFixtures(venues, category => categoryStyle(category).color))
  }
  refreshVenues(focus, true)

  let visibleBuildingDrawCalls = 0
  let visibilityRange = Infinity
  const applyDrawDistance = (): void => {
    const drawRadius = Math.min(QUALITY[currentQuality].buildingRadius, visibilityRange)
    visibleBuildingDrawCalls = 0
    for (const chunk of buildingScene.chunks) {
      chunk.object.visible = Math.hypot(chunk.center.x - currentPosition.x, chunk.center.z - currentPosition.z) <= drawRadius + chunk.radius
      if (chunk.object.visible) visibleBuildingDrawCalls += chunk.object.children.length
    }
  }
  applyDrawDistance()

  let labelFocus = focus
  let streetLabelsShown = 0
  const applyLabelDistance = (): void => {
    const labelRadius = Math.min(QUALITY[currentQuality].labelRadius, visibilityRange)
    streetLabelsShown = 0
    for (const label of labelMeshes) {
      label.mesh.visible = Math.hypot(label.at.x - labelFocus.x, label.at.z - labelFocus.z) <= labelRadius
      if (label.mesh.visible) streetLabelsShown++
    }
  }
  applyLabelDistance()

  let triangles = 0
  root.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const count = mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position?.count ?? 0
    triangles += (count / 3) * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1)
  })

  const stats = {
    facadeStyle: facadeStyle.id,
    facadeBasis: facadeStyle.basis,
    triangles: Math.round(triangles),
    buildingsShown,
    buildingTriangles: buildingScene.triangles,
    buildingDrawCalls: visibleBuildingDrawCalls,
    buildingMeshPools: buildingScene.drawCalls,
    surfaceMaterials: surfaceBindings.length + 4,
    trees: streetDetail.stats.trees,
    venues: venues.length,
    streetLabels,
    streetLabelsShown,
  }
  const fixedTriangles = Math.max(0, stats.triangles - streetDetail.stats.triangles)

  return {
    root, venues,
    setNight(amount) {
      const night = THREE.MathUtils.clamp(amount, 0, 1)
      streetDetail.setNight(night)
      fixtureScene.material.emissiveIntensity = 0.08 + night * 0.55
      waterMaterial.roughness = THREE.MathUtils.lerp(0.3, 0.16, night)
    },
    setQuality(nextQuality) {
      const changed = currentQuality !== nextQuality
      const nextSurfaceTier = nextQuality === 'low' ? 'low' : 'standard'
      currentQuality = nextQuality
      if (changed && nextSurfaceTier !== surfaceTier) {
        setSurfaceQuality(nextQuality)
        buildingScene.setQuality(nextQuality)
        surfaceTier = nextSurfaceTier
      }
      streetDetail.setQuality(nextQuality)
      refreshVenues(currentPosition, true)
      applyDrawDistance()
      applyLabelDistance()
      stats.streetLabelsShown = streetLabelsShown
      stats.triangles = fixedTriangles + streetDetail.stats.triangles
      stats.trees = streetDetail.stats.trees
      stats.venues = venues.length
      stats.buildingDrawCalls = visibleBuildingDrawCalls
    },
    setVisibilityRange(metres) {
      if (!Number.isFinite(metres) || Math.abs(visibilityRange - metres) < 24) return
      visibilityRange = Math.max(120, metres)
      applyDrawDistance()
      applyLabelDistance()
      stats.buildingDrawCalls = visibleBuildingDrawCalls
      stats.streetLabelsShown = streetLabelsShown
    },
    updatePosition(position) {
      streetDetail.update(position)
      refreshVenues(position)
      stats.triangles = fixedTriangles + streetDetail.stats.triangles
      stats.trees = streetDetail.stats.trees
      stats.venues = venues.length
      if (Math.hypot(position.x - labelFocus.x, position.z - labelFocus.z) >= LABEL_STEP) {
        labelFocus = { x: position.x, z: position.z }
        applyLabelDistance()
        stats.streetLabelsShown = streetLabelsShown
      }
      if (Math.hypot(position.x - currentPosition.x, position.z - currentPosition.z) >= BUILDING_CHUNK * 0.3) {
        currentPosition = position
        applyDrawDistance()
        stats.buildingDrawCalls = visibleBuildingDrawCalls
      }
    },
    stats,
    streaming: streetDetail.stats,
    dispose() {
      streetDetail.dispose()
      venues.forEach(disposeVenue)
      venues.length = 0
      root.traverse(child => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh) { mesh.geometry.dispose(); const material = mesh.material; (Array.isArray(material) ? material : [material]).forEach(m => m.dispose()) }
      })
      for (const item of disposables) item.dispose()
      root.removeFromParent()
    },
  }
}
