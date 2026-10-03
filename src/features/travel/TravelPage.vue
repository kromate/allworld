<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { WorldError } from '../../shared/model.ts'
import type { CoarseArea } from '../../shared/model.ts'
import type { LedgerEntry, TravelMode, TravelQuote, TravelState } from '../../shared/travel.ts'
import { TRAVEL, visaFreeBetween, visaTerms } from '../../shared/travel.ts'
import { STARTER_PLACES } from '../../shared/places.ts'
import { areaFromPlace } from '../../geo/areas.ts'
import { findDepartureHub, searchDestinations } from './hubs.ts'
import type { HubResult } from './hubs.ts'
import { readJourney, saveJourney } from './journey.ts'
import type { JourneyContext } from './journey.ts'
import type { PlaceResult } from '../../geo/geocode.ts'
import { vehicles } from '../../state/vehicles.ts'
import { api, app, messageOf, onReconnect, onServerEvent, refreshMe, refreshPoints } from '../../state/app.ts'
import { enterArea, world } from '../../state/world.ts'
import { loadTravel, travel } from '../../state/travel.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { dateTime } from '../../ui/format.ts'
import { useLoad } from '../../ui/useLoad.ts'
import TravelMap from './TravelMap.vue'
import TripPass from './TripPass.vue'
import CostPreview from './CostPreview.vue'

const router = useRouter()
const tab = ref<'departures' | 'documents' | 'wallet'>('departures')
const now = ref(Date.now())
const destination = ref<CoarseArea | null>(null)
const quote = ref<TravelQuote | null>(null)
const quoting = ref(false)
const quoteError = ref('')
const busy = ref(false)
const reviewing = ref(false)
const hubLoading = ref(false)
const hub = ref<HubResult | null>(null)
const journeyContext = ref(readJourney())
const lastPayment = ref<LedgerEntry | null>(null)
const ticket = ref<HTMLElement | null>(null)
let reviewGeneration = 0
const actionError = ref('')
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const results = ref<PlaceResult[]>([])
const searching = ref(false)
const searched = ref(false)
const searchError = ref('')
const showPlaces = ref(false)
const completedShifts = ref<number | null>(null)
const places = STARTER_PLACES.map(areaFromPlace)
const modeIcon: Record<TravelMode, string> = { local: '🚶', bus: '🚌', rail: '🚆', flight: '✈' }
const modeName: Record<TravelMode, string> = { local: 'Walk', bus: 'Bus', rail: 'Rail', flight: 'Flight' }
let disposed = false
let quoteGeneration = 0
let searchGeneration = 0
let refreshTask: Promise<void> | null = null
let lastPoll = 0
const { data, state: loadState, error, reload } = useLoad(async () => (await api('travel.state', {})).ledger)
const state = computed(() => travel.state)
const deskError = computed(() => error.value.includes('Unknown operation') ? 'Travel is not available yet. The travel desk is being prepared. Try again shortly.' : `The travel desk could not connect. ${error.value}`)
const trip = computed(() => state.value?.trip?.status === 'in-transit' ? state.value.trip : null)
const location = computed(() => state.value ? state.value.location : app.me?.browsing ?? app.me?.currentArea ?? null)
const target = computed(() => trip.value?.to ?? quote.value?.to ?? destination.value)
const latestArrival = computed(() => state.value?.recentTrips.find(item => item.status === 'arrived') ?? null)
const activeHub = computed(() => journeyContext.value?.tripId === trip.value?.id ? journeyContext.value?.hub ?? null : null)
const departure = computed(() => activeHub.value?.kind === 'found' ? activeHub.value.anchor : null)
const recentPlaces = computed(() => {
  const seen = new Set([location.value?.areaId])
  return (state.value?.recentTrips ?? []).flatMap(item => [item.from, item.to]).filter(area => {
    if (seen.has(area.areaId)) return false
    seen.add(area.areaId); return true
  }).slice(0, 3)
})
const balance = computed(() => state.value?.balance ?? 0)
const ledger = computed(() => [...(data.value ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)))
const border = computed(() => {
  const home = state.value?.homeCountry, to = target.value?.countryCode
  return home && to ? visaFreeBetween(home, to) : null
})
const visa = computed(() => state.value?.visas.find(item => item.countryCode === target.value?.countryCode))
const terms = computed(() => quote.value && quote.value.to.areaId === target.value?.areaId ? visaTerms(quote.value.distanceKm) : null)
const canTravel = computed(() => !vehicles.seated.value && Boolean(quote.value && (quote.value.allowed || (quote.value.mode === 'local' && quote.value.requirements.every(item => item.met))) && !trip.value))
const visaNeeded = computed(() => Boolean(target.value && state.value?.homeCountry && !border.value?.free))
const extraQuoteReason = computed(() => {
  const chosen = quote.value
  return chosen && !chosen.requirements.some(item => item.text === chosen.reason) ? chosen.reason : ''
})
const remaining = (at: string | null): number => at ? Math.max(0, Math.ceil((Date.parse(at) - now.value) / 1000)) : 0
const clock = (at: string | null): string => { const seconds = remaining(at); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
const duration = (seconds: number): string => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
const countryName = (code: string | null): string => {
  if (!code) return 'Choose a starting area'
  try { return new Intl.DisplayNames([app.me?.preferences.language || 'en'], { type: 'region' }).of(code) ?? code } catch { return code }
}
const borderText = (area: CoarseArea): string => {
  const home = state.value?.homeCountry
  if (!home) return 'Choose home first'
  if (location.value?.countryCode === area.countryCode) return 'No documents'
  return visaFreeBetween(home, area.countryCode).free ? 'Passport only' : 'Passport + visa'
}
const borderTone = (area: CoarseArea): string => {
  const home = state.value?.homeCountry
  return location.value?.countryCode === area.countryCode ? 'leaf' : home && visaFreeBetween(home, area.countryCode).free ? 'sky' : 'grape'
}
watch(trip, value => {
  if (value) { quoteGeneration++; quote.value = null; quoting.value = false; reviewing.value = false; journeyContext.value = readJourney() }
})

async function refreshQuote(): Promise<void> {
  const mine = ++quoteGeneration
  const to = destination.value
  const from = state.value?.location?.areaId
  if (!to || trip.value || !from) { quote.value = null; quoting.value = false; return }
  quoting.value = true
  quoteError.value = ''
  try {
    const result = await api('travel.quote', { to })
    if (mine === quoteGeneration && !disposed && !trip.value && state.value?.location?.areaId === from && destination.value?.areaId === to.areaId) quote.value = result.quote
  } catch (cause) { if (mine === quoteGeneration) quoteError.value = messageOf(cause) }
  finally { if (mine === quoteGeneration) quoting.value = false }
}

function refresh(): Promise<void> {
  if (disposed) return Promise.resolve()
  if (refreshTask) return refreshTask
  error.value = ''
  refreshTask = (async () => {
    try { await loadTravel(); await reload(); if (!disposed) { settleUnanswered(); await refreshQuote() } }
    finally { refreshTask = null; lastPoll = Date.now() }
  })()
  return refreshTask
}

// No answer is not a refusal: a payment whose answer was lost with the link may have been taken.
// The ledger from before it is kept, and the next refresh that works says which it was.
let unanswered: Set<string> | null = null
// True when the service itself answered that the payment was made and only the refresh after it failed.
let paid = false
function settleUnanswered(): void {
  const known = unanswered
  if (!known || error.value || !data.value) return
  unanswered = null
  lastPayment.value = data.value.find(entry => !known.has(entry.id) && entry.amount < 0) ?? null
  actionError.value = lastPayment.value ? '' : paid ? 'That payment went through. Open the Wallet tab to see it.' : 'That payment was not taken: no coins left your wallet. You can try again.'
}

async function select(area: CoarseArea): Promise<void> {
  if (busy.value || trip.value) return
  cancelReview(); hub.value = null; searchGeneration++
  destination.value = area
  quote.value = null
  actionError.value = ''
  results.value = []
  searched.value = false
  showPlaces.value = false
  tab.value = 'departures'
  await refreshQuote()
}

async function search(): Promise<void> {
  if (query.value.trim().length < 2 || searching.value) return
  const mine = ++searchGeneration
  searching.value = true
  searchError.value = ''
  searched.value = false
  results.value = []
  try {
    const found = await searchDestinations(query.value.trim(), app.me?.preferences.language || 'en')
    if (mine === searchGeneration && !disposed) { results.value = found; searched.value = true }
  } catch (cause) { if (mine === searchGeneration) searchError.value = messageOf(cause) }
  finally { searching.value = false }
}

async function transact(run: () => Promise<{ state: TravelState }>): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = ''
  lastPayment.value = null
  unanswered = null
  paid = false
  const known = new Set(data.value?.map(entry => entry.id) ?? [])
  try {
    await run()
    paid = true
    await refreshPoints()
    if (refreshTask) await refreshTask
    await refresh()
    if (error.value) {
      // The service answered, so the coins are spent; only the read after it failed. Keep Pay shut and say so.
      unanswered = known
      actionError.value = 'That went through and your coins were spent, but the travel desk could not refresh. Try again to see your receipt.'
    } else lastPayment.value = data.value?.find(entry => !known.has(entry.id) && entry.amount < 0) ?? null
  } catch (cause) {
    actionError.value = messageOf(cause)
    if (paid) {
      unanswered = known
      actionError.value = 'That went through and your coins were spent, but the travel desk could not refresh. Try again to see your receipt.'
    }
    const lost = !paid && cause instanceof WorldError && cause.code === 'unavailable'
    // A read that left before the lost answer cannot say what became of it: let it finish, then ask afresh.
    if (lost && refreshTask) await refreshTask
    if (lost) unanswered = known
    await refresh()
  } finally { busy.value = false }
}

async function reviewBooking(): Promise<void> {
  if (busy.value || !canTravel.value || quoteError.value || !quote.value) return
  if (quote.value.mode === 'local') { await book(); return }
  const mine = ++reviewGeneration
  reviewing.value = true
  hubLoading.value = true
  hub.value = null
  await nextTick()
  ticket.value?.focus()
  await refresh()
  // Cancelled or replaced while waiting: the review that replaced it owns the loading state.
  if (mine !== reviewGeneration || disposed) return
  const chosen = quote.value, from = location.value
  // No hub lookup ran, so leave the review: the notice above retries, and Review booking starts it again.
  if (!chosen || !from || !canTravel.value || error.value || quoteError.value) { reviewing.value = false; hubLoading.value = false; return }
  const found = await findDepartureHub(from, chosen.mode)
  if (mine === reviewGeneration && !disposed) { hub.value = found; hubLoading.value = false }
}

function cancelReview(): void { reviewGeneration++; reviewing.value = false; hubLoading.value = false }

async function book(): Promise<void> {
  if (vehicles.seated.value) { actionError.value = 'Exit your vehicle safely before starting another journey.'; return }
  const chosen = quote.value
  if (busy.value || !chosen || !canTravel.value || quoting.value || quoteError.value || error.value || trip.value || chosen.to.areaId !== destination.value?.areaId) return
  if (chosen.mode !== 'local') {
    if (!reviewing.value || hubLoading.value) return
    await transact(async () => {
      const result = await api('travel.book', { to: chosen.to })
      if (result.state.trip) {
        const context: JourneyContext = { tripId: result.state.trip.id, hub: hub.value ?? { kind: 'missing', reason: 'Departure hub was not confirmed.' } }
        saveJourney(context); journeyContext.value = context
      }
      return result
    })
    return
  }
  busy.value = true
  actionError.value = ''
  try {
    await api('member.setBrowsing', { area: chosen.to })
    await refreshMe()
    if (!await enterArea(chosen.to)) throw new Error('The streets did not load. Try opening this place again.')
    // The page may have closed while the streets loaded; the area is entered, but nobody is sent back.
    if (!disposed) await router.push('/')
  } catch (cause) { actionError.value = messageOf(cause) } finally { busy.value = false }
}

function applyVisa(): void {
  const to = target.value
  if (to) void transact(() => api('travel.visaApply', { countryCode: to.countryCode, toward: to }))
}
function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (reviewing.value) { event.preventDefault(); event.stopImmediatePropagation(); if (!busy.value) cancelReview(); return }
  if (showPlaces.value || searched.value || searching.value || searchError.value) {
    event.preventDefault(); event.stopImmediatePropagation()
    showPlaces.value = false; results.value = []; searched.value = false; searchError.value = ''; searchGeneration++
    searchInput.value?.focus()
  } else if (event.target instanceof HTMLInputElement) {
    event.preventDefault(); event.stopImmediatePropagation(); event.target.blur()
  }
}
const offEvent = onServerEvent(event => { if (event.type === 'travel.changed') void refresh() })
const offReconnect = onReconnect(() => { void refresh() })
// The countdowns (the trip, and a passport or visa in review) tick once a second, and only while
// there is one to show and the page is visible. They start again at once when the page returns,
// which also asks the service whether anything finished meanwhile. The service decides when a
// trip or document is done; reaching 0:00 here only prompts the next (single-flight) refresh.
const counting = computed(() => Boolean(trip.value || state.value?.passport.status === 'processing' || state.value?.visas.some(item => item.status === 'processing')))
const visible = ref(document.visibilityState === 'visible')
let timer: ReturnType<typeof setInterval> | undefined
function tick(): void {
  now.value = Date.now()
  if (counting.value && Date.now() - lastPoll >= 3000 && !error.value) void refresh()
}
function schedule(): void {
  clearInterval(timer)
  timer = undefined
  if (disposed || !visible.value || !counting.value) return
  tick()
  timer = setInterval(tick, 1000)
}
const onVisibility = (): void => { visible.value = document.visibilityState === 'visible' }
watch([counting, visible], schedule)
// Dates the page compares with the clock (a passport's expiry) stay right while nothing ticks.
watch(state, () => { now.value = Date.now() })
onMounted(() => {
  if (world.homeWalk.kind === 'travel') void select(world.homeWalk.to)
  window.addEventListener('keydown', escape, true)
  document.addEventListener('visibilitychange', onVisibility)
  lastPoll = Date.now()
  void loadTravel()
  void api('work.career', {}).then(result => { completedShifts.value = result.career.shifts.completed }).catch(() => undefined)
  schedule()
})
onBeforeUnmount(() => {
  disposed = true; quoteGeneration++; searchGeneration++; reviewGeneration++
  clearInterval(timer); timer = undefined; offEvent(); offReconnect()
  window.removeEventListener('keydown', escape, true)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <PanelPage class="travel-page" title="Travel" wide>
    <template #actions>
      <button class="wallet-shortcut" type="button" aria-label="Open coin wallet" @click="tab = 'wallet'">🪙 <span class="num">{{ state ? balance.toLocaleString() : '—' }}</span></button>
    </template>

    <nav class="travel-tabs" aria-label="Travel sections">
      <button type="button" :aria-current="tab === 'departures' ? 'page' : undefined" @click="tab = 'departures'">{{ trip ? 'Your journey' : 'Departures' }}</button>
      <button type="button" :aria-current="tab === 'documents' ? 'page' : undefined" @click="tab = 'documents'">Documents<span v-if="state?.passport.status === 'processing'" class="processing-dot" aria-label="Processing"></span></button>
      <button type="button" :aria-current="tab === 'wallet' ? 'page' : undefined" @click="tab = 'wallet'">Wallet</button>
    </nav>

    <div v-show="tab === 'departures'" class="stack">
      <TravelMap :location="location" :home-country="state?.homeCountry ?? null" :destination="target" :trip="trip" :now="now" :passport="state?.passport ?? null" :visas="state?.visas ?? []" :recent-trips="state?.recentTrips ?? []" :departure="departure" @select="select" />
      <TripPass v-if="trip" :trip="trip" :home-country="state?.homeCountry ?? null" :now="now" :hub="activeHub" />
      <template v-else-if="state?.location">
        <form v-if="!reviewing" class="row search-form" role="search" @submit.prevent="search">
          <label class="grow"><span class="sr-only">Find a destination</span><input ref="searchInput" v-model="query" class="input" type="search" placeholder="Search, or pick a map pin" autocomplete="off" enterkeyhint="search" /></label>
          <button class="btn dark" type="submit" :disabled="searching || query.trim().length < 2">{{ searching ? 'Searching…' : 'Search' }}</button>
        </form>
        <p v-if="searchError" class="notice coral" role="alert">{{ searchError }}</p>
        <ul v-if="results.length" class="place-list" aria-label="Matching destinations">
          <li v-for="place in results" :key="`${place.label}-${place.anchor.lat}`"><button type="button" @click="select(areaFromPlace(place))"><span><strong>{{ place.label }}</strong><small>{{ place.detail }}</small></span><span aria-hidden="true">→</span></button></li>
        </ul>
        <p v-else-if="searched" class="notice">No places found. Try a nearby town or city.</p>
        <button v-if="!reviewing" class="btn ghost browse" type="button" :aria-expanded="showPlaces" @click="showPlaces = !showPlaces">{{ showPlaces ? 'Close places' : 'Browse places' }}</button>
        <ul v-if="showPlaces" class="place-list starter-list" aria-label="Starter destinations">
          <li v-for="place in places" :key="place.areaId"><button type="button" :disabled="busy" @click="select(place)"><span><strong>{{ place.label }}</strong><small>{{ countryName(place.countryCode) }}</small></span><span class="chip" :class="borderTone(place)">{{ borderText(place) }}</span></button></li>
        </ul>
        <div v-if="quoting" class="quote-loading small" role="status">Checking fares and entry requirements…</div>
        <StateView v-if="quoteError" state="error" :message="quoteError" @retry="refreshQuote" />
        <section v-if="quote" ref="ticket" tabindex="-1" class="boarding" aria-label="Travel quote" :aria-busy="quoting">
          <div class="ticket-band"><span>{{ modeIcon[quote.mode] }} {{ modeName[quote.mode] }} {{ reviewing ? 'booking review' : 'ticket' }}</span><span>{{ quote.international ? 'International' : 'Domestic' }}</span></div>
          <div class="ticket-body">
            <div class="passenger"><span>{{ app.me?.displayName }} · one traveller</span><span>Fictional game ticket</span></div>
            <div class="itinerary"><div><small>From</small><h2>{{ state.location.label }}</h2></div><span aria-hidden="true">→</span><div><small>To</small><h2>{{ quote.to.label }}</h2></div></div>
            <div class="ticket-facts"><div><small>Distance</small><strong class="num">{{ Math.round(quote.distanceKm).toLocaleString() }} km</strong></div><div><small>Game time</small><strong class="num">{{ quote.seconds ? duration(quote.seconds) : 'Walk right in' }}</strong></div><div><small>Fare</small><strong class="fare num">{{ quote.fare.toLocaleString() }} 🪙</strong></div></div>
            <div v-if="reviewing" class="hub-review">
              <p v-if="hubLoading" role="status">Finding a mapped departure hub…</p>
              <template v-else-if="hub?.kind === 'found'"><p>From <strong>{{ hub.name }}</strong></p><p class="tiny muted">Nearest suitable result returned · {{ Math.round(hub.distance) }} km from your area. <a :href="hub.source" target="_blank" rel="noopener">View mapped {{ hub.category }}</a></p></template>
              <p v-else class="small muted">{{ hub?.kind === 'missing' ? hub.reason : 'Departure hub is not confirmed.' }}</p>
              <p class="tiny muted">A fictional journey using mapped places, not a real transport timetable.</p>
            </div>
            <h3 v-if="reviewing" class="check-heading">Documents check</h3>
            <ul class="requirements" aria-label="Entry requirements"><li v-for="item in quote.requirements" :key="item.kind" :class="{ met: item.met }"><span class="check" :aria-label="item.met ? 'Met' : 'Not met'">{{ item.met ? '✓' : '!' }}</span><span>{{ item.text }}</span></li></ul>
            <p v-if="!quote.requirements.length" class="small">No documents needed for this journey.</p>
            <p v-if="vehicles.seated.value" class="small reason">Exit your vehicle safely before starting another journey.</p>
            <p v-if="!canTravel && extraQuoteReason" class="small reason">{{ extraQuoteReason }}</p>
            <CostPreview v-if="quote.fare" class="fare-preview" :cost="quote.fare" :balance="balance" purpose="One-way fare. Payment starts your journey." />
          </div>
          <!-- The fare, what is short and where to earn it are in the cost preview above; the footer is the next step only. -->
          <div class="ticket-footer">
            <button v-if="reviewing" class="btn" type="button" :disabled="busy" @click="cancelReview">Back</button>
            <button v-else-if="quote.requirements.some(item => !item.met)" class="btn" type="button" @click="tab = 'documents'">Check documents</button>
            <span v-else-if="quote.mode === 'local'" class="small muted">Close enough to walk</span>
            <button class="btn primary" type="button" :disabled="!canTravel || busy || quoting || hubLoading || Boolean(quoteError) || Boolean(error)" @click="reviewing ? book() : reviewBooking()">{{ busy ? 'Please wait…' : hubLoading ? 'Checking departure…' : quote.mode === 'local' ? 'Open it' : reviewing ? `Pay ${quote.fare.toLocaleString()} 🪙 & depart` : 'Review booking' }}</button>
          </div>
        </section>
        <details v-else-if="latestArrival && !quoting && !quoteError" class="arrival-receipt"><summary>Arrival receipt · {{ latestArrival.to.label }}</summary><TripPass :trip="latestArrival" :home-country="state.homeCountry" :now="now" :hub="journeyContext?.tripId === latestArrival.id ? journeyContext.hub : null" /></details>
        <div v-if="recentPlaces.length && !quote" class="return-board"><h2>Go again</h2><button v-for="place in recentPlaces" :key="place.areaId" type="button" @click="select(place)"><span>{{ place.label }}</span><span class="chip" :class="borderTone(place)">{{ borderText(place) }}</span></button></div>
      </template>
    </div>

    <div v-if="lastPayment" class="payment-receipt" role="status"><div><strong>{{ lastPayment.text }}</strong><p>−{{ Math.abs(lastPayment.amount).toLocaleString() }} 🪙 recorded · balance {{ lastPayment.balanceAfter.toLocaleString() }}</p></div><button class="btn" type="button" @click="tab = 'wallet'">View ledger</button></div>
    <StateView v-if="loadState !== 'ready' || !travel.loaded" :state="loadState === 'error' ? 'error' : 'loading'" :message="deskError" @retry="refresh" />
    <StateView v-else-if="!state" state="error" message="Your travel status did not load. Try again to check your location and documents." @retry="refresh" />
    <StateView v-else-if="!state.location && !trip" state="empty" art="🧭" title="Every journey needs a starting point" message="Choose your first area to set your home country and begin travelling.">
      <RouterLink class="btn primary" to="/settings?tab=area">Choose a starting area</RouterLink>
    </StateView>
    <div v-else-if="error" class="notice coral" role="alert"><span class="grow">Travel could not refresh. {{ error }}</span><button class="btn" type="button" @click="refresh">Retry</button></div>
    <p v-if="actionError" class="notice coral" role="alert">{{ actionError }}</p>
    <div v-if="tab === 'documents' && state?.location" class="stack">
      <section class="passport-card" aria-label="Your passport">
        <div class="passport-cover"><span class="passport-emblem" aria-hidden="true">◎</span><strong>World passport</strong><span>{{ countryName(state.homeCountry) }}</span><small>Fictional game document</small></div>
        <div class="passport-details stack tight"><span class="chip" :class="state.passport.status === 'valid' ? 'leaf' : 'amber'">{{ state.passport.status === 'none' ? 'Not issued' : state.passport.status }}</span><h2>{{ app.me?.displayName }}</h2>
          <p v-if="state.passport.status === 'processing'" class="small">At the passport office · <strong class="num">{{ clock(state.passport.readyAt) }}</strong> remaining</p>
          <p v-else-if="state.passport.status === 'valid' && state.passport.expiresAt" class="small">Valid until {{ dateTime(state.passport.expiresAt) }}</p>
          <p v-else-if="state.passport.status === 'expired'" class="small">Your passport has expired. Apply again before crossing a border.</p>
          <p v-else class="small">Your first step beyond your home country. Processing takes {{ duration(TRAVEL.passport.seconds) }}.</p>
          <p v-if="state.passport.appliedAt" class="tiny muted">Applied {{ dateTime(state.passport.appliedAt) }}</p>
        </div>
      </section>
      <div v-if="state.passport.status !== 'valid' && state.passport.status !== 'processing'" class="stack passport-application">
        <CostPreview :cost="TRAVEL.passport.fee" :balance="balance" :purpose="`Passport issue fee. Processing takes ${duration(TRAVEL.passport.seconds)}.`" />
        <button class="btn primary" type="button" :disabled="busy || balance < TRAVEL.passport.fee" @click="transact(() => api('travel.passportApply', {}))">Apply — {{ TRAVEL.passport.fee }} 🪙</button>
      </div>
      <section class="visa-section stack">
        <div class="row between"><h2>Entry to {{ target ? countryName(target.countryCode) : 'your next country' }}</h2><button class="btn" type="button" @click="tab = 'departures'; showPlaces = true">Choose place</button></div>
          <article v-if="visa && target" class="visa-document" :class="visa.status" aria-label="Visa decision">
            <div class="visa-title"><span>Entry visa · {{ countryName(target.countryCode) }}</span><strong>{{ visa.status === 'processing' ? 'In review' : visa.status }}</strong></div>
            <h3>{{ app.me?.displayName }}</h3>
            <p v-if="visa.status === 'processing'">Decision in <strong class="num">{{ clock(visa.readyAt) }}</strong>. Keep the application funds available during review.</p>
            <p v-else-if="visa.status === 'valid' && visa.validUntil">Valid until {{ dateTime(visa.validUntil) }}</p>
            <p v-else-if="visa.status === 'refused'">{{ visa.note }}</p>
            <p v-else-if="visa.status === 'expired'">This visa has expired. Apply again for your next visit.</p>
            <small>Applied {{ dateTime(visa.appliedAt) }} · fictional game permit</small>
          </article>
        <p v-if="!target" class="muted small">Choose a destination to see its visa rules and application fee.</p>
        <template v-else-if="target.countryCode === state.location.countryCode || border?.free"><p class="notice leaf">{{ target.countryCode === state.location.countryCode ? 'This journey stays in the same country. No passport or visa is needed.' : target.countryCode === state.homeCountry ? 'No visa needed to return to your home country. You still need a valid passport to cross the border.' : `No visa needed. ${border?.bloc} allows visa-free travel from ${countryName(state.homeCountry)} in this game. You still need a valid passport.` }}</p></template>
        <template v-else-if="visaNeeded && terms">
          <template v-if="visa?.status !== 'valid' && visa?.status !== 'processing'">
            <p class="small">{{ countryName(target.countryCode) }} is outside your home country's visa-free blocs. You need a valid passport and a visa.</p>
            <dl class="visa-terms"><div><dt>Application fee</dt><dd>{{ terms.fee }} 🪙</dd></div><div><dt>Before applying</dt><dd>{{ terms.funds }} 🪙</dd></div><div><dt>Work completed</dt><dd>{{ completedShifts ?? '—' }} shifts</dd></div></dl>
            <p class="small muted">Have {{ terms.funds }} coins before applying. After the {{ terms.fee }}-coin fee, keep at least {{ terms.funds - terms.fee }} coins until the decision and complete {{ TRAVEL.visa.minShifts }} work shifts. Review takes {{ duration(TRAVEL.visa.seconds) }}. Missing these requirements means refusal; the fee is not refunded.</p>
            <p v-if="state.passport.status !== 'valid'" class="notice amber">Get a valid passport before applying.</p>
            <p v-if="completedShifts !== null && completedShifts < TRAVEL.visa.minShifts" class="small reason">Complete {{ TRAVEL.visa.minShifts - completedShifts }} more work {{ TRAVEL.visa.minShifts - completedShifts === 1 ? 'shift' : 'shifts' }} before applying to avoid refusal.</p>
            <CostPreview :cost="terms.fee" :balance="balance" :required-balance="terms.funds" purpose="Visa review fee. Charged even if the decision is refused." />
            <button class="btn primary" type="button" :disabled="busy || state.passport.status !== 'valid' || balance < terms.fee" @click="applyVisa">{{ visa?.status === 'refused' ? 'Apply again' : 'Apply for visa' }} — {{ terms.fee }} 🪙</button>
          </template>
        </template>
      </section>
      <details v-if="state.visas.length" class="document-history"><summary>All visas ({{ state.visas.length }})</summary><ul class="visa-history"><li v-for="entry in state.visas" :key="entry.countryCode"><strong>{{ countryName(entry.countryCode) }}</strong><span>{{ entry.status }}<template v-if="entry.status === 'processing'"> · {{ clock(entry.readyAt) }}</template><template v-else-if="entry.status === 'valid' && entry.validUntil"> until {{ dateTime(entry.validUntil) }}</template></span><p v-if="entry.status === 'refused'" class="small">{{ entry.note }}</p></li></ul></details>
    </div>

    <div v-if="tab === 'wallet' && state" class="stack">
      <section class="wallet-balance"><div><h2 class="num">{{ balance.toLocaleString() }} <span>🪙</span></h2><small>Available coins</small></div><RouterLink class="btn primary" to="/work">Earn coins at work</RouterLink></section>
      <div class="row between"><h2>Coin history</h2><button class="btn ghost" type="button" @click="refresh">Refresh</button></div>
      <ul v-if="ledger.length" class="ledger"><li v-for="entry in ledger" :key="entry.id"><span class="ledger-symbol" :class="{ earned: entry.amount > 0 }" aria-hidden="true">{{ entry.amount > 0 ? '↙' : '↗' }}</span><div class="grow"><strong>{{ entry.text }}</strong><small>{{ dateTime(entry.at) }} · Balance {{ entry.balanceAfter.toLocaleString() }}</small></div><strong class="num" :class="{ earned: entry.amount > 0 }">{{ entry.amount > 0 ? '+' : '−' }}{{ Math.abs(entry.amount).toLocaleString() }}</strong></li></ul>
      <p v-else class="notice">Your earnings and travel spending will appear here.</p>
    </div>
    <p class="travel-note">Coins are play money earned in the game, not real money. Travel rules are a simplified game, not visa advice.</p>
  </PanelPage>
</template>

<style scoped>
.passenger { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; color: var(--muted); font-size: .7rem; margin-bottom: 14px; }
.fare-preview { margin-top: 16px; }
.hub-review { display: flex; flex-direction: column; gap: 6px; padding: 12px; margin-bottom: 14px; border-radius: 10px; background: var(--sky-soft); font-size: .86rem; }
.check-heading { margin-bottom: 10px; font-size: .86rem; }
.payment-receipt { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; background: var(--leaf-soft); border: 1px solid #b9dfc8; border-radius: 12px; font-size: .8rem; }
.payment-receipt p { font-size: .76rem; margin-top: 3px; }
.payment-receipt .btn { flex: none; font-size: .8rem; }
.arrival-receipt summary { min-height: 44px; padding: 10px 0; cursor: pointer; color: #1f7447; font-weight: 650; font-size: .84rem; }
.return-board h2 { font-size: .9rem; margin-bottom: 8px; }
.return-board button { width: 100%; min-height: 48px; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; text-align: left; gap: 10px; border: 0; border-bottom: 1px solid var(--line); background: var(--surface); font-size: .84rem; }
.visa-document { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 18px; background: #edf3ed; border: 1px solid #cad9c9; border-left: 5px solid var(--leaf); border-radius: 4px 12px 12px 4px; }
.visa-document.refused, .visa-document.expired { background: #fff4ef; border-color: #ecc9bb; border-left-color: var(--coral); }
.visa-document.processing { background: var(--accent-soft); border-color: #eddbb0; border-left-color: var(--accent-strong); }
.visa-title { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: .75rem; }
.visa-title strong { border: 1px solid currentColor; padding: 3px 8px; border-radius: 3px; color: #1f7447; text-transform: uppercase; letter-spacing: .05em; }
.refused .visa-title strong, .expired .visa-title strong { color: var(--danger); }
.processing .visa-title strong { color: var(--accent-text); }
.visa-document p { font-size: .87rem; }
.visa-document small { font-size: .7rem; color: var(--muted); }
.passport-application > .btn { align-self: flex-start; }
.travel-page :deep(.panel-body) { gap: 12px; }
.travel-page :deep(.btn.sm) { min-height: 40px; }
.travel-page :deep(.panel-head .btn) { min-height: 40px; min-width: 40px; }
.travel-page :deep(.notice) { flex-wrap: wrap; }
.wallet-shortcut { display: flex; gap: 6px; align-items: center; min-height: 40px; border: 1px solid #eddaab; border-radius: 12px; padding: 0 12px; background: var(--accent-soft); font-weight: 750; }
/* The 40 px above is for a mouse. These rules outrank the shared 44 px for fingers, so it is restated here. */
@media (pointer: coarse) {
  .travel-page :deep(.btn.sm), .wallet-shortcut { min-height: 44px; }
  .travel-page :deep(.panel-head .btn) { min-height: 44px; min-width: 44px; }
}
.travel-tabs { display: flex; border-bottom: 1px solid var(--line-strong); flex: none; }
.travel-tabs button { position: relative; flex: 1; min-height: 44px; border: 0; border-bottom: 3px solid transparent; background: none; color: var(--ink-2); font-weight: 700; padding: 8px; }
.travel-tabs button[aria-current] { color: var(--ink); border-bottom-color: var(--accent-strong); }
.processing-dot { display: inline-block; height: 7px; width: 7px; border-radius: 50%; background: var(--sky); margin-left: 5px; }
.place-list, .requirements, .ledger, .visa-history { list-style: none; margin: 0; padding: 0; }
.place-list { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.place-list li + li { border-top: 1px solid var(--line); }
.place-list button { width: 100%; min-height: 58px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; text-align: left; border: 0; background: var(--surface); }
.place-list button:hover { background: var(--accent-soft); }
.place-list small, .ledger small { display: block; color: var(--muted); font-size: .76rem; }
.starter-list { max-height: 290px; overflow-y: auto; }
.starter-list strong { font-size: .86rem; }
.browse { align-self: flex-start; min-height: 44px; font-size: .82rem; padding-inline: 12px; margin: -6px 0 -6px -12px; text-decoration: underline; text-underline-offset: 3px; }
.boarding { border: 1px solid var(--line-strong); border-radius: 15px; background: var(--surface); overflow: hidden; flex: none; }
.ticket-band { display: flex; justify-content: space-between; gap: 10px; background: var(--ink); color: var(--surface); padding: 10px 16px; font-size: .82rem; font-weight: 700; }
.ticket-band > :first-child { color: var(--accent); }
.ticket-body { padding: 16px; }
.itinerary { display: grid; grid-template-columns: 1fr 24px 1fr; gap: 12px; align-items: center; }
.itinerary > span { color: var(--muted); font-size: 1.3rem; }
.itinerary h2 { font-size: 1.12rem; line-height: 1.2; overflow-wrap: anywhere; }
.itinerary small, .ticket-facts small { display: block; color: var(--muted); font-size: .72rem; margin-bottom: 3px; }
.ticket-facts { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 17px 0; }
.ticket-facts strong { font-size: .95rem; }
.ticket-facts .fare { font-size: 1.1rem; }
.requirements { display: flex; flex-direction: column; gap: 8px; font-size: .82rem; }
.requirements li { display: flex; align-items: flex-start; gap: 8px; }
.check { display: grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 50%; background: var(--coral-soft); color: #8f2c19; font-weight: 800; font-size: .75rem; }
.met .check { background: var(--leaf-soft); color: #1c5c39; }
.reason { color: #98371f; margin-top: 8px; }
.ticket-footer { padding: 13px 16px; border-top: 1px dashed var(--line-strong); display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--surface-2); }
.ticket-footer .btn { flex: none; }
.ticket-footer .btn.primary { margin-left: auto; }
.transit progress { display: block; width: 100%; height: 9px; border: 0; border-radius: 8px; overflow: hidden; accent-color: var(--accent-strong); }
.transit progress::-webkit-progress-bar { background: var(--surface-3); }
.transit progress::-webkit-progress-value { background: var(--accent-strong); }
.quote-loading { padding: 8px 0; color: var(--ink-2); }
.passport-card { display: grid; grid-template-columns: 180px 1fr; gap: 24px; align-items: center; padding: 18px 0; }
.passport-cover { min-height: 226px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; padding: 18px 12px; border-radius: 4px 14px 14px 4px; background: #233e40; color: #f3d49a; box-shadow: inset 5px 0 0 #162d2f, inset 8px 0 0 #ffffff15, 3px 5px 0 #d9d1c2; text-align: center; }
.passport-cover strong { font-size: 1.2rem; }
.passport-cover small { margin-top: 14px; font-size: .68rem; opacity: .85; }
.passport-emblem { font-size: 3rem; line-height: 1; }
.passport-details { align-items: flex-start; }
.passport-details > .btn { margin-top: 6px; }
.visa-section { border-top: 1px solid var(--line); padding-top: 18px; }
.visa-section > .btn { align-self: flex-start; }
.visa-terms { margin: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 14px; background: var(--surface-3); border-radius: 12px; }
.visa-terms dt { font-size: .75rem; color: var(--ink-2); }
.visa-terms dd { font-weight: 750; margin: 4px 0 0; }
.document-history summary { min-height: 44px; padding-block: 12px; cursor: pointer; font-weight: 650; }
.visa-history li { padding: 12px 0; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; font-size: .86rem; }
.visa-history p { width: 100%; }
.wallet-balance { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 18px; background: var(--accent-soft); border-radius: 14px; }
.wallet-balance p, .wallet-balance small { font-size: .78rem; color: var(--ink-2); }
.wallet-balance h2 { font-size: 2.8rem; margin: 6px 0 0; }
.wallet-balance h2 span { font-size: 1.8rem; }
.ledger li { display: flex; align-items: center; gap: 10px; padding: 14px 0; border-bottom: 1px solid var(--line); font-size: .85rem; }
.ledger-symbol { display: grid; place-items: center; background: var(--surface-3); border-radius: 50%; width: 34px; height: 34px; flex: none; font-size: 1.2rem; }
.earned { color: #1f7447; }
.travel-note { padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: .72rem; line-height: 1.5; }
@media (max-width: 540px) {
  .travel-page :deep(.panel-head) { padding: 14px 14px 8px; gap: 6px; }
  .travel-page :deep(.panel-head h1) { font-size: 1.25rem; }
  .travel-page :deep(.panel-head p) { font-size: .73rem; }
  .travel-page :deep(.panel-body) { padding-inline: 14px; }
  .wallet-shortcut { padding-inline: 8px; }
  .ticket-body { padding: 14px; }
  .itinerary { gap: 8px; grid-template-columns: 1fr 16px 1fr; }
  .itinerary h2 { font-size: 1rem; }
  .ticket-footer { flex-wrap: wrap; padding: 12px 14px; }
  .ticket-footer > .btn.primary { width: 100%; }
  .passport-card { grid-template-columns: 114px 1fr; gap: 16px; align-items: start; }
  .passport-cover { min-height: 183px; padding: 14px 10px; }
  .passport-cover strong { font-size: .95rem; }
  .passport-cover > span:not(.passport-emblem) { font-size: .8rem; }
  .passport-details h2 { font-size: 1.05rem; }
  .passport-details p { font-size: .8rem; }
  .passport-details .btn { font-size: .8rem; padding-inline: 10px; }
  .visa-section .row h2 { font-size: 1rem; }
  .visa-section .row .btn { font-size: .8rem; padding-inline: 10px; }
  .visa-terms { padding: 12px; gap: 8px; }
  .visa-terms dt { font-size: .68rem; }
  .visa-terms dd { font-size: .9rem; }
  .wallet-balance { align-items: flex-start; flex-direction: column; gap: 16px; }
  .starter-list .chip { font-size: .66rem; padding-inline: 6px; }
}
</style>
