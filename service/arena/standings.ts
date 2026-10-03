// Ratings, coins, the member's home area and the standings tables.
//
// Privacy: a table is scoped to a state or a country, but a row never says where anyone is — it
// carries a name, a portrait and a rating. A member can leave the public tables altogether.
import type { CommunityId, MemberId } from '../../src/shared/ids.ts'
import { iso } from '../../src/shared/ids.ts'
import { ARENA } from '../../src/shared/arena.ts'
import type { ArenaGame, ArenaHome, MyStanding, StandingRow, StandingScope, StandingView, Standings } from '../../src/shared/arena.ts'
import { STANDING_SCOPES } from '../../src/shared/arena.ts'
import { WorldError } from '../../src/shared/model.ts'
import type { CoarseArea } from '../../src/shared/model.ts'
import { STARTER_PLACES } from '../../src/shared/places.ts'
import { isoWeek } from '../../src/shared/play.ts'
import type { World } from '../kernel.ts'
import { exists, friendsOf, isBlockedEitherWay, lookFor, record } from '../members.ts'
import { communityMemberIds, communityName, isCommunityMember } from '../social.ts'
import { addPoints } from '../work.ts'
import { arena, dayOf } from './state.ts'
import type { HomeRec, RatingRec } from './state.ts'

// ── Ratings ──

const fresh = (now: number): RatingRec => ({ rating: ARENA.rating.start, played: 0, won: 0, drawn: 0, lost: 0, since: now, week: '', weekWins: 0, weekAt: 0 })

/** The member's record in a game, without creating one. */
export function ratingOf(world: World, memberId: MemberId, game: ArenaGame): RatingRec {
  return arena(world).ratings[memberId]?.[game] ?? fresh(world.now())
}
export const isProvisional = (rec: RatingRec): boolean => rec.played < ARENA.rating.provisionalGames
const kFor = (played: number): number => ARENA.rating.k.find(step => played < step.under)?.k ?? ARENA.rating.kSettled

/**
 * One finished rated game between two members. `scoreA` is 1, 0.5 or 0 for the first of them.
 * Returns each one's change. Elo: expected = 1 / (1 + 10^((other − mine) / 400)); change = K × (score − expected).
 */
export function settleRatings(world: World, game: ArenaGame, a: MemberId, b: MemberId, scoreA: number, now: number): [number, number] {
  const data = arena(world)
  const recA = ((data.ratings[a] ??= {})[game] ??= fresh(now))
  const recB = ((data.ratings[b] ??= {})[game] ??= fresh(now))
  const expectedA = 1 / (1 + 10 ** ((recB.rating - recA.rating) / 400))
  const changeA = Math.round(kFor(recA.played) * (scoreA - expectedA))
  const changeB = Math.round(kFor(recB.played) * ((1 - scoreA) - (1 - expectedA)))
  const week = isoWeek(now).label
  const apply = (rec: RatingRec, change: number, score: number): number => {
    const next = Math.max(ARENA.rating.floor, rec.rating + change)
    const applied = next - rec.rating
    rec.rating = next
    rec.played++
    if (score === 1) rec.won++; else if (score === 0) rec.lost++; else rec.drawn++
    if (applied !== 0 || rec.played === 1) rec.since = now
    if (rec.week !== week) { rec.week = week; rec.weekWins = 0; rec.weekAt = 0 }
    if (score === 1) { rec.weekWins++; rec.weekAt = now }
    return applied
  }
  const out: [number, number] = [apply(recA, changeA, scoreA), apply(recB, changeB, 1 - scoreA)]
  // Everyone with a rating has a home on record, so the state and country tables can place them.
  homeOf(world, a); homeOf(world, b)
  world.touch()
  return out
}

// ── Coins ──

/** Pay a win, up to today's cap for that kind of win. Returns what was actually paid. */
export function payWin(world: World, memberId: MemberId, kind: 'computer' | 'human', amount: number, text: string, now: number): number {
  const data = arena(world)
  const today = dayOf(now)
  let rec = data.pay[memberId]
  if (!rec || rec.day !== today) rec = data.pay[memberId] = { day: today, computer: 0, human: 0 }
  const paid = Math.max(0, Math.min(amount, ARENA.pay.dailyCap[kind] - rec[kind]))
  if (paid > 0) {
    rec[kind] += paid
    addPoints(world, memberId, paid, { kind: 'game', text })
  }
  world.touch()
  return paid
}

const pairKey = (a: MemberId, b: MemberId): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
/** Counted games these two have already finished today. */
export function pairGamesToday(world: World, a: MemberId, b: MemberId, now: number): number {
  const rec = arena(world).pairs[pairKey(a, b)]
  return rec && rec.day === dayOf(now) ? rec.count : 0
}
export function countPairGame(world: World, a: MemberId, b: MemberId, now: number): void {
  const data = arena(world)
  const key = pairKey(a, b), today = dayOf(now)
  const rec = data.pairs[key]
  if (rec && rec.day === today) rec.count++
  else data.pairs[key] = { day: today, count: 1 }
  world.touch()
}

// ── Home area ──

let regionNames: Intl.DisplayNames | null = null
const countryName = (code: string): string => {
  try { return (regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })).of(code) ?? code } catch { return code }
}
const cleanRegion = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : null)
/** "Lagos" and "Lagos State" are one table; so are "São Paulo" and "Sao Paulo". */
const regionKey = (region: string): string => region.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+state$/, '').trim()

/**
 * The member's home: the country of their first arrival (the travel module records it) and the
 * first-level area of the place they named there. Fixed once a region is known. An area saved
 * before regions existed has none, so the member is in the country and global tables only until
 * they set their area again.
 */
function regionOf(area: CoarseArea): string | null {
  const region = cleanRegion(area.region)
  if (region) return region
  // Old starter records can recover their known region without reconfirming anyone's location.
  const known = STARTER_PLACES.find(place => place.label === area.label && place.countryCode === area.countryCode.toUpperCase() && place.anchor.lat === area.anchor.lat && place.anchor.lon === area.anchor.lon)
  return cleanRegion(known?.region)
}

export function homeOf(world: World, memberId: MemberId): HomeRec | null {
  const data = arena(world)
  const saved = data.homes[memberId]
  if (saved?.region) return saved
  if (!exists(world, memberId)) return saved ?? null
  const profile = record(world, memberId).profile
  const areas = [profile.currentArea, profile.browsing].filter(area => area !== null && area !== undefined)
  const travelHome = world.peek<{ members?: Record<string, { homeCountry?: string | null }> }>('travel')?.members?.[memberId]?.homeCountry
  const country = (saved?.countryCode ?? travelHome ?? areas[0]?.countryCode ?? '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(country) || country === 'ZZ') return null
  const region = areas.filter(area => area.countryCode.toUpperCase() === country).map(regionOf).find(value => value !== null) ?? null
  if (!saved || saved.countryCode !== country || saved.region !== region) {
    data.homes[memberId] = { countryCode: country, region }
    world.touch()
  }
  return data.homes[memberId]!
}

export function homeView(world: World, memberId: MemberId): ArenaHome {
  const home = homeOf(world, memberId)
  return { countryCode: home?.countryCode ?? null, countryName: home ? countryName(home.countryCode) : null, region: home?.region ?? null }
}

export const isPublic = (world: World, memberId: MemberId): boolean => arena(world).hidden[memberId] !== true
export function setPublic(world: World, memberId: MemberId, shown: boolean): void {
  const data = arena(world)
  if (shown) delete data.hidden[memberId]; else data.hidden[memberId] = true
  world.touch()
}

// ── Standings ──

const RULES: Record<StandingView, string> = {
  rating: 'Ranked by rating. On a tie, more rated games ranks higher, then whoever got there first. Only rated games between two members count; games against the computer never do.',
  week: 'Most rated wins since Monday 00:00 UTC. On a tie, whoever got there first ranks higher. Games against the computer never count.',
}

interface Ranked { id: MemberId; rec: RatingRec }

export function standings(world: World, viewer: MemberId, game: ArenaGame, scope: StandingScope, view: StandingView, communityId: CommunityId | null): Standings {
  const data = arena(world)
  const now = world.now()
  const week = isoWeek(now)
  const rated = (): MemberId[] => Object.keys(data.ratings) as MemberId[]
  let pool: MemberId[] = []
  let scopeName: string | null = null
  let note: string | null = null
  const publicOnly = scope === 'state' || scope === 'country' || scope === 'global'

  if (scope === 'friends') pool = [viewer, ...friendsOf(world, viewer)]
  else if (scope === 'community') {
    if (!communityId || !isCommunityMember(world, communityId, viewer)) throw new WorldError('forbidden', 'Join the community to see its standings.')
    pool = communityMemberIds(world, communityId)
    scopeName = communityName(world, communityId)
  } else if (scope === 'global') pool = rated()
  else {
    const home = homeOf(world, viewer)
    if (!home) note = 'Choose your area to join the standings for your state and your country.'
    else if (scope === 'country') {
      scopeName = countryName(home.countryCode)
      pool = rated().filter(id => homeOf(world, id)?.countryCode === home.countryCode)
    } else if (!home.region) note = 'Set your area again to join your state’s standings.'
    else {
      const key = regionKey(home.region)
      scopeName = home.region
      pool = rated().filter(id => { const other = homeOf(world, id); return other?.countryCode === home.countryCode && other.region !== null && regionKey(other.region) === key })
    }
  }

  const ranked: Ranked[] = []
  for (const id of new Set(pool)) {
    const rec = data.ratings[id]?.[game]
    if (!rec || !exists(world, id) || isBlockedEitherWay(world, viewer, id)) continue
    if (publicOnly && !isPublic(world, id)) continue
    if (view === 'rating' ? rec.played < 1 : rec.week !== week.label || rec.weekWins < 1) continue
    ranked.push({ id, rec })
  }
  if (view === 'rating') ranked.sort((a, b) => b.rec.rating - a.rec.rating || b.rec.played - a.rec.played || a.rec.since - b.rec.since || (a.id < b.id ? -1 : 1))
  else ranked.sort((a, b) => b.rec.weekWins - a.rec.weekWins || a.rec.weekAt - b.rec.weekAt || (a.id < b.id ? -1 : 1))

  const row = (entry: Ranked, index: number): StandingRow => ({
    rank: index + 1, memberId: entry.id, displayName: record(world, entry.id).profile.displayName, look: lookFor(world, viewer, entry.id),
    rating: entry.rec.rating, provisional: isProvisional(entry.rec), played: entry.rec.played, won: entry.rec.won,
    weekWins: entry.rec.week === week.label ? entry.rec.weekWins : 0, isMe: entry.id === viewer,
    since: iso(view === 'rating' ? entry.rec.since : entry.rec.weekAt),
  })
  const mine = ranked.findIndex(entry => entry.id === viewer)
  if (mine < 0 && !note) {
    const own = data.ratings[viewer]?.[game]
    if (publicOnly && !isPublic(world, viewer)) note = `You are hidden from public standings, so you are not ranked here. Your rating is ${own?.rating ?? ARENA.rating.start}.`
    else if (!own || own.played < 1) note = 'Finish a rated game against another member to get on the table.'
    else if (view === 'week') note = 'Win a rated game this week to get on the table.'
  }
  return {
    game, scope, view, scopeName, rows: ranked.slice(0, ARENA.standingsTop).map(row), me: mine >= 0 ? row(ranked[mine]!, mine) : null,
    total: ranked.length, note, week: view === 'week' ? week.label : null, resetsAt: view === 'week' ? iso(week.endsAt) : null, rules: RULES[view],
  }
}

export function myStanding(world: World, viewer: MemberId, game: ArenaGame, communityId: CommunityId | null): MyStanding {
  const rec = ratingOf(world, viewer, game)
  const week = isoWeek(world.now()).label
  const places: MyStanding['places'] = []
  for (const scope of STANDING_SCOPES) {
    if (scope === 'community' && !(communityId && isCommunityMember(world, communityId, viewer))) continue
    const table = standings(world, viewer, game, scope, 'rating', communityId)
    places.push({ scope, name: table.scopeName, rank: table.me?.rank ?? null, of: table.total, note: table.note })
  }
  return {
    game, rating: rec.rating, provisional: isProvisional(rec), played: rec.played, won: rec.won, drawn: rec.drawn, lost: rec.lost,
    weekWins: rec.week === week ? rec.weekWins : 0, places,
  }
}
