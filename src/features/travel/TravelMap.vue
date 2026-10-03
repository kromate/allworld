<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FeatureCollection, LineString } from 'geojson'
import type { ErrorEvent as MapLibreErrorEvent, Map as MapLibreMap, Marker } from 'maplibre-gl'
import { STARTER_PLACES } from '../../shared/places.ts'
import { areaFromPlace } from '../../geo/areas.ts'
import type { LatLon } from '../../shared/geo.ts'
import type { CoarseArea } from '../../shared/model.ts'
import type { Passport, Trip, TravelMode, Visa } from '../../shared/travel.ts'
import { VISA_FREE_BLOCS, visaFreeBetween } from '../../shared/travel.ts'
import { greatCircleRoute, pointAlongRoute, type MapCoordinate } from './mapRoute.ts'

const props = defineProps<{
  location: CoarseArea | null
  homeCountry: string | null
  destination: CoarseArea | null
  trip: Trip | null
  now: number
  passport?: Passport | null
  visas?: Visa[]
  recentTrips?: Trip[]
  departure?: LatLon | null
}>()

const emit = defineEmits<{ select: [area: CoarseArea] }>()

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron'
const ROUTE_SOURCE = 'travel-route'
const ROUTE_LAYER = 'travel-route-line'

const mapElement = ref<HTMLElement | null>(null)
const loading = ref(true)
const problem = ref('')
let map: MapLibreMap | null = null
let maplibre: typeof import('maplibre-gl') | null = null
let resizeObserver: ResizeObserver | null = null
let placeMarkers: Marker[] = []
let placeMarkerRecords: PlaceMarkerRecord[] = []
let vehicleMarker: Marker | null = null
let activeRoute: MapCoordinate[] = []
let disposed = false
let initAttempt = 0
let lastReadinessMinute = -1

type DocumentClass = 'domestic' | 'bloc' | 'visa' | 'unknown'
type DocumentReadiness = 'ready' | 'needed' | 'processing' | 'unknown'

interface PlaceAccess {
  requirement: DocumentClass
  readiness: DocumentReadiness
  summary: string
}

interface PlaceMarkerRecord {
  area: CoarseArea
  element: HTMLButtonElement
  selected: boolean
  visited: boolean
  worldRepresentative: boolean
}

function validUntil(status: string, expiresAt: string | null): boolean {
  return status === 'valid' && expiresAt !== null && Date.parse(expiresAt) > props.now
}

function passportIsValid(): boolean {
  return Boolean(props.passport && validUntil(props.passport.status, props.passport.expiresAt))
}

function validVisa(countryCode: string): Visa | null {
  return (props.visas ?? []).find(visa => visa.countryCode === countryCode && validUntil(visa.status, visa.validUntil)) ?? null
}

function documentClass(countryCode: string): DocumentClass {
  const currentCountry = props.trip?.from.countryCode ?? props.location?.countryCode ?? null
  const home = props.homeCountry ?? currentCountry
  if (!home) return 'unknown'
  if (currentCountry === countryCode) return 'domestic'
  return visaFreeBetween(home, countryCode).free ? 'bloc' : 'visa'
}

function accessFor(area: CoarseArea): PlaceAccess {
  const requirement = documentClass(area.countryCode)
  if (requirement === 'domestic') return { requirement, readiness: 'ready', summary: 'No travel documents required.' }
  if (requirement === 'unknown') return { requirement, readiness: 'unknown', summary: 'Choose a home country to see document requirements.' }

  const passportReady = passportIsValid()
  const passportProcessing = props.passport?.status === 'processing'
  if (requirement === 'bloc') {
    const bloc = visaFreeBetween(props.homeCountry ?? '', area.countryCode).bloc
    if (passportReady) return { requirement, readiness: 'ready', summary: `Passport ready${bloc ? ` for ${bloc}` : ''}.` }
    return {
      requirement,
      readiness: passportProcessing ? 'processing' : props.passport === undefined ? 'unknown' : 'needed',
      summary: `${bloc ? `${bloc}: ` : ''}${passportProcessing ? 'passport processing' : props.passport === undefined ? 'passport status unavailable' : 'passport needed'}.`,
    }
  }

  const visa = validVisa(area.countryCode)
  if (passportReady && visa) return { requirement, readiness: 'ready', summary: 'Passport and destination visa ready.' }
  const processing = passportProcessing || (props.visas ?? []).some(entry => entry.countryCode === area.countryCode && entry.status === 'processing')
  if (processing) return { requirement, readiness: 'processing', summary: 'Required travel document is processing.' }
  if (props.passport === undefined || props.visas === undefined) return { requirement, readiness: 'unknown', summary: 'Passport and destination visa required; document status unavailable.' }
  return { requirement, readiness: 'needed', summary: passportReady ? 'Destination visa needed.' : 'Passport and destination visa needed.' }
}

const documentLegend = computed(() => {
  const home = props.homeCountry
  const blocs = home ? VISA_FREE_BLOCS.filter(bloc => bloc.countries.includes(home)).map(bloc => bloc.name) : []
  const blocLabel = blocs.length ? blocs.join(' / ') : 'Visa-free routes'
  const passportState = !home ? 'Choose a home country'
    : props.passport === undefined ? 'Status unavailable'
    : passportIsValid() ? 'Passport ready'
      : props.passport?.status === 'processing' ? 'Passport processing' : 'Passport needed'
  const heldVisas = (props.visas ?? []).filter(visa => validUntil(visa.status, visa.validUntil))
  const visaState = props.visas === undefined ? 'Status unavailable'
    : heldVisas.length ? `Valid: ${heldVisas.map(visa => `${flag(visa.countryCode)} ${visa.countryCode}`).join(', ')}`
      : passportIsValid() ? 'Destination visa needed' : 'Passport + destination visa needed'
  return { blocLabel, passportState, visaState }
})

function flag(code: string): string {
  return /^[A-Z]{2}$/.test(code)
    ? String.fromCodePoint(...[...code].map(character => 127397 + character.charCodeAt(0)))
    : '📍'
}

function effectiveDestination(): CoarseArea | null {
  return props.trip?.to ?? props.destination
}

function routeEndpoints(): { from: LatLon; to: LatLon } | null {
  if (props.trip) return { from: props.departure ?? props.trip.from.anchor, to: props.trip.to.anchor }
  if (props.location && props.destination) return { from: props.location.anchor, to: props.destination.anchor }
  return null
}

function routeData(coordinates: MapCoordinate[]): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: coordinates.length < 2 ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }],
  }
}

function clearMarkers(): void {
  for (const marker of placeMarkers) marker.remove()
  placeMarkers = []
  placeMarkerRecords = []
  vehicleMarker?.remove()
  vehicleMarker = null
}

function applyMarkerReadiness(record: Pick<PlaceMarkerRecord, 'area' | 'element' | 'visited'>): void {
  const access = accessFor(record.area)
  record.element.classList.remove('is-ready', 'is-needed', 'is-processing', 'is-unknown')
  record.element.classList.add(`is-${access.readiness}`)
  const visited = record.visited ? ' Visited.' : ''
  record.element.setAttribute('aria-label', `Choose ${record.area.label}. ${access.summary}${visited} Fares and funds are checked after selection.`)
  record.element.title = `${record.area.label} · ${access.summary}${visited}`
}

function makePlaceButton(area: CoarseArea, selected: boolean, visited: boolean): HTMLButtonElement {
  const button = document.createElement('button')
  const requirement = documentClass(area.countryCode)
  button.type = 'button'
  button.className = `travel-map-pin travel-map-pin--${requirement}${selected ? ' is-selected' : ''}${visited ? ' is-visited' : ''}`
  button.dataset.label = area.label
  button.addEventListener('click', () => emit('select', area))
  button.addEventListener('focus', () => {
    if (button.matches(':focus-visible') && map) map.easeTo({ center: [area.anchor.lon, area.anchor.lat], zoom: Math.max(3, map.getZoom()), duration: 300 })
  })
  const dot = document.createElement('span')
  dot.setAttribute('aria-hidden', 'true')
  dot.textContent = visited ? '✓' : ''
  button.appendChild(dot)
  applyMarkerReadiness({ area, element: button, visited })
  return button
}

function updateMarkerVisibility(): void {
  if (!map) return
  const zoom = map.getZoom()
  const origin = props.trip?.from ?? props.location
  for (const record of placeMarkerRecords) {
    record.element.hidden = !(record.selected || record.visited || record.worldRepresentative || zoom >= 3.15)
    record.element.classList.toggle('show-label', record.area.areaId !== origin?.areaId && (record.selected || (record.visited && zoom >= 3.8) || zoom >= 5.7))
  }
}

function updateMarkerReadiness(): void {
  for (const record of placeMarkerRecords) applyMarkerReadiness(record)
}

function addPlaceMarkers(): void {
  if (!map || !maplibre) return
  clearMarkers()
  const destination = effectiveDestination()
  const starterAreas = STARTER_PLACES.map(areaFromPlace)
  const visitedIds = new Set<string>()
  const entries = new Map<string, { area: CoarseArea; starter: boolean; visited: boolean; selected: boolean }>()
  for (const area of starterAreas) entries.set(area.areaId, { area, starter: true, visited: false, selected: false })
  for (const trip of props.recentTrips ?? []) {
    for (const area of [trip.from, trip.to]) {
      visitedIds.add(area.areaId)
      const existing = entries.get(area.areaId)
      entries.set(area.areaId, { area, starter: existing?.starter ?? false, visited: true, selected: false })
    }
  }
  if (destination) {
    const existing = entries.get(destination.areaId)
    entries.set(destination.areaId, { area: destination, starter: existing?.starter ?? false, visited: visitedIds.has(destination.areaId), selected: true })
  }

  const representedCountries = new Set<string>()
  for (const entry of entries.values()) {
    const representative = entry.starter && !representedCountries.has(entry.area.countryCode)
    if (representative) representedCountries.add(entry.area.countryCode)
    const element = makePlaceButton(entry.area, entry.selected, entry.visited)
    const marker = new maplibre.Marker({ element, anchor: 'center' })
      .setLngLat([entry.area.anchor.lon, entry.area.anchor.lat])
      .addTo(map)
    placeMarkers.push(marker)
    placeMarkerRecords.push({ area: entry.area, element, selected: entry.selected, visited: entry.visited, worldRepresentative: representative })
  }

  const currentArea = props.trip?.from ?? props.location
  if (currentArea) {
    const markerElement = document.createElement('div')
    markerElement.className = 'travel-current-marker'
    markerElement.setAttribute('role', 'img')
    const pointer = document.createElement('span')
    pointer.className = 'travel-current-marker__pointer'
    pointer.setAttribute('aria-hidden', 'true')
    const status = document.createElement('span')
    status.className = 'travel-current-marker__status'
    status.textContent = props.trip?.status === 'in-transit' ? 'Departed from' : 'You are here'
    const label = document.createElement('span')
    label.className = 'travel-current-marker__label'
    label.textContent = currentArea.label
    const badge = document.createElement('span')
    badge.className = 'travel-current-marker__badge'
    const home = props.homeCountry ?? currentArea.countryCode
    badge.textContent = `${flag(home)} Home · ${home}`
    markerElement.setAttribute('aria-label', `${status.textContent}: ${currentArea.label}. Home country: ${home}`)
    markerElement.append(pointer, status, label, badge)
    placeMarkers.push(new maplibre.Marker({ element: markerElement, anchor: 'bottom' })
      .setLngLat([currentArea.anchor.lon, currentArea.anchor.lat])
      .addTo(map))
  }

  updateVehicle()
  updateMarkerVisibility()
}

function tripProgress(trip: Trip): number {
  const departed = Date.parse(trip.departedAt)
  const arrives = Date.parse(trip.arrivesAt)
  if (!Number.isFinite(departed) || !Number.isFinite(arrives) || arrives <= departed) return 1
  return Math.max(0, Math.min(1, (props.now - departed) / (arrives - departed)))
}

function vehicleGlyph(mode: TravelMode): string {
  switch (mode) {
    case 'local': return '🚶'
    case 'bus': return '🚌'
    case 'rail': return '🚆'
    case 'flight': return '✈️'
  }
}

function updateVehicle(): void {
  if (!map || !maplibre) return
  const trip = props.trip
  if (!trip || trip.status !== 'in-transit' || activeRoute.length === 0) {
    vehicleMarker?.remove()
    vehicleMarker = null
    return
  }
  const point = pointAlongRoute(activeRoute, tripProgress(trip))
  if (!point) return
  if (!vehicleMarker) {
    const element = document.createElement('div')
    element.className = 'travel-vehicle-marker'
    element.setAttribute('role', 'img')
    element.setAttribute('aria-label', `${trip.mode} trip to ${trip.to.label}`)
    element.textContent = vehicleGlyph(trip.mode)
    vehicleMarker = new maplibre.Marker({ element, anchor: 'center' }).setLngLat(point).addTo(map)
  } else {
    vehicleMarker.setLngLat(point)
  }
}

function fitJourney(): void {
  if (!map || activeRoute.length < 2) return
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  for (const [longitude, latitude] of activeRoute) {
    west = Math.min(west, longitude)
    south = Math.min(south, latitude)
    east = Math.max(east, longitude)
    north = Math.max(north, latitude)
  }
  map.fitBounds([west, south, east, north], { padding: { top: 130, right: 94, bottom: 68, left: 94 }, maxZoom: 7, duration: 650 })
}

function showWorld(): void {
  if (!map) return
  map.fitBounds([[-175, -55], [180, 75]], { padding: 22, bearing: 0, pitch: 0, duration: 650 })
}

function updateStaticMap(refit: boolean): void {
  if (!map || !maplibre || !map.getSource(ROUTE_SOURCE)) return
  const endpoints = routeEndpoints()
  activeRoute = endpoints ? greatCircleRoute(endpoints.from, endpoints.to) : []
  map.setRenderWorldCopies(activeRoute.some(([longitude]) => longitude < -180 || longitude > 180))
  const source = map.getSource(ROUTE_SOURCE)
  if (source instanceof maplibre.GeoJSONSource) void source.setData(routeData(activeRoute))
  addPlaceMarkers()
  if (refit && endpoints) fitJourney()
  else if (refit && props.location) map.easeTo({ center: [props.location.anchor.lon, props.location.anchor.lat], zoom: 4.2, duration: 650 })
}

function addRouteLayer(): void {
  if (!map) return
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeData([]) })
  map.addLayer({
    id: ROUTE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#f39a00',
      'line-width': ['interpolate', ['linear'], ['zoom'], 1, 2.5, 6, 4.5],
      'line-opacity': 0.9,
      'line-dasharray': [1, 1.7],
    },
  })
}

async function initialise(): Promise<void> {
  const element = mapElement.value
  if (!element || map) return
  const attempt = ++initAttempt
  loading.value = true
  problem.value = ''

  try {
    const [loadedMapLibre, workerModule] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
      import('maplibre-gl/dist/maplibre-gl.css'),
    ])
    if (disposed || attempt !== initAttempt) return
    maplibre = loadedMapLibre
    loadedMapLibre.setWorkerUrl(workerModule.default)
    const instance = new loadedMapLibre.Map({
      container: element,
      style: STYLE_URL,
      center: [10, 18],
      zoom: 1.25,
      minZoom: -1,
      renderWorldCopies: false,
      pixelRatio: Math.min(devicePixelRatio, 1.5),
      maxZoom: 14,
      attributionControl: false,
      cooperativeGestures: true,
    })
    map = instance
    instance.addControl(new loadedMapLibre.NavigationControl({ showCompass: false }), 'top-right')
    instance.addControl(new loadedMapLibre.AttributionControl({ compact: false, customAttribution: '<a href="https://github.com/openmaptiles/positron-gl-style/blob/master/LICENSE.md" target="_blank" rel="noopener">Positron design</a>' }), 'bottom-right')

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { cleanUp(); reject(new Error('The map provider took too long to answer. Please try again.')) }, 20_000)
      const cleanUp = (): void => {
        clearTimeout(deadline)
        instance.off('load', onLoad)
        instance.off('error', onError)
        instance.off('remove', onRemove)
      }
      const onLoad = (): void => { cleanUp(); resolve() }
      const onError = (event: MapLibreErrorEvent): void => { cleanUp(); reject(event.error) }
      const onRemove = (): void => { cleanUp(); reject(new Error('Map closed before it finished loading.')) }
      instance.once('load', onLoad)
      instance.once('error', onError)
      instance.once('remove', onRemove)
    })
    if (disposed || attempt !== initAttempt || map !== instance) return
    addRouteLayer()
    updateStaticMap(true)
    instance.on('zoomend', updateMarkerVisibility)
    resizeObserver = new ResizeObserver(() => instance.resize())
    resizeObserver.observe(element)
    loading.value = false
  } catch (error) {
    if (disposed || attempt !== initAttempt) return
    map?.remove()
    map = null
    maplibre = null
    clearMarkers()
    loading.value = false
    problem.value = error instanceof Error ? error.message : 'The map could not load.'
  }
}

async function retry(): Promise<void> {
  resizeObserver?.disconnect()
  resizeObserver = null
  map?.remove()
  map = null
  maplibre = null
  clearMarkers()
  await nextTick()
  await initialise()
}

watch(
  () => [
    props.location?.areaId,
    props.homeCountry,
    props.destination?.areaId,
    props.trip?.id,
    props.trip?.status,
    props.departure?.lat,
    props.departure?.lon,
    (props.recentTrips ?? []).map(item => `${item.id}:${item.status}`).join('|'),
  ],
  () => updateStaticMap(true),
)
watch(
  () => [
    props.passport?.status,
    props.passport?.expiresAt,
    (props.visas ?? []).map(item => `${item.countryCode}:${item.status}:${item.validUntil}`).join('|'),
  ],
  updateMarkerReadiness,
)
watch(() => props.now, value => {
  updateVehicle()
  const minute = Math.floor(value / 60_000)
  if (minute !== lastReadinessMinute) {
    lastReadinessMinute = minute
    updateMarkerReadiness()
  }
})

onMounted(() => void initialise())
onBeforeUnmount(() => {
  disposed = true
  initAttempt += 1
  resizeObserver?.disconnect()
  clearMarkers()
  map?.remove()
  map = null
  maplibre = null
})
</script>

<template>
  <section class="travel-map" aria-label="Travel map">
    <div class="travel-map__viewport">
      <div ref="mapElement" class="travel-map__canvas" :aria-busy="loading || undefined"></div>

      <div v-if="loading" class="travel-map__state" role="status">
        <span class="travel-map__spinner" aria-hidden="true"></span>
        <strong>Opening the map…</strong>
      </div>

      <div v-else-if="problem" class="travel-map__state travel-map__state--error" role="alert">
        <strong>Map unavailable</strong>
        <span>{{ problem }}</span>
        <button class="btn sm" type="button" @click="retry">Try again</button>
      </div>

      <button class="travel-map__world glass" type="button" :disabled="loading || Boolean(problem)" @click="showWorld">
        World view
      </button>
    </div>

    <div class="travel-map__legend glass" aria-label="Travel document readiness">
      <span><i class="key key--domestic"></i><span><strong>Same country</strong><small>Ready · no documents</small></span></span>
      <span><i class="key key--bloc"></i><span><strong>{{ documentLegend.blocLabel }}</strong><small>{{ documentLegend.passportState }}</small></span></span>
      <span><i class="key key--visa"></i><span><strong>Other countries</strong><small>{{ documentLegend.visaState }}</small></span></span>
      <span v-if="recentTrips?.length" class="travel-map__visited-key"><i class="key key--visited">✓</i><strong>Visited</strong></span>
      <p>Documents only; fares checked after selection.</p>
    </div>
  </section>
</template>

<style scoped>
.travel-map {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.travel-map__viewport {
  position: relative;
  height: 300px;
  overflow: hidden;
  isolation: isolate;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: linear-gradient(145deg, var(--sky-soft), var(--surface-2));
  box-shadow: var(--shadow);
}

.travel-map__canvas { position: absolute; inset: 0; }

.travel-map__state {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  padding: 24px;
  text-align: center;
  color: var(--ink-2);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  backdrop-filter: blur(7px);
}

.travel-map__state button { min-height: 40px; }
.travel-map__state--error span { max-width: 42ch; font-size: 0.86rem; color: var(--muted); }
.travel-map__spinner { width: 30px; height: 30px; border: 4px solid var(--sky-soft); border-top-color: var(--sky); border-radius: 50%; animation: map-spin 0.8s linear infinite; }

.travel-map__legend {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
  gap: 7px 12px;
  width: 100%;
  padding: 9px 11px;
  border-radius: 12px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--ink-2);
}

.travel-map__legend > span { display: flex; align-items: center; gap: 6px; min-width: 0; }
.travel-map__legend > span > span { display: flex; min-width: 0; flex-direction: column; }
.travel-map__legend strong { font-size: 0.75rem; line-height: 1.25; }
.travel-map__legend small { color: var(--ink-2); font-size: 0.7rem; font-weight: 650; line-height: 1.25; }
.travel-map__legend p { grid-column: 1 / -1; color: var(--ink-2); font-size: 0.7rem; font-weight: 600; line-height: 1.25; }
.travel-map__visited-key { align-self: center; white-space: nowrap; }
.key { width: 9px; height: 9px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgba(28, 26, 36, 0.2); }
.key--domestic { background: var(--leaf); }
.key--bloc { background: var(--sky); }
.key--visa { background: var(--grape); }
.key--visited { display: grid; place-items: center; width: 13px; height: 13px; flex: none; color: #fff; border: 0; background: var(--accent-strong); font-size: 0.55rem; }

.travel-map__world {
  position: absolute;
  z-index: 3;
  top: 10px;
  left: 10px;
  min-height: 40px;
  padding: 0 11px;
  border-radius: 10px;
  color: var(--ink-2);
  font-size: 0.74rem;
  font-weight: 750;
}

.travel-map__world:disabled { opacity: 0.55; cursor: not-allowed; }

:global(.travel-map-pin) {
  position: relative;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  touch-action: manipulation;
}

:global(.travel-map-pin > span) {
  width: 15px;
  height: 15px;
  border: 3px solid #fff;
  border-radius: 50%;
  background: var(--muted);
  box-shadow: 0 2px 7px rgba(28, 26, 36, 0.38);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  color: #fff;
  font-size: 0.55rem;
  font-weight: 900;
  line-height: 9px;
  text-align: center;
}

:global(.travel-map-pin--domestic > span) { background: var(--leaf); }
:global(.travel-map-pin--bloc > span) { background: var(--sky); }
:global(.travel-map-pin--visa > span) { background: var(--grape); }
:global(.travel-map-pin.is-needed > span) { border-style: dashed; opacity: 0.88; }
:global(.travel-map-pin.is-processing > span) { animation: document-pulse 1.4s ease-in-out infinite; }
:global(.travel-map-pin.is-unknown > span) { background: var(--muted); }
:global(.travel-map-pin.is-visited > span) { box-shadow: 0 0 0 3px rgba(255, 176, 32, 0.7), 0 2px 7px rgba(28, 26, 36, 0.38); }
:global(.travel-map-pin:hover > span),
:global(.travel-map-pin:focus-visible > span),
:global(.travel-map-pin.is-selected > span) { transform: scale(1.4); box-shadow: 0 0 0 4px rgba(255, 176, 32, 0.34), 0 2px 8px rgba(28, 26, 36, 0.36); }

:global(.travel-map-pin::after) {
  content: attr(data-label);
  position: absolute;
  top: 34px;
  left: 50%;
  width: max-content;
  max-width: 170px;
  padding: 5px 8px;
  transform: translateX(-50%);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 8px;
  color: #fff;
  background: var(--ink);
  box-shadow: var(--shadow);
  font-size: 0.7rem;
  font-weight: 750;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.12s ease;
}

:global(.travel-map-pin:hover::after),
:global(.travel-map-pin:focus-visible::after),
:global(.travel-map-pin.is-selected::after),
:global(.travel-map-pin.show-label::after) { opacity: 1; visibility: visible; }

:global(.travel-current-marker) { display: grid; justify-items: center; border-radius: 11px; padding: 7px 10px; background: var(--ink); pointer-events: none; filter: drop-shadow(0 3px 7px rgba(28, 26, 36, 0.28)); }
:global(.travel-current-marker__pointer) { position: absolute; bottom: -6px; width: 14px; height: 14px; transform: rotate(45deg); border-radius: 3px; background: var(--ink); }
:global(.travel-current-marker__status) { z-index: 1; padding: 0; color: #ffd271; background: var(--ink); font-size: 0.62rem; font-weight: 800; }
:global(.travel-current-marker__label) { z-index: 1; max-width: 170px; padding: 1px 0 2px; overflow: hidden; color: #fff; background: var(--ink); font-size: 0.78rem; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
:global(.travel-current-marker__badge) { z-index: 1; padding: 0; color: #fff; background: var(--ink); font-size: 0.66rem; font-weight: 650; }
:global(.travel-vehicle-marker) { display: grid; place-items: center; width: 34px; height: 34px; border: 2px solid #fff; border-radius: 50%; background: var(--accent); box-shadow: 0 4px 12px rgba(28, 26, 36, 0.32); font-size: 1rem; }

:deep(.maplibregl-ctrl-group button) { width: 40px; height: 40px; }
:deep(.maplibregl-ctrl-attrib) { max-width: calc(100% - 12px); font-size: 10px; line-height: 14px; background: rgba(255, 253, 249, 0.86); }
:deep(.maplibregl-ctrl-attrib a) { color: var(--ink-2); }

/* Fingers get 44 px on the map's own controls. The place pins keep their size: their labels hang from it. */
@media (pointer: coarse) {
  .travel-map__state button, .travel-map__world { min-height: 44px; }
  :deep(.maplibregl-ctrl-group button) { width: 44px; height: 44px; }
}

@keyframes map-spin { to { transform: rotate(360deg); } }
@keyframes document-pulse { 50% { transform: scale(0.78); opacity: 0.7; } }

@media (max-width: 620px) {
  .travel-map__viewport { height: 260px; border-radius: 16px; }
  .travel-map__legend { gap: 7px 10px; padding: 8px 9px; }
  .travel-map__world { left: 8px; top: 8px; }
  :deep(.maplibregl-ctrl-top-right) { top: 4px; right: 4px; }
  :deep(.maplibregl-ctrl-attrib) { font-size: 9px; line-height: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .travel-map__spinner { animation: none; }
  :global(.travel-map-pin.is-processing > span) { animation: none; }
  :global(.travel-map-pin > span) { transition: none; }
  :global(.travel-map-pin::after) { transition: none; }
}
</style>
