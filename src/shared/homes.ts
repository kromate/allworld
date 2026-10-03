// Home building and its game economy: the kind of house, its rooms and doors, furniture bought
// with coins, and where the house stands on the map.
//
// Coins are the play money of travel.ts: earned by playing, never bought, never real money and
// never passed between members. Every price here is game policy, set to sit beside a meal (8 to
// 34 coins), a shift (about 100 to 150) and a passport (400). None of it is a real price for a
// real thing. Real products and their real prices are the Market's (market.ts) and are untouched.
//
// A home is still the virtual home of social.ts: the same id, name, visiting rule and furniture.
// What is added is declared here and hangs off `Home.building`. The service is the authority for
// all of it; the functions below are the rules both sides run, so the App can check a plan before
// it asks and the service can refuse one that is wrong.
import type { DistrictId, HomeId, Id, Iso } from './ids.ts'
import type { Vec2 } from './geo.ts'
import type { ChatMessage, CoarseArea, RoomSnapshot } from './model.ts'
import type { Home } from './social.ts'

type Empty = Record<string, never>
type Op<In, Out> = { in: In; out: Out }

export type HomeQuoteId = Id<'homeQuote'>

// ── Rules ─────────────────────────────────────────────────────────────────────────────────────

export const HOME_RULES = {
  /** Rooms sit on whole metres. Furniture and door positions sit on this step, in metres. */
  grid: 0.5,
  /** Width of a door opening, and the wall that must be left on each side of it, in metres. */
  doorWidth: 1.2,
  doorMargin: 0.4,
  /** How far inside the front door a character is stood, in metres. */
  entranceInset: 0.6,
  /** Clear ground kept in front of the front door, in metres. No room may be built on it. */
  entranceApron: 2,
  /** Game policy: coins per square metre of a new room, and of floor added to a room. */
  coinsPerSquareMetre: 12,
  /** A price is held for this long. After that, ask again. */
  quoteMinutes: 10,
  /** Bought pieces of furniture one member may own, placed and stored together. Free pieces do not count. */
  ownedLimit: 400,
  /** One furniture purchase: at most this many different pieces, and this many of each. */
  purchaseLines: 20,
  purchaseQuantity: 20,
  /** Receipts kept per member. A request repeated after its receipt was dropped is a new request. */
  receiptsKept: 40,
  /** No room corner may be further than this from the main room's corner, in metres. */
  planSpan: 48,
} as const

/** The client's own id for one intent: 8 to 64 of these characters. Send the same one again after a lost answer. */
export const HOME_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

/** Bump when a price, a limit or a row below changes, so a window can tell its copy is old. */
export const HOME_CATALOG_VERSION = '058.3a'

// ── House types ───────────────────────────────────────────────────────────────────────────────

export const HOUSE_TYPE_IDS = ['studio', 'bungalow', 'house', 'villa'] as const
export type HouseTypeId = (typeof HOUSE_TYPE_IDS)[number]

export interface HouseType {
  id: HouseTypeId
  label: string
  about: string
  /** A home only moves up: to a type with a higher tier. */
  tier: number
  /** Game policy, in coins. Moving up costs the difference between the two types. */
  price: number
  maxRooms: number
  /** The largest box all the rooms together may fill, in metres. */
  plot: { width: number; depth: number }
  /** Pieces of furniture that may stand in the rooms at once. */
  itemLimit: number
  /** What the outside is drawn from. `style` names the shell; colours are #rrggbb. */
  exterior: { style: HouseTypeId; roof: string; storeys: 1 }
}

/** One row per type, lowest tier first. Every home starts as the first. */
export const HOUSE_TYPES: readonly HouseType[] = [
  { id: 'studio', label: 'Studio', about: 'One room. Where every home starts.', tier: 0, price: 0, maxRooms: 1, plot: { width: 16, depth: 16 }, itemLimit: 80, exterior: { style: 'studio', roof: '#8a5a44', storeys: 1 } },
  { id: 'bungalow', label: 'Bungalow', about: 'Room for a bedroom and a kitchen beside the main room.', tier: 1, price: 600, maxRooms: 3, plot: { width: 22, depth: 20 }, itemLimit: 120, exterior: { style: 'bungalow', roof: '#7a4b3a', storeys: 1 } },
  { id: 'house', label: 'Family house', about: 'Five rooms on a wider plot.', tier: 2, price: 1500, maxRooms: 5, plot: { width: 28, depth: 24 }, itemLimit: 170, exterior: { style: 'house', roof: '#5f4a57', storeys: 1 } },
  { id: 'villa', label: 'Villa', about: 'Eight rooms and the largest plot.', tier: 3, price: 3200, maxRooms: 8, plot: { width: 34, depth: 30 }, itemLimit: 240, exterior: { style: 'villa', roof: '#3f5a66', storeys: 1 } },
]
export const houseType = (id: HouseTypeId): HouseType => HOUSE_TYPES.find(entry => entry.id === id) ?? HOUSE_TYPES[0]!
/** The most pieces any type holds: the bound on a saved layout before the home's own type is known. */
export const HOME_ITEM_LIMIT_MAX = Math.max(...HOUSE_TYPES.map(entry => entry.itemLimit))

/** Coins to move from one type up to another. Null when that is not a move up. */
export function upgradePrice(from: HouseTypeId, to: HouseTypeId): number | null {
  const a = houseType(from), b = houseType(to)
  return b.tier > a.tier ? b.price - a.price : null
}

// ── Room kinds ────────────────────────────────────────────────────────────────────────────────

export const ROOM_KIND_IDS = ['main', 'living', 'bedroom', 'kitchen', 'bathroom', 'study', 'hall'] as const
export type RoomKindId = (typeof ROOM_KIND_IDS)[number]

export interface RoomKind {
  id: RoomKindId
  label: string
  /** Game policy, in coins, on top of the floor area. The main room is never bought. */
  base: number
  min: { width: number; depth: number }
  max: { width: number; depth: number }
  /** Colours a new room of this kind starts with, #rrggbb. */
  floor: string
  wall: string
}

/** One row per kind. `main` is the room every home already has; the rest are built. */
export const ROOM_KINDS: readonly RoomKind[] = [
  { id: 'main', label: 'Main room', base: 0, min: { width: 8, depth: 8 }, max: { width: 16, depth: 16 }, floor: '#e9d2b0', wall: '#f4efe6' },
  { id: 'living', label: 'Living room', base: 150, min: { width: 4, depth: 4 }, max: { width: 10, depth: 10 }, floor: '#d9c3a3', wall: '#f1ece2' },
  { id: 'bedroom', label: 'Bedroom', base: 120, min: { width: 3, depth: 3 }, max: { width: 8, depth: 8 }, floor: '#cdb49a', wall: '#e9e4f0' },
  { id: 'kitchen', label: 'Kitchen', base: 160, min: { width: 3, depth: 3 }, max: { width: 8, depth: 8 }, floor: '#c9c4b8', wall: '#f3f1e7' },
  { id: 'bathroom', label: 'Bathroom', base: 140, min: { width: 2, depth: 2 }, max: { width: 5, depth: 5 }, floor: '#b9c7cc', wall: '#e8f1f2' },
  { id: 'study', label: 'Study', base: 120, min: { width: 3, depth: 3 }, max: { width: 7, depth: 7 }, floor: '#bfa583', wall: '#ece6da' },
  { id: 'hall', label: 'Hall', base: 60, min: { width: 2, depth: 2 }, max: { width: 12, depth: 12 }, floor: '#d6c8b2', wall: '#f2eee6' },
]
export const roomKind = (id: RoomKindId): RoomKind => ROOM_KINDS.find(entry => entry.id === id) ?? ROOM_KINDS[0]!

/** Coins for a new room of this kind and size. */
export const roomPrice = (kind: RoomKindId, width: number, depth: number): number => roomKind(kind).base + width * depth * HOME_RULES.coinsPerSquareMetre
/** Coins for making a room bigger. A room made smaller gives nothing back. */
export const growthPrice = (fromArea: number, toArea: number): number => Math.max(0, toArea - fromArea) * HOME_RULES.coinsPerSquareMetre

// ── Furniture ─────────────────────────────────────────────────────────────────────────────────

export interface FurnitureListing {
  /** A model name from the furniture pack (src/assets/furniture.index.json). */
  model: string
  group: string
  /** Game policy, in coins, for one piece. For a `free` piece: what it would cost if it stopped being free. */
  price: number
  /**
   * Any member may place this piece without buying it. These are the pieces the home editor
   * offered before there was a shop, and they keep working as they did. A piece that is not free
   * is placed only by a home that owns one.
   */
  free: boolean
}

const FREE = 'free'

/**
 * The furniture, one row per piece: `[model, coins]`, or `[model, coins, FREE]` for a piece every
 * member may place without buying. To add a piece, add a row: the model must be in the furniture
 * pack and stand on the floor. Wall, ceiling and structural parts are left out on purpose. To make
 * a free piece something that is bought, take `FREE` off its row: the ones already standing in
 * homes stay owned. A piece a home already holds stays owned even if its row goes.
 */
export const FURNITURE_SHOP: readonly { id: string; label: string; pieces: readonly (readonly [model: string, coins: number, free?: typeof FREE])[] }[] = [
  { id: 'seating', label: 'Seating', pieces: [
    ['loungeSofa', 120, FREE], ['loungeSofaLong', 160, FREE], ['loungeSofaCorner', 180, FREE], ['loungeSofaOttoman', 60], ['loungeDesignSofa', 170, FREE], ['loungeDesignSofaCorner', 210],
    ['loungeChair', 70, FREE], ['loungeChairRelax', 85, FREE], ['loungeDesignChair', 95, FREE], ['chair', 25], ['chairCushion', 35, FREE], ['chairModernCushion', 45, FREE],
    ['chairModernFrameCushion', 50], ['chairRounded', 40, FREE], ['chairDesk', 55, FREE], ['stoolBar', 25, FREE], ['stoolBarSquare', 25], ['bench', 40], ['benchCushion', 55, FREE], ['benchCushionLow', 50],
  ] },
  { id: 'tables', label: 'Tables', pieces: [
    ['table', 60, FREE], ['tableRound', 65, FREE], ['tableCross', 60, FREE], ['tableCrossCloth', 70], ['tableCloth', 70, FREE], ['tableGlass', 90, FREE], ['tableCoffee', 40, FREE], ['tableCoffeeSquare', 40, FREE],
    ['tableCoffeeGlass', 55, FREE], ['tableCoffeeGlassSquare', 55], ['sideTable', 30, FREE], ['sideTableDrawers', 40, FREE], ['desk', 80, FREE], ['deskCorner', 110, FREE],
  ] },
  { id: 'beds', label: 'Beds', pieces: [
    ['bedSingle', 110, FREE], ['bedDouble', 170, FREE], ['bedBunk', 190, FREE], ['cabinetBed', 35, FREE], ['cabinetBedDrawer', 45, FREE], ['cabinetBedDrawerTable', 50],
  ] },
  { id: 'storage', label: 'Storage', pieces: [
    ['bookcaseOpen', 70, FREE], ['bookcaseOpenLow', 50, FREE], ['bookcaseClosed', 85, FREE], ['bookcaseClosedDoors', 95], ['bookcaseClosedWide', 110, FREE], ['cabinetTelevision', 75, FREE],
    ['cabinetTelevisionDoors', 90, FREE], ['coatRack', 20], ['coatRackStanding', 30, FREE], ['cardboardBoxClosed', 5, FREE], ['cardboardBoxOpen', 5], ['trashcan', 10],
  ] },
  { id: 'lighting', label: 'Lighting', pieces: [
    ['lampRoundFloor', 35, FREE], ['lampSquareFloor', 35, FREE], ['lampRoundTable', 20, FREE], ['lampSquareTable', 20, FREE],
  ] },
  { id: 'decor', label: 'Decor', pieces: [
    ['rugRectangle', 45, FREE], ['rugRound', 40, FREE], ['rugRounded', 45, FREE], ['rugSquare', 40, FREE], ['rugDoormat', 12, FREE], ['pottedPlant', 30, FREE], ['plantSmall1', 12, FREE], ['plantSmall2', 12, FREE],
    ['plantSmall3', 12, FREE], ['books', 8, FREE], ['televisionModern', 150, FREE], ['televisionVintage', 90, FREE], ['radio', 35, FREE], ['speaker', 60, FREE], ['speakerSmall', 35], ['bear', 18, FREE],
    ['pillow', 8, FREE], ['pillowBlue', 8], ['pillowLong', 10], ['pillowBlueLong', 10], ['laptop', 140], ['computerScreen', 110], ['computerKeyboard', 20], ['computerMouse', 10],
  ] },
  { id: 'kitchen', label: 'Kitchen', pieces: [
    ['kitchenBar', 70, FREE], ['kitchenBarEnd', 60], ['kitchenCabinet', 60, FREE], ['kitchenCabinetDrawer', 65, FREE], ['kitchenSink', 90, FREE], ['kitchenStove', 130, FREE], ['kitchenStoveElectric', 140],
    ['kitchenFridge', 150, FREE], ['kitchenFridgeSmall', 90, FREE], ['kitchenFridgeLarge', 190], ['kitchenCoffeeMachine', 55, FREE], ['kitchenMicrowave', 60, FREE], ['kitchenBlender', 25], ['toaster', 20, FREE],
  ] },
  { id: 'bathroom', label: 'Bathroom and laundry', pieces: [
    ['toilet', 80], ['toiletSquare', 85], ['bathtub', 160], ['shower', 130], ['showerRound', 140], ['bathroomSink', 70], ['bathroomSinkSquare', 75], ['bathroomCabinet', 45],
    ['bathroomCabinetDrawer', 55], ['bathroomMirror', 30], ['washer', 120], ['dryer', 110], ['washerDryerStacked', 200],
  ] },
]

const LISTINGS = new Map<string, FurnitureListing>()
for (const group of FURNITURE_SHOP) for (const [model, price, free] of group.pieces) LISTINGS.set(model, { model, group: group.id, price, free: free === FREE })
/** The row for a model, or null when it is not in the table. */
export const furnitureListing = (model: string): FurnitureListing | null => LISTINGS.get(model) ?? null
export const furnitureListings = (): FurnitureListing[] => [...LISTINGS.values()]
/** May any member place this model without owning one? */
export const isFreeFurniture = (model: string): boolean => LISTINGS.get(model)?.free === true

/** Furniture kit units to metres. The App's interior uses the same figure to size what it draws. */
export const HOME_FURNITURE_SCALE = 2.2
/** Pieces a character walks through or over. Everything else is in the way. Same rule as the App's interior. */
export const HOME_WALK_THROUGH = /^(rug|pillow|books|lamp.*Table|plantSmall|computer|laptop|radio|toaster|kitchenCoffeeMachine|kitchenMicrowave|kitchenBlender|bear)/
export const blocksWalking = (model: string): boolean => !HOME_WALK_THROUGH.test(model)
/** Margin kept between a character and a piece that is in the way, in metres. */
export const HOME_WALK_MARGIN = 0.25

// ── The plan: rooms, doors, the front door ────────────────────────────────────────────────────
//
// Plan metres: +x east, +z south, the same frame a character's position has inside the home. The
// main room is `r1` and its north-west corner is the origin, always: furniture saved before homes
// had plans keeps its place. Furniture positions are cells of HOME_RULES.grid in this frame
// (`PlacedItem.x * grid` metres), and may be negative in a room built to the west or north.

export type WallSide = 'north' | 'south' | 'east' | 'west'
export const WALL_SIDES = ['north', 'south', 'east', 'west'] as const satisfies readonly WallSide[]
export const MAIN_ROOM_ID = 'r1'

export interface HomeRoom {
  /** `r1`, `r2`, …. Given by the service, never reused in one home, the same after every reload. */
  id: string
  kind: RoomKindId
  /** North-west corner and size, whole plan metres. */
  x: number
  z: number
  width: number
  depth: number
  floor: string
  wall: string
}

export interface HomeDoor {
  /** `d1`, `d2`, …. Given by the service; kept while the same two rooms are joined at the same place. */
  id: string
  a: string
  b: string
  /** Where the middle of the opening is along the wall the two rooms share, plan metres. */
  at: number
  /** The way that wall runs. `x`: the wall is the line z = `z`. `z`: the wall is the line x = `x`. */
  along: 'x' | 'z'
  /** The middle of the opening, plan metres. */
  x: number
  z: number
}

export interface HomeEntrance {
  roomId: string
  side: WallSide
  /** Where the middle of the opening is along that wall, plan metres (x for north and south, z for east and west). */
  at: number
  /** The middle of the opening on the outer wall line, plan metres. */
  x: number
  z: number
  /** The way the door faces, outward: a scene `rotation.y`, forward is (sin h, cos h). South is 0, east π/2. */
  facing: number
  /** Where a character stands just inside, and the way they face (into the room). */
  inside: { pos: Vec2; heading: number }
}

export interface HomePlan {
  /** The shape of this record. */
  schema: 1
  /** Rises by one each time rooms, doors or the front door change. Furniture moving does not change it. */
  version: number
  rooms: HomeRoom[]
  doors: HomeDoor[]
  entrance: HomeEntrance
  /** The box that holds every room, plan metres. */
  bounds: { x: number; z: number; width: number; depth: number }
}

/** A plan as stored or proposed, before the derived fields are worked out. */
export interface PlanInput {
  rooms: HomeRoom[]
  doors: { id: string; a: string; b: string; at: number }[]
  entrance: { roomId: string; side: WallSide; at: number }
}

type Box = Pick<HomeRoom, 'x' | 'z' | 'width' | 'depth'>
export interface WallLine { along: 'x' | 'z'; line: number; from: number; to: number }

const OUTWARD: Record<WallSide, { dx: number; dz: number; facing: number }> = {
  north: { dx: 0, dz: -1, facing: Math.PI }, south: { dx: 0, dz: 1, facing: 0 },
  east: { dx: 1, dz: 0, facing: Math.PI / 2 }, west: { dx: -1, dz: 0, facing: -Math.PI / 2 },
}

export function wallOf(room: Box, side: WallSide): WallLine {
  if (side === 'north' || side === 'south') return { along: 'x', line: side === 'north' ? room.z : room.z + room.depth, from: room.x, to: room.x + room.width }
  return { along: 'z', line: side === 'west' ? room.x : room.x + room.width, from: room.z, to: room.z + room.depth }
}

/** The stretch of wall two rooms share, or null when they do not touch along a wall. */
export function sharedWall(a: Box, b: Box): WallLine | null {
  if (a.x + a.width === b.x || b.x + b.width === a.x) {
    const from = Math.max(a.z, b.z), to = Math.min(a.z + a.depth, b.z + b.depth)
    if (to > from) return { along: 'z', line: a.x + a.width === b.x ? b.x : a.x, from, to }
  }
  if (a.z + a.depth === b.z || b.z + b.depth === a.z) {
    const from = Math.max(a.x, b.x), to = Math.min(a.x + a.width, b.x + b.width)
    if (to > from) return { along: 'x', line: a.z + a.depth === b.z ? b.z : a.z, from, to }
  }
  return null
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth
const boundsOf = (rooms: readonly Box[]): HomePlan['bounds'] => {
  if (rooms.length === 0) return { x: 0, z: 0, width: 0, depth: 0 }
  const x = Math.min(...rooms.map(room => room.x)), z = Math.min(...rooms.map(room => room.z))
  return { x, z, width: Math.max(...rooms.map(room => room.x + room.width)) - x, depth: Math.max(...rooms.map(room => room.z + room.depth)) - z }
}
const onGrid = (value: number): boolean => Number.isFinite(value) && Number.isInteger(value / HOME_RULES.grid)
/** Half an opening plus the wall kept beside it: an opening's middle stays this far from a wall's ends. */
const OPENING_REACH = HOME_RULES.doorWidth / 2 + HOME_RULES.doorMargin

/** The room a point is in, walls included. Null when it is in none. */
export function roomAt(rooms: readonly HomeRoom[], point: Vec2): HomeRoom | null {
  return rooms.find(room => point.x >= room.x && point.x <= room.x + room.width && point.z >= room.z && point.z <= room.z + room.depth) ?? null
}

/** Work out the derived fields of a plan. Does not judge it: see `planProblem`. */
export function resolvePlan(input: PlanInput, version: number): HomePlan {
  const byId = new Map(input.rooms.map(room => [room.id, room]))
  const doors: HomeDoor[] = input.doors.map(door => {
    const a = byId.get(door.a), b = byId.get(door.b)
    const wall = a && b ? sharedWall(a, b) : null
    const along = wall?.along ?? 'x', line = wall?.line ?? 0
    return { id: door.id, a: door.a, b: door.b, at: door.at, along, x: along === 'x' ? door.at : line, z: along === 'x' ? line : door.at }
  })
  const room = byId.get(input.entrance.roomId) ?? input.rooms[0] ?? { x: 0, z: 0, width: 0, depth: 0 }
  const wall = wallOf(room, input.entrance.side), out = OUTWARD[input.entrance.side]
  const x = wall.along === 'x' ? input.entrance.at : wall.line, z = wall.along === 'x' ? wall.line : input.entrance.at
  const entrance: HomeEntrance = {
    roomId: input.entrance.roomId, side: input.entrance.side, at: input.entrance.at, x, z, facing: out.facing,
    inside: { pos: { x: x - out.dx * HOME_RULES.entranceInset, z: z - out.dz * HOME_RULES.entranceInset }, heading: out.facing > 0 ? out.facing - Math.PI : out.facing + Math.PI },
  }
  return { schema: 1, version, rooms: input.rooms.map(entry => ({ ...entry })), doors, entrance, bounds: boundsOf(input.rooms) }
}

/** The two places a character stands to go through a door, one in each room, and the one inside the front door. */
export function doorwayPoints(plan: HomePlan): { opening: string; pos: Vec2 }[] {
  const step = HOME_RULES.entranceInset
  const points: { opening: string; pos: Vec2 }[] = [{ opening: 'entrance', pos: plan.entrance.inside.pos }]
  for (const door of plan.doors) {
    if (door.along === 'x') points.push({ opening: door.id, pos: { x: door.x, z: door.z - step } }, { opening: door.id, pos: { x: door.x, z: door.z + step } })
    else points.push({ opening: door.id, pos: { x: door.x - step, z: door.z } }, { opening: door.id, pos: { x: door.x + step, z: door.z } })
  }
  return points
}

/**
 * What is wrong with a plan for a house of this type, as a sentence to show, or null when it is
 * sound: every room a known kind and size on whole metres, no two rooms overlapping, all of them
 * inside the type's plot, every door on a wall its two rooms share with wall left beside it, every
 * room reachable from the front door through doors, and the front door on an outer wall with
 * clear ground in front of it.
 */
export function planProblem(input: PlanInput, type: HouseType): string | null {
  const { rooms } = input
  const main = rooms.find(room => room.id === MAIN_ROOM_ID)
  if (!main || main.kind !== 'main' || main.x !== 0 || main.z !== 0) return 'The main room stays where it is: it cannot be removed or moved.'
  if (rooms.length > type.maxRooms) return `A ${type.label.toLowerCase()} holds ${type.maxRooms} ${type.maxRooms === 1 ? 'room' : 'rooms'}. Move up to a bigger house to build more.`
  const ids = new Set<string>()
  for (const room of rooms) {
    if (ids.has(room.id)) return 'Two rooms have the same id.'
    ids.add(room.id)
    const kind = ROOM_KINDS.find(entry => entry.id === room.kind)
    if (!kind) return 'That kind of room is not known.'
    if (kind.id === 'main' && room.id !== MAIN_ROOM_ID) return 'A home has one main room.'
    if (![room.x, room.z, room.width, room.depth].every(Number.isInteger)) return 'Rooms sit on whole metres.'
    if (room.width < kind.min.width || room.depth < kind.min.depth || room.width > kind.max.width || room.depth > kind.max.depth) {
      return `A ${kind.label.toLowerCase()} is between ${kind.min.width} by ${kind.min.depth} and ${kind.max.width} by ${kind.max.depth} metres.`
    }
    if (Math.max(Math.abs(room.x), Math.abs(room.z), Math.abs(room.x + room.width), Math.abs(room.z + room.depth)) > HOME_RULES.planSpan) return 'That room is too far from the main room.'
  }
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) if (overlaps(rooms[i]!, rooms[j]!)) return 'Two rooms overlap.'
  const bounds = boundsOf(rooms)
  if (bounds.width > type.plot.width || bounds.depth > type.plot.depth) return `The rooms need ${bounds.width} by ${bounds.depth} metres. A ${type.label.toLowerCase()} has a plot of ${type.plot.width} by ${type.plot.depth}.`

  const byId = new Map(rooms.map(room => [room.id, room]))
  const pairs = new Set<string>(), doorIds = new Set<string>()
  const joined = new Map<string, string[]>()
  for (const door of input.doors) {
    const a = byId.get(door.a), b = byId.get(door.b)
    if (!a || !b || a === b) return 'A door joins two rooms of this home.'
    if (doorIds.has(door.id)) return 'Two doors have the same id.'
    doorIds.add(door.id)
    const pair = [door.a, door.b].sort().join('|')
    if (pairs.has(pair)) return 'Two rooms are joined by one door.'
    pairs.add(pair)
    const wall = sharedWall(a, b)
    if (!wall) return 'A door needs a wall that both rooms share.'
    if (!onGrid(door.at) || door.at < wall.from + OPENING_REACH || door.at > wall.to - OPENING_REACH) return `A door needs ${OPENING_REACH} metres of shared wall on each side of its middle.`
    joined.set(door.a, [...(joined.get(door.a) ?? []), door.b])
    joined.set(door.b, [...(joined.get(door.b) ?? []), door.a])
  }

  const front = byId.get(input.entrance.roomId)
  if (!front) return 'The front door must be in a room of this home.'
  const wall = wallOf(front, input.entrance.side), out = OUTWARD[input.entrance.side]
  if (!onGrid(input.entrance.at) || input.entrance.at < wall.from + OPENING_REACH || input.entrance.at > wall.to - OPENING_REACH) return `The front door needs ${OPENING_REACH} metres of wall on each side of its middle.`
  // The ground just outside: as wide as the opening and the wall kept beside it, and as deep as the apron.
  const apron: Box = wall.along === 'x'
    ? { x: input.entrance.at - OPENING_REACH, width: OPENING_REACH * 2, z: out.dz > 0 ? wall.line : wall.line - HOME_RULES.entranceApron, depth: HOME_RULES.entranceApron }
    : { z: input.entrance.at - OPENING_REACH, depth: OPENING_REACH * 2, x: out.dx > 0 ? wall.line : wall.line - HOME_RULES.entranceApron, width: HOME_RULES.entranceApron }
  if (rooms.some(room => overlaps(room, apron))) return 'The front door must open to the outside, with clear ground in front of it.'

  const reached = new Set<string>([front.id])
  for (const queue = [front.id]; queue.length;) for (const next of joined.get(queue.shift()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next) }
  const cut = rooms.find(room => !reached.has(room.id))
  if (cut) return `The ${roomKind(cut.kind).label.toLowerCase()} cannot be reached from the front door. Join it to another room with a door.`
  return null
}

// ── The house in the street ───────────────────────────────────────────────────────────────────
//
// A placed home is a building in a district of the game's copy of the map. It stands on a parcel:
// a spot the service's own parcel data vouches for, worked out from the trusted map tiles, roads,
// obstacles, places and land use, and from the region's placed props. Nothing about it comes from
// a request, a device or a real address, and nothing here says where a person lives.
//
// A home that is not on a valid parcel cannot be walked into at all. There is no stepping in from
// somewhere else and no arriving at a district's public point instead.
//
// District metres: +x east, +z south, origin the tile centre. A heading is a scene `rotation.y`;
// forward is (sin h, cos h). An angle turns a vector (x, z) into
// (x cos a + z sin a, −x sin a + z cos a), which is what `rotation.y = a` does.

export const HOME_PHYSICAL = {
  /** Thickness of the outer wall, metres. The shell is every room grown by this on each side. */
  wall: 0.2,
  /** Roof edge, trim and door frame may stand out from the shell by at most this, metres. Parcel data keeps that margin clear. */
  eaves: 0.24,
  /** Top of the walls above the ground, metres, for each storey. The roof above is the renderer's. */
  storeyHeight: 3.2,
  /** A character goes in from within this distance of the middle of the front door, metres. */
  doorRange: 1.6,
  /** And from at least this far out from the wall face, on the street side, metres. */
  publicSide: 0.3,
  /** Clear ground kept round a standing or exit point, metres: the radius walking gives a character. */
  clearRadius: 0.55,
  /** An exit point is taken while another character stands within this distance of it, metres. */
  occupiedRadius: 0.8,
  /** Alternate exit points a parcel carries, at most. */
  alternates: 4,
} as const

/**
 * The versions a parcel answers to. `id` and `dataVersion` name the parcel data: `dataVersion` is
 * the SHA-256 of its canonical payload. The other four are what it was worked out from, in the
 * field names the trusted road data uses (`VehicleRoadSceneVersion`): the provider's map revision,
 * the SHA-256 of this district's source tile, of the scene sources, and of the region pack.
 */
export interface HomeParcelSource {
  id: string
  dataVersion: string
  mapDataVersion: string
  tileSha256: string
  sceneHash: string
  regionPackSha256: string
}

/**
 * The ground a parcel keeps for a house, in the door's own frame: origin the middle of the door on
 * the outer face of the wall, +z out into the street (the way the door faces), and x along the
 * front (`doorFrame`). The whole shell must lie in x from `xMin` (≤ 0) to `xMax` (≥ 0) and z from
 * −`depth` to 0. Sized for the biggest house the parcel can ever hold; eaves may overhang it.
 */
export interface HomeEnvelope { xMin: number; xMax: number; depth: number }

/** A parcel as it was when the home was placed on it. Copied into the saved home and never changed after. */
export interface HomeParcelAnchor {
  parcelId: string
  source: HomeParcelSource
  /** The middle of the front door on the outer face of the wall, and the way it faces (outward). */
  door: Vec2
  facing: number
  /** Where a character stands to go in: on the street side, inside `HOME_PHYSICAL.doorRange`, with clear ground round it. */
  standing: Vec2
  /** Where a character is put on coming out, facing `facing`. Beside the door, with clear ground round it. */
  exit: Vec2
  /** Other proved places beside the door, in the order tried when `exit` is taken. At most `HOME_PHYSICAL.alternates`. */
  alternates: Vec2[]
  envelope: HomeEnvelope
  /** The point on a mapped road or footpath that `standing` was proved to be walkable from. */
  access: Vec2
}

/**
 * 'valid': the parcel data the service runs now is the data this anchor was taken from.
 * 'source-missing': the service has no parcel data for the district.
 * 'source-stale': it has, but another version. The home is not moved. It cannot be gone to,
 * drawn or collided with until that version is served again or the owner places it afresh.
 */
export type HomeSiteStatus = 'valid' | 'source-missing' | 'source-stale'

export interface HomeSite {
  districtId: DistrictId
  /** The public name of the area, and the area itself: the parcel data's own, the one a trip there is booked to. */
  areaLabel: string
  area: CoarseArea
  /** The building this home is while it stands here. Random, kept with the placement, new with each placement. */
  buildingId: string
  parcel: HomeParcelAnchor
  status: HomeSiteStatus
  placedAt: Iso
}

export interface HomeBuilding {
  houseType: HouseTypeId
  plan: HomePlan
  /** What the outside is drawn from: the type's shell and roof, and the wall colour of the room with the front door. */
  exterior: { style: HouseTypeId; roof: string; wall: string; storeys: 1 }
  /** Null until the owner places the home, and for a viewer who is not told where it stands (`home.approach` says which). */
  site: HomeSite | null
}

/** A free or taken parcel in the district the member's character is in. */
export interface HomeParcelOption {
  parcelId: string
  label: string
  door: Vec2
  facing: number
  standing: Vec2
  envelope: HomeEnvelope
  /** Another home stands there. Whose is not said. */
  taken: boolean
  /** The member's rooms, as they are now, fit the envelope. */
  fits: boolean
}

/** What a build of the App carries about the parcel data, to say which scene it draws. Never the parcels themselves. */
export interface HomeParcelManifest {
  schemaVersion: 1
  id: string
  dataVersion: string
  mapDataVersion: string
  sceneHash: string
  regionPackSha256: string
  districts: { districtId: DistrictId; tileSha256: string; parcels: number }[]
}

/** The source to send with `home.exteriors` for a district, or null when the manifest does not cover it. */
export function homeParcelSource(manifest: HomeParcelManifest, districtId: DistrictId): HomeParcelSource | null {
  const district = manifest.districts.find(entry => entry.districtId === districtId)
  return district ? {
    id: manifest.id, dataVersion: manifest.dataVersion, mapDataVersion: manifest.mapDataVersion, tileSha256: district.tileSha256,
    sceneHash: manifest.sceneHash, regionPackSha256: manifest.regionPackSha256,
  } : null
}
export const sameParcelSource = (a: HomeParcelSource, b: HomeParcelSource): boolean =>
  a.id === b.id && a.dataVersion === b.dataVersion && a.mapDataVersion === b.mapDataVersion && a.tileSha256 === b.tileSha256 && a.sceneHash === b.sceneHash && a.regionPackSha256 === b.regionPackSha256

// ── From the plan to the street ──
// The service projects with these; a renderer reads the result from `home.exteriors` and never
// works out a footprint or a door for itself.

const EPSILON = 1e-6
const turned = (x: number, z: number, angle: number): Vec2 => {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  return { x: x * cos + z * sin, z: -x * sin + z * cos }
}

/** The middle of the front door on the outer face of the wall, plan metres: the point that stands on a parcel's `door`. */
export function planDoor(plan: Pick<HomePlan, 'entrance'>): Vec2 {
  const { x, z, facing } = plan.entrance
  return { x: x + Math.sin(facing) * HOME_PHYSICAL.wall, z: z + Math.cos(facing) * HOME_PHYSICAL.wall }
}

/** A plan point in the door's frame: see `HomeEnvelope`. */
export function doorFrame(plan: Pick<HomePlan, 'entrance'>, point: Vec2): Vec2 {
  const door = planDoor(plan)
  return turned(point.x - door.x, point.z - door.z, -plan.entrance.facing)
}

/** The turn that carries the plan onto a parcel, and a plan point in district metres. The front door lands on `door`, facing `facing`, wherever in the plan it is. */
export function planPlacement(plan: Pick<HomePlan, 'entrance'>, anchor: Pick<HomeParcelAnchor, 'door' | 'facing'>): { angle: number; toDistrict(point: Vec2): Vec2 } {
  const door = planDoor(plan), angle = anchor.facing - plan.entrance.facing
  return {
    angle,
    toDistrict(point) { const moved = turned(point.x - door.x, point.z - door.z, angle); return { x: anchor.door.x + moved.x, z: anchor.door.z + moved.z } },
  }
}

function without(piece: Box, cut: Box): Box[] {
  const x0 = Math.max(piece.x, cut.x), x1 = Math.min(piece.x + piece.width, cut.x + cut.width)
  const z0 = Math.max(piece.z, cut.z), z1 = Math.min(piece.z + piece.depth, cut.z + cut.depth)
  if (x1 - x0 <= EPSILON || z1 - z0 <= EPSILON) return [piece]
  const parts: Box[] = []
  if (x0 - piece.x > EPSILON) parts.push({ x: piece.x, z: piece.z, width: x0 - piece.x, depth: piece.depth })
  if (piece.x + piece.width - x1 > EPSILON) parts.push({ x: x1, z: piece.z, width: piece.x + piece.width - x1, depth: piece.depth })
  if (z0 - piece.z > EPSILON) parts.push({ x: x0, z: piece.z, width: x1 - x0, depth: z0 - piece.z })
  if (piece.z + piece.depth - z1 > EPSILON) parts.push({ x: x0, z: z1, width: x1 - x0, depth: piece.z + piece.depth - z1 })
  return parts
}

/**
 * The shell, plan metres: every room grown by the outer wall, as rectangles that do not overlap
 * (they may share an edge). Rooms are taken in plan order and each keeps what the earlier ones
 * left, so an L-shaped house stays two rectangles and its inside corner stays open ground.
 */
export function planShell(plan: Pick<HomePlan, 'rooms'>): { x: number; z: number; width: number; depth: number }[] {
  const wall = HOME_PHYSICAL.wall
  const shell: Box[] = []
  for (const room of plan.rooms) {
    let pieces: Box[] = [{ x: room.x - wall, z: room.z - wall, width: room.width + wall * 2, depth: room.depth + wall * 2 }]
    for (const earlier of shell) pieces = pieces.flatMap(piece => without(piece, earlier))
    shell.push(...pieces)
  }
  return shell
}

/** Does the whole shell lie inside a parcel's envelope? */
export function shellFits(plan: Pick<HomePlan, 'rooms' | 'entrance'>, envelope: HomeEnvelope): boolean {
  for (const box of planShell(plan)) {
    for (const corner of [{ x: box.x, z: box.z }, { x: box.x + box.width, z: box.z }, { x: box.x, z: box.z + box.depth }, { x: box.x + box.width, z: box.z + box.depth }]) {
      const at = doorFrame(plan, corner)
      if (at.x < envelope.xMin - EPSILON || at.x > envelope.xMax + EPSILON || at.z > EPSILON || at.z < -envelope.depth - EPSILON) return false
    }
  }
  return true
}

// ── What everyone in the street is sent ──

/** One rectangle of a building's shell, district metres: its middle, its turn, its size along its own x and z, and the top of its walls. */
export interface HomeExteriorFootprint {
  pos: Vec2
  angle: number
  width: number
  depth: number
  height: number
}

/**
 * A building as scenery. It says nothing of whose it is: no home, no member, no name, no visiting
 * rule, no room, no furniture. Every member in the district is sent the same list, so everyone
 * sees the walls the service collides against.
 */
export interface HomeExteriorScenery {
  /** Random, kept with the placement. Never a HomeId or a MemberId, nor worked out from one. */
  buildingId: string
  footprints: HomeExteriorFootprint[]
  /** The parcel's door and the way it faces, exactly. Draw the door here, wherever the rectangles' middles are. */
  frontDoor: { pos: Vec2; facing: number }
  exterior: HomeBuilding['exterior']
}

/**
 * Which building is a home the caller may visit and is told the place of: the owner, friends the
 * owner accepted, and anyone else who may visit only when the owner is discoverable. Being let in
 * is not being told where. The only thing that ties a building to a home or a name.
 */
export interface HomeExteriorEntry {
  buildingId: string
  homeId: HomeId
  name: string
  standing: Vec2
}

/** The service's own projection of a placed home's shell. */
export function exteriorFootprints(plan: Pick<HomePlan, 'rooms' | 'entrance'>, anchor: Pick<HomeParcelAnchor, 'door' | 'facing'>, storeys: number): HomeExteriorFootprint[] {
  const placement = planPlacement(plan, anchor)
  return planShell(plan).map(box => ({
    pos: placement.toDistrict({ x: box.x + box.width / 2, z: box.z + box.depth / 2 }), angle: placement.angle,
    width: box.width, depth: box.depth, height: storeys * HOME_PHYSICAL.storeyHeight,
  }))
}

/** Pushed to members in a district when its buildings, or which of them the member may visit, may have changed. Ask `home.exteriors` again. */
export type HomeEvent = { type: 'home.exteriors'; districtId: DistrictId; sceneRevision: string }

// ── Going to a home, going in, coming out ──

export const HOME_UNAVAILABLE = ['unplaced', 'no-coverage', 'source-missing', 'source-stale', 'no-live-position', 'not-shared'] as const
/**
 * Why a home cannot be gone to.
 * 'unplaced': it stands on no parcel. 'no-coverage': the district has no parcel data.
 * 'source-missing', 'source-stale': see `HomeSiteStatus`.
 * 'no-live-position': this service cannot say where a character is standing at this moment (its
 * rooms run on other processes), so it lets nobody through a door.
 * 'not-shared': the caller may visit but is not told where the home stands, wherever their character is.
 */
export type HomeUnavailableReason = (typeof HOME_UNAVAILABLE)[number]

export type HomeApproach =
  /** The caller's character may be in the home's district now. Walk to `site.parcel.standing`, then `home.enter`. */
  | {
    kind: 'walk'; homeId: HomeId; site: HomeSite
    /** Where the character will stand inside: plan metres, the room's id and the way to face. */
    inside: { roomId: string; pos: Vec2; heading: number }
    /** What `home.enter` would answer at this moment. `reason` is the sentence when it would refuse. */
    enter: { allowed: boolean; reason: string }
  }
  /** The home is too far to walk to, or the character is on a trip. `to` is the area to book a trip to, by the Travel rules as they are. */
  | { kind: 'travel'; homeId: HomeId; to: CoarseArea; message: string }
  | { kind: 'unavailable'; homeId: HomeId; reason: HomeUnavailableReason; message: string }

/**
 * The door a character went in by. Kept in the saved world from `home.enter` until `home.leave`,
 * through a reload, a dropped connection and a restart of the service.
 * 'shown-out': the caller may no longer be inside (the home was closed to them). Only `home.leave` is left.
 */
export interface HomeStay { homeId: HomeId; buildingId: string; districtId: DistrictId; since: Iso; state: 'inside' | 'shown-out' }

export interface HomeEntered {
  home: Home
  canEdit: boolean
  /** Where the service stood the character. */
  inside: { roomId: string; pos: Vec2; heading: number }
  snapshot: RoomSnapshot
  history: ChatMessage[]
  stay: HomeStay
}

export interface HomeLeft {
  /** Where the service stood the character: beside the door it went in by, facing out. */
  exit: { districtId: DistrictId; pos: Vec2; heading: number }
  snapshot: RoomSnapshot
  history: ChatMessage[]
}

/**
 * What `home.presence` answers. `lastExit` is where the caller's last `home.leave` put them. It is
 * kept through a dropped connection and a restart of the service, and is there only while
 * `home.return` could still use it: it goes when the character travels, or enters any room but
 * the street it came out into.
 */
export interface HomePresence { stay: HomeStay | null; lastExit: HomeLeft['exit'] | null }

// ── Buying and building ───────────────────────────────────────────────────────────────────────

/** A room as proposed. `id` is the room's own for one that exists; for a new room, any other short name (`new1`), used by the doors in the same proposal. */
export interface HomeRoomDraft { id: string; kind: RoomKindId; x: number; z: number; width: number; depth: number; floor: string; wall: string }
export interface HomePlanDraft {
  rooms: HomeRoomDraft[]
  doors: { a: string; b: string; at: number }[]
  entrance: { roomId: string; side: WallSide; at: number }
}
/** Where one placed piece goes as part of a change to the rooms: into storage, or to another cell. */
export type HomeItemMove = { key: string; to: 'storage' } | { key: string; to: { x: number; z: number; turns: 0 | 1 | 2 | 3 } }

export type HomeChange =
  /** Buy furniture that is not free. It goes into storage; placing it is `home.save`, as before. */
  | { kind: 'furniture'; lines: { model: string; quantity: number }[] }
  /** Move up to a bigger type of house. */
  | { kind: 'house'; houseType: HouseTypeId }
  /**
   * Change the rooms: the whole plan as it should be, and where each piece that would be left
   * outside it goes. A piece not named stays where it is. Nothing is dropped: a plan that would
   * leave a piece outside every room is refused until that piece is named here.
   */
  | { kind: 'layout'; plan: HomePlanDraft; items: HomeItemMove[] }

export interface HomeReview {
  furniture: { model: string; quantity: number; each: number }[]
  houseType: { from: HouseTypeId; to: HouseTypeId } | null
  rooms: {
    added: HomeRoom[]
    /** Removed rooms give no coins back. */
    removed: HomeRoom[]
    resized: { id: string; from: { x: number; z: number; width: number; depth: number }; to: { x: number; z: number; width: number; depth: number } }[]
  }
  /** Every piece this change moves or stores, for the member to look over before agreeing. */
  items: { key: string; model: string; from: { x: number; z: number }; to: 'storage' | { x: number; z: number; turns: 0 | 1 | 2 | 3 } }[]
  /** The plan as it will be, with the ids its new rooms and doors will have. Null when the rooms do not change. */
  plan: HomePlan | null
}

export interface HomeQuote {
  id: HomeQuoteId
  kind: HomeChange['kind']
  lines: { label: string; coins: number }[]
  /** Game coins. Zero for a change that costs nothing, which is still agreed to with `home.commit`. */
  total: number
  balance: number
  affordable: boolean
  review: HomeReview
  /** `Home.revision` and `HomeEstate.revision` this was worked out against. Either moving on makes it stale. */
  revision: number
  estateRevision: number
  expiresAt: Iso
}

export interface HomeReceipt {
  id: string
  requestId: string
  kind: HomeChange['kind']
  /** One line saying what was bought or built. */
  summary: string
  lines: { label: string; coins: number }[]
  total: number
  balanceAfter: number
  /** The wallet history line, when coins were taken. */
  ledgerId: string | null
  at: Iso
}

/** What only the owner sees. */
export interface HomeEstate {
  /** Rises by one with every committed purchase or change to the rooms. */
  revision: number
  houseType: HouseTypeId
  /**
   * Furniture owned, by model: how many in all, and how many of those stand in the rooms. The rest
   * are in storage. A free piece is owned from the moment it is first placed.
   */
  inventory: { model: string; owned: number; placed: number }[]
  itemLimit: number
  ownedLimit: number
  balance: number
  /** Newest first. */
  receipts: HomeReceipt[]
}

export interface HomeCatalog {
  version: string
  /** Every figure in the catalogue is game coins: game policy, not a real price. */
  currency: 'game-coins'
  houseTypes: readonly HouseType[]
  roomKinds: readonly RoomKind[]
  furniture: FurnitureListing[]
  groups: { id: string; label: string }[]
  rules: typeof HOME_RULES
  physical: typeof HOME_PHYSICAL
}

export interface HomeOps {
  /** The service's own tables and prices. */
  'home.catalog': Op<Empty, { catalog: HomeCatalog }>
  /** The caller's own home with what only they see. */
  'home.estate': Op<Empty, { home: Home; estate: HomeEstate }>
  /** Work out a change to the caller's own home and what it costs. Nothing is changed or charged. */
  'home.quote': Op<{ change: HomeChange }, { quote: HomeQuote }>
  /**
   * Agree to a quote. The coins are taken once and the change is made in the same step, or
   * neither happens. `requestId` repeated with the same quote answers the same receipt and does
   * nothing again (`repeated: true`). `home` and `estate` are always the caller's own, as they are now.
   */
  'home.commit': Op<{ quoteId: HomeQuoteId; requestId: string; expectedRevision: number }, { receipt: HomeReceipt; repeated: boolean; home: Home; estate: HomeEstate }>
  /** Where the caller could place their home: the district their character is in, and the parcels the service's data vouches for there. */
  'home.sites': Op<Empty, {
    here: { districtId: DistrictId; areaLabel: string } | null
    /** Why not, when `here` is null. */
    reason: string
    /** Set when nothing can be placed in `here`: 'no-coverage' or 'no-live-position'. `parcels` is then empty. */
    unavailable: HomeUnavailableReason | null
    parcels: HomeParcelOption[]
    source: HomeParcelSource | null
    site: HomeSite | null
  }>
  /**
   * Place the caller's home on a parcel in the district their character is in, or take it off the
   * map (`place` null). `parcelId` null asks for the default: the first free parcel, in the parcel
   * data's own order, that the rooms fit. The service never places a home unasked.
   */
  'home.setSite': Op<{ place: { parcelId: string | null } | null }, { home: Home }>
  'home.approach': Op<{ homeId: HomeId | null }, { approach: HomeApproach }>
  /**
   * The buildings standing in a district, for everyone the same, and which of them the caller may
   * visit. `source` is the scene the caller draws; it must be the one the service runs.
   */
  'home.exteriors': Op<
    { districtId: DistrictId; source: HomeParcelAnchor['source'] },
    {
      source: HomeParcelAnchor['source']
      /** Names this list of buildings. It changes when the list or anything in it does. The static scene's own hashes never change with it. */
      sceneRevision: string
      buildings: HomeExteriorScenery[]
      entries: HomeExteriorEntry[]
    }
  >
  /** Go in by the front door. `homeId` null is the caller's own. The only way into a home: `room.enter` refuses a home. */
  'home.enter': Op<{ homeId: HomeId | null }, HomeEntered>
  /** Back inside the home the caller's stay is in, after a reload or a lost connection. No door check: the character never left. */
  'home.resume': Op<Empty, HomeEntered>
  /**
   * Out by the door the caller went in by, into the street room they came from, at the parcel's
   * exit. Asked again after a lost answer, with the caller already standing where it put them, it
   * answers the same again.
   */
  'home.leave': Op<Empty, HomeLeft>
  /** The caller's open stay and last exit, if any. Ask it before entering a street after a reload. */
  'home.presence': Op<Empty, HomePresence>
  /**
   * Back to `lastExit`, for a caller who is in no room (a reload or a lost connection after
   * leaving a home). Takes nothing from the request. Everything is checked again; a caller who is
   * in a room, has travelled, or has no `lastExit` is refused.
   */
  'home.return': Op<Empty, HomeLeft>
}
