// Interiors: virtual homes and illustrative venue rooms, furnished from the furniture pack
// (Kenney Furniture Kit, CC0).
import * as THREE from 'three'
import furnitureIndex from '../assets/furniture.index.json'
import type { Vec2 } from '../shared/geo.ts'
import { HOME_FURNITURE_SCALE, HOME_WALK_THROUGH } from '../shared/homes.ts'
import type { HomePlan } from '../shared/homes.ts'
import type { HomeLayout, PlacedItem } from '../shared/social.ts'
import type { Quality } from './districtScene.ts'
import { PACKS, loadPack, parseModel } from './packs.ts'
import { acquireSurface } from './surfaceMaterials.ts'
import { createOriginalFurniture } from './newinteriorFurniture.ts'
import { buildHomeScene } from './homeScene.ts'
import type { HomeGhost } from './homeScene.ts'
import { createVenueDressing, createVenueLayout, venuePlanForLayout } from './venueInteriors.ts'
import type { InteriorStation } from './venueInteriors.ts'

export type { InteriorStation, InteriorStationKind } from './venueInteriors.ts'

interface FurnitureMeta {
  name: string
  materials: string[]
  min: number[]
  max: number[]
  asset?: string
  pack?: string
  material?: string
  height?: number
  generator?: 'original-detail'
}
export const FURNITURE = furnitureIndex as FurnitureMeta[]
const FURNITURE_BY_NAME = new Map(FURNITURE.map(entry => [entry.name, entry]))

/** Furniture kit units to metres, sized against a 1.75 m adult. The contract's figure: the service measures the same pieces. */
const FURNITURE_SCALE = HOME_FURNITURE_SCALE
/** Grid step for placed items, in metres. */
export const GRID = 0.5
export const WALL_HEIGHT = 3.1

interface FurnitureDimensions { width: number; depth: number; height: number }

/** Pieces a member can place, grouped for the editor. Structural kit parts (walls, floors) are left out. */
export const FURNITURE_GROUPS: { id: string; label: string; models: string[] }[] = [
  { id: 'seating', label: 'Seating', models: ['loungeSofa', 'loungeSofaLong', 'loungeSofaCorner', 'loungeDesignSofa', 'loungeChair', 'loungeChairRelax', 'loungeDesignChair', 'chairCushion', 'chairModernCushion', 'chairRounded', 'chairDesk', 'stoolBar', 'benchCushion'] },
  { id: 'tables', label: 'Tables', models: ['table', 'tableRound', 'tableCross', 'tableCloth', 'tableGlass', 'tableCoffee', 'tableCoffeeSquare', 'tableCoffeeGlass', 'sideTable', 'sideTableDrawers', 'desk', 'deskCorner'] },
  { id: 'beds', label: 'Beds', models: ['bedSingle', 'bedDouble', 'bedBunk', 'cabinetBed', 'cabinetBedDrawer'] },
  { id: 'storage', label: 'Storage', models: ['bookcaseOpen', 'bookcaseOpenLow', 'bookcaseClosed', 'bookcaseClosedWide', 'cabinetTelevision', 'cabinetTelevisionDoors', 'coatRackStanding', 'cardboardBoxClosed'] },
  { id: 'lighting', label: 'Lighting', models: ['lampRoundFloor', 'lampSquareFloor', 'lampRoundTable', 'lampSquareTable'] },
  { id: 'decor', label: 'Decor', models: ['rugRectangle', 'rugRound', 'rugRounded', 'rugSquare', 'rugDoormat', 'pottedPlant', 'plantSmall1', 'plantSmall2', 'plantSmall3', 'books', 'televisionModern', 'televisionVintage', 'radio', 'speaker', 'bear', 'pillow'] },
  { id: 'kitchen', label: 'Kitchen', models: ['kitchenBar', 'kitchenCabinet', 'kitchenCabinetDrawer', 'kitchenSink', 'kitchenStove', 'kitchenFridge', 'kitchenFridgeSmall', 'kitchenCoffeeMachine', 'kitchenMicrowave', 'toaster'] },
]

const WALK_THROUGH = HOME_WALK_THROUGH

function furnitureDimensions(model: string, turns: number): FurnitureDimensions {
  const meta = FURNITURE_BY_NAME.get(model)
  if (!meta) return { width: 1, depth: 1, height: 1 }
  const width = (meta.max[0]! - meta.min[0]!) * FURNITURE_SCALE
  const depth = (meta.max[2]! - meta.min[2]!) * FURNITURE_SCALE
  const height = meta.height ?? (meta.max[1]! - meta.min[1]!) * FURNITURE_SCALE
  return turns % 2 === 0 ? { width, depth, height } : { width: depth, depth: width, height }
}

export function footprint(model: string, turns: number): { width: number; depth: number } {
  const { width, depth } = furnitureDimensions(model, turns)
  return { width, depth }
}

export const isFurniture = (model: string): boolean => FURNITURE_BY_NAME.has(model)
export const blocksWalking = (model: string): boolean => !WALK_THROUGH.test(model)
export const materialsOf = (model: string): string[] => FURNITURE_BY_NAME.get(model)?.materials ?? []

interface FurnitureSource { object: THREE.Object3D; size: THREE.Vector3; scaleToFootprint: boolean; fallbackTint: boolean }
const sources = new Map<string, Promise<FurnitureSource>>()

function prepareFurniture(object: THREE.Object3D, materialName?: string): FurnitureSource {
  const bounds = new THREE.Box3().setFromObject(object)
  const size = bounds.getSize(new THREE.Vector3())
  const centre = bounds.getCenter(new THREE.Vector3())
  const wrapper = new THREE.Group()
  object.position.set(-centre.x, -bounds.min.y, -centre.z)
  wrapper.add(object)
  object.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const candidate of materials) {
      const material = candidate as THREE.MeshStandardMaterial
      if (materialName) material.name = materialName
      material.roughness = Math.max(0.35, material.roughness)
      material.metalness = materialName?.startsWith('metal') ? Math.max(0.22, material.metalness) : material.metalness
    }
  })
  return { object: wrapper, size, scaleToFootprint: Boolean(materialName), fallbackTint: Boolean(materialName) }
}

function loadLegacyFurniture(meta: FurnitureMeta): Promise<FurnitureSource> {
  const key = `legacy:${meta.name}`
  let pending = sources.get(key)
  if (!pending) {
    pending = loadPack(PACKS.furniture).then(pack => parseModel(pack, meta.name)).then(gltf => {
      const holder = new THREE.Group()
      gltf.scene.position.set(-(meta.min[0]! + meta.max[0]!) / 2, -meta.min[1]!, -(meta.min[2]! + meta.max[2]!) / 2)
      holder.add(gltf.scene)
      const prepared = prepareFurniture(holder)
      prepared.scaleToFootprint = false
      prepared.fallbackTint = false
      holder.traverse(child => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const candidate of materials) {
          const material = candidate as THREE.MeshStandardMaterial
          material.roughness = 0.82
          material.metalness = material.name.startsWith('metal') ? 0.35 : 0
        }
      })
      return prepared
    })
    sources.set(key, pending)
    pending.catch(() => sources.delete(key))
  }
  return pending
}

function loadFurniture(model: string): Promise<FurnitureSource> {
  const meta = FURNITURE_BY_NAME.get(model)
  if (!meta) return Promise.reject(new Error(`Unknown furniture model "${model}"`))
  if (meta.generator === 'original-detail') {
    const key = `original:${meta.name}`
    let pending = sources.get(key)
    if (!pending) {
      pending = Promise.resolve().then(() => {
        const prepared = prepareFurniture(createOriginalFurniture(meta.name, meta.materials))
        prepared.scaleToFootprint = true
        prepared.fallbackTint = true
        return prepared
      })
      sources.set(key, pending)
      pending.catch(() => sources.delete(key))
    }
    return pending
  }
  if (!meta.asset || !meta.pack) return loadLegacyFurniture(meta)
  const key = `${meta.pack}:${meta.asset}`
  let pending = sources.get(key)
  if (!pending) {
    pending = loadPack(meta.pack).then(pack => parseModel(pack, meta.asset!)).then(gltf => prepareFurniture(gltf.scene, meta.material))
    sources.set(key, pending)
    pending.catch(() => sources.delete(key))
  }
  return pending
}

export async function createFurniture(item: Pick<PlacedItem, 'model' | 'tints'>): Promise<THREE.Object3D> {
  const meta = FURNITURE_BY_NAME.get(item.model)
  if (!meta) throw new Error(`Unknown furniture model "${item.model}"`)
  let source: FurnitureSource
  try {
    source = await loadFurniture(item.model)
  } catch (error) {
    if (!meta.asset && meta.generator !== 'original-detail') throw error
    source = await loadLegacyFurniture(meta)
  }
  const instance = source.object.clone(true)
  const tints = Object.entries(item.tints)
  if (tints.length) {
    instance.traverse(child => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const tint = (material: THREE.Material): THREE.Material => {
        const direct = tints.find(([name]) => name === material.name)
        const compatible = source.fallbackTint ? tints.find(([name]) => meta.materials.includes(name)) : undefined
        const colour = direct ?? compatible
        if (!colour) return material
        const copy = material.clone() as THREE.MeshStandardMaterial
        copy.color.set(colour[1])
        return copy
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material)
    })
  }
  if (source.scaleToFootprint) {
    const target = footprint(item.model, 0)
    instance.scale.set(target.width / source.size.x, (meta.height ?? 1) / source.size.y, target.depth / source.size.z)
  } else instance.scale.setScalar(FURNITURE_SCALE)
  return instance
}

export interface InteriorSpec {
  kind: 'home' | 'venue'
  title: string
  layout: HomeLayout
  /** A home's rooms, doors and front door. Without one a home is drawn as the single room `layout` describes. */
  plan?: HomePlan
  /** Venue rooms are illustrative: they are not the real layout of the named place. */
  illustrative: boolean
}

export interface InteriorScene {
  root: THREE.Group
  spec: InteriorSpec
  /** Stable, walkable interaction anchors for situated venue actions. Empty in homes. */
  stations: readonly InteriorStation[]
  /** Where avatars enter and leave. */
  door: Vec2
  cameraObstacles: THREE.Object3D[]
  setQuality(quality: Quality): void
  setItems(items: PlacedItem[]): Promise<void>
  highlight(key: string | null): void
  itemAt(raycaster: THREE.Raycaster): string | null
  route(from: Vec2, target: Vec2): Vec2[]
  walkable(point: Vec2): boolean
  dispose(): void
  /** Homes only: where a character first stands on stepping in, and the way they face. */
  entry?: { pos: Vec2; heading: number }
  /** Homes only: the plan as drawn now. */
  plan?(): HomePlan
  /** Homes only: redraw the rooms from a changed plan. Furniture stays. */
  setPlan?(plan: HomePlan): void
  /** Homes only: outline rooms being planned on the floor, or clear them. */
  setGhost?(ghost: HomeGhost | null): void
  /** Homes only: lift the ceiling and lower the walls to see every room from above. */
  setCutaway?(on: boolean): void
}

export function itemPosition(item: Pick<PlacedItem, 'x' | 'z'>): Vec2 { return { x: item.x * GRID, z: item.z * GRID } }

export function buildInterior(spec: InteriorSpec, quality: Quality = 'medium'): InteriorScene {
  if (spec.kind === 'home' && spec.plan) {
    return buildHomeScene({ ...spec, plan: spec.plan }, { createFurniture, footprint, isFurniture, blocksWalking, itemPosition, grid: GRID, wallHeight: WALL_HEIGHT }, quality)
  }
  const { width, depth, floor, wall } = spec.layout
  const venuePlan = spec.kind === 'venue' ? venuePlanForLayout(spec.layout) : null
  const root = new THREE.Group()
  root.name = `interior ${spec.title}`
  let floorMaterial = acquireSurface('wood', quality)
  floorMaterial.color.copy(new THREE.Color(floor).lerp(new THREE.Color('#ffffff'), 0.58))
  floorMaterial.roughness = 0.72
  const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, depth), floorMaterial)
  floorMesh.position.set(width / 2, -0.1, depth / 2)
  floorMesh.receiveShadow = true
  floorMesh.name = 'floor'
  root.add(floorMesh)
  const cameraObstacles: THREE.Object3D[] = []
  let wallMaterial = acquireSurface('plaster', quality)
  wallMaterial.color.copy(new THREE.Color(wall).lerp(new THREE.Color('#ffffff'), 0.34))
  let trimMaterial = acquireSurface('wood', quality)
  trimMaterial.color.set('#68452f')
  trimMaterial.roughness = 0.68
  const wallThickness = 0.2
  const makeWall = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMaterial)
    mesh.position.set(x, y, z)
    mesh.receiveShadow = true
    mesh.castShadow = true
    cameraObstacles.push(mesh)
    root.add(mesh)
    return mesh
  }
  const makeTrim = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trimMaterial)
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    root.add(mesh)
  }
  makeWall(width + wallThickness * 2, WALL_HEIGHT, wallThickness, width / 2, WALL_HEIGHT / 2, -wallThickness / 2)
  const windowWidth = Math.min(2, depth * 0.24)
  const windowHeight = 1.3
  const windowY = 1.65
  const windowZ = depth * 0.42
  const windowStart = windowZ - windowWidth / 2
  const windowEnd = windowZ + windowWidth / 2
  const sideWall = (x: number): void => {
    makeWall(wallThickness, WALL_HEIGHT, windowStart, x, WALL_HEIGHT / 2, windowStart / 2)
    makeWall(wallThickness, WALL_HEIGHT, depth - windowEnd, x, WALL_HEIGHT / 2, windowEnd + (depth - windowEnd) / 2)
    makeWall(wallThickness, windowY - windowHeight / 2, windowWidth, x, (windowY - windowHeight / 2) / 2, windowZ)
    makeWall(wallThickness, WALL_HEIGHT - windowY - windowHeight / 2, windowWidth, x, windowY + windowHeight / 2 + (WALL_HEIGHT - windowY - windowHeight / 2) / 2, windowZ)
    makeTrim(0.09, windowHeight + 0.18, wallThickness + 0.05, x, windowY, windowStart - 0.045)
    makeTrim(0.09, windowHeight + 0.18, wallThickness + 0.05, x, windowY, windowEnd + 0.045)
    makeTrim(0.09, 0.09, windowWidth, x, windowY - windowHeight / 2 - 0.045, windowZ)
    makeTrim(0.09, 0.09, windowWidth, x, windowY + windowHeight / 2 + 0.045, windowZ)
    makeTrim(0.08, windowHeight, 0.07, x, windowY, windowZ)
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(windowWidth - 0.14, windowHeight - 0.14), new THREE.MeshStandardMaterial({ color: '#a9d6df', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, side: THREE.DoubleSide }))
    glass.position.set(x, windowY, windowZ)
    glass.rotation.y = Math.PI / 2
    root.add(glass)
  }
  sideWall(-wallThickness / 2)
  sideWall(width + wallThickness / 2)
  const door: Vec2 = { x: width / 2, z: depth - 0.6 }
  const doorWidth = 1.14
  const doorHeight = 2.22
  const doorLeft = width / 2 - doorWidth / 2
  const doorRight = width / 2 + doorWidth / 2
  makeWall(doorLeft, WALL_HEIGHT, wallThickness, doorLeft / 2, WALL_HEIGHT / 2, depth + wallThickness / 2)
  makeWall(width - doorRight, WALL_HEIGHT, wallThickness, doorRight + (width - doorRight) / 2, WALL_HEIGHT / 2, depth + wallThickness / 2)
  makeWall(doorWidth, WALL_HEIGHT - doorHeight, wallThickness, width / 2, doorHeight + (WALL_HEIGHT - doorHeight) / 2, depth + wallThickness / 2)
  makeTrim(0.1, doorHeight + 0.1, wallThickness + 0.08, doorLeft - 0.05, doorHeight / 2, depth)
  makeTrim(0.1, doorHeight + 0.1, wallThickness + 0.08, doorRight + 0.05, doorHeight / 2, depth)
  makeTrim(doorWidth + 0.2, 0.1, wallThickness + 0.08, width / 2, doorHeight + 0.05, depth)
  const doorPivot = new THREE.Group()
  doorPivot.position.set(doorLeft, 0, depth - 0.03)
  doorPivot.rotation.y = -1.08
  const doorLeaf = new THREE.Mesh(new THREE.BoxGeometry(doorWidth, doorHeight, 0.07), trimMaterial)
  doorLeaf.position.set(doorWidth / 2, doorHeight / 2, 0)
  doorLeaf.castShadow = true
  const handleMaterial = new THREE.MeshStandardMaterial({ color: '#b99151', roughness: 0.28, metalness: 0.78 })
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), handleMaterial)
  handle.position.set(doorWidth - 0.14, doorHeight * 0.48, -0.07)
  doorPivot.add(doorLeaf, handle)
  root.add(doorPivot)
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), wallMaterial)
  ceiling.position.set(width / 2, WALL_HEIGHT, depth / 2)
  ceiling.rotation.x = Math.PI / 2
  ceiling.receiveShadow = true
  root.add(ceiling)
  const ceilingStop = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }))
  ceilingStop.position.copy(ceiling.position)
  ceilingStop.rotation.copy(ceiling.rotation)
  root.add(ceilingStop)
  cameraObstacles.push(ceilingStop)
  for (const x of [width * 0.32, width * 0.68]) {
    const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.045, 20), new THREE.MeshStandardMaterial({ color: '#f5e2b8', emissive: '#ffd890', emissiveIntensity: 2.4, roughness: 0.38 }))
    fixture.position.set(x, WALL_HEIGHT - 0.04, depth * 0.5)
    root.add(fixture)
    const light = new THREE.PointLight('#ffd9a3', 8, Math.max(width, depth) * 0.72, 2)
    light.position.set(x, WALL_HEIGHT - 0.24, depth * 0.5)
    root.add(light)
  }
  const mat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 0.9), new THREE.MeshStandardMaterial({ color: '#3b8d6b', roughness: 1 }))
  mat.position.set(door.x, 0.02, depth - 0.45)
  mat.receiveShadow = true
  root.add(mat)
  if (venuePlan) root.add(createVenueDressing(venuePlan, spec.layout, furnitureDimensions))

  const placed = new Map<string, { object: THREE.Object3D; item: PlacedItem }>()
  const itemsGroup = new THREE.Group()
  root.add(itemsGroup)
  const outline = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.82, 32), new THREE.MeshBasicMaterial({ color: '#ffb020', depthTest: false, transparent: true }))
  outline.rotation.x = -Math.PI / 2
  outline.renderOrder = 4
  outline.visible = false
  root.add(outline)
  let generation = 0

  const place = (object: THREE.Object3D, item: PlacedItem): void => {
    const at = itemPosition(item)
    object.position.set(at.x, 0, at.z)
    object.rotation.y = -item.turns * (Math.PI / 2)
    object.userData.itemKey = item.key
  }

  const walkable = (point: Vec2): boolean => {
      if (point.x < 0.5 || point.x > width - 0.5 || point.z < 0.5 || point.z > depth - 0.3) return false
      for (const { item } of placed.values()) {
        if (!blocksWalking(item.model)) continue
        const at = itemPosition(item)
        const size = footprint(item.model, item.turns)
        if (Math.abs(point.x - at.x) < size.width / 2 + 0.25 && Math.abs(point.z - at.z) < size.depth / 2 + 0.25) return false
      }
      return true
    }

  return {
    root, spec, door, cameraObstacles, stations: venuePlan?.stations ?? [],
    setQuality(nextQuality) {
      if ((quality === 'low') === (nextQuality === 'low')) { quality = nextQuality; return }
      const replace = (old: THREE.MeshStandardMaterial, name: 'wood' | 'plaster'): THREE.MeshStandardMaterial => {
        const next = acquireSurface(name, nextQuality)
        next.color.copy(old.color); next.roughness = old.roughness; next.metalness = old.metalness
        root.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return
          object.material = Array.isArray(object.material) ? object.material.map(material => material === old ? next : material) : object.material === old ? next : object.material
        })
        old.dispose()
        return next
      }
      floorMaterial = replace(floorMaterial, 'wood')
      wallMaterial = replace(wallMaterial, 'plaster')
      trimMaterial = replace(trimMaterial, 'wood')
      quality = nextQuality
    },
    async setItems(items) {
      const mine = ++generation
      const wanted = new Map(items.map(item => [item.key, item]))
      for (const [key, entry] of placed) {
        const next = wanted.get(key)
        if (next && next.model === entry.item.model && JSON.stringify(next.tints) === JSON.stringify(entry.item.tints)) { place(entry.object, next); entry.item = next; continue }
        itemsGroup.remove(entry.object)
        placed.delete(key)
      }
      await Promise.all(items.filter(item => !placed.has(item.key) && isFurniture(item.model)).map(async item => {
        const object = await createFurniture(item)
        if (mine !== generation || placed.has(item.key)) return
        place(object, item)
        itemsGroup.add(object)
        placed.set(item.key, { object, item })
      }))
    },
    highlight(key) {
      const entry = key ? placed.get(key) : undefined
      outline.visible = Boolean(entry)
      if (!entry) return
      const size = footprint(entry.item.model, entry.item.turns)
      const radius = Math.max(size.width, size.depth) / 2 + 0.25
      outline.scale.setScalar(radius / 0.76)
      outline.position.set(entry.object.position.x, 0.03, entry.object.position.z)
    },
    itemAt(raycaster) {
      const hit = raycaster.intersectObjects(itemsGroup.children, true)[0]
      let node: THREE.Object3D | null = hit?.object ?? null
      while (node && !node.userData.itemKey) node = node.parent
      return (node?.userData.itemKey as string | undefined) ?? null
    },
    walkable,
    route(from, target) {
      const clearLine = (a: Vec2, b: Vec2): boolean => {
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.15)
        for (let i = 1; i <= steps; i++) if (!walkable({ x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps })) return false
        return true
      }
      if (walkable(target) && clearLine(from, target)) return [target]
      const columns = Math.floor(width / GRID), rows = Math.floor(depth / GRID)
      const points: Vec2[] = []
      const allowed: boolean[] = []
      for (let z = 0; z <= rows; z++) for (let x = 0; x <= columns; x++) {
        const point = { x: x * GRID, z: z * GRID }
        points.push(point); allowed.push(walkable(point))
      }
      let start = -1, bestStart = Infinity
      for (let i = 0; i < points.length; i++) {
        if (!allowed[i]) continue
        const gap = Math.hypot(points[i]!.x - from.x, points[i]!.z - from.z)
        if (gap < bestStart && gap < 1.5 && clearLine(from, points[i]!)) { start = i; bestStart = gap }
      }
      if (start < 0) return []
      const queue = [start], came = new Map<number, number>([[start, -1]])
      let nearest = start, gap = Infinity
      for (let head = 0; head < queue.length; head++) {
        const index = queue[head]!, point = points[index]!
        const distance = Math.hypot(point.x - target.x, point.z - target.z)
        if (distance < gap) { nearest = index; gap = distance }
        for (const offset of [-columns - 1, columns + 1, -1, 1]) {
          const next = index + offset
          const candidate = points[next]
          if (!candidate || !allowed[next] || came.has(next) || Math.hypot(candidate.x - point.x, candidate.z - point.z) > GRID + 0.01 || !clearLine(point, candidate)) continue
          came.set(next, index); queue.push(next)
        }
      }
      if (gap > 2) return []
      const path: Vec2[] = []
      for (let at = nearest; at !== -1; at = came.get(at) ?? -1) path.unshift(points[at]!)
      const result: Vec2[] = []
      let anchor = from
      while (path.length) {
        let next = path.length - 1
        while (next > 0 && !clearLine(anchor, path[next]!)) next--
        anchor = path[next]!; result.push(anchor); path.splice(0, next + 1)
      }
      // Grid routing must finish at an exact reachable interaction point.
      if (walkable(target) && clearLine(anchor, target) && Math.hypot(anchor.x - target.x, anchor.z - target.z) > 0.001) result.push({ ...target })
      return result
    },
    dispose() {
      generation++
      // Cached furniture geometry belongs to the pack, not this room.
      root.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return
        let parent = child.parent
        while (parent && parent !== itemsGroup) parent = parent.parent
        if (parent === itemsGroup) return
        child.geometry.dispose()
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const material of materials) {
          const ownedMaps: unknown = material.userData.ownedMaps
          if (Array.isArray(ownedMaps)) for (const map of ownedMaps) if (map instanceof THREE.Texture) map.dispose()
          material.dispose()
        }
      })
      root.removeFromParent()
    },
  }
}

/** A plausible room for a public venue, chosen by map category. It is a stand-in, not a survey. */
export function venueLayout(category: string, seed: number): HomeLayout {
  return createVenueLayout(category, seed)
}
