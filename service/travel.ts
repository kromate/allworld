// Travel, documents and the play-money wallet.
//
// The avatar is in one place. Another city costs a fare; another country needs a passport and,
// outside visa-free blocs, a visa. Everything is paid in coins (the work module's game points).
// This module is the only thing that moves an avatar between metros or takes coins from a member:
// it vets every area change (members.ts) and every street room (rooms.ts), re-checks each booking
// from scratch, and settles time-based work both on tick and before any read or decision, so the
// outcome never depends on which of the two happens first.
import tzlookup from 'tz-lookup'
import type { Iso, MemberId } from '../src/shared/ids.ts'
import { iso, ms, randomToken } from '../src/shared/ids.ts'
import { parseDistrictId, tileToLatLon } from '../src/shared/geo.ts'
import type { LatLon } from '../src/shared/geo.ts'
import { WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode, RoomRef } from '../src/shared/model.ts'
import { TRAVEL, distanceKm, tripTerms, visaFreeBetween, visaTerms } from '../src/shared/travel.ts'
import type { LedgerEntry, LedgerKind, Passport, TravelMode, TravelQuote, TravelRequirement, TravelState, Trip, Visa } from '../src/shared/travel.ts'
import type { World } from './kernel.ts'
import { exists, parseCoarseArea, record, setAreaRules } from './members.ts'
import { emit } from './notify.ts'
import { empty, obj, str } from './parse.ts'
import { evict, heldReason, roomOf, setRoomGuard } from './rooms.ts'
import { addPoints, careerPoints, completedShifts, setEarningHook, setSpendingHook, spendPoints } from './work.ts'

interface VisaRecord extends Visa {
  /** Coins the applicant must still hold when the decision is made: required funds minus the fee already paid. */
  needs: number
}
interface MemberTravel {
  location: CoarseArea | null
  /**
   * Where the avatar arrived (first arrival or the end of a trip). Every distance — walking range,
   * street rooms, fares, visa terms — is measured from here. A walk changes `location` but never
   * this, so short walks cannot be chained into a free journey.
   */
  centre: LatLon | null
  /** Before the first arrival only: the one district a member has looked at. */
  preview: LatLon | null
  homeCountry: string | null
  passport: Passport
  visas: VisaRecord[]
  trip: Trip | null
  recentTrips: Trip[]
  /** Newest first. */
  ledger: LedgerEntry[]
  startingGranted: boolean
}
interface TravelSlice { members: Record<string, MemberTravel> }

const DAY = 86_400_000
const LEDGER_KEPT = 60, TRIPS_KEPT = 10
/** A district's centre can sit this far beyond the anchor of the area that holds it. */
const DISTRICT_SLACK_KM = 2
const MODE_NAME: Record<TravelMode, string> = { local: 'Walk', bus: 'Bus', rail: 'Train', flight: 'Flight' }
const NOT_PLACED = 'Choose where you are first. Then you can travel from there.'

const state = (world: World): TravelSlice => world.slice<TravelSlice>('travel', () => ({ members: {} }))

// ── Which country a point is in ───────────────────────────────────────────────────────────────
// An area's country code comes from the member's device, and every border rule hangs on it. So it
// is checked against the timezone map first. That map is coarse — it can be a hundred kilometres
// out along a border — so the check is deliberately loose: a claim is kept when the point's zone
// belongs to that country or one of its territories, or when that country is found anywhere within
// COUNTRY_REACH_KM. Otherwise the country the map gives is used instead. Nobody is locked out, but
// a far city cannot be passed off as domestic. Unknown zones and older runtimes keep the claim.
// (Measured on 34,152 cities with their real codes: none is changed.)

/** Zones the map files under another code: territories under their sovereign, and zones shared across a border. */
const ALSO_COVERS: Record<string, readonly string[]> = {
  US: ['PR', 'GU', 'VI', 'AS', 'MP', 'UM'], FR: ['RE', 'GP', 'MQ', 'GF', 'YT', 'PM', 'BL', 'MF', 'NC', 'PF', 'WF', 'TF'],
  GB: ['GI', 'IM', 'JE', 'GG', 'BM', 'KY', 'VG', 'TC', 'MS', 'AI', 'FK', 'SH', 'IO', 'PN', 'GS'], NL: ['AW', 'CW', 'SX', 'BQ'],
  DK: ['GL', 'FO'], FI: ['AX'], NO: ['SJ', 'BV'], AU: ['CX', 'CC', 'NF', 'HM'], NZ: ['CK', 'NU', 'TK'], CN: ['HK', 'MO'],
  VN: ['TH', 'LA', 'KH', 'CN'], NA: ['BW'], XK: ['RS'], MA: ['EH'], VA: ['IT'], SM: ['IT'], MC: ['FR'], AR: ['CL'],
}
const COUNTRY_REACH_KM = 300
const COUNTRY_RINGS_KM = [10, 25, 45, 70, 100, 140, 180, 220, 260, COUNTRY_REACH_KM]

type ZonedLocale = Intl.Locale & { getTimeZones?: () => string[] | undefined; timeZones?: string[] }
let zoneCountries: Map<string, string> | null = null
function zoneCountry(zone: string): string | null {
  if (!zoneCountries) {
    zoneCountries = new Map()
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b)
      try {
        const locale = new Intl.Locale(`und-${code}`) as ZonedLocale
        // Retired codes (UK, SU, ZR…) resolve to their successor and are skipped.
        if (locale.region === code) for (const name of locale.getTimeZones?.() ?? locale.timeZones ?? []) zoneCountries.set(name, code)
      } catch { /* not a region code */ }
    }
  }
  if (!zoneCountries.has(zone) && zoneCountries.size) {
    // The map names zones the modern way (Asia/Kolkata); the runtime may list the older alias.
    let alias = zone
    try { alias = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone } catch { /* unknown zone */ }
    const found = zoneCountries.get(alias)
    if (found) zoneCountries.set(zone, found)
  }
  return zoneCountries.get(zone) ?? null
}

function countryAt(point: LatLon): string | null {
  try { return zoneCountry(tzlookup(point.lat, point.lon)) } catch { return null }
}

function offset(point: LatLon, km: number, bearing: number): LatLon {
  const turn = (bearing * Math.PI) / 180
  const lat = point.lat + (km / 111.32) * Math.cos(turn)
  const lon = point.lon + (km / (111.32 * Math.max(0.05, Math.cos((point.lat * Math.PI) / 180)))) * Math.sin(turn)
  return { lat: Math.max(-85, Math.min(85, lat)), lon: ((((lon + 180) % 360) + 360) % 360) - 180 }
}

function countryOf(area: CoarseArea): string {
  const claimed = /^[A-Z]{2}$/.test(area.countryCode) ? area.countryCode : 'ZZ'
  const found = countryAt(area.anchor)
  // Open sea and unknown zones have no country to check against. The map's zones reach well past walking range offshore.
  if (!found || found === claimed || ALSO_COVERS[claimed]?.includes(found)) return claimed
  for (const km of COUNTRY_RINGS_KM) for (let bearing = 0; bearing < 360; bearing += 11.25) if (countryAt(offset(area.anchor, km, bearing)) === claimed) return claimed
  return found
}

/** A private copy of an area with a country the service stands behind. */
const settled = (area: CoarseArea): CoarseArea => ({
  areaId: area.areaId, label: area.label, countryCode: countryOf(area), timezone: area.timezone,
  anchor: { lat: area.anchor.lat, lon: area.anchor.lon }, arrivalDistrict: area.arrivalDistrict,
  ...(area.region ? { region: area.region } : {}),
})

let regionNames: Intl.DisplayNames | null = null
function countryName(code: string): string {
  if (code === 'ZZ') return 'that country'
  try { return (regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })).of(code) ?? code } catch { return code }
}

const day = (at: Iso): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(ms(at))
const secondsUntil = (at: Iso, now: number): number => Math.max(1, Math.ceil((ms(at) - now) / 1000))
const travelling = (trip: Trip, now: number): string => `You are travelling. You arrive in ${secondsUntil(trip.arrivesAt, now)} seconds.`

// ── State ─────────────────────────────────────────────────────────────────────────────────────

function view(world: World, memberId: MemberId, member: MemberTravel): TravelState {
  return {
    location: member.location, walkingOrigin: member.centre ? { ...member.centre } : null, homeCountry: member.homeCountry, balance: careerPoints(world, memberId), passport: { ...member.passport },
    visas: member.visas.map(({ needs: _needs, ...visa }): Visa => visa), trip: member.trip, recentTrips: [...member.recentTrips],
  }
}

function announce(world: World, memberId: MemberId, member: MemberTravel): void {
  world.touch()
  world.push(memberId, { type: 'travel.changed', state: view(world, memberId, member) })
}

/** Write a coin movement into the wallet history. Call it after the balance has changed. */
function log(world: World, memberId: MemberId, member: MemberTravel, kind: LedgerKind, amount: number, text: string): void {
  member.ledger.unshift({ id: `lg_${randomToken(12)}`, at: iso(world.now()), amount, kind, text, balanceAfter: careerPoints(world, memberId) })
  if (member.ledger.length > LEDGER_KEPT) member.ledger.length = LEDGER_KEPT
}

/** Street rooms are open within walking range of where the avatar arrived. Homes and tables are not street rooms. */
function reachKm(member: MemberTravel, ref: RoomRef): number | null {
  if (ref.kind !== 'district' && ref.kind !== 'venue') return null
  const tile = parseDistrictId(ref.districtId)
  const from = member.centre ?? member.preview
  return tile && from ? distanceKm(from, tileToLatLon(tile)) : null
}
const withinReach = (member: MemberTravel, ref: RoomRef): boolean => (reachKm(member, ref) ?? 0) <= TRAVEL.localRangeKm + DISTRICT_SLACK_KM

function firstArrival(world: World, memberId: MemberId, member: MemberTravel, area: CoarseArea): void {
  member.location = area
  member.centre = { ...area.anchor }
  member.preview = null
  member.homeCountry ??= area.countryCode
  // Whatever street the member was looking at before, the avatar is here now.
  const room = roomOf(world, memberId)
  if (room && !withinReach(member, room.ref)) evict(world, memberId)
  if (!member.startingGranted) {
    member.startingGranted = true
    addPoints(world, memberId, TRAVEL.startingCoins)
    log(world, memberId, member, 'starting', TRAVEL.startingCoins, 'Starting coins')
  }
  announce(world, memberId, member)
}

function memberOf(world: World, memberId: MemberId): MemberTravel {
  const members = state(world).members
  const existing = members[memberId]
  if (existing) return existing
  const created: MemberTravel = {
    location: null, centre: null, preview: null, homeCountry: null,
    passport: { status: 'none', countryCode: null, appliedAt: null, readyAt: null, expiresAt: null },
    visas: [], trip: null, recentTrips: [], ledger: [], startingGranted: false,
  }
  members[memberId] = created
  // A member who chose an area before travel existed starts where they said they are.
  const profile = exists(world, memberId) ? record(world, memberId).profile : null
  const start = profile?.currentArea ?? profile?.browsing
  if (profile && start) {
    firstArrival(world, memberId, created, settled(start))
    if (profile.browsing && distanceKm(start.anchor, profile.browsing.anchor) > TRAVEL.localRangeKm) { profile.browsing = settled(start); profile.revision++ }
  }
  world.touch()
  return created
}

// ── Time ──────────────────────────────────────────────────────────────────────────────────────

function arrive(world: World, memberId: MemberId, member: MemberTravel, trip: Trip): void {
  member.trip = null
  member.location = trip.to
  member.centre = { ...trip.to.anchor }
  member.recentTrips.unshift({ ...trip, status: 'arrived' })
  if (member.recentTrips.length > TRIPS_KEPT) member.recentTrips.length = TRIPS_KEPT
  if (exists(world, memberId)) {
    // The App opens where the avatar now is.
    const { profile } = record(world, memberId)
    profile.browsing = settled(trip.to)
    profile.revision++
  }
  emit(world, {
    to: memberId, category: 'events', kind: 'travel.arrived', title: `You have arrived in ${trip.to.label}`,
    body: `Your ${MODE_NAME[trip.mode].toLowerCase()} from ${trip.from.label} is in. Step out and look around.`, link: '/', dedupeKey: `trip:${trip.id}`,
  })
}

/** Approve or refuse on what is true at this moment: the balance and the finished shifts. */
function decide(world: World, memberId: MemberId, visa: VisaRecord, now: number): void {
  const balance = careerPoints(world, memberId), shifts = completedShifts(world, memberId)
  const failed: string[] = []
  if (balance < visa.needs) failed.push(`Funds were below the required ${visa.needs} coins: you had ${balance}.`)
  if (shifts < TRAVEL.visa.minShifts) failed.push(`Work history was too short: ${shifts} of the ${TRAVEL.visa.minShifts} completed shifts needed.`)
  const name = countryName(visa.countryCode)
  if (failed.length) {
    visa.status = 'refused'
    visa.validUntil = null
    visa.note = failed.join(' ')
  } else {
    visa.status = 'valid'
    visa.validUntil = iso(now + TRAVEL.visa.validDays * DAY)
    visa.note = ''
  }
  emit(world, {
    to: memberId, category: 'events', kind: failed.length ? 'visa.refused' : 'visa.approved', link: '/travel', dedupeKey: `visa:${memberId}:${visa.countryCode}:${visa.appliedAt}`,
    title: failed.length ? `Your visa for ${name} was refused` : `Your visa for ${name} was approved`,
    body: failed.length ? `${visa.note} The fee is not refunded. You can apply again.` : `It is valid until ${day(visa.validUntil!)}.`,
  })
}

/** Bring one member up to date with the clock: arrivals, documents coming due, documents expiring. */
function settle(world: World, memberId: MemberId, member: MemberTravel, now: number): void {
  let changed = false
  if (member.trip && ms(member.trip.arrivesAt) <= now) { arrive(world, memberId, member, member.trip); changed = true }
  const passport = member.passport
  if (passport.status === 'processing' && passport.readyAt && ms(passport.readyAt) <= now) {
    passport.status = 'valid'
    passport.expiresAt = iso(now + TRAVEL.passport.validDays * DAY)
    emit(world, {
      to: memberId, category: 'events', kind: 'passport.ready', title: 'Your passport is ready', link: '/travel',
      body: `It is valid until ${day(passport.expiresAt)}.`, dedupeKey: `passport:${memberId}:${passport.appliedAt}`,
    })
    changed = true
  }
  if (passport.status === 'valid' && passport.expiresAt && ms(passport.expiresAt) <= now) { passport.status = 'expired'; changed = true }
  for (const visa of member.visas) {
    if (visa.status === 'processing' && visa.readyAt && ms(visa.readyAt) <= now) { decide(world, memberId, visa, now); changed = true }
    if (visa.status === 'valid' && visa.validUntil && ms(visa.validUntil) <= now) { visa.status = 'expired'; changed = true }
  }
  if (changed) announce(world, memberId, member)
}

/** The member's record, settled against the clock. Every rule below starts here. */
function current(world: World, memberId: MemberId, now: number): MemberTravel {
  const member = memberOf(world, memberId)
  settle(world, memberId, member, now)
  return member
}

// ── Rules ─────────────────────────────────────────────────────────────────────────────────────

const passportValid = (member: MemberTravel, at: number): boolean =>
  member.passport.status === 'valid' && member.passport.expiresAt !== null && ms(member.passport.expiresAt) > at
/** The end of a visa's validity when it is valid at `at`, otherwise null. */
const visaValidUntil = (visa: VisaRecord | undefined, at: number): Iso | null =>
  visa && visa.status === 'valid' && visa.validUntil !== null && ms(visa.validUntil) > at ? visa.validUntil : null

function passportRequirement(member: MemberTravel, now: number): TravelRequirement {
  const passport = member.passport
  if (passportValid(member, now)) return { kind: 'passport', met: true, text: `Your passport is valid until ${day(passport.expiresAt!)}.` }
  const text = passport.status === 'processing' && passport.readyAt ? `Your passport is still being processed. It will be ready in ${secondsUntil(passport.readyAt, now)} seconds.`
    : passport.status === 'none' ? 'You need a passport to cross a border. Apply for one from Travel.'
    : 'Your passport has expired. Renew it from Travel.'
  return { kind: 'passport', met: false, text }
}

function visaRequirement(member: MemberTravel, countryCode: string, now: number): TravelRequirement {
  const name = countryName(countryCode)
  if (member.homeCountry === countryCode) return { kind: 'visa', met: true, text: `No visa needed. ${name} is your home country.` }
  const bloc = member.homeCountry ? visaFreeBetween(member.homeCountry, countryCode) : { free: false, bloc: null }
  if (bloc.free) return { kind: 'visa', met: true, text: `No visa needed for ${name}. Visa-free bloc: ${bloc.bloc}.` }
  const visa = member.visas.find(entry => entry.countryCode === countryCode)
  const validUntil = visaValidUntil(visa, now)
  if (validUntil) return { kind: 'visa', met: true, text: `Your visa for ${name} is valid until ${day(validUntil)}.` }
  const text = !visa ? `You need a visa for ${name}. Apply for one from Travel.`
    : visa.status === 'processing' ? `Your visa for ${name} is still being processed.${visa.readyAt ? ` The decision comes in ${secondsUntil(visa.readyAt, now)} seconds.` : ''}`
    : visa.status === 'refused' ? `Your visa for ${name} was refused. You can apply again from Travel.`
    : `Your visa for ${name} has expired. Apply again from Travel.`
  return { kind: 'visa', met: false, text }
}

const borderRequirements = (member: MemberTravel, countryCode: string, now: number): TravelRequirement[] =>
  [passportRequirement(member, now), visaRequirement(member, countryCode, now)]

type Blocked = 'local' | 'trip' | TravelRequirement['kind']

/** Work out a trip from the member's present state. Booking calls this again; an earlier quote counts for nothing. */
function quoteFor(world: World, memberId: MemberId, member: MemberTravel, to: CoarseArea, now: number): { quote: TravelQuote; blocked: Blocked | null } {
  if (!member.location || !member.centre) throw new WorldError('conflict', NOT_PLACED)
  const km = distanceKm(member.centre, to.anchor)
  const terms = tripTerms(km)
  const international = to.countryCode !== member.location.countryCode
  const balance = careerPoints(world, memberId)
  const requirements: TravelRequirement[] = international ? borderRequirements(member, to.countryCode, now) : []
  requirements.push(balance >= terms.fare
    ? { kind: 'funds', met: true, text: terms.fare ? `The fare is ${terms.fare} coins. You have ${balance}.` : 'There is no fare.' }
    : { kind: 'funds', met: false, text: `You need ${terms.fare - balance} more ${terms.fare - balance === 1 ? 'coin' : 'coins'} for the ${terms.fare} coin fare. Work a shift or play a game to earn them.` })
  const unmet = requirements.find(requirement => !requirement.met)
  let blocked: Blocked | null = null, reason = ''
  if (terms.mode === 'local') { blocked = 'local'; reason = 'That is close enough to walk. Open it from the area list.' }
  else if (member.trip) { blocked = 'trip'; reason = travelling(member.trip, now) }
  else if (unmet) { blocked = unmet.kind; reason = unmet.text }
  return {
    quote: { to, distanceKm: Math.round(km * 10) / 10, mode: terms.mode, fare: terms.fare, seconds: terms.seconds, international, requirements, allowed: blocked === null, reason },
    blocked,
  }
}

/**
 * For modules that pay coins (work, games): call this after adding the points, so the wallet
 * history shows where they came from. It records the earning; it does not move coins itself.
 */
export function recordEarning(world: World, memberId: MemberId, amount: number, kind: 'work' | 'game' | 'gift', text: string): void {
  if (!(amount > 0) || !exists(world, memberId)) return
  const member = memberOf(world, memberId)
  log(world, memberId, member, kind, Math.floor(amount), text.slice(0, 120))
  announce(world, memberId, member)
}

/** Where a member's character is, for other modules: the area it stands in, and the trip it is on if any. Read-only. */
export function whereIs(world: World, memberId: MemberId): { location: CoarseArea | null; trip: Trip | null; homeCountry: string | null } {
  const member = state(world).members[memberId]
  return member ? { location: member.location, trip: member.trip, homeCountry: member.homeCountry } : { location: null, trip: null, homeCountry: null }
}

/** The country a member's character is from (the country of first arrival), for standings by place. Read-only. */
export const homeCountryOf = (world: World, memberId: MemberId): string | null => state(world).members[memberId]?.homeCountry ?? null

/** Other modules that charge coins (a meal, groceries) report the purchase here so it shows in the wallet history. */
export function recordSpending(world: World, memberId: MemberId, amount: number, kind: 'food', text: string): void {
  if (!(amount > 0) || !exists(world, memberId)) return
  const member = memberOf(world, memberId)
  log(world, memberId, member, kind, -Math.ceil(amount), text.slice(0, 120))
  announce(world, memberId, member)
}

/**
 * May this member's character be in this street room? The same rule the street guard applies
 * (walking range of where they arrived, and not on a trip), asked without entering and without
 * the one-place preview a new member gets. Null when they may; otherwise the sentence to show.
 */
export function streetAdmission(world: World, memberId: MemberId, ref: RoomRef): string | null {
  if (ref.kind !== 'district' && ref.kind !== 'venue') return 'That is not a street.'
  if (!exists(world, memberId) || !parseDistrictId(ref.districtId)) return 'That district cannot be entered.'
  const now = world.now()
  const member = current(world, memberId, now)
  if (member.trip) return travelling(member.trip, now)
  if (!member.centre) return NOT_PLACED
  if (withinReach(member, ref)) return null
  return `That district is ${Math.round(reachKm(member, ref) ?? 0)} km from ${member.location?.label ?? 'where you are'}. Book a trip from Travel to go there.`
}

/**
 * Take a vehicle's charter fare. The amount is the service's own quote, never a request's. The
 * whole fare or nothing: too few coins throws and changes nothing. One line in the wallet history.
 */
export function chargeVehicleFare(world: World, memberId: MemberId, fare: number, text: string): { ledgerId: string; balance: number } {
  if (!Number.isSafeInteger(fare) || fare < 1) throw new WorldError('invalid', 'That fare is not valid.')
  const member = current(world, memberId, world.now())
  spendPoints(world, memberId, fare)
  log(world, memberId, member, 'fare', -fare, text.slice(0, 120))
  announce(world, memberId, member)
  return { ledgerId: member.ledger[0]!.id, balance: careerPoints(world, memberId) }
}

/** Give a charter fare back. The caller records that it did, so that it happens once. */
export function refundVehicleFare(world: World, memberId: MemberId, amount: number, text: string): { ledgerId: string; balance: number } {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new WorldError('invalid', 'That refund is not valid.')
  const member = memberOf(world, memberId)
  addPoints(world, memberId, amount)
  log(world, memberId, member, 'refund', amount, text.slice(0, 120))
  announce(world, memberId, member)
  return { ledgerId: member.ledger[0]!.id, balance: careerPoints(world, memberId) }
}

/**
 * Take the coins for something bought or built for a home. The amount is the service's own
 * quote, never a request's. The whole amount or nothing: too few coins throws and changes
 * nothing. One line in the wallet history.
 */
export function chargeHomePurchase(world: World, memberId: MemberId, coins: number, text: string): { ledgerId: string; balance: number } {
  if (!Number.isSafeInteger(coins) || coins < 1) throw new WorldError('invalid', 'That amount is not valid.')
  const member = current(world, memberId, world.now())
  spendPoints(world, memberId, coins)
  log(world, memberId, member, 'home', -coins, text.slice(0, 120))
  announce(world, memberId, member)
  return { ledgerId: member.ledger[0]!.id, balance: careerPoints(world, memberId) }
}

export function registerTravel(world: World): void {
  setSpendingHook((hookWorld, memberId, amount, kind, text) => { if (hookWorld === world) recordSpending(world, memberId, amount, kind, text) })
  setEarningHook((hookWorld, memberId, amount, kind, text) => { if (hookWorld === world) recordEarning(world, memberId, amount, kind, text) })
  world.onTick(now => {
    for (const [memberId, member] of Object.entries(state(world).members)) {
      // One damaged record must not stop every other member's trip from landing.
      try { settle(world, memberId as MemberId, member, now) } catch (error) { console.error(`[travel] could not settle ${memberId}`, error) }
    }
  })

  setAreaRules({
    currentAreaSet(hookWorld, memberId, area) {
      // Saying where you are places the avatar once. After that the avatar moves only by travelling.
      const member = current(hookWorld, memberId, hookWorld.now())
      if (!member.location) firstArrival(hookWorld, memberId, member, settled(area))
    },
    relocate(hookWorld, memberId, area) {
      const now = hookWorld.now()
      const member = current(hookWorld, memberId, now)
      if (!area) return
      const to = settled(area)
      if (!member.location || !member.centre) { firstArrival(hookWorld, memberId, member, to); return }
      if (member.trip) throw new WorldError('forbidden', travelling(member.trip, now))
      const km = distanceKm(member.centre, to.anchor)
      if (km > TRAVEL.localRangeKm) throw new WorldError('forbidden', `That is ${Math.round(km)} km away. Book a trip from Travel to go there.`)
      if (to.countryCode !== member.location.countryCode) {
        // Walking over a border costs nothing, but it is still a border.
        const unmet = borderRequirements(member, to.countryCode, now).find(requirement => !requirement.met)
        if (unmet) throw new WorldError('forbidden', `${to.label} is across the border in ${countryName(to.countryCode)}. ${unmet.text}`)
      }
      const before = JSON.stringify(member.location)
      member.location = to
      if (JSON.stringify(to) !== before) announce(hookWorld, memberId, member)
    },
  })

  setRoomGuard('street', (guardWorld, memberId, ref) => {
    if (ref.kind !== 'district' && ref.kind !== 'venue') return
    const tile = parseDistrictId(ref.districtId)
    if (!tile) throw new WorldError('invalid', 'ref.districtId is not a valid district')
    const now = guardWorld.now()
    const member = current(guardWorld, memberId, now)
    if (member.trip) throw new WorldError('forbidden', travelling(member.trip, now))
    // Before choosing an area a member may look at one place; onboarding places them right after.
    if (!member.centre && !member.preview) { member.preview = tileToLatLon(tile); guardWorld.touch(); return }
    if (withinReach(member, ref)) return
    throw new WorldError('forbidden', member.location
      ? `That district is ${Math.round(reachKm(member, ref) ?? 0)} km from ${member.location.label}. Book a trip from Travel to go there.`
      : 'Choose where you are first. Then book a trip from Travel to go further.')
  })

  world.register('travel.state', empty, ctx => {
    const member = current(world, ctx.memberId, ctx.now)
    return { state: view(world, ctx.memberId, member), ledger: [...member.ledger] }
  })

  const parseTo = (value: unknown): { to: CoarseArea } => ({ to: parseCoarseArea(obj(value).to) })

  world.register('travel.quote', parseTo, (ctx, input) => {
    const member = current(world, ctx.memberId, ctx.now)
    return { quote: quoteFor(world, ctx.memberId, member, settled(input.to), ctx.now).quote }
  })

  world.register('travel.book', parseTo, (ctx, input) => {
    // Seated in a vehicle: get out first. The trip would take the avatar out of the room and leave the seat taken.
    const held = heldReason(world, ctx.memberId)
    if (held) throw new WorldError('conflict', held)
    const member = current(world, ctx.memberId, ctx.now)
    const { quote, blocked } = quoteFor(world, ctx.memberId, member, settled(input.to), ctx.now)
    if (blocked) {
      const code: ErrorCode = blocked === 'passport' || blocked === 'visa' ? 'forbidden' : 'conflict'
      throw new WorldError(code, quote.reason)
    }
    spendPoints(world, ctx.memberId, quote.fare)
    log(world, ctx.memberId, member, 'fare', -quote.fare, `${MODE_NAME[quote.mode]} to ${quote.to.label}`)
    member.trip = {
      id: `tr_${randomToken(12)}`, from: member.location!, to: quote.to, mode: quote.mode, fare: quote.fare, distanceKm: quote.distanceKm,
      departedAt: iso(ctx.now), arrivesAt: iso(ctx.now + quote.seconds * 1000), status: 'in-transit',
    }
    // In transit the avatar is in no room.
    evict(world, ctx.memberId)
    announce(world, ctx.memberId, member)
    return { state: view(world, ctx.memberId, member) }
  })

  world.register('travel.passportApply', empty, ctx => {
    const member = current(world, ctx.memberId, ctx.now)
    if (!member.homeCountry) throw new WorldError('conflict', 'Choose where you are first. Your home country issues your passport.')
    const passport = member.passport
    if (passport.status === 'processing') throw new WorldError('conflict', `Your passport is already being processed.${passport.readyAt ? ` It will be ready in ${secondsUntil(passport.readyAt, ctx.now)} seconds.` : ''}`)
    if (passportValid(member, ctx.now)) throw new WorldError('conflict', `Your passport is still valid until ${day(passport.expiresAt!)}. You can renew it once it expires.`)
    spendPoints(world, ctx.memberId, TRAVEL.passport.fee)
    log(world, ctx.memberId, member, 'passport', -TRAVEL.passport.fee, passport.status === 'none' ? 'Passport application' : 'Passport renewal')
    member.passport = {
      status: 'processing', countryCode: member.homeCountry, appliedAt: iso(ctx.now), readyAt: iso(ctx.now + TRAVEL.passport.seconds * 1000), expiresAt: null,
    }
    announce(world, ctx.memberId, member)
    return { state: view(world, ctx.memberId, member) }
  })

  world.register('travel.visaApply', value => {
    const raw = obj(value)
    const countryCode = str(raw, 'countryCode', { min: 2, max: 2 }).toUpperCase()
    if (!/^[A-Z]{2}$/.test(countryCode)) throw new WorldError('invalid', 'countryCode must be a two-letter country code')
    return { countryCode, toward: parseCoarseArea(raw.toward) }
  }, (ctx, input) => {
    const member = current(world, ctx.memberId, ctx.now)
    if (!member.location || !member.centre || !member.homeCountry) throw new WorldError('conflict', NOT_PLACED)
    // The fee follows the distance to `toward`, so that place must really be in the country asked for.
    const toward = settled(input.toward)
    const country = input.countryCode, name = countryName(country)
    if (toward.countryCode !== country) throw new WorldError('invalid', `${toward.label} is not in ${name}.`)
    if (country === member.homeCountry) throw new WorldError('conflict', `You do not need a visa for ${name}. It is your home country.`)
    const bloc = visaFreeBetween(member.homeCountry, country)
    if (bloc.free) throw new WorldError('conflict', `You do not need a visa for ${name}. Visa-free bloc: ${bloc.bloc}.`)
    if (!passportValid(member, ctx.now)) throw new WorldError('conflict', `A visa application needs a valid passport. ${passportRequirement(member, ctx.now).text}`)
    const existing = member.visas.find(visa => visa.countryCode === country)
    if (existing?.status === 'processing') throw new WorldError('conflict', `Your visa for ${name} is already being processed.`)
    const validUntil = visaValidUntil(existing, ctx.now)
    if (validUntil) throw new WorldError('conflict', `You already have a visa for ${name}, valid until ${day(validUntil)}.`)
    const terms = visaTerms(distanceKm(member.centre, toward.anchor))
    spendPoints(world, ctx.memberId, terms.fee)
    log(world, ctx.memberId, member, 'visa', -terms.fee, `Visa application for ${name}`)
    // One record per country: a new application replaces a refused or expired one.
    member.visas = member.visas.filter(visa => visa.countryCode !== country)
    member.visas.unshift({
      countryCode: country, status: 'processing', appliedAt: iso(ctx.now), readyAt: iso(ctx.now + TRAVEL.visa.seconds * 1000), validUntil: null, note: '',
      needs: terms.funds - terms.fee,
    })
    announce(world, ctx.memberId, member)
    return { state: view(world, ctx.memberId, member) }
  })
}
