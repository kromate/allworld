// Planning the rooms of a home: the checks and the small edits the build window makes before it asks
// the service for a price. Everything here is pure, so a probe runs it on synthetic plans. It judges
// with the contract's own `planProblem`; it never decides a price or that anything is committed.
import {
  HOME_RULES, HOME_WALK_MARGIN, MAIN_ROOM_ID, WALL_SIDES, blocksWalking, planProblem, roomAt, roomKind, sharedWall,
} from '../../shared/homes.ts'
import type { HomeChange, HomeItemMove, HomePlan, HomePlanDraft, HomeRoomDraft, HouseType, PlanInput, RoomKindId, WallLine } from '../../shared/homes.ts'
import type { Vec2 } from '../../shared/geo.ts'
import type { PlacedItem } from '../../shared/social.ts'

export type Footprint = (model: string, turns: number) => { width: number; depth: number }
type Box = { x: number; z: number; width: number; depth: number }

/** Half a door and the wall kept beside it: a door's middle stays this far from the ends of the wall it is in. */
const REACH = HOME_RULES.doorWidth / 2 + HOME_RULES.doorMargin
const STEP = HOME_RULES.grid

export const FLOOR_SWATCHES = ['#e9d2b0', '#a98467', '#d9d2c3', '#9aa5ab', '#c9926f', '#aebfa5'] as const
export const WALL_SWATCHES = ['#f4efe6', '#e9e4f0', '#e8f1f2', '#f3e3cf', '#dfe8d8', '#f1d9d2', '#d8dee9'] as const

// ── Drafts ────────────────────────────────────────────────────────────────────────────────────

export const draftOf = (plan: HomePlan): HomePlanDraft => ({
  rooms: plan.rooms.map(room => ({ id: room.id, kind: room.kind, x: room.x, z: room.z, width: room.width, depth: room.depth, floor: room.floor, wall: room.wall })),
  doors: plan.doors.map(door => ({ a: door.a, b: door.b, at: door.at })),
  entrance: { roomId: plan.entrance.roomId, side: plan.entrance.side, at: plan.entrance.at },
})
export const copyDraft = (draft: HomePlanDraft): HomePlanDraft => JSON.parse(JSON.stringify(draft)) as HomePlanDraft
export const sameDraft = (a: HomePlanDraft, b: HomePlanDraft): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The draft as the contract's check reads it. Door ids are only for the check; the service gives the real ones. */
export const inputOf = (draft: HomePlanDraft): PlanInput => ({
  rooms: draft.rooms.map(room => ({ ...room })),
  doors: draft.doors.map((door, index) => ({ id: `x${index + 1}`, ...door })),
  entrance: { ...draft.entrance },
})
export const problemOf = (draft: HomePlanDraft, type: HouseType): string | null => planProblem(inputOf(draft), type)

export const areaOf = (room: Box): number => room.width * room.depth
export const nextRoomName = (draft: HomePlanDraft): string => {
  for (let index = 1; ; index++) if (!draft.rooms.some(room => room.id === `new${index}`)) return `new${index}`
}

export const boundsOf = (rooms: readonly Box[]): Box => {
  if (!rooms.length) return { x: 0, z: 0, width: 0, depth: 0 }
  const x = Math.min(...rooms.map(room => room.x)), z = Math.min(...rooms.map(room => room.z))
  return { x, z, width: Math.max(...rooms.map(room => room.x + room.width)) - x, depth: Math.max(...rooms.map(room => room.z + room.depth)) - z }
}
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth

// ── Doors ─────────────────────────────────────────────────────────────────────────────────────

/** Every position along a shared wall where a door's middle may be: on the grid, with wall left each side. */
export function doorPositions(wall: WallLine): number[] {
  const out: number[] = []
  for (let at = Math.ceil((wall.from + REACH) / STEP) * STEP; at <= wall.to - REACH + 1e-9; at += STEP) out.push(at)
  return out
}

/** Where a character stands each side of a door: the points the service keeps clear. */
export function standingPoints(wall: WallLine, at: number): [Vec2, Vec2] {
  const step = HOME_RULES.entranceInset
  return wall.along === 'x' ? [{ x: at, z: wall.line - step }, { x: at, z: wall.line + step }] : [{ x: wall.line - step, z: at }, { x: wall.line + step, z: at }]
}

/** Pieces in the way that stand on these points. */
export function blockersAt(points: readonly Vec2[], items: readonly PlacedItem[], footprintOf: Footprint): PlacedItem[] {
  return items.filter(item => {
    if (!blocksWalking(item.model)) return false
    const size = footprintOf(item.model, item.turns)
    const x = item.x * STEP, z = item.z * STEP
    return points.some(point => Math.abs(point.x - x) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(point.z - z) < size.depth / 2 + HOME_WALK_MARGIN)
  })
}

/** The door a new room gets by default: on its longest shared wall, nearest the middle, and not behind a piece of furniture. */
export function autoDoor(rooms: readonly HomeRoomDraft[], room: HomeRoomDraft, items: readonly PlacedItem[], footprintOf: Footprint): { a: string; b: string; at: number } | null {
  let best: { a: string; b: string; at: number; length: number } | null = null
  for (const other of rooms) {
    if (other.id === room.id) continue
    const wall = sharedWall(other, room)
    if (!wall) continue
    const middle = (wall.from + wall.to) / 2
    const free = doorPositions(wall).filter(at => !blockersAt(standingPoints(wall, at), items, footprintOf).length).sort((p, q) => Math.abs(p - middle) - Math.abs(q - middle))
    const at = free[0]
    if (at !== undefined && (!best || wall.to - wall.from > best.length)) best = { a: other.id, b: room.id, at, length: wall.to - wall.from }
  }
  return best ? { a: best.a, b: best.b, at: best.at } : null
}

/** The shared wall of a door, or null when its two rooms no longer touch. */
export function wallOfDoor(draft: HomePlanDraft, door: { a: string; b: string }): WallLine | null {
  const a = draft.rooms.find(room => room.id === door.a), b = draft.rooms.find(room => room.id === door.b)
  return a && b ? sharedWall(a, b) : null
}

/** After a room changes size, keep each door of the plan on a wall that still exists, nudging it to the nearest position that is allowed. */
export function repairOpenings(draft: HomePlanDraft): HomePlanDraft {
  const next = copyDraft(draft)
  next.doors = next.doors.flatMap(door => {
    const wall = wallOfDoor(next, door)
    if (!wall) return []
    const spots = doorPositions(wall)
    if (!spots.length) return []
    return [{ ...door, at: spots.reduce((best, at) => Math.abs(at - door.at) < Math.abs(best - door.at) ? at : best, spots[0]!) }]
  })
  const front = next.rooms.find(room => room.id === next.entrance.roomId)
  if (front) {
    const wall = wallSpan(front, next.entrance.side)
    const spots = doorPositions(wall)
    if (spots.length) next.entrance.at = spots.reduce((best, at) => Math.abs(at - next.entrance.at) < Math.abs(best - next.entrance.at) ? at : best, spots[0]!)
  }
  return next
}

const wallSpan = (room: Box, side: HomePlanDraft['entrance']['side']): WallLine => (
  side === 'north' || side === 'south'
    ? { along: 'x', line: side === 'north' ? room.z : room.z + room.depth, from: room.x, to: room.x + room.width }
    : { along: 'z', line: side === 'west' ? room.x : room.x + room.width, from: room.z, to: room.z + room.depth }
)
export const entranceWall = (draft: HomePlanDraft): WallLine | null => {
  const room = draft.rooms.find(entry => entry.id === draft.entrance.roomId)
  return room ? wallSpan(room, draft.entrance.side) : null
}

// ── Edits ─────────────────────────────────────────────────────────────────────────────────────

export function withRoom(draft: HomePlanDraft, room: HomeRoomDraft, door: { a: string; b: string; at: number } | null): HomePlanDraft {
  const next = copyDraft(draft)
  next.rooms.push({ ...room })
  if (door) next.doors.push({ ...door })
  return next
}

export function withoutRoom(draft: HomePlanDraft, roomId: string): HomePlanDraft {
  const next = copyDraft(draft)
  next.rooms = next.rooms.filter(room => room.id !== roomId)
  next.doors = next.doors.filter(door => door.a !== roomId && door.b !== roomId)
  return next
}

export function withSize(draft: HomePlanDraft, roomId: string, width: number, depth: number): HomePlanDraft {
  const next = copyDraft(draft)
  const room = next.rooms.find(entry => entry.id === roomId)
  if (room) { room.width = width; room.depth = depth }
  return repairOpenings(next)
}

export function withColours(draft: HomePlanDraft, roomId: string, colours: { floor?: string; wall?: string }): HomePlanDraft {
  const next = copyDraft(draft)
  const room = next.rooms.find(entry => entry.id === roomId)
  if (room) { if (colours.floor) room.floor = colours.floor; if (colours.wall) room.wall = colours.wall }
  return next
}

export function withDoorAt(draft: HomePlanDraft, index: number, at: number): HomePlanDraft {
  const next = copyDraft(draft)
  const door = next.doors[index]
  if (door) door.at = at
  return next
}

export function withDoor(draft: HomePlanDraft, door: { a: string; b: string; at: number }): HomePlanDraft {
  const next = copyDraft(draft)
  next.doors.push({ ...door })
  return next
}

export function withoutDoor(draft: HomePlanDraft, index: number): HomePlanDraft {
  const next = copyDraft(draft)
  next.doors.splice(index, 1)
  return next
}

export function withEntrance(draft: HomePlanDraft, entrance: HomePlanDraft['entrance']): HomePlanDraft {
  const next = copyDraft(draft)
  next.entrance = { ...entrance }
  return next
}

/** Where the front door can go on a room: every side with room for it, at each position the grid allows. */
export function frontDoorOptions(draft: HomePlanDraft, roomId: string): { side: HomePlanDraft['entrance']['side']; positions: number[] }[] {
  const room = draft.rooms.find(entry => entry.id === roomId)
  if (!room) return []
  return WALL_SIDES.map(side => ({ side, positions: doorPositions(wallSpan(room, side)) })).filter(option => option.positions.length > 0)
}

// ── Where a new room can go ───────────────────────────────────────────────────────────────────

/**
 * Every corner at which a room of this kind and size can be added: touching a room along a wall long
 * enough for a door, inside the plot, clear of the front door, with a door that does not stand
 * behind a piece of furniture. Each is checked with the contract's `planProblem`.
 */
export function roomSpots(draft: HomePlanDraft, kind: RoomKindId, width: number, depth: number, type: HouseType, items: readonly PlacedItem[], footprintOf: Footprint): { x: number; z: number }[] {
  const bounds = boundsOf(draft.rooms)
  const spots: { x: number; z: number }[] = []
  const probe: HomeRoomDraft = { id: nextRoomName(draft), kind, x: 0, z: 0, width, depth, floor: roomKind(kind).floor, wall: roomKind(kind).wall }
  const lowX = Math.max(bounds.x - width, -HOME_RULES.planSpan), highX = Math.min(bounds.x + bounds.width, HOME_RULES.planSpan - width)
  const lowZ = Math.max(bounds.z - depth, -HOME_RULES.planSpan), highZ = Math.min(bounds.z + bounds.depth, HOME_RULES.planSpan - depth)
  for (let x = lowX; x <= highX; x++) for (let z = lowZ; z <= highZ; z++) {
    const candidate = { ...probe, x, z }
    if (draft.rooms.some(room => overlaps(room, candidate))) continue
    const total = boundsOf([...draft.rooms, candidate])
    if (total.width > type.plot.width || total.depth > type.plot.depth) continue
    const door = autoDoor(draft.rooms, candidate, items, footprintOf)
    if (!door) continue
    if (problemOf(withRoom(draft, candidate, door), type) === null) spots.push({ x, z })
  }
  return spots
}

/** The spot nearest to a wanted corner, or null when there are none. */
export const nearestSpot = (spots: readonly { x: number; z: number }[], wanted: Vec2): { x: number; z: number } | null =>
  spots.reduce<{ x: number; z: number } | null>((best, spot) => !best || Math.hypot(spot.x - wanted.x, spot.z - wanted.z) < Math.hypot(best.x - wanted.x, best.z - wanted.z) ? spot : best, null)

// ── What a change does to the furniture ───────────────────────────────────────────────────────

const cellOf = (item: Pick<PlacedItem, 'x' | 'z'>): Vec2 => ({ x: item.x * STEP, z: item.z * STEP })

/** Pieces that the draft leaves outside every room. */
export const strandedPieces = (items: readonly PlacedItem[], draft: HomePlanDraft): PlacedItem[] => items.filter(item => !roomAt(draft.rooms, cellOf(item)))

/** Pieces that stand where a door, new in this draft, would be walked through. */
export function blockedOpenings(current: HomePlan, draft: HomePlanDraft, items: readonly PlacedItem[], footprintOf: Footprint): { item: PlacedItem; what: string }[] {
  const out: { item: PlacedItem; what: string }[] = []
  for (const door of draft.doors) {
    const kept = current.doors.some(old => old.at === door.at && ((old.a === door.a && old.b === door.b) || (old.a === door.b && old.b === door.a)))
    if (kept) continue
    const wall = wallOfDoor(draft, door)
    if (!wall) continue
    for (const item of blockersAt(standingPoints(wall, door.at), items, footprintOf)) out.push({ item, what: 'a new doorway' })
  }
  const front = draft.entrance
  if (front.roomId !== current.entrance.roomId || front.side !== current.entrance.side || front.at !== current.entrance.at) {
    const wall = entranceWall(draft)
    if (wall) {
      const inward = front.side === 'north' || front.side === 'west' ? 1 : -1
      const point = wall.along === 'x' ? { x: front.at, z: wall.line + inward * HOME_RULES.entranceInset } : { x: wall.line + inward * HOME_RULES.entranceInset, z: front.at }
      for (const item of blockersAt([point], items, footprintOf)) out.push({ item, what: 'the new front door' })
    }
  }
  return out
}

/** The change to ask a price for: this plan, and every stranded piece sent to storage, named, so nothing is dropped unseen. */
export function layoutChange(draft: HomePlanDraft, items: readonly PlacedItem[]): Extract<HomeChange, { kind: 'layout' }> {
  const moves: HomeItemMove[] = strandedPieces(items, draft).map(item => ({ key: item.key, to: 'storage' as const }))
  return { kind: 'layout', plan: copyDraft(draft), items: moves }
}

/** The plan with the cells it uses, for a drawing: the grid to show, every room, and the plot a house of this type may fill. */
export function viewOf(draft: HomePlanDraft, type: HouseType): { x: number; z: number; width: number; depth: number } {
  const bounds = boundsOf(draft.rooms)
  const x = bounds.x + bounds.width - type.plot.width, z = bounds.z + bounds.depth - type.plot.depth
  const x1 = bounds.x + type.plot.width, z1 = bounds.z + type.plot.depth
  return { x: Math.max(x, -HOME_RULES.planSpan), z: Math.max(z, -HOME_RULES.planSpan), width: Math.min(x1, HOME_RULES.planSpan) - Math.max(x, -HOME_RULES.planSpan), depth: Math.min(z1, HOME_RULES.planSpan) - Math.max(z, -HOME_RULES.planSpan) }
}

export { MAIN_ROOM_ID }
