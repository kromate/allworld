// Stations inside a venue room: the counter, the tables, a market stall. The world engine publishes
// them and walks the avatar to one; this module picks the right one for an activity and says when
// the avatar has got there. It never moves a meter, a coin or a shift: those stay with the service.
import { distance } from '../../shared/geo.ts'
import { watch } from 'vue'
import type { InteriorStation, InteriorStationKind } from '../../world/interior.ts'
import { getEngine, world } from '../../state/world.ts'

/** The engine sets the avatar exactly on a station when it arrives, so anything this close is "there". */
const ARRIVED_WITHIN = 0.1
const WATCHDOG_MS = 1000
/** No movement for this long while still short of the station means the walk was broken off. */
const STALLED_MS = 3000
/** Another member this close to a seat has taken it. */
const TAKEN_WITHIN = 0.6

export type { InteriorStation, InteriorStationKind }

export const stationsHere = (): readonly InteriorStation[] => getEngine()?.interiorStations ?? []

/** The station the avatar is standing or sitting at, if any. */
export function stationAt(): InteriorStation | null {
  const engine = getEngine()
  if (!engine) return null
  const me = engine.position
  return engine.interiorStations.find(station => distance(station.position, me) < ARRIVED_WITHIN) ?? null
}

/**
 * Stations of the wanted kinds, best first: the order of `kinds` decides, then one nobody else is
 * at, then the nearest. Empty when this room has none of them.
 */
export function stationsFor(kinds: readonly InteriorStationKind[]): InteriorStation[] {
  const engine = getEngine()
  if (!engine) return []
  const me = engine.position
  const taken = (station: InteriorStation): boolean => world.members.some(member => distance(member.pos, station.position) < TAKEN_WITHIN)
  return engine.interiorStations
    .filter(station => kinds.includes(station.kind))
    .map(station => ({ station, kind: kinds.indexOf(station.kind), taken: taken(station) ? 1 : 0, metres: distance(station.position, me) }))
    .sort((a, b) => a.kind - b.kind || a.taken - b.taken || a.metres - b.metres)
    .map(entry => entry.station)
}

export type ApproachEnd = 'arrived' | 'stalled' | 'left'

/**
 * Walk to one of these stations, trying each in turn until the engine finds a way to one. Calls
 * `done` once: on arrival, when the walk stops short, or when the room changes under it. Returns
 * the station being walked to and a way to call it off, or null when none can be reached.
 * The caller decides who may steer meanwhile (see `lockInput` with `preserveWalking`).
 */
export function approach(candidates: readonly InteriorStation[], done: (end: ApproachEnd, station: InteriorStation) => void): { station: InteriorStation; cancel(): void } | null {
  const engine = getEngine()
  if (!engine) return null
  const station = candidates.find(candidate => engine.walkToStation(candidate.id))
  if (!station) return null
  const room = world.roomKey
  let last = engine.position, still = 0
  let settled = false
  const finish = (end: ApproachEnd): void => {
    if (settled) return
    settled = true; window.clearInterval(timer); stopWatching(); done(end, station)
  }
  const inspect = (): void => {
    const now = getEngine()
    if (!now || world.roomKey !== room || !now.interiorStations.some(entry => entry.id === station.id)) { finish('left'); return }
    const at = now.position
    if (distance(at, station.position) < ARRIVED_WITHIN) { finish('arrived'); return }
  }
  const stopWatching = watch(() => [world.station?.id, world.roomKey], inspect, { flush: 'post' })
  const timer = window.setInterval(() => {
    inspect()
    if (settled) return
    const at = engine.position
    still = document.hidden ? 0 : distance(at, last) < 0.02 ? still + WATCHDOG_MS : 0
    last = at
    if (still >= STALLED_MS) finish('stalled')
  }, WATCHDOG_MS)
  return {
    station,
    cancel() {
      if (settled) return
      settled = true; window.clearInterval(timer); stopWatching()
      // Only call off the walk this approach started: in another room the engine has already dropped it.
      if (world.roomKey === room) getEngine()?.stop()
    },
  }
}

/** How a station reads in a sentence: "the counter", "a table", "a stall". */
export const STATION_WORDS: Record<InteriorStationKind, { the: string; at: string }> = {
  counter: { the: 'the counter', at: 'at the counter' },
  till: { the: 'the till', at: 'at the till' },
  table: { the: 'a table', at: 'at a table' },
  stall: { the: 'a stall', at: 'at a stall' },
  shelf: { the: 'the shelves', at: 'at the shelves' },
  bench: { the: 'a bench', at: 'on a bench' },
  'ticket-desk': { the: 'the ticket desk', at: 'at the ticket desk' },
}
