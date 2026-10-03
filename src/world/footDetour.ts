// A way on foot round standing vehicles. Presentation only: it orders points the walker may already
// stand on, and the service still judges every step that is sent.
import type { Vec2 } from '../shared/geo.ts'
import { PERSON_RADIUS } from '../shared/worldCollision.ts'
import type { FootObstacle } from '../shared/worldCollision.ts'

type Box = Extract<FootObstacle, { kind: 'box' }>
/** moveFoot refuses below PERSON_RADIUS + 0.012. Legs keep a little more so a sent chord still passes the service sweep. */
const LEG_CLEAR = PERSON_RADIUS + 0.045
const SAMPLE = 0.1
const REACH = 40
/** How far outside a body's corners the walk-round turns. */
const CORNER_OFFSET = 0.65
/** A leg is looked at once a standing body is this close to the walker. */
const NEAR = PERSON_RADIUS + 2.5
/** Walk-rounds one route may be given, so a stall cannot put off the give-up for ever. */
export const DETOUR_REPLANS = 4

const local = (box: Box, point: Vec2): { x: number; z: number } => {
  const dx = point.x - box.pos.x, dz = point.z - box.pos.z, cos = Math.cos(box.heading), sin = Math.sin(box.heading)
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos }
}
/** Square-cornered gap, as the service grows a body for a destination. Never more than the rounded gap moveFoot uses. */
const boxGap = (box: Box, point: Vec2): number => {
  const at = local(box, point)
  return Math.max(Math.abs(at.x) - box.halfWidth, Math.abs(at.z) - box.halfDepth)
}
const roundGap = (box: Box, point: Vec2): number => {
  const at = local(box, point)
  return Math.hypot(Math.max(0, Math.abs(at.x) - box.halfWidth), Math.max(0, Math.abs(at.z) - box.halfDepth))
}
const corners = (box: Box, offset: number): Vec2[] => {
  const cos = Math.cos(box.heading), sin = Math.sin(box.heading)
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]) => {
    const x = sx * (box.halfWidth + offset), z = sz * (box.halfDepth + offset)
    return { x: box.pos.x + x * cos + z * sin, z: box.pos.z - x * sin + z * cos }
  })
}
/** A leg is clear when every sample is standable and keeps LEG_CLEAR from every box; a start already closer may only move away. */
function legClear(from: Vec2, to: Vec2, boxes: readonly Box[], standable: (point: Vec2) => boolean): boolean {
  const length = Math.hypot(to.x - from.x, to.z - from.z), steps = Math.max(1, Math.ceil(length / SAMPLE))
  const previous = boxes.map(box => boxGap(box, from)), leaving = previous.map(gap => gap < LEG_CLEAR)
  for (let step = 1; step <= steps; step++) {
    const point = { x: from.x + (to.x - from.x) * step / steps, z: from.z + (to.z - from.z) * step / steps }
    if (!standable(point)) return false
    for (const [index, box] of boxes.entries()) {
      const gap = boxGap(box, point)
      if (gap >= LEG_CLEAR) leaving[index] = false
      else if (!leaving[index] || gap < previous[index]! - 1e-9) return false
      previous[index] = gap
    }
  }
  return true
}

/**
 * Waypoints from `from` to `to` round the standing boxes, ending at `to`; null when the straight leg
 * is already clear, when there is no clear way, or when either end is inside a box's clearance.
 */
export function footDetour(from: Vec2, to: Vec2, obstacles: readonly FootObstacle[], standable: (point: Vec2) => boolean, cornerOffset = CORNER_OFFSET): Vec2[] | null {
  const boxes = obstacles.filter((obstacle): obstacle is Box => obstacle.kind === 'box')
  if (!boxes.length || Math.hypot(to.x - from.x, to.z - from.z) > REACH) return null
  if (boxes.some(box => boxGap(box, to) < LEG_CLEAR || roundGap(box, from) < PERSON_RADIUS)) return null
  if (legClear(from, to, boxes, standable)) return null
  const nodes: Vec2[] = [from, to]
  for (const box of boxes) for (const corner of corners(box, cornerOffset)) if (standable(corner) && boxes.every(other => boxGap(other, corner) >= LEG_CLEAR)) nodes.push(corner)
  const cost = nodes.map(() => Infinity), came = nodes.map(() => -1), done = nodes.map(() => false)
  cost[0] = 0
  for (;;) {
    let current = -1
    for (let index = 0; index < nodes.length; index++) if (!done[index] && cost[index]! < Infinity && (current < 0 || cost[index]! < cost[current]!)) current = index
    if (current < 0 || current === 1) break
    done[current] = true
    for (let next = 1; next < nodes.length; next++) {
      if (done[next]) continue
      const total = cost[current]! + Math.hypot(nodes[next]!.x - nodes[current]!.x, nodes[next]!.z - nodes[current]!.z)
      if (total < cost[next]! && legClear(nodes[current]!, nodes[next]!, boxes, standable)) { cost[next] = total; came[next] = current }
    }
  }
  if (cost[1] === Infinity) return null
  const out: Vec2[] = []
  for (let index = 1; index > 0; index = came[index]!) out.unshift({ ...nodes[index]! })
  return out
}

/** True when a standing body is close enough to the walker for the leg ahead to be worth looking at. */
export function standingNear(from: Vec2, standing: readonly FootObstacle[]): boolean {
  return standing.some(obstacle => obstacle.kind === 'box' && roundGap(obstacle, from) <= NEAR)
}

/**
 * A walk-round for the head of a route: the points to put in front of it, how many waypoints they replace,
 * and how many of the points are turns the route did not have. Null when no walk-round is needed or possible.
 * Up to three waypoints ahead are tried, because a street point may itself lie under a body; a long leg is taken to a point along it.
 */
export function detourAhead(from: Vec2, path: readonly Vec2[], standing: readonly FootObstacle[], standable: (point: Vec2) => boolean): { points: Vec2[]; replaces: number; turns: number } | null {
  const boxes = standing.filter((obstacle): obstacle is Box => obstacle.kind === 'box' && roundGap(obstacle, from) <= REACH)
  for (let ahead = 0; ahead < Math.min(3, path.length); ahead++) {
    const aim = path[ahead]!, far = Math.hypot(aim.x - from.x, aim.z - from.z)
    const stops = far <= REACH ? [aim] : ahead === 0 ? [24, 32].map(metres => ({ x: from.x + (aim.x - from.x) * metres / far, z: from.z + (aim.z - from.z) * metres / far })) : []
    for (const stop of stops) {
      const points = footDetour(from, stop, boxes, standable)
      if (points) return far <= REACH ? { points, replaces: ahead + 1, turns: points.length - 1 } : { points, replaces: 0, turns: points.length }
    }
  }
  return null
}
