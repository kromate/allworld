// A three-wheeled keke (auto-rickshaw): one front wheel under a nose cowl, handlebar steering, an
// open-sided cabin with a driver's seat and a three-person bench behind it, and a black roof.
// Its sides have no doors: you step over the sill. Overall about 1.6 m wide with mirrors, 2.8 m long, 1.9 m tall,
// a little taller than a stock one so a 1.87 m avatar sits upright under the roof.
import * as THREE from 'three'
import { Pieces } from './builder.ts'
import { seatPieces, strut, vec, wheelCover, transformBox } from './parts.ts'
import type { AnchorSpec, Blueprint } from './parts.ts'
import { SIT_DROP, SIT_HIP } from './types.ts'
import type { VehicleEntry, VehicleLayout, VehicleSeat, VehicleWheel } from './types.ts'

const FLOOR = 0.24
const NOSE = 1.37, TAIL = -1.37
const WHEEL_R = 0.26
const FRONT = vec(0, WHEEL_R, 1.1)
/** Where the bar sits, and so which way the fork leans. */
const BAR = vec(0, 1.14, 0.62)
const AISLE = -0.26
const PASSENGER_Z = -0.72

function seat(id: string, place: string, label: string, x: number, z: number, entries: string[], driver: boolean, across: Record<string, string[]> = {}): VehicleSeat {
  return {
    id, place, label, role: driver ? 'driver' : 'passenger', position: vec(x, FLOOR, z), mount: vec(x, FLOOR + SIT_HIP, z), facing: 0, surface: FLOOR + SIT_DROP, entries,
    // The bench is reached over its edge and shuffled along: the walk ends at the threshold, and the last leg is the sit.
    via: [], across, hands: driver ? ['hand.left', 'hand.right'] : [],
  }
}

function entry(id: string, label: string, side: 'left' | 'right', z: number): VehicleEntry {
  const s = side === 'left' ? 1 : -1
  return {
    id, label, side, door: null, outside: vec(s * 1.0, 0, z), steps: [vec(s * 0.8, 0.12, z)], threshold: vec(s * 0.5, FLOOR, z),
    facing: -s * Math.PI / 2,
  }
}

const WHEELS: VehicleWheel[] = [
  { id: 'front', position: FRONT, radius: WHEEL_R, width: 0.13, steered: true },
  { id: 'rear-left', position: vec(0.6, WHEEL_R, -0.88), radius: WHEEL_R, width: 0.13, steered: false },
  { id: 'rear-right', position: vec(-0.6, WHEEL_R, -0.88), radius: WHEEL_R, width: 0.13, steered: false },
]

export const KEKE_LAYOUT: VehicleLayout = {
  kind: 'keke', label: 'Keke', length: 2.8, width: 1.61, height: 1.88, wheelBase: FRONT.z + 0.88,
  seats: [
    seat('driver', 'driver', 'Driver', 0, 0.22, ['left-front', 'right-front'], true),
    seat('passenger-1', 'rear-left', 'Rear left', 0.43, PASSENGER_Z, ['left-rear', 'right-rear'], false, { 'right-rear': ['passenger-2', 'passenger-3'] }),
    seat('passenger-2', 'rear-middle', 'Rear middle', 0, PASSENGER_Z, ['left-rear', 'right-rear'], false, { 'left-rear': ['passenger-1'], 'right-rear': ['passenger-3'] }),
    seat('passenger-3', 'rear-right', 'Rear right', -0.43, PASSENGER_Z, ['right-rear', 'left-rear'], false, { 'left-rear': ['passenger-1', 'passenger-2'] }),
  ],
  entries: [
    entry('left-rear', 'Left side, rear', 'left', AISLE), entry('right-rear', 'Right side, rear', 'right', AISLE),
    entry('left-front', 'Left side, driver', 'left', 0.22), entry('right-front', 'Right side, driver', 'right', 0.22),
  ],
  doors: [],
  wheels: WHEELS,
  steering: { kind: 'handlebar', maxSteer: 0.5, ratio: 1 },
  paint: 'yellow',
}

export function buildKeke(): Blueprint {
  const body = new Pieces()
  const steer = new Pieces()

  // Floor, and the sills a passenger steps over.
  body.box('floor', [1.34, 0.06, 2.2], [0, FLOOR - 0.03, -0.24])
  for (const s of [-1, 1]) {
    body.box('paint', [0.04, 0.18, 2.2], [s * 0.67, 0.23, -0.24])
    body.box('trim', [0.05, 0.05, 2.2], [s * 0.67, 0.145, -0.24])
  }

  // Engine cover behind the bench, with its lamps and a blank plate.
  body.soft('paint', [1.36, 0.62, 0.26], [0, 0.6, -1.24], 0.05, { solid: 'engine' })
  for (const s of [-1, 1]) body.box('lampTail', [0.12, 0.07, 0.03], [s * 0.52, 0.78, TAIL - 0.005])
  body.box('plate', [0.28, 0.12, 0.015], [0, 0.5, TAIL - 0.008], { near: true })
  // Rear mudguards.
  for (const w of [WHEELS[1]!, WHEELS[2]!]) wheelCover(body, WHEEL_R + 0.05, 0.17, [w.position.x, w.position.y, w.position.z])

  // The nose cowl: dash, bonnet slope and a front that clears the wheel.
  body.profileX('paint', [[0.86, FLOOR], [0.86, 0.98], [1.12, 1.0], [1.3, 0.86], [NOSE, 0.66], [NOSE - 0.02, 0.6], [0.86, 0.6]], -0.64, 0.64, { solid: 'cowl' })
  body.box('trim', [1.0, 0.07, 0.05], [0, 0.63, NOSE - 0.01], { near: true })
  body.cylinder('lampHead', 'z', 0.1, 0.1, 0.06, 14, [0, 0.8, NOSE - 0.005])
  body.cylinder('metal', 'z', 0.12, 0.12, 0.04, 14, [0, 0.8, NOSE - 0.03], { near: true })
  body.box('plastic', [1.0, 0.03, 0.26], [0, 1.005, 0.99], { near: true })

  // Windscreen and its pillars.
  body.quad('glass', [0.62, 1.01, 0.92], [-0.62, 1.01, 0.92], [-0.62, 1.78, 0.54], [0.62, 1.78, 0.54])
  for (const s of [-1, 1]) {
    strut(body, 'trim', vec(s * 0.65, 0.98, 0.92), vec(s * 0.65, 1.8, 0.54), 0.045, { solid: 'pillar' })
    strut(body, 'trim', vec(s * 0.69, 0.3, -1.3), vec(s * 0.69, 1.8, -1.3), 0.045, { solid: 'pillar' })
  }

  // Black roof: an octagon in plan, 8 cm thick, with its underside 1.80 m up.
  body.profileY('canvas', [[-0.66, 0.52], [0.66, 0.52], [0.74, 0.44], [0.74, -1.25], [0.66, TAIL], [-0.66, TAIL], [-0.74, -1.25], [-0.74, 0.44]], 1.8, 1.88, { solid: 'roof' })
  for (const s of [-1, 1]) body.box('trim', [0.03, 0.06, 1.7], [s * 0.74, 1.77, -0.42], { near: true })

  // Mirrors on short stays.
  for (const s of [-1, 1]) {
    strut(body, 'trim', vec(s * 0.64, 1.0, 0.86), vec(s * 0.78, 1.2, 0.78), 0.02, { near: true })
    body.box('trim', [0.03, 0.13, 0.1], [s * 0.79, 1.2, 0.76], { near: true })
  }

  // Seats: the driver's, and a bench for three. Their cushions stand 0.50 m above the floor.
  seatPieces(body, { id: 'driver', x: 0, z: 0.22, floor: FLOOR, width: 0.44 })
  for (const [id, x] of [['passenger-1', 0.43], ['passenger-2', 0], ['passenger-3', -0.43]] as const) seatPieces(body, { id, x, z: PASSENGER_Z, floor: FLOOR, width: 0.43 })

  // The steering assembly, in its own frame: origin at the front wheel's centre, turning about the fork.
  const bar = new THREE.Vector3(BAR.x - FRONT.x, BAR.y - FRONT.y, BAR.z - FRONT.z)
  const fork = bar.clone().normalize()
  steer.add('metal', new THREE.CylinderGeometry(0.03, 0.03, bar.length(), 8).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), fork)), [bar.x / 2, bar.y / 2, bar.z / 2])
  // A single-sided fork leg and the front mudguard.
  steer.box('metal', [0.04, WHEEL_R * 1.5, 0.05], [0.09, WHEEL_R * 0.55, 0.0], { near: true })
  // Only the front and top of the wheel: a full cover would reach back through the cowl into the driver's footwell.
  wheelCover(steer, WHEEL_R + 0.05, 0.17, [0, 0, 0], { arc: { back: 0.26, down: 0.3 } })
  steer.cylinder('metal', 'x', 0.016, 0.016, 0.66, 8, [bar.x, bar.y, bar.z], { solid: 'handlebar' })
  for (const s of [-1, 1]) {
    steer.cylinder('rubber', 'x', 0.021, 0.021, 0.13, 8, [s * 0.27, bar.y, bar.z])
    steer.box('metal', [0.012, 0.06, 0.012], [s * 0.18, bar.y + 0.03, bar.z + 0.03], { near: true })
  }
  steer.box('plastic', [0.14, 0.07, 0.1], [0, bar.y + 0.04, bar.z], { near: true })

  const anchors: AnchorSpec[] = [
    { name: 'hand.left', parent: 'steer', position: vec(0.27, bar.y, bar.z), rotation: [0, 0, Math.PI / 2] },
    { name: 'hand.right', parent: 'steer', position: vec(-0.27, bar.y, bar.z), rotation: [0, 0, Math.PI / 2] },
  ]

  const steerFrame = { position: FRONT, quaternion: new THREE.Quaternion(), axis: vec(fork.x, fork.y, fork.z) }
  const obstacles = [...body.obstacles, ...steer.obstacles.map(item => ({ tag: item.tag, box: transformBox(item.box, FRONT, steerFrame.quaternion) }))]
  return { layout: KEKE_LAYOUT, body, doors: new Map(), steer, steerFrame, steerWheel: 'front', anchors, obstacles }
}
