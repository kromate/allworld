// Daily-life state shared by the HUD meters and the eat/rest prompts. The service owns every
// number here: this module asks, listens, and shows. It never moves a meter or a coin itself.
import { reactive } from 'vue'
import { distance } from '../shared/geo.ts'
import type { Vec2 } from '../shared/geo.ts'
import { randomToken } from '../shared/ids.ts'
import { placeKeyOf, servesMeals, venueKindOf, venueMenu } from '../shared/life.ts'
import type { Dish, LifeState, Menu, PlaceClaim, Receipt, TableInvite, VenueKind } from '../shared/life.ts'
import { WorldError } from '../shared/model.ts'
import type { Poi } from '../geo/district.ts'
import { api, app, messageOf, onAccountReset, onReconnect, onServerEvent, refreshPoints, toast } from './app.ts'
import { getEngine, world } from './world.ts'

export const life = reactive({
  state: null as LifeState | null,
  loaded: false,
  /** Why the meters could not be read, in a sentence. Empty when they could. */
  error: '',
  /** The last thing the service said about a change, for example a return after time away. */
  note: '',
  noteAt: 0,
  /** What the last finished shift did: the on-form bonus it paid (0 when not on form), stamped with the service's time. */
  shift: null as { bonus: number; at: number } | null,
  /** Someone in the room has sat down to eat, and when this tab heard about it. */
  table: null as (TableInvite & { heardAt: number }) | null,
  /** An order sent from this room whose answer never came: the service may or may not have taken it. */
  unanswered: null as { itemId: string; room: string | null; orderId: string } | null,
})

/** The engine may or may not support a walking pace yet. Nothing is claimed in the UI unless it does. */
interface Paced { setPace?: (multiplier: number) => void }
export const paceSupported = (): boolean => typeof (getEngine() as unknown as Paced | null)?.setPace === 'function'

/** Counts account resets. An answer to a question asked before one belongs to the member who left: it is dropped. */
let generation = 0
/** Counts states put on screen. A failure that finds a newer state than the one it asked beside has nothing to add. */
let shown = 0
const changed = (): WorldError => new WorldError('unauthorized', 'The current character changed.')

function apply(state: LifeState): void {
  shown++
  life.state = state
  life.loaded = true
  life.error = ''
  ;(getEngine() as unknown as Paced | null)?.setPace?.(state.effects.pace)
}

export async function loadLife(): Promise<void> {
  const asked = generation, seen = shown
  try {
    const result = await api('life.state', {})
    if (asked === generation) apply(result.state)
  } catch (error) {
    if (asked !== generation) return
    if (shown === seen) life.error = messageOf(error)
    life.loaded = true
  }
}

/** What the map says about the venue the member is standing in. The service decides what that means. */
export function placeClaim(): PlaceClaim | null {
  const venue = world.kind === 'venue' ? world.venue : null
  return venue ? { category: venue.category, subclass: venue.subclass, name: venue.name } : null
}

export async function loadMenu(): Promise<{ menu: Menu | null; reason: string }> {
  const asked = generation
  const result = await api('life.menu', { place: placeClaim() })
  if (asked !== generation) throw changed()
  apply(result.state)
  return { menu: result.menu, reason: result.reason }
}

/**
 * Order one item where the member stands. Throws the service's reason when it is refused.
 * How the avatar shows it is the caller's to decide: it knows whether the member is seated.
 *
 * The service charges an order id once. When no answer comes back the order is in doubt, so choosing
 * the same item again in the same room sends the same id: it is taken if it was not, and `repeated`
 * says so if it already was. A refusal is an answer: nothing was taken, and the next choice is new.
 */
export async function orderItem(itemId: string): Promise<{ menu: Menu | null; receipt: Receipt | null; repeated: boolean }> {
  const room = world.roomKey, asked = generation
  const waiting = life.unanswered
  const orderId = waiting && waiting.itemId === itemId && waiting.room === room ? waiting.orderId : `o-${randomToken(14)}`
  try {
    const result = await api('life.eat', { itemId, orderId, place: placeClaim() })
    // The order was the previous member's: what it did is theirs to see, not this one's.
    if (asked !== generation) throw changed()
    if (life.unanswered?.orderId === orderId) life.unanswered = null
    apply(result.state)
    void refreshPoints()
    return { menu: result.menu, receipt: result.receipt, repeated: result.repeated }
  } catch (error) {
    if (asked !== generation) throw error
    if (error instanceof WorldError && error.code === 'unavailable') life.unanswered = { itemId, room, orderId }
    else if (life.unanswered?.orderId === orderId) life.unanswered = null
    throw error
  }
}

export interface FoodPlace {
  poi: Poi; kind: VenueKind; meals: boolean
  /** Walking metres along the streets when `routed`; a straight line otherwise. */
  metres: number
  routed: boolean
  /** False when a walking route was looked for and there is none from here. */
  reachable: boolean
}

/** Food this close is worth more than a better meal far away. */
export const FOOD_NEAR_METRES = 400
/** Route searches per look: the nearest few of each sort by straight line. Everything else keeps its straight-line distance. */
const ROUTE_SHORTLIST = { meals: 4, kiosk: 2, grocery: 1 } as const
/** A walking distance is kept until the member has moved this far: a few steps do not change which place is nearer. */
const ROUTE_REUSE_METRES = 12

const sortOf = (kind: VenueKind): keyof typeof ROUTE_SHORTLIST => (kind === 'grocery' ? 'grocery' : kind === 'kiosk' ? 'kiosk' : 'meals')
const routeMemo = new Map<string, { at: Vec2; metres: number | null }>()
let routeMemoRoom = ''

/** Walking metres to a place from where the member stands, or null when the engine finds no way there. It never starts a walk. */
function walkingMetres(poi: Poi, me: Vec2): number | null {
  const room = world.roomKey ?? ''
  if (routeMemoRoom !== room) { routeMemo.clear(); routeMemoRoom = room }
  const known = routeMemo.get(poi.placeId)
  if (known && distance(known.at, me) < ROUTE_REUSE_METRES) return known.metres
  const metres = getEngine()?.routeLength(poi.pos) ?? null
  routeMemo.set(poi.placeId, { at: me, metres })
  return metres
}

/**
 * Where to send someone who is hungry, best first: a proper meal within a short walk, then a snack
 * within a short walk, then a proper meal further off, a kiosk further off, and shops that only
 * stock the kitchen. Places not measured along the streets come after those that were, and places
 * with no walking route from here come last.
 */
const foodRank = (place: FoodPlace): number => {
  if (!place.reachable) return 6
  if (!place.routed) return 5
  if (place.kind === 'grocery') return 4
  const snack = place.kind === 'kiosk'
  return place.metres <= FOOD_NEAR_METRES ? (snack ? 1 : 0) : snack ? 3 : 2
}

/** Mapped places in this district that serve food or sell it, most useful first. Distances are to places, never to people. */
export function foodPlaces(limit = 5): FoodPlace[] {
  const me = getEngine()?.position
  if (!me || world.kind !== 'district') return []
  const found: FoodPlace[] = []
  for (const poi of world.places) {
    const kind = venueKindOf(poi.category, poi.subclass)
    if (kind) found.push({ poi, kind, metres: distance(poi.pos, me), routed: false, reachable: true, meals: servesMeals(poi.category, poi.subclass) })
  }
  found.sort((a, b) => a.metres - b.metres)
  const searched = { meals: 0, kiosk: 0, grocery: 0 }
  for (const place of found) {
    const sort = sortOf(place.kind)
    if (searched[sort] >= ROUTE_SHORTLIST[sort]) continue
    searched[sort]++
    const metres = walkingMetres(place.poi, me)
    place.routed = true
    if (metres === null) place.reachable = false
    else place.metres = metres
  }
  return found.sort((a, b) => foodRank(a) - foodRank(b) || a.metres - b.metres).slice(0, limit)
}

/** "about 120 m walk", "about 300 m in a straight line", "no walking route from here". */
export const walkWords = (place: FoodPlace): string =>
  (!place.reachable ? 'no walking route from here' : place.routed ? `${roughly(place.metres)}${place.metres < 15 ? '' : ' walk'}` : `${roughly(place.metres)} in a straight line`)

export interface DishLead { dish: Dish; place: FoodPlace }

/**
 * Dishes the member has not tried that a mapped place in this district would serve: one per place,
 * in the same order as the places to eat (a short measured walk first). What a place serves is the
 * same rule the service uses, so the lead is true when they get there.
 */
export function dishLeads(limit = 3): DishLead[] {
  const now = life.state
  if (!now) return []
  const leads: DishLead[] = []
  // Already in the order worth walking: measured and reachable first, nearest within each.
  for (const place of foodPlaces(24)) {
    if (place.kind === 'grocery' || !place.reachable) continue
    // Each place has its own board: ask for that one, not the regional list.
    const board = venueMenu(now.region.id, place.kind, placeKeyOf(world.districtId ?? '', place.poi.placeId)).dishes
    const dish = board.find(entry => !now.tried.includes(entry.id) && !leads.some(lead => lead.dish.id === entry.id))
    if (dish) leads.push({ dish, place })
    if (leads.length >= limit) break
  }
  return leads
}

/** "about 120 m" — rounded so it reads as a walk, not a survey. */
export const roughly = (metres: number): string => (metres < 15 ? 'a few steps' : metres < 950 ? `about ${Math.round(metres / 10) * 10} m` : `about ${(metres / 1000).toFixed(1)} km`)

const stopEvents = onServerEvent(event => {
  if (event.type === 'life.table') { life.table = { from: event.from, dish: event.dish, at: event.at, heardAt: Date.now() }; return }
  if (event.type !== 'life.changed') return
  apply(event.state)
  if (event.reason === 'shift') life.shift = { bonus: event.bonus, at: Date.parse(event.state.at) }
  if (event.bonus > 0) void refreshPoints()
  if (!event.note) return
  life.note = event.note
  life.noteAt = Date.now()
  // Small shifts ("getting peckish") stay in the HUD; the ones worth interrupting for get a toast.
  if (event.reason === 'shift' || event.reason === 'table' || event.note.startsWith('You are on form') || event.note === 'Fully rested.') toast(event.note, 'good')
  else if (event.reason === 'woke' || event.state.hunger.level === 'critical' || event.state.energy.level === 'critical') toast(event.note, 'info')
})
const stopReconnect = onReconnect(() => { void loadLife() })
const stopReset = onAccountReset(() => { generation++; life.state = null; life.loaded = false; life.error = ''; life.note = ''; life.noteAt = 0; life.shift = null; life.table = null; life.unanswered = null })

// The meters move slowly; a look once a minute keeps them honest between pushes.
const poll = setInterval(() => { if (app.phase === 'ready' && life.loaded && app.link === 'online' && document.visibilityState === 'visible') void loadLife() }, 60_000)

// In development a hot update runs this module again: the old copy must stop listening, or every note would show twice.
if (import.meta.hot) import.meta.hot.dispose(() => { stopEvents(); stopReconnect(); stopReset(); clearInterval(poll) })
