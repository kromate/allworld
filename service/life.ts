// Daily life: food and energy.
//
// The two meters are never stored per second. A member's record holds the values at one instant
// (`at`); everything after that is worked out from the clock and from how the time was spent:
//   away    – disconnected or no activity for ten minutes. Energy returns; hunger falls slowly.
//   online  – active in the world. Both meters run down slowly.
//   home    – standing in their own home. Hunger as online; energy comes back fast.
// A record is rewritten only when something happens (a meal, a shift, a level change, coming or
// going), so a thousand idle members cost a thousand comparisons a second and no disk writes.
// Coming home, leaving home and a shift closing are told to this module by the rooms and work
// modules at the moment they happen; only the slow drift across a level is found by looking.
//
// A member has needs from the first time they ask for them (the App does on arrival). Until then
// this module does nothing for them: no meters, no notifications, no change to what a shift pays.
//
// Nothing here blocks anything. Being hungry or exhausted loses the on-form bonus and slows the
// walk; it never closes chat, friends, games, work or travel.
import type { Iso, MemberId } from '../src/shared/ids.ts'
import { iso } from '../src/shared/ids.ts'
import {
  GROCERY_PORTIONS, LIFE, MEALTIMES, MEALTIME_WINDOWS, PROPER_MEAL, TIERS, dishById, foodRegionLabel, foodRegionOf, groceriesFor, homeDishesFor, labelOf, levelOf,
  mainMeter, mealtimeAt, placeKeyOf, regionDishes, regularPrice, venueKindOf, venueMenu,
} from '../src/shared/life.ts'
import type {
  DayView, Dish, FoodRegionId, FriendMood, LifeChanged, LifeEffects, LifeState, LifeSummary, MealRecord, Mealtime, Menu, MenuItem, NeedKey, NeedView, PlaceClaim,
  Receipt, Tier, VenueKind,
} from '../src/shared/life.ts'
import { WorldError } from '../src/shared/model.ts'
import type { RoomRef } from '../src/shared/model.ts'
import type { World } from './kernel.ts'
import { areFriends, exists, isBlockedEitherWay, publicMember, record } from './members.ts'
import { emit, settle as settleNotice } from './notify.ts'
import { empty, id, obj, str } from './parse.ts'
import { onRoomEnter, onRoomLeave, roomMates, roomOf } from './rooms.ts'
import { addPoints, careerPoints, setShiftClosedHook, spendPoints } from './work.ts'
import { activityUntil, onActivity } from './comeback.ts'

interface MemberLife {
  /** Values at `at`. Fractions are kept; clients and rules see whole numbers. */
  hunger: number
  energy: number
  at: number
  pantry: number
  firstMealUsed: boolean
  companyUntil: number | null
  tried: string[]
  /** Newest first. */
  meals: MealRecord[]
  /** Recent order ids, so a retried request is not charged again. */
  orders: string[]
  /** A "hungry" / "exhausted" notice has been sent and the meter has not recovered since. */
  hungry: boolean
  exhausted: boolean
  hungrySince: number | null
  /** When the member last disconnected and the energy they left with, for the welcome back. Null while connected. */
  left: { at: number; energy: number } | null
  /** What the places this member eats at remember of them, by district and place id. */
  places: Record<string, PlaceMemory>
  /** The meals of the day already eaten in their windows, for one local date. */
  day: { date: string; had: Mealtime[] }
  /** Meals eaten at the same table as another member. */
  together: number
}
interface PlaceMemory { name: string; visits: number; last: number; orders: Record<string, number> }
interface LifeSlice { members: Record<string, MemberLife> }

type Mode = 'away' | 'online' | 'home'
interface Seen {
  /** How the time since the record's `at` is being spent. */
  mode: Mode
  activeUntil: number
  bands: string
}
/** Someone who has just sat down to a proper meal in a room. */
interface Seat { memberId: MemberId; at: number; dishId: string; dish: { name: string; emoji: string } }
/** Not persisted: who is connected, what was last observed of them, and who is eating where. A restart begins with everyone away. */
interface Runtime { online: Set<MemberId>; seen: Map<MemberId, Seen>; tables: Map<string, Seat[]>; lastAwaySweep: number; lastCheckpoint: number }

const HOUR = 3_600_000
const MEALS_KEPT = 8, ORDERS_KEPT = 12, TRIED_KEPT = 400, PLACES_KEPT = 40
const AWAY_SWEEP_MS = 60_000
/** Connected members' records are written down this often, so a crash loses at most this much of how their time was spent. */
const CHECKPOINT_MS = 5 * 60_000
/** Shorter absences are not announced as a return. */
const WOKE_AFTER_MS = 30 * 60_000

const state = (world: World): LifeSlice => world.slice<LifeSlice>('life', () => ({ members: {} }))

/** A member's record, or nothing if they have no needs yet. Records written before places, mealtimes and tables existed are filled in. */
function recordOf(world: World, memberId: MemberId): MemberLife | undefined {
  const member = state(world).members[memberId]
  if (member && member.places === undefined) {
    member.places = {}
    member.day = { date: '', had: [] }
    member.together = 0
    member.meals = member.meals.map(meal => ({ ...meal, with: meal.with ?? [], mealtime: meal.mealtime ?? null }))
    delete (member as { shifts?: number }).shifts
  }
  return member
}
const runtimes = new WeakMap<World, Runtime>()
const runtime = (world: World): Runtime => {
  let found = runtimes.get(world)
  if (!found) { found = { online: new Set(), seen: new Map(), tables: new Map(), lastAwaySweep: 0, lastCheckpoint: 0 }; runtimes.set(world, found) }
  return found
}

const whole = (value: number): number => Math.round(Math.max(0, Math.min(100, value)))
const coins = (count: number): string => `${count} ${count === 1 ? 'coin' : 'coins'}`
const hungryKey = (memberId: MemberId): string => `life:hungry:${memberId}`
const exhaustedKey = (memberId: MemberId): string => `life:exhausted:${memberId}`

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

/** Where the meters stand at `now`, given how the time since the record was spent. Changes nothing. */
function project(member: Pick<MemberLife, 'hunger' | 'energy' | 'at'>, now: number, mode: Mode, activeUntil = Infinity): { hunger: number; energy: number } {
  if (mode !== 'away' && now > activeUntil) {
    const boundary = Math.max(member.at, activeUntil)
    const active = project(member, boundary, mode)
    return project({ ...active, at: boundary }, now, 'away')
  }
  const elapsed = Math.max(0, now - member.at)
  const hours = elapsed / HOUR
  // Time alone never takes a meter below its floor; a meter already below it stays where it is.
  const fall = (value: number, perHour: number, floor: number): number => (value > floor ? Math.max(floor, value + perHour * hours) : value)
  if (mode === 'away') return { hunger: fall(member.hunger, LIFE.away.hunger, LIFE.floor.awayHunger), energy: Math.min(100, member.energy + LIFE.away.energy * hours) }
  const hunger = fall(member.hunger, LIFE.online.hunger, LIFE.floor.hunger)
  if (mode === 'home') return { hunger, energy: Math.min(100, member.energy + (LIFE.restPerSecond * elapsed) / 1000) }
  return { hunger, energy: fall(member.energy, LIFE.online.energy, LIFE.floor.energy) }
}

function commit(member: MemberLife, now: number, mode: Mode, activeUntil = Infinity): void {
  const next = project(member, now, mode, activeUntil)
  member.hunger = next.hunger
  member.energy = next.energy
  member.at = now
}

function effectsOf(values: { hunger: number; energy: number }, member: MemberLife, now: number): LifeEffects {
  const hunger = whole(values.hunger), energy = whole(values.energy)
  const onForm = hunger >= LIFE.bands.good && energy >= LIFE.bands.good
  const company = member.companyUntil !== null && member.companyUntil > now
  const worn = hunger < LIFE.bands.low || energy < LIFE.bands.low
  return {
    onForm,
    shiftBonusPercent: onForm ? (company ? LIFE.company.percent : LIFE.onForm.percent) : 0,
    shiftBonusCap: company ? LIFE.company.cap : LIFE.onForm.cap,
    pace: worn ? LIFE.pace.worn : onForm ? LIFE.pace.onForm : LIFE.pace.normal,
    companyUntil: company ? iso(member.companyUntil!) : null,
  }
}

const bandsOf = (values: { hunger: number; energy: number }, member: MemberLife, now: number): string => {
  const effects = effectsOf(values, member, now)
  return [levelOf(whole(values.hunger)), levelOf(whole(values.energy)), effects.onForm ? 1 : 0, effects.companyUntil ? 1 : 0, whole(values.energy) >= 100 ? 1 : 0].join('|')
}

/** One sentence for a change of level, or nothing when the change is not worth a line. */
function changeNote(before: string, after: string, percent: number): string {
  const [hungerWas, energyWas, formWas, , fullWas] = before.split('|')
  const [hungerNow, energyNow, formNow, , fullNow] = after.split('|')
  if (hungerNow === 'critical' && hungerWas !== 'critical') return 'You are hungry. Find something to eat.'
  if (energyNow === 'critical' && energyWas !== 'critical') return 'You are exhausted. Rest at home or have a hot drink.'
  if (formNow === '1' && formWas !== '1') return `You are on form: finished shifts pay ${percent}% more.`
  if (fullNow === '1' && fullWas !== '1') return 'Fully rested.'
  if (hungerNow === 'low' && (hungerWas === 'ok' || hungerWas === 'good')) return 'You are getting peckish.'
  if (energyNow === 'low' && (energyWas === 'ok' || energyWas === 'good')) return 'You are getting tired.'
  return ''
}

// ── Records ───────────────────────────────────────────────────────────────────────────────────

const ownHome = (world: World, memberId: MemberId): boolean => {
  const room = roomOf(world, memberId)
  return room?.ref.kind === 'home' && room.ref.homeId === record(world, memberId).profile.homeId
}

function seenOf(world: World, memberId: MemberId, member: MemberLife, now: number): Seen {
  const rt = runtime(world)
  let seen = rt.seen.get(memberId)
  if (!seen) {
    seen = { mode: ownHome(world, memberId) ? 'home' : 'online', activeUntil: activityUntil(world, memberId), bands: bandsOf(member, member, now) }
    rt.seen.set(memberId, seen)
  }
  return seen
}

/** How the time since a member's record was written is being spent. */
function modeOf(world: World, memberId: MemberId, member: MemberLife, now: number): Mode {
  if (!runtime(world).online.has(memberId)) return 'away'
  const seen = seenOf(world, memberId, member, now)
  return now >= seen.activeUntil ? 'away' : seen.mode
}

function projectFor(world: World, memberId: MemberId, member: MemberLife, now: number): { hunger: number; energy: number } {
  if (!runtime(world).online.has(memberId)) return project(member, now, 'away')
  const seen = seenOf(world, memberId, member, now)
  return project(member, now, seen.mode, seen.activeUntil)
}

function commitFor(world: World, memberId: MemberId, member: MemberLife, now: number): void {
  const values = projectFor(world, memberId, member, now)
  member.hunger = values.hunger
  member.energy = values.energy
  member.at = now
}

function regionOf(world: World, memberId: MemberId): FoodRegionId {
  const { profile } = record(world, memberId)
  return foodRegionOf(profile.browsing?.countryCode ?? profile.currentArea?.countryCode)
}

const need = (key: NeedKey, value: number): NeedView => {
  const rounded = whole(value), level = levelOf(rounded)
  return { value: rounded, level, label: labelOf(key, level) }
}

// ── The day, by the local time of the place the avatar is in ──

const clocks = new Map<string, Intl.DateTimeFormat>()
function localClock(now: number, timezone: string): { date: string; minutes: number } {
  let clock = clocks.get(timezone)
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    clocks.set(timezone, clock)
  }
  const parts = clock.formatToParts(now)
  const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? '0'
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')) }
}

function timezoneOf(world: World, memberId: MemberId): string {
  const { profile } = record(world, memberId)
  const timezone = profile.browsing?.timezone ?? profile.currentArea?.timezone ?? 'UTC'
  try { localClock(0, timezone); return timezone } catch { return 'UTC' }
}

function dayOf(world: World, memberId: MemberId, member: MemberLife, now: number): DayView {
  const timezone = timezoneOf(world, memberId)
  const clock = localClock(now, timezone)
  const later = MEALTIMES.find(which => MEALTIME_WINDOWS[which].from > clock.minutes)
  // After the last window of the day the next one is tomorrow's breakfast.
  const wait = later ? MEALTIME_WINDOWS[later].from - clock.minutes : 1440 - clock.minutes + MEALTIME_WINDOWS.breakfast.from
  return {
    timezone, now: mealtimeAt(clock.minutes), had: member.day.date === clock.date ? [...member.day.had] : [],
    next: { which: later ?? 'breakfast', at: iso(now - (now % 60_000) + wait * 60_000) },
  }
}

/** Where the member is a regular, and what they have there most. The best-known place wins. */
function usualOf(member: MemberLife): LifeState['usual'] {
  let best: PlaceMemory | null = null
  for (const memory of Object.values(member.places)) if (memory.visits >= LIFE.regular.visits && (!best || memory.visits > best.visits)) best = memory
  const dish = best ? dishById(usualDish(best) ?? '') : null
  return best && dish ? { place: best.name, dish: dish.name, emoji: dish.emoji, visits: best.visits } : null
}
function usualDish(memory: PlaceMemory): string | null {
  let top: string | null = null
  for (const [dishId, count] of Object.entries(memory.orders)) if (top === null || count > memory.orders[top]!) top = dishId
  return top
}

function view(world: World, memberId: MemberId, member: MemberLife, now: number): LifeState {
  const mode = modeOf(world, memberId, member, now)
  const values = projectFor(world, memberId, member, now)
  const region = regionOf(world, memberId)
  const here = regionDishes(region)
  return {
    hunger: need('hunger', values.hunger), energy: need('energy', values.energy), effects: effectsOf(values, member, now),
    resting: mode === 'home' && whole(values.energy) < 100, pantry: member.pantry, balance: careerPoints(world, memberId),
    firstMealFree: !member.firstMealUsed, meals: member.meals.map(meal => ({ ...meal, with: [...meal.with] })), tried: [...member.tried],
    region: { id: region, label: foodRegionLabel(region), dishes: here.length, tried: here.filter(dish => member.tried.includes(dish.id)).length },
    day: dayOf(world, memberId, member, now), together: member.together, usual: usualOf(member),
    at: iso(now),
  }
}

function announce(world: World, memberId: MemberId, member: MemberLife, now: number, reason: LifeChanged['reason'], note: string, bonus = 0): void {
  if (world.isOnline(memberId)) world.push(memberId, { type: 'life.changed', state: view(world, memberId, member, now), reason, note, bonus })
}

/** Send "hungry" and "exhausted" once per crossing, and clear them when the meter has recovered. Call after a commit. */
function thresholds(world: World, memberId: MemberId, member: MemberLife, now: number): void {
  const hunger = whole(member.hunger), energy = whole(member.energy)
  if (hunger >= LIFE.bands.low) member.hungrySince = null
  if (hunger < LIFE.bands.low && !member.hungry) {
    member.hungry = true
    member.hungrySince = now
    emit(world, {
      to: memberId, category: 'events', kind: 'life.hungry', title: 'Your character is hungry', link: '/', dedupeKey: hungryKey(memberId),
      body: 'It has been a while since the last meal. Walk into a café or restaurant nearby, or have a plain meal at home: that one is free.',
    })
  } else if (member.hungry && hunger >= LIFE.bands.ok) {
    member.hungry = false
    settleNotice(world, memberId, hungryKey(memberId))
  }
  if (energy < LIFE.bands.low && !member.exhausted) {
    member.exhausted = true
    emit(world, {
      to: memberId, category: 'events', kind: 'life.exhausted', title: 'Your character is exhausted', link: '/home', dedupeKey: exhaustedKey(memberId),
      body: 'A minute at home brings energy back, and so does a hot drink. Time away from the game rests the character too.',
    })
  } else if (member.exhausted && energy >= LIFE.bands.ok) {
    member.exhausted = false
    settleNotice(world, memberId, exhaustedKey(memberId))
  }
}

/**
 * Notice a connected member drifting across a level (peckish to hungry, tired to exhausted, on
 * form or not). Runs every tick for connected members and before every operation. Everything
 * sudden — coming home, a shift closing, a meal — is handled where it happens.
 */
function observe(world: World, memberId: MemberId, member: MemberLife, now: number): void {
  if (!runtime(world).online.has(memberId)) return
  const seen = seenOf(world, memberId, member, now)
  const bands = bandsOf(project(member, now, seen.mode, seen.activeUntil), member, now)
  if (bands === seen.bands) return
  commit(member, now, seen.mode, seen.activeUntil)
  const note = changeNote(seen.bands, bands, effectsOf(member, member, now).shiftBonusPercent)
  seen.bands = bands
  thresholds(world, memberId, member, now)
  world.touch()
  announce(world, memberId, member, now, 'level', note)
}

/** The rooms module says a member walked into or out of a room. Only their own home matters here: that is where they rest. */
function roomChanged(world: World, memberId: MemberId, ref: RoomRef, now: number, entered: boolean): void {
  if (ref.kind !== 'home' || !runtime(world).online.has(memberId)) return
  const member = recordOf(world, memberId)
  if (!member || ref.homeId !== record(world, memberId).profile.homeId) return
  const seen = seenOf(world, memberId, member, now)
  // Up to this instant the member was outside (entering) or at home (leaving): exactly that, to the millisecond.
  commit(member, now, entered ? 'online' : 'home', seen.activeUntil)
  seen.mode = entered ? 'home' : 'online'
  seen.bands = bandsOf(member, member, now)
  thresholds(world, memberId, member, now)
  world.touch()
  announce(world, memberId, member, now, 'home', '')
}

/** The work module says a shift closed, with its pay already in the balance. A finished shift takes it out of you and, on form, pays a little more. */
function shiftClosed(world: World, memberId: MemberId, shift: { status: 'completed' | 'left-early' | 'timed-out'; points: number }): void {
  const member = recordOf(world, memberId)
  if (!member || shift.status !== 'completed') return
  const now = world.now()
  commitFor(world, memberId, member, now)
  const effects = effectsOf(member, member, now)
  let bonus = 0, note = ''
  if (effects.onForm && shift.points > 0) {
    bonus = Math.min(effects.shiftBonusCap, Math.max(1, Math.round((shift.points * effects.shiftBonusPercent) / 100)))
    addPoints(world, memberId, bonus, { kind: 'work', text: `On-form bonus · ${effects.shiftBonusPercent}% for being well fed and rested` })
    note = `On form: ${coins(bonus)} extra for that shift.`
  }
  const spend = (value: number, cost: number, floor: number): number => (value > floor ? Math.max(floor, value + cost) : value)
  member.hunger = spend(member.hunger, LIFE.shift.hunger, LIFE.floor.hunger)
  member.energy = spend(member.energy, LIFE.shift.energy, LIFE.floor.energy)
  const seen = runtime(world).seen.get(memberId)
  if (seen) {
    const bands = bandsOf(member, member, now)
    note ||= changeNote(seen.bands, bands, effects.shiftBonusPercent)
    seen.bands = bands
  }
  thresholds(world, memberId, member, now)
  world.touch()
  announce(world, memberId, member, now, 'shift', note, bonus)
}

let hooked = false
/** The rooms and work modules keep one list of listeners for the whole process, so this is done once, whichever world asks first. */
function hook(): void {
  if (hooked) return
  hooked = true
  onRoomEnter((world, memberId, ref, now) => roomChanged(world, memberId, ref, now, true))
  onRoomLeave((world, memberId, ref, now) => roomChanged(world, memberId, ref, now, false))
  onActivity((world, memberId, now, until) => {
    if (!runtime(world).online.has(memberId)) return
    const member = recordOf(world, memberId)
    if (!member) return
    const seen = seenOf(world, memberId, member, now)
    if (now >= seen.activeUntil) {
      commit(member, now, seen.mode, seen.activeUntil)
      thresholds(world, memberId, member, now)
      seen.bands = bandsOf(member, member, now)
      world.touch()
    }
    seen.activeUntil = until
  })
  setShiftClosedHook(shiftClosed)
}

/** The member's record, created on first use and brought up to date. */
function current(world: World, memberId: MemberId, now: number): MemberLife {
  let member = recordOf(world, memberId)
  if (!member) {
    member = {
      hunger: LIFE.start.hunger, energy: LIFE.start.energy, at: now, pantry: 0, firstMealUsed: false,
      companyUntil: null, tried: [], meals: [], orders: [], hungry: false, exhausted: false, hungrySince: null, left: null,
      places: {}, day: { date: '', had: [] }, together: 0,
    }
    state(world).members[memberId] = member
    world.touch()
  }
  observe(world, memberId, member, now)
  // An operation from a member who is not connected (a check script) still sees time pass.
  if (!runtime(world).online.has(memberId) && now > member.at) { commit(member, now, 'away'); thresholds(world, memberId, member, now) }
  return member
}

/** After an operation changed the meters: remember the new level so the next tick does not announce it again. */
function settled(world: World, memberId: MemberId, member: MemberLife, now: number): void {
  thresholds(world, memberId, member, now)
  const seen = runtime(world).seen.get(memberId)
  if (seen) seen.bands = bandsOf(member, member, now)
  world.touch()
}

// ── Menus ─────────────────────────────────────────────────────────────────────────────────────

type Spot = { where: 'venue' | 'grocery' | 'home'; kind: VenueKind | 'home'; title: string; key: string | null }

/** Where the member is standing, as the rooms module has it. The place's category comes from the App's map data. */
function locate(world: World, memberId: MemberId, place: PlaceClaim | null): Spot | { where: null; reason: string } {
  const room = roomOf(world, memberId)
  if (!room) return { where: null, reason: 'You are not standing anywhere in the world right now. Step into a street first.' }
  if (room.ref.kind === 'home') {
    return room.ref.homeId === record(world, memberId).profile.homeId
      ? { where: 'home', kind: 'home', title: 'Your kitchen', key: null }
      : { where: null, reason: 'This is someone else’s home. You cook and rest in your own.' }
  }
  if (room.ref.kind === 'district') return { where: null, reason: 'You are out on the street. Walk into a café, restaurant, bakery or food shop to see what it serves.' }
  if (room.ref.kind !== 'venue') return { where: null, reason: 'There is nothing to eat at a game table. Head to a café or restaurant.' }
  const kind = place ? venueKindOf(place.category, place.subclass) : null
  const title = place?.name || 'This place'
  if (!kind) return { where: null, reason: `${title} does not serve food. Look for a café, restaurant, bakery or food shop.` }
  return { where: kind === 'grocery' ? 'grocery' : 'venue', kind, title, key: placeKeyOf(room.ref.districtId, room.ref.placeId) }
}

const WELCOME_TIERS: Tier[] = ['feast', 'meal', 'light']

/** Which meters a tier is eaten for. An item is refused, free of charge, when all of them are already full. */
const eatenFor = (dish: Dish): NeedKey[] => (dish.tier === 'coffee' ? ['energy'] : dish.tier === 'drink' || dish.tier === 'sweet' ? ['hunger', 'energy'] : ['hunger'])

interface OfferTerms { balance: number; onTheHouse: boolean; regular: boolean; usualId: string | null; specialId: string | null }

function offer(dish: Dish, member: MemberLife, terms: OfferTerms): MenuItem {
  const tier = TIERS[dish.tier]
  const hunger = whole(member.hunger), energy = whole(member.energy)
  // The welcome is a proper meal, not a biscuit: snacks, drinks and groceries are never the free one.
  const price = terms.onTheHouse && WELCOME_TIERS.includes(dish.tier) ? 0 : terms.regular ? regularPrice(tier.price) : tier.price
  const special = dish.id === terms.specialId
  const extra = special ? LIFE.special : 0
  let why = '', short = 0
  if (dish.tier === 'groceries') {
    if (member.pantry + GROCERY_PORTIONS > LIFE.pantryMax) why = `Your kitchen is stocked: ${member.pantry} of ${LIFE.pantryMax} portions. Cook some at home first.`
  } else if (dish.tier === 'staple') {
    if (hunger >= LIFE.stapleCeiling) why = `A plain meal only helps below ${LIFE.stapleCeiling}. You are at ${hunger}.`
  } else if (dish.tier === 'home' && member.pantry < 1) {
    why = 'Your kitchen is empty. Buy groceries at a food shop or supermarket.'
  } else if (eatenFor(dish).every(key => (key === 'hunger' ? hunger : energy) >= LIFE.fullAt)) {
    why = dish.tier === 'coffee' ? 'You are wide awake already.' : 'You are full. Come back when you are hungry.'
  }
  if (!why && price > terms.balance) {
    short = price - terms.balance
    why = `You need ${short} more ${short === 1 ? 'coin' : 'coins'} for ${dish.name}. A work shift pays about 100.`
  }
  return {
    id: dish.id, name: dish.name, emoji: dish.emoji, about: dish.about, tier: dish.tier, price, listPrice: tier.price,
    hunger: tier.hunger + (mainMeter(dish.tier) === 'hunger' ? extra : 0), energy: tier.energy + (mainMeter(dish.tier) === 'energy' ? extra : 0),
    portions: dish.tier === 'groceries' ? GROCERY_PORTIONS : 0,
    isNew: dish.tier !== 'groceries' && !member.tried.includes(dish.id), usual: dish.id === terms.usualId, special, can: !why, why, short,
  }
}

/** Members eating a proper meal in the same room as `memberId` right now, as that member may see them. */
function seatsNear(world: World, memberId: MemberId, now: number): Seat[] {
  const rt = runtime(world)
  const room = roomOf(world, memberId)
  if (!room) return []
  const fresh = (rt.tables.get(room.key) ?? []).filter(seat => now - seat.at <= LIFE.tableMinutes * 60_000)
  if (fresh.length) rt.tables.set(room.key, fresh); else rt.tables.delete(room.key)
  const mates = new Set(roomMates(world, memberId))
  return fresh.filter(seat => seat.memberId !== memberId && mates.has(seat.memberId) && !isBlockedEitherWay(world, memberId, seat.memberId))
}

const nameOf = (world: World, memberId: MemberId): string => record(world, memberId).profile.displayName

function menuAt(world: World, memberId: MemberId, member: MemberLife, spot: Spot, now: number): Menu {
  const region = regionOf(world, memberId)
  const memory = spot.key ? member.places[spot.key] : undefined
  const regular = (memory?.visits ?? 0) >= LIFE.regular.visits
  let dishes: Dish[], specialId: string | null = null
  if (spot.where === 'home') { const home = homeDishesFor(region); dishes = [home.cooked, home.staple] }
  else if (spot.kind === 'grocery' || spot.kind === 'home') dishes = [groceriesFor(region)]
  else {
    const board = venueMenu(region, spot.kind, spot.key ?? '')
    specialId = board.specialId
    // A market has food stalls and sells the makings of a meal.
    dishes = spot.kind === 'market' ? [...board.dishes, groceriesFor(region)] : board.dishes
  }
  const terms: OfferTerms = {
    balance: careerPoints(world, memberId), onTheHouse: spot.where === 'venue' && !member.firstMealUsed, regular,
    usualId: regular && memory ? usualDish(memory) : null, specialId,
  }
  const day = dayOf(world, memberId, member, now)
  return {
    place: spot.where, kind: spot.kind, title: spot.title, regionLabel: foodRegionLabel(region), items: dishes.map(dish => offer(dish, member, terms)),
    visits: memory?.visits ?? 0, regular, mealtime: day.now && !day.had.includes(day.now) ? day.now : null,
    eating: seatsNear(world, memberId, now).map(seat => nameOf(world, seat.memberId)),
  }
}

/** Remember an order at a mapped place. Orders more than half an hour apart are separate visits. Returns true when this made the member a regular. */
function remember(member: MemberLife, spot: Spot, dishId: string, now: number): boolean {
  if (!spot.key) return false
  const memory = (member.places[spot.key] ??= { name: spot.title, visits: 0, last: 0, orders: {} })
  const before = memory.visits
  if (memory.visits === 0 || now - memory.last > LIFE.regular.visitGapMinutes * 60_000) memory.visits++
  memory.last = now
  memory.name = spot.title
  memory.orders[dishId] = (memory.orders[dishId] ?? 0) + 1
  const keys = Object.keys(member.places)
  if (keys.length > PLACES_KEPT) delete member.places[keys.reduce((oldest, key) => (member.places[key]!.last < member.places[oldest]!.last ? key : oldest))]
  return before < LIFE.regular.visits && memory.visits >= LIFE.regular.visits
}

/**
 * A member has sat down to a proper meal. Anyone already eating in the room is now eating with
 * them: each goes into the other's food diary and both have good company. Room mates who are not
 * eating are told once, so they can join. Nothing passes between members but the company.
 */
function sitDown(world: World, memberId: MemberId, member: MemberLife, meal: MealRecord, now: number): void {
  const rt = runtime(world)
  const room = roomOf(world, memberId)
  if (!room) return
  const mates = roomMates(world, memberId).filter(other => !isBlockedEitherWay(world, memberId, other))
  if (mates.length) member.companyUntil = now + LIFE.company.hours * HOUR
  const table = seatsNear(world, memberId, now)
  const mine = nameOf(world, memberId)
  for (const seat of table) {
    const other = recordOf(world, seat.memberId)
    // Their plate at this table: the meal they sat down to, not whatever they ordered after it.
    const theirs = other?.meals.find(entry => entry.dishId === seat.dishId && entry.at === iso(seat.at))
    if (!other || !theirs || theirs.with.includes(mine)) continue
    theirs.with.push(mine)
    meal.with.push(nameOf(world, seat.memberId))
    other.companyUntil = now + LIFE.company.hours * HOUR
    other.together++
    const seen = rt.seen.get(seat.memberId)
    if (seen) { commit(other, now, seen.mode, seen.activeUntil); seen.bands = bandsOf(other, other, now) }
    announce(world, seat.memberId, other, now, 'table', `${mine} sat down with ${meal.name}. You are eating together.`)
  }
  if (meal.with.length) member.together++
  const seats = rt.tables.get(room.key) ?? []
  const already = seats.some(seat => seat.memberId === memberId && now - seat.at <= LIFE.tableMinutes * 60_000)
  // Everyone else in the room hears about it once per sitting, not once per plate.
  if (!already) {
    const eating = new Set(table.map(seat => seat.memberId))
    for (const other of mates) if (!eating.has(other)) world.push(other, { type: 'life.table', from: { id: memberId, name: mine }, dish: { name: meal.name, emoji: meal.emoji }, at: iso(now) })
  }
  rt.tables.set(room.key, [...seats.filter(seat => seat.memberId !== memberId), { memberId, at: now, dishId: meal.dishId, dish: { name: meal.name, emoji: meal.emoji } }])
}

// ── For other modules ─────────────────────────────────────────────────────────────────────────

/**
 * A member's needs right now, for the come-back track ("your character is hungry"). Null when the
 * member has never had needs. Reads only: nothing is written and nobody is notified.
 */
export function needsSummary(world: World, memberId: MemberId): LifeSummary | null {
  const member = recordOf(world, memberId)
  if (!member || !exists(world, memberId)) return null
  const now = world.now()
  const mode = modeOf(world, memberId, member, now)
  const values = projectFor(world, memberId, member, now)
  const hunger = whole(values.hunger), energy = whole(values.energy)
  const hungry = hunger < LIFE.bands.low, exhausted = energy < LIFE.bands.low
  const effects = effectsOf(values, member, now)
  // Hungry is "rounds to less than 20", so the crossing is at 19.5.
  const edge = LIFE.bands.low - 0.5
  let hungryAt: Iso | null = null
  if (!hungry) {
    const until = mode === 'away' ? now : seenOf(world, memberId, member, now).activeUntil
    const activeHours = Math.max(0, until - now) / HOUR
    const activeCrossing = (values.hunger - edge) / -LIFE.online.hunger
    hungryAt = mode !== 'away' && activeCrossing <= activeHours
      ? iso(now + activeCrossing * HOUR)
      : iso(until + ((values.hunger + LIFE.online.hunger * activeHours - edge) / -LIFE.away.hunger) * HOUR)
  }
  const day = dayOf(world, memberId, member, now)
  const meal = day.now && !day.had.includes(day.now) ? `time for ${day.now}` : 'time for something to eat'
  const headline = hungry && !exhausted && energy >= LIFE.bands.good ? `Rested, and hungry: ${meal}.`
    : hungry ? `Hungry: ${meal}.`
    : exhausted ? 'Worn out: a minute at home will fix it.'
    : effects.onForm ? 'Well fed and rested: on form for work.'
    : 'Doing fine.'
  return {
    memberId, hunger, energy, hungerLevel: levelOf(hunger), energyLevel: levelOf(energy), hungry, exhausted, onForm: effects.onForm,
    hungrySince: hungry ? iso(member.hungrySince ?? now) : null, hungryAt, lastMeal: member.meals[0] ? { ...member.meals[0], with: [...member.meals[0].with] } : null,
    mealtime: day.now, nextMealtime: day.next, usual: usualOf(member), headline,
  }
}

/** What a member's needs are doing to them right now, for modules that pay or move the avatar. Null when they have no needs yet. */
export function lifeEffects(world: World, memberId: MemberId): LifeEffects | null {
  const member = recordOf(world, memberId)
  if (!member) return null
  const now = world.now()
  return effectsOf(projectFor(world, memberId, member, now), member, now)
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

function parsePlace(value: unknown): PlaceClaim | null {
  if (value === null || value === undefined) return null
  const raw = obj(value, 'place')
  const category = str(raw, 'category', { max: 40 }), subclass = str(raw, 'subclass', { max: 60 })
  if (!/^[a-z0-9_]*$/.test(category) || !/^[a-z0-9_]*$/.test(subclass)) throw new WorldError('invalid', 'place.category is not a map category')
  return { category, subclass, name: str(raw, 'name', { max: 80 }) }
}

function away(duration: number): string {
  const minutes = Math.round(duration / 60_000)
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

export function registerLife(world: World): void {
  const rt = runtime(world)
  hook()

  world.onConnect(memberId => {
    rt.online.add(memberId)
    rt.seen.delete(memberId)
    const member = recordOf(world, memberId)
    if (!member) return
    const now = world.now()
    // After a crash there is no record of leaving: the last time the record was written stands in.
    const gone = now - (member.left?.at ?? member.at)
    const energyWas = whole(member.left?.energy ?? member.energy)
    member.left = null
    // Whatever happened since the record was written, the member was not here for it.
    commit(member, now, 'away')
    thresholds(world, memberId, member, now)
    seenOf(world, memberId, member, now)
    world.touch()
    if (gone < WOKE_AFTER_MS) return
    const energy = whole(member.energy), hunger = levelOf(whole(member.hunger))
    const day = dayOf(world, memberId, member, now)
    const meal = day.now && !day.had.includes(day.now) ? `it is ${day.now} time` : 'time for something to eat'
    const parts = [`You were away ${away(gone)}.`]
    if (energy > energyWas) parts.push(energy >= 100 ? 'You slept well: energy is full.' : `You rested: energy is back to ${energy}.`)
    if (hunger === 'critical') parts.push(`You are hungry: ${meal}.`)
    else if (hunger === 'low') parts.push(day.now && !day.had.includes(day.now) ? `You are a little peckish, and it is ${day.now} time.` : 'You are a little peckish.')
    announce(world, memberId, member, now, 'woke', parts.join(' '))
  })

  world.onDisconnect(memberId => {
    const member = recordOf(world, memberId)
    if (member && rt.online.has(memberId)) {
      const now = world.now()
      // The rooms module has already walked the member out of their room, so this is ordinary time.
      commitFor(world, memberId, member, now)
      thresholds(world, memberId, member, now)
      member.left = { at: now, energy: member.energy }
      world.touch()
    }
    rt.online.delete(memberId)
    rt.seen.delete(memberId)
  })

  world.onTick(now => {
    const members = state(world).members
    for (const memberId of rt.online) {
      const member = recordOf(world, memberId)
      // One damaged record must not stop everyone else's meters.
      if (member) try { observe(world, memberId, member, now) } catch (error) { console.error(`[life] could not update ${memberId}`, error) }
    }
    if (now - rt.lastCheckpoint >= CHECKPOINT_MS || now < rt.lastCheckpoint) {
      rt.lastCheckpoint = now
      let wrote = false
      for (const memberId of rt.online) {
        const member = members[memberId]
        if (member && now > member.at) { commitFor(world, memberId, member, now); wrote = true }
      }
      if (wrote) world.touch()
    }
    if (now - rt.lastAwaySweep < AWAY_SWEEP_MS && now >= rt.lastAwaySweep) return
    rt.lastAwaySweep = now
    // Away, only one thing can happen worth telling someone: the character got hungry.
    for (const [key, member] of Object.entries(members)) {
      const memberId = key as MemberId
      if (member.hungry || rt.online.has(memberId)) continue
      if (whole(project(member, now, 'away').hunger) >= LIFE.bands.low) continue
      try { commit(member, now, 'away'); thresholds(world, memberId, member, now); world.touch() } catch (error) { console.error(`[life] could not update ${memberId}`, error) }
    }
  })

  world.register('life.state', empty, ctx => ({ state: view(world, ctx.memberId, current(world, ctx.memberId, ctx.now), ctx.now) }))

  world.register('life.menu', value => ({ place: parsePlace(obj(value).place) }), (ctx, input) => {
    const member = current(world, ctx.memberId, ctx.now)
    const spot = locate(world, ctx.memberId, input.place)
    const snapshot = view(world, ctx.memberId, member, ctx.now)
    if (spot.where === null) return { menu: null, reason: spot.reason, state: snapshot }
    // Offers are judged on the meters as they stand now, not as they were last written down.
    commitFor(world, ctx.memberId, member, ctx.now)
    return { menu: menuAt(world, ctx.memberId, member, spot, ctx.now), reason: '', state: snapshot }
  })

  world.register('life.eat', value => {
    const raw = obj(value)
    const orderId = str(raw, 'orderId', { min: 6, max: 40 })
    if (!/^[A-Za-z0-9_-]+$/.test(orderId)) throw new WorldError('invalid', 'orderId is not valid')
    return { itemId: str(raw, 'itemId', { min: 3, max: 40 }), orderId, place: parsePlace(raw.place) }
  }, (ctx, input) => {
    const memberId = ctx.memberId, now = ctx.now
    const member = current(world, memberId, now)
    const spot = locate(world, memberId, input.place)
    // The same order arriving twice (a retry after a dropped reply) is answered, not charged again.
    if (member.orders.includes(input.orderId)) {
      return { state: view(world, memberId, member, now), menu: spot.where === null ? null : menuAt(world, memberId, member, spot, now), receipt: null, repeated: true }
    }
    world.limit(`life-eat:${memberId}`, 10, 60_000)
    if (spot.where === null) throw new WorldError('conflict', spot.reason)
    commitFor(world, memberId, member, now)
    const board = menuAt(world, memberId, member, spot, now)
    const item = board.items.find(entry => entry.id === input.itemId)
    if (!item) throw new WorldError('not_found', 'That is not on the menu here.')
    if (!item.can) throw new WorldError('conflict', item.why)

    const from = { hunger: whole(member.hunger), energy: whole(member.energy), pantry: member.pantry }
    // Refuses the whole amount when the balance is short; nothing below runs in that case.
    spendPoints(world, memberId, item.price, { kind: 'food', text: `${item.tier === 'groceries' ? 'Groceries' : item.name} · ${spot.title}` })
    if (item.tier === 'groceries') member.pantry += GROCERY_PORTIONS
    else if (item.tier === 'staple') member.hunger = Math.min(LIFE.stapleCeiling, member.hunger + item.hunger)
    else {
      if (item.tier === 'home') member.pantry -= 1
      member.hunger = Math.min(100, member.hunger + item.hunger)
      member.energy = Math.min(100, member.energy + item.energy)
    }
    const onTheHouse = spot.where === 'venue' && !member.firstMealUsed && item.price === 0 && item.listPrice > 0
    if (onTheHouse) member.firstMealUsed = true
    const proper = PROPER_MEAL.includes(item.tier)
    // A proper meal in its own window of the day, once a day, picks you up a little more.
    const mealtime = proper ? board.mealtime : null
    if (mealtime) {
      const date = localClock(now, timezoneOf(world, memberId)).date
      member.day = { date, had: member.day.date === date ? [...member.day.had, mealtime] : [mealtime] }
      member.energy = Math.min(100, member.energy + LIFE.mealtimeEnergy)
    }
    const nowRegular = remember(member, spot, item.id, now)
    const newDish = item.tier !== 'groceries' && !member.tried.includes(item.id)
    if (newDish) { member.tried.push(item.id); if (member.tried.length > TRIED_KEPT) member.tried.shift() }
    const meal: MealRecord = {
      dishId: item.id, name: item.name, emoji: item.emoji, where: spot.where === 'home' ? 'Home' : spot.title, price: item.price, at: iso(now),
      shared: false, with: [], mealtime,
    }
    // A proper meal with someone else in the room is better than one alone, and better still when they are eating too.
    if (proper) {
      sitDown(world, memberId, member, meal, now)
      meal.shared = member.companyUntil === now + LIFE.company.hours * HOUR
    }
    member.meals.unshift(meal)
    if (member.meals.length > MEALS_KEPT) member.meals.length = MEALS_KEPT
    member.orders.push(input.orderId)
    if (member.orders.length > ORDERS_KEPT) member.orders.shift()
    settled(world, memberId, member, now)

    const receipt: Receipt = {
      name: item.name, emoji: item.emoji, charged: item.price, hunger: { from: from.hunger, to: whole(member.hunger) }, energy: { from: from.energy, to: whole(member.energy) },
      pantry: { from: from.pantry, to: member.pantry }, newDish, shared: meal.shared, onTheHouse, mealtime, with: [...meal.with], nowRegular,
    }
    return { state: view(world, memberId, member, now), menu: menuAt(world, memberId, member, spot, now), receipt, repeated: false }
  })

  world.register('life.peek', value => ({ memberId: id<MemberId>(obj(value), 'memberId', 'm') }), (ctx, input) => {
    // A blocked pair, or a member who does not exist, is "not found" either way.
    publicMember(world, ctx.memberId, input.memberId)
    if (input.memberId !== ctx.memberId && !areFriends(world, ctx.memberId, input.memberId)) throw new WorldError('forbidden', 'Only friends can see how someone is doing.')
    const member = recordOf(world, input.memberId)
    if (!member) return { mood: null }
    const values = projectFor(world, input.memberId, member, ctx.now)
    const hunger = levelOf(whole(values.hunger)), energy = levelOf(whole(values.energy))
    const mood: FriendMood = { hunger, hungerLabel: labelOf('hunger', hunger), energy, energyLabel: labelOf('energy', energy), onForm: effectsOf(values, member, ctx.now).onForm }
    return { mood }
  })
}
