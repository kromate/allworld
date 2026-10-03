import type { Vec2 } from './geo.ts'
import type { VehicleKind } from './vehicles.ts'
import { VEHICLE_SPECS, vehiclePoint } from './vehicles.ts'

export const PERSON_RADIUS = 0.34
const SKIN = 0.012
const STEP = 0.1
const CELL = 4
export type FootObstacle =
  | { kind: 'disc'; pos: Vec2; radius: number }
  | { kind: 'box'; pos: Vec2; heading: number; halfWidth: number; halfDepth: number }

/** Local broad phase. Updates replace an owner's cells rather than accumulating old positions. */
export class FootObstacleGrid<Key> {
  private readonly cells = new Map<string, Set<Key>>()
  private readonly entries = new Map<Key, { obstacle: FootObstacle; cells: string[] }>()
  clear(): void { this.cells.clear(); this.entries.clear() }
  remove(key: Key): void {
    const entry = this.entries.get(key)
    if (!entry) return
    for (const cell of entry.cells) { const keys = this.cells.get(cell); keys?.delete(key); if (!keys?.size) this.cells.delete(cell) }
    this.entries.delete(key)
  }
  set(key: Key, obstacle: FootObstacle): void {
    this.remove(key)
    const reach = obstacle.kind === 'disc' ? obstacle.radius : Math.hypot(obstacle.halfWidth, obstacle.halfDepth)
    const cells = this.cellKeys(obstacle.pos.x - reach, obstacle.pos.x + reach, obstacle.pos.z - reach, obstacle.pos.z + reach)
    this.entries.set(key, { obstacle, cells })
    for (const cell of cells) { let keys = this.cells.get(cell); if (!keys) { keys = new Set(); this.cells.set(cell, keys) } keys.add(key) }
  }
  query(from: Vec2, to: Vec2, radius = PERSON_RADIUS): { key: Key; obstacle: FootObstacle }[] {
    const keys = new Set<Key>()
    for (const cell of this.cellKeys(Math.min(from.x, to.x) - radius, Math.max(from.x, to.x) + radius, Math.min(from.z, to.z) - radius, Math.max(from.z, to.z) + radius)) for (const key of this.cells.get(cell) ?? []) keys.add(key)
    const found: { key: Key; obstacle: FootObstacle }[] = []
    for (const key of keys) { const entry = this.entries.get(key); if (entry) found.push({ key, obstacle: entry.obstacle }) }
    return found
  }
  private cellKeys(minX: number, maxX: number, minZ: number, maxZ: number): string[] {
    const out: string[] = []
    for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) out.push(`${x}:${z}`)
    return out
  }
}

function contact(point: Vec2, obstacle: FootObstacle): { gap: number; x: number; z: number } {
  const dx = point.x - obstacle.pos.x, dz = point.z - obstacle.pos.z
  if (obstacle.kind === 'disc') {
    const length = Math.hypot(dx, dz)
    return { gap: length - obstacle.radius, x: length > 1e-8 ? dx / length : 1, z: length > 1e-8 ? dz / length : 0 }
  }
  const cos = Math.cos(obstacle.heading), sin = Math.sin(obstacle.heading)
  const x = dx * cos - dz * sin, z = dx * sin + dz * cos
  const nearX = Math.max(-obstacle.halfWidth, Math.min(obstacle.halfWidth, x)), nearZ = Math.max(-obstacle.halfDepth, Math.min(obstacle.halfDepth, z))
  let nx = x - nearX, nz = z - nearZ, gap = Math.hypot(nx, nz)
  if (gap > 1e-8) { nx /= gap; nz /= gap }
  else if (obstacle.halfWidth - Math.abs(x) < obstacle.halfDepth - Math.abs(z)) { gap = Math.abs(x) - obstacle.halfWidth; nx = x < 0 ? -1 : 1; nz = 0 }
  else { gap = Math.abs(z) - obstacle.halfDepth; nx = 0; nz = z < 0 ? -1 : 1 }
  return { gap, x: nx * cos + nz * sin, z: -nx * sin + nz * cos }
}

/** Swept mover-only response. Existing overlaps may escape; nothing pushes or teleports another actor. */
export function moveFoot(from: Vec2, to: Vec2, obstacles: readonly FootObstacle[], standable: (point: Vec2) => boolean = () => true): Vec2 {
  const distance = Math.hypot(to.x - from.x, to.z - from.z)
  if (!Number.isFinite(distance) || distance > 64) return { ...from }
  const steps = Math.max(1, Math.ceil(distance / STEP)), dx = (to.x - from.x) / steps, dz = (to.z - from.z) / steps
  let pos = { ...from }
  const allowed = (next: Vec2): boolean => standable(next) && obstacles.every(obstacle => {
    const before = contact(pos, obstacle).gap, after = contact(next, obstacle).gap
    return after >= PERSON_RADIUS + SKIN - 1e-6 || (before < PERSON_RADIUS + SKIN && after >= before - 1e-6)
  })
  for (let step = 0; step < steps; step++) {
    const target = { x: pos.x + dx, z: pos.z + dz }
    if (allowed(target)) { pos = target; continue }
    let sx = dx, sz = dz
    for (let iteration = 0; iteration < 3; iteration++) for (const obstacle of obstacles) {
      if (contact({ x: pos.x + sx, z: pos.z + sz }, obstacle).gap >= PERSON_RADIUS + SKIN) continue
      const normal = contact(pos, obstacle), toward = sx * normal.x + sz * normal.z
      if (toward < 0) { sx -= toward * normal.x; sz -= toward * normal.z }
    }
    const slide = { x: pos.x + sx, z: pos.z + sz }
    if (allowed(slide)) pos = slide
    else {
      const x = { x: pos.x + dx, z: pos.z }, z = { x: pos.x, z: pos.z + dz }
      if (allowed(x)) pos = x
      else if (allowed(z)) pos = z
    }
  }
  return pos
}

/** One body shape from the existing authoritative spec, never a second vehicle simulation. */
export function vehicleFootObstacle(kind: VehicleKind, pos: Vec2, heading: number): FootObstacle {
  const { front, rear, halfWidth } = VEHICLE_SPECS[kind].footprint
  return { kind: 'box', pos: vehiclePoint(pos, heading, 0, (front - rear) / 2), heading, halfWidth, halfDepth: (front + rear) / 2 }
}
