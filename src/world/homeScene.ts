// A home drawn from its plan: every room's floor, walls, doorways and ceiling, the front door, and
// the furniture standing in the rooms. `src/shared/homes.ts` is the authority for the plan; this
// file only draws it and says where a character can walk. Plan metres: +x east, +z south, the main
// room's north-west corner at the origin, the front door's outward heading a scene `rotation.y`.
//
// The geometry is batched: each room has one floor and one skin of wall in its own colours, and
// everything else (outer shell, trim, glass, ceilings, light fittings) is one mesh each, so a villa
// of eight rooms costs about twenty draws before furniture. Walls are drawn as a skin on the
// inside of every room, so two rooms that share a wall each show their own colour on their side.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Vec2 } from '../shared/geo.ts'
import { HOME_RULES, sharedWall } from '../shared/homes.ts'
import type { HomeDoor, HomePlan, HomeRoom, WallSide } from '../shared/homes.ts'
import type { PlacedItem } from '../shared/social.ts'
import type { Quality } from './districtScene.ts'
import type { InteriorScene, InteriorSpec } from './interior.ts'
import { acquireSurface } from './surfaceMaterials.ts'
import type { SurfaceName } from './surfaceMaterials.ts'

/** What the room needs from the furniture side of `interior.ts`, handed in so the two files do not import each other. */
export interface HomeSceneHooks {
  createFurniture(item: Pick<PlacedItem, 'model' | 'tints'>): Promise<THREE.Object3D>
  footprint(model: string, turns: number): { width: number; depth: number }
  isFurniture(model: string): boolean
  blocksWalking(model: string): boolean
  itemPosition(item: Pick<PlacedItem, 'x' | 'z'>): Vec2
  grid: number
  wallHeight: number
}

/** How a room outline drawn on the floor is to look: a room being added, one that cannot go there, the one picked, one going away. */
export type GhostLook = 'new' | 'blocked' | 'selected' | 'removed'
export interface HomeGhost {
  rooms: { x: number; z: number; width: number; depth: number; look: GhostLook }[]
  doors: { x: number; z: number; along: 'x' | 'z' }[]
}

const SKIN = 0.08
const SHELL = 0.14
const DOOR_HEIGHT = 2.22
const WINDOW = { sill: 1, top: 2.3, height: 1.3 }
const LEAF_OPEN = 1.08
// The service admits clear interior poses at half its 0.7 m separation, including beside the wall.
const ROOM_MARGIN = 0.35
const DOOR_BRIDGE = { half: 0.45, reach: 0.62 }
const MAX_LIGHTS = 4
/** How far in from the front wall a character is first stood: 2.8 m past where the door stands, as the App always did. */
const ENTRY_DEPTH = 3.4

type Along = 'x' | 'z'
export interface Opening { from: number; to: number; y0: number; y1: number }
export interface RoomSide { room: HomeRoom; side: WallSide; along: Along; line: number; from: number; to: number; inward: 1 | -1 }

const sidesOf = (room: HomeRoom): RoomSide[] => [
  { room, side: 'north', along: 'x', line: room.z, from: room.x, to: room.x + room.width, inward: 1 },
  { room, side: 'south', along: 'x', line: room.z + room.depth, from: room.x, to: room.x + room.width, inward: -1 },
  { room, side: 'west', along: 'z', line: room.x, from: room.z, to: room.z + room.depth, inward: 1 },
  { room, side: 'east', along: 'z', line: room.x + room.width, from: room.z, to: room.z + room.depth, inward: -1 },
]

/** The solid stretches of a wall from `from` to `to` once the openings are cut: [from, to, bottom, top]. */
export function wallPieces(from: number, to: number, openings: readonly Opening[], height: number): { from: number; to: number; y0: number; y1: number }[] {
  const pieces: { from: number; to: number; y0: number; y1: number }[] = []
  let cursor = from
  for (const opening of [...openings].sort((a, b) => a.from - b.from)) {
    if (opening.from > cursor) pieces.push({ from: cursor, to: opening.from, y0: 0, y1: height })
    if (opening.y0 > 0) pieces.push({ from: opening.from, to: opening.to, y0: 0, y1: opening.y0 })
    if (opening.y1 < height) pieces.push({ from: opening.from, to: opening.to, y0: opening.y1, y1: height })
    cursor = Math.max(cursor, opening.to)
  }
  if (cursor < to) pieces.push({ from: cursor, to, y0: 0, y1: height })
  return pieces
}

/** The stretches of a room's wall that no other room shares: the outside of the house. */
export function exteriorStretches(side: RoomSide, rooms: readonly HomeRoom[]): [number, number][] {
  const covered: [number, number][] = []
  for (const other of rooms) {
    if (other.id === side.room.id) continue
    const wall = sharedWall(side.room, other)
    if (wall && wall.along === side.along && wall.line === side.line) covered.push([wall.from, wall.to])
  }
  covered.sort((a, b) => a[0] - b[0])
  const open: [number, number][] = []
  let cursor = side.from
  for (const [from, to] of covered) {
    if (from > cursor) open.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < side.to) open.push([cursor, side.to])
  return open
}

/** Where a character may stand in this plan, ignoring furniture. Rooms keep a margin from their walls; a doorway is a short bridge between two rooms. */
export function planWalkable(plan: HomePlan, point: Vec2): boolean {
  for (const room of plan.rooms) {
    const front = plan.entrance.roomId === room.id ? plan.entrance.side : null
    const x0 = room.x + ROOM_MARGIN, x1 = room.x + room.width - ROOM_MARGIN
    const z0 = room.z + ROOM_MARGIN, z1 = room.z + room.depth - ROOM_MARGIN
    if (point.x >= x0 - (front === 'west' ? 0.2 : 0) && point.x <= x1 + (front === 'east' ? 0.2 : 0)
      && point.z >= z0 - (front === 'north' ? 0.2 : 0) && point.z <= z1 + (front === 'south' ? 0.2 : 0)) return true
  }
  for (const door of plan.doors) {
    const across = door.along === 'x' ? Math.abs(point.z - door.z) : Math.abs(point.x - door.x)
    const along = door.along === 'x' ? Math.abs(point.x - door.x) : Math.abs(point.z - door.z)
    if (along <= DOOR_BRIDGE.half && across <= DOOR_BRIDGE.reach) return true
  }
  return false
}

class Batch {
  private readonly parts: THREE.BufferGeometry[] = []
  add(geometry: THREE.BufferGeometry): void { this.parts.push(geometry) }
  /** Axis-aligned slab: `a0..a1` along the wall, `y0..y1` up, `p0..p1` across it. */
  slab(along: Along, a0: number, a1: number, y0: number, y1: number, p0: number, p1: number): void {
    const length = a1 - a0, height = y1 - y0, thick = p1 - p0
    const geometry = along === 'x' ? new THREE.BoxGeometry(length, height, thick) : new THREE.BoxGeometry(thick, height, length)
    if (along === 'x') geometry.translate((a0 + a1) / 2, (y0 + y1) / 2, (p0 + p1) / 2)
    else geometry.translate((p0 + p1) / 2, (y0 + y1) / 2, (a0 + a1) / 2)
    this.parts.push(geometry)
  }
  get empty(): boolean { return this.parts.length === 0 }
  mesh(material: THREE.Material, name: string, shadows: { cast: boolean; receive: boolean }): THREE.Mesh | null {
    if (!this.parts.length) return null
    const geometry = this.parts.length === 1 ? this.parts[0]! : mergeGeometries(this.parts, false)
    if (this.parts.length > 1) for (const part of this.parts) part.dispose()
    this.parts.length = 0
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.castShadow = shadows.cast
    mesh.receiveShadow = shadows.receive
    return mesh
  }
}

interface Tracked { material: THREE.MeshStandardMaterial; name: SurfaceName }

export function buildHomeScene(spec: InteriorSpec & { plan: HomePlan }, hooks: HomeSceneHooks, initialQuality: Quality = 'medium'): InteriorScene {
  let quality = initialQuality
  let plan = spec.plan
  const height = hooks.wallHeight
  const root = new THREE.Group()
  root.name = `interior ${spec.title}`
  const cameraObstacles: THREE.Object3D[] = []
  const surfaces: Tracked[] = []
  const surface = (name: SurfaceName, colour: string, mix: number, roughness: number): THREE.MeshStandardMaterial => {
    const material = acquireSurface(name, quality)
    material.color.copy(new THREE.Color(colour).lerp(new THREE.Color('#ffffff'), mix))
    material.roughness = roughness
    surfaces.push({ material, name })
    return material
  }

  // Everything that depends on the plan lives in `structure`, so a change to the rooms replaces it whole.
  let structure: THREE.Group | null = null
  let walls: THREE.Group | null = null
  let ceiling: THREE.Mesh | null = null
  let fixtures: THREE.Mesh | null = null
  let cutaway = false
  const lights: THREE.PointLight[] = []

  const releaseObject = (object: THREE.Object3D): void => {
    object.traverse(child => {
      if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.LineSegments) && !(child instanceof THREE.LineLoop)) return
      child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const material of materials) {
        const ownedMaps: unknown = material.userData.ownedMaps
        if (Array.isArray(ownedMaps)) for (const map of ownedMaps) if (map instanceof THREE.Texture) map.dispose()
        material.dispose()
      }
    })
  }

  const clearStructure = (): void => {
    if (structure) { root.remove(structure); releaseObject(structure) }
    for (const light of lights) root.remove(light)
    lights.length = 0
    surfaces.length = 0
    cameraObstacles.length = 0
    structure = walls = null
    ceiling = fixtures = null
  }

  /** Where a character is first stood on stepping in, or at the door itself when the room is too small for that. */
  const entryFor = (from: HomePlan): { pos: Vec2; heading: number } => {
    const { x, z, inside } = from.entrance
    const length = Math.hypot(inside.pos.x - x, inside.pos.z - z) || 1
    const further = { x: x + (inside.pos.x - x) / length * ENTRY_DEPTH, z: z + (inside.pos.z - z) / length * ENTRY_DEPTH }
    return { pos: planWalkable(from, further) ? further : { ...inside.pos }, heading: inside.heading }
  }
  const door: Vec2 = { ...plan.entrance.inside.pos }
  const entry = entryFor(plan)

  function buildStructure(): void {
    clearStructure()
    structure = new THREE.Group()
    structure.name = 'rooms'
    walls = new THREE.Group()
    walls.name = 'walls'
    structure.add(walls)
    const trim = new Batch(), glass = new Batch(), brass = new Batch(), shell = new Batch(), ceilings = new Batch(), fittings = new Batch(), mats = new Batch()
    const doorLeaves: { door: HomeDoor | null; side: RoomSide; at: number }[] = []

    const doorsOnSide = (side: RoomSide): { door: HomeDoor | null; at: number }[] => {
      const found: { door: HomeDoor | null; at: number }[] = []
      for (const door of plan.doors) {
        if (door.a !== side.room.id && door.b !== side.room.id) continue
        if (door.along !== side.along) continue
        const line = side.along === 'x' ? door.z : door.x, at = side.along === 'x' ? door.x : door.z
        if (line === side.line) found.push({ door, at })
      }
      if (plan.entrance.roomId === side.room.id && plan.entrance.side === side.side) found.push({ door: null, at: side.along === 'x' ? plan.entrance.x : plan.entrance.z })
      return found
    }

    const frame = (side: RoomSide, at: number, y0: number, y1: number, half: number): void => {
      // A frame through the wall: two posts, a head, and a sill when the opening does not reach the floor.
      const reach = SKIN + SHELL + 0.04
      const p0 = side.line - reach, p1 = side.line + reach
      trim.slab(side.along, at - half - 0.1, at - half, y0, y1 + 0.1, p0, p1)
      trim.slab(side.along, at + half, at + half + 0.1, y0, y1 + 0.1, p0, p1)
      trim.slab(side.along, at - half - 0.1, at + half + 0.1, y1, y1 + 0.1, p0, p1)
      if (y0 > 0) trim.slab(side.along, at - half - 0.1, at + half + 0.1, y0 - 0.08, y0, p0, p1 + 0.06)
    }

    for (const room of plan.rooms) {
      const kind = room.kind
      const wet = kind === 'kitchen' || kind === 'bathroom'
      const floorMaterial = surface(wet ? 'concrete' : 'wood', room.floor, wet ? 0.45 : 0.58, wet ? 0.5 : 0.72)
      const floor = new THREE.Mesh(new THREE.BoxGeometry(room.width, 0.2, room.depth), floorMaterial)
      floor.position.set(room.x + room.width / 2, -0.1, room.z + room.depth / 2)
      floor.receiveShadow = true
      floor.name = `floor ${room.id}`
      structure.add(floor)

      const skin = new Batch()
      for (const side of sidesOf(room)) {
        const openings: Opening[] = []
        const here = doorsOnSide(side)
        for (const entryDoor of here) openings.push({ from: entryDoor.at - HOME_RULES.doorWidth / 2, to: entryDoor.at + HOME_RULES.doorWidth / 2, y0: 0, y1: DOOR_HEIGHT })
        const outside = exteriorStretches(side, plan.rooms)
        const windows: Opening[] = []
        const hasFront = here.some(entryDoor => entryDoor.door === null)
        for (const [from, to] of outside) {
          const length = to - from
          if (hasFront && here.some(entryDoor => entryDoor.door === null && entryDoor.at >= from && entryDoor.at <= to)) continue
          const count = Math.min(3, Math.floor(length / 3.2))
          for (let index = 0; index < count; index++) {
            const centre = from + length * (index + 0.5) / count
            const half = Math.min(0.9, length / count / 2 - 0.5)
            if (half < 0.4) continue
            // Windows keep clear of a door in the same stretch of wall.
            if (here.some(entryDoor => Math.abs(entryDoor.at - centre) < half + HOME_RULES.doorWidth / 2 + 0.5)) continue
            windows.push({ from: centre - half, to: centre + half, y0: WINDOW.sill, y1: WINDOW.top })
          }
        }
        const cuts = [...openings, ...windows]
        // The room's own skin, on its side of the wall. Side walls stop short of the corners the north and south walls already fill.
        const trimEnds = side.along === 'x' ? 0 : SKIN
        const lo = side.from + trimEnds, hi = side.to - trimEnds
        const inner = side.inward === 1 ? [side.line, side.line + SKIN] as const : [side.line - SKIN, side.line] as const
        for (const piece of wallPieces(lo, hi, cuts, height)) skin.slab(side.along, piece.from, piece.to, piece.y0, piece.y1, inner[0], inner[1])
        // The outside of the house on stretches no other room shares.
        const outer = side.inward === 1 ? [side.line - SHELL, side.line] as const : [side.line, side.line + SHELL] as const
        for (const [from, to] of outside) {
          const stretch = cuts.filter(cut => cut.to > from && cut.from < to)
          // North and south walls reach round the outside corner so the shell has no notch there, unless another room is in the way.
          const free = (x: number): boolean => !plan.rooms.some(other => x < other.x + other.width && other.x < x + SHELL && outer[0] < other.z + other.depth && other.z < outer[0] + SHELL)
          const reachFrom = side.along === 'x' && from === side.from && free(from - SHELL) ? from - SHELL : from
          const reachTo = side.along === 'x' && to === side.to && free(to) ? to + SHELL : to
          for (const piece of wallPieces(reachFrom, reachTo, stretch, height)) shell.slab(side.along, piece.from, piece.to, piece.y0, piece.y1, outer[0], outer[1])
        }
        for (const entryDoor of here) {
          frame(side, entryDoor.at, 0, DOOR_HEIGHT, HOME_RULES.doorWidth / 2)
          if (entryDoor.door === null || entryDoor.door.a === room.id) doorLeaves.push({ door: entryDoor.door, side, at: entryDoor.at })
        }
        for (const window of windows) {
          const centre = (window.from + window.to) / 2, half = (window.to - window.from) / 2
          frame(side, centre, WINDOW.sill, WINDOW.top, half)
          trim.slab(side.along, centre - 0.03, centre + 0.03, WINDOW.sill, WINDOW.top, side.line - 0.05, side.line + 0.05)
          const pane = new THREE.PlaneGeometry(half * 2 - 0.06, WINDOW.height - 0.06)
          if (side.along === 'z') pane.rotateY(Math.PI / 2)
          pane.translate(side.along === 'x' ? centre : side.line, (WINDOW.sill + WINDOW.top) / 2, side.along === 'x' ? side.line : centre)
          glass.add(pane)
        }
      }
      const wallMaterial = surface('plaster', room.wall, 0.34, 0.92)
      const skinMesh = skin.mesh(wallMaterial, `walls ${room.id}`, { cast: true, receive: true })
      if (skinMesh) { walls.add(skinMesh); cameraObstacles.push(skinMesh) }

      const top = new THREE.PlaneGeometry(room.width, room.depth)
      top.rotateX(Math.PI / 2)
      top.translate(room.x + room.width / 2, height, room.z + room.depth / 2)
      ceilings.add(top)
      const fittingCount = room.width * room.depth >= 80 ? 2 : 1
      for (let index = 0; index < fittingCount; index++) {
        const fitting = new THREE.CylinderGeometry(0.22, 0.22, 0.045, 20)
        const share = fittingCount === 1 ? 0.5 : index === 0 ? 0.32 : 0.68
        fitting.translate(room.x + room.width * share, height - 0.04, room.z + room.depth / 2)
        fittings.add(fitting)
      }
    }

    // Door leaves, swung part-way open into the room they belong to. The front door opens inward.
    for (const leaf of doorLeaves) {
      const { side } = leaf
      const alongX = side.along === 'x'
      const width = HOME_RULES.doorWidth - 0.06
      const swing = side.inward
      // The leaf is built along local +x from its hinge, then turned so it ends up pointing into the room.
      const direction = alongX ? { x: Math.cos(LEAF_OPEN), z: Math.sin(LEAF_OPEN) * swing } : { x: Math.sin(LEAF_OPEN) * swing, z: Math.cos(LEAF_OPEN) }
      const angle = Math.atan2(-direction.z, direction.x)
      const hinge = leaf.at - HOME_RULES.doorWidth / 2
      const origin = { x: alongX ? hinge : side.line, z: alongX ? side.line : hinge }
      const leafGeometry = new THREE.BoxGeometry(width, DOOR_HEIGHT - 0.04, 0.05)
      leafGeometry.translate(width / 2, (DOOR_HEIGHT - 0.04) / 2, 0)
      leafGeometry.rotateY(angle)
      leafGeometry.translate(origin.x, 0, origin.z)
      trim.add(leafGeometry)
      const knob = new THREE.Vector3(width - 0.14, DOOR_HEIGHT * 0.48, 0.05).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle)
      brass.add(new THREE.SphereGeometry(0.055, 12, 8).translate(origin.x + knob.x, knob.y, origin.z + knob.z))
    }

    // The mat just inside the front door, a little nearer the door than where a character first stands.
    {
      const front = plan.entrance
      const matGeometry = front.side === 'north' || front.side === 'south' ? new THREE.BoxGeometry(1.8, 0.04, 0.9) : new THREE.BoxGeometry(0.9, 0.04, 1.8)
      matGeometry.translate(front.inside.pos.x + (front.x - front.inside.pos.x) * 0.25, 0.02, front.inside.pos.z + (front.z - front.inside.pos.z) * 0.25)
      mats.add(matGeometry)
    }

    const wallMaterial = surface('plaster', '#e6dccb', 0.2, 0.92)
    const trimMaterial = surface('wood', '#68452f', 0, 0.68)
    const shellMesh = shell.mesh(wallMaterial, 'shell', { cast: true, receive: true })
    if (shellMesh) { walls.add(shellMesh); cameraObstacles.push(shellMesh) }
    const trimMesh = trim.mesh(trimMaterial, 'trim', { cast: true, receive: false })
    if (trimMesh) walls.add(trimMesh)
    const brassMesh = brass.mesh(new THREE.MeshStandardMaterial({ color: '#b99151', roughness: 0.28, metalness: 0.78 }), 'handles', { cast: false, receive: false })
    if (brassMesh) walls.add(brassMesh)
    const glassMesh = glass.mesh(new THREE.MeshStandardMaterial({ color: '#a9d6df', roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }), 'glass', { cast: false, receive: false })
    if (glassMesh) walls.add(glassMesh)
    const matMesh = mats.mesh(new THREE.MeshStandardMaterial({ color: '#3b8d6b', roughness: 1 }), 'door mat', { cast: false, receive: true })
    if (matMesh) structure.add(matMesh)

    // The ceiling is a roof for the camera too: it never looks down through it.
    const ceilingMesh = ceilings.mesh(wallMaterial, 'ceiling', { cast: false, receive: true })
    if (ceilingMesh) { ceiling = ceilingMesh; structure.add(ceilingMesh); cameraObstacles.push(ceilingMesh) }
    const fixtureMesh = fittings.mesh(new THREE.MeshStandardMaterial({ color: '#f5e2b8', emissive: '#ffd890', emissiveIntensity: 2.4, roughness: 0.38 }), 'light fittings', { cast: false, receive: false })
    if (fixtureMesh) { fixtures = fixtureMesh; structure.add(fixtureMesh) }

    // A light or two for the biggest rooms: each light costs every lit surface, so the number stays small.
    const ordered = [...plan.rooms].sort((a, b) => b.width * b.depth - a.width * a.depth).slice(0, plan.rooms.length === 1 ? 1 : MAX_LIGHTS)
    for (const room of ordered) {
      const spots = plan.rooms.length === 1 ? [0.32, 0.68] : [0.5]
      for (const share of spots) {
        const light = new THREE.PointLight('#ffd9a3', plan.rooms.length === 1 ? 8 : 9, Math.max(room.width, room.depth) * 0.9 + 2, 2)
        light.position.set(room.x + room.width * share, height - 0.24, room.z + room.depth / 2)
        lights.push(light)
        root.add(light)
      }
    }
    root.add(structure)
    applyCutaway()
  }

  function applyCutaway(): void {
    if (walls) walls.scale.y = cutaway ? 0.3 : 1
    if (ceiling) ceiling.visible = !cutaway
    if (fixtures) fixtures.visible = !cutaway
    const stopped = ceiling ? cameraObstacles.indexOf(ceiling) : -1
    if (ceiling && cutaway && stopped >= 0) cameraObstacles.splice(stopped, 1)
    if (ceiling && !cutaway && stopped < 0) cameraObstacles.push(ceiling)
  }

  // ── Furniture ──
  const placed = new Map<string, { object: THREE.Object3D; item: PlacedItem }>()
  const itemsGroup = new THREE.Group()
  root.add(itemsGroup)
  const outline = new THREE.Mesh(new THREE.RingGeometry(0.7, 0.82, 32), new THREE.MeshBasicMaterial({ color: '#ffb020', depthTest: false, transparent: true }))
  outline.rotation.x = -Math.PI / 2
  outline.renderOrder = 4
  outline.visible = false
  root.add(outline)
  let generation = 0
  let gridCache: { points: Vec2[]; allowed: boolean[]; columns: number } | null = null

  const place = (object: THREE.Object3D, item: PlacedItem): void => {
    const at = hooks.itemPosition(item)
    object.position.set(at.x, 0, at.z)
    object.rotation.y = -item.turns * (Math.PI / 2)
    object.userData.itemKey = item.key
  }

  const walkable = (point: Vec2): boolean => {
    if (!planWalkable(plan, point)) return false
    for (const { item } of placed.values()) {
      if (!hooks.blocksWalking(item.model)) continue
      const at = hooks.itemPosition(item)
      const size = hooks.footprint(item.model, item.turns)
      if (Math.abs(point.x - at.x) < size.width / 2 + 0.25 && Math.abs(point.z - at.z) < size.depth / 2 + 0.25) return false
    }
    return true
  }

  const clearLine = (a: Vec2, b: Vec2): boolean => {
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.15)
    for (let step = 1; step <= steps; step++) if (!walkable({ x: a.x + (b.x - a.x) * step / steps, z: a.z + (b.z - a.z) * step / steps })) return false
    return true
  }

  const gridOf = (): { points: Vec2[]; allowed: boolean[]; columns: number } => {
    if (gridCache) return gridCache
    const { bounds } = plan
    const columns = Math.floor(bounds.width / hooks.grid), rows = Math.floor(bounds.depth / hooks.grid)
    const points: Vec2[] = [], allowed: boolean[] = []
    for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
      const point = { x: bounds.x + column * hooks.grid, z: bounds.z + row * hooks.grid }
      points.push(point); allowed.push(walkable(point))
    }
    return (gridCache = { points, allowed, columns })
  }

  const scene: InteriorScene & { door: Vec2 } = {
    root, spec, door, cameraObstacles, stations: [], entry,
    plan: () => plan,
    setQuality(next) {
      if ((quality === 'low') === (next === 'low')) { quality = next; return }
      quality = next
      for (const entryOf of surfaces) {
        const old = entryOf.material
        const replacement = acquireSurface(entryOf.name, quality)
        replacement.color.copy(old.color); replacement.roughness = old.roughness; replacement.metalness = old.metalness
        root.traverse(object => {
          if (!(object instanceof THREE.Mesh)) return
          object.material = Array.isArray(object.material) ? object.material.map(material => material === old ? replacement : material) : object.material === old ? replacement : object.material
        })
        old.dispose()
        entryOf.material = replacement
      }
    },
    setPlan(next) {
      plan = next
      gridCache = null
      door.x = next.entrance.inside.pos.x; door.z = next.entrance.inside.pos.z
      const stepIn = entryFor(next)
      entry.pos = stepIn.pos; entry.heading = stepIn.heading
      buildStructure()
      scene.setGhost?.(null)
    },
    setCutaway(on) { cutaway = on; applyCutaway() },
    async setItems(items) {
      const mine = ++generation
      gridCache = null
      const wanted = new Map(items.map(item => [item.key, item]))
      for (const [key, entryOf] of placed) {
        const next = wanted.get(key)
        if (next && next.model === entryOf.item.model && JSON.stringify(next.tints) === JSON.stringify(entryOf.item.tints)) { place(entryOf.object, next); entryOf.item = next; continue }
        itemsGroup.remove(entryOf.object)
        placed.delete(key)
      }
      await Promise.all(items.filter(item => !placed.has(item.key) && hooks.isFurniture(item.model)).map(async item => {
        const object = await hooks.createFurniture(item)
        if (mine !== generation || placed.has(item.key)) return
        place(object, item)
        itemsGroup.add(object)
        placed.set(item.key, { object, item })
        gridCache = null
      }))
    },
    highlight(key) {
      const entryOf = key ? placed.get(key) : undefined
      outline.visible = Boolean(entryOf)
      if (!entryOf) return
      const size = hooks.footprint(entryOf.item.model, entryOf.item.turns)
      const radius = Math.max(size.width, size.depth) / 2 + 0.25
      outline.scale.setScalar(radius / 0.76)
      outline.position.set(entryOf.object.position.x, 0.03, entryOf.object.position.z)
    },
    itemAt(raycaster) {
      const hit = raycaster.intersectObjects(itemsGroup.children, true)[0]
      let node: THREE.Object3D | null = hit?.object ?? null
      while (node && !node.userData.itemKey) node = node.parent
      return (node?.userData.itemKey as string | undefined) ?? null
    },
    walkable,
    route(from, target) {
      if (walkable(target) && clearLine(from, target)) return [target]
      const { points, allowed, columns } = gridOf()
      let start = -1, bestStart = Infinity
      for (let index = 0; index < points.length; index++) {
        if (!allowed[index]) continue
        const gap = Math.hypot(points[index]!.x - from.x, points[index]!.z - from.z)
        if (gap < bestStart && gap < 1.5 && clearLine(from, points[index]!)) { start = index; bestStart = gap }
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
          if (!candidate || !allowed[next] || came.has(next) || Math.hypot(candidate.x - point.x, candidate.z - point.z) > hooks.grid + 0.01 || !clearLine(point, candidate)) continue
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
      if (walkable(target) && clearLine(anchor, target) && Math.hypot(anchor.x - target.x, anchor.z - target.z) > 0.001) result.push({ ...target })
      return result
    },
    dispose() {
      generation++
      clearStructure()
      setGhost(null)
      for (const material of ghostMaterials.values()) material.dispose()
      ghostMaterials.clear()
      outline.geometry.dispose()
      ;(outline.material as THREE.Material).dispose()
      // Cached furniture geometry belongs to the pack, not this room.
      root.removeFromParent()
    },
  }

  // ── Outlines for a room being planned ──
  const ghostMaterials = new Map<string, THREE.Material>()
  const ghostGroup = new THREE.Group()
  ghostGroup.name = 'plan preview'
  root.add(ghostGroup)
  const ghostLook: Record<GhostLook, { colour: string; opacity: number }> = {
    new: { colour: '#3fae7a', opacity: 0.38 }, blocked: { colour: '#e4584a', opacity: 0.4 },
    selected: { colour: '#ffb020', opacity: 0.3 }, removed: { colour: '#e4584a', opacity: 0.22 },
  }
  const ghostFill = (look: GhostLook): THREE.Material => {
    let material = ghostMaterials.get(look)
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color: ghostLook[look].colour, transparent: true, opacity: ghostLook[look].opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
      ghostMaterials.set(look, material)
    }
    return material
  }
  const ghostLine = (look: GhostLook): THREE.Material => {
    const key = `line:${look}`
    let material = ghostMaterials.get(key)
    if (!material) { material = new THREE.LineBasicMaterial({ color: ghostLook[look].colour, depthTest: false, transparent: true }); ghostMaterials.set(key, material) }
    return material
  }
  function setGhost(ghost: HomeGhost | null): void {
    for (const child of [...ghostGroup.children]) {
      ghostGroup.remove(child)
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose()
    }
    if (!ghost) return
    for (const room of ghost.rooms) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(room.width, room.depth).rotateX(-Math.PI / 2), ghostFill(room.look))
      plate.position.set(room.x + room.width / 2, 0.03, room.z + room.depth / 2)
      plate.renderOrder = 3
      ghostGroup.add(plate)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(room.width, 0.9, room.depth)), ghostLine(room.look))
      edges.position.set(room.x + room.width / 2, 0.45, room.z + room.depth / 2)
      edges.renderOrder = 5
      ghostGroup.add(edges)
    }
    for (const doorway of ghost.doors) {
      const post = new THREE.Mesh(doorway.along === 'x' ? new THREE.BoxGeometry(HOME_RULES.doorWidth, 0.08, 0.3) : new THREE.BoxGeometry(0.3, 0.08, HOME_RULES.doorWidth), ghostFill('new'))
      post.position.set(doorway.x, 0.05, doorway.z)
      post.renderOrder = 4
      ghostGroup.add(post)
    }
  }
  scene.setGhost = setGhost

  buildStructure()
  return scene
}
