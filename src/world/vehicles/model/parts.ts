// Parts every vehicle uses: the wheel, a seat, a steering wheel, and the shape of what a vehicle
// file hands back (`Blueprint`).
import * as THREE from 'three'
import type { Obstacle, Pieces } from './builder.ts'
import { SIT_DROP } from './types.ts'
import type { Vec3, VehicleLayout } from './types.ts'

/** A point that follows a moving part: the steering frame, a door, or the fixed body. */
export interface AnchorSpec {
  name: string
  parent: 'body' | 'steer' | `door:${string}`
  position: Vec3
  /** Euler radians. +Y is along the grip, in either sense: the rim's tangent for a steering wheel, the bar for a handlebar. */
  rotation?: readonly [number, number, number]
}

export interface Blueprint {
  layout: VehicleLayout
  /** Everything that does not move. */
  body: Pieces
  /** Door panels, each in its own frame: origin at the door's pivot. */
  doors: ReadonlyMap<string, Pieces>
  /** The steering wheel, or the handlebar and fork, in the steering frame. */
  steer: Pieces
  /** The steering frame: where it sits, how it is oriented, and the axis it turns about inside itself. */
  steerFrame: { position: Vec3; quaternion: THREE.Quaternion; axis: Vec3 }
  /** The wheel that turns with the steering assembly, whose frame it then sits in (a keke's front wheel). */
  steerWheel: string | null
  anchors: AnchorSpec[]
  /** Fixed solids in the vehicle frame, plus every closed door. */
  obstacles: Obstacle[]
}

export function vec(x: number, y: number, z: number): Vec3 { return { x, y, z } }

/** Tyre, sidewall, rim, hub and five slots. The slots exist so that spinning is visible. */
export function wheelGeometry(radius: number, width: number, segments: number, detailed: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const paint = (geometry: THREE.BufferGeometry, r: number, g: number, b: number): void => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    for (const name of Object.keys(flat.attributes)) if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name)
    const count = flat.getAttribute('position').count
    const colours = new Float32Array(count * 3)
    for (let index = 0; index < count; index++) { colours[index * 3] = r; colours[index * 3 + 1] = g; colours[index * 3 + 2] = b }
    flat.setAttribute('color', new THREE.BufferAttribute(colours, 3))
    if (flat !== geometry) geometry.dispose()
    parts.push(flat)
  }
  const axis = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => geometry.rotateZ(-Math.PI / 2)
  paint(axis(new THREE.CylinderGeometry(radius, radius, width * 0.64, segments)), 0.07, 0.07, 0.075)
  for (const side of [-1, 1]) {
    // A frustum rounds each shoulder of the tyre.
    const shoulder = axis(new THREE.CylinderGeometry(side > 0 ? radius * 0.88 : radius, side > 0 ? radius : radius * 0.88, width * 0.18, segments))
    shoulder.translate(side * width * 0.41, 0, 0)
    paint(shoulder, 0.07, 0.07, 0.075)
  }
  const rimRadius = radius * 0.6
  paint(axis(new THREE.CylinderGeometry(rimRadius, rimRadius, width * 0.78, segments)), 0.62, 0.64, 0.66)
  if (detailed) {
    paint(axis(new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, width * 0.92, 10)), 0.8, 0.8, 0.8)
    for (let slot = 0; slot < 5; slot++) {
      const angle = slot * Math.PI * 2 / 5
      for (const side of [-1, 1]) {
        const bar = new THREE.BoxGeometry(0.012, radius * 0.1, rimRadius * 0.78)
        bar.translate(side * width * 0.4, 0, rimRadius * 0.5)
        bar.rotateX(angle)
        paint(bar, 0.16, 0.17, 0.18)
      }
    }
  }
  const merged = mergeParts(parts)
  merged.computeBoundingSphere()
  return merged
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], colours: number[] = []
  for (const part of parts) {
    positions.push(...(part.getAttribute('position').array as Float32Array))
    normals.push(...(part.getAttribute('normal').array as Float32Array))
    colours.push(...(part.getAttribute('color').array as Float32Array))
    part.dispose()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  return geometry
}

export interface SeatPieces {
  id: string
  /** Centre across the vehicle (+X is left). */
  x: number
  /** Hip front-to-back position. */
  z: number
  /** Floor top the avatar's feet stand on. */
  floor: number
  width: number
  /** Tall backrest with a headrest, for a car; a bench back for the rest. */
  headrest?: boolean
  /** What the cushion stands on. Default a plain box. */
  base?: 'box' | 'none'
}

/** Cushion, base and backrest of one seat, tagged so its own occupant ignores it. */
export function seatPieces(pieces: Pieces, seat: SeatPieces): void {
  const surface = seat.floor + SIT_DROP
  const own = `own:seat:${seat.id}`
  // Cushion: 0.44 deep, with its front edge 0.22 ahead of the hip.
  pieces.soft('fabric', [seat.width - 0.02, 0.12, 0.44], [seat.x, surface - 0.06, seat.z], 0.04, { solid: own })
  if (seat.base !== 'none') pieces.box('trim', [seat.width - 0.04, surface - 0.12 - seat.floor, 0.42], [seat.x, seat.floor + (surface - 0.12 - seat.floor) / 2, seat.z - 0.01], { solid: own, near: true })
  // The backrest starts at the cushion and leans nothing: it stays behind the hip, 0.22 to 0.34 back.
  pieces.soft('fabric', [seat.width - 0.04, 0.62, 0.12], [seat.x, surface + 0.31, seat.z - 0.28], 0.04, { solid: own })
  if (seat.headrest) pieces.soft('fabric', [0.24, 0.17, 0.1], [seat.x, surface + 0.71, seat.z - 0.28], 0.03, { solid: own, near: true })
}

/** A steering wheel in its own frame: rim in the XY plane, axis +Z towards the driver. Returns its outer radius. */
export function steeringWheelPieces(pieces: Pieces, radius: number, tube: number): number {
  pieces.add('plastic', new THREE.TorusGeometry(radius, tube, 6, 18))
  for (const angle of [Math.PI / 2 + Math.PI * 2 / 3, Math.PI / 2 - Math.PI * 2 / 3, -Math.PI / 2]) {
    pieces.add('plastic', new THREE.BoxGeometry(radius * 0.92, 0.022, 0.018).translate(radius * 0.46, 0, 0), [0, 0, 0], { rot: [0, 0, angle] })
  }
  pieces.cylinder('plastic', 'z', 0.045, 0.05, 0.05, 10, [0, 0, 0])
  return radius + tube
}

/** Where the driver's hands go on the wheel: at nine and three o'clock, on the rim. Local frame positions; the rim's tangent there is local +Y. */
export function handGrips(radius: number): { left: Vec3; right: Vec3 } {
  // The frame's +X is the driver's right, because +Z points back at the driver.
  return { left: vec(-radius, 0, 0), right: vec(radius, 0, 0) }
}

/** The frame a steering wheel sits in: axis towards the driver and tipped up by `tilt`, with local +X on the driver's right. */
export function wheelFrame(tilt: number): THREE.Quaternion {
  const z = new THREE.Vector3(0, Math.sin(tilt), -Math.cos(tilt))
  const x = new THREE.Vector3(-1, 0, 0)
  const y = new THREE.Vector3().crossVectors(z, x)
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
}

/** A square bar between two points: pillars, rails, stays. */
export function strut(pieces: Pieces, material: 'paint' | 'trim' | 'metal' | 'plastic', from: Vec3, to: Vec3, thickness: number, options: { solid?: string; near?: boolean } = {}): void {
  const direction = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z)
  const length = direction.length()
  if (length < 1e-6) return
  const geometry = new THREE.BoxGeometry(thickness, thickness, length)
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize()))
  pieces.add(material, geometry, [(from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2], options)
}

/**
 * A wheel cover: an open half-tube over a wheel whose axle runs along X. `arc` narrows it to the
 * front and top: it starts `back` radians behind the top and ends `down` radians below the front.
 */
export function wheelCover(pieces: Pieces, radius: number, width: number, at: readonly [number, number, number], options: { solid?: string; arc?: { back: number; down: number } } = {}): void {
  const start = options.arc ? Math.PI * 1.5 - options.arc.back : Math.PI
  const length = options.arc ? options.arc.back + Math.PI / 2 + options.arc.down : Math.PI
  const geometry = new THREE.CylinderGeometry(radius, radius, width, 14, 1, true, start, length)
  geometry.rotateZ(-Math.PI / 2)
  pieces.add('paint', geometry, at, options)
}

/** The box that encloses `box` after it is moved by a position and an orientation. */
export function transformBox(box: THREE.Box3, position: Vec3, quaternion: THREE.Quaternion): THREE.Box3 {
  const out = new THREE.Box3()
  const corner = new THREE.Vector3()
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    out.expandByPoint(corner.set(x, y, z).applyQuaternion(quaternion).add(new THREE.Vector3(position.x, position.y, position.z)))
  }
  return out
}

/**
 * How far to turn a handlebar and fork about the fork axis so the wheel's rolling direction has a
 * ground-plane yaw of `yaw` (radians about +Y, positive to the left). The axis leans back, so turning
 * about it by `yaw` itself would give less: rotating the wheel's forward vector about the unit axis
 * (0, ay, az) by θ gives a ground direction (ay·sinθ, ay²·cosθ + az²), hence
 * tan(yaw) = ay·sinθ / (ay²·cosθ + az²), solved for θ exactly. The axis must have no sideways part.
 */
export function forkAngleForYaw(axis: Vec3, yaw: number): number {
  const length = Math.hypot(axis.x, axis.y, axis.z)
  const ay = axis.y / length, az = axis.z / length
  if (ay < 1e-6 || yaw === 0) return yaw
  const t = Math.tan(yaw)
  const a = ay, b = t * ay * ay, c = t * az * az
  return Math.atan2(b, a) + Math.asin(Math.max(-1, Math.min(1, c / Math.hypot(a, b))))
}
