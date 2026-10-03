// A Lagos-style danfo: a yellow forward-control minibus with black stripes, a hinged door at each
// cab seat and a sliding door on the kerb (right) side with a step beneath it. A three-seat cab bench, a
// door bay and a left seat, two rows of two, and a three-person rear bench: eleven seats, a central
// aisle between them. About 2.0 m wide, 5.4 m long, 2.3 m tall.
import * as THREE from 'three'
import { Pieces, skinOutline } from './builder.ts'
import { handGrips, seatPieces, steeringWheelPieces, strut, transformBox, vec, wheelFrame } from './parts.ts'
import type { AnchorSpec, Blueprint } from './parts.ts'
import { SIT_DROP, SIT_HIP } from './types.ts'
import type { VehicleDoor, VehicleEntry, VehicleLayout, VehicleSeat, VehicleWheel } from './types.ts'

const FLOOR = 0.5
const HALF = 0.99
const NOSE = 2.7, TAIL = -2.7
const WHEEL_R = 0.38
const FRONT_AXLE = 2.15, REAR_AXLE = -1.5
const BELT = 1.22, ROOF = 2.3
const ARCHES = [{ z: FRONT_AXLE, radius: 0.46 }, { z: REAR_AXLE, radius: 0.46 }]
const CAB_FRONT = 1.66, CAB_REAR = 0.8
const SLIDE_FRONT = 0.72, SLIDE_REAR = -0.32
const BAY_Z = 0.2
const WHEEL_X = 0.8
/** An open cab door swings forward past this; the gap between its trailing edge and the B-post is the way in. */
const CAB_ENTRY = 1.1

function seat(id: string, place: string, label: string, x: number, z: number, entries: string[], driver: boolean, via: [number, number, number][], across: Record<string, string[]> = {}): VehicleSeat {
  return {
    id, place, label, role: driver ? 'driver' : 'passenger', position: vec(x, FLOOR, z), mount: vec(x, FLOOR + SIT_HIP, z), facing: 0, surface: FLOOR + SIT_DROP, entries,
    via: via.map(p => vec(p[0], p[1], p[2])), across, hands: driver ? ['hand.left', 'hand.right'] : [],
  }
}

/** From the door bay, along the aisle, to beside a seat. The aisle ends at the third row's backs; the rear bench is reached from there. */
const AISLE_END = -1.7
const aisle = (z: number): [number, number, number][] => {
  const end = Math.max(z, AISLE_END)
  return Math.abs(end - BAY_Z) < 0.01 ? [[0, FLOOR, BAY_Z]] : [[0, FLOOR, BAY_Z], [0, FLOOR, end]]
}

const WHEELS: VehicleWheel[] = [
  { id: 'front-left', position: vec(WHEEL_X, WHEEL_R, FRONT_AXLE), radius: WHEEL_R, width: 0.22, steered: true },
  { id: 'front-right', position: vec(-WHEEL_X, WHEEL_R, FRONT_AXLE), radius: WHEEL_R, width: 0.22, steered: true },
  { id: 'rear-left', position: vec(WHEEL_X, WHEEL_R, REAR_AXLE), radius: WHEEL_R, width: 0.22, steered: false },
  { id: 'rear-right', position: vec(-WHEEL_X, WHEEL_R, REAR_AXLE), radius: WHEEL_R, width: 0.22, steered: false },
]

const DOORS: VehicleDoor[] = [
  { id: 'cab-left', label: 'Driver door', kind: 'hinge', side: 'left', pivot: vec(HALF - 0.02, 0, CAB_FRONT), travel: 1.3 },
  { id: 'cab-right', label: 'Front passenger door', kind: 'hinge', side: 'right', pivot: vec(-HALF + 0.02, 0, CAB_FRONT), travel: 1.3 },
  { id: 'side', label: 'Sliding door', kind: 'slide', side: 'right', pivot: vec(-HALF + 0.02, 0, SLIDE_FRONT), travel: 1.0 },
]

function entry(id: string, label: string, side: 'left' | 'right', door: string, z: number): VehicleEntry {
  const s = side === 'left' ? 1 : -1
  return {
    id, label, side, door, outside: vec(s * 1.55, 0, z), steps: [vec(s * 1.08, 0.26, z)], threshold: vec(s * 0.8, FLOOR, z), facing: -s * Math.PI / 2,
  }
}

export const DANFO_LAYOUT: VehicleLayout = {
  kind: 'danfo', label: 'Danfo', length: 5.44, width: 2.31, height: 2.42, wheelBase: FRONT_AXLE - REAR_AXLE,
  seats: [
    seat('driver', 'driver', 'Driver', 0.47, 1.18, ['cab-left'], true, []),
    seat('passenger-1', 'front-passenger', 'Front passenger', -0.47, 1.18, ['cab-right'], false, []),
    // The cab bench seats three: the middle seat is reached across a neighbour's.
    seat('passenger-2', 'front-middle', 'Front middle', 0, 1.18, ['cab-right', 'cab-left'], false, [], { 'cab-right': ['passenger-1'], 'cab-left': ['driver'] }),
    seat('passenger-3', 'row1-left', 'Row 1, left', 0.62, 0.3, ['side'], false, aisle(0.3)),
    seat('passenger-4', 'row2-left', 'Row 2, left', 0.62, -0.56, ['side'], false, aisle(-0.56)),
    seat('passenger-5', 'row2-right', 'Row 2, right', -0.62, -0.56, ['side'], false, aisle(-0.56)),
    seat('passenger-6', 'row3-left', 'Row 3, left', 0.62, -1.42, ['side'], false, aisle(-1.42)),
    seat('passenger-7', 'row3-right', 'Row 3, right', -0.62, -1.42, ['side'], false, aisle(-1.42)),
    seat('passenger-8', 'bench-left', 'Rear bench, left', 0.45, -2.28, ['side'], false, aisle(-2.28)),
    seat('passenger-9', 'bench-middle', 'Rear bench, middle', 0, -2.28, ['side'], false, aisle(-2.28)),
    seat('passenger-10', 'bench-right', 'Rear bench, right', -0.45, -2.28, ['side'], false, aisle(-2.28)),
  ],
  entries: [
    entry('cab-left', 'Driver door', 'left', 'cab-left', CAB_ENTRY),
    entry('cab-right', 'Front passenger door', 'right', 'cab-right', CAB_ENTRY),
    entry('side', 'Sliding door', 'right', 'side', BAY_Z),
  ],
  doors: DOORS,
  wheels: WHEELS,
  steering: { kind: 'wheel', maxSteer: 0.5, ratio: 3 },
  paint: 'yellow',
}

/** A door panel in its own frame: origin at the pivot, the panel running back along -Z. */
function doorPanel(door: VehicleDoor, width: number): Pieces {
  const pieces = new Pieces()
  const out = door.side === 'left' ? 1 : -1
  pieces.box('paint', [0.04, BELT - 0.52, width], [0, (BELT + 0.52) / 2, -width / 2], { solid: `door:${door.id}` })
  pieces.box('trim', [0.05, 0.14, width - 0.02], [0, 0.99, -width / 2])
  pieces.box('trim', [0.05, 0.1, width], [0, 0.46 + 0.04, -width / 2], { near: true })
  pieces.box('trim', [0.05, 0.06, width], [0, ROOF - 0.03, -width / 2])
  for (const z of [-0.025, -width + 0.025]) pieces.box('trim', [0.05, ROOF - BELT, 0.05], [0, (ROOF + BELT) / 2, z], { solid: `door:${door.id}` })
  pieces.quad('glass', [0, BELT + 0.02, -0.05], [0, BELT + 0.02, -width + 0.05], [0, ROOF - 0.06, -width + 0.05], [0, ROOF - 0.06, -0.05])
  for (const side of [1, -1]) pieces.box('trim', [0.04, 0.04, 0.15], [side * out * 0.04, 1.12, -width + 0.14], { near: true })
  return pieces
}

export function buildDanfo(): Blueprint {
  const body = new Pieces()
  const steer = new Pieces()
  const doors = new Map<string, Pieces>()
  const anchors: AnchorSpec[] = []
  for (const door of DOORS) {
    const width = door.kind === 'slide' ? SLIDE_FRONT - SLIDE_REAR : CAB_FRONT - CAB_REAR
    doors.set(door.id, doorPanel(door, width))
    const out = door.side === 'left' ? 1 : -1
    anchors.push(
      { name: `handle.${door.id}.outside`, parent: `door:${door.id}`, position: vec(out * 0.07, 1.12, -width + 0.14) },
      { name: `handle.${door.id}.inside`, parent: `door:${door.id}`, position: vec(-out * 0.07, 1.12, -width + 0.14) },
    )
  }

  // Underbody and floor.
  body.box('trim', [1.7, 0.14, 5.3], [0, 0.37, 0], { near: true })
  body.box('floor', [1.86, 0.06, 4.64], [0, FLOOR - 0.03, -0.3])

  // Side skins, split around the three doors. Arches are cut where the wheels show.
  for (const s of [1, -1]) {
    const x0 = s > 0 ? HALF - 0.04 : -HALF, x1 = s > 0 ? HALF : -HALF + 0.04
    const spans: [number, number, number][] = s > 0
      ? [[TAIL, CAB_REAR, BELT], [CAB_FRONT, 2.05, BELT], [2.05, NOSE, 1.06]]
      : [[TAIL, SLIDE_REAR, BELT], [CAB_FRONT, 2.05, BELT], [2.05, NOSE, 1.06]]
    for (const [z0, z1, top] of spans) body.profileX('paint', skinOutline(z0, z1, 0.4, top, ARCHES), x0, x1)
    // The black stripe runs the whole side above the arches; the door panels carry their own.
    for (const [z0, z1] of spans) body.box('trim', [0.05, 0.14, z1 - z0], [s * (HALF - 0.015), 0.99, (z0 + z1) / 2], { near: false })
    // Step under the sliding door, and rails along the roof edge.
    body.box('trim', [0.05, 0.1, 5.3], [s * (HALF - 0.015), 2.03, 0], { near: true })
    if (s < 0) body.box('metal', [0.2, 0.04, SLIDE_FRONT - SLIDE_REAR], [-HALF - 0.07, 0.25, (SLIDE_FRONT + SLIDE_REAR) / 2], { near: true })
    // Fixed glass and the pillars between doors.
    if (s > 0) body.quad('glass', [HALF - 0.02, BELT + 0.02, TAIL + 0.1], [HALF - 0.02, BELT + 0.02, CAB_REAR - 0.05], [HALF - 0.02, ROOF - 0.06, CAB_REAR - 0.05], [HALF - 0.02, ROOF - 0.06, TAIL + 0.1])
    else body.quad('glass', [-HALF + 0.02, BELT + 0.02, TAIL + 0.1], [-HALF + 0.02, BELT + 0.02, SLIDE_REAR - 0.05], [-HALF + 0.02, ROOF - 0.06, SLIDE_REAR - 0.05], [-HALF + 0.02, ROOF - 0.06, TAIL + 0.1])
    body.box('trim', [0.05, ROOF - BELT, 0.07], [s * (HALF - 0.02), (ROOF + BELT) / 2, CAB_REAR - 0.02], { solid: 'pillar' })
    body.box('trim', [0.05, ROOF - BELT, 0.07], [s * (HALF - 0.02), (ROOF + BELT) / 2, TAIL + 0.04], { solid: 'pillar' })
    strut(body, 'trim', vec(s * (HALF - 0.02), BELT, 2.05), vec(s * (HALF - 0.02), ROOF, 1.8), 0.06, { solid: 'pillar' })
    // Door mirrors on arms.
    strut(body, 'trim', vec(s * (HALF - 0.02), 1.45, 1.78), vec(s * 1.1, 1.58, 1.7), 0.03, { near: true })
    body.box('trim', [0.05, 0.28, 0.18], [s * 1.13, 1.6, 1.68], { near: true })
  }
  // The B-post between the sliding door and the cab door, right side.
  body.box('paint', [0.04, BELT - 0.4, CAB_REAR - SLIDE_FRONT], [-HALF + 0.02, (BELT + 0.4) / 2, (CAB_REAR + SLIDE_FRONT) / 2])

  // Front: bonnet, bumper, grille and lamps. Rear: panel, bumper, lamps. Both blank of any name.
  body.profileX('paint', [[2.0, FLOOR], [2.0, BELT], [2.35, 1.2], [2.62, 1.08], [NOSE, 0.92], [NOSE, 0.55], [2.5, FLOOR]], -0.7, 0.7, { solid: 'bonnet' })
  for (const s of [1, -1]) body.box('paint', [0.3, 0.05, NOSE - 2.0], [s * 0.85, 1.04, (NOSE + 2.0) / 2], { solid: 'mudguard' })
  body.box('trim', [1.96, 0.22, 0.12], [0, 0.52, NOSE - 0.05])
  body.box('trim', [0.8, 0.34, 0.03], [0, 0.8, NOSE + 0.005], { near: true })
  for (const s of [1, -1]) body.cylinder('lampHead', 'z', 0.1, 0.1, 0.05, 14, [s * 0.64, 0.82, NOSE])
  body.box('paint', [1.9, BELT - 0.4, 0.04], [0, (BELT + 0.4) / 2, TAIL + 0.02])
  body.box('trim', [1.9, 0.14, 0.05], [0, 0.99, TAIL + 0.015])
  body.box('trim', [1.98, 0.2, 0.1], [0, 0.5, TAIL + 0.05])
  for (const s of [1, -1]) body.box('lampTail', [0.1, 0.24, 0.03], [s * 0.88, 0.86, TAIL - 0.005])
  body.box('plate', [0.4, 0.14, 0.015], [0, 0.6, TAIL - 0.008], { near: true })
  body.quad('glass', [0.9, BELT + 0.02, TAIL + 0.02], [-0.9, BELT + 0.02, TAIL + 0.02], [-0.9, ROOF - 0.06, TAIL + 0.02], [0.9, ROOF - 0.06, TAIL + 0.02])

  // Windscreen and roof, with a light rack on top.
  body.quad('glass', [0.96, BELT + 0.02, 2.05], [-0.96, BELT + 0.02, 2.05], [-0.96, ROOF - 0.04, 1.8], [0.96, ROOF - 0.04, 1.8])
  body.profileY('paint', [[-HALF, 1.8], [HALF, 1.8], [HALF, TAIL], [-HALF, TAIL]], ROOF, ROOF + 0.08, { solid: 'roof' })
  for (const s of [1, -1]) body.box('metal', [0.03, 0.03, 3.9], [s * 0.8, ROOF + 0.1, -0.45], { near: true })
  for (const z of [-2.3, -1.4, -0.5, 0.4, 1.3]) body.box('metal', [1.6, 0.03, 0.03], [0, ROOF + 0.1, z], { near: true })

  // Wheel humps inside the cabin.
  for (const [z, long] of [[FRONT_AXLE, 0.92], [REAR_AXLE, 0.88]] as const) {
    for (const s of [1, -1]) body.box('paint', [0.23, 0.3, long], [s * 0.815, FLOOR + 0.15, z], { solid: 'wheelwell' })
  }
  // No engine tunnel: the engine sits under the cab floor, so the middle seat has floor beneath its feet.
  body.box('plastic', [1.86, 0.62, 0.16], [0, FLOOR + 0.31, 2.04], { solid: 'dash' })

  // Seats. Cab seats are single; the rest are benches the width of one or three people.
  for (const s of DANFO_LAYOUT.seats) {
    const wide = s.place.startsWith('bench') || s.place === 'front-middle' ? 0.43 : 0.5
    seatPieces(body, { id: s.id, x: s.position.x, z: s.position.z, floor: FLOOR, width: wide })
  }
  // The back of each cab seat has a grab handle; the doorway has a rail for the step up.
  body.cylinder('metal', 'y', 0.015, 0.015, 0.6, 8, [-HALF + 0.12, FLOOR + 0.5, SLIDE_FRONT + 0.0], { near: true })

  // Steering wheel: tipped back about 29 degrees, hub 0.5 m ahead of the driver's hips.
  const driver = DANFO_LAYOUT.seats[0]!
  const radius = 0.2
  steeringWheelPieces(steer, radius, 0.017)
  const tilt = 0.5
  const frame = vec(driver.position.x, driver.surface + 0.42, driver.position.z + 0.5)
  const quaternion = wheelFrame(tilt)
  // The column runs from the hub down and forward into the dash.
  const columnDirection = new THREE.Vector3(0, -0.45, 0.89).normalize()
  strut(body, 'plastic', frame, vec(frame.x + columnDirection.x * 0.4, frame.y + columnDirection.y * 0.4, frame.z + columnDirection.z * 0.4), 0.06, { near: true })
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
  return { layout: DANFO_LAYOUT, body, doors, steer, steerFrame: { position: frame, quaternion, axis: vec(0, 0, 1) }, steerWheel: null, anchors, obstacles }
}
