// Travel state shared by the whole App: where the avatar is, the trip in progress, and the one
// place that reacts to an arrival. Windows read this; they do not each handle arrivals.
import { reactive, watch } from 'vue'
import type { LedgerEntry, TravelState } from '../shared/travel.ts'
import { api, app, messageOf, onAccountReset, onReconnect, onServerEvent, refreshMe, refreshPoints, toast } from './app.ts'
import { enterArea, setArrivalTarget, world } from './world.ts'

export const travel = reactive({ state: null as TravelState | null, ledger: [] as LedgerEntry[], loaded: false, error: '' })

/** Seconds left on the trip in progress, or 0. */
export function secondsLeft(now = Date.now()): number {
  const trip = travel.state?.trip
  return trip ? Math.max(0, Math.ceil((Date.parse(trip.arrivesAt) - now) / 1000)) : 0
}

const arrivalListeners = new Set<() => void>()
let accountGeneration = 0
let stateRevision = 0
/** The shell navigates back to the world when the avatar arrives. */
export function onArrival(listener: () => void): () => void { arrivalListeners.add(listener); return () => arrivalListeners.delete(listener) }

async function apply(next: TravelState, pushed = false): Promise<void> {
  const account = accountGeneration
  stateRevision++
  const before = travel.state
  travel.state = next
  app.points = next.balance
  travel.loaded = true
  // The avatar has left the street: the scene behind the window is no longer where they are. A
  // read can be the first to say so, when the booking's own answer was lost with the link.
  if (!before?.trip && next.trip && (pushed || before)) { world.state = 'idle'; world.roomKey = null; world.members = []; world.chat = [] }
  // A trip that was booked and finished while the link was down still ends in an arrival: it is
  // the new entry at the head of the recent trips.
  const landed = before && !next.trip && next.location && (before.trip || next.recentTrips[0]?.id !== before.recentTrips[0]?.id)
  if (!landed || !next.location) return
  await Promise.all([refreshMe().catch(() => undefined), refreshPoints()])
  if (account !== accountGeneration || travel.state?.trip || travel.state?.location?.arrivalDistrict !== next.location.arrivalDistrict) return
  for (const listener of arrivalListeners) listener()
  // Remember where we are meant to be until the scene is really up, so a retry goes there too.
  setArrivalTarget(next.location)
  const entered = await enterArea(next.location)
  // The street may have finished loading for someone who has since left; it is no longer ours to announce.
  if (entered && account === accountGeneration) { setArrivalTarget(null); toast(`Welcome to ${next.location.label}.`, 'good') }
}

async function read(): Promise<TravelState | null> {
  const account = accountGeneration
  const revision = stateRevision
  try {
    const result = await api('travel.state', {})
    if (account !== accountGeneration) return null
    travel.ledger = result.ledger
    travel.error = ''
    // The state is in place as soon as this is called; a read does not wait for the street an arrival then loads.
    if (revision === stateRevision) void apply(result.state)
  } catch (error) {
    if (account !== accountGeneration) return null
    travel.loaded = true
    travel.error = messageOf(error)
  }
  return travel.state
}

// One read at a time. A read that is already on its way may have left before the caller's own
// change (a booking, a visa), so a caller who asks meanwhile gets one more read that starts after
// it: never two at once, and never an answer older than the question.
let reading: Promise<TravelState | null> | null = null
let followUp: Promise<TravelState | null> | null = null
export function loadTravel(): Promise<TravelState | null> {
  const account = accountGeneration
  if (!reading) {
    const current = read().finally(() => { if (reading === current) reading = null })
    reading = current
    return current
  }
  if (!followUp) {
    const queued = reading.then(() => {
      if (followUp === queued) followUp = null
      return account === accountGeneration ? loadTravel() : null
    })
    followUp = queued
  }
  return followUp
}

const offEvent = onServerEvent(event => {
  if (event.type !== 'travel.changed') return
  void apply(event.state, true)
  // The ledger changes with every fare and fee; refresh it without a second owner of the state.
  void loadTravel()
  void refreshPoints()
})
const offReconnect = onReconnect(() => { void loadTravel() })
const offReset = onAccountReset(() => {
  accountGeneration++; stateRevision++
  reading = null; followUp = null
  // A street that failed to load is retried for its own member only.
  setArrivalTarget(null)
  travel.state = null; travel.ledger = []; travel.loaded = false; travel.error = ''
})

// A trip that has run out of time is settled by the service, so ask it, but only while a trip
// exists and the page is showing, never while another read is on its way, and at once when the
// page comes back (a trip that ended while the tab was asleep is picked up then).
function settleIfDue(): void {
  if (document.visibilityState !== 'visible' || !travel.state?.trip || secondsLeft() > 0 || reading || followUp) return
  void loadTravel()
}
let watcher: ReturnType<typeof setInterval> | undefined
const stopWatching = watch(() => Boolean(travel.state?.trip), travelling => {
  clearInterval(watcher)
  watcher = travelling ? setInterval(settleIfDue, 2000) : undefined
}, { immediate: true })
document.addEventListener('visibilitychange', settleIfDue)
if (import.meta.hot) import.meta.hot.dispose(() => {
  accountGeneration++
  offEvent(); offReconnect(); offReset()
  clearInterval(watcher); stopWatching()
  document.removeEventListener('visibilitychange', settleIfDue)
})
