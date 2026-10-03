// A plain, unbranded four-door crossover hatchback: driver and front passenger seats, a rear bench
// for two, four hinged doors, and glass all round so the people inside can be seen. About 1.85 m
// wide, 4.4 m long and 1.7 m tall; the roof is higher than a saloon's so a 1.87 m avatar sits upright.
import * as THREE from 'three'
import { Pieces, skinOutline } from './builder.ts'
import { handGrips, seatPieces, steeringWheelPieces, strut, transformBox, vec, wheelFrame } from './parts.ts'
import type { AnchorSpec, Blueprint } from './parts.ts'
import { SIT_DROP, SIT_HIP } from './types.ts'
import type { VehicleDoor, VehicleEntry, VehicleLayout, VehicleSeat, VehicleWheel } from './types.ts'

const FLOOR = 0.16
const HALF = 0.92
const NOSE = 2.18, TAIL = -2.18
const WHEEL_R = 0.34
const FRONT_AXLE = 1.38, REAR_AXLE = -1.3
const BELT = 1.0, ROOF = 1.66
const SILL = 0.28
const ARCH = 0.4
const ARCHES = [{ z: FRONT_AXLE, radius: ARCH }, { z: REAR_AXLE, radius: ARCH }]
const FRONT_DOOR = { front: 0.62, rear: -0.4 }
const REAR_DOOR = { front: -0.44, rear: -1.3 }
/** Where a person stands to get in: in the gap between an open door's trailing edge and the next pillar. */
const FRONT_ENTRY = -0.1, REAR_ENTRY = -1.02

function seat(id: string, place: string, label: string, x: number, z: number, entries: string[], driver: boolean): VehicleSeat {
  return {
    id, place, label, role: driver ? 'driver' : 'passenger', position: vec(x, FLOOR, z), mount: vec(x, FLOOR + SIT_HIP, z), facing: 0, surface: FLOOR + SIT_DROP, entries, via: [], across: {},
    hands: driver ? ['hand.left', 'hand.right'] : [],
  }
}

function entry(id: string, label: string, side: 'left' | 'right', z: number): VehicleEntry {
  const s = side === 'left' ? 1 : -1
  // The sill is 12 cm above the floor; there is no separate step.
  return { id, label, side, door: id, outside: vec(s * 1.45, 0, z), steps: [], threshold: vec(s * 0.72, FLOOR, z), facing: -s * Math.PI / 2 }
}

const WHEELS: VehicleWheel[] = [
  { id: 'front-left', position: vec(0.78, WHEEL_R, FRONT_AXLE), radius: WHEEL_R, width: 0.22, steered: true },
  { id: 'front-right', position: vec(-0.78, WHEEL_R, FRONT_AXLE), radius: WHEEL_R, width: 0.22, steered: true },
  { id: 'rear-left', position: vec(0.78, WHEEL_R, REAR_AXLE), radius: WHEEL_R, width: 0.22, steered: false },
  { id: 'rear-right', position: vec(-0.78, WHEEL_R, REAR_AXLE), radius: WHEEL_R, width: 0.22, steered: false },
]

const DOORS: VehicleDoor[] = [
  { id: 'front-left', label: 'Driver door', kind: 'hinge', side: 'left', pivot: vec(HALF - 0.02, 0, FRONT_DOOR.front), travel: 1.25 },
  { id: 'rear-left', label: 'Rear left door', kind: 'hinge', side: 'left', pivot: vec(HALF - 0.02, 0, REAR_DOOR.front), travel: 1.2 },
  { id: 'front-right', label: 'Front passenger door', kind: 'hinge', side: 'right', pivot: vec(-HALF + 0.02, 0, FRONT_DOOR.front), travel: 1.25 },
  { id: 'rear-right', label: 'Rear right door', kind: 'hinge', side: 'right', pivot: vec(-HALF + 0.02, 0, REAR_DOOR.front), travel: 1.2 },
]

export const CAR_LAYOUT: VehicleLayout = {
  kind: 'car', label: 'Car', length: 4.41, width: 2.08, height: 1.72, wheelBase: FRONT_AXLE - REAR_AXLE,
  seats: [
    seat('driver', 'driver', 'Driver', 0.4, 0.05, ['front-left'], true),
    seat('passenger-1', 'front-passenger', 'Front passenger', -0.4, 0.05, ['front-right'], false),
    seat('passenger-2', 'rear-left', 'Rear left', 0.42, -0.82, ['rear-left'], false),
    seat('passenger-3', 'rear-right', 'Rear right', -0.42, -0.82, ['rear-right'], false),
  ],
  entries: [
    entry('front-left', 'Driver door', 'left', FRONT_ENTRY), entry('front-right', 'Front passenger door', 'right', FRONT_ENTRY),
    entry('rear-left', 'Rear left door', 'left', REAR_ENTRY), entry('rear-right', 'Rear right door', 'right', REAR_ENTRY),
  ],
  doors: DOORS,
  wheels: WHEELS,
  steering: { kind: 'wheel', maxSteer: 0.6, ratio: 3 },
  paint: 'silver',
}

function doorPanel(door: VehicleDoor, span: { front: number; rear: number }): Pieces {
  const pieces = new Pieces()
  const pivotZ = door.pivot.z, width = span.front - span.rear
  const out = door.side === 'left' ? 1 : -1
  // Lower skin, cut around the wheel arch where the door reaches it. Local frame: the skin is centred on x = 0.
  const outline = skinOutline(span.rear, span.front, SILL, BELT, ARCHES).map(([z, y]): [number, number] => [z - pivotZ, y])
  pieces.profileX('paint', outline, -0.02, 0.02, { solid: `door:${door.id}` })
  pieces.box('trim', [0.045, 0.04, width], [0, ROOF - 0.02, -width / 2])
  for (const z of [-0.02, -width + 0.02]) pieces.box('trim', [0.045, ROOF - BELT, 0.04], [0, (ROOF + BELT) / 2, z], { solid: `door:${door.id}` })
  pieces.box('trim', [0.05, 0.03, width], [0, BELT + 0.01, -width / 2])
  pieces.quad('glass', [0, BELT + 0.03, -0.04], [0, BELT + 0.03, -width + 0.04], [0, ROOF - 0.04, -width + 0.04], [0, ROOF - 0.04, -0.04])
  for (const side of [1, -1]) pieces.box('trim', [0.035, 0.03, 0.13], [side * out * 0.04, BELT - 0.08, -width + 0.12], { near: true })
  return pieces
}

export function buildCar(): Blueprint {
  const body = new Pieces()
  const steer = new Pieces()
  const doors = new Map<string, Pieces>()
  const anchors: AnchorSpec[] = []
  for (const door of DOORS) {
    const span = door.id.startsWith('front') ? FRONT_DOOR : REAR_DOOR
    doors.set(door.id, doorPanel(door, span))
    const out = door.side === 'left' ? 1 : -1
    const width = span.front - span.rear
    anchors.push(
      { name: `handle.${door.id}.outside`, parent: `door:${door.id}`, position: vec(out * 0.06, BELT - 0.08, -width + 0.12) },
      { name: `handle.${door.id}.inside`, parent: `door:${door.id}`, position: vec(-out * 0.06, BELT - 0.08, -width + 0.12) },
    )
  }

  // Underbody, floor and the sills under the doors.
  body.box('trim', [1.5, 0.06, 4.0], [0, 0.1, -0.1], { near: true })
  body.box('floor', [1.62, 0.06, 2.7], [0, FLOOR - 0.03, -0.38])
  for (const s of [1, -1]) body.box('paint', [0.12, SILL - FLOOR, 1.92], [s * 0.84, (SILL + FLOOR) / 2, -0.34])

  // Fixed side panels: front wings and rear quarters, with arches for the wheels.
  for (const s of [1, -1]) {
    const x0 = s > 0 ? HALF - 0.04 : -HALF, x1 = s > 0 ? HALF : -HALF + 0.04
    body.profileX('paint', skinOutline(FRONT_DOOR.front, NOSE, SILL, 0.88, ARCHES), x0, x1)
    body.profileX('paint', skinOutline(TAIL, REAR_DOOR.rear, SILL, BELT, ARCHES), x0, x1)
    body.box('paint', [0.04, BELT - SILL, 0.05], [s * (HALF - 0.02), (BELT + SILL) / 2, (FRONT_DOOR.rear + REAR_DOOR.front) / 2])
    // Pillars: A leans back from the cowl, B stands between the doors, C leans with the rear glass.
    strut(body, 'trim', vec(s * 0.88, BELT, 0.68), vec(s * 0.8, ROOF, 0.24), 0.07, { solid: 'pillar' })
    body.box('trim', [0.06, ROOF - BELT, 0.07], [s * (HALF - 0.03), (ROOF + BELT) / 2, (FRONT_DOOR.rear + REAR_DOOR.front) / 2], { solid: 'pillar' })
    strut(body, 'trim', vec(s * 0.88, BELT, -1.36), vec(s * 0.8, ROOF, -1.62), 0.07, { solid: 'pillar' })
    body.quad('glass', [s * 0.88, BELT + 0.03, REAR_DOOR.rear], [s * 0.88, BELT + 0.03, -1.4], [s * 0.82, ROOF - 0.06, -1.6], [s * 0.82, ROOF - 0.06, REAR_DOOR.rear + 0.1])
    // Mirrors on short stays.
    strut(body, 'trim', vec(s * 0.9, 1.0, 0.56), vec(s * 0.97, 1.08, 0.5), 0.025, { near: true })
    body.soft('paint', [0.08, 0.1, 0.17], [s * 1.0, 1.1, 0.5], 0.03, { near: true })
  }

  // Bonnet over the engine bay, wing tops either side of it, and the nose.
  body.profileX('paint', [[0.95, 0.3], [0.95, 1.0], [1.6, 0.92], [2.1, 0.8], [NOSE, 0.7], [NOSE, 0.3]], -0.64, 0.64, { solid: 'bonnet' })
  for (const s of [1, -1]) body.box('paint', [0.3, 0.05, NOSE - 0.62], [s * 0.77, 0.86, (NOSE + 0.62) / 2])
  body.box('trim', [1.8, 0.22, 0.12], [0, 0.4, NOSE - 0.06])
  body.box('trim', [0.9, 0.16, 0.03], [0, 0.6, NOSE + 0.005], { near: true })
  for (const s of [1, -1]) body.box('lampHead', [0.32, 0.1, 0.05], [s * 0.66, 0.72, NOSE - 0.01])
  body.box('plate', [0.4, 0.12, 0.015], [0, 0.4, NOSE + 0.008], { near: true })

  // The tail: a solid load space behind the rear seat, a sloping glass hatch, bumper and lamps.
  body.profileX('paint', [[-1.4, 0.3], [-1.4, 1.0], [-2.0, 1.08], [TAIL, 0.96], [TAIL, 0.34], [-1.9, 0.3]], -0.86, 0.86, { solid: 'tail' })
  body.quad('glass', [0.74, ROOF - 0.04, -1.62], [-0.74, ROOF - 0.04, -1.62], [-0.74, 1.1, -2.04], [0.74, 1.1, -2.04])
  body.box('trim', [1.8, 0.22, 0.12], [0, 0.4, TAIL + 0.06])
  for (const s of [1, -1]) body.box('lampTail', [0.28, 0.12, 0.04], [s * 0.66, 0.9, TAIL - 0.01])
  body.box('plate', [0.4, 0.12, 0.015], [0, 0.6, TAIL - 0.008], { near: true })

  // Windscreen and roof.
  body.quad('glass', [0.8, BELT + 0.03, 0.78], [-0.8, BELT + 0.03, 0.78], [-0.76, ROOF - 0.04, 0.24], [0.76, ROOF - 0.04, 0.24])
  body.profileY('paint', [[-0.8, 0.22], [0.8, 0.22], [0.8, -1.62], [-0.8, -1.62]], ROOF, ROOF + 0.06, { solid: 'roof' })

  // Inside: dash and firewall ahead of the front seats, a console between them.
  body.soft('plastic', [1.66, 0.34, 0.26], [0, 0.82, 0.82], 0.05, { solid: 'dash' })
  body.box('plastic', [1.66, 0.55, 0.04], [0, 0.43, 0.93], { solid: 'dash' })
  body.soft('plastic', [0.2, 0.36, 0.9], [0, 0.34, 0.18], 0.04, { solid: 'console' })

  // Seats: all four have headrests; their cushions stand 0.50 m above the floor.
  for (const s of CAR_LAYOUT.seats) seatPieces(body, { id: s.id, x: s.position.x, z: s.position.z, floor: FLOOR, width: s.place.startsWith('rear') ? 0.54 : 0.52, headrest: true })

  // Steering wheel, tipped back 24 degrees, hub 0.53 m ahead of the driver's hips.
  const driver = CAR_LAYOUT.seats[0]!
  const radius = 0.19, tilt = 0.42
  steeringWheelPieces(steer, radius, 0.017)
  const frame = vec(driver.position.x, driver.surface + 0.4, driver.position.z + 0.53)
  const quaternion = wheelFrame(tilt)
  strut(body, 'plastic', frame, vec(frame.x, frame.y - 0.18, frame.z + 0.2), 0.06, { near: true })
  const grips = handGrips(radius)
  anchors.push(
    { name: 'hand.left', parent: 'steer', position: grips.left },
    { name: 'hand.right', parent: 'steer', position: grips.right },
  )
  const rim = radius + 0.017
  const wheelBox = new THREE.Box3(new THREE.Vector3(-rim, -rim, -0.03), new THREE.Vector3(rim, rim, 0.03))
  const obstacles = [
    ...body.obstacles,
    { tag: 'steering', box: transformBox(wheelBox, frame, quaternion) },
    ...DOORS.flatMap(door => (doors.get(door.id)?.obstacles ?? []).map(item => ({ tag: item.tag, box: item.box.clone().translate(new THREE.Vector3(door.pivot.x, door.pivot.y, door.pivot.z)) }))),
  ]
  return { layout: CAR_LAYOUT, body, doors, steer, steerFrame: { position: frame, quaternion, axis: vec(0, 0, 1) }, steerWheel: null, anchors, obstacles }
}
