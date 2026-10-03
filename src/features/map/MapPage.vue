<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Poi } from '../../geo/district.ts'
import type { Vec2 } from '../../shared/geo.ts'
import type { DistrictId, PlaceId } from '../../shared/ids.ts'
import { distance, parseDistrictId, tileToLatLon } from '../../shared/geo.ts'
import { distanceKm, TRAVEL } from '../../shared/travel.ts'
import { world, getEngine, getStreetContext, walkToPlace, enterVenue, returnToArrival, enterDistrict, leaveInterior } from '../../state/world.ts'
import { travel } from '../../state/travel.ts'
import { toast } from '../../state/app.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import MemberCard from '../people/MemberCard.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import StreetMap from './StreetMap.vue'
import { adjacentDistricts, destinationDistrict, lngLatToLocal, localToLngLat } from './geometry.ts'

const props = defineProps<{ transport?: { role: 'driver' | 'passenger' | null; canChooseDestination: boolean; canStopRide: boolean; connected: boolean; busy: boolean; status: string; pending: string; problem: string; retryLabel: string } }>()
const emit = defineEmits<{ transportDestination: [destination: { districtId: DistrictId; pos: Vec2; label: string; placeId?: PlaceId }]; transportStop: []; transportRetry: [] }>()
const router = useRouter()
const map = ref<InstanceType<typeof StreetMap> | null>(null)
const stage = ref<HTMLElement | null>(null)
const detailPanel = ref<HTMLElement | null>(null)
const query = ref('')
const listOpen = ref(false)
const layersOpen = ref(false)
const categories = ref<string[]>([])
const showPeople = ref(true)
const friendsOnly = ref(false)
const zoom = ref(16.4)
const position = ref<Vec2>({ x: 0, z: 0 })
const heading = ref(0)
const busy = ref(false)
const selected = ref<Poi | null>(null)
const memberId = ref<string | null>(null)
const point = ref<{ lng: number; lat: number } | null>(null)
const streetContext = ref<ReturnType<typeof getStreetContext>>(null)
const follow = ref(true)
const headingUp = ref(false)
const preview = ref<{ points: Vec2[]; length: number; viaStreets: boolean } | null>(null)
const routeStart = ref<Vec2 | null>(null)
const routePending = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let routeTimer: ReturnType<typeof setTimeout> | undefined
let lastRouteAt = 0
let lastRouteTarget = ''
let lastRoutePosition: Vec2 | null = null
let disposed = false
const transit = computed(() => Boolean(travel.state?.trip))
const indoors = computed(() => world.kind !== 'district')
const canWalk = computed(() => world.state === 'ready' && !indoors.value && !transit.value && !props.transport?.role && !!streetContext.value)
const mapDistrictId = computed(() => streetContext.value?.districtId ?? world.districtId)
const available = computed(() => mapDistrictId.value && parseDistrictId(mapDistrictId.value) && !transit.value)
const label = (category: string) => category.replaceAll('_', ' ')
const allCategories = computed(() => [...new Set(world.places.map(p => p.category))].sort())
const filtered = computed(() => world.places.filter(p => (!categories.value.length || categories.value.includes(p.category)) && `${p.name} ${label(p.category)} ${label(p.subclass)}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const sorted = computed(() => [...filtered.value].sort((a, b) => distance(a.pos, position.value) - distance(b.pos, position.value)))
const members = computed(() => showPeople.value ? world.members.filter(m => !friendsOnly.value || m.relation === 'friend') : [])
const selectedMember = computed(() => world.members.find(m => m.id === memberId.value) ?? null)
const rangeCenter = computed<[number, number] | null>(() => {
  const origin = travel.state?.walkingOrigin
  return origin ? [origin.lon, origin.lat] : null
})
const pointDistrict = computed(() => point.value ? destinationDistrict(point.value.lng, point.value.lat) : null)
const adjacent = computed(() => mapDistrictId.value ? adjacentDistricts(mapDistrictId.value) : [])
const adjacentTarget = computed(() => adjacent.value.find(d => d.id === pointDistrict.value))
const pointAllowed = computed(() => {
  if (!rangeCenter.value) return false
  const tile = pointDistrict.value && parseDistrictId(pointDistrict.value)
  return tile && distanceKm({ lon: rangeCenter.value[0], lat: rangeCenter.value[1] }, tileToLatLon(tile)) <= TRAVEL.localRangeKm
})
const pointHere = computed(() => pointDistrict.value === mapDistrictId.value)
const pointPosition = computed(() => point.value && mapDistrictId.value ? lngLatToLocal(mapDistrictId.value, point.value.lng, point.value.lat) : null)
const nearSelected = computed(() => selected.value && world.nearVenue?.placeId === selected.value.placeId)
const detailOpen = computed(() => Boolean(selected.value || point.value || selectedMember.value))
const detailVisible = computed(() => detailOpen.value && !listOpen.value && !layersOpen.value)
const routeTarget = computed(() => selected.value?.pos ?? (pointHere.value ? pointPosition.value : null))
const routeTargetKey = computed(() => selected.value ? `place:${selected.value.placeId}` : point.value && pointHere.value ? `point:${point.value.lng}:${point.value.lat}` : '')
const atDestination = computed(() => {
  const endpoint = preview.value?.points.at(-1)
  return !!endpoint && distance(position.value, endpoint) < 0.7
})
const hasRoute = computed(() => !!preview.value?.points.length)
const routePoints = computed<Vec2[]>(() => preview.value?.points.length && routeStart.value && !indoors.value ? [routeStart.value, ...preview.value.points] : [])
const routeDescription = computed(() => {
  if (indoors.value) return 'Step outside to see a walking route.'
  if (atDestination.value) return 'You are here'
  if (routePending.value) return 'Finding a walking route…'
  if (!hasRoute.value || !preview.value) return 'No walking route found yet'
  return `${Math.round(preview.value.length)} m · ~${Math.max(1, Math.ceil(preview.value.length / 80))} min`
})

function readPosition(): void {
  const engine = getEngine()
  const context = getStreetContext()
  const previous = streetContext.value
  if (previous?.districtId !== context?.districtId || previous?.approximate !== context?.approximate || (context && distance(previous?.position ?? position.value, context.position) > 0)) {
    streetContext.value = context ? { ...context, position: { ...context.position } } : null
  }
  if (transit.value) return
  const next = context?.position ?? world.arrival?.pos
  if (next && distance(position.value, next) > 0) position.value = { ...next }
  const nextHeading = !indoors.value && engine ? engine.facing : 0
  if (Math.abs(heading.value - nextHeading) > 0.001) heading.value = nextHeading
  scheduleRoute()
}
function metresAway(pos: Vec2): string {
  return `${Math.round(distance(pos, position.value))} m away`
}
function scheduleRoute(): void {
  const key = routeTargetKey.value
  const target = routeTarget.value
  if (!key || !target || indoors.value || !streetContext.value || transit.value || props.transport?.role) {
    clearTimeout(routeTimer); routeTimer = undefined; preview.value = null; routeStart.value = null; routePending.value = false; lastRouteTarget = ''; lastRoutePosition = null
    return
  }
  const changed = key !== lastRouteTarget
  const moved = !lastRoutePosition || distance(position.value, lastRoutePosition) >= 2
  if (!changed && !moved) return
  if (changed) { preview.value = null; routeStart.value = null; routePending.value = true }
  if (routeTimer) return
  const wait = Math.max(0, 1000 - (Date.now() - lastRouteAt))
  routeTimer = setTimeout(() => {
    routeTimer = undefined
    lastRouteAt = Date.now()
    lastRouteTarget = routeTargetKey.value
    lastRoutePosition = { ...position.value }
    routeStart.value = lastRoutePosition
    preview.value = getEngine()?.previewWalkTo(routeTarget.value ?? position.value) ?? null
    routePending.value = false
  }, wait)
}
function resetSelection(): void { selected.value = null; point.value = null; memberId.value = null; scheduleRoute() }
function choose(poi: Poi): void { resetSelection(); selected.value = poi; follow.value = false; listOpen.value = false; layersOpen.value = false; map.value?.focus(poi); scheduleRoute() }
function choosePoint(lng: number, lat: number): void { resetSelection(); point.value = { lng, lat }; follow.value = false; listOpen.value = false; layersOpen.value = false; scheduleRoute() }
function chooseMember(id: string): void { resetSelection(); memberId.value = id; follow.value = false; listOpen.value = false; layersOpen.value = false }
function toggleCategory(category: string): void { categories.value = categories.value.includes(category) ? categories.value.filter(c => c !== category) : [...categories.value, category] }
function close(): void { void router.push('/') }
function noRoute(): void {
  preview.value = null; routeStart.value = null; routePending.value = false
  lastRouteTarget = routeTargetKey.value; lastRoutePosition = { ...position.value }
  toast('No walking route found yet', 'info')
}
function walk(): void {
  if (!canWalk.value || !hasRoute.value || atDestination.value) return
  const engine = getEngine()
  const target = routeTarget.value
  const latest = target && engine?.previewWalkTo(target)
  if (!target || !latest?.points.length) { noRoute(); return }
  const route = selected.value ? walkToPlace(selected.value) : engine?.walkTo(target)
  if (!route || ('status' in route && route.status === 'unreachable') || route.length === 0) { noRoute(); return }
  toast(`Walking ${Math.round(route.length)} m${route.viaStreets ? ' along the streets' : ''}.`, 'info'); close()
}
async function enter(): Promise<void> {
  if (!selected.value || !nearSelected.value || !canWalk.value) return
  busy.value = true; await enterVenue(selected.value); busy.value = false
  if (world.kind === 'venue') close()
}
/**
 * Leave the room and keep what was chosen on the map. Entering the street changes the room, which
 * clears the selection like any other scene change; the choice is put back only when the street
 * that loaded is the district it was made in, and (for a place) that district still lists it. The
 * route is then worked out afresh from where the member now stands.
 */
async function stepOutside(): Promise<void> {
  if (busy.value) return
  const chosen = { placeId: selected.value?.placeId ?? null, point: point.value && pointHere.value ? { ...point.value } : null, districtId: mapDistrictId.value }
  busy.value = true
  try { await leaveInterior() } finally { busy.value = false }
  // The room watcher runs before this continues; wait for it so it cannot clear what is restored here.
  await nextTick()
  if (disposed || world.state !== 'ready' || world.kind !== 'district' || !chosen.districtId || world.districtId !== chosen.districtId) return
  if (selected.value || point.value || memberId.value) return
  const place = chosen.placeId ? world.places.find(poi => poi.placeId === chosen.placeId) : null
  if (place) selected.value = place
  else if (chosen.point && !chosen.placeId) point.value = chosen.point
  else return
  readPosition()
}
async function goDistrict(): Promise<void> {
  if (!canWalk.value || !adjacentTarget.value || !pointAllowed.value || !point.value || !pointDistrict.value) return
  busy.value = true
  const ok = await enterDistrict(pointDistrict.value, { at: lngLatToLocal(pointDistrict.value, point.value.lng, point.value.lat), areaLabel: world.areaLabel })
  busy.value = false
  if (ok) close()
}
const rideDestination = computed(() => {
  if (selected.value && mapDistrictId.value) return { districtId: mapDistrictId.value, pos: { ...selected.value.pos }, label: selected.value.name, placeId: selected.value.placeId }
  if (point.value && pointDistrict.value) return { districtId: pointDistrict.value, pos: lngLatToLocal(pointDistrict.value, point.value.lng, point.value.lat), label: 'Selected map location' }
  return null
})
function chooseRide(): void {
  if (!props.transport?.canChooseDestination || !rideDestination.value) return
  emit('transportDestination', rideDestination.value)
}
function centreOnMe(): void { follow.value = true; map.value?.centre() }
function city(): void { if (!rangeCenter.value) return; resetSelection(); layersOpen.value = false; follow.value = false; map.value?.city() }
function arrival(): void { if (canWalk.value) { returnToArrival(); readPosition(); resetSelection(); centreOnMe() } }
function resultsKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') { event.preventDefault(); document.querySelector<HTMLButtonElement>('.map-result')?.focus() }
  else if (event.key === 'Enter' && sorted.value[0]) { event.preventDefault(); choose(sorted.value[0]) }
}
function listKey(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.map-result')]
  const index = buttons.findIndex(b => b === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault(); buttons[next]?.focus()
}
watch([listOpen, layersOpen], ([list, layers]) => { if (list || layers) void nextTick(() => stage.value?.scrollIntoView?.({ block: 'nearest' })) })
watch(detailVisible, visible => { if (visible) void nextTick(() => detailPanel.value?.scrollIntoView({ block: 'nearest' })) })
watch(query, () => { listOpen.value = true; layersOpen.value = false; resetSelection() })
watch(() => world.roomKey, () => { resetSelection(); categories.value = []; readPosition() })
onMounted(() => { readPosition(); timer = setInterval(readPosition, 200) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer); clearTimeout(routeTimer) })
</script>

<template>
  <section class="map-page" aria-label="Neighbourhood map">
    <header class="map-head">
      <div class="grow"><h1>Map <span>{{ world.areaLabel || 'Your neighbourhood' }}</span></h1><p>{{ indoors && available ? `You are inside ${world.title}` : world.street || 'Find a place. Make your next move.' }}</p></div>
      <button class="btn icon" aria-label="Close map and return to the world" @click="close">✕</button>
    </header>
    <section v-if="transport" class="map-transport" aria-label="Ride controls">
      <p class="map-meta" role="status">{{ transport.pending || transport.status }}</p>
      <p v-if="transport.problem" class="problem" role="alert">{{ transport.problem }}</p>
      <div class="map-detail-actions">
        <button v-if="transport.canStopRide" class="btn" type="button" :disabled="transport.busy" @click="emit('transportStop')">Stop ride</button>
        <button v-if="transport.retryLabel" class="btn" type="button" :disabled="!transport.connected || !!transport.pending" @click="emit('transportRetry')">{{ transport.retryLabel }}</button>
        <button class="btn" type="button" @click="close">Return to world</button>
      </div>
      <p v-if="transport.canStopRide" class="map-meta">Stopping before departure returns the fare once. After departure, no fare is returned.</p>
    </section>
    <p v-if="world.state === 'error'" class="map-state-error" role="alert">{{ world.error }} <button class="btn sm" @click="router.push('/travel')">Open Travel</button></p>
    <div v-if="!available" class="map-empty">
      <h2>{{ transit ? 'Your journey is underway' : 'Your street map starts here' }}</h2>
      <p>{{ transit ? 'You are between places. Your live street map returns when you arrive.' : 'Enter a neighbourhood to see its streets, places and people.' }}</p>
      <button class="btn primary" @click="router.push('/travel')">{{ transit ? 'View journey' : 'Open Travel' }}</button>
    </div>
    <template v-else-if="mapDistrictId">
      <div class="map-tools">
        <label class="map-search"><span class="sr-only">Search places by name or category</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input v-model="query" type="search" placeholder="Find a place" aria-controls="map-list" :aria-expanded="listOpen" @focus="listOpen = true; layersOpen = false" @keydown="resultsKey" /></label>
        <button class="btn map-tool" :class="{ active: layersOpen }" :aria-expanded="layersOpen" aria-controls="map-layers" @click="layersOpen = !layersOpen; listOpen = false">Options<span v-if="categories.length" class="filter-count">{{ categories.length }}</span></button>
      </div>
      <div ref="stage" class="map-stage">
        <StreetMap ref="map" :district-id="mapDistrictId" :position="position" :heading="heading" :places="filtered" :members="indoors ? [] : members" :arrival="world.arrival" :selected="selected" :target="point ? [point.lng, point.lat] : null" :route="routePoints" :range-center="rangeCenter" :follow="follow" :heading-up="headingUp" :indoors="indoors" :show-position="!!streetContext" @place="choose" @point="choosePoint" @member="chooseMember" @zoom="zoom = $event" @pan="follow = false" />
        <div class="map-actions" aria-label="Map controls">
          <button class="btn icon" title="Centre on me and follow" aria-label="Centre on me and follow" :aria-pressed="follow" @click="centreOnMe"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg></button>
        </div>
        <aside v-if="listOpen" id="map-list" class="map-sheet map-list" aria-label="Places in this district">
          <div class="map-sheet-head"><h2>{{ query ? 'Search results' : 'Around you' }}</h2><button class="btn icon" aria-label="Close places list" @click="listOpen = false">✕</button></div>
          <p class="map-meta">{{ filtered.length }} places · {{ indoors ? 'Street locations' : 'Nearest first' }}</p>
          <div class="map-results" @keydown="listKey">
            <button v-for="poi in sorted" :key="poi.placeId" class="map-result" @click="choose(poi)"><span class="map-category" :style="{ background: categoryStyle(poi.category).color }" aria-hidden="true">{{ categoryStyle(poi.category).icon }}</span><span class="grow"><strong>{{ poi.name }}</strong><small>{{ label(poi.category) }} · {{ metresAway(poi.pos) }}</small></span><span aria-hidden="true">›</span></button>
            <p v-if="!filtered.length" class="map-no-results">{{ world.places.length ? 'No places match. Try a different name or clear your category filters.' : 'No public places are mapped in this district yet. You can still choose a street point.' }}</p>

          </div>
        </aside>
        <aside v-if="layersOpen" id="map-layers" class="map-sheet map-layers" aria-label="Map options">
          <div class="map-sheet-head"><h2>Map options</h2><button class="btn icon" aria-label="Close map options" @click="layersOpen = false">✕</button></div>
          <div class="map-layer-scroll"><div class="map-option-list">          <button class="btn map-option" title="Heading up" aria-label="Heading up" :aria-pressed="headingUp" @click="headingUp = !headingUp">Heading up</button>
          <button class="btn map-option" title="View city and walking range" aria-label="View city and walking range" :disabled="!rangeCenter" @click="city">View city & walking range</button>
          <button class="btn map-option" @click="map?.zoomIn()">Zoom in</button><button class="btn map-option" @click="map?.zoomOut()">Zoom out</button>
          <button class="btn map-option" :disabled="!canWalk" @click="arrival(); layersOpen = false">Back to arrival point</button>
          <button class="btn map-option" @click="router.push('/travel')">Travel to another city ↗</button>
</div><details class="map-disclosure"><summary>Place filters <span v-if="categories.length">· {{ categories.length }} selected</span></summary><div class="map-chips"><button class="btn sm" :aria-pressed="!categories.length" @click="categories = []">All places</button><button v-for="category in allCategories" :key="category" class="btn sm" :aria-pressed="categories.includes(category)" @click="toggleCategory(category)"><span aria-hidden="true">{{ categoryStyle(category).icon }}</span>{{ label(category) }}</button></div></details>
          <details class="map-disclosure"><summary>People in this room · {{ world.members.length }}</summary><label class="map-check"><input v-model="showPeople" type="checkbox" /> People in this room</label><label class="map-check"><input v-model="friendsOnly" type="checkbox" :disabled="!showPeople" /> Friends only</label>            <template v-if="showPeople"><button v-for="member in members" :key="member.id" class="map-result" @click="chooseMember(member.id)"><MemberBadge :member-id="member.id" :look="member.look" :size="36" /><span class="grow"><strong>{{ member.displayName }}</strong><small>{{ member.relation === 'friend' ? 'Friend' : 'In your room' }}</small></span></button><p v-if="!members.length" class="map-no-results">{{ friendsOnly ? 'No friends in this room right now.' : 'You have this room to yourself right now.' }}</p></template>
          </details><details class="map-disclosure"><summary>Map legend</summary><div class="map-legend"><p><b class="legend-me">▲</b> Your character · live position</p><p><b class="legend-arrival">A</b> Public arrival point</p><p><b class="legend-route">━</b> Blue line · walking route to your chosen place</p><p><b class="legend-route">┈</b> Blue dots · from where the route ends to the mapped spot</p><p><b class="legend-friend">●</b> Gold portrait border · friend</p><p><b>┄</b> Amber boundary · loaded district</p><p><b class="legend-arrival">┄</b> Green boundary · neighbouring district</p><p>Numbered pins group nearby places. Zoom in to separate them and reveal names.</p><p>People appear only in your current room.</p></div></details></div>
        </aside>

        <div v-if="!detailOpen && !listOpen && !layersOpen && (indoors || zoom < 12 || !streetContext)" class="map-hint"><span v-if="zoom < 12 && rangeCenter">{{ TRAVEL.localRangeKm }} km local range · beyond the green boundary needs a trip</span><span v-else>{{ indoors ? (streetContext ? 'Surrounding streets · door position is approximate' : 'Surrounding map · street position unavailable') : streetContext ? 'Tap a place or street to make your next move' : 'Street position unavailable · showing the public arrival point' }}</span><button v-if="zoom < 12" class="btn sm" @click="router.push('/travel')">Travel</button></div>
      </div>
        <aside v-if="detailVisible" ref="detailPanel" class="map-detail" :class="{ 'member-detail': selectedMember }" aria-label="Selected map location" aria-live="polite">
          <template v-if="selectedMember"><MemberCard :key="selectedMember.id" :member="selectedMember" closable compact subtitle="In your current room" @close="resetSelection" @changed="resetSelection" /></template>
          <template v-else><div class="map-sheet-head"><div class="grow"><h2>{{ selected?.name || (pointHere ? 'Selected street point' : adjacentTarget ? 'Explore the next district' : 'Keep exploring') }}</h2><p v-if="selected" class="map-kind"><span class="map-kind-dot" :style="{ background: categoryStyle(selected.category).color }" aria-hidden="true">{{ categoryStyle(selected.category).icon }}</span><span>{{ label(selected.category) }}</span></p></div><button class="btn icon" aria-label="Clear map selection" @click="resetSelection">✕</button></div>
            <p v-if="transport?.role" class="map-meta">{{ transport.status }}. {{ transport.role === 'passenger' ? 'You can explore the map while the driver controls the vehicle.' : 'Choose a destination for this drive.' }}</p>
            <div v-if="transport && rideDestination" class="map-detail-actions"><button class="btn primary" type="button" :disabled="!transport.canChooseDestination" @click="chooseRide">{{ transport.role === 'passenger' ? 'View selected location' : transport.role === 'driver' ? 'Set driving destination' : 'Ride there' }}</button></div>
            <template v-if="!transport?.role && (selected || pointHere)"><p class="map-distance">{{ routeDescription }} <span>{{ indoors && streetContext?.approximate ? 'Approximate street position at the door' : preview?.viaStreets ? 'Along walkable streets' : '' }}</span></p><div class="map-detail-actions"><button v-if="indoors" class="btn primary" :disabled="busy" @click="stepOutside">{{ busy ? 'Stepping outside…' : 'Step outside' }}</button><button v-else-if="nearSelected" class="btn primary" :disabled="!canWalk || busy" @click="enter">Enter {{ selected?.name }}</button><button v-else class="btn primary" :disabled="!canWalk || !hasRoute || atDestination || busy" @click="walk">{{ atDestination ? 'You are here' : selected ? 'Walk there' : 'Walk here' }}</button></div></template>
            <template v-else-if="!transport?.role && adjacentTarget && pointAllowed"><p class="map-meta">This neighbouring district is within walking range. Load its streets to continue exploring.</p><button class="btn primary" :disabled="!canWalk || busy" @click="goDistrict">Go to this district</button></template>
            <template v-else-if="!transport?.role"><p class="map-meta">{{ !rangeCenter ? 'Your local walking range is unavailable. Open Travel to plan your next move.' : pointAllowed ? 'Walk through neighbouring districts to reach this area, or open Travel to plan your next move.' : `This is beyond your ${TRAVEL.localRangeKm} km local walking range. Plan a trip to get there.` }}</p><button class="btn primary" @click="router.push('/travel')">Open Travel</button></template>
          </template>
        </aside>
    </template>
  </section>
</template>

<style scoped>
.map-page { height: 100%; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--surface); overflow-y: auto; overscroll-behavior: contain; scroll-padding-top: 58px; }
.map-transport { padding: 10px 18px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.map-transport .map-detail-actions { flex-wrap: wrap; }
.map-transport ~ .map-stage { min-height: 0; }
.map-transport p { margin: 0 0 8px; }
.map-transport p:last-child { margin-bottom: 0; }
.map-head { padding: 14px 18px; display: flex; align-items: center; gap: 10px; }
.map-head h1 { font-size: 22px; display: flex; align-items: baseline; gap: 14px; }
.map-head h1 span { font-size: 14px; color: var(--ink-2); font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-head p { font-size: 12px; color: var(--ink-2); margin-top: 3px; }
.map-stage { position: relative; flex: 1; min-height: 160px; overflow: hidden; isolation: isolate; }
.map-tools { display: flex; align-items: center; gap: 8px; padding: 0 14px 12px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 4; background: var(--surface); flex: none; }
.map-search { display: flex; align-items: center; gap: 9px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 12px; padding: 0 12px; flex: 1; min-width: 0; height: 44px; }
.map-search input { border: 0; outline: 0; background: transparent; width: 100%; min-width: 0; font-size: 14px; }
.map-search:focus-within { outline: 3px solid var(--sky); outline-offset: 1px; }
.map-search input::placeholder { color: var(--ink-2); }
.map-tool { height: 44px; padding: 0 13px; font-size: 13px; }
.map-tool span { margin-left: 5px; font-size: 11px; color: var(--ink-2); }
.map-actions { z-index: 2; position: absolute; right: 12px; bottom: 60px; }
.map-actions .btn { width: 44px; height: 44px; box-shadow: var(--shadow); }
.map-actions [aria-pressed=true] { background: var(--accent-soft); border-color: var(--accent-strong); color: var(--accent-text); }
.map-sheet { z-index: 3; position: absolute; left: 12px; top: 12px; width: 330px; max-height: calc(100% - 64px); border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface); padding: 14px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 10px; }
.map-sheet-head { display: flex; align-items: center; gap: 8px; }
.map-sheet-head h2 { font-size: 18px; overflow-wrap: anywhere; }
.map-sheet-head > h2 { flex: 1; }
.map-sheet-head .btn { flex: none; }
.map-meta { font-size: 12px; color: var(--ink-2); }
.map-results,.map-layer-scroll { overflow-y: auto; overscroll-behavior: contain; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--line-strong) var(--surface); }
.map-result { width: 100%; display: flex; align-items: center; gap: 11px; padding: 11px 2px; border: 0; border-bottom: 1px solid var(--line); text-align: left; background: none; }
.map-result:hover { background: var(--surface-2); }
.map-result strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
.map-result small { display: block; font-size: 11px; color: var(--ink-2); margin-top: 3px; }
.map-category { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 50%; font-size: 18px; }
.map-no-results { font-size: 13px; color: var(--ink-2); padding: 12px 0; }
.map-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 18px; }
.map-chips .btn { white-space: normal; text-align: left; min-height: 44px; }
.map-chips [aria-pressed=true] { background: var(--accent-soft); border-color: var(--accent-strong); }
.map-check { display: flex; align-items: center; gap: 9px; min-height: 44px; font-size: 13px; }
.map-check input { width: 18px; height: 18px; accent-color: var(--accent-text); }
.map-legend { display: grid; gap: 10px; font-size: 12px; color: var(--ink-2); margin-top: 16px; border-top: 1px solid var(--line); padding-top: 14px; }
.map-legend b { display: inline-block; min-width: 24px; color: var(--accent-text); }
.map-legend .legend-me { color: #263a60; }.map-legend .legend-arrival { color: #287451; }.map-legend .legend-friend { color: #a86a00; }.map-legend .legend-route { color: #285ca1; }
.map-kind { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 12px; color: var(--ink-2); text-transform: capitalize; }
.map-kind-dot { width: 20px; height: 20px; flex: none; display: grid; place-items: center; border-radius: 50%; font-size: 12px; }
.map-detail { flex: none; padding: 14px 18px; border-top: 1px solid var(--line); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 24px; max-height: 44%; overflow-y: auto; background: var(--surface); }
.map-detail.member-detail { display: block; }
.map-detail .map-sheet-head { grid-row: 1; grid-column: 1 / -1; }
.map-detail-actions { align-self: center; }
.map-detail-actions .btn { min-height: 44px; }
.map-option-list { display: grid; gap: 4px; }
.map-option { justify-content: flex-start; min-height: 44px; border: 0; box-shadow: none; background: transparent; text-align: left; }
.map-option[aria-pressed=true], .map-tool.active { background: var(--accent-soft); color: var(--accent-text); }
.map-disclosure { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 4px; }
.map-disclosure summary { min-height: 44px; padding: 12px 0; font-weight: 650; cursor: pointer; font-size: 13px; }
.map-disclosure summary:focus-visible { outline: 3px solid var(--sky); outline-offset: 2px; }
.map-distance { font-size: 18px; font-weight: 750; font-variant-numeric: tabular-nums; }
.map-distance span { display: block; font-size: 11px; font-weight: 450; color: var(--ink-2); }
.map-detail-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.map-hint { position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%); background: #fffdf9ed; border-radius: 6px; padding: 6px 10px; font-size: 12px; max-width: calc(100% - 132px); display: flex; align-items: center; gap: 8px; }
.map-state-error { padding: 8px 14px; background: var(--coral-soft); font-size: 13px; }
.map-empty { margin: auto; padding: 32px; max-width: 420px; display: grid; gap: 16px; }
/* A short window (a phone on its side): the page scrolls inside the window, the search bar stays in reach, and the stage keeps room for its sheet so a result is never clipped. */
@media (max-height: 560px) {
  .map-head { padding: 8px max(14px, env(safe-area-inset-right)) 8px max(14px, env(safe-area-inset-left)); }.map-head h1 { font-size: 18px; }
  .map-transport { padding: 6px max(14px, env(safe-area-inset-right)) 6px max(14px, env(safe-area-inset-left)); }.map-transport p { margin-bottom: 4px; }
  .map-tools { padding-left: max(14px, env(safe-area-inset-left)); padding-right: max(14px, env(safe-area-inset-right)); }
  .map-stage { flex: 1 0 220px; min-height: 220px; }
  .map-sheet { left: max(12px, env(safe-area-inset-left)); top: 8px; bottom: 8px; width: min(330px, calc(100% - 24px)); max-height: none; }
  .map-actions { right: max(12px, env(safe-area-inset-right)); }
  .map-detail { padding-left: max(18px, env(safe-area-inset-left)); padding-right: max(18px, env(safe-area-inset-right)); }
}
@media (max-width: 600px) {
  .map-head { padding: 10px 12px; }.map-head h1 { font-size: 20px; gap: 10px; }.map-head h1 span { max-width: 220px; font-size: 12px; }.map-head p { max-width: 270px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .map-tools { padding: 0 10px 10px; gap: 8px; }.map-search { padding: 0 10px; gap: 8px; }.map-search input { font-size: 16px; }.map-tool { padding: 0 12px; font-size: 13px; }
  .map-sheet { top: 8px; bottom: 42px; left: 8px; right: 8px; width: auto; max-height: none; padding: 14px; }
  .map-detail { padding: 12px; gap: 6px 12px; max-height: 42%; }
  .map-detail .map-sheet-head h2 { font-size: 18px; }.map-distance { font-size: 16px; }
  .map-detail-actions .btn { white-space: normal; max-width: 160px; }
  .map-hint { max-width: calc(100% - 90px); left: 12px; transform: none; bottom: 82px; padding: 6px 8px; font-size: 11px; }
}
</style>
