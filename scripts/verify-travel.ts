// Evidence probe for travel, documents and the wallet: in-process world, controllable clock, plain
// asserts. Run: node scripts/verify-travel.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import type { MemberId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode, RoomRef } from '../src/shared/model.ts'
import type { ServerEvent } from '../src/shared/protocol.ts'
import { HOME_PHYSICAL } from '../src/shared/homes.ts'
import { TRAVEL, distanceKm, tripTerms, visaTerms } from '../src/shared/travel.ts'
import type { TravelState } from '../src/shared/travel.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import type { Persistence, World } from '../service/kernel.ts'
import { createWorld } from '../service/index.ts'
import { ensureMember } from '../service/members.ts'
import { roomOf } from '../service/rooms.ts'
import { recordEarning } from '../service/travel.ts'
import { careerPoints, spendPoints } from '../service/work.ts'

const SECOND = 1000, DAY = 86_400_000
let now = Date.UTC(2026, 9, 1, 12)
let stored: Record<string, unknown> | null = null
const persistence: Persistence = { load: () => (stored ? structuredClone(stored) : null), save: saved => { stored = structuredClone(saved) } }

const place = (label: string, countryCode: string, lat: number, lon: number): CoarseArea => areaFromPlace({ label, countryCode, anchor: { lat, lon } })
const ibadan = place('Bodija, Ibadan', 'NG', 7.4352, 3.914)
const mokola = place('Mokola, Ibadan', 'NG', 7.4011, 3.8917)
const iwo = place('Iwo', 'NG', 7.6333, 4.1833)
const ede = place('Ede', 'NG', 7.7333, 4.4333)
const lagos = place('Yaba, Lagos', 'NG', 6.5095, 3.3711)
const abuja = place('Wuse, Abuja', 'NG', 9.0765, 7.476)
const accra = place('Osu, Accra', 'GH', 5.556, -0.182)
const aflao = place('Aflao', 'GH', 6.119, 1.194)
const lome = place('Lomé', 'TG', 6.1319, 1.2228)
const nairobi = place('Kilimani, Nairobi', 'KE', -1.2921, 36.7856)
const manchester = place('Northern Quarter, Manchester', 'GB', 53.4839, -2.2364)
const madrid = place('Centro, Madrid', 'ES', 40.4168, -3.7038)

const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j', 'k'] as const
const id = (name: string): MemberId => `m_local_${name}` as MemberId
const [A, B, C, D, E, F, G, H, J, K] = names.map(id) as [MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId, MemberId]
const events: Record<string, ServerEvent[]> = {}

function makeWorld(): World {
  const made = createWorld({ now: () => now, persistence })
  for (const name of names) {
    ensureMember(made, id(name), `Member ${name.toUpperCase()}`)
    made.connect(id(name), frame => { if (frame.t === 'event') (events[id(name)] ??= []).push(frame.event) }, () => {})
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

const travel = (member: MemberId): TravelState => world.call(member, 'travel.state', {}).state
const ledger = (member: MemberId) => world.call(member, 'travel.state', {}).ledger
const balance = (member: MemberId): number => travel(member).balance
const quote = (member: MemberId, to: CoarseArea) => world.call(member, 'travel.quote', { to }).quote
const book = (member: MemberId, to: CoarseArea): TravelState => world.call(member, 'travel.book', { to }).state
const district = (area: CoarseArea): RoomRef => ({ kind: 'district', districtId: area.arrivalDistrict })
const enter = (member: MemberId, area: CoarseArea) => world.call(member, 'room.enter', { ref: district(area), pos: { x: 0, z: 0 }, heading: 0 })
const notes = (member: MemberId, kind: string) => world.call(member, 'notify.list', { includeRead: true }).notifications.filter(note => note.kind === kind)
const arriveAt = (member: MemberId, area: CoarseArea): void => { world.call(member, 'member.setCurrentArea', { area, source: 'manual' }) }
const termsFrom = (from: CoarseArea, to: CoarseArea) => tripTerms(distanceKm(from.anchor, to.anchor))
const pushed = (member: MemberId): TravelState[] => (events[member] ?? []).flatMap(event => event.type === 'travel.changed' ? [event.state] : [])

/** Walk a member to `target` in the street they are in, 1.5 m a second. Every step must be accepted; returns the last pose the service gave back. */
function walkTo(member: MemberId, from: { x: number; z: number }, target: { x: number; z: number }): { x: number; z: number } {
  let pos = from
  for (let step = 0; step < 60 && Math.hypot(target.x - pos.x, target.z - pos.z) > 1e-6; step++) {
    const dx = target.x - pos.x, dz = target.z - pos.z, fraction = Math.min(1, 1.5 / Math.hypot(dx, dz))
    now += SECOND
    const moved = world.call(member, 'room.move', { pos: { x: pos.x + dx * fraction, z: pos.z + dz * fraction }, heading: Math.atan2(dx, dz), moving: true })
    assert.equal(moved.accepted, true, `walk step ${step} was refused`)
    pos = moved.pos
  }
  return pos
}
/** One full work shift: five correct answers. Takes 40 seconds of world time. */
function workShift(member: MemberId): void {
  now += 35 * SECOND
  let { shift } = world.call(member, 'work.start', { workplaceId: 'corner-cafe', venueName: null })
  while (shift.status === 'active') {
    now += SECOND
    shift = world.call(member, 'work.answer', { shiftId: shift.id, index: shift.current!.index, handed: [...shift.current!.wants] }).shift
  }
  assert.equal(shift.status, 'completed')
}
/** Paid work that never counts as a completed shift: four tasks, then leave. */
function partShift(member: MemberId): void {
  now += 35 * SECOND
  let { shift } = world.call(member, 'work.start', { workplaceId: 'corner-shop', venueName: null })
  for (let index = 0; index < 4; index++) {
    now += SECOND
    shift = world.call(member, 'work.answer', { shiftId: shift.id, index, handed: [...shift.current!.wants] }).shift
  }
  assert.equal(world.call(member, 'work.leave', { shiftId: shift.id }).shift.status, 'left-early')
}
function earn(member: MemberId, target: number, work: (member: MemberId) => void = workShift): void {
  for (let guard = 0; careerPoints(world, member) < target; guard++) { assert.ok(guard < 80, 'earning took too long'); work(member) }
}
/** Let a trip, passport or visa come due, then tick. */
function wait(seconds: number): void { now += seconds * SECOND; world.tick() }

// ── 1–3 Arriving, walking, street rooms ──

check('1 first arrival sets location and home country and grants 150 coins once', () => {
  const before = travel(A)
  assert.equal(before.location, null)
  assert.equal(before.homeCountry, null)
  assert.equal(before.balance, 0)
  rejects('conflict', () => quote(A, lagos), /Choose where you are first/)
  rejects('conflict', () => world.call(A, 'travel.passportApply', {}), /Choose where you are first/)
  arriveAt(A, ibadan)
  const after = travel(A)
  assert.deepEqual(after.location, ibadan)
  assert.equal(after.homeCountry, 'NG')
  assert.equal(after.balance, TRAVEL.startingCoins)
  assert.equal(after.balance, 150)
  assert.equal(after.passport.status, 'none')
  const entries = ledger(A)
  assert.equal(entries.length, 1)
  assert.deepEqual([entries[0]!.kind, entries[0]!.amount, entries[0]!.balanceAfter], ['starting', 150, 150])
  assert.deepEqual(pushed(A).at(-1)!.location, ibadan, 'travel.changed carries the fresh state')
  arriveAt(A, ibadan)
  arriveAt(A, nairobi)
  assert.equal(balance(A), 150, 'confirming an area again grants nothing')
  assert.equal(ledger(A).length, 1)
  assert.deepEqual(travel(A).location, ibadan, 'saying you are in Nairobi does not move the avatar')
  assert.equal(travel(A).homeCountry, 'NG')
  // Browsing somewhere is a first arrival too.
  world.call(B, 'member.setBrowsing', { area: ibadan })
  assert.deepEqual([travel(B).location?.label, travel(B).homeCountry, balance(B)], ['Bodija, Ibadan', 'NG', 150])
  world.call(B, 'member.setBrowsing', { area: null })
  assert.equal(balance(B), 150)
})

check('2 local move is free; a far move is refused and points to Travel', () => {
  const { profile } = world.call(A, 'member.setBrowsing', { area: mokola })
  assert.equal(profile.browsing?.label, 'Mokola, Ibadan')
  assert.equal(travel(A).location?.label, 'Mokola, Ibadan')
  assert.deepEqual(travel(A).location?.anchor, mokola.anchor)
  assert.equal(balance(A), 150)
  rejects('forbidden', () => world.call(A, 'member.setBrowsing', { area: nairobi }), /^That is 3773 km away\. Book a trip from Travel to go there\.$/)
  assert.equal(travel(A).location?.label, 'Mokola, Ibadan')
  assert.equal(world.call(A, 'member.me', {}).profile.browsing?.label, 'Mokola, Ibadan', 'the refused area was not saved as browsing')
  assert.equal(world.call(A, 'member.setBrowsing', { area: null }).profile.browsing, null, 'null means back to where the avatar is')
  assert.equal(travel(A).location?.label, 'Mokola, Ibadan')
})

check('3 street guard: far district refused, local district and its venues allowed', () => {
  rejects('forbidden', () => enter(A, manchester), /Book a trip from Travel/)
  assert.equal(roomOf(world, A), null)
  rejects('forbidden', () => world.call(A, 'room.enter', { ref: { kind: 'venue', districtId: manchester.arrivalDistrict, placeId: 'cafe-1' as never }, pos: { x: 0, z: 0 }, heading: 0 }))
  assert.equal(enter(A, ibadan).snapshot.ref.kind, 'district')
  assert.equal(enter(A, mokola).snapshot.ref.kind, 'district')
  assert.equal(world.call(A, 'room.enter', { ref: { kind: 'venue', districtId: ibadan.arrivalDistrict, placeId: 'cafe-1' as never }, pos: { x: 0, z: 0 }, heading: 0 }).snapshot.ref.kind, 'venue')
  enter(A, ibadan)
  // Homes are not street rooms: the travel guard leaves them alone, and the door rule answers instead.
  // A home is entered only by walking to its front door, so a raw room.enter is refused, in the street or out of it.
  const home = world.call(A, 'member.me', {}).profile.homeId
  const rawHome = (member: MemberId, homeId: typeof home) => world.call(member, 'room.enter', { ref: { kind: 'home', homeId }, pos: { x: 0, z: 0 }, heading: 0 })
  rejects('conflict', () => rawHome(A, home), /^Go in by the front door: walk up to it and use it\.$/)
  assert.equal(roomOf(world, A)?.ref.kind, 'district', 'a refused raw entry leaves the avatar in its street')
  // Far from the only district with home parcels, A has no way to place a home, and an unplaced home has no door.
  assert.equal(world.call(A, 'home.sites', {}).unavailable, 'no-coverage')
  assert.equal(world.call(A, 'home.approach', { homeId: null }).approach.kind, 'unavailable')
  rejects('unavailable', () => world.call(A, 'home.enter', { homeId: null }))
  enter(A, ibadan)

  // A synthetic owner in Yaba, Lagos: a placed home, and the authoritative walk from the public arrival to its front door.
  const owner = id('owner')
  ensureMember(world, owner, 'Home owner')
  world.connect(owner, () => {}, () => {})
  arriveAt(owner, lagos)
  const arrival = enter(owner, lagos)
  const start = arrival.snapshot.members.find(member => member.id === owner)!.pos
  assert.notDeepEqual(start, { x: 0, z: 0 }, 'public arrival is the service’s pose, not the requested one')
  const placed = world.call(owner, 'home.setSite', { place: { parcelId: null } }).home
  const approach = world.call(owner, 'home.approach', { homeId: null }).approach
  assert.equal(approach.kind, 'walk')
  if (approach.kind !== 'walk') return
  const front = approach.site.parcel.standing
  assert.deepEqual([approach.site.districtId, approach.site.area.label], [lagos.arrivalDistrict, 'Yaba, Lagos'])
  assert.deepEqual([approach.enter.allowed, approach.enter.reason], [false, 'Walk up to the front door.'])
  rejects('conflict', () => rawHome(owner, placed.id), /^Go in by the front door/)
  rejects('conflict', () => world.call(owner, 'home.enter', { homeId: null }), /^Walk up to the front door\.$/)
  assert.equal(roomOf(world, owner)?.ref.kind, 'district', 'refused door entries leave the owner in the street')
  // The door cannot be jumped to (a step is bounded by speed and elapsed time, and no time has passed), and a walk that stops short does not open it.
  const jump = world.call(owner, 'room.move', { pos: front, heading: 0, moving: true })
  assert.deepEqual([jump.accepted, jump.pos], [false, start], 'an 18 m jump in no time is not a walk')
  const short = { x: front.x - (front.x - start.x) * 0.2, z: front.z - (front.z - start.z) * 0.2 }
  const near = walkTo(owner, start, short)
  assert.ok(Math.hypot(front.x - near.x, front.z - near.z) > HOME_PHYSICAL.doorRange + 1, 'stopped well outside door range')
  rejects('conflict', () => world.call(owner, 'home.enter', { homeId: null }), /^Walk up to the front door\.$/)
  const at = walkTo(owner, near, front)
  assert.deepEqual(at, front, 'every step was accepted and the last returned pose is the standing point')
  const ready = world.call(owner, 'home.approach', { homeId: null }).approach
  assert.equal(ready.kind, 'walk')
  if (ready.kind !== 'walk') return
  assert.deepEqual(ready.enter, { allowed: true, reason: '' })
  // Travel binds the door: A is in Ibadan, so even an open home in Yaba is a trip away, and no raw entry or door call gets A in.
  world.call(owner, 'home.setPolicy', { policy: 'public' })
  const hidden = world.call(A, 'home.approach', { homeId: placed.id }).approach
  assert.deepEqual([hidden.kind, hidden.kind === 'unavailable' ? hidden.reason : null], ['unavailable', 'not-shared'], 'a stranger is not told where the home stands')
  rejects('unavailable', () => world.call(A, 'home.enter', { homeId: placed.id }))
  const { preferences } = world.call(owner, 'member.me', {}).profile
  world.call(owner, 'member.savePreferences', { preferences: { ...preferences, discoverable: true } })
  assert.equal(world.call(A, 'home.approach', { homeId: placed.id }).approach.kind, 'travel')
  rejects('conflict', () => world.call(A, 'home.enter', { homeId: placed.id }), /Book a trip from Travel/)
  rejects('conflict', () => rawHome(A, placed.id), /^Go in by the front door/)
  assert.equal(roomOf(world, A)?.ref.kind, 'district')
  assert.equal(travel(A).location?.label, 'Mokola, Ibadan')

  const inside = world.call(owner, 'home.enter', { homeId: null })
  assert.deepEqual([inside.snapshot.ref, inside.stay.homeId, inside.stay.state], [{ kind: 'home', homeId: placed.id }, placed.id, 'inside'])
  assert.deepEqual(roomOf(world, owner)?.ref, { kind: 'home', homeId: placed.id })
  assert.equal(travel(owner).location?.label, 'Yaba, Lagos', 'going indoors does not move the avatar between places')
  // Booking a trip takes the character out of the house and ends the stay; the door then answers as a travel refusal.
  const toIbadan = book(owner, ibadan)
  assert.equal(toIbadan.trip?.status, 'in-transit')
  assert.equal(world.call(owner, 'home.presence', {}).stay, null, 'a trip ends the stay')
  assert.equal(roomOf(world, owner), null)
  rejects('conflict', () => world.call(owner, 'home.enter', { homeId: null }), /You are travelling/)
  wait(15)
  assert.equal(travel(owner).location?.label, 'Bodija, Ibadan')
  assert.equal(world.call(owner, 'home.approach', { homeId: null }).approach.kind, 'travel', 'the owner is a trip away from their own door')
  rejects('conflict', () => world.call(owner, 'home.enter', { homeId: null }), /Book a trip from Travel/)
})

// ── 4–5 Domestic trips and money ──

check('4 domestic trip Ibadan to Lagos: fare, ledger, transit, arrival', () => {
  const terms = termsFrom(ibadan, lagos)
  assert.equal(terms.mode, 'bus')
  const offer = quote(A, lagos)
  assert.equal(offer.mode, 'bus')
  assert.equal(offer.fare, terms.fare)
  assert.equal(offer.fare, 85)
  assert.equal(offer.seconds, 15)
  assert.equal(offer.distanceKm, Math.round(distanceKm(ibadan.anchor, lagos.anchor) * 10) / 10, 'measured from the arrival point, not from the last walk')
  assert.equal(offer.international, false)
  assert.deepEqual(offer.requirements.map(item => [item.kind, item.met]), [['funds', true]])
  assert.equal(offer.allowed, true)
  assert.equal(offer.reason, '')
  assert.equal(quote(A, abuja).mode, 'rail')
  const walk = quote(A, iwo)
  assert.deepEqual([walk.mode, walk.fare, walk.allowed, walk.reason], ['local', 0, false, 'That is close enough to walk. Open it from the area list.'])
  rejects('conflict', () => book(A, iwo), /close enough to walk/)

  assert.ok(roomOf(world, A), 'in a street room before leaving')
  const departed = now
  const state = book(A, lagos)
  assert.equal(state.balance, 150 - terms.fare)
  assert.equal(balance(A), 65)
  assert.deepEqual([state.trip?.status, state.trip?.mode, state.trip?.fare, state.trip?.to.label, state.trip?.from.label], ['in-transit', 'bus', 85, 'Yaba, Lagos', 'Mokola, Ibadan'])
  assert.equal(Date.parse(state.trip!.arrivesAt), departed + 15 * SECOND)
  const entry = ledger(A)[0]!
  assert.deepEqual([entry.kind, entry.amount, entry.text, entry.balanceAfter], ['fare', -85, 'Bus to Yaba, Lagos', 65])
  assert.equal(roomOf(world, A), null, 'in no room while travelling')
  rejects('forbidden', () => enter(A, ibadan), /^You are travelling\. You arrive in 15 seconds\.$/)
  rejects('forbidden', () => enter(A, lagos), /You are travelling/)
  rejects('forbidden', () => world.call(A, 'member.setBrowsing', { area: mokola }), /You are travelling/)
  assert.equal(travel(A).location?.label, 'Mokola, Ibadan', 'still at the origin until the trip ends')
  wait(14)
  assert.equal(travel(A).trip?.status, 'in-transit')
  assert.equal(notes(A, 'travel.arrived').length, 0)
  wait(1)
  const arrived = travel(A)
  assert.equal(arrived.trip, null)
  assert.deepEqual(arrived.location, lagos)
  assert.deepEqual([arrived.recentTrips[0]?.status, arrived.recentTrips[0]?.to.label], ['arrived', 'Yaba, Lagos'])
  assert.equal(arrived.homeCountry, 'NG')
  const note = notes(A, 'travel.arrived')
  assert.equal(note.length, 1)
  assert.deepEqual([note[0]!.category, note[0]!.title, note[0]!.link], ['events', 'You have arrived in Yaba, Lagos', '/'])
  assert.equal(world.call(A, 'member.me', {}).profile.browsing?.label, 'Yaba, Lagos', 'the App opens at the destination')
  assert.deepEqual(pushed(A).at(-1)!.location, lagos)
  world.tick()
  assert.equal(notes(A, 'travel.arrived').length, 1, 'ticking again does not arrive twice')
  assert.equal(travel(A).recentTrips.length, 1)
  assert.equal(enter(A, lagos).snapshot.ref.kind, 'district')
  rejects('forbidden', () => enter(A, ibadan), /Book a trip/)
})

check('5 not enough coins: quote and booking name the shortfall, nothing is deducted', () => {
  const terms = termsFrom(lagos, abuja)
  const offer = quote(A, abuja)
  assert.deepEqual([offer.mode, offer.fare, offer.allowed], ['rail', terms.fare, false])
  const short = terms.fare - 65
  assert.deepEqual(offer.requirements.map(item => [item.kind, item.met]), [['funds', false]])
  assert.match(offer.reason, new RegExp(`^You need ${short} more coins`))
  const entries = ledger(A).length
  rejects('conflict', () => book(A, abuja), new RegExp(`You need ${short} more coins`))
  assert.equal(balance(A), 65)
  assert.equal(ledger(A).length, entries)
  assert.equal(travel(A).trip, null)
  assert.ok(roomOf(world, A), 'a refused booking does not put the avatar in transit')
})

// ── 6 ECOWAS: passport, no visa ──

check('6 ECOWAS: Ghana and Togo need a passport but no visa; passport is paid, processed, then valid', () => {
  for (const to of [accra, lome]) {
    const offer = quote(B, to)
    assert.equal(offer.international, true)
    assert.deepEqual(offer.requirements.map(item => item.kind), ['passport', 'visa', 'funds'])
    assert.equal(offer.requirements[0]!.met, false)
    assert.equal(offer.requirements[1]!.met, true)
    assert.match(offer.requirements[1]!.text, /ECOWAS/)
    assert.equal(offer.allowed, false)
    assert.match(offer.reason, /You need a passport/)
  }
  rejects('forbidden', () => book(B, accra), /You need a passport/)
  rejects('conflict', () => world.call(B, 'travel.passportApply', {}), /^You need 250 more coins/)
  assert.equal(balance(B), 150)
  assert.equal(travel(B).passport.status, 'none')

  const fare = termsFrom(ibadan, accra).fare
  earn(B, TRAVEL.passport.fee + fare)
  const before = balance(B)
  rejects('forbidden', () => book(B, accra), /You need a passport/)
  assert.equal(balance(B), before, 'money alone does not cross a border')
  const applied = world.call(B, 'travel.passportApply', {}).state
  assert.equal(applied.balance, before - 400)
  assert.deepEqual([applied.passport.status, applied.passport.countryCode], ['processing', 'NG'])
  assert.deepEqual([ledger(B)[0]!.kind, ledger(B)[0]!.amount, ledger(B)[0]!.balanceAfter], ['passport', -400, before - 400])
  rejects('conflict', () => world.call(B, 'travel.passportApply', {}), /already being processed/)
  assert.equal(balance(B), before - 400, 'a second application is not charged')
  rejects('forbidden', () => book(B, accra), /still being processed/)
  wait(TRAVEL.passport.seconds - 1)
  assert.equal(travel(B).passport.status, 'processing')
  wait(1)
  const passport = travel(B).passport
  assert.equal(passport.status, 'valid')
  assert.equal(Date.parse(passport.expiresAt!), now + TRAVEL.passport.validDays * DAY)
  assert.deepEqual(notes(B, 'passport.ready').map(note => [note.category, note.link]), [['events', '/travel']])
  rejects('conflict', () => world.call(B, 'travel.passportApply', {}), /still valid/)
  assert.equal(balance(B), before - 400)

  const offer = quote(B, accra)
  assert.deepEqual(offer.requirements.map(item => item.met), [true, true, true])
  assert.deepEqual([offer.allowed, offer.mode, offer.fare], [true, 'rail', fare])
  assert.equal(quote(B, lome).allowed, true)
  book(B, accra)
  assert.equal(balance(B), before - 400 - fare)
  wait(25)
  assert.deepEqual([travel(B).location?.label, travel(B).location?.countryCode, travel(B).homeCountry], ['Osu, Accra', 'GH', 'NG'])
})

// ── 7 Visas ──

const kenyaFare = termsFrom(ibadan, nairobi).fare
const kenyaVisa = visaTerms(distanceKm(ibadan.anchor, nairobi.anchor))

check('7 visas: required outside the bloc, refused with the exact reason, approved once the conditions hold', () => {
  arriveAt(C, ibadan)
  for (const to of [nairobi, manchester, madrid]) {
    const offer = quote(C, to)
    assert.equal(offer.international, true)
    assert.deepEqual(offer.requirements.map(item => [item.kind, item.met]), [['passport', false], ['visa', false], ['funds', false]])
    assert.match(offer.requirements[1]!.text, /^You need a visa for (Kenya|United Kingdom|Spain)\./)
    assert.equal(offer.fare, termsFrom(ibadan, to).fare)
  }
  rejects('conflict', () => world.call(C, 'travel.visaApply', { countryCode: 'KE', toward: nairobi }), /needs a valid passport/)
  assert.equal(balance(C), 150)
  assert.deepEqual(kenyaVisa, { fee: 450, funds: 450 + kenyaFare })

  // Too little money: two finished shifts and a passport, but under the required funds at decision time.
  earn(C, 400 + 450 + 100)
  world.call(C, 'travel.passportApply', {})
  wait(TRAVEL.passport.seconds)
  rejects('conflict', () => world.call(C, 'travel.visaApply', { countryCode: 'GH', toward: accra }), /^You do not need a visa for Ghana\. Visa-free bloc: ECOWAS\.$/)
  rejects('conflict', () => world.call(C, 'travel.visaApply', { countryCode: 'NG', toward: lagos }), /^You do not need a visa for Nigeria\. It is your home country\.$/)
  rejects('invalid', () => world.call(C, 'travel.visaApply', { countryCode: 'GB', toward: nairobi }), /is not in United Kingdom/)
  const held = balance(C)
  const applied = world.call(C, 'travel.visaApply', { countryCode: 'KE', toward: nairobi }).state
  assert.equal(applied.balance, held - 450)
  assert.deepEqual(applied.visas.map(visa => [visa.countryCode, visa.status]), [['KE', 'processing']])
  assert.ok(!JSON.stringify(applied).includes('needs'), 'the internal funds figure stays in the service')
  assert.deepEqual([ledger(C)[0]!.kind, ledger(C)[0]!.amount, ledger(C)[0]!.text], ['visa', -450, 'Visa application for Kenya'])
  rejects('conflict', () => world.call(C, 'travel.visaApply', { countryCode: 'KE', toward: nairobi }), /already being processed/)
  assert.equal(balance(C), held - 450, 'a second application is not charged')
  rejects('forbidden', () => book(C, nairobi), /still being processed/)
  wait(TRAVEL.visa.seconds - 1)
  assert.equal(travel(C).visas[0]!.status, 'processing')
  wait(1)
  let visa = travel(C).visas[0]!
  assert.equal(visa.status, 'refused')
  assert.equal(visa.note, `Funds were below the required ${kenyaFare} coins: you had ${held - 450}.`)
  assert.equal(visa.validUntil, null)
  assert.equal(balance(C), held - 450, 'the fee is not refunded')
  assert.ok(!ledger(C).some(entry => entry.kind === 'refund'))
  assert.deepEqual(notes(C, 'visa.refused').map(note => [note.category, note.link, note.title]), [['events', '/travel', 'Your visa for Kenya was refused']])
  rejects('forbidden', () => book(C, nairobi), /was refused/)

  // Too few shifts: plenty of money, earned without ever finishing a shift.
  arriveAt(D, ibadan)
  earn(D, 400 + 450 + kenyaFare + 50, partShift)
  assert.equal(world.call(D, 'work.career', {}).career.shifts.completed, 0)
  world.call(D, 'travel.passportApply', {})
  wait(TRAVEL.passport.seconds)
  const rich = balance(D)
  world.call(D, 'travel.visaApply', { countryCode: 'KE', toward: nairobi })
  wait(TRAVEL.visa.seconds)
  assert.equal(travel(D).visas[0]!.status, 'refused')
  assert.equal(travel(D).visas[0]!.note, 'Work history was too short: 0 of the 2 completed shifts needed.')
  assert.equal(balance(D), rich - 450)

  // Enough of both: the second application is approved and the flight can be booked.
  earn(C, 450 + kenyaFare)
  const ready = balance(C)
  world.call(C, 'travel.visaApply', { countryCode: 'KE', toward: nairobi })
  assert.equal(travel(C).visas.length, 1, 'one record per country')
  wait(TRAVEL.visa.seconds)
  visa = travel(C).visas[0]!
  assert.deepEqual([visa.countryCode, visa.status, visa.note], ['KE', 'valid', ''])
  assert.equal(Date.parse(visa.validUntil!), now + TRAVEL.visa.validDays * DAY)
  assert.equal(notes(C, 'visa.approved').length, 1)
  rejects('conflict', () => world.call(C, 'travel.visaApply', { countryCode: 'KE', toward: nairobi }), /already have a visa/)
  assert.equal(quote(C, manchester).requirements[1]!.met, false, 'a visa for Kenya is not a visa for the UK')
  const offer = quote(C, nairobi)
  assert.deepEqual(offer.requirements.map(item => item.met), [true, true, true])
  assert.deepEqual([offer.allowed, offer.mode, offer.fare, offer.seconds], [true, 'flight', kenyaFare, termsFrom(ibadan, nairobi).seconds])
  const flown = book(C, nairobi)
  assert.equal(flown.trip?.fare, kenyaFare)
  assert.equal(flown.balance, ready - 450 - kenyaFare)
  wait(offer.seconds)
  assert.deepEqual([travel(C).location?.label, travel(C).location?.countryCode, travel(C).homeCountry], ['Kilimani, Nairobi', 'KE', 'NG'])
})

// ── 8 No way round ──

check('8 no continent jumping: only travel.book crosses a border', () => {
  arriveAt(E, ibadan)
  rejects('forbidden', () => world.call(E, 'member.setBrowsing', { area: manchester }), /Book a trip from Travel/)
  world.call(E, 'member.setCurrentArea', { area: manchester, source: 'device-suggested' })
  rejects('forbidden', () => enter(E, manchester), /Book a trip from Travel/)
  rejects('forbidden', () => enter(E, accra), /Book a trip from Travel/)
  rejects('forbidden', () => book(E, manchester), /You need a passport/)
  world.tick()
  assert.deepEqual(travel(E).location, ibadan)
  assert.equal(travel(E).homeCountry, 'NG')
  assert.equal(travel(E).trip, null)
  assert.equal(balance(E), 150)
  assert.equal(world.call(E, 'member.me', {}).profile.browsing, null)
})

check('9 walks cannot be chained, and a border within walking range still needs documents', () => {
  // Iwo is 37 km from the arrival point: a walk. Ede is 30 km beyond Iwo but 66 km from the arrival point.
  world.call(E, 'member.setBrowsing', { area: iwo })
  assert.equal(travel(E).location?.label, 'Iwo')
  assert.ok(distanceKm(iwo.anchor, ede.anchor) < TRAVEL.localRangeKm)
  rejects('forbidden', () => world.call(E, 'member.setBrowsing', { area: ede }), /^That is 66 km away\. Book a trip/)
  rejects('forbidden', () => enter(E, ede), /Book a trip/)
  assert.deepEqual([quote(E, ede).mode, quote(E, ede).fare], ['bus', termsFrom(ibadan, ede).fare], 'the fare is not shortened by walking towards it')
  assert.equal(travel(E).location?.label, 'Iwo')

  // Aflao (Ghana) and Lomé (Togo) are 3.5 km apart.
  arriveAt(F, aflao)
  assert.equal(travel(F).homeCountry, 'GH')
  assert.equal(quote(F, lome).mode, 'local')
  assert.deepEqual(quote(F, lome).requirements.map(item => [item.kind, item.met]), [['passport', false], ['visa', true], ['funds', true]])
  rejects('forbidden', () => world.call(F, 'member.setBrowsing', { area: lome }), /^Lomé is across the border in Togo\. You need a passport/)
  assert.equal(travel(F).location?.countryCode, 'GH')
  earn(F, 400)
  world.call(F, 'travel.passportApply', {})
  rejects('forbidden', () => world.call(F, 'member.setBrowsing', { area: lome }), /still being processed/)
  wait(TRAVEL.passport.seconds)
  world.call(F, 'member.setBrowsing', { area: lome })
  assert.deepEqual([travel(F).location?.label, travel(F).location?.countryCode, travel(F).homeCountry], ['Lomé', 'TG', 'GH'])
})

check('10 a forged country code does not turn a border into a domestic trip', () => {
  const forged = (area: CoarseArea, countryCode: string): CoarseArea => ({ ...area, countryCode })
  arriveAt(G, ibadan)
  // Nairobi and Manchester passed off as Nigeria; Manchester passed off as visa-free Ghana.
  for (const [to, real] of [[forged(nairobi, 'NG'), 'KE'], [forged(manchester, 'NG'), 'GB'], [forged(manchester, 'GH'), 'GB'], [forged(accra, 'NG'), 'GH']] as const) {
    const offer = quote(G, to)
    assert.equal(offer.to.countryCode, real)
    assert.equal(offer.international, true)
    assert.equal(offer.requirements[0]!.kind, 'passport')
    assert.equal(offer.allowed, false)
    rejects('forbidden', () => book(G, to), /You need a passport/)
  }
  assert.equal(quote(G, forged(nairobi, 'NG')).requirements[1]!.met, false, 'the visa rule follows the real country')
  // A walk cannot relabel the avatar's country, and a first arrival cannot pick a convenient home.
  world.call(G, 'member.setBrowsing', { area: forged(mokola, 'KE') })
  assert.equal(travel(G).location?.countryCode, 'NG')
  arriveAt(H, forged(ibadan, 'GB'))
  assert.deepEqual([travel(H).homeCountry, travel(H).location?.countryCode], ['NG', 'NG'])
  arriveAt(J, forged(ibadan, 'ZZ'))
  assert.equal(travel(J).homeCountry, 'NG')
  assert.equal(quote(J, forged(nairobi, 'ZZ')).international, true)
  // Coastal water counts with its coast: 40 km off Mombasa, passed off as Nigeria, is still Kenya.
  assert.equal(quote(G, place('Offshore', 'NG', -4.2, 40.0)).to.countryCode, 'KE')
  // A cheap nearby "UK" address does not buy a UK visa: the visa is for where the place really is.
  rejects('invalid', () => world.call(G, 'travel.visaApply', { countryCode: 'GB', toward: forged(lagos, 'GB') }), /^Yaba, Lagos is not in United Kingdom\.$/)
  // Honest codes are left alone, including border towns and territories filed under their sovereign.
  for (const honest of [ibadan, lagos, accra, aflao, lome, nairobi, manchester, madrid, place('San Juan', 'US', 18.4655, -66.1057), place('Hong Kong', 'CN', 22.3193, 114.1694), place('Hanoi', 'VN', 21.0278, 105.8342)]) {
    assert.equal(quote(G, honest).to.countryCode, honest.countryCode, honest.label)
  }
  assert.equal(balance(G), 150)
  assert.deepEqual(travel(G).location?.label, 'Mokola, Ibadan')
})

// ── 11–13 Time, idempotence, money safety ──

check('11 documents expire: on tick and on any read, and an expired passport blocks the border', () => {
  // B is in Accra with a passport; C is in Nairobi with a passport and a Kenya visa.
  assert.equal(quote(B, lome).requirements[0]!.met, true)
  now = Date.parse(travel(C).visas[0]!.validUntil!) - SECOND
  assert.equal(travel(C).visas[0]!.status, 'valid')
  now += SECOND
  assert.equal(travel(C).visas[0]!.status, 'expired', 'expired on read, without a tick')
  now = Date.parse(travel(B).passport.expiresAt!) - SECOND
  assert.equal(quote(B, lome).requirements[0]!.met, true)
  now += SECOND
  // No tick has run: the booking still sees the expiry.
  rejects('forbidden', () => book(B, lome), /^Your passport has expired\. Renew it from Travel\.$/)
  const offer = quote(B, lome)
  assert.deepEqual([offer.requirements[0]!.kind, offer.requirements[0]!.met, offer.allowed], ['passport', false, false])
  assert.equal(travel(B).passport.status, 'expired')
  world.tick()
  assert.equal(travel(B).passport.status, 'expired')
  assert.equal(pushed(B).at(-1)!.passport.status, 'expired')
  assert.equal(travel(B).location?.label, 'Osu, Accra')
  // Expired documents can be applied for again; a still-valid one could not (checks 6 and 7).
  earn(B, 400)
  const renewed = world.call(B, 'travel.passportApply', {}).state
  assert.equal(renewed.passport.status, 'processing')
  assert.equal(ledger(B)[0]!.text, 'Passport renewal')
  wait(TRAVEL.passport.seconds)
  assert.equal(quote(B, lome).requirements[0]!.met, true)
})

check('12 booking twice in transit is a conflict and charges one fare; time settles without a tick', () => {
  arriveAt(K, ibadan)
  const fare = termsFrom(ibadan, lagos).fare
  book(K, lagos)
  rejects('conflict', () => book(K, lagos), /^You are travelling\. You arrive in 15 seconds\.$/)
  rejects('conflict', () => book(K, abuja), /You are travelling/)
  assert.deepEqual([quote(K, abuja).allowed, quote(K, abuja).reason], [false, 'You are travelling. You arrive in 15 seconds.'])
  assert.equal(balance(K), 150 - fare)
  assert.equal(ledger(K).filter(entry => entry.kind === 'fare').length, 1)
  // The clock passes the arrival time with no tick: the next request lands the trip first.
  now += 15 * SECOND
  assert.equal(enter(K, lagos).snapshot.ref.kind, 'district')
  assert.deepEqual([travel(K).location?.label, travel(K).trip], ['Yaba, Lagos', null])
  assert.equal(notes(K, 'travel.arrived').length, 1)
  world.tick()
  assert.equal(notes(K, 'travel.arrived').length, 1)
  assert.equal(travel(K).recentTrips.length, 1)
  // Back again: a stale quote is worth nothing, the fare is worked out at booking from where the avatar now is.
  const stale = quote(K, ibadan)
  assert.equal(stale.allowed, false, 'only 65 coins left')
  rejects('conflict', () => book(K, stale.to), /You need 20 more coins/)
  assert.equal(balance(K), 150 - fare)
})

check('13 wallet safety: no negative balance anywhere, spends are refused whole, earnings are logged not minted', () => {
  rejects('conflict', () => spendPoints(world, K, 66), /^You need 1 more coin\./)
  rejects('invalid', () => spendPoints(world, K, -5))
  rejects('invalid', () => spendPoints(world, K, Number.NaN))
  assert.equal(careerPoints(world, K), 65)
  spendPoints(world, K, 0)
  assert.equal(careerPoints(world, K), 65)
  recordEarning(world, K, 30, 'work', 'Shift at Corner café')
  assert.equal(balance(K), 65, 'recording an earning adds no coins')
  assert.deepEqual([ledger(K)[0]!.kind, ledger(K)[0]!.amount, ledger(K)[0]!.text, ledger(K)[0]!.balanceAfter], ['work', 30, 'Shift at Corner café', 65])
  recordEarning(world, K, -10, 'game', 'not an earning')
  assert.equal(ledger(K)[0]!.kind, 'work')
  for (let index = 0; index < 70; index++) recordEarning(world, K, 1, 'game', `Game ${index}`)
  const entries = ledger(K)
  assert.equal(entries.length, 60, 'the ledger keeps the last 60')
  assert.equal(entries[0]!.text, 'Game 69', 'newest first')
  for (const name of names) {
    const member = id(name)
    assert.ok(careerPoints(world, member) >= 0, `${name} balance`)
    assert.ok(pushed(member).every(state => state.balance >= 0), `${name} pushed balances`)
    assert.ok(ledger(member).every(entry => entry.balanceAfter >= 0 && Number.isInteger(entry.amount)), `${name} ledger`)
    assert.ok(travel(member).recentTrips.length <= 10)
  }
})

// ── 14–15 Members without a location, restarts ──

check('14 a member with no location may look at one place, not roam; a restart keeps trips and coins', () => {
  const fresh = id('fresh')
  ensureMember(world, fresh, 'Fresh member')
  assert.equal(enter(fresh, manchester).snapshot.ref.kind, 'district')
  rejects('forbidden', () => enter(fresh, ibadan), /^Choose where you are first/)
  assert.equal(travel(fresh).balance, 0)
  assert.ok(roomOf(world, fresh))
  arriveAt(fresh, ibadan)
  assert.equal(roomOf(world, fresh), null, 'arriving in Ibadan takes the avatar out of the Manchester street')
  assert.equal(enter(fresh, ibadan).snapshot.ref.kind, 'district')
  rejects('forbidden', () => enter(fresh, manchester), /Book a trip/)

  // E leaves for Lagos; the service restarts mid-trip.
  const before = balance(E)
  book(E, lagos)
  world.flush()
  world = makeWorld()
  assert.equal(travel(E).trip?.status, 'in-transit')
  assert.equal(balance(E), before - termsFrom(ibadan, lagos).fare)
  rejects('conflict', () => book(E, lagos), /You are travelling/)
  wait(15)
  assert.deepEqual([travel(E).location?.label, travel(E).trip], ['Yaba, Lagos', null])
  assert.equal(travel(B).passport.status, 'valid')
  assert.equal(travel(A).homeCountry, 'NG')
})

check('15 a member from before travel existed starts where they said they are, once', () => {
  world.flush()
  // Drop the travel records, as if the module had just been added.
  delete stored!.travel
  world = makeWorld()
  const profile = world.call(H, 'member.me', {}).profile
  assert.equal(profile.currentArea?.label, 'Bodija, Ibadan')
  const state = travel(H)
  assert.deepEqual([state.location?.label, state.location?.countryCode, state.homeCountry], ['Bodija, Ibadan', 'NG', 'NG'])
  assert.deepEqual(Object.keys(state.location!).sort(), Object.keys(ibadan).sort(), 'the location is a plain area')
  const coins = balance(H)
  travel(H)
  arriveAt(H, ibadan)
  assert.equal(balance(H), coins)
  assert.equal(ledger(H).filter(entry => entry.kind === 'starting').length, 1)
  rejects('forbidden', () => world.call(H, 'member.setBrowsing', { area: nairobi }), /Book a trip/)
})

if (!failed) console.log('ALL PASS')
