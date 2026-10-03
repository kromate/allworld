// Going to work, as a journey: pick a mapped place that can host the job, walk there, go in, reach
// the counter, and only then start the shift. This module holds the journey; the service still
// issues the tickets, judges them and pays. It also keeps the walk alive when a window opens over
// the world, and says in a sentence why a workplace cannot be reached.
import { reactive } from 'vue'
import type { Poi } from '../../geo/district.ts'
import type { DistrictId } from '../../shared/ids.ts'
import { distance } from '../../shared/geo.ts'
import { hostsWork } from '../../shared/play.ts'
import type { Shift, Workplace } from '../../shared/play.ts'
import { api, attempt, onAccountReset, toast } from '../../state/app.ts'
import { roughly } from '../../state/life.ts'
import { enterVenue, getEngine, getStreetContext, leaveInterior, walkToPlace, world } from '../../state/world.ts'
import { STATION_WORDS, approach, stationAt, stationsFor } from './stations.ts'
import type { InteriorStation } from './stations.ts'

export type TripStage = 'leaving' | 'walking' | 'entering' | 'inside' | 'ready' | 'stopped'

export interface Trip {
  workplace: Workplace
  poi: Poi
  districtId: DistrictId
  stage: TripStage
  /** Walking metres left to the door. Null once inside, or before a route is known. */
  metres: number | null
  /** True from the moment the avatar is in the venue's room. */
  indoors: boolean
  /** Where the job is done. Null when the room has no station for it: the job is done on the floor. */
  station: InteriorStation | null
  /** Why the journey stopped, in a sentence. */
  problem: string
  /** Walks to the station that did not get there. After two, the shift may start from the floor. */
  misses: number
}

/** A mapped place that can host a job. `metres` is a walk when `routed`, a straight line otherwise. */
export interface WorkSpot { poi: Poi; metres: number; routed: boolean }
export interface WorkOptions {
  spots: WorkSpot[]
  /** Hosts on this district's map, reachable or not. */
  mapped: number
  /** The nearest host with no walking route from here, when there is one. */
  cut: Poi | null
}

export const work = reactive({
  workplaces: [] as Workplace[],
  loaded: false,
  /** The shift that is open on the service, as far as this tab knows. */
  active: null as Shift | null,
  trip: null as Trip | null,
  starting: false,
  /** Per workplace id: where the job can be done from here. Missing until looked for. */
  options: {} as Record<string, WorkOptions>,
  searching: false,
})

/** Route searches per job. The nearest few by straight line are the only ones worth a search. */
const ROUTE_CANDIDATES = 4
const WATCH_MS = 400
const STALLED_MS = 3000
const PROGRESS_MS = 2000

export async function loadWork(): Promise<void> {
  try {
    const result = await api('work.places', {})
    work.workplaces = result.workplaces
    work.active = result.active
    work.loaded = true
  } catch { /* the Work window says so when it is opened; the prompts simply stay away */ }
}

const inside = (poi: Poi): boolean => world.kind === 'venue' && world.venue?.placeId === poi.placeId
// Asked afresh each time: the scene changes while a journey waits on a door.
const onStreet = (): boolean => world.kind === 'district'

/** Jobs the venue the member is standing in can host. */
export const jobsHere = (): Workplace[] => {
  const venue = world.kind === 'venue' ? world.venue : null
  return venue ? work.workplaces.filter(workplace => hostsWork(workplace, venue.category, venue.subclass)) : []
}

// ── Where the work is ──

const pause = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
let searchRun = 0

/**
 * Look for places that can host each job. On the street the nearest few are measured along the
 * streets, one search at a time so the window stays responsive; indoors there is no street route to
 * measure, so they are listed by straight line from the door.
 */
export async function findWork(): Promise<void> {
  const run = ++searchRun
  work.searching = true
  for (const workplace of work.workplaces) {
    const origin = getStreetContext()
    const hosts = origin
      ? world.places.filter(poi => hostsWork(workplace, poi.category, poi.subclass)).map(poi => ({ poi, straight: distance(poi.pos, origin.position) })).sort((a, b) => a.straight - b.straight)
      : []
    const spots: WorkSpot[] = []
    let cut: Poi | null = null
    for (const host of hosts.slice(0, ROUTE_CANDIDATES)) {
      if (inside(host.poi)) { spots.push({ poi: host.poi, metres: 0, routed: true }); continue }
      if (!onStreet()) { spots.push({ poi: host.poi, metres: host.straight, routed: false }); continue }
      await pause()
      if (run !== searchRun) return
      const metres = onStreet() ? getEngine()?.routeLength(host.poi.pos) ?? null : null
      if (metres === null) cut ??= host.poi
      else spots.push({ poi: host.poi, metres, routed: true })
    }
    work.options[workplace.id] = { spots: spots.sort((a, b) => a.metres - b.metres), mapped: hosts.length, cut }
  }
  if (run === searchRun) work.searching = false
}

// ── The journey ──

let covered = false
let watch = 0
let walkHandle: { cancel(): void } | null = null
let lastAt: { x: number; z: number } | null = null
let still = 0, sinceProgress = 0

/** A window is open over the world. The stage locks walking then; a journey asks for it to carry on. */
function keepWalking(): void { if (covered) getEngine()?.lockInput(true, { preserveWalking: true }) }

/** Told by the world prompt when a window opens or closes over the world. */
export function setCovered(open: boolean): void {
  covered = open
  if (open && work.trip) keepWalking()
}

function stopWatching(): void { window.clearInterval(watch); watch = 0; walkHandle?.cancel(); walkHandle = null }

function halt(problem: string): void {
  if (!work.trip) return
  walkHandle = null
  work.trip.stage = 'stopped'
  work.trip.problem = problem
}

export function cancelTrip(): void {
  const walking = work.trip?.stage === 'walking'
  stopWatching()
  if (walking) getEngine()?.stop()
  work.trip = null
}

export async function beginTrip(workplace: Workplace, poi: Poi): Promise<void> {
  cancelTrip()
  const districtId = world.districtId
  if (!districtId) { toast('The street has not loaded yet. Try again in a moment.', 'info'); return }
  work.trip = { workplace, poi, districtId, stage: 'walking', metres: null, indoors: false, station: null, problem: '', misses: 0 }
  watch = window.setInterval(look, WATCH_MS)
  await setOff()
}

/** Start, or start again, whichever leg of the journey the avatar is on. */
export function resumeTrip(): void { walkHandle?.cancel(); walkHandle = null; void setOff() }

async function setOff(): Promise<void> {
  const trip = work.trip
  if (!trip) return
  trip.problem = ''
  if (inside(trip.poi)) { toStation(); return }
  if (!onStreet()) {
    trip.stage = 'leaving'
    await leaveInterior()
    if (work.trip !== trip) return
    if (!onStreet()) { halt('The street did not load. Try again from the street.'); return }
  }
  if (world.districtId !== trip.districtId) { cancelTrip(); toast(`${trip.poi.name} is in another district, so the walk to work was called off.`, 'info'); return }
  if (world.nearVenue?.placeId === trip.poi.placeId) { void goIn(); return }
  keepWalking()
  const route = walkToPlace(trip.poi)
  if (!route || ('status' in route && route.status === 'unreachable')) { halt(`There is no walking route to ${trip.poi.name} from where you stand. Walk closer, or pick another place.`); return }
  // Already standing where the walk would end: that is the door, so go in.
  if ('status' in route && route.status === 'arrived') { void goIn(); return }
  trip.stage = 'walking'
  trip.metres = route.length || null
  lastAt = null; still = 0; sinceProgress = 0
}

async function goIn(): Promise<void> {
  const trip = work.trip
  if (!trip || trip.stage === 'entering') return
  trip.stage = 'entering'
  await enterVenue(trip.poi)
  if (work.trip !== trip) return
  if (inside(trip.poi)) toStation()
  // The stage shows why the door did not open; the journey has nothing to add.
  else cancelTrip()
}

function toStation(): void {
  const trip = work.trip
  if (!trip) return
  trip.indoors = true
  trip.metres = null
  const candidates = stationsFor(trip.workplace.stations)
  const here = stationAt()
  if (!candidates.length || trip.misses >= 2) { trip.station = null; trip.stage = 'ready'; return }
  if (here && candidates.some(candidate => candidate.id === here.id)) { trip.station = here; trip.stage = 'ready'; return }
  keepWalking()
  const walk = approach(candidates, (end, station) => {
    if (work.trip !== trip) return
    walkHandle = null
    if (end === 'arrived') { trip.station = station; trip.stage = 'ready'; return }
    if (end === 'left') { cancelTrip(); return }
    trip.misses++
    halt(`You stopped short of ${STATION_WORDS[station.kind].the}.`)
  })
  if (!walk) { trip.misses++; halt(`There is no clear way to ${STATION_WORDS[candidates[0]!.kind].the} from where you stand.`); return }
  walkHandle = walk
  trip.station = walk.station
  trip.stage = 'inside'
}

/** Keeps the journey honest about where the avatar really is. Runs only while there is a journey. */
function look(): void {
  const trip = work.trip
  if (!trip) { stopWatching(); return }
  if (world.state !== 'ready' || trip.stage === 'leaving' || trip.stage === 'entering') return
  if (trip.stage === 'ready') {
    // Walked out of the room: the journey is over. Stepped off the station: say so, and offer the way back.
    if (!inside(trip.poi)) { cancelTrip(); return }
    if (trip.station && stationAt()?.id !== trip.station.id) halt(`You stepped away from ${STATION_WORDS[trip.station.kind].the}.`)
    return
  }
  if (trip.stage === 'inside') { if (!inside(trip.poi)) cancelTrip(); return }
  // Walking, or stopped on the way: going in by the door picks the journey up either way.
  if (inside(trip.poi)) { if (!trip.indoors) toStation(); return }
  if (!onStreet() || world.districtId !== trip.districtId) {
    if (trip.indoors || world.districtId !== trip.districtId) cancelTrip()
    else if (trip.stage === 'walking') halt(`You turned off on the way to ${trip.poi.name}.`)
    return
  }
  if (trip.indoors) { cancelTrip(); return }
  if (trip.stage !== 'walking') return
  if (world.nearVenue?.placeId === trip.poi.placeId) { void goIn(); return }
  const engine = getEngine()
  if (!engine) return
  const at = engine.position
  still = lastAt && distance(at, lastAt) < 0.05 ? still + WATCH_MS : 0
  lastAt = at
  if (still >= STALLED_MS) { halt(`You stopped on the way to ${trip.poi.name}.`); return }
  sinceProgress += WATCH_MS
  if (sinceProgress >= PROGRESS_MS) { sinceProgress = 0; trip.metres = engine.routeLength(trip.poi.pos) ?? trip.metres }
}

/** Where the journey stands, in a sentence for the prompt and the Work window. */
export function tripLine(trip: Trip): string {
  const place = trip.poi.name
  switch (trip.stage) {
    case 'leaving': return `Stepping out to walk to ${place}`
    case 'walking': return `Walking to ${place}${trip.metres ? ` · ${roughly(trip.metres)}` : ''}`
    case 'entering': return `Going into ${place}`
    case 'inside': return `Walking to ${trip.station ? STATION_WORDS[trip.station.kind].the : 'your place'} in ${place}`
    case 'ready': return trip.station ? `You are ${STATION_WORDS[trip.station.kind].at} in ${place}` : `You are on the floor of ${place}`
    case 'stopped': return trip.problem
  }
}

/** Where a placed shift is being worked, for a heading: "at the counter". Empty when the avatar is not there. */
export function standingWords(): string {
  const station = stationAt()
  return station ? STATION_WORDS[station.kind].at : ''
}

/**
 * Start the shift the journey was for. The service places it from the room it finds the member in,
 * so the shift that comes back says whether it counted as worked at the place.
 */
export async function startPlacedShift(): Promise<Shift | null> {
  const trip = work.trip
  if (!trip || trip.stage !== 'ready' || work.starting) return null
  work.starting = true
  const started = await attempt('work.start', { workplaceId: trip.workplace.id, venueName: trip.poi.name.slice(0, 80) })
  work.starting = false
  if (!started) return null
  stopWatching()
  work.trip = null
  work.active = started.shift.status === 'active' ? started.shift : null
  return started.shift
}

const stopReset = onAccountReset(() => { cancelTrip(); searchRun++; Object.assign(work, { workplaces: [], loaded: false, active: null, starting: false, options: {}, searching: false }) })

// In development a hot update runs this module again: the old copy must let go of its timer.
if (import.meta.hot) import.meta.hot.dispose(() => { stopReset(); stopWatching() })
