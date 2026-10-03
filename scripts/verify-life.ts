// Evidence probe for daily life (food and energy): in-process world, controllable clock, plain
// asserts. Run: node scripts/verify-life.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { DistrictId, HomeId, MemberId } from '../src/shared/ids.ts'
import { distance, parseDistrictId } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { HOME_PHYSICAL } from '../src/shared/homes.ts'
import type { HomeParcelAnchor } from '../src/shared/homes.ts'
import {
  FOOD_KINDS, FOOD_REGIONS, GROCERY_PORTIONS, LIFE, TIERS, dishesFor, foodRegionOf, placeKeyOf, regionDishes, regularPrice, servesMeals, venueKindOf, venueMenu,
} from '../src/shared/life.ts'
import type { LifeChanged, LifeState, PlaceClaim, TableInvite } from '../src/shared/life.ts'
import { WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode, RoomRef } from '../src/shared/model.ts'
import type { ServerEvent } from '../src/shared/protocol.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { buildDistrict } from '../src/geo/district.ts'
import { StreetNavigator } from '../src/world/nav.ts'
import type { NavigationFootprint } from '../src/world/nav.ts'
import type { Connection, Persistence, World } from '../service/kernel.ts'
import { createWorld } from '../service/index.ts'
import { lifeEffects, needsSummary } from '../service/life.ts'
import { addFriendship, ensureMember } from '../service/members.ts'
import { placeOf } from '../service/rooms.ts'
import { careerPoints, spendPoints } from '../service/work.ts'

const SECOND = 1000, MINUTE = 60_000, HOUR = 3_600_000
let now = Date.UTC(2026, 9, 1, 8)
let stored: Record<string, unknown> | null = null
const persistence: Persistence = { load: () => (stored ? structuredClone(stored) : null), save: saved => { stored = structuredClone(saved) } }

const place = (label: string, countryCode: string, lat: number, lon: number): CoarseArea => areaFromPlace({ label, countryCode, anchor: { lat, lon } })
// Homes open only where compiled street and parcel data ship (Yaba and Wuse). Everyone here lives in Yaba, so a home is a real door in a real street.
const yaba = place('Yaba, Lagos', 'NG', 6.5095, 3.3711)
const manchester = place('Northern Quarter, Manchester', 'GB', 53.4839, -2.2364)

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const id = (name: string): MemberId => `m_life_${name}` as MemberId
const [A, B, C, D, E, F, G, H] = names.map(id) as [MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId]
const events: Record<string, ServerEvent[]> = {}
const links: Record<string, Connection> = {}

function connect(made: World, member: MemberId): void {
  links[member] = made.connect(member, frame => { if (frame.t === 'event') (events[member] ??= []).push(frame.event) }, () => {})
}
function makeWorld(connected = true): World {
  const made = createWorld({ now: () => now, persistence })
  for (const name of names) {
    ensureMember(made, id(name), `Member ${name.toUpperCase()}`)
    if (connected) connect(made, id(name))
  }
  return made
}
let world = makeWorld()

function rejects(code: ErrorCode, run: () => unknown, message?: RegExp): void {
  try { run() } catch (error) {
    assert.ok(error instanceof WorldError, `expected WorldError(${code}), got ${String(error)}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (message) assert.match(error.message, message)
    return
  }
  assert.fail(`expected ${code}, but the call succeeded`)
}

let failed = false
function check(name: string, run: () => void): void {
  if (failed) return
  // Each check starts with a full request allowance.
  now += 5 * SECOND
  try { run(); console.log(`PASS ${name}`) } catch (error) {
    failed = true
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

const whole = (value: number): number => Math.round(Math.max(0, Math.min(100, value)))
const life = (member: MemberId): LifeState => world.call(member, 'life.state', {}).state
const balance = (member: MemberId): number => careerPoints(world, member)
// Active time includes the same visible-tab beats as the App. A socket alone is not activity.
const pass = (ms: number): void => {
  const end = now + ms
  while (now < end) {
    for (const name of names) if (world.isOnline(id(name))) world.call(id(name), 'comeback.here', { visible: true, origin: null })
    now = Math.min(end, now + 2 * MINUTE)
  }
  world.tick()
}
const arriveAt = (member: MemberId, area: CoarseArea): void => { world.call(member, 'member.setCurrentArea', { area, source: 'manual' }) }
const street = (area: CoarseArea): RoomRef => ({ kind: 'district', districtId: area.arrivalDistrict })
const venue = (area: CoarseArea, placeId: string): RoomRef => ({ kind: 'venue', districtId: area.arrivalDistrict, placeId: placeId as never })
/** Leaving a room for another one; from inside a home that is out by the front door, as the service requires. */
const enter = (member: MemberId, ref: RoomRef) => {
  if (world.call(member, 'home.presence', {}).stay) world.call(member, 'home.leave', {})
  return world.call(member, 'room.enter', { ref, pos: { x: 1, z: 1 }, heading: 0 })
}

// A home is a door in the street: place it, walk to it on the game's own route, and go in with home.enter. Nothing here moves a character except accepted steps.
let navigator: StreetNavigator | null = null
function streetNavigator(): StreetNavigator {
  if (navigator) return navigator
  const tile = parseDistrictId(yaba.arrivalDistrict)!
  const roads = JSON.parse(readFileSync(new URL('../service/data/transport/yaba-vehicles.json', import.meta.url), 'utf8'))
  const bytes = readFileSync(new URL(`../service/data/transport/source/${tile.z}-${tile.x}-${tile.y}.pbf`, import.meta.url))
  navigator = new StreetNavigator(buildDistrict(yaba.arrivalDistrict as DistrictId, bytes, roads.mapDataVersion))
  // The region's props are in the way of the route, as they were when the parcels were chosen.
  navigator.registerObstacles('region', roads.districts.find((entry: { id: string }) => entry.id === yaba.arrivalDistrict).obstacles
    .filter((obstacle: { kind: string; outer: Vec2[] }) => obstacle.kind === 'prop' && obstacle.outer.length === 4)
    .map((prop: { outer: [Vec2, Vec2, Vec2, Vec2] }): NavigationFootprint => {
      const [c0, c1, c2, c3] = prop.outer
      return { pos: { x: (c0.x + c2.x) / 2, z: (c0.z + c2.z) / 2 }, angle: Math.atan2(-(c3.z - c0.z), c3.x - c0.x), width: Math.hypot(c3.x - c0.x, c3.z - c0.z), depth: Math.hypot(c1.x - c0.x, c1.z - c0.z), height: 1 }
    }))
  return navigator
}
/** Walk from wherever the service has the member standing, a few metres a second, every step accepted or the probe stops. */
function walkTo(member: MemberId, goal: Vec2): void {
  const route = streetNavigator().walkingRoute(placeOf(world, member)!.pos, goal).points
  route.forEach((point, leg) => {
    const from = placeOf(world, member)!.pos
    const steps = Math.max(1, Math.ceil(distance(from, point) / 4))
    for (let step = 1; step <= steps; step++) {
      now += SECOND
      const pos = { x: from.x + (point.x - from.x) * step / steps, z: from.z + (point.z - from.z) * step / steps }
      const moved = world.call(member, 'room.move', { pos, heading: Math.atan2(point.x - from.x, point.z - from.z), moving: leg < route.length - 1 || step < steps })
      assert.equal(moved.accepted, true, `the walk to the door was refused at ${JSON.stringify(pos)}`)
    }
  })
}
const goOut = (member: MemberId) => enter(member, street(yaba))
const homeId = (owner: MemberId) => world.call(owner, 'home.get', { homeId: null }).home.id
/** Put the member's own home on its first free parcel, from the street, as the service allows. Nothing is placed unasked. */
function placeHome(member: MemberId): void {
  goOut(member)
  world.call(member, 'home.setSite', { place: { parcelId: null } })
}
/** The parcel's own standing point, or a spot beside it when someone is already standing there: both are in reach of the door and clear of its wall. */
function doorSpot(member: MemberId, parcel: HomeParcelAnchor): Vec2 {
  const out = { x: Math.sin(parcel.facing), z: Math.cos(parcel.facing) }, across = { x: Math.cos(parcel.facing), z: -Math.sin(parcel.facing) }
  const beside = [-1.2, 1.2].map(side => ({ x: parcel.door.x + out.x * 0.9 + across.x * side, z: parcel.door.z + out.z * 0.9 + across.z * side }))
  const taken = (spot: Vec2): boolean => names.some(name => {
    const other = placeOf(world, id(name))
    return id(name) !== member && other !== null && other.ref.kind === 'district' && distance(other.pos, spot) < HOME_PHYSICAL.occupiedRadius
  })
  return [parcel.standing, ...beside.sort((p, q) => distance(p, parcel.access) - distance(q, parcel.access))].find(spot => !taken(spot)) ?? parcel.standing
}
/** Stand at the front door of `owner`'s home, outside, ready to go in. */
function toDoor(member: MemberId, owner: MemberId = member): HomeId {
  const home = homeId(owner)
  let approach = world.call(member, 'home.approach', { homeId: home }).approach
  if (approach.kind === 'unavailable' && approach.reason === 'unplaced' && member === owner) {
    placeHome(member)
    approach = world.call(member, 'home.approach', { homeId: home }).approach
  }
  assert.equal(approach.kind, 'walk', `the way to the home: ${JSON.stringify(approach)}`)
  if (approach.kind !== 'walk') throw new Error('unreachable')
  if (world.call(member, 'home.presence', {}).stay?.homeId === home || approach.enter.allowed) return home
  goOut(member)
  walkTo(member, doorSpot(member, approach.site.parcel))
  approach = world.call(member, 'home.approach', { homeId: home }).approach
  assert.ok(approach.kind === 'walk' && approach.enter.allowed, `at the door: ${JSON.stringify(approach)}`)
  return home
}
/** In by the front door of `owner`'s home: walk up to it, then home.enter. `room.enter` refuses a home. */
function goHome(member: MemberId, owner: MemberId = member) {
  const entered = world.call(member, 'home.enter', { homeId: toDoor(member, owner) })
  assert.equal(entered.stay.state, 'inside')
  assert.equal(placeOf(world, member)!.ref.kind, 'home', 'the service has them inside the home')
  return entered
}
const notes = (member: MemberId, kind: string) => world.call(member, 'notify.list', { includeRead: true }).notifications.filter(note => note.kind === kind)
const pushed = (member: MemberId): LifeChanged[] => (events[member] ?? []).flatMap(event => (event.type === 'life.changed' ? [event] : []))
const invites = (member: MemberId): TableInvite[] => (events[member] ?? []).flatMap(event => (event.type === 'life.table' ? [event] : []))
const ledger = (member: MemberId) => world.call(member, 'travel.state', {}).ledger

let orders = 0
const order = (): string => `probe-order-${++orders}`
const eat = (member: MemberId, itemId: string, claim: PlaceClaim | null, orderId = order()) => world.call(member, 'life.eat', { itemId, orderId, place: claim })
const menu = (member: MemberId, claim: PlaceClaim | null) => world.call(member, 'life.menu', { place: claim })

const kitchen: PlaceClaim = { category: 'restaurant', subclass: 'restaurant', name: 'Probe Kitchen' }
const library: PlaceClaim = { category: 'library', subclass: 'library', name: 'Probe Library' }
const shop: PlaceClaim = { category: 'grocery', subclass: 'supermarket', name: 'Probe Market' }
const cafe: PlaceClaim = { category: 'cafe', subclass: 'cafe', name: 'Probe Café' }
/** Each mapped place has its own board. Pick place ids whose boards suit the checks below, the way a tester would pick a venue. */
function placeWhere(kind: 'restaurant' | 'cafe', suits: (board: ReturnType<typeof venueMenu>) => boolean, from = 1000): string {
  for (let n = from; n < from + 500; n++) if (suits(venueMenu('ng', kind, placeKeyOf(yaba.arrivalDistrict, `p${n}`)))) return `p${n}`
  throw new Error('no place id suits')
}
const has = (board: ReturnType<typeof venueMenu>, dishId: string): boolean => board.dishes.some(dish => dish.id === dishId)
// A restaurant that serves amala (so not egusi) and whose special is moi moi; a café whose special is neither the tea nor the puff-puff.
const KITCHEN = placeWhere('restaurant', board => has(board, 'ng.amala') && board.specialId === 'ng.moimoi')
const CAFE = placeWhere('cafe', board => has(board, 'ng.puffpuff') && board.specialId === 'ng.zobo')
const LIBRARY = 'p1502', SHOP = 'p1503', QUIET = 'p1505'
const SECOND_UNIT = 1000
/** Move the clock forward to the next time a place's local clock reads hour:minute. */
function untilLocal(timezone: string, hour: number, minute = 0): void {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (let guard = 0; guard < 1500; guard++) {
    pass(60 * SECOND_UNIT)
    const parts = clock.formatToParts(now)
    if (Number(parts.find(part => part.type === 'hour')!.value) === hour && Number(parts.find(part => part.type === 'minute')!.value) === minute) return
  }
  throw new Error('the local time never came')
}

/** One full work shift: five correct answers, 40 seconds of world time. Returns what it paid. */
function workShift(member: MemberId): number {
  now += 35 * SECOND
  let { shift } = world.call(member, 'work.start', { workplaceId: 'corner-cafe', venueName: null })
  while (shift.status === 'active') {
    now += SECOND
    shift = world.call(member, 'work.answer', { shiftId: shift.id, index: shift.current!.index, handed: [...shift.current!.wants] }).shift
  }
  assert.equal(shift.status, 'completed')
  return shift.result!.points
}

// ── 1–5 Arriving and eating ──

check('1 needs begin the first time a member asks: peckish and rested; nobody has needs before that', () => {
  for (const member of [A, B, D, E, F, G]) arriveAt(member, yaba)
  arriveAt(H, manchester)
  assert.equal(needsSummary(world, A), null, 'no record before the first ask')
  const state = life(A)
  assert.deepEqual(state.hunger, { value: LIFE.start.hunger, level: 'low', label: 'Peckish' })
  assert.deepEqual(state.energy, { value: 100, level: 'good', label: 'Rested' })
  assert.equal(state.effects.onForm, false)
  assert.equal(state.effects.shiftBonusPercent, 0)
  assert.equal(state.effects.pace, LIFE.pace.normal)
  assert.equal(state.firstMealFree, true)
  assert.equal(state.balance, 150)
  assert.equal(state.region.id, 'ng')
  assert.equal(state.region.label, 'Nigeria')
  assert.equal(state.pantry, 0)
  assert.ok(needsSummary(world, A), 'the record exists after the first ask')
})

check('2 eating needs the room of a food venue: the street and a non-food venue are refused', () => {
  const before = balance(A)
  enter(A, street(yaba))
  let seen = menu(A, kitchen)
  assert.equal(seen.menu, null, 'claiming a restaurant while standing in the street shows no menu')
  assert.match(seen.reason, /out on the street/)
  rejects('conflict', () => eat(A, 'ng.jollof', kitchen), /out on the street/)
  enter(A, venue(yaba, LIBRARY))
  seen = menu(A, library)
  assert.equal(seen.menu, null)
  assert.equal(seen.reason, 'Probe Library does not serve food. Look for a café, restaurant, bakery or food shop.')
  rejects('conflict', () => eat(A, 'ng.jollof', library), /does not serve food/)
  rejects('conflict', () => eat(A, 'ng.jollof', null), /does not serve food/)
  rejects('invalid', () => eat(A, 'ng.jollof', { category: 'Rest aurant', subclass: '', name: 'x' }))
  assert.equal(balance(A), before, 'nothing was charged')
  assert.equal(life(A).hunger.value, 35, 'nothing was eaten')
  assert.equal(life(A).firstMealFree, true)
  enter(A, venue(yaba, KITCHEN))
  seen = menu(A, kitchen)
  assert.equal(seen.menu!.place, 'venue')
  assert.equal(seen.menu!.title, 'Probe Kitchen')
  assert.deepEqual(seen.menu!.items.map(item => item.name), ['Amala, ewedu and gbegiri', 'Jollof rice and chicken', 'Moi moi', 'Zobo'])
  assert.deepEqual(seen.menu!.items.map(item => item.price), [0, 0, 0, TIERS.drink.price], 'the welcome is a proper meal: the drink keeps its price')
  rejects('not_found', () => eat(A, 'uk.fishchips', kitchen), /not on the menu here/)
})

check('3 the first meal is on the house; after that an order charges exactly its price, once', () => {
  const first = eat(A, 'ng.jollof', kitchen)
  assert.equal(first.receipt!.onTheHouse, true)
  assert.equal(first.receipt!.charged, 0)
  assert.equal(balance(A), 150)
  assert.deepEqual(first.receipt!.hunger, { from: 35, to: 35 + TIERS.meal.hunger })
  assert.equal(first.state.firstMealFree, false)
  assert.ok(ledger(A).every(entry => entry.kind !== 'food'), 'a free meal moves no coins, so the wallet history has nothing to show')
  assert.ok(first.menu!.items.every(item => item.price === item.listPrice), 'the menu is back to list prices')
  const orderId = order()
  const second = eat(A, 'ng.zobo', kitchen, orderId)
  assert.equal(second.receipt!.charged, TIERS.drink.price)
  assert.equal(balance(A), 150 - TIERS.drink.price)
  assert.equal(second.state.balance, 150 - TIERS.drink.price)
  const spent = ledger(A)[0]!
  assert.deepEqual([spent.kind, spent.amount, spent.text, spent.balanceAfter], ['food', -TIERS.drink.price, 'Zobo · Probe Kitchen', 150 - TIERS.drink.price], 'the meal is in the wallet history')
  assert.deepEqual(second.receipt!.hunger, { from: 85, to: 85 + TIERS.drink.hunger })
  const again = eat(A, 'ng.zobo', kitchen, orderId)
  assert.equal(again.repeated, true)
  assert.equal(again.receipt, null)
  assert.equal(balance(A), 150 - TIERS.drink.price, 'the same order id is not charged a second time')
  assert.equal(ledger(A).filter(entry => entry.kind === 'food').length, 1, 'or written to the wallet twice')
  assert.equal(again.state.hunger.value, second.state.hunger.value, 'or eaten a second time')
  assert.deepEqual(life(A).meals.map(meal => [meal.name, meal.where, meal.price]), [['Zobo', 'Probe Kitchen', 6], ['Jollof rice and chicken', 'Probe Kitchen', 0]])
})

check('4 short of coins: refused with the shortfall, nothing charged, nothing eaten', () => {
  enter(F, venue(yaba, KITCHEN))
  const drink = eat(F, 'ng.zobo', kitchen).receipt!
  assert.deepEqual([drink.onTheHouse, drink.charged], [false, TIERS.drink.price], 'a drink before the first meal is paid for')
  assert.equal(life(F).firstMealFree, true, 'and the welcome meal is still waiting')
  assert.equal(eat(F, 'ng.moimoi', kitchen).receipt!.onTheHouse, true)
  spendPoints(world, F, 139)
  assert.equal(balance(F), 5)
  const hungerBefore = life(F).hunger.value
  rejects('conflict', () => eat(F, 'ng.jollof', kitchen), /^You need 17 more coins for Jollof rice and chicken\./)
  const item = menu(F, kitchen).menu!.items.find(entry => entry.id === 'ng.jollof')!
  assert.deepEqual([item.can, item.short, item.price], [false, 17, 22])
  assert.equal(balance(F), 5)
  assert.equal(life(F).hunger.value, hungerBefore)
  spendPoints(world, F, 5)
  rejects('conflict', () => eat(F, 'ng.zobo', kitchen), /^You need 6 more coins for Zobo\./)
})

check('5 food restores the stated amount, capped at 100; eating when full gives nothing and costs nothing', () => {
  assert.equal(life(A).hunger.value, 91)
  const paid = balance(A)
  const light = eat(A, 'ng.moimoi', kitchen)
  assert.deepEqual(light.receipt!.hunger, { from: 91, to: 100 }, '91 + 30 is capped at 100')
  assert.equal(balance(A), paid - TIERS.light.price)
  rejects('conflict', () => eat(A, 'ng.jollof', kitchen), /^You are full\./)
  rejects('conflict', () => eat(A, 'ng.amala', kitchen), /^You are full\./)
  rejects('conflict', () => eat(A, 'ng.zobo', kitchen), /^You are full\./)
  assert.equal(balance(A), paid - TIERS.light.price, 'refusals are free')
  assert.equal(life(A).hunger.value, 100)
  assert.ok(menu(A, kitchen).menu!.items.every(item => !item.can && item.short === 0), 'the menu says so before the member tries')
})

// ── 6–8 The meters and the clock ──

check('6 active play, both meters run down with the clock and stop at a floor', () => {
  assert.deepEqual([life(G).hunger.value, life(G).energy.value], [35, 100])
  pass(30 * MINUTE)
  let state = life(G)
  assert.equal(state.hunger.value, whole(35 + LIFE.online.hunger * 0.5), 'half an hour online: 35 − 12.5')
  assert.equal(state.energy.value, 100 + LIFE.online.energy * 0.5, 'half an hour online: 100 − 10')
  assert.equal(state.at, new Date(now).toISOString())
  pass(10 * HOUR)
  state = life(G)
  assert.equal(state.hunger.value, LIFE.floor.hunger, 'time alone never takes hunger below the floor')
  assert.equal(state.energy.value, LIFE.floor.energy, 'nor energy')
  assert.deepEqual([state.hunger.level, state.hunger.label, state.energy.level, state.energy.label], ['critical', 'Hungry', 'critical', 'Exhausted'])
  assert.equal(state.effects.pace, LIFE.pace.worn, 'hungry and exhausted: the walk slows')
  assert.equal(lifeEffects(world, G)!.pace, LIFE.pace.worn, 'the same effects are readable by other modules')
  pass(48 * HOUR)
  assert.deepEqual([life(G).hunger.value, life(G).energy.value], [LIFE.floor.hunger, LIFE.floor.energy], 'two more days online change nothing')
})

check('7 each threshold sends one notification per crossing, however many ticks pass', () => {
  assert.equal(notes(G, 'life.hungry').length, 1)
  assert.equal(notes(G, 'life.exhausted').length, 1)
  for (let minute = 0; minute < 120; minute++) pass(MINUTE)
  assert.equal(notes(G, 'life.hungry').length, 1, 'still one')
  assert.equal(notes(G, 'life.hungry')[0]!.count, 1, 'and it was sent once, not folded many times')
  assert.equal(notes(G, 'life.exhausted')[0]!.count, 1)
  assert.equal(notes(G, 'life.hungry')[0]!.category, 'events')
  assert.equal(notes(G, 'life.hungry')[0]!.title, 'Your character is hungry')
  const levels = pushed(G).filter(event => event.reason === 'level')
  assert.ok(levels.length >= 1 && levels.length <= 4, `life.changed is pushed when a level changes, not every tick (${levels.length} pushes over ${123} ticks)`)
  assert.ok(levels.some(event => event.note === 'You are hungry. Find something to eat.'))
  // Recover, then cross again: a second notification, and the first one is settled.
  enter(G, venue(yaba, KITCHEN))
  const fed = eat(G, 'ng.amala', kitchen)
  assert.equal(fed.state.hunger.value, LIFE.floor.hunger + TIERS.feast.hunger)
  assert.equal(notes(G, 'life.hungry')[0]!.state, 'resolved', 'eating settles the hungry notice')
  pass(4 * HOUR)
  assert.equal(life(G).hunger.value, LIFE.floor.hunger)
  const hungry = notes(G, 'life.hungry')
  assert.equal(hungry.length, 2, 'a new crossing, a new notice')
  assert.deepEqual(hungry.map(note => note.state).sort(), ['active', 'resolved'])
})

check('8 away, the character sleeps: energy returns, hunger creeps to a higher floor, and one hungry notice is sent', () => {
  enter(E, venue(yaba, KITCHEN))
  assert.equal(eat(E, 'ng.amala', kitchen).state.hunger.value, 100)
  pass(2 * HOUR)
  assert.deepEqual([life(E).hunger.value, life(E).energy.value], [50, 60], 'two hours online: −50 and −40')
  world.disconnect(links[E]!)
  assert.ok(Math.abs(LIFE.away.hunger) < Math.abs(LIFE.online.hunger) / 2, 'hunger falls much more slowly away')
  pass(HOUR)
  let summary = needsSummary(world, E)!
  assert.deepEqual([summary.hunger, summary.energy], [50 + LIFE.away.hunger, 60 + LIFE.away.energy], 'one hour away: −8 and +17')
  assert.equal(summary.hungry, false)
  assert.equal(summary.hungryAt, new Date(now + ((42 - 19.5) / 8) * HOUR).toISOString(), 'the come-back track can see when hunger arrives')
  assert.equal(notes(E, 'life.hungry').length, 0)
  pass(2 * HOUR)
  summary = needsSummary(world, E)!
  assert.deepEqual([summary.hunger, summary.energy], [26, 100], 'energy is capped at 100')
  for (let hour = 0; hour < 30; hour++) pass(HOUR)
  summary = needsSummary(world, E)!
  assert.deepEqual([summary.hunger, summary.energy], [LIFE.floor.awayHunger, 100], 'a day away ends at the away floor, not at zero')
  assert.equal(summary.hungry, true)
  assert.match(summary.headline, /^Rested, and hungry: time for (something to eat|breakfast|lunch|dinner)\.$/)
  assert.ok(summary.hungrySince && Date.parse(summary.hungrySince) < now)
  assert.equal(summary.lastMeal!.name, 'Amala, ewedu and gbegiri')
  assert.equal(notes(E, 'life.hungry').length, 1, 'one notice for the crossing while away')
  assert.equal(notes(E, 'life.hungry')[0]!.count, 1)
  pass(20 * 24 * HOUR)
  assert.equal(needsSummary(world, E)!.hunger, LIFE.floor.awayHunger, 'three weeks away is no worse than one day')
  assert.equal(notes(E, 'life.hungry').length, 1)
  const before = pushed(E).length
  connect(world, E)
  const woke = pushed(E).slice(before)
  assert.equal(woke.length, 1)
  assert.equal(woke[0]!.reason, 'woke')
  assert.match(woke[0]!.note, /^You were away 21 days\. You slept well: energy is full\. You are hungry: (time for something to eat|it is (breakfast|lunch|dinner) time)\.$/)
  assert.deepEqual([woke[0]!.state.hunger.value, woke[0]!.state.energy.value], [LIFE.floor.awayHunger, 100])
})

// ── 9–13 Drinks, home, and what the meters do ──

check('9 a hot drink is for energy; ordering is limited to ten a minute', () => {
  enter(G, venue(yaba, CAFE))
  assert.equal(life(G).energy.value, LIFE.floor.energy)
  const paid = balance(G)
  const tea = eat(G, 'ng.tea', cafe)
  assert.deepEqual(tea.receipt!.energy, { from: 10, to: 10 + TIERS.coffee.energy })
  assert.equal(tea.receipt!.charged, TIERS.coffee.price)
  assert.equal(balance(G), paid - TIERS.coffee.price)
  const codes: string[] = []
  for (let n = 0; n < 12; n++) { try { eat(G, 'ng.puffpuff', cafe); codes.push('ok') } catch (error) { codes.push((error as WorldError).code) } }
  assert.deepEqual(codes.slice(0, 9), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'conflict', 'conflict', 'conflict'], 'six snacks fill G up; the rest are refused as full')
  assert.deepEqual(codes.slice(9), ['rate_limited', 'rate_limited', 'rate_limited'], 'the eleventh order in a minute waits')
  assert.equal(balance(G), paid - TIERS.coffee.price - 6 * TIERS.snack.price, 'only the six that were eaten were charged')
})

check('10 groceries stock the kitchen; cooking and the free plain meal happen in your own home only', () => {
  placeHome(A)
  enter(A, venue(yaba, SHOP))
  const hungerBefore = life(A).hunger.value
  const shelf = menu(A, shop).menu!
  assert.equal(shelf.place, 'grocery')
  assert.deepEqual(shelf.items.map(item => [item.name, item.price, item.portions]), [['Rice, tomatoes and pepper', TIERS.groceries.price, GROCERY_PORTIONS]])
  const paid = balance(A)
  assert.deepEqual(eat(A, 'ng.groceries', shop).receipt!.pantry, { from: 0, to: 3 })
  assert.deepEqual(eat(A, 'ng.groceries', shop).receipt!.pantry, { from: 3, to: LIFE.pantryMax })
  rejects('conflict', () => eat(A, 'ng.groceries', shop), /^Your kitchen is stocked: 6 of 6 portions\./)
  assert.equal(balance(A), paid - 2 * TIERS.groceries.price)
  assert.deepEqual([ledger(A)[0]!.kind, ledger(A)[0]!.amount, ledger(A)[0]!.text], ['food', -TIERS.groceries.price, 'Groceries · Probe Market'])
  assert.equal(life(A).hunger.value, hungerBefore, 'groceries are not eaten in the shop')
  rejects('not_found', () => eat(A, 'ng.home', shop), /not on the menu/)

  // G is hungry and has no coins: the cupboard is still there.
  goHome(G)
  spendPoints(world, G, balance(G))
  pass(5 * HOUR)
  assert.equal(life(G).hunger.value, LIFE.floor.hunger)
  const cupboard = menu(G, null).menu!
  assert.equal(cupboard.place, 'home')
  assert.deepEqual(cupboard.items.map(item => [item.name, item.price, item.can]), [['Home-cooked jollof', 0, false], ['Garri and groundnuts', 0, true]])
  assert.equal(cupboard.items[0]!.why, 'Your kitchen is empty. Buy groceries at a food shop or supermarket.')
  assert.deepEqual(eat(G, 'ng.staple', null).receipt!.hunger, { from: 10, to: 30 })
  assert.deepEqual(eat(G, 'ng.staple', null).receipt!.hunger, { from: 30, to: LIFE.stapleCeiling }, 'the plain meal only tops up to 40')
  rejects('conflict', () => eat(G, 'ng.staple', null), /^A plain meal only helps below 40\./)
  assert.equal(balance(G), 0, 'it is free')

  // B walks to A's door while A is still out: a walk is time, and time at home is rest.
  addFriendship(world, A, B)
  toDoor(B, A)
  // The door is the only way in: not a room request, and not from the shop.
  rejects('conflict', () => world.call(A, 'room.enter', { ref: { kind: 'home', homeId: homeId(A) }, pos: { x: 1, z: 1 }, heading: 0 }), /front door/)
  rejects('conflict', () => world.call(A, 'home.enter', { homeId: null }), /Walk to the front door first/)
  goHome(A)
  const cooked = eat(A, 'ng.home', null)
  assert.deepEqual(cooked.receipt!.pantry, { from: 6, to: 5 })
  assert.equal(cooked.receipt!.charged, 0)
  assert.deepEqual(cooked.receipt!.hunger, { from: LIFE.floor.hunger, to: LIFE.floor.hunger + TIERS.home.hunger })
  assert.equal(cooked.state.meals[0]!.where, 'Home')

  goHome(B, A)
  const visiting = menu(B, null)
  assert.equal(visiting.menu, null)
  assert.match(visiting.reason, /someone else’s home/)
  rejects('conflict', () => eat(B, 'ng.staple', null), /someone else’s home/)
})

check('11 standing in your own home brings energy back; a friend’s home does not', () => {
  const guest = life(B).energy.value
  enter(A, street(yaba))
  const outside = life(A).energy.value
  assert.ok(outside < 40, `A starts tired (${outside})`)
  // No tick between these: the rooms module tells this module the moment A walks in and out.
  now += 20 * SECOND
  goHome(A)
  assert.equal(life(A).energy.value, outside, 'twenty seconds outside the door are not rest')
  assert.equal(life(A).resting, true)
  now += 30 * SECOND
  assert.equal(life(A).energy.value, outside + 30 * LIFE.restPerSecond, 'thirty seconds at home, thirty points, with no tick in between')
  enter(A, street(yaba))
  now += 30 * SECOND
  assert.equal(life(A).energy.value, outside + 30, 'thirty more seconds outside add nothing')
  assert.equal(life(A).resting, false)
  goHome(A)
  const from = life(A).energy.value
  for (let second = 0; second < 30; second++) pass(SECOND)
  assert.equal(life(A).energy.value, from + 30 * LIFE.restPerSecond)
  for (let second = 0; second < 90; second++) pass(SECOND)
  assert.equal(life(A).energy.value, 100)
  assert.equal(life(A).resting, false, 'full: no longer resting')
  assert.ok(pushed(A).some(event => event.note === 'Fully rested.'))
  assert.equal(notes(A, 'life.exhausted')[0]!.state, 'resolved', 'the exhausted notice is settled')
  assert.ok(life(B).energy.value <= guest, 'B stood in A’s home the whole time and did not rest')
  assert.equal(life(B).resting, false)
  enter(A, street(yaba))
  pass(30 * MINUTE)
  assert.equal(life(A).energy.value, 100 + LIFE.online.energy * 0.5, 'back on the street, energy runs down again')
})

check('12 on form, a finished shift pays a bonus; hungry, it pays the plain amount', () => {
  enter(B, street(yaba))
  goHome(A)
  assert.equal(eat(A, 'ng.home', null).receipt!.shared, false, 'B has left: A eats alone')
  enter(A, street(yaba))
  const state = life(A)
  assert.ok(state.hunger.value >= 60 && state.energy.value >= 60, `A is fed and rested (${state.hunger.value}/${state.energy.value})`)
  assert.equal(state.effects.onForm, true)
  assert.equal(state.effects.shiftBonusPercent, LIFE.onForm.percent)
  assert.equal(state.effects.pace, LIFE.pace.onForm)
  const before = balance(A), seen = pushed(A).length
  const pay = workShift(A)
  const bonus = Math.min(LIFE.onForm.cap, Math.round(pay * LIFE.onForm.percent / 100))
  assert.ok(bonus >= 10, `a real bonus (${bonus} on ${pay})`)
  assert.equal(balance(A), before + pay + bonus, 'paid the moment the shift closes, with no tick: exactly 10% of what it paid')
  const entry = ledger(A)[0]!
  assert.deepEqual([entry.kind, entry.amount, entry.text], ['work', bonus, 'On-form bonus · 10% for being well fed and rested'], 'the bonus is in the wallet history as an earning')
  const event = pushed(A).slice(seen).find(item => item.reason === 'shift')!
  assert.equal(event.bonus, bonus)
  assert.equal(event.note, `On form: ${bonus} coins extra for that shift.`)
  const after = life(A)
  assert.ok(Math.abs(after.hunger.value - (state.hunger.value + LIFE.shift.hunger)) <= 1, 'a shift takes 4 food')
  assert.ok(Math.abs(after.energy.value - (state.energy.value + LIFE.shift.energy)) <= 1, 'and 5 energy')
  for (let second = 0; second < 5; second++) pass(SECOND)
  assert.equal(balance(A), before + pay + bonus, 'the bonus is paid once')
  // A shift left early is not a finished shift: no bonus, and it takes nothing out of you.
  const leftAt = life(A)
  assert.equal(leftAt.effects.onForm, true)
  const partBefore = balance(A)
  now += 35 * SECOND
  let part = world.call(A, 'work.start', { workplaceId: 'corner-shop', venueName: null }).shift
  for (let index = 0; index < 4; index++) { now += SECOND; part = world.call(A, 'work.answer', { shiftId: part.id, index, handed: [...part.current!.wants] }).shift }
  const left = world.call(A, 'work.leave', { shiftId: part.id }).shift
  assert.equal(left.status, 'left-early')
  assert.equal(balance(A), partBefore + left.result!.points, 'only the tickets were paid')
  assert.ok(leftAt.energy.value - life(A).energy.value <= 1, 'and no shift cost was taken')

  // G has rested at home but is hungry: no bonus, and never a deduction.
  pass(3 * HOUR)
  const worn = life(G)
  assert.deepEqual([worn.hunger.level, worn.energy.level], ['critical', 'good'])
  assert.equal(worn.effects.onForm, false)
  assert.equal(worn.effects.pace, LIFE.pace.worn)
  const plain = balance(G)
  const plainPay = workShift(G)
  assert.equal(balance(G), plain + plainPay, 'exactly what the shift paid')
  // C has never asked for needs: this module leaves their pay and their inbox alone.
  arriveAt(C, yaba)
  const untouched = balance(C)
  const untouchedPay = workShift(C)
  pass(40 * HOUR)
  assert.equal(balance(C), untouched + untouchedPay)
  assert.equal(needsSummary(world, C), null)
  assert.equal(notes(C, 'life.hungry').length + notes(C, 'life.exhausted').length, 0)
  assert.equal(pushed(C).length, 0)
})

check('13 a proper meal with someone else in the room lifts the bonus for two hours; a blocked member is not company', () => {
  goHome(B)
  world.tick()
  for (let second = 0; second < 95; second++) pass(SECOND)
  enter(A, venue(yaba, KITCHEN))
  enter(B, venue(yaba, KITCHEN))
  const earlier = invites(A).length
  const shared = eat(B, 'ng.amala', kitchen)
  assert.equal(shared.receipt!.shared, true)
  assert.equal(shared.state.effects.companyUntil, new Date(now + LIFE.company.hours * HOUR).toISOString())
  assert.equal(shared.state.effects.onForm, true)
  assert.deepEqual([shared.state.effects.shiftBonusPercent, shared.state.effects.shiftBonusCap], [LIFE.company.percent, LIFE.company.cap])
  assert.equal(eat(B, 'ng.zobo', kitchen).receipt!.shared, false, 'a drink is not a shared meal')
  // A was in the room and not eating: A hears about it once, and can join.
  assert.deepEqual(invites(A).slice(earlier).map(invite => [invite.from.name, invite.dish.name]), [['Member B', 'Amala, ewedu and gbegiri']])
  assert.deepEqual(shared.receipt!.with, [], 'nobody was eating yet')
  assert.equal(menu(A, kitchen).menu!.eating.join(), 'Member B', 'the menu says who is eating here')
  const before = balance(B)
  const pay = workShift(B)
  assert.equal(balance(B), before + pay + Math.min(LIFE.company.cap, Math.round(pay * LIFE.company.percent / 100)), 'the lifted bonus is what gets paid')
  // A sits down within ten minutes: now they are eating together, and each is in the other's food diary.
  const coins = [balance(A), balance(B)]
  const told = pushed(B).length, tables = life(A).together
  const joined = eat(A, 'ng.jollof', kitchen)
  assert.deepEqual(joined.receipt!.with, ['Member B'])
  assert.equal(joined.receipt!.shared, true)
  assert.deepEqual(joined.state.meals[0]!.with, ['Member B'])
  assert.equal(joined.state.together, tables + 1)
  const news = pushed(B).slice(told).find(event => event.reason === 'table')!
  assert.equal(news.note, 'Member A sat down with Jollof rice and chicken. You are eating together.')
  assert.deepEqual(life(B).meals.find(meal => meal.name === 'Amala, ewedu and gbegiri')!.with, ['Member A'], 'on the plate B sat down to, not the drink ordered after it')
  assert.equal(life(B).together, 1)
  assert.equal(life(B).effects.companyUntil, new Date(now + LIFE.company.hours * HOUR).toISOString(), 'B’s good company starts again')
  assert.deepEqual([balance(A), balance(B)], [coins[0]! - TIERS.meal.price, coins[1]!], 'each pays for their own plate and nothing passes between them')
  assert.equal(invites(B).length, 0, 'B was already eating, so B is told as a companion, not invited')
  // Eleven minutes later the table has moved on: company still counts, but it is not a meal together.
  now += 11 * MINUTE
  const later = eat(B, 'ng.moimoi', kitchen)
  assert.deepEqual([later.receipt!.shared, later.receipt!.with], [true, []])
  assert.equal(later.state.together, 1)
  // D eats with only A in the room, and A has blocked D.
  world.call(A, 'member.block', { memberId: D })
  enter(A, venue(yaba, QUIET))
  enter(D, venue(yaba, QUIET))
  const heard = invites(A).length
  const alone = eat(D, 'ng.jollof', kitchen)
  assert.equal(alone.receipt!.shared, false)
  assert.equal(alone.state.effects.companyUntil, null)
  assert.equal(invites(A).length, heard, 'A is not told that a blocked member is eating')
  assert.deepEqual(menu(A, kitchen).menu!.eating, [], 'and does not see them on the menu')
  pass(LIFE.company.hours * HOUR + MINUTE)
  assert.equal(life(B).effects.companyUntil, null, 'the boost ends')
})

// ── 14–17 Privacy, other modules, storage ──

check('14 nobody can read another member’s meters: friends get words only, strangers and blocked members nothing', () => {
  const mood = world.call(B, 'life.peek', { memberId: A }).mood!
  assert.deepEqual(Object.keys(mood).sort(), ['energy', 'energyLabel', 'hunger', 'hungerLabel', 'onForm'])
  assert.ok(!/\d/.test(JSON.stringify(mood)), 'a friend sees levels in words, never numbers')
  rejects('forbidden', () => world.call(F, 'life.peek', { memberId: A }), /Only friends/)
  rejects('not_found', () => world.call(D, 'life.peek', { memberId: A }))
  rejects('not_found', () => world.call(A, 'life.peek', { memberId: D }))
  rejects('not_found', () => world.call(A, 'life.peek', { memberId: 'm_life_nobody' as MemberId }))
  addFriendship(world, B, C)
  assert.equal(world.call(B, 'life.peek', { memberId: C }).mood, null, 'a friend without needs yet has no mood')
  // life.state takes no member id at all: whatever is sent, the caller gets their own.
  const mine = world.call(F, 'life.state', { memberId: A } as never).state
  assert.equal(mine.balance, balance(F))
  assert.deepEqual(mine.meals.map(meal => meal.name), ['Moi moi', 'Zobo'])
  // Pushes only ever carry the receiver's own state.
  assert.ok(pushed(A).some(event => event.state.meals.some(meal => meal.where === 'Probe Market')), 'A was told about A’s grocery run')
  for (const member of [B, D, E, F, G, H]) assert.ok(pushed(member).every(event => !event.state.meals.some(meal => meal.where === 'Probe Market')), 'nobody else received it')
})

check('15 menus follow the country, prices follow the tier, and dishes tried are collected', () => {
  assert.equal(life(H).region.label, 'Britain and Ireland')
  enter(H, venue(manchester, 'p2001'))
  const british = menu(H, kitchen).menu!
  const board = venueMenu('uk', 'restaurant', placeKeyOf(manchester.arrivalDistrict, 'p2001'))
  assert.deepEqual(british.items.map(item => item.id), board.dishes.map(dish => dish.id))
  assert.equal(board.dishes.length, 5, 'one of the two big meals is left off this board')
  assert.ok(board.dishes.some(dish => dish.name === 'Fish and chips') && board.dishes.some(dish => dish.name === 'Cup of tea'))
  assert.equal(british.regionLabel, 'Britain and Ireland')
  assert.ok(british.items.every(item => item.listPrice === TIERS[item.tier].price), 'list prices come from the tier')
  assert.deepEqual(british.items.map(item => item.price), [0, 0, 0, TIERS.coffee.price, TIERS.drink.price], 'the first proper meal is on the house; drinks are not')
  rejects('not_found', () => eat(H, 'ng.jollof', kitchen), /not on the menu here/)
  const tried = eat(H, 'uk.fishchips', kitchen)
  assert.equal(tried.receipt!.newDish, true)
  assert.deepEqual(tried.state.tried, ['uk.fishchips'])
  assert.equal(tried.state.region.tried, 1)
  assert.equal(tried.state.region.dishes, regionDishes('uk').length)
  assert.equal(tried.menu!.items.find(item => item.id === 'uk.fishchips')!.isNew, false)
  assert.equal(tried.menu!.items.find(item => item.id === 'uk.fishchips')!.price, TIERS.meal.price, 'the same tier costs the same in every country')
  for (const region of FOOD_REGIONS) for (const kind of FOOD_KINDS) {
    const dishes = dishesFor(region, kind)
    assert.ok(dishes.length >= 3 && dishes.length <= 6, `${region} ${kind} has ${dishes.length} dishes`)
    assert.equal(new Set(dishes.map(dish => dish.id)).size, dishes.length)
    assert.ok(dishes.some(dish => TIERS[dish.tier].hunger >= 12), `${region} ${kind} has something to eat`)
  }
  assert.equal(foodRegionOf('NG'), 'ng')
  assert.equal(foodRegionOf('ZZ'), 'xx')
  assert.equal(foodRegionOf(null), 'xx')
  assert.deepEqual([venueKindOf('cafe'), venueKindOf('beer'), venueKindOf('shop', 'supermarket'), venueKindOf('shop', 'clothes'), venueKindOf('library')], ['cafe', 'bar', 'grocery', null, null])
  assert.deepEqual([venueKindOf('grocery', 'marketplace'), venueKindOf('fuel', 'fuel'), venueKindOf('railway', 'station'), venueKindOf('lodging', 'hotel')], ['market', 'kiosk', 'kiosk', 'restaurant'])
  assert.deepEqual([servesMeals('fast_food'), servesMeals('grocery'), servesMeals('bank')], [true, false, false])
  // A mapped market has hot food and groceries; a station kiosk has one of each small thing.
  enter(H, venue(manchester, 'p2002'))
  const market = menu(H, { category: 'grocery', subclass: 'marketplace', name: 'Probe Market Hall' }).menu!
  assert.deepEqual([market.place, market.kind], ['venue', 'market'])
  assert.deepEqual(market.items.map(item => item.tier), ['meal', 'light', 'snack', 'snack', 'groceries'])
  const kiosk = menu(H, { category: 'railway', subclass: 'station', name: 'Probe Station' }).menu!
  assert.deepEqual(kiosk.items.map(item => item.tier), ['snack', 'sweet', 'coffee', 'drink'])
  for (const region of FOOD_REGIONS) assert.equal(dishesFor(region, 'kiosk').length, 4, `${region} kiosk`)
})

check('16 breakfast, lunch and dinner follow the local clock: a proper meal in its window is a little better, once a day', () => {
  const zone = life(H).day.timezone
  assert.equal(zone, 'Europe/London')
  pass(3 * HOUR)
  untilLocal(zone, 13)
  world.tick()
  assert.equal(life(H).day.now, 'lunch')
  assert.deepEqual(life(H).day.had, [])
  const lunch = eat(H, 'uk.fishchips', kitchen)
  assert.equal(lunch.receipt!.mealtime, 'lunch')
  assert.equal(lunch.receipt!.energy.to - lunch.receipt!.energy.from, TIERS.meal.energy + LIFE.mealtimeEnergy, 'lunch at lunch time: ten more energy')
  assert.deepEqual(lunch.state.day.had, ['lunch'])
  assert.equal(lunch.state.meals[0]!.mealtime, 'lunch')
  assert.equal(lunch.menu!.mealtime, null, 'lunch has been had')
  assert.equal(lunch.state.day.next.which, 'dinner')
  const drink = eat(H, 'uk.lemonade', kitchen)
  assert.equal(drink.receipt!.mealtime, null, 'a drink is not lunch')
  untilLocal(zone, 13, 40)
  const second = eat(H, 'uk.jacket', kitchen)
  assert.equal(second.receipt!.mealtime, null, 'a second lunch is only a meal')
  assert.equal(second.receipt!.energy.to - second.receipt!.energy.from, TIERS.light.energy)
  untilLocal(zone, 16)
  assert.equal(life(H).day.now, null)
  assert.equal(menu(H, kitchen).menu!.mealtime, null, 'between meals nothing is lost and nothing is added')
  untilLocal(zone, 8)
  const morning = life(H)
  assert.deepEqual([morning.day.now, morning.day.had], ['breakfast', []], 'a new day')
  assert.equal(menu(H, kitchen).menu!.mealtime, 'breakfast')
  assert.equal(needsSummary(world, H)!.mealtime, 'breakfast')
  assert.match(needsSummary(world, H)!.headline, /time for breakfast\.$/, 'the come-back line knows what meal it is')
})

check('17 every place has its own board and special; after three visits you are a regular with a usual and a lower price', () => {
  const boards = [1600, 1601, 1602, 1603, 1604, 1605, 1606, 1607].map(n => venueMenu('ng', 'cafe', placeKeyOf(yaba.arrivalDistrict, `p${n}`)))
  assert.ok(new Set(boards.map(board => `${board.dishes.map(dish => dish.id).join()}|${board.specialId}`)).size >= 3, 'eight cafés in one district are not eight copies')
  assert.ok(boards.every(board => board.dishes.length === 4 && board.dishes.some(dish => dish.id === board.specialId)))
  assert.deepEqual(venueMenu('ng', 'cafe', placeKeyOf(yaba.arrivalDistrict, CAFE)), venueMenu('ng', 'cafe', placeKeyOf(yaba.arrivalDistrict, CAFE)), 'and a place is the same every time')
  enter(C, venue(yaba, CAFE))
  let board = menu(C, cafe).menu!
  const special = board.items.find(item => item.special)!
  assert.deepEqual([special.id, special.energy, special.price], ['ng.zobo', TIERS.drink.energy + LIFE.special, TIERS.drink.price], 'the house special gives more for the same price')
  assert.deepEqual([board.visits, board.regular, board.items.some(item => item.usual)], [0, false, false])
  const first = eat(C, 'ng.puffpuff', cafe)
  assert.equal(eat(C, 'ng.zobo', cafe).receipt!.energy.to, Math.min(100, first.state.energy.value + TIERS.drink.energy + LIFE.special))
  assert.equal(menu(C, cafe).menu!.visits, 1, 'two orders in one sitting are one visit')
  pass(31 * MINUTE)
  assert.equal(eat(C, 'ng.puffpuff', cafe).receipt!.nowRegular, false)
  pass(31 * MINUTE)
  const paid = balance(C)
  const third = eat(C, 'ng.puffpuff', cafe)
  assert.equal(third.receipt!.nowRegular, true)
  assert.equal(balance(C), paid - TIERS.snack.price, 'the third visit is still at the list price')
  board = third.menu!
  assert.deepEqual([board.visits, board.regular], [3, true])
  assert.deepEqual(board.items.filter(item => item.usual).map(item => item.name), ['Puff-puff'], 'what C has here most')
  const charged = board.items.filter(item => item.price > 0)
  assert.ok(charged.length >= 3 && charged.every(item => item.price === regularPrice(item.listPrice) && item.price < item.listPrice), 'a regular pays a tenth less (the welcome meal is still free)')
  assert.deepEqual(third.state.usual, { place: 'Probe Café', dish: 'Puff-puff', emoji: '🍩', visits: 3 })
  pass(31 * MINUTE)
  const cheaper = balance(C)
  assert.equal(eat(C, 'ng.puffpuff', cafe).receipt!.charged, regularPrice(TIERS.snack.price))
  assert.equal(balance(C), cheaper - regularPrice(TIERS.snack.price), 'and is charged exactly that')
  assert.equal(needsSummary(world, C)!.usual!.place, 'Probe Café', 'the come-back track can name the place')
  enter(C, venue(yaba, KITCHEN))
  assert.equal(menu(C, kitchen).menu!.regular, false, 'being known at one place is not being known at another')
})

check('18 the come-back track can read a summary without changing anything', () => {
  const hunger = life(A).hunger.value
  world.flush()
  const before = JSON.stringify(stored)
  const summary = needsSummary(world, A)!
  assert.deepEqual(Object.keys(summary).sort(), ['energy', 'energyLevel', 'exhausted', 'headline', 'hunger', 'hungerLevel', 'hungry', 'hungryAt', 'hungrySince', 'lastMeal', 'mealtime', 'memberId', 'nextMealtime', 'onForm', 'usual'])
  assert.equal(summary.memberId, A)
  assert.equal(summary.hunger, hunger)
  assert.equal(summary.lastMeal!.name, 'Jollof rice and chicken')
  assert.deepEqual(summary.lastMeal!.with, ['Member B'])
  const starving = needsSummary(world, G)!
  assert.deepEqual([starving.hungry, starving.hungryAt, starving.hungerLevel], [true, null, 'critical'])
  world.flush()
  assert.equal(JSON.stringify(stored), before, 'reading a summary wrote nothing')
})

check('19 the slice survives a restart; the time the service was down counts as time away', () => {
  // A leaves before the restart; G is still connected when the service stops.
  world.disconnect(links[A]!)
  const kept = life(A), notices = notes(G, 'life.hungry').length
  world.flush()
  assert.ok(stored && 'life' in stored, 'the life slice is persisted')
  world = makeWorld(false)
  const back = life(A)
  for (const key of ['hunger', 'energy', 'pantry', 'firstMealFree', 'meals', 'tried', 'region', 'balance'] as const) assert.deepEqual(back[key], kept[key], `${key} survived`)
  assert.equal(back.pantry, 4)
  assert.deepEqual([back.together, back.day, back.usual], [kept.together, kept.day, kept.usual])
  assert.equal(life(C).usual!.visits, 4, 'the places that know a member survive too')
  assert.equal(notes(G, 'life.hungry').length, notices, 'notification history is intact')
  // Nobody is connected after a restart, so an hour of downtime is an hour asleep, not an hour of running about.
  const down = needsSummary(world, G)!
  now += HOUR
  const later = needsSummary(world, G)!
  assert.equal(later.hunger, Math.max(Math.min(down.hunger, LIFE.floor.awayHunger), down.hunger + LIFE.away.hunger))
  assert.equal(later.energy, Math.min(100, down.energy + LIFE.away.energy))
  world.flush()
})

check('20 idle and hidden tabs rest even with a socket open; passive reads do not wake them', () => {
  let clock = Date.UTC(2026, 9, 1, 8)
  const made = createWorld({ now: () => clock })
  const member = id('idle')
  ensureMember(made, member, 'Idle member')
  made.connect(member, () => {}, () => {})
  const read = () => made.call(member, 'life.state', {}).state
  const silent = (duration: number) => { clock += duration; made.tick() }
  read()
  // A single large interval must retain its first ten active minutes, then count away rest.
  silent(30 * MINUTE)
  let seen = read()
  assert.equal(seen.hunger.value, whole(35 + LIFE.online.hunger / 6 + LIFE.away.hunger / 3))
  assert.equal(seen.energy.value, 100)
  assert.equal(made.isOnline(member), true, 'the socket stayed open')
  silent(5 * HOUR)
  seen = read()
  assert.deepEqual([seen.hunger.value, seen.energy.value], [LIFE.floor.awayHunger, 100])
  assert.equal(made.call(member, 'notify.list', { includeRead: true }).notifications.filter(note => note.kind === 'life.exhausted').length, 0)
  assert.equal(made.call(member, 'notify.list', { includeRead: true }).notifications.filter(note => note.kind === 'life.hungry').length, 1)
  made.call(member, 'comeback.here', { visible: true, origin: null })
  for (let minute = 0; minute < 60; minute += 2) {
    made.call(member, 'comeback.here', { visible: true, origin: null })
    silent(2 * MINUTE)
  }
  assert.equal(read().energy.value, 80, 'visible beats keep active drain')
  made.call(member, 'comeback.here', { visible: false, origin: null })
  // Hidden background mutations and reads do not extend the last genuine activity deadline.
  for (let minute = 0; minute < 60; minute += 2) {
    made.call(member, 'member.completeOnboarding', {})
    read()
    silent(2 * MINUTE)
  }
  const mixedEnergy = 80 + LIFE.online.energy * (8 / 60) + LIFE.away.energy * (52 / 60)
  assert.equal(read().energy.value, whole(mixedEnergy))
  made.call(member, 'comeback.here', { visible: true, origin: null })
  const before = read().energy.value
  silent(3 * MINUTE)
  assert.equal(read().energy.value, whole(mixedEnergy + LIFE.online.energy * (3 / 60)))
  assert.ok(read().energy.value < before, 'showing the tab resumes active play')
  made.close()
})

console.log('verify-life: all checks passed')
