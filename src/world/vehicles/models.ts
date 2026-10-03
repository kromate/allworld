// Three.js models for the vehicles of a Lagos street: keke, danfo and car. Rendering only. This
// file builds shapes and moves wheels, doors and the steering; who owns a vehicle, who sits where,
// how it drives and what it costs are decided elsewhere and arrive here as plain numbers.
//
//   const danfo = createVehicleModel('danfo', 'near')
//   scene.add(danfo.root)                          // origin: on the ground, halfway between the axles; +Z forward, +X left
//   danfo.update({ steering: 0.2, wheelRotation: distance / radius, doors: { side: 1 } })
//   danfo.anchors.seats                            // driver, passenger-1 ... : mount (pelvis), entryId
//   danfo.anchors.driverHands.left                 // follows the wheel
//   danfo.boardingRoute('passenger-4')             // outside → step → threshold → aisle
//   danfo.dispose()                                // when the scene is torn down: disposeVehicleModels()
//
// Geometry and materials are made once per kind and shared by every model of that kind, so ten keke
// are ten sets of nodes and one set of geometry. `createVehicleModel` uses one shared kit that lives
// until `disposeVehicleModels()`; `createVehicleKit()` gives a scene its own. See docs/transport/VEHICLE-MODELS.md.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { MaterialKey } from './model/builder.ts'
import { BAKED, createMaterials } from './model/materials.ts'
import { buildCar, CAR_LAYOUT } from './model/car.ts'
import { buildDanfo, DANFO_LAYOUT } from './model/danfo.ts'
import { buildKeke, KEKE_LAYOUT } from './model/keke.ts'
import { forkAngleForYaw, wheelGeometry } from './model/parts.ts'
import type { Blueprint } from './model/parts.ts'
import type {
  PaintName, Vec3, VehicleDetail, VehicleKind, VehicleKit, VehicleKitStats, VehicleLayout, VehicleModel, VehicleModelEntry, VehicleModelSeat, VehicleVisualState,
} from './model/types.ts'

export { SEATED_HEAD, SIT_DROP, SIT_HIP } from './model/types.ts'
export type {
  PaintName, Vec3, VehicleAnchorPose, VehicleDetail, VehicleDoor, VehicleEntry, VehicleKind, VehicleKit, VehicleKitStats,
  VehicleLayout, VehicleModel, VehicleModelEntry, VehicleModelSeat, VehicleSeat, VehicleVisualState, VehicleWheel,
} from './model/types.ts'

export const VEHICLE_KINDS: readonly VehicleKind[] = ['keke', 'danfo', 'car']

/** Metres the authored frame is moved back so the model's origin is halfway between its axles. */
function axleShift(layout: VehicleLayout): number {
  const zs = layout.wheels.map(wheel => wheel.position.z)
  return -(Math.max(...zs) + Math.min(...zs)) / 2
}
const shiftPoint = (point: Vec3, dz: number): Vec3 => ({ x: point.x, y: point.y, z: point.z + dz })
function shiftLayout(layout: VehicleLayout, dz: number): VehicleLayout {
  return {
    ...layout,
    seats: layout.seats.map(seat => ({ ...seat, position: shiftPoint(seat.position, dz), mount: shiftPoint(seat.mount, dz), via: seat.via.map(point => shiftPoint(point, dz)) })),
    entries: layout.entries.map(entry => ({ ...entry, outside: shiftPoint(entry.outside, dz), steps: entry.steps.map(point => shiftPoint(point, dz)), threshold: shiftPoint(entry.threshold, dz) })),
    doors: layout.doors.map(door => ({ ...door, pivot: shiftPoint(door.pivot, dz) })),
    wheels: layout.wheels.map(wheel => ({ ...wheel, position: shiftPoint(wheel.position, dz) })),
  }
}
const SHIFTED: Record<VehicleKind, VehicleLayout> = {
  keke: shiftLayout(KEKE_LAYOUT, axleShift(KEKE_LAYOUT)), danfo: shiftLayout(DANFO_LAYOUT, axleShift(DANFO_LAYOUT)), car: shiftLayout(CAR_LAYOUT, axleShift(CAR_LAYOUT)),
}

/** Seats, entries, doors and wheels of a kind, in the model's own frame. No geometry is made: a service can count seats from this. */
export function vehicleLayout(kind: VehicleKind): VehicleLayout { return SHIFTED[kind] }

/** How far a sliding door first moves out from the body, metres, before it runs back. */
const SLIDE_OUT = 0.08
const WHEEL_SEGMENTS = { near: 18, reduced: 10 }

interface Built {
  blueprint: Blueprint
  body: Map<MaterialKey, THREE.BufferGeometry>
  doors: Map<string, Map<MaterialKey, THREE.BufferGeometry>>
  steer: Map<MaterialKey, THREE.BufferGeometry>
  /** Everything the far silhouette draws other than the paint, with colour in the vertices. */
  farRest: THREE.BufferGeometry
  farPaint: THREE.BufferGeometry | null
  wheels: Map<string, THREE.BufferGeometry>
  triangles: { near: number; far: number }
}

function triangles(geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
}

function bake(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const colour = new THREE.Color(hex)
  const count = geometry.getAttribute('position').count
  const values = new Float32Array(count * 3)
  for (let index = 0; index < count; index++) { values[index * 3] = colour.r; values[index * 3 + 1] = colour.g; values[index * 3 + 2] = colour.b }
  geometry.setAttribute('color', new THREE.BufferAttribute(values, 3))
  return geometry
}

function mergeOrThrow(list: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const merged = mergeGeometries(list, false)
  if (!merged) throw new Error(`Vehicle model: could not merge ${label}`)
  merged.computeBoundingSphere()
  return merged
}

function build(kind: VehicleKind): Built {
  const blueprint = kind === 'keke' ? buildKeke() : kind === 'danfo' ? buildDanfo() : buildCar()
  const layout = blueprint.layout
  const body = blueprint.body.merged()
  const steer = blueprint.steer.merged()
  const doors = new Map<string, Map<MaterialKey, THREE.BufferGeometry>>()
  const wheels = new Map<string, THREE.BufferGeometry>()
  const paintFar: THREE.BufferGeometry[] = []
  const restFar: THREE.BufferGeometry[] = []

  const collectFar = (source: Map<MaterialKey, THREE.BufferGeometry>, at: Vec3 | null): void => {
    for (const [key, geometry] of source) {
      const copy = geometry.clone()
      if (at) copy.translate(at.x, at.y, at.z)
      if (key === 'paint') paintFar.push(copy)
      else restFar.push(bake(copy, BAKED[key]))
    }
  }
  collectFar(blueprint.body.mergedFar(), null)
  for (const door of layout.doors) {
    const pieces = blueprint.doors.get(door.id)
    if (!pieces) continue
    doors.set(door.id, pieces.merged())
    // Closed doors belong to the silhouette, at their resting place.
    collectFar(pieces.mergedFar(), door.pivot)
  }
  for (const wheel of layout.wheels) {
    const key = `${wheel.radius}:${wheel.width}`
    if (!wheels.has(key)) wheels.set(key, wheelGeometry(wheel.radius, wheel.width, WHEEL_SEGMENTS.near, true))
    // The silhouette gets plain, coarse wheels, fixed in place.
    restFar.push(wheelGeometry(wheel.radius, wheel.width, WHEEL_SEGMENTS.reduced, false).translate(wheel.position.x, wheel.position.y, wheel.position.z))
  }
  const farRest = mergeOrThrow(restFar, `${kind} silhouette`)
  const farPaint = paintFar.length ? mergeOrThrow(paintFar, `${kind} silhouette paint`) : null
  for (const geometry of [...restFar, ...paintFar]) geometry.dispose()

  let near = 0
  for (const geometry of body.values()) near += triangles(geometry)
  for (const geometry of steer.values()) near += triangles(geometry)
  for (const set of doors.values()) for (const geometry of set.values()) near += triangles(geometry)
  for (const wheel of layout.wheels) near += triangles(wheels.get(`${wheel.radius}:${wheel.width}`)!)
  blueprint.body.release(); blueprint.steer.release()
  for (const pieces of blueprint.doors.values()) pieces.release()
  return { blueprint, body, doors, steer, farRest, farPaint, wheels, triangles: { near, far: triangles(farRest) + (farPaint ? triangles(farPaint) : 0) } }
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0))
const scratchMatrix = new THREE.Matrix4()
const scratchInverse = new THREE.Matrix4()
const scratchScale = new THREE.Vector3()

export function createVehicleKit(): VehicleKit {
  const materials = createMaterials()
  const built = new Map<VehicleKind, Built>()
  let live = 0
  let disposed = false

  const builtFor = (kind: VehicleKind): Built => {
    let entry = built.get(kind)
    if (!entry) { entry = build(kind); built.set(kind, entry) }
    return entry
  }

  function create(kind: VehicleKind, options: { paint?: PaintName; detail?: VehicleDetail } = {}): VehicleModel {
    if (disposed) throw new Error('Vehicle kit has been disposed')
    const source = builtFor(kind)
    // Nodes are built where the geometry was authored and the whole content is moved back to put the
    // origin between the axles; the public layout and the anchors are already in that final frame.
    const authored = source.blueprint.layout
    const layout = SHIFTED[kind]
    const paint = options.paint ?? layout.paint
    const root = new THREE.Group()
    root.name = `vehicle:${kind}`
    const content = new THREE.Group()
    content.name = 'content'
    content.position.z = axleShift(authored)
    const near = new THREE.Group(), reduced = new THREE.Group()
    near.name = 'near'; reduced.name = 'reduced'
    content.add(near, reduced)
    root.add(content)

    const meshes = (parent: THREE.Object3D, set: Map<MaterialKey, THREE.BufferGeometry>, label: string): void => {
      for (const [key, geometry] of set) {
        const mesh = new THREE.Mesh(geometry, key === 'paint' ? materials.paint(paint) : materials.surface(key))
        mesh.name = `${label}:${key}`
        parent.add(mesh)
      }
    }

    meshes(near, source.body, 'body')
    if (source.farPaint) { const mesh = new THREE.Mesh(source.farPaint, materials.paint(paint)); mesh.name = 'reduced:paint'; reduced.add(mesh) }
    { const mesh = new THREE.Mesh(source.farRest, materials.baked); mesh.name = 'reduced:rest'; reduced.add(mesh) }

    // Steering: a frame at the column (or the front wheel's centre) and a spinner inside it that turns.
    const frame = new THREE.Group()
    frame.name = 'steering frame'
    const { steerFrame, anchors } = source.blueprint
    frame.position.set(steerFrame.position.x, steerFrame.position.y, steerFrame.position.z)
    frame.quaternion.copy(steerFrame.quaternion)
    const spinner = new THREE.Group()
    spinner.name = 'steering'
    const steerAxis = new THREE.Vector3(steerFrame.axis.x, steerFrame.axis.y, steerFrame.axis.z).normalize()
    frame.add(spinner)
    meshes(spinner, source.steer, 'steering')
    near.add(frame)

    // Wheels: a pivot that steers, and a spinner inside it that rolls.
    const pivots = new Map<string, THREE.Group>()
    const spinners: THREE.Group[] = []
    for (const wheel of authored.wheels) {
      const pivot = new THREE.Group()
      pivot.name = `wheel:${wheel.id}`
      const spin = new THREE.Group()
      spin.name = `roll:${wheel.id}`
      const mesh = new THREE.Mesh(source.wheels.get(`${wheel.radius}:${wheel.width}`)!, materials.wheel)
      mesh.name = `tyre:${wheel.id}`
      spin.add(mesh); pivot.add(spin)
      if (wheel.id === source.blueprint.steerWheel) spinner.add(pivot)
      else { pivot.position.set(wheel.position.x, wheel.position.y, wheel.position.z); near.add(pivot) }
      pivots.set(wheel.id, pivot)
      spinners.push(spin)
    }

    // Doors: a node at the pivot holding the panel.
    const doorNodes = new Map<string, THREE.Group>()
    for (const door of authored.doors) {
      const node = new THREE.Group()
      node.name = `door:${door.id}`
      node.position.set(door.pivot.x, door.pivot.y, door.pivot.z)
      const set = source.doors.get(door.id)
      if (set) meshes(node, set, `door ${door.id}`)
      near.add(node)
      doorNodes.set(door.id, node)
    }

    // Anchors that move: hands and handles.
    const anchorNodes = new Map<string, THREE.Object3D>()
    for (const anchor of anchors) {
      const node = new THREE.Object3D()
      node.name = `anchor:${anchor.name}`
      node.position.set(anchor.position.x, anchor.position.y, anchor.position.z)
      if (anchor.rotation) node.rotation.set(anchor.rotation[0], anchor.rotation[1], anchor.rotation[2])
      const parent = anchor.parent === 'body' ? near : anchor.parent === 'steer' ? spinner : doorNodes.get(anchor.parent.slice(5)) ?? near
      parent.add(node)
      anchorNodes.set(anchor.name, node)
    }

    // Anchors that stay put, under the root so switching detail never touches them.
    const fixed = new THREE.Group()
    fixed.name = 'anchors'
    root.add(fixed)
    const place = (name: string, at: Vec3, yaw: number): THREE.Object3D => {
      const node = new THREE.Object3D()
      node.name = name
      node.position.set(at.x, at.y, at.z)
      node.rotation.y = yaw
      fixed.add(node)
      return node
    }
    const seatAnchors: VehicleModelSeat[] = layout.seats.map(seat => ({ id: seat.id, role: seat.role, mount: place(`mount:${seat.id}`, seat.mount, seat.facing), entryId: seat.entries[0]! }))
    const entryAnchors: VehicleModelEntry[] = layout.entries.map(entry => {
      const outside = place(`outside:${entry.id}`, entry.outside, entry.facing)
      const doorPivot = entry.door ? doorNodes.get(entry.door) : undefined
      return doorPivot ? { id: entry.id, side: entry.side, outside, doorPivot } : { id: entry.id, side: entry.side, outside }
    })
    const hand = (name: string): THREE.Object3D => {
      const node = anchorNodes.get(name)
      if (!node) throw new Error(`Vehicle model ${kind} has no ${name} anchor`)
      return node
    }

    // The values last applied. Door ids are entry ids, so a door keyed by an entry is that entry's door.
    const doors: Record<string, number> = {}
    for (const door of layout.doors) doors[door.id] = 0
    const state: VehicleVisualState = { steering: 0, wheelRotation: 0, doors }
    let detail: VehicleDetail = 'near'
    let gone = false

    const applySteer = (road: number): void => {
      for (const wheel of authored.wheels) if (wheel.steered && wheel.id !== source.blueprint.steerWheel) pivots.get(wheel.id)!.rotation.y = road
      // A handlebar turns about its leaning fork, so it turns further than the wheel's ground yaw; a steering wheel turns by a ratio.
      spinner.quaternion.setFromAxisAngle(steerAxis, layout.steering.kind === 'handlebar' ? forkAngleForYaw(steerAxis, road) : road * layout.steering.ratio)
    }
    const applyDoor = (id: string, openness: number): void => {
      const door = authored.doors.find(item => item.id === id)
      const node = doorNodes.get(id)
      if (!door || !node) return
      const open = clamp(openness, 0, 1)
      doors[id] = open
      if (door.kind === 'hinge') {
        // A right-hand door's rear edge swings towards -X; a left-hand door's towards +X.
        node.rotation.y = (door.side === 'right' ? 1 : -1) * door.travel * open
      } else {
        const outward = door.side === 'right' ? -1 : 1
        node.position.x = door.pivot.x + outward * SLIDE_OUT * Math.min(1, open / 0.25)
        node.position.z = door.pivot.z - door.travel * Math.max(0, (open - 0.2) / 0.8)
      }
    }
    const setDetail = (next: VehicleDetail): void => { detail = next; near.visible = next === 'near'; reduced.visible = next === 'reduced' }
    setDetail(options.detail ?? 'near')
    live++

    const model: VehicleModel = {
      kind, root, layout, paint,
      anchors: { seats: seatAnchors, entries: entryAnchors, driverHands: { left: hand('hand.left'), right: hand('hand.right') } },
      dimensions: { width: layout.width, length: layout.length, height: layout.height, wheelbase: layout.wheelBase },
      get detail() { return detail },
      get state() { return state },
      anchorNames: [...anchorNodes.keys()],
      update(next) {
        if (gone) return
        state.steering = clamp(next.steering, -layout.steering.maxSteer, layout.steering.maxSteer)
        applySteer(state.steering)
        state.wheelRotation = Number.isFinite(next.wheelRotation) ? next.wheelRotation % (Math.PI * 2) : 0
        for (const spin of spinners) spin.rotation.x = state.wheelRotation
        for (const door of layout.doors) applyDoor(door.id, next.doors?.[door.id] ?? 0)
      },
      setDetail(next) { if (!gone) setDetail(next) },
      readAnchor(name, out) {
        const node = anchorNodes.get(name)
        if (!node) return false
        node.updateWorldMatrix(true, false)
        root.updateWorldMatrix(true, false)
        scratchInverse.copy(root.matrixWorld).invert()
        scratchMatrix.multiplyMatrices(scratchInverse, node.matrixWorld)
        scratchMatrix.decompose(out.position, out.quaternion, scratchScale)
        return true
      },
      boardingRoute(seatId, entryId) {
        const seat = layout.seats.find(item => item.id === seatId)
        if (!seat) return []
        // Only the entries this seat names: a route to any other opening is not a route to this seat.
        const chosen = entryId ?? seat.entries[0]
        const entry = chosen !== undefined && seat.entries.includes(chosen) ? layout.entries.find(item => item.id === chosen) : undefined
        if (!entry) return []
        return [entry.outside, ...entry.steps, entry.threshold, ...seat.via, seat.position]
      },
      dispose() {
        if (gone) return
        gone = true; live--
        root.removeFromParent()
        root.clear(); content.clear(); near.clear(); reduced.clear(); fixed.clear()
      },
    }
    return model
  }

  return {
    create,
    originShift: kind => axleShift(builtFor(kind).blueprint.layout),
    setNight: amount => materials.setNight(amount),
    stats(): VehicleKitStats {
      const sizes = { keke: { near: 0, far: 0 }, danfo: { near: 0, far: 0 }, car: { near: 0, far: 0 } }
      let geometries = 0
      for (const [kind, entry] of built) {
        sizes[kind] = entry.triangles
        geometries += entry.body.size + entry.steer.size + entry.wheels.size + 1 + (entry.farPaint ? 1 : 0)
        for (const set of entry.doors.values()) geometries += set.size
      }
      return { geometries, materials: materials.all().length, triangles: sizes, instances: live }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of built.values()) {
        for (const set of [entry.body, entry.steer, entry.wheels, ...entry.doors.values()]) for (const geometry of set.values()) geometry.dispose()
        entry.farRest.dispose(); entry.farPaint?.dispose()
      }
      built.clear()
      materials.dispose()
    },
  }
}

let shared: VehicleKit | null = null

/**
 * One model of `kind`, built on a kit shared by every caller. The kit's geometry and materials are
 * made on first use and stay until `disposeVehicleModels()`: `model.dispose()` only takes the model
 * out of the scene, so one vehicle leaving never disturbs another.
 */
export function createVehicleModel(kind: VehicleKind, detail: VehicleDetail = 'near', options: { paint?: PaintName } = {}): VehicleModel {
  shared ??= createVehicleKit()
  return shared.create(kind, options.paint ? { detail, paint: options.paint } : { detail })
}

/** Dusk and night for the shared kit's lamps: 0 is day, 1 is night. */
export function setVehicleNight(amount: number): void { shared?.setNight(amount) }

/** Releases the shared kit's geometry and materials. Dispose every model first; call when the scene goes. */
export function disposeVehicleModels(): void { shared?.dispose(); shared = null }
