// Virtual homes: the house each member furnishes. This module owns who may come in and registers
// every home operation. The building itself — the type of house, its rooms, the furniture owned,
// what a change costs — is service/homeBuilding.ts. Where the house stands in the street, and
// going in and out by its door, is service/homePhysical.ts. This module decides who may come in
// and who is told where a home stands, and passes those answers to both. The district label is
// for flavour only: moving it never touches the owner's current area or nearby matching.
import type { DistrictId, HomeId, Iso, MemberId } from '../src/shared/ids.ts'
import { iso } from '../src/shared/ids.ts'
import { parseDistrictId } from '../src/shared/geo.ts'
import { WorldError } from '../src/shared/model.ts'
import type { RoomRef } from '../src/shared/model.ts'
import { HOME_SIZE } from '../src/shared/social.ts'
import type { Home, HomeLayout, PlacedItem, VisitPolicy } from '../src/shared/social.ts'
import { HOME_ITEM_LIMIT_MAX, HOME_RULES } from '../src/shared/homes.ts'
import type { HomeApproach, HomeEntered, HomeParcelSource } from '../src/shared/homes.ts'
import type { World } from './kernel.ts'
import { catalog, checkFurnitureSave, commitChange, estateOf, estateView, parseChange, parseCommit, quoteChange, setLayoutGuard } from './homeBuilding.ts'
import type { EstateRecord } from './homeBuilding.ts'
import {
  announceEverywhere, announceExteriors, approachFor, buildingOf, checkPlanOnParcel, departed, enterHome, exteriorsFor, homeFootAllowed, leaveHome, presenceFor, resumeHome,
  returnHome, roomEntered, setSite, showOut, sitesFor, stoodAt, streetGate, watchExterior,
} from './homePhysical.ts'
import type { PhysicalState } from './homePhysical.ts'
import { allMemberIds, areFriends, exists, friendsOf, isBlockedEitherWay, onBlock, onUnfriend, publicMember, record, tryPublicMember } from './members.ts'
import { RELATION_OPS, addEnterGate, addFootRule, evict, occupantsOfRoom, onRoomEnter, onStood, roomOf, setRoomGuard } from './rooms.ts'
import { emit, settle } from './notify.ts'
import { roomKey } from '../src/shared/model.ts'
import { empty, hexColor, list, num, obj, oneOf, optStr, str } from './parse.ts'

interface HomeRecord {
  id: HomeId; owner: MemberId; name: string; districtLabel: string; policy: VisitPolicy; layout: HomeLayout; revision: number; updatedAt: Iso
  /** Absent on a home saved before building. It is then read as a studio that owns the pieces standing in it. */
  estate?: EstateRecord
}
interface HomeState extends PhysicalState { homes: Record<string, HomeRecord> }

const state = (world: World): HomeState => world.slice<HomeState>('homes', () => ({ homes: {} }))
const visitKey = (homeId: HomeId, visitor: MemberId): string => `home-visited:${homeId}:${visitor}`

const STARTER_LAYOUT: HomeLayout = {
  width: 10, depth: 10, floor: '#e9d2b0', wall: '#f4efe6',
  items: [
    { key: 'starter-sofa', model: 'loungeSofa', x: 4, z: 2, turns: 0, productId: null, variantId: null, tints: {} },
    { key: 'starter-rug', model: 'rugRectangle', x: 4, z: 5, turns: 0, productId: null, variantId: null, tints: {} },
    { key: 'starter-table', model: 'tableCoffee', x: 5, z: 6, turns: 0, productId: null, variantId: null, tints: {} },
    { key: 'starter-plant', model: 'pottedPlant', x: 1, z: 1, turns: 0, productId: null, variantId: null, tints: {} },
    { key: 'starter-lamp', model: 'lampRoundFloor', x: 8, z: 1, turns: 0, productId: null, variantId: null, tints: {} },
  ],
}

function ensureHome(world: World, owner: MemberId): HomeRecord {
  const homeId = record(world, owner).profile.homeId
  const homes = state(world).homes
  homes[homeId] ??= {
    id: homeId, owner, name: `${record(world, owner).profile.displayName}’s place`, districtLabel: 'Not placed yet', policy: 'friends',
    layout: structuredClone(STARTER_LAYOUT), revision: 1, updatedAt: iso(world.now()),
  }
  return homes[homeId]
}

function mayVisit(world: World, viewer: MemberId, home: HomeRecord): boolean {
  if (viewer === home.owner) return true
  if (isBlockedEitherWay(world, viewer, home.owner)) return false
  return home.policy === 'public' || (home.policy === 'friends' && areFriends(world, viewer, home.owner))
}

/**
 * Who is told where a home stands. The place was chosen from where the owner's character was, so
 * it follows the rule for a member's area and no wider one: the owner, friends they accepted, and
 * anyone once the owner chose to be discoverable. Being allowed to visit does not tell a member
 * where the home is, however near their character stands: without this they have no door to go to.
 */
const maySeeSite = (world: World, viewer: MemberId, home: HomeRecord): boolean =>
  viewer === home.owner || areFriends(world, viewer, home.owner) || record(world, home.owner).profile.preferences.discoverable

function view(world: World, viewer: MemberId, home: HomeRecord): Home {
  return {
    id: home.id, owner: publicMember(world, viewer, home.owner), name: home.name, districtLabel: home.districtLabel,
    policy: home.policy, layout: home.layout, revision: home.revision, updatedAt: home.updatedAt,
    building: buildingOf(world, home, maySeeSite(world, viewer, home)),
  }
}

function findHome(world: World, homeId: HomeId): HomeRecord {
  const direct = state(world).homes[homeId]
  if (direct) return direct
  // A member who has never opened their home still has one; create it on first visit.
  const owner = allMemberIds(world).find(memberId => record(world, memberId).profile.homeId === homeId)
  if (!owner) throw new WorldError('not_found', 'That home was not found.')
  return ensureHome(world, owner)
}

/**
 * How `viewer` would go to a home (`null`: their own): the visiting rule, then who is told where it
 * stands, then the physical approach. The one place both are asked, so `home.approach` and the social
 * module's invitations give the same answer. It spends nothing from anyone's request budget: the
 * caller is whatever operation, or view, already holds the viewer's. Throws what `home.get` throws.
 */
export function approachTo(world: World, viewer: MemberId, homeId: HomeId | null): HomeApproach {
  const home = homeId ? findHome(world, homeId) : ensureHome(world, viewer)
  if (!mayVisit(world, viewer, home)) throw new WorldError('forbidden', 'This home is private.')
  return approachFor(world, state(world), home, viewer, maySeeSite(world, viewer, home))
}

/** Furniture cells reach as far as rooms can be built. Whether a cell is in a room is checked against the home's plan. */
const CELLS = HOME_RULES.planSpan / HOME_RULES.grid

function parseLayout(value: unknown): HomeLayout {
  const raw = obj(value, 'layout')
  const width = num(raw, 'width', { integer: true, min: HOME_SIZE.minWidth, max: HOME_SIZE.maxWidth })
  const depth = num(raw, 'depth', { integer: true, min: HOME_SIZE.minDepth, max: HOME_SIZE.maxDepth })
  const keys = new Set<string>()
  const items = list(raw, 'items', (entry): PlacedItem => {
    const item = obj(entry, 'item')
    const key = str(item, 'key', { min: 1, max: 40 })
    if (keys.has(key)) throw new WorldError('invalid', 'Two items share the same key.')
    keys.add(key)
    const model = str(item, 'model', { min: 1, max: 48 })
    if (!/^[A-Za-z0-9]+$/.test(model)) throw new WorldError('invalid', 'Unknown furniture model.')
    const tintsRaw = obj(item.tints ?? {}, 'item.tints')
    const tints: Record<string, string> = {}
    for (const [material, colour] of Object.entries(tintsRaw).slice(0, 8)) {
      if (!/^[A-Za-z0-9_]{1,24}$/.test(material)) throw new WorldError('invalid', 'Unknown material name.')
      tints[material] = hexColor(colour, `tint ${material}`)
    }
    return {
      key, model, x: num(item, 'x', { min: -CELLS, max: CELLS }), z: num(item, 'z', { min: -CELLS, max: CELLS }),
      turns: num(item, 'turns', { integer: true, min: 0, max: 3 }) as PlacedItem['turns'],
      productId: optStr(item, 'productId', { max: 40 }), variantId: optStr(item, 'variantId', { max: 40 }), tints,
    }
  }, { max: HOME_ITEM_LIMIT_MAX })
  return { width, depth, floor: hexColor(raw.floor, 'floor'), wall: hexColor(raw.wall, 'wall'), items }
}

/** The street a home stands in, when it is placed. */
const streetOfHome = (home: HomeRecord): DistrictId | null => estateOf(home).site?.districtId ?? null
/** Who may go in, or is told where, may have changed for this home: everyone in its street asks again. Nothing in the event names the home. */
function tellStreet(world: World, home: HomeRecord): void {
  const districtId = streetOfHome(home)
  if (districtId) announceExteriors(world, state(world), districtId)
}

/**
 * Remove visitors who may no longer be inside after a policy change, block or unfriend. Each
 * keeps the door they came in by: their stay is marked shown-out, and `home.leave` takes them to it.
 */
function evictUninvited(world: World, home: HomeRecord): void {
  showOut(world, state(world), home.id, visitor => mayVisit(world, visitor, home))
  const key = roomKey({ kind: 'home', homeId: home.id })
  for (const visitor of occupantsOfRoom(world, key)) {
    if (mayVisit(world, visitor, home)) continue
    evict(world, visitor)
    world.push(visitor, { type: 'social.changed', scope: 'homes' })
  }
}

/** Tell the visitors inside that the home changed, so they read it again. */
function tellVisitors(world: World, home: HomeRecord): void {
  const key = roomKey({ kind: 'home', homeId: home.id })
  for (const visitor of occupantsOfRoom(world, key)) if (visitor !== home.owner) world.push(visitor, { type: 'social.changed', scope: 'homes' })
}

/** Hooks into the rooms module that take the world as an argument are added once, however many worlds a process holds. */
let roomsWired = false

export function registerHomes(world: World): void {
  if (!roomsWired) {
    roomsWired = true
    // A street room is refused to a member whose stay in a home is open, and nobody arrives inside a building.
    addEnterGate(streetGate)
    // Walking: the same rectangles `home.exteriors` sends, asked beside whatever rule the static scene's owner installs.
    addFootRule((moveWorld, _memberId, place, from, to) => place.ref.kind !== 'district' || homeFootAllowed(moveWorld, place.ref.districtId, from, to))
    // A last exit is for a reload straight after leaving a home. An accepted step away from it ends it.
    onStood(stoodAt)
  }
  setLayoutGuard(world, (home, estate, plan) => checkPlanOnParcel(world, home, estate, plan))
  onRoomEnter((visitWorld, visitor, ref) => { if (visitWorld === world) roomEntered(world, state(world), visitor, ref) })
  // Who is told where a home stands follows friendships and the owner's discoverable setting.
  world.onOperation((memberId, op) => {
    // A trip booked: the character has left, so a stay and a last exit end now. A booking that was refused does not come here.
    if (op === 'travel.book') { departed(world, state(world), memberId); return }
    if (op === 'member.unblock') { announceEverywhere(world, state(world)); return }
    if (op !== 'member.savePreferences' && !RELATION_OPS.has(op)) return
    const data = state(world)
    const streets = new Set<DistrictId>()
    for (const owner of [memberId, ...(RELATION_OPS.has(op) ? friendsOf(world, memberId) : [])]) {
      const home = exists(world, owner) ? data.homes[record(world, owner).profile.homeId] : undefined
      const districtId = home ? streetOfHome(home) : null
      if (districtId) streets.add(districtId)
    }
    for (const districtId of streets) announceExteriors(world, data, districtId)
  })

  onRoomEnter((visitWorld, visitor, ref) => {
    if (visitWorld !== world || ref.kind !== 'home') return
    const home = findHome(world, ref.homeId)
    if (visitor === home.owner || !areFriends(world, visitor, home.owner) || !mayVisit(world, visitor, home)) return
    if (roomOf(world, home.owner)?.key === roomKey(ref)) return
    emit(world, {
      to: home.owner, category: 'social', kind: 'home.visited', actor: visitor,
      title: `${publicMember(world, home.owner, visitor).displayName} called at your home`,
      body: 'You were out when they visited. Send them a message to catch up.',
      link: `/messages?to=${visitor}`, dedupeKey: visitKey(home.id, visitor),
    })
  })
  setRoomGuard('home', (guardWorld, memberId, ref: RoomRef) => {
    if (ref.kind !== 'home') return
    const home = findHome(guardWorld, ref.homeId)
    if (!mayVisit(guardWorld, memberId, home)) throw new WorldError('forbidden', 'This home is private.')
    // A home is a building in a street. Nobody steps into one from somewhere else.
    throw new WorldError('conflict', 'Go in by the front door: walk up to it and use it.')
  })

  onBlock((blockWorld, blocker, blocked) => {
    for (const owner of [blocker, blocked]) {
      const home = state(blockWorld).homes[record(blockWorld, owner).profile.homeId]
      if (home) {
        evictUninvited(blockWorld, home)
        settle(blockWorld, owner, visitKey(home.id, owner === blocker ? blocked : blocker))
        tellStreet(blockWorld, home)
      }
    }
  })

  onUnfriend((friendWorld, a, b) => {
    for (const owner of [a, b]) {
      const home = state(friendWorld).homes[record(friendWorld, owner).profile.homeId]
      if (home) {
        evictUninvited(friendWorld, home)
        settle(friendWorld, owner, visitKey(home.id, owner === a ? b : a))
        tellStreet(friendWorld, home)
      }
    }
  })

  world.register('home.get', value => ({ homeId: optStr(obj(value), 'homeId', { max: 60 }) as HomeId | null }), (ctx, input) => {
    const home = input.homeId ? findHome(world, input.homeId) : ensureHome(world, ctx.memberId)
    if (!mayVisit(world, ctx.memberId, home)) throw new WorldError('forbidden', 'This home is private.')
    world.touch()
    return { home: view(world, ctx.memberId, home), canEdit: home.owner === ctx.memberId }
  })

  world.register('home.save', value => {
    const raw = obj(value)
    return { layout: parseLayout(raw.layout), name: str(raw, 'name', { min: 1, max: 48 }), expectedRevision: num(raw, 'expectedRevision', { integer: true, min: 0 }) }
  }, (ctx, input) => {
    const home = ensureHome(world, ctx.memberId)
    if (input.expectedRevision !== home.revision) throw new WorldError('conflict', 'Your home was changed in another session. Reload it before saving again.')
    // Placing is free; owning is not. Every placed piece is one the member owns, in a room, clear of the doors.
    checkFurnitureSave(world, home, input.layout)
    // The colour of the front room's wall is the colour of the house in the street, and its name is on its door.
    const named = home.name
    watchExterior(world, state(world), home, () => {
      home.layout = input.layout
      home.name = input.name
      home.revision++
      home.updatedAt = iso(ctx.now)
      world.touch()
    })
    if (named !== home.name) tellStreet(world, home)
    tellVisitors(world, home)
    return { home: view(world, ctx.memberId, home) }
  })

  world.register('home.setPolicy', value => ({ policy: oneOf(obj(value), 'policy', ['private', 'friends', 'public'] as const) }), (ctx, input) => {
    const home = ensureHome(world, ctx.memberId)
    home.policy = input.policy
    home.updatedAt = iso(ctx.now)
    world.touch()
    evictUninvited(world, home)
    tellStreet(world, home)
    if (home.policy === 'private') for (const visitor of friendsOf(world, ctx.memberId)) settle(world, ctx.memberId, visitKey(home.id, visitor))
    return { home: view(world, ctx.memberId, home) }
  })

  world.register('home.move', value => ({ districtLabel: str(obj(value), 'districtLabel', { min: 1, max: 80 }) }), (ctx, input) => {
    const home = ensureHome(world, ctx.memberId)
    home.districtLabel = input.districtLabel
    home.updatedAt = iso(ctx.now)
    world.touch()
    return { home: view(world, ctx.memberId, home) }
  })

  world.register('home.visitable', empty, ctx => {
    const homes = Object.values(state(world).homes).filter(home => home.owner !== ctx.memberId && exists(world, home.owner) && mayVisit(world, ctx.memberId, home))
      .flatMap(home => {
        const owner = tryPublicMember(world, ctx.memberId, home.owner)
        return owner ? [{ homeId: home.id, owner, name: home.name, districtLabel: home.districtLabel, policy: home.policy }] : []
      })
      .sort((a, b) => Number(b.owner.relation === 'friend') - Number(a.owner.relation === 'friend') || a.name.localeCompare(b.name))
    return { homes: homes.slice(0, 50) }
  })

  // ── Building: the owner's own home only. Each of these starts from `ensureHome(ctx.memberId)`. ──

  world.register('home.catalog', empty, () => ({ catalog: catalog() }))

  world.register('home.estate', empty, ctx => {
    const home = ensureHome(world, ctx.memberId)
    return { home: view(world, ctx.memberId, home), estate: estateView(world, state(world), home) }
  })

  world.register('home.quote', value => ({ change: parseChange(obj(value).change) }), (ctx, input) => {
    world.limit(`home-quote:${ctx.memberId}`, 30, 60_000)
    return { quote: quoteChange(world, ensureHome(world, ctx.memberId), input.change, ctx.now) }
  })

  world.register('home.commit', parseCommit, (ctx, input) => {
    const home = ensureHome(world, ctx.memberId)
    const done = watchExterior(world, state(world), home, () => commitChange(world, state(world), home, input, ctx.now))
    if (done.shown) tellVisitors(world, home)
    // Always the caller's own home as it is now, first time or repeat: a receipt never opens anyone else's.
    return { receipt: done.receipt, repeated: done.repeated, home: view(world, ctx.memberId, home), estate: estateView(world, state(world), home) }
  })

  // ── The home in the street. Nothing here takes a position from the request. ──

  const mayEnter = (viewer: MemberId, home: HomeRecord): boolean => mayVisit(world, viewer, home) && maySeeSite(world, viewer, home)
  const homeId = (value: unknown): { homeId: HomeId | null } => ({ homeId: optStr(obj(value), 'homeId', { max: 60 }) as HomeId | null })
  /** The home named, for a caller who may visit it. The same door as `home.get`. */
  const visitable = (viewer: MemberId, id: HomeId | null): HomeRecord => {
    const home = id ? findHome(world, id) : ensureHome(world, viewer)
    if (!mayVisit(world, viewer, home)) throw new WorldError('forbidden', 'This home is private.')
    return home
  }
  const entered = (viewer: MemberId, home: HomeRecord, arrived: Pick<HomeEntered, 'inside' | 'snapshot' | 'history' | 'stay'>): HomeEntered =>
    ({ home: view(world, viewer, home), canEdit: home.owner === viewer, ...arrived })

  world.register('home.sites', empty, ctx => sitesFor(world, state(world), ensureHome(world, ctx.memberId)))

  world.register('home.setSite', value => {
    const raw = obj(value)
    if (raw.place === null) return { place: null }
    return { place: { parcelId: optStr(obj(raw.place, 'place'), 'parcelId', { max: 120 }) } }
  }, (ctx, input) => {
    const home = ensureHome(world, ctx.memberId)
    setSite(world, state(world), home, input.place, ctx.now)
    return { home: view(world, ctx.memberId, home) }
  })

  // Whoever may not visit learns nothing; whoever may visit but is not told where learns only that.
  world.register('home.approach', homeId, (ctx, input) => ({ approach: approachTo(world, ctx.memberId, input.homeId) }))

  world.register('home.exteriors', value => {
    const raw = obj(value), source = obj(raw.source, 'source')
    const districtId = str(raw, 'districtId', { max: 40 }) as DistrictId
    if (!parseDistrictId(districtId)) throw new WorldError('invalid', 'districtId is not a valid district')
    const field = (key: keyof HomeParcelSource): string => str(source, key, { min: 1, max: 80 })
    return { districtId, source: { id: field('id'), dataVersion: field('dataVersion'), mapDataVersion: field('mapDataVersion'), tileSha256: field('tileSha256'), sceneHash: field('sceneHash'), regionPackSha256: field('regionPackSha256') } }
  }, (ctx, input) => exteriorsFor(world, state(world), ctx.memberId, input.districtId, input.source, home => mayEnter(ctx.memberId, home as HomeRecord)))

  world.register('home.enter', homeId, (ctx, input) => {
    const home = visitable(ctx.memberId, input.homeId)
    return entered(ctx.memberId, home, enterHome(world, state(world), home, ctx.memberId, maySeeSite(world, ctx.memberId, home), ctx.now))
  })

  world.register('home.resume', empty, ctx => {
    const { home, arrived } = resumeHome(world, state(world), ctx.memberId, candidate => mayVisit(world, ctx.memberId, candidate as HomeRecord))
    return entered(ctx.memberId, home as HomeRecord, arrived)
  })

  world.register('home.leave', empty, ctx => leaveHome(world, state(world), ctx.memberId, ctx.now))
  world.register('home.return', empty, ctx => returnHome(world, state(world), ctx.memberId, ctx.now))
  world.register('home.presence', empty, ctx => presenceFor(world, state(world), ctx.memberId))
}

export const currentHomeRoom = (world: World, memberId: MemberId): HomeId | null => {
  const room = roomOf(world, memberId)
  return room?.ref.kind === 'home' ? room.ref.homeId : null
}
