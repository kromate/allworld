// Home building: the kind of house, its rooms and doors, the furniture a member owns, what a
// change costs. The tables and the plan rules are the contract's (src/shared/homes.ts); this
// module holds a home to them. Where the house stands in the street, and going in and out by its
// door, is service/homePhysical.ts.
//
// service/homes.ts owns who may come in and registers every home operation. It hands this module
// the home record, so nothing here decides access.
//
// Money. A change is priced from the home as it is (`planChange`), shown as a quote, and priced
// again from scratch when it is agreed to: an earlier quote counts for nothing but its total.
// `commitChange` takes the coins and makes the change in one step with no await between them, so
// both are in the saved world or neither is. A request repeated with the same quote is answered
// from its receipt and does nothing again.
import furnitureIndex from '../src/assets/furniture.index.json' with { type: 'json' }
import type { DistrictId, HomeId, Iso, MemberId } from '../src/shared/ids.ts'
import { iso, randomToken } from '../src/shared/ids.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { WorldError, roomKey } from '../src/shared/model.ts'
import type { CoarseArea } from '../src/shared/model.ts'
import type { HomeLayout, PlacedItem } from '../src/shared/social.ts'
import {
  FURNITURE_SHOP, HOME_CATALOG_VERSION, HOME_FURNITURE_SCALE, HOME_ITEM_LIMIT_MAX, HOME_PHYSICAL, HOME_REQUEST_ID, HOME_RULES, HOME_WALK_MARGIN, HOUSE_TYPES,
  HOUSE_TYPE_IDS, MAIN_ROOM_ID, ROOM_KINDS, ROOM_KIND_IDS, WALL_SIDES, blocksWalking, doorwayPoints, furnitureListing, furnitureListings, growthPrice,
  houseType, isFreeFurniture, planProblem, resolvePlan, roomAt, roomKind, roomPrice, upgradePrice,
} from '../src/shared/homes.ts'
import type {
  HomeCatalog, HomeChange, HomeEstate, HomeItemMove, HomeParcelAnchor, HomePlan, HomeQuote, HomeQuoteId, HomeReceipt, HomeReview, HomeRoom, HouseTypeId,
  PlanInput, WallSide,
} from '../src/shared/homes.ts'
import type { World } from './kernel.ts'
import { id, list, num, obj, oneOf, str, hexColor } from './parse.ts'
import type { Raw } from './parse.ts'
import { occupantsOfRoom, roomOf } from './rooms.ts'
import { chargeHomePurchase } from './travel.ts'
import { careerPoints } from './work.ts'

// ── What is kept ──────────────────────────────────────────────────────────────────────────────

/**
 * Where a home stands: the parcel as it was when the home was placed on it, never changed after,
 * and the building it is while it stands there. `buildingId` is random, so it says nothing of the owner.
 */
export interface SiteRecord { districtId: DistrictId; areaLabel: string; area: CoarseArea; buildingId: string; placedAt: Iso; parcel: HomeParcelAnchor }

/** What building added to a home. A home saved before it has none: see `estateOf`. */
export interface EstateRecord {
  houseType: HouseTypeId
  /** Rooms beyond the main room. The main room's size and colours stay in the home's `layout`, where they always were. */
  rooms: HomeRoom[]
  doors: { id: string; a: string; b: string; at: number }[]
  entrance: { roomId: string; side: WallSide; at: number }
  /** Ids are never reused in one home. */
  nextRoom: number
  nextDoor: number
  planVersion: number
  /** Furniture owned by model: the pieces standing in the rooms and the ones in storage. */
  owned: Record<string, number>
  revision: number
  site: SiteRecord | null
}

/** The part of a home record this module reads and changes. */
export interface BuiltHome { id: HomeId; owner: MemberId; layout: HomeLayout; revision: number; updatedAt: Iso; estate?: EstateRecord }

interface ReceiptRecord extends HomeReceipt { quoteId: string }
/** Kept in the homes slice, beside the homes. Absent in a world saved before building. */
export interface BuildingState { receipts?: Record<string, ReceiptRecord[]> }

/** How many of each model. A map, not an object: a model may be named `constructor`, and an object would answer for it. */
const countModels = (items: readonly PlacedItem[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const item of items) out.set(item.model, (out.get(item.model) ?? 0) + 1)
  return out
}
/** How many of a model the home owns. Only what was put there counts. */
const ownedOf = (estate: EstateRecord, model: string): number => Object.hasOwn(estate.owned, model) ? estate.owned[model]! : 0

/**
 * The estate of a home as it stands. A home saved before building is read as a studio with its
 * door where it always was, owning exactly the pieces standing in it. Reading writes nothing.
 */
export function estateOf(home: BuiltHome): EstateRecord {
  return home.estate ?? {
    houseType: 'studio', rooms: [], doors: [], entrance: { roomId: MAIN_ROOM_ID, side: 'south', at: home.layout.width / 2 },
    nextRoom: 2, nextDoor: 1, planVersion: 1, owned: Object.fromEntries(countModels(home.layout.items)), revision: 1, site: null,
  }
}

/** The same, kept on the record. Called before the owner changes anything, so what was owned is fixed before it moves. */
export function ownEstate(world: World, home: BuiltHome): EstateRecord {
  if (!home.estate) { home.estate = estateOf(home); world.touch() }
  return home.estate
}

const mainRoom = (home: BuiltHome): HomeRoom => ({ id: MAIN_ROOM_ID, kind: 'main', x: 0, z: 0, width: home.layout.width, depth: home.layout.depth, floor: home.layout.floor, wall: home.layout.wall })
const planInput = (home: BuiltHome, estate: EstateRecord): PlanInput => ({ rooms: [mainRoom(home), ...estate.rooms], doors: estate.doors, entrance: estate.entrance })
export const planOf = (home: BuiltHome, estate: EstateRecord = estateOf(home)): HomePlan => resolvePlan(planInput(home, estate), estate.planVersion)

interface QuoteRecord { quote: HomeQuote; memberId: MemberId; change: HomeChange; expiresAt: number }
/** Asked of every proposed plan before it is priced: throws when the house could not stand as planned where it is. */
type LayoutGuard = (home: BuiltHome, estate: EstateRecord, plan: HomePlan) => void
interface Runtime { quotes: Map<string, QuoteRecord>; layoutGuard: LayoutGuard | null }
const runtimes = new WeakMap<World, Runtime>()
const runtime = (world: World): Runtime => {
  let found = runtimes.get(world)
  if (!found) { found = { quotes: new Map(), layoutGuard: null }; runtimes.set(world, found) }
  return found
}

/** service/homePhysical.ts holds a placed home to its parcel here: a plan is checked in the quote and again in the commit, before any coin moves. */
export function setLayoutGuard(world: World, guard: LayoutGuard): void { runtime(world).layoutGuard = guard }

// ── Furniture in the rooms ────────────────────────────────────────────────────────────────────

interface ModelBox { name: string; min: number[]; max: number[] }
let boxes: Map<string, ModelBox> | null = null
/** Floor space a piece takes, in metres, from the furniture pack's own index: the figure the App draws it at. */
function footprint(model: string, turns: number): { width: number; depth: number } {
  boxes ??= new Map((furnitureIndex as ModelBox[]).map(entry => [entry.name, entry]))
  const box = boxes.get(model)
  // A model the pack does not know is given a metre, as in the App.
  const width = box ? (box.max[0]! - box.min[0]!) * HOME_FURNITURE_SCALE : 1, depth = box ? (box.max[2]! - box.min[2]!) * HOME_FURNITURE_SCALE : 1
  return turns % 2 === 0 ? { width, depth } : { width: depth, depth: width }
}

const cell = (item: Pick<PlacedItem, 'x' | 'z'>): Vec2 => ({ x: item.x * HOME_RULES.grid, z: item.z * HOME_RULES.grid })
const pieceName = (model: string): string => model.replace(/([A-Z0-9])/g, ' $1').trim().toLowerCase()
const sameSpot = (a: PlacedItem | undefined, b: PlacedItem): boolean => Boolean(a && a.model === b.model && a.x === b.x && a.z === b.z && a.turns === b.turns)

/** Is this spot of the plan taken up by a piece that is in the way, with a character's margin round it? */
export function furnitureInTheWay(home: BuiltHome, pos: Vec2): boolean {
  for (const item of home.layout.items) {
    if (!blocksWalking(item.model)) continue
    const size = footprint(item.model, item.turns), centre = cell(item)
    if (Math.abs(pos.x - centre.x) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(pos.z - centre.z) < size.depth / 2 + HOME_WALK_MARGIN) return true
  }
  return false
}

/** Changed solid pieces cannot be saved over an avatar already occupying this home. */
function furnitureOccupantProblem(world: World, home: BuiltHome, items: readonly PlacedItem[]): string | null {
  const before = new Map(home.layout.items.map(item => [item.key, item]))
  const people = occupantsOfRoom(world, roomKey({ kind: 'home', homeId: home.id }))
    .map(memberId => roomOf(world, memberId)?.pos).filter((pos): pos is Vec2 => pos !== undefined)
  if (!people.length) return null
  for (const item of items) {
    if (!blocksWalking(item.model) || sameSpot(before.get(item.key), item)) continue
    const size = footprint(item.model, item.turns), centre = cell(item)
    if (people.some(pos => Math.abs(pos.x - centre.x) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(pos.z - centre.z) < size.depth / 2 + HOME_WALK_MARGIN)) {
      return `The ${pieceName(item.model)} would overlap a player in this home. Move it clear before saving.`
    }
  }
  return null
}

/**
 * Why these pieces cannot stand in this plan, or null. Every piece must be in a room. A piece
 * that is in the way must not stand where a character goes through a door, but only pieces that
 * are new or moved (`fresh`) and openings that are new (`openings`) are held to that, so a home is
 * never refused for the way it already was.
 */
function itemsProblem(plan: HomePlan, items: readonly PlacedItem[], fresh: (item: PlacedItem) => boolean, openings: ReadonlySet<string>): string | null {
  const outside = items.filter(item => !roomAt(plan.rooms, cell(item)))
  if (outside.length) return `${outside.length === 1 ? 'A piece' : `${outside.length} pieces`} would be outside every room: ${outside.slice(0, 4).map(item => pieceName(item.model)).join(', ')}.`
  const points = doorwayPoints(plan)
  for (const item of items) {
    if (!blocksWalking(item.model)) continue
    const moved = fresh(item)
    const size = footprint(item.model, item.turns), centre = cell(item)
    for (const point of points) {
      if (!moved && !openings.has(point.opening)) continue
      if (Math.abs(point.pos.x - centre.x) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(point.pos.z - centre.z) < size.depth / 2 + HOME_WALK_MARGIN) {
        return `The ${pieceName(item.model)} would block ${point.opening === 'entrance' ? 'the front door' : 'a doorway'}. Put it clear of the door.`
      }
    }
  }
  return null
}

/**
 * Hold a furniture save to the building: the main room keeps its size, the house holds so many
 * pieces, every placed piece is free or owned, and the pieces stand in rooms and clear of doors.
 * Throws with the reason, having changed nothing. Call it before the layout is replaced.
 */
export function checkFurnitureSave(world: World, home: BuiltHome, next: HomeLayout): void {
  if (next.width !== home.layout.width || next.depth !== home.layout.depth) throw new WorldError('invalid', 'A room is made bigger or smaller by building, not by saving the furniture.')
  const estate = ownEstate(world, home), type = houseType(estate.houseType)
  if (next.items.length > type.itemLimit) throw new WorldError('invalid', `A ${type.label.toLowerCase()} holds up to ${type.itemLimit} pieces. Put some in storage first.`)
  const placed = countModels(next.items)
  for (const [model, count] of placed) {
    const short = count - ownedOf(estate, model)
    if (short > 0 && !isFreeFurniture(model)) throw new WorldError('conflict', `You need ${short} more ${pieceName(model)} than you own. Buy it first, then place it.`)
  }
  const before = new Map(home.layout.items.map(item => [item.key, item]))
  const problem = itemsProblem(planOf(home, estate), next.items, item => !sameSpot(before.get(item.key), item), new Set())
  if (problem) throw new WorldError('invalid', problem)
  const occupied = furnitureOccupantProblem(world, home, next.items)
  if (occupied) throw new WorldError('conflict', occupied)
  // Nothing is refused past here. A free piece is the home's from the moment it is placed, so it
  // stays owned if it ever stops being free.
  for (const [model, count] of placed) if (count > ownedOf(estate, model)) estate.owned[model] = count
  // The main room's colours are part of the plan a window draws walls from.
  if (next.floor !== home.layout.floor || next.wall !== home.layout.wall) estate.planVersion++
}

// ── Working out a change ──────────────────────────────────────────────────────────────────────

interface Planned {
  lines: { label: string; coins: number }[]
  total: number
  review: HomeReview
  summary: string
  /** Visitors inside see the difference: the rooms or the type of house changed. */
  shown: boolean
  /** Make the change. Called once everything is checked and the coins are taken. It only assigns: it cannot fail. */
  apply(): void
}

const noReview = (): HomeReview => ({ furniture: [], houseType: null, rooms: { added: [], removed: [], resized: [] }, items: [], plan: null })
const invalid = (message: string): never => { throw new WorldError('invalid', message) }
const sum = (lines: { coins: number }[]): number => lines.reduce((total, line) => total + line.coins, 0)

function planFurniture(estate: EstateRecord, change: Extract<HomeChange, { kind: 'furniture' }>): Planned {
  if (change.lines.length === 0) invalid('Choose at least one piece.')
  const seen = new Set<string>()
  const bought = change.lines.map(line => {
    if (seen.has(line.model)) invalid('A piece is listed twice. Put the number in one line.')
    seen.add(line.model)
    const listing = furnitureListing(line.model)
    if (!listing) throw new WorldError('not_found', `The shop does not sell "${line.model}".`)
    if (listing.free) throw new WorldError('conflict', `The ${pieceName(line.model)} is free. Place it in a room without buying it.`)
    return { model: line.model, quantity: line.quantity, each: listing.price }
  })
  const owned = Object.entries(estate.owned).reduce((total, [model, count]) => total + (isFreeFurniture(model) ? 0 : count), 0) + bought.reduce((total, line) => total + line.quantity, 0)
  if (owned > HOME_RULES.ownedLimit) throw new WorldError('conflict', `A home keeps up to ${HOME_RULES.ownedLimit} bought pieces, placed and stored. That would make ${owned}.`)
  const lines = bought.map(line => ({ label: `${line.quantity} × ${pieceName(line.model)}`, coins: line.each * line.quantity }))
  return {
    lines, total: sum(lines), review: { ...noReview(), furniture: bought }, shown: false,
    summary: `Furniture: ${bought.map(line => `${line.quantity} × ${pieceName(line.model)}`).join(', ')}`,
    apply() { for (const line of bought) estate.owned[line.model] = ownedOf(estate, line.model) + line.quantity },
  }
}

function planHouse(estate: EstateRecord, change: Extract<HomeChange, { kind: 'house' }>): Planned {
  const from = houseType(estate.houseType), to = houseType(change.houseType)
  const price = upgradePrice(from.id, to.id)
  if (price === null) throw new WorldError('conflict', to.id === from.id ? `Your home is already a ${from.label.toLowerCase()}.` : 'A home only moves up to a bigger type of house.')
  return {
    lines: [{ label: `${from.label} to ${to.label}`, coins: price }], total: price, shown: true,
    review: { ...noReview(), houseType: { from: from.id, to: to.id } }, summary: `House: moved up to a ${to.label.toLowerCase()}`,
    apply() { estate.houseType = to.id },
  }
}

const sameBox = (a: HomeRoom, b: HomeRoom): boolean => a.x === b.x && a.z === b.z && a.width === b.width && a.depth === b.depth
const boxOf = (room: HomeRoom): { x: number; z: number; width: number; depth: number } => ({ x: room.x, z: room.z, width: room.width, depth: room.depth })

function planLayout(world: World, home: BuiltHome, estate: EstateRecord, change: Extract<HomeChange, { kind: 'layout' }>): Planned {
  const type = houseType(estate.houseType)
  const current = planInput(home, estate)
  const known = new Map(current.rooms.map(room => [room.id, room]))
  let nextRoom = estate.nextRoom, nextDoor = estate.nextDoor

  // Rooms: one that exists keeps its id; a new one is given the next id, in the order proposed.
  const finalId = new Map<string, string>()
  const rooms: HomeRoom[] = change.plan.rooms.map(draft => {
    if (finalId.has(draft.id)) invalid('Two rooms in the plan have the same name.')
    const existing = known.get(draft.id)
    if (existing && existing.kind !== draft.kind) invalid('A room keeps the kind it was built as.')
    if (!existing && /^r\d+$/.test(draft.id)) invalid(`There is no room ${draft.id} in this home. Give a new room another name.`)
    const roomId = existing ? existing.id : `r${nextRoom++}`
    finalId.set(draft.id, roomId)
    return { id: roomId, kind: draft.kind, x: draft.x, z: draft.z, width: draft.width, depth: draft.depth, floor: draft.floor, wall: draft.wall }
  })
  const named = (name: string): string => finalId.get(name) ?? invalid('A door names a room that is not in the plan.')
  const doors = change.plan.doors.map(door => {
    const a = named(door.a), b = named(door.b)
    const kept = current.doors.find(old => old.at === door.at && ((old.a === a && old.b === b) || (old.a === b && old.b === a)))
    return { id: kept?.id ?? `d${nextDoor++}`, a, b, at: door.at }
  })
  const entrance = { roomId: named(change.plan.entrance.roomId), side: change.plan.entrance.side, at: change.plan.entrance.at }
  rooms.sort((a, b) => Number(b.id === MAIN_ROOM_ID) - Number(a.id === MAIN_ROOM_ID))
  const next: PlanInput = { rooms, doors, entrance }
  const problem = planProblem(next, type)
  if (problem) invalid(problem)

  const finalRooms = new Set(rooms.map(room => room.id))
  const added = rooms.filter(room => !known.has(room.id))
  const removed = current.rooms.filter(room => !finalRooms.has(room.id))
  const resized = rooms.flatMap(room => { const was = known.get(room.id); return was && !sameBox(was, room) ? [{ id: room.id, was, now: room }] : [] })
  const recoloured = rooms.some(room => { const was = known.get(room.id); return was !== undefined && (was.floor !== room.floor || was.wall !== room.wall) })
  const keptDoors = new Set(current.doors.map(door => door.id))
  const openings = new Set<string>(doors.filter(door => !keptDoors.has(door.id)).map(door => door.id))
  const entranceMoved = entrance.roomId !== current.entrance.roomId || entrance.side !== current.entrance.side || entrance.at !== current.entrance.at
  if (entranceMoved) openings.add('entrance')
  const reshaped = added.length > 0 || removed.length > 0 || resized.length > 0 || recoloured || openings.size > 0 || doors.length !== current.doors.length
  if (!reshaped && change.items.length === 0) invalid('Nothing would change.')

  const plan = resolvePlan(next, estate.planVersion + (reshaped ? 1 : 0))
  // A placed home stays inside its parcel, wherever in the plan its door is.
  runtime(world).layoutGuard?.(home, estate, plan)

  // Furniture: a piece stays where it is unless this change names it. Nothing is dropped.
  const moves = new Map<string, HomeItemMove['to']>()
  for (const move of change.items) {
    if (moves.has(move.key)) invalid('A piece is named twice in this change.')
    moves.set(move.key, move.to)
  }
  const inRooms = new Set(home.layout.items.map(item => item.key))
  for (const key of moves.keys()) if (!inRooms.has(key)) invalid('A piece named in this change is not in the rooms.')
  const items: PlacedItem[] = []
  const reviewed: HomeReview['items'] = []
  for (const item of home.layout.items) {
    const to = moves.get(item.key)
    if (to === undefined) { items.push(item); continue }
    reviewed.push({ key: item.key, model: item.model, from: { x: item.x, z: item.z }, to })
    if (to !== 'storage') items.push({ ...item, x: to.x, z: to.z, turns: to.turns })
  }
  const left = items.filter(item => !roomAt(plan.rooms, cell(item)))
  if (left.length) {
    throw new WorldError('conflict', `${left.length === 1 ? 'A piece' : `${left.length} pieces`} would be left outside the rooms: ${left.slice(0, 4).map(item => pieceName(item.model)).join(', ')}${left.length > 4 ? ' and more' : ''}. Say where each one goes, or send it to storage, as part of this change.`)
  }
  const blocked = itemsProblem(plan, items, item => moves.has(item.key), openings)
  if (blocked) invalid(blocked)

  const occupied = furnitureOccupantProblem(world, home, items)
  if (occupied) throw new WorldError('conflict', occupied)

  // Nobody is left standing where there is no longer a floor.
  for (const memberId of occupantsOfRoom(world, roomKey({ kind: 'home', homeId: home.id }))) {
    const at = roomOf(world, memberId)?.pos
    if (at && !roomAt(plan.rooms, at)) throw new WorldError('conflict', 'Someone is standing where this change leaves no room. Wait until they have stepped out of it.')
  }

  const lines = [
    ...added.map(room => ({ label: `${roomKind(room.kind).label}, ${room.width} by ${room.depth} m`, coins: roomPrice(room.kind, room.width, room.depth) })),
    ...resized.flatMap(({ was, now }) => {
      const coins = growthPrice(was.width * was.depth, now.width * now.depth)
      return coins > 0 ? [{ label: `${roomKind(now.kind).label} made bigger, to ${now.width} by ${now.depth} m`, coins }] : []
    }),
  ]
  const said = [
    added.length ? `${added.map(room => roomKind(room.kind).label.toLowerCase()).join(', ')} added` : '',
    removed.length ? `${removed.map(room => roomKind(room.kind).label.toLowerCase()).join(', ')} removed` : '',
    resized.length ? `${resized.length} resized` : '',
  ].filter(Boolean).join('; ')
  return {
    lines, total: sum(lines), shown: true, summary: `Rooms: ${said || 'doors, colours or furniture changed'}`,
    review: {
      ...noReview(), items: reviewed, plan: reshaped ? plan : null,
      rooms: { added, removed, resized: resized.map(({ id: roomId, was, now }) => ({ id: roomId, from: boxOf(was), to: boxOf(now) })) },
    },
    apply() {
      const main = rooms.find(room => room.id === MAIN_ROOM_ID)!
      home.layout = { width: main.width, depth: main.depth, floor: main.floor, wall: main.wall, items }
      estate.rooms = rooms.filter(room => room.id !== MAIN_ROOM_ID)
      estate.doors = doors
      estate.entrance = entrance
      estate.nextRoom = nextRoom
      estate.nextDoor = nextDoor
      if (reshaped) estate.planVersion++
      home.revision++
    },
  }
}

/** Work out a change against the home as it is now. Throws when it cannot be made. Changes nothing. */
function planChange(world: World, home: BuiltHome, estate: EstateRecord, change: HomeChange): Planned {
  if (change.kind === 'furniture') return planFurniture(estate, change)
  if (change.kind === 'house') return planHouse(estate, change)
  return planLayout(world, home, estate, change)
}

// ── Reading requests ──────────────────────────────────────────────────────────────────────────

const CELLS = HOME_RULES.planSpan / HOME_RULES.grid
const metres = (raw: Raw, key: string): number => num(raw, key, { integer: true, min: -HOME_RULES.planSpan, max: HOME_RULES.planSpan })
const along = (raw: Raw, key: string): number => num(raw, key, { min: -HOME_RULES.planSpan, max: HOME_RULES.planSpan })
const roomName = (raw: Raw, key: string): string => {
  const value = str(raw, key, { min: 1, max: 24 })
  return /^[A-Za-z0-9-]+$/.test(value) ? value : invalid(`${key} is not a valid room name`)
}

export function parseChange(value: unknown): HomeChange {
  const raw = obj(value, 'change')
  const kind = oneOf(raw, 'kind', ['furniture', 'house', 'layout'] as const)
  if (kind === 'furniture') {
    return { kind, lines: list(raw, 'lines', entry => {
      const line = obj(entry, 'line')
      return { model: str(line, 'model', { min: 1, max: 48 }), quantity: num(line, 'quantity', { integer: true, min: 1, max: HOME_RULES.purchaseQuantity }) }
    }, { max: HOME_RULES.purchaseLines }) }
  }
  if (kind === 'house') return { kind, houseType: oneOf(raw, 'houseType', HOUSE_TYPE_IDS) }
  const plan = obj(raw.plan, 'plan'), front = obj(plan.entrance, 'plan.entrance')
  return {
    kind,
    plan: {
      rooms: list(plan, 'rooms', entry => {
        const room = obj(entry, 'room')
        return {
          id: roomName(room, 'id'), kind: oneOf(room, 'kind', ROOM_KIND_IDS), x: metres(room, 'x'), z: metres(room, 'z'),
          width: num(room, 'width', { integer: true, min: 1, max: HOME_RULES.planSpan }), depth: num(room, 'depth', { integer: true, min: 1, max: HOME_RULES.planSpan }),
          floor: hexColor(room.floor, 'room.floor'), wall: hexColor(room.wall, 'room.wall'),
        }
      }, { max: 16 }),
      doors: list(plan, 'doors', entry => { const door = obj(entry, 'door'); return { a: roomName(door, 'a'), b: roomName(door, 'b'), at: along(door, 'at') } }, { max: 32 }),
      entrance: { roomId: roomName(front, 'roomId'), side: oneOf(front, 'side', WALL_SIDES), at: along(front, 'at') },
    },
    items: list(raw, 'items', (entry): HomeItemMove => {
      const move = obj(entry, 'item'), key = str(move, 'key', { min: 1, max: 40 })
      if (move.to === 'storage') return { key, to: 'storage' }
      const to = obj(move.to, 'item.to')
      return { key, to: { x: num(to, 'x', { min: -CELLS, max: CELLS }), z: num(to, 'z', { min: -CELLS, max: CELLS }), turns: num(to, 'turns', { integer: true, min: 0, max: 3 }) as 0 | 1 | 2 | 3 } }
    }, { max: HOME_ITEM_LIMIT_MAX }),
  }
}

export function parseCommit(value: unknown): { quoteId: HomeQuoteId; requestId: string; expectedRevision: number } {
  const raw = obj(value)
  const requestId = str(raw, 'requestId', { min: 8, max: 64 })
  if (!HOME_REQUEST_ID.test(requestId)) invalid('requestId is not valid')
  return { quoteId: id<HomeQuoteId>(raw, 'quoteId', 'hq'), requestId, expectedRevision: num(raw, 'expectedRevision', { integer: true, min: 0 }) }
}

// ── What the owner sees ───────────────────────────────────────────────────────────────────────

const receiptView = ({ quoteId: _quoteId, ...receipt }: ReceiptRecord): HomeReceipt => receipt

export function estateView(world: World, state: BuildingState, home: BuiltHome): HomeEstate {
  const estate = estateOf(home), placed = countModels(home.layout.items)
  return {
    revision: estate.revision, houseType: estate.houseType,
    inventory: Object.keys(estate.owned).sort().map(model => ({ model, owned: estate.owned[model]!, placed: placed.get(model) ?? 0 })),
    itemLimit: houseType(estate.houseType).itemLimit, ownedLimit: HOME_RULES.ownedLimit, balance: careerPoints(world, home.owner),
    receipts: (state.receipts?.[home.owner] ?? []).slice(0, 10).map(receiptView),
  }
}

export const catalog = (): HomeCatalog => ({
  version: HOME_CATALOG_VERSION, currency: 'game-coins', houseTypes: HOUSE_TYPES, roomKinds: ROOM_KINDS, furniture: furnitureListings(),
  groups: FURNITURE_SHOP.map(group => ({ id: group.id, label: group.label })), rules: HOME_RULES, physical: HOME_PHYSICAL,
})

// ── Quote and commit ──────────────────────────────────────────────────────────────────────────

const QUOTES_HELD = 8

/** Price a change to the member's own home. Nothing is changed, charged or written. */
export function quoteChange(world: World, home: BuiltHome, change: HomeChange, now: number): HomeQuote {
  const estate = estateOf(home)
  const planned = planChange(world, home, estate, change)
  const balance = careerPoints(world, home.owner)
  const quote: HomeQuote = {
    id: `hq_${randomToken(12)}` as HomeQuoteId, kind: change.kind, lines: planned.lines, total: planned.total, balance, affordable: balance >= planned.total,
    review: planned.review, revision: home.revision, estateRevision: estate.revision, expiresAt: iso(now + HOME_RULES.quoteMinutes * 60_000),
  }
  const { quotes } = runtime(world)
  // Prices that have run out go, and a member holds only their latest few.
  for (const [quoteId, entry] of quotes) if (entry.expiresAt <= now) quotes.delete(quoteId)
  const mine = [...quotes.values()].filter(entry => entry.memberId === home.owner)
  for (const old of mine.slice(0, Math.max(0, mine.length - QUOTES_HELD + 1))) quotes.delete(old.quote.id)
  quotes.set(quote.id, { quote, memberId: home.owner, change, expiresAt: now + HOME_RULES.quoteMinutes * 60_000 })
  return quote
}

/**
 * Take the coins. Too few throws with nothing taken. Once they are taken this returns, whatever
 * else goes wrong (telling the member's App, say): from that point the change must be made too.
 */
function charge(world: World, memberId: MemberId, coins: number, text: string): { ledgerId: string | null; balance: number } {
  const before = careerPoints(world, memberId)
  try { return chargeHomePurchase(world, memberId, coins, text) } catch (error) {
    if (careerPoints(world, memberId) === before) throw error
    console.error('[homes] the coins were taken but the wallet could not finish reporting it; the purchase goes ahead', error)
    return { ledgerId: null, balance: careerPoints(world, memberId) }
  }
}

/**
 * Agree to a quote for the member's own home. Returns the receipt and whether this was a repeat
 * of a request already answered. On a repeat nothing is charged or changed.
 */
export function commitChange(world: World, state: BuildingState, home: BuiltHome, input: { quoteId: HomeQuoteId; requestId: string; expectedRevision: number }, now: number): { receipt: HomeReceipt; repeated: boolean; shown: boolean } {
  const memberId = home.owner
  const receipts = ((state.receipts ??= {})[memberId] ??= [])
  const done = receipts.find(receipt => receipt.requestId === input.requestId)
  if (done) {
    if (done.quoteId !== input.quoteId) throw new WorldError('conflict', 'That request id was already used for something else. Use a new one.')
    // The first answer may not have arrived, and what it reported may still be on its way to the
    // disk. Marking a change here makes this answer wait for a save that holds it (kernel: durable acks).
    world.touch()
    return { receipt: receiptView(done), repeated: true, shown: false }
  }
  if (receipts.some(receipt => receipt.quoteId === input.quoteId)) throw new WorldError('conflict', 'That price was already agreed to. Ask for a new price to buy again.')
  world.limit(`home-commit:${memberId}`, 20, 60_000)
  const { quotes } = runtime(world)
  const held = quotes.get(input.quoteId)
  // A quote is its member's alone; another member's id is as good as none.
  if (!held || held.memberId !== memberId) throw new WorldError('expired', 'That price is no longer held. Ask again.')
  if (held.expiresAt <= now) { quotes.delete(input.quoteId); throw new WorldError('expired', 'That price was held for ten minutes and has run out. Ask again.') }
  const estate = ownEstate(world, home)
  if (input.expectedRevision !== home.revision || held.quote.revision !== home.revision || held.quote.estateRevision !== estate.revision) {
    throw new WorldError('conflict', 'Your home changed since this price was worked out. Ask again.')
  }
  // Priced again from the home as it is now: the quote's own figures are not trusted.
  const planned = planChange(world, home, estate, held.change)
  if (planned.total !== held.quote.total) throw new WorldError('conflict', 'The price has changed. Ask again.')

  // Everything is checked. The coins are taken whole or not at all (too few throws here, with
  // nothing changed); the change, the receipt and the record of this request follow in the same step.
  const paid = planned.total > 0 ? charge(world, memberId, planned.total, planned.summary) : null
  planned.apply()
  estate.revision++
  home.updatedAt = iso(now)
  const receipt: ReceiptRecord = {
    id: `hr_${randomToken(12)}`, requestId: input.requestId, quoteId: input.quoteId, kind: held.change.kind, summary: planned.summary.slice(0, 160),
    lines: planned.lines, total: planned.total, balanceAfter: paid ? paid.balance : careerPoints(world, memberId), ledgerId: paid ? paid.ledgerId : null, at: iso(now),
  }
  receipts.unshift(receipt)
  if (receipts.length > HOME_RULES.receiptsKept) receipts.length = HOME_RULES.receiptsKept
  quotes.delete(input.quoteId)
  world.touch()
  return { receipt: receiptView(receipt), repeated: false, shown: planned.shown }
}
