// Daily life: the character has a body. Two meters — food and energy — move with real time, and
// the real places on the map are where they are looked after: a meal at a mapped café or
// restaurant, groceries from a mapped shop to cook at home, a rest in your own home.
//
// Everything here is a game. A menu is written for the region and the kind of place; it is not the
// real menu of the business on the map, nothing is ordered from it, and coins are play money.
// Owned by its track. Operations and events declared here are merged into the protocol.
import type { Iso, MemberId } from './ids.ts'

// ── The numbers ───────────────────────────────────────────────────────────────────────────────
// One source for the service (which applies them) and the App (which explains them).

export const LIFE = {
  /** A new character arrives rested and a little peckish, so the first meal is an early errand. */
  start: { hunger: 35, energy: 100 },
  /** Points per hour while the member is in the world. Full to hungry takes about 3 h 12 min. */
  online: { hunger: -25, energy: -20 },
  /** Points per hour while away. The character sleeps: energy comes back, hunger creeps down. */
  away: { hunger: -8, energy: 17 },
  /** Meters never fall below these from time alone. Nobody returns to a ruined character. */
  floor: { hunger: 10, energy: 10, awayHunger: 15 },
  /** At or above `good` both meters → on form. Below `low` → hungry or exhausted. */
  bands: { good: 60, ok: 40, low: 20 },
  /** What one finished work shift takes out of you. */
  shift: { hunger: -4, energy: -5 },
  /** Extra pay on a finished shift while on form, as a percentage of that shift, with a cap in coins. */
  onForm: { percent: 10, cap: 20 },
  /** A proper meal eaten with someone else in the room lifts the bonus for a while. */
  company: { percent: 15, cap: 30, hours: 2, minHunger: 30 },
  /** Energy per second while standing in your own home. Exhausted to full takes about 80 seconds. */
  restPerSecond: 1,
  pantryMax: 6,
  /** Walking pace multipliers the App applies to the avatar when the engine supports it. */
  pace: { worn: 0.85, normal: 1, onForm: 1.05 },
  /** The free plain meal at home only tops you up to here. */
  stapleCeiling: 40,
  /** A food is refused, free of charge, when its main meter is already this high. */
  fullAt: 95,
  /** A proper meal in its own window of the local day (once per window per day) gives this much extra energy. */
  mealtimeEnergy: 10,
  /** Each place has one house special: the same price, this much more of what it is eaten for. */
  special: 10,
  /** After this many visits a place knows you: your usual is remembered and everything is a little cheaper. */
  regular: { visits: 3, percentOff: 10, visitGapMinutes: 30 },
  /** Two proper meals in the same room within this many minutes are a meal eaten together. */
  tableMinutes: 10,
} as const

// ── The day ───────────────────────────────────────────────────────────────────────────────────
// Meals have their hours, by the local time of the place the avatar is in. Eating a proper meal
// in its window is a little better. Missing one costs nothing.

export const MEALTIMES = ['breakfast', 'lunch', 'dinner'] as const
export type Mealtime = (typeof MEALTIMES)[number]
/** Local minutes after midnight: from (inclusive) to (exclusive). */
export const MEALTIME_WINDOWS: Record<Mealtime, { from: number; to: number; label: string }> = {
  breakfast: { from: 6 * 60, to: 10 * 60 + 30, label: 'Breakfast' },
  lunch: { from: 12 * 60, to: 15 * 60, label: 'Lunch' },
  dinner: { from: 18 * 60, to: 22 * 60, label: 'Dinner' },
}
export const mealtimeAt = (localMinutes: number): Mealtime | null =>
  MEALTIMES.find(which => localMinutes >= MEALTIME_WINDOWS[which].from && localMinutes < MEALTIME_WINDOWS[which].to) ?? null
/** Tiers that count as a proper meal: for the welcome, for mealtimes and for eating together. */
export const PROPER_MEAL: readonly string[] = ['feast', 'meal', 'light', 'home']

export type NeedKey = 'hunger' | 'energy'
/** Both meters read like a battery: 100 is best. `critical` is hungry or exhausted. */
export type NeedLevel = 'good' | 'ok' | 'low' | 'critical'

export const levelOf = (value: number): NeedLevel =>
  value >= LIFE.bands.good ? 'good' : value >= LIFE.bands.ok ? 'ok' : value >= LIFE.bands.low ? 'low' : 'critical'

const LABELS: Record<NeedKey, Record<NeedLevel, string>> = {
  hunger: { good: 'Well fed', ok: 'Fine', low: 'Peckish', critical: 'Hungry' },
  energy: { good: 'Rested', ok: 'Fine', low: 'Tired', critical: 'Exhausted' },
}
export const labelOf = (key: NeedKey, level: NeedLevel): string => LABELS[key][level]

// ── Records ───────────────────────────────────────────────────────────────────────────────────

export interface NeedView {
  /** Whole number, 0–100. */
  value: number
  level: NeedLevel
  /** The level in words, for example "Peckish". Never rely on colour alone. */
  label: string
}

export interface LifeEffects {
  /** Both meters at 60 or more. */
  onForm: boolean
  /** Extra pay on the next finished shift, in percent of that shift. 0 when not on form. */
  shiftBonusPercent: number
  /** The most coins that bonus can be. */
  shiftBonusCap: number
  /** Walking pace multiplier: 0.85 when hungry or exhausted, 1.05 on form, otherwise 1. */
  pace: number
  /** A shared meal's good-company boost lasts until this time. */
  companyUntil: Iso | null
}

export interface MealRecord {
  dishId: string; name: string; emoji: string; where: string; price: number; at: Iso
  /** Someone else was in the room. */
  shared: boolean
  /** Display names of the members who ate a proper meal at the same table. */
  with: string[]
  /** The meal of the day this counted as, if it was eaten in its window. */
  mealtime: Mealtime | null
}

export interface DayView {
  timezone: string
  /** The meal whose window is open now, by local time. */
  now: Mealtime | null
  /** Meals of the day already eaten in their windows today. */
  had: Mealtime[]
  /** The next window to open. */
  next: { which: Mealtime; at: Iso }
}

export interface LifeState {
  hunger: NeedView
  energy: NeedView
  effects: LifeEffects
  /** True while the member stands in their own home and energy is coming back. */
  resting: boolean
  /** Home-cooked portions waiting in the kitchen. */
  pantry: number
  /** Coins, as the wallet has them now. Play money. */
  balance: number
  /** The first proper meal at a venue (not a snack or a drink) is on the house, and has not been had yet. */
  firstMealFree: boolean
  /** Newest first. */
  meals: MealRecord[]
  /** Ids of every dish tried, across all regions. */
  tried: string[]
  /** The cooking of the place the avatar is in. */
  region: { id: FoodRegionId; label: string; dishes: number; tried: number }
  /** Breakfast, lunch and dinner by the local time of the place the avatar is in. */
  day: DayView
  /** How many meals have been eaten together with another member. */
  together: number
  /** The place that knows this member best, once they are a regular somewhere. */
  usual: { place: string; dish: string; emoji: string; visits: number } | null
  /** When this was worked out. */
  at: Iso
}

export interface MenuItem {
  id: string
  name: string
  emoji: string
  about: string
  tier: Tier
  /** Coins charged now (0 when it is free). */
  price: number
  /** The usual price, shown struck through when this order is on the house. */
  listPrice: number
  /** What it restores before the cap at 100. */
  hunger: number
  energy: number
  /** Groceries only: portions added to the kitchen. */
  portions: number
  /** Not eaten before by this member. */
  isNew: boolean
  /** What this member orders most at this place. Only once they are a regular. */
  usual: boolean
  /** This place's house special: `hunger` or `energy` above already includes the extra. */
  special: boolean
  can: boolean
  /** Why not, when `can` is false. A plain sentence. */
  why: string
  /** Coins missing, when that is the reason. */
  short: number
}

export interface Menu {
  place: 'venue' | 'grocery' | 'home'
  kind: VenueKind | 'home'
  title: string
  regionLabel: string
  items: MenuItem[]
  /** Visits to this place so far, and whether that makes the member a regular (prices already show it). */
  visits: number
  regular: boolean
  /** The meal of the day a proper meal here would count as right now, if it has not been had today. */
  mealtime: Mealtime | null
  /** Display names of members eating a proper meal in this room right now. */
  eating: string[]
}

export interface Receipt {
  name: string
  emoji: string
  charged: number
  hunger: { from: number; to: number }
  energy: { from: number; to: number }
  pantry: { from: number; to: number }
  newDish: boolean
  shared: boolean
  onTheHouse: boolean
  /** The meal of the day this was, when eaten in its window for the first time today. */
  mealtime: Mealtime | null
  /** Who was eating at the same table. */
  with: string[]
  /** This order made the member a regular here. */
  nowRegular: boolean
}

/** What a friend may see: words, never numbers. */
export interface FriendMood { hunger: NeedLevel; hungerLabel: string; energy: NeedLevel; energyLabel: string; onForm: boolean }

/** For the come-back track: a member's needs right now, read on the service. */
export interface LifeSummary {
  memberId: MemberId
  hunger: number
  energy: number
  hungerLevel: NeedLevel
  energyLevel: NeedLevel
  hungry: boolean
  exhausted: boolean
  onForm: boolean
  /** When the character became hungry, if it is hungry now. */
  hungrySince: Iso | null
  /** When it will become hungry if nothing changes. Null when already hungry. */
  hungryAt: Iso | null
  lastMeal: MealRecord | null
  /** The meal whose window is open now where the avatar is, and the next one to open. */
  mealtime: Mealtime | null
  nextMealtime: { which: Mealtime; at: Iso }
  /** Where the member is a regular, and what they usually have there. */
  usual: { place: string; dish: string; emoji: string; visits: number } | null
  /** One sentence fit for a nudge, for example "Rested, and hungry: time for breakfast." */
  headline: string
}

/** Another member in the room has sat down to a proper meal. Sent to room mates who are not eating, and never past a block. */
export interface TableInvite { from: { id: MemberId; name: string }; dish: { name: string; emoji: string }; at: Iso }

/** What the App knows about the place the member is standing in. The category comes from map data. */
export interface PlaceClaim { category: string; subclass: string; name: string }

export interface LifeOps {
  /** The member's own needs. Nobody else's can be read with this. */
  'life.state': { in: Record<string, never>; out: { state: LifeState } }
  /** The menu where the member is standing: a food venue, a food shop, or their own kitchen. */
  'life.menu': { in: { place: PlaceClaim | null }; out: { menu: Menu | null; reason: string; state: LifeState } }
  /** Buy and eat (or stock the kitchen). `orderId` makes a retry safe: the same order is never charged twice. */
  'life.eat': { in: { itemId: string; orderId: string; place: PlaceClaim | null }; out: { state: LifeState; menu: Menu | null; receipt: Receipt | null; repeated: boolean } }
  /** How a friend is doing, in words. Refused for anyone who is not a friend. */
  'life.peek': { in: { memberId: MemberId }; out: { mood: FriendMood | null } }
}

/** Pushed when the needs change in a way worth showing: a level changed, a shift was paid, a return after time away. */
export type LifeEvent =
  | { type: 'life.changed'; state: LifeState; reason: 'level' | 'shift' | 'woke' | 'home' | 'table'; note: string; bonus: number }
  /** Someone in the room is eating: an opening to eat together. Nothing about the receiver changes. */
  | ({ type: 'life.table' } & TableInvite)
export type LifeChanged = Extract<LifeEvent, { type: 'life.changed' }>

// ── Places that serve food ────────────────────────────────────────────────────────────────────

export const FOOD_KINDS = ['restaurant', 'fast_food', 'cafe', 'bar', 'bakery', 'ice_cream'] as const
/**
 * Beyond the six kinds of eating place: a `market` has food stalls and sells groceries, a `kiosk`
 * (at a petrol station or a railway station) has snacks and drinks, a `grocery` only stocks the
 * kitchen. Many districts, in Nigeria especially, have a mapped market and no mapped café at all,
 * so these are what keep food within walking distance there.
 */
export type VenueKind = (typeof FOOD_KINDS)[number] | 'market' | 'kiosk' | 'grocery'
export type EatingKind = Exclude<VenueKind, 'grocery'>

export const KIND_LABEL: Record<VenueKind, string> = {
  restaurant: 'Restaurant', fast_food: 'Quick bites', cafe: 'Café', bar: 'Bar', bakery: 'Bakery', ice_cream: 'Ice cream',
  market: 'Market stalls', kiosk: 'Kiosk', grocery: 'Food shop',
}

const BY_SUBCLASS: Record<string, VenueKind> = {
  marketplace: 'market',
  restaurant: 'restaurant', fast_food: 'fast_food', food_court: 'fast_food', cafe: 'cafe', bar: 'bar', pub: 'bar', biergarten: 'bar',
  bakery: 'bakery', pastry: 'bakery', confectionery: 'bakery', ice_cream: 'ice_cream',
  supermarket: 'grocery', convenience: 'grocery', greengrocer: 'grocery', deli: 'grocery', delicatessen: 'grocery',
  butcher: 'grocery', seafood: 'grocery', general: 'grocery', farm: 'grocery', kiosk: 'kiosk', mall: 'fast_food',
  hotel: 'restaurant', guest_house: 'restaurant', hostel: 'cafe', motel: 'restaurant',
}
const BY_CATEGORY: Record<string, VenueKind> = {
  restaurant: 'restaurant', fast_food: 'fast_food', cafe: 'cafe', bar: 'bar', beer: 'bar', bakery: 'bakery', ice_cream: 'ice_cream', grocery: 'grocery',
  // A hotel has a dining room, a mall has a food court, and a filling station or a railway station has a kiosk.
  lodging: 'restaurant', fuel: 'kiosk', railway: 'kiosk',
}

/** What a mapped place serves, from its map category and subclass. Null when it is not a food place. */
export function venueKindOf(category: string, subclass = ''): VenueKind | null {
  if (subclass === 'marketplace') return 'market'
  return BY_CATEGORY[category] ?? BY_SUBCLASS[subclass] ?? null
}
/** Somewhere a meal can be eaten on the spot. */
export const servesMeals = (category: string, subclass = ''): boolean => {
  const kind = venueKindOf(category, subclass)
  return kind !== null && kind !== 'grocery'
}

// ── Food ──────────────────────────────────────────────────────────────────────────────────────
// Price and what a dish restores depend only on its tier, never on the region or the kind of
// place. So the names change from country to country and the economy does not.

export const TIERS = {
  feast: { price: 34, hunger: 75, energy: 5, label: 'Big meal' },
  meal: { price: 22, hunger: 50, energy: 5, label: 'Meal' },
  light: { price: 14, hunger: 30, energy: 0, label: 'Light meal' },
  snack: { price: 8, hunger: 15, energy: 0, label: 'Snack' },
  sweet: { price: 9, hunger: 12, energy: 8, label: 'Treat' },
  coffee: { price: 8, hunger: 4, energy: 20, label: 'Hot drink' },
  drink: { price: 6, hunger: 6, energy: 8, label: 'Cold drink' },
  /** Three portions for the kitchen at home. */
  groceries: { price: 30, hunger: 0, energy: 0, label: 'Groceries' },
  /** One portion cooked at home from groceries. */
  home: { price: 0, hunger: 45, energy: 5, label: 'Home cooking' },
  /** Always in the cupboard, always free, and only ever a top-up. */
  staple: { price: 0, hunger: 20, energy: 0, label: 'Plain meal' },
} as const
export type Tier = keyof typeof TIERS
export const GROCERY_PORTIONS = 3
const TIER_ORDER: Tier[] = ['feast', 'meal', 'light', 'snack', 'sweet', 'coffee', 'drink', 'groceries', 'home', 'staple']

export interface Dish { id: string; name: string; emoji: string; tier: Tier; about: string }

export const FOOD_REGIONS = ['ng', 'gh', 'wa', 'ea', 'sa', 'me', 'uk', 'eu', 'na', 'la', 'in', 'as', 'se', 'xx'] as const
export type FoodRegionId = (typeof FOOD_REGIONS)[number]

/** slug, name, emoji, tier, where it is served (r restaurant, f quick bites, c café, b bar, k bakery, i ice cream), about. */
type Row = readonly [string, string, string, Tier, string, string]
interface Cuisine {
  label: string
  countries: readonly string[]
  rows: readonly Row[]
  staple: readonly [string, string]
  home: readonly [string, string]
  groceries: readonly [string, string]
}

/** A market's stalls sell what the quick-bites places do. A kiosk is handled apart: snacks and drinks from anywhere. */
const KIND_LETTER: Record<EatingKind, string> = { restaurant: 'r', fast_food: 'f', cafe: 'c', bar: 'b', bakery: 'k', ice_cream: 'i', market: 'f', kiosk: '' }
const KIOSK_TIERS: Tier[] = ['snack', 'sweet', 'coffee', 'drink']

const CUISINES: Record<FoodRegionId, Cuisine> = {
  ng: {
    label: 'Nigeria', countries: ['NG'],
    rows: [
      ['amala', 'Amala, ewedu and gbegiri', '🍲', 'feast', 'r', 'Yam-flour swallow with two soups and assorted meat'],
      ['egusi', 'Pounded yam and egusi', '🥘', 'feast', 'r', 'Melon-seed soup with pounded yam'],
      ['jollof', 'Jollof rice and chicken', '🍛', 'meal', 'rf', 'Smoky party rice with fried chicken'],
      ['moimoi', 'Moi moi', '🫘', 'light', 'rc', 'Steamed bean pudding'],
      ['suya', 'Suya', '🍢', 'light', 'fb', 'Spiced beef skewers with onions and yaji'],
      ['akara', 'Akara and pap', '🧆', 'light', 'ck', 'Bean fritters with warm corn pap'],
      ['peppersoup', 'Goat pepper soup', '🌶️', 'light', 'b', 'Hot, peppery broth'],
      ['puffpuff', 'Puff-puff', '🍩', 'snack', 'fck', 'Soft fried dough, still warm'],
      ['meatpie', 'Meat pie', '🥟', 'snack', 'fk', 'Flaky pastry with minced beef and potato'],
      ['smallchops', 'Small chops', '🍡', 'snack', 'b', 'Samosa, spring roll and puff-puff on one plate'],
      ['agege', 'Agege bread and butter', '🍞', 'snack', 'k', 'Soft, sweet loaf'],
      ['icecream', 'Ice cream cup', '🍨', 'sweet', 'i', 'Two cold scoops'],
      ['froyo', 'Frozen yoghurt', '🍦', 'sweet', 'i', 'Tangy and cold'],
      ['tea', 'Milky tea', '🍵', 'coffee', 'ck', 'Hot, with milk and plenty of sugar'],
      ['chapman', 'Chapman', '🍹', 'drink', 'b', 'Fruity red mocktail with cucumber'],
      ['zobo', 'Zobo', '🥤', 'drink', 'rfcki', 'Chilled hibiscus with ginger'],
    ],
    staple: ['Garri and groundnuts', '🥣'], home: ['Home-cooked jollof', '🍛'], groceries: ['Rice, tomatoes and pepper', '🧺'],
  },
  gh: {
    label: 'Ghana', countries: ['GH'],
    rows: [
      ['banku', 'Banku and tilapia', '🐟', 'feast', 'r', 'Fermented corn dough with grilled fish and pepper'],
      ['fufu', 'Fufu and light soup', '🍲', 'feast', 'r', 'Pounded cassava and plantain in a peppery soup'],
      ['waakye', 'Waakye', '🍛', 'meal', 'rf', 'Rice and beans with shito, egg and gari'],
      ['redred', 'Red red', '🫘', 'meal', 'r', 'Bean stew with fried plantain'],
      ['chichinga', 'Chichinga', '🍢', 'light', 'fb', 'Spiced kebab skewers'],
      ['koko', 'Hausa koko and koose', '🥣', 'light', 'ck', 'Spiced millet porridge with bean fritters'],
      ['kelewele', 'Kelewele', '🍌', 'snack', 'fb', 'Spicy fried plantain cubes'],
      ['bofrot', 'Bofrot', '🍩', 'snack', 'ck', 'Round fried dough'],
      ['icecream', 'Ice cream cup', '🍨', 'sweet', 'i', 'Two cold scoops'],
      ['tea', 'Tea with milk', '🍵', 'coffee', 'ck', 'Hot and sweet'],
      ['sobolo', 'Sobolo', '🥤', 'drink', 'rfcbki', 'Chilled hibiscus with ginger and cloves'],
    ],
    staple: ['Gari soakings', '🥣'], home: ['Home-cooked waakye', '🍛'], groceries: ['Rice, beans and shito', '🧺'],
  },
  wa: {
    label: 'West Africa', countries: ['SN', 'CI', 'TG', 'BJ', 'ML', 'BF', 'GM', 'SL', 'LR', 'GN', 'GW', 'CV', 'NE', 'CM'],
    rows: [
      ['thieb', 'Thieboudienne', '🍛', 'feast', 'r', 'Fish and rice cooked in tomato with vegetables'],
      ['yassa', 'Chicken yassa', '🍗', 'meal', 'rf', 'Chicken in onion and lemon sauce'],
      ['attieke', 'Attiéké and grilled fish', '🐟', 'meal', 'rf', 'Cassava couscous with fish and pepper'],
      ['mafe', 'Mafé', '🥘', 'meal', 'r', 'Groundnut stew over rice'],
      ['brochettes', 'Brochettes', '🍢', 'light', 'fb', 'Grilled meat skewers'],
      ['alloco', 'Alloco', '🍌', 'snack', 'fb', 'Fried ripe plantain'],
      ['fataya', 'Fataya', '🥟', 'snack', 'kcf', 'Fried pastry with spiced filling'],
      ['beignets', 'Beignets', '🍩', 'sweet', 'kci', 'Sugared fried dough'],
      ['touba', 'Café Touba', '☕', 'coffee', 'ck', 'Coffee with selim pepper'],
      ['bissap', 'Bissap', '🥤', 'drink', 'rfcbki', 'Chilled hibiscus drink'],
    ],
    staple: ['Plain rice and pepper sauce', '🍚'], home: ['Home-cooked mafé', '🥘'], groceries: ['Rice, groundnut paste and onions', '🧺'],
  },
  ea: {
    label: 'East Africa', countries: ['KE', 'UG', 'TZ', 'RW', 'ET', 'BI', 'SS', 'SO'],
    rows: [
      ['nyamachoma', 'Nyama choma', '🍖', 'feast', 'rb', 'Roast meat with kachumbari'],
      ['ugali', 'Ugali and sukuma wiki', '🥬', 'meal', 'r', 'Maize meal with braised greens'],
      ['pilau', 'Pilau', '🍛', 'meal', 'rf', 'Spiced rice with beef'],
      ['chipsmayai', 'Chips mayai', '🍳', 'meal', 'f', 'Chips cooked into an omelette'],
      ['chapati', 'Chapati and beans', '🫓', 'light', 'rcf', 'Soft chapati with stewed beans'],
      ['rolex', 'Rolex', '🌯', 'light', 'f', 'Omelette rolled in a chapati'],
      ['mandazi', 'Mandazi', '🍩', 'snack', 'ck', 'Lightly sweet fried dough'],
      ['samosa', 'Samosa', '🥟', 'snack', 'fckb', 'Crisp and peppery'],
      ['icecream', 'Ice cream cup', '🍨', 'sweet', 'i', 'Two cold scoops'],
      ['chai', 'Masala chai', '🍵', 'coffee', 'ckr', 'Milky spiced tea'],
      ['passion', 'Passion juice', '🥤', 'drink', 'rfcbki', 'Fresh and sharp'],
    ],
    staple: ['Chai and bread', '🍞'], home: ['Home-cooked pilau', '🍛'], groceries: ['Maize flour, greens and beans', '🧺'],
  },
  sa: {
    label: 'Southern Africa', countries: ['ZA', 'BW', 'NA', 'LS', 'SZ', 'ZM', 'ZW', 'MZ', 'MW'],
    rows: [
      ['braai', 'Braai plate', '🍖', 'feast', 'rb', 'Grilled meat, pap and salad'],
      ['bunny', 'Bunny chow', '🍞', 'meal', 'fr', 'Curry in a hollowed-out loaf'],
      ['pap', 'Pap and chakalaka', '🥘', 'meal', 'r', 'Maize porridge with spicy relish'],
      ['bobotie', 'Bobotie', '🍛', 'meal', 'r', 'Spiced mince baked under egg'],
      ['boerie', 'Boerewors roll', '🌭', 'light', 'fb', 'Farm sausage in a roll'],
      ['vetkoek', 'Vetkoek', '🍩', 'snack', 'kfc', 'Fried dough, plain or filled'],
      ['biltong', 'Biltong', '🥓', 'snack', 'b', 'Dried cured meat'],
      ['koeksister', 'Koeksister', '🥨', 'sweet', 'kci', 'Plaited dough in syrup'],
      ['rooibos', 'Rooibos tea', '🍵', 'coffee', 'ckr', 'Red bush tea'],
      ['gingerbeer', 'Ginger beer', '🥤', 'drink', 'rfcbki', 'Home-style and soft'],
    ],
    staple: ['Pap and gravy', '🥣'], home: ['Home-cooked stew and pap', '🥘'], groceries: ['Maize meal, beans and tomatoes', '🧺'],
  },
  me: {
    label: 'North Africa and the Middle East', countries: ['EG', 'MA', 'DZ', 'TN', 'LY', 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'TR', 'IQ', 'SD'],
    rows: [
      ['tagine', 'Lamb tagine', '🍲', 'feast', 'r', 'Slow-cooked with prunes and almonds'],
      ['mezze', 'Mezze platter', '🧆', 'feast', 'rb', 'Small plates to share'],
      ['shawarma', 'Chicken shawarma', '🌯', 'meal', 'fr', 'Carved chicken with garlic sauce'],
      ['koshari', 'Koshari', '🍛', 'meal', 'rf', 'Rice, lentils and pasta with crispy onions'],
      ['falafel', 'Falafel wrap', '🥙', 'light', 'fc', 'Chickpea fritters with tahini'],
      ['manakish', 'Manakish', '🫓', 'light', 'kc', 'Flatbread with za’atar'],
      ['hummus', 'Hummus and bread', '🥣', 'snack', 'cbr', 'With olive oil'],
      ['baklava', 'Baklava', '🍯', 'sweet', 'kci', 'Pastry, nuts and syrup'],
      ['minttea', 'Mint tea', '🍵', 'coffee', 'ckrb', 'Poured from a height'],
      ['lemonmint', 'Lemon and mint', '🥤', 'drink', 'rfcbki', 'Crushed ice, fresh mint'],
    ],
    staple: ['Bread, olives and tea', '🫒'], home: ['Home-cooked lentils and rice', '🍛'], groceries: ['Lentils, rice and flatbread', '🧺'],
  },
  uk: {
    label: 'Britain and Ireland', countries: ['GB', 'IE'],
    rows: [
      ['fryup', 'Full breakfast', '🍳', 'feast', 'cr', 'Eggs, bacon, sausage, beans and toast'],
      ['roast', 'Sunday roast', '🍖', 'feast', 'rb', 'Roast meat, potatoes and gravy'],
      ['fishchips', 'Fish and chips', '🐟', 'meal', 'fr', 'Battered fish, salt and vinegar'],
      ['piemash', 'Pie and mash', '🥧', 'meal', 'rb', 'With gravy'],
      ['baconroll', 'Bacon roll', '🥓', 'light', 'ckf', 'Brown sauce or red'],
      ['jacket', 'Jacket potato and beans', '🥔', 'light', 'cr', 'A café staple'],
      ['sausageroll', 'Sausage roll', '🌭', 'snack', 'kcf', 'Warm from the oven'],
      ['chips', 'Chips and gravy', '🍟', 'snack', 'fb', 'A northern classic'],
      ['scone', 'Scone with jam', '🧁', 'sweet', 'ck', 'With a little cream'],
      ['cone', 'Ice cream cone', '🍦', 'sweet', 'i', 'Soft and cold'],
      ['tea', 'Cup of tea', '🍵', 'coffee', 'ckr', 'Milk, no fuss'],
      ['lemonade', 'Lemonade', '🥤', 'drink', 'rfcbki', 'Cloudy and cold'],
    ],
    staple: ['Beans on toast', '🍞'], home: ['Home-cooked shepherd’s pie', '🥧'], groceries: ['Mince, potatoes and veg', '🧺'],
  },
  eu: {
    label: 'Europe', countries: ['FR', 'ES', 'IT', 'DE', 'PT', 'NL', 'BE', 'AT', 'CH', 'SE', 'DK', 'NO', 'FI', 'PL', 'CZ', 'GR', 'HU', 'RO', 'IS', 'LU', 'SK', 'SI', 'EE', 'LV', 'LT', 'MT', 'HR', 'BG', 'RS', 'UA'],
    rows: [
      ['paella', 'Paella', '🥘', 'feast', 'r', 'Saffron rice from one wide pan'],
      ['schnitzel', 'Schnitzel and potatoes', '🍽', 'feast', 'r', 'Crisp, with lemon'],
      ['pizza', 'Margherita pizza', '🍕', 'meal', 'rf', 'Tomato, mozzarella, basil'],
      ['pasta', 'Pasta al pomodoro', '🍝', 'meal', 'r', 'Tomato and basil'],
      ['tapas', 'Tapas plate', '🫒', 'light', 'br', 'A few small plates'],
      ['baguette', 'Baguette sandwich', '🥖', 'light', 'kcf', 'Ham, butter, crust'],
      ['bratwurst', 'Bratwurst roll', '🌭', 'light', 'fb', 'With mustard'],
      ['croissant', 'Croissant', '🥐', 'snack', 'kc', 'Butter, flakes everywhere'],
      ['gelato', 'Gelato', '🍨', 'sweet', 'ic', 'Two flavours'],
      ['painchoc', 'Pain au chocolat', '🍫', 'sweet', 'k', 'Still warm'],
      ['espresso', 'Espresso', '☕', 'coffee', 'cbkr', 'Short and strong'],
      ['sparkling', 'Sparkling water with lemon', '🥤', 'drink', 'rfcbki', 'Cold, with a slice'],
    ],
    staple: ['Bread, cheese and an apple', '🧀'], home: ['Home-cooked pasta', '🍝'], groceries: ['Pasta, tomatoes and cheese', '🧺'],
  },
  na: {
    label: 'North America', countries: ['US', 'CA'],
    rows: [
      ['bbq', 'Barbecue plate', '🍖', 'feast', 'r', 'Brisket, slaw and pickles'],
      ['burger', 'Cheeseburger and fries', '🍔', 'meal', 'frb', 'With everything'],
      ['mac', 'Mac and cheese', '🧀', 'meal', 'r', 'Baked until it bubbles'],
      ['tacos', 'Breakfast tacos', '🌮', 'light', 'cf', 'Egg, potato and salsa'],
      ['bagel', 'Bagel with cream cheese', '🥯', 'light', 'ck', 'Toasted'],
      ['wings', 'Hot wings', '🍗', 'light', 'bf', 'With blue cheese dip'],
      ['slice', 'Slice of pizza', '🍕', 'snack', 'f', 'Folded, eaten standing'],
      ['doughnut', 'Glazed doughnut', '🍩', 'sweet', 'kc', 'Still sticky'],
      ['sundae', 'Sundae', '🍨', 'sweet', 'i', 'Hot fudge on top'],
      ['coffee', 'Drip coffee', '☕', 'coffee', 'ckr', 'Free refills in spirit'],
      ['icedtea', 'Iced tea', '🥤', 'drink', 'rfcbki', 'Sweet or not'],
    ],
    staple: ['Peanut butter sandwich', '🥪'], home: ['Home-cooked chili', '🥘'], groceries: ['Beans, mince and tortillas', '🧺'],
  },
  la: {
    label: 'Latin America', countries: ['BR', 'MX', 'AR', 'CO', 'CL', 'PE', 'UY', 'PY', 'BO', 'EC', 'VE', 'CR', 'PA', 'GT', 'DO', 'CU'],
    rows: [
      ['feijoada', 'Feijoada', '🍲', 'feast', 'r', 'Black beans and pork with rice'],
      ['churrasco', 'Churrasco plate', '🍖', 'feast', 'rb', 'Grilled meat, sliced at the table'],
      ['pf', 'Prato feito', '🍛', 'meal', 'r', 'Rice, beans, meat and salad'],
      ['pastor', 'Tacos al pastor', '🌮', 'meal', 'fr', 'Pork, pineapple, coriander'],
      ['arepa', 'Arepa', '🫓', 'light', 'fc', 'Corn cake, filled'],
      ['empanada', 'Empanada', '🥟', 'snack', 'fkcb', 'Baked or fried'],
      ['coxinha', 'Coxinha', '🍗', 'snack', 'fkb', 'Chicken croquette'],
      ['paoqueijo', 'Pão de queijo', '🧀', 'snack', 'ck', 'Warm cheese bread'],
      ['acai', 'Açaí bowl', '🍧', 'sweet', 'ic', 'With banana and granola'],
      ['brigadeiro', 'Brigadeiro', '🍫', 'sweet', 'k', 'Chocolate truffle'],
      ['cafezinho', 'Cafezinho', '☕', 'coffee', 'ckr', 'Small, sweet, strong'],
      ['limonada', 'Limonada', '🥤', 'drink', 'rfcbki', 'Lime, sugar, ice'],
    ],
    staple: ['Bread and coffee', '🍞'], home: ['Home-cooked rice and beans', '🍛'], groceries: ['Rice, black beans and eggs', '🧺'],
  },
  in: {
    label: 'South Asia', countries: ['IN', 'PK', 'BD', 'LK', 'NP'],
    rows: [
      ['thali', 'Thali', '🍱', 'feast', 'r', 'A full plate of small dishes'],
      ['biryani', 'Chicken biryani', '🍛', 'meal', 'rf', 'Layered spiced rice'],
      ['pavbhaji', 'Pav bhaji', '🥘', 'meal', 'fr', 'Buttery vegetable mash with rolls'],
      ['dosa', 'Masala dosa', '🫓', 'light', 'rc', 'Crisp rice crêpe with potato'],
      ['paneertikka', 'Paneer tikka', '🍢', 'light', 'br', 'Charred, with mint chutney'],
      ['vadapav', 'Vada pav', '🍔', 'snack', 'fk', 'Potato fritter in a bun'],
      ['samosa', 'Samosa', '🥟', 'snack', 'fckb', 'With tamarind chutney'],
      ['jalebi', 'Jalebi', '🥨', 'sweet', 'k', 'Hot spirals in syrup'],
      ['kulfi', 'Kulfi', '🍡', 'sweet', 'i', 'Dense, cardamom ice'],
      ['chai', 'Masala chai', '🍵', 'coffee', 'ckr', 'Cutting chai, very hot'],
      ['lassi', 'Sweet lassi', '🥛', 'drink', 'rfcbki', 'Cold yoghurt drink'],
    ],
    staple: ['Roti and pickle', '🫓'], home: ['Home-cooked dal and rice', '🍛'], groceries: ['Rice, lentils and spices', '🧺'],
  },
  as: {
    label: 'East Asia', countries: ['JP', 'KR', 'CN', 'TW', 'HK', 'MO', 'MN'],
    rows: [
      ['teishoku', 'Set meal', '🍱', 'feast', 'r', 'Rice, soup, fish and pickles'],
      ['ramen', 'Ramen', '🍜', 'meal', 'rf', 'Broth, noodles, soft egg'],
      ['curry', 'Curry rice', '🍛', 'meal', 'rf', 'Thick, mild and filling'],
      ['gyoza', 'Gyoza', '🥟', 'light', 'rbf', 'Pan-fried dumplings'],
      ['yakitori', 'Yakitori', '🍢', 'light', 'b', 'Chicken skewers over charcoal'],
      ['onigiri', 'Onigiri', '🍙', 'snack', 'kcf', 'Rice ball in seaweed'],
      ['edamame', 'Edamame', '🫛', 'snack', 'b', 'Salted, in the pod'],
      ['taiyaki', 'Taiyaki', '🐟', 'sweet', 'ki', 'Fish-shaped cake with red bean'],
      ['softserve', 'Matcha soft serve', '🍦', 'sweet', 'ic', 'Green and bitter-sweet'],
      ['greentea', 'Green tea', '🍵', 'coffee', 'ckr', 'Hot and grassy'],
      ['barleytea', 'Barley tea', '🥤', 'drink', 'rfcbki', 'Cold and toasty'],
    ],
    staple: ['Rice and miso soup', '🍚'], home: ['Home-cooked rice bowl', '🍚'], groceries: ['Rice, eggs and greens', '🧺'],
  },
  se: {
    label: 'Southeast Asia', countries: ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA', 'MM', 'BN'],
    rows: [
      ['nasilemak', 'Nasi lemak', '🍛', 'feast', 'r', 'Coconut rice, sambal, egg and chicken'],
      ['padthai', 'Pad thai', '🍜', 'meal', 'rf', 'Rice noodles, peanuts, lime'],
      ['pho', 'Pho', '🍲', 'meal', 'r', 'Beef noodle soup with herbs'],
      ['nasigoreng', 'Nasi goreng', '🍳', 'meal', 'rf', 'Fried rice with a fried egg'],
      ['satay', 'Satay', '🍢', 'light', 'fb', 'Skewers with peanut sauce'],
      ['banhmi', 'Banh mi', '🥖', 'light', 'kcf', 'Crisp roll, pickles, chilli'],
      ['springrolls', 'Spring rolls', '🥟', 'snack', 'fbc', 'With sweet chilli'],
      ['currypuff', 'Curry puff', '🥐', 'snack', 'k', 'Flaky and spiced'],
      ['mangorice', 'Mango sticky rice', '🥭', 'sweet', 'ic', 'With coconut cream'],
      ['icedcoffee', 'Iced coffee', '☕', 'coffee', 'ckr', 'With condensed milk'],
      ['limesoda', 'Lime soda', '🥤', 'drink', 'rfcbki', 'Salt or sugar'],
    ],
    staple: ['Rice and a fried egg', '🍳'], home: ['Home-cooked fried rice', '🍚'], groceries: ['Rice, eggs and chillies', '🧺'],
  },
  xx: {
    label: 'Everyday', countries: [],
    rows: [
      ['chicken', 'Grilled chicken plate', '🍗', 'feast', 'r', 'With rice and salad'],
      ['stew', 'Rice and stew', '🍛', 'meal', 'rf', 'A proper plate'],
      ['sandwich', 'Sandwich', '🥪', 'light', 'ckfb', 'Made to order'],
      ['soup', 'Soup and bread', '🍲', 'light', 'cr', 'Whatever is on today'],
      ['fries', 'Fries', '🍟', 'snack', 'fb', 'Hot and salted'],
      ['roll', 'Bread roll', '🍞', 'snack', 'k', 'Fresh this morning'],
      ['fruit', 'Fruit cup', '🍉', 'snack', 'ci', 'Cut fresh'],
      ['pastry', 'Pastry', '🥐', 'sweet', 'kc', 'From the counter'],
      ['icecream', 'Ice cream cup', '🍨', 'sweet', 'i', 'Two cold scoops'],
      ['coffee', 'Coffee', '☕', 'coffee', 'ckrb', 'A strong cup'],
      ['juice', 'Fruit juice', '🥤', 'drink', 'rfcbki', 'Cold'],
    ],
    staple: ['Bread and tea', '🍞'], home: ['Home-cooked rice and stew', '🍛'], groceries: ['Rice, vegetables and eggs', '🧺'],
  },
}

const COUNTRY_REGION = new Map<string, FoodRegionId>()
for (const region of FOOD_REGIONS) for (const code of CUISINES[region].countries) COUNTRY_REGION.set(code, region)

/** The cooking of a country. Unknown countries get the everyday menu. */
export const foodRegionOf = (countryCode: string | null | undefined): FoodRegionId => COUNTRY_REGION.get((countryCode ?? '').toUpperCase()) ?? 'xx'
export const foodRegionLabel = (region: FoodRegionId): string => CUISINES[region].label

const dishOf = (region: FoodRegionId, row: Row): Dish => ({ id: `${region}.${row[0]}`, name: row[1], emoji: row[2], tier: row[3], about: row[5] })
const rank = (tier: Tier): number => TIER_ORDER.indexOf(tier)

/** Up to six dishes for one kind of place in one region, topped up from the everyday menu when the region has few. */
export function dishesFor(region: FoodRegionId, kind: EatingKind): Dish[] {
  const letter = KIND_LETTER[kind]
  if (kind === 'kiosk') {
    // One of each: something to chew, something sweet, something hot, something cold.
    const rows = CUISINES[region].rows
    return KIOSK_TIERS.flatMap(tier => { const row = rows.find(entry => entry[3] === tier) ?? CUISINES.xx.rows.find(entry => entry[3] === tier); return row ? [dishOf(rows.includes(row) ? region : 'xx', row)] : [] })
  }
  const own = CUISINES[region].rows.filter(row => row[4].includes(letter)).map(row => dishOf(region, row))
  const pool = [...own]
  if (own.length < 4 && region !== 'xx') {
    for (const row of CUISINES.xx.rows) {
      if (pool.length >= 5) break
      if (row[4].includes(letter) && !pool.some(dish => dish.tier === row[3])) pool.push(dishOf('xx', row))
    }
  }
  // One of each tier first, then seconds, so a long list keeps its variety when it is cut to six.
  const picked: Dish[] = []
  for (let round = 0; picked.length < 6 && round < 3; round++) {
    for (const tier of TIER_ORDER) {
      const next = pool.filter(dish => dish.tier === tier)[round]
      if (next && picked.length < 6) picked.push(next)
    }
  }
  return picked.sort((a, b) => rank(a.tier) - rank(b.tier))
}

export function groceriesFor(region: FoodRegionId): Dish {
  const [name, emoji] = CUISINES[region].groceries
  return { id: `${region}.groceries`, name, emoji, tier: 'groceries', about: `Enough to cook ${GROCERY_PORTIONS} meals at home` }
}
export function homeDishesFor(region: FoodRegionId): { cooked: Dish; staple: Dish } {
  const cuisine = CUISINES[region]
  return {
    cooked: { id: `${region}.home`, name: cuisine.home[0], emoji: cuisine.home[1], tier: 'home', about: 'One portion from your kitchen' },
    staple: { id: `${region}.staple`, name: cuisine.staple[0], emoji: cuisine.staple[1], tier: 'staple', about: `Always in the cupboard. Tops you up to ${LIFE.stapleCeiling}` },
  }
}

/** Every dish a member can collect in a region: what its venues serve, plus the two eaten at home. */
export function regionDishes(region: FoodRegionId): Dish[] {
  const home = homeDishesFor(region)
  return [...CUISINES[region].rows.map(row => dishOf(region, row)), home.cooked, home.staple]
}

/** Look a dish up by id, in any region. */
export function dishById(id: string): Dish | null {
  const region = id.split('.')[0] as FoodRegionId
  if (!FOOD_REGIONS.includes(region)) return null
  return regionDishes(region).find(dish => dish.id === id) ?? (groceriesFor(region).id === id ? groceriesFor(region) : null)
}

// ── One place, one menu ───────────────────────────────────────────────────────────────────────
// Two cafés in the same street are not the same café. Each mapped place leaves one dish off the
// regional list and has one house special, both fixed by the place's id, so everyone who walks in
// sees the same board and it is still there tomorrow.

/** A stable number for a place, from its district and place id (FNV-1a). */
export function placeSeed(placeKey: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < placeKey.length; index++) { hash ^= placeKey.charCodeAt(index); hash = Math.imul(hash, 0x01000193) }
  return hash >>> 0
}
export const placeKeyOf = (districtId: string, placeId: string): string => `${districtId}|${placeId}`

/** What one particular place serves, and which dish is its special. */
export function venueMenu(region: FoodRegionId, kind: EatingKind, placeKey: string): { dishes: Dish[]; specialId: string | null } {
  const seed = placeSeed(placeKey)
  let dishes = kind === 'market' ? dishesFor(region, 'market').slice(0, 4) : dishesFor(region, kind)
  if (dishes.length >= 5) {
    // Leave one off: by preference one of two dishes of the same size, so every place keeps its range.
    const twins = dishes.filter(dish => dishes.some(other => other !== dish && other.tier === dish.tier))
    const candidates = twins.length ? twins : dishes.slice(1, -1)
    const dropped = candidates[seed % candidates.length]
    dishes = dishes.filter(dish => dish !== dropped)
  }
  const special = dishes.length ? dishes[(seed >>> 8) % dishes.length]! : null
  return { dishes, specialId: special?.id ?? null }
}

/** The meter a tier is mostly eaten for: where a house special's extra goes. */
export const mainMeter = (tier: Tier): NeedKey => (TIERS[tier].energy > TIERS[tier].hunger ? 'energy' : 'hunger')
/** A regular's price. */
export const regularPrice = (price: number): number => Math.round(price * (1 - LIFE.regular.percentOff / 100))
