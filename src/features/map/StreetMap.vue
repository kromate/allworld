<script setup lang="ts">
import { h, nextTick, onBeforeUnmount, onMounted, ref, render, watch } from 'vue'
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'
import type { Map as LibreMap, Marker } from 'maplibre-gl'
import type { DistrictId } from '../../shared/ids.ts'
import type { Vec2 } from '../../shared/geo.ts'
import type { PresenceMember } from '../../shared/model.ts'
import type { Poi } from '../../geo/district.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import AvatarPortrait from '../avatar/AvatarPortrait.vue'
import { TRAVEL } from '../../shared/travel.ts'
import { adjacentDistricts, districtPolygon, lngLatToLocal, localToLngLat, walkingRange } from './geometry.ts'

const props = defineProps<{
  districtId: DistrictId; position: Vec2; heading: number; places: Poi[]; members: PresenceMember[]
  arrival: { pos: Vec2; label: string } | null; selected: Poi | null; rangeCenter: [number, number] | null; indoors: boolean; showPosition: boolean; target: [number, number] | null; route: Vec2[]; follow: boolean; headingUp: boolean
}>()
const emit = defineEmits<{ place: [poi: Poi]; point: [lng: number, lat: number]; member: [id: string]; zoom: [value: number]; pan: [] }>()
const container = ref<HTMLElement | null>(null)
const loading = ref(true)
const problem = ref('')
let map: LibreMap | null = null
let libre: typeof import('maplibre-gl') | null = null
let me: Marker | null = null
let arrival: Marker | null = null
let selected: Marker | null = null
const people = new Map<string, Marker>()
let resize: ResizeObserver | null = null
let deadline: ReturnType<typeof setTimeout> | undefined
let disposed = false
let attempt = 0
let fittedRoute = ''
let hiddenName = ''
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400
/** Metres between a route's end and the mapped spot before the dotted link is worth drawing. */
const APPROACH_GAP = 6
/** How much the other places fade while one destination is chosen. */
const DIMMED = 0.5

function placeData(): FeatureCollection<Point> {
  return { type: 'FeatureCollection', features: props.places.map(poi => ({ type: 'Feature', properties: { id: poi.placeId, name: poi.name, category: poi.category }, geometry: { type: 'Point', coordinates: localToLngLat(props.districtId, poi.pos) } })) }
}
function setPlaces(): void {
  if (!map || !libre || !map.getSource('places')) return
  for (const poi of props.places) {
    const id = `pin-${poi.category}`
    if (map.hasImage(id)) continue
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    const style = categoryStyle(poi.category)
    ctx.beginPath(); ctx.arc(40, 40, 33, 0, Math.PI * 2); ctx.fillStyle = style.color; ctx.fill()
    ctx.lineWidth = 5; ctx.strokeStyle = '#fffdf9'; ctx.stroke()
    ctx.font = '34px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(style.icon, 40, 42)
    map.addImage(id, ctx.getImageData(0, 0, 80, 80), { pixelRatio: 2 })
  }
  const source = map.getSource('places')
  if (source instanceof libre.GeoJSONSource) void source.setData(placeData())
}
function rangeData(): FeatureCollection<Polygon> {
  return { type: 'FeatureCollection', features: props.rangeCenter ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: walkingRange(props.rangeCenter, TRAVEL.localRangeKm) } }] : [] }
}
/**
 * The walking route, the point where it ends, and a dotted link when that end is not the mapped
 * spot itself. The engine stops a route at the nearest place that can be walked to; the link shows
 * that gap honestly instead of stretching the route over ground nobody can walk.
 */
function routeData(): FeatureCollection<LineString | Point> {
  const end = props.route.at(-1)
  if (props.route.length < 2 || !end) return { type: 'FeatureCollection', features: [] }
  const features: Feature<LineString | Point>[] = [
    { type: 'Feature', properties: { part: 'route' }, geometry: { type: 'LineString', coordinates: props.route.map(point => localToLngLat(props.districtId, point)) } },
    { type: 'Feature', properties: { part: 'end' }, geometry: { type: 'Point', coordinates: localToLngLat(props.districtId, end) } },
  ]
  const mapped = props.selected?.pos ?? (props.target ? lngLatToLocal(props.districtId, props.target[0], props.target[1]) : null)
  if (mapped && Math.hypot(mapped.x - end.x, mapped.z - end.z) > APPROACH_GAP) {
    features.push({ type: 'Feature', properties: { part: 'approach' }, geometry: { type: 'LineString', coordinates: [localToLngLat(props.districtId, end), localToLngLat(props.districtId, mapped)] } })
  }
  return { type: 'FeatureCollection', features }
}
function updateRoute(): void {
  const source = map?.getSource('walk-route')
  if (libre && source instanceof libre.GeoJSONSource) void source.setData(routeData())
  if (props.route.length < 2) { fittedRoute = ''; return }
  const key = `${props.districtId}:${props.selected?.placeId ?? props.target?.join(',')}:${container.value?.clientWidth}:${container.value?.clientHeight}`
  if (!map || !libre || props.follow || key === fittedRoute) return
  fittedRoute = key
  const instance = map
  const bounds = new libre.LngLatBounds()
  for (const point of props.route) bounds.extend(localToLngLat(props.districtId, point))
  void nextTick(() => {
    if (map !== instance) return
    const padding = { top: 36, right: 68, bottom: 64, left: 36 }
    instance.fitBounds(bounds, { padding, maxZoom: 17.5, duration: motion() })
  })
}
function updateRange(): void {
  const source = map?.getSource('range')
  if (libre && source instanceof libre.GeoJSONSource) void source.setData(rangeData())
}
function bearing(): number { return props.headingUp ? 180 - props.heading * 180 / Math.PI : 0 }
function followPosition(): void {
  updateMe()
  if (!map || !props.follow || !props.showPosition || document.hidden) return
  map.easeTo({ center: localToLngLat(props.districtId, props.position), bearing: bearing(), duration: motion() ? 220 : 0 })
}
function addLayers(): void {
  if (!map) return
  const polygons: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { current: true }, geometry: { type: 'Polygon', coordinates: districtPolygon(props.districtId) } },
    ...adjacentDistricts(props.districtId).map(d => ({ type: 'Feature' as const, properties: { current: false }, geometry: { type: 'Polygon' as const, coordinates: d.coordinates } })),
  ] }
  map.addSource('districts', { type: 'geojson', data: polygons })
  map.addLayer({ id: 'district-fill', type: 'fill', source: 'districts', minzoom: 12, paint: { 'fill-color': ['case', ['get', 'current'], '#efab28', '#608b7d'], 'fill-opacity': 0.045 } })
  map.addLayer({ id: 'district-edge', type: 'line', source: 'districts', minzoom: 12, paint: { 'line-color': ['case', ['get', 'current'], '#a56812', '#628575'], 'line-width': ['case', ['get', 'current'], 2.5, 1.5], 'line-dasharray': [3, 3] } })
  map.addSource('range', { type: 'geojson', data: rangeData() })
  map.addLayer({ id: 'range-fill', type: 'fill', source: 'range', maxzoom: 12, paint: { 'fill-color': '#38835f', 'fill-opacity': 0.1 } })
  map.addLayer({ id: 'range-edge', type: 'line', source: 'range', maxzoom: 12, paint: { 'line-color': '#287650', 'line-width': 2, 'line-dasharray': [3, 2] } })
  map.addSource('walk-route', { type: 'geojson', data: routeData() })
  map.addLayer({ id: 'walk-route-casing', type: 'line', source: 'walk-route', filter: ['==', ['get', 'part'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fffdf9', 'line-width': 8 } })
  map.addLayer({ id: 'walk-route-line', type: 'line', source: 'walk-route', filter: ['==', ['get', 'part'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#285ca1', 'line-width': 4 } })
  map.addLayer({ id: 'walk-route-approach', type: 'line', source: 'walk-route', filter: ['==', ['get', 'part'], 'approach'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#285ca1', 'line-width': 3, 'line-dasharray': [0.1, 2] } })
  map.addLayer({ id: 'walk-route-end', type: 'circle', source: 'walk-route', filter: ['==', ['get', 'part'], 'end'], paint: { 'circle-radius': 5, 'circle-color': '#fffdf9', 'circle-stroke-width': 3, 'circle-stroke-color': '#285ca1' } })
  map.addSource('places', { type: 'geojson', data: placeData(), cluster: true, clusterRadius: 42, clusterMaxZoom: 16 })
  map.addLayer({ id: 'clusters', type: 'circle', source: 'places', filter: ['has', 'point_count'], paint: { 'circle-color': '#1c1a24', 'circle-radius': 20, 'circle-stroke-width': 3, 'circle-stroke-color': '#fffdf9' } })
  map.addLayer({ id: 'counts', type: 'symbol', source: 'places', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Regular'], 'text-size': 13 }, paint: { 'text-color': '#ffffff' } })
  setPlaces()
  map.addLayer({ id: 'pins', type: 'symbol', source: 'places', filter: ['!', ['has', 'point_count']], layout: { 'icon-image': ['concat', 'pin-', ['get', 'category']], 'icon-allow-overlap': false, 'icon-padding': 5 } })
  map.addLayer({ id: 'names', type: 'symbol', source: 'places', minzoom: 16.5, filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-anchor': 'top', 'text-offset': [0, 2], 'text-max-width': 12 }, paint: { 'text-color': '#332c26', 'text-halo-color': '#fffdf9', 'text-halo-width': 2 } })
}
function updateMe(): void {
  if (!map || !libre) return
  if (!props.showPosition) { me?.remove(); me = null; return }
  if (!me) {
    const el = document.createElement('div'); el.className = 'street-me'; el.setAttribute('role', 'img')
    el.setAttribute('aria-label', props.indoors ? 'The door you used on the street map' : 'Your live position')
    el.innerHTML = '<span></span>'
    me = new libre.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(localToLngLat(props.districtId, props.position)).addTo(map)
  }
  me.setLngLat(localToLngLat(props.districtId, props.position)).setRotation(180 - props.heading * 180 / Math.PI)
}
function updatePeople(): void {
  if (!map || !libre) return
  const ids = new Set<string>(props.members.map(m => m.id))
  for (const [id, marker] of people) if (!ids.has(id)) { render(null, marker.getElement()); marker.remove(); people.delete(id) }
  const occupied: { x: number; y: number }[] = []
  for (const member of props.members) {
    let marker = people.get(member.id)
    if (!marker) {
      const el = document.createElement('button'); el.type = 'button'; el.className = 'street-person'
      el.addEventListener('click', event => { event.stopPropagation(); emit('member', member.id) })
      marker = new libre.Marker({ element: el, offset: [0, -36] }).setLngLat(localToLngLat(props.districtId, member.pos)).addTo(map)
      people.set(member.id, marker)
    }
    const el = marker.getElement(); el.classList.toggle('friend', member.relation === 'friend')
    el.setAttribute('aria-label', `${member.displayName}${member.relation === 'friend' ? ', friend' : ', in your room'}`)
    el.title = member.displayName
    render(h(AvatarPortrait, { look: member.look, memberId: member.id, size: 38, alt: '' }), el)
    const coordinate = localToLngLat(props.districtId, member.pos)
    const projected = map.project(coordinate)
    const nearby = occupied.filter(p => Math.hypot(p.x - projected.x, p.y - projected.y) < 48).length
    const offset = nearby === 0 ? 0 : Math.ceil(nearby / 2) * 42 * (nearby % 2 ? -1 : 1)
    marker.setLngLat(coordinate).setOffset([offset, -40])
    occupied.push(projected)
  }
}
/** While a destination is chosen the other places fade, so it and its route are what the eye finds. */
function updateEmphasis(): void {
  if (!map?.getLayer('pins')) return
  const rest = props.selected || props.target ? DIMMED : 1
  // Other places share one opacity; the selected name is handled by the separate filter.
  map.setPaintProperty('pins', 'icon-opacity', rest)
  map.setPaintProperty('names', 'text-opacity', rest)
  // The chosen place carries its name on its own marker, so the map's copy of that name steps aside.
  const named = props.selected?.placeId ?? ''
  if (named === hiddenName) return
  hiddenName = named
  map.setFilter('names', ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'id'], named]])
}
function updateSelected(): void {
  selected?.remove(); selected = null
  updateEmphasis()
  if (!map || !libre) return
  const coordinate = props.selected ? localToLngLat(props.districtId, props.selected.pos) : props.target
  if (!coordinate) return
  const el = document.createElement('div'); el.className = 'street-selected'; el.setAttribute('aria-hidden', 'true')
  if (props.selected) {
    const style = categoryStyle(props.selected.category); el.textContent = style.icon; el.style.background = style.color
    const name = document.createElement('span'); name.className = 'street-selected-name'; name.textContent = props.selected.name; el.append(name)
    el.style.pointerEvents = 'auto'
    el.addEventListener('click', event => {
      event.stopPropagation()
      if (props.selected) emit('place', props.selected)
    })
  } else { el.textContent = '+'; el.style.background = '#fffdf9' }
  selected = new libre.Marker({ element: el }).setLngLat(coordinate).addTo(map)
}
function centre(): void { map?.easeTo({ center: localToLngLat(props.districtId, props.position), zoom: 16.4, bearing: bearing(), duration: motion() }) }
function focus(poi: Poi): void { map?.easeTo({ center: localToLngLat(props.districtId, poi.pos), zoom: Math.max(17, map.getZoom()), duration: motion() }) }
function city(): void { if (!props.rangeCenter) return; map?.easeTo({ center: props.rangeCenter, zoom: 9, bearing: 0, duration: motion() }) }
function clear(): void {
  clearTimeout(deadline); resize?.disconnect(); resize = null
  for (const marker of people.values()) render(null, marker.getElement())
  fittedRoute = ''; hiddenName = ''; me = null; arrival = null; selected = null; people.clear(); map?.remove(); map = null
}
async function initialise(): Promise<void> {
  const mine = ++attempt; clear(); loading.value = true; problem.value = ''
  try {
    const [module, worker] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'), import('maplibre-gl/dist/maplibre-gl.css')])
    if (disposed || mine !== attempt || !container.value) return
    libre = module; module.setWorkerUrl(worker.default)
    const instance = new module.Map({ container: container.value, style: 'https://tiles.openfreemap.org/styles/positron', center: localToLngLat(props.districtId, props.position), zoom: 16.4, bearing: bearing(), maxZoom: 19, minZoom: 3, maxPitch: 0, dragRotate: false, touchPitch: false, renderWorldCopies: false, pixelRatio: Math.min(devicePixelRatio, 1.5), attributionControl: false })
    map = instance; instance.touchZoomRotate.disableRotation(); instance.keyboard.disableRotation()

    instance.addControl(new module.ScaleControl({ maxWidth: 90 }), 'bottom-left')
    instance.addControl(new module.AttributionControl({ compact: false, customAttribution: '<a href="https://github.com/openmaptiles/positron-gl-style/blob/master/LICENSE.md" target="_blank" rel="noopener">Positron</a>' }), 'bottom-right')
    deadline = setTimeout(() => { loading.value = false; problem.value = 'The street map is taking too long. Places are still available in the list.' }, 20000)
    instance.on('error', () => { loading.value = false; problem.value = 'Some map tiles could not load. You can still use the places list.' })
    instance.once('load', () => {
      if (disposed || mine !== attempt) return
      clearTimeout(deadline); loading.value = false; addLayers(); updateMe(); updatePeople(); updateSelected(); updateRoute()
      if (props.arrival) {
        const el = document.createElement('button'); el.type = 'button'; el.className = 'street-arrival'; el.textContent = 'A'; el.title = `Arrival · ${props.arrival.label}`; el.setAttribute('aria-label', el.title)
        el.addEventListener('click', e => { e.stopPropagation(); if (props.arrival) { const p = localToLngLat(props.districtId, props.arrival.pos); emit('point', p[0], p[1]) } })
        arrival = new module.Marker({ element: el, offset: [0, 28] }).setLngLat(localToLngLat(props.districtId, props.arrival.pos)).addTo(instance)
      }
    })
    instance.on('click', event => {
      if (!instance.getLayer('pins')) return
      const hit = instance.queryRenderedFeatures(event.point, { layers: ['pins', 'clusters', 'names'] })[0]
      if (hit?.properties.cluster_id !== undefined && hit.geometry.type === 'Point') {
        const source = instance.getSource('places'); const coords = hit.geometry.coordinates
        if (source instanceof module.GeoJSONSource && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
          const center: [number, number] = [coords[0], coords[1]]
          void source.getClusterExpansionZoom(Number(hit.properties.cluster_id)).then(zoom => { if (map === instance) instance.easeTo({ center, zoom: zoom + 0.2, duration: motion() }) })
        }
      } else {
        const poi = props.places.find(p => p.placeId === hit?.properties.id)
        if (poi) emit('place', poi); else emit('point', event.lngLat.lng, event.lngLat.lat)
      }
    })
    instance.on('movestart', event => { if (event.originalEvent) emit('pan') })
    instance.on('zoomend', () => emit('zoom', instance.getZoom()))
    instance.on('moveend', updatePeople)
    resize = new ResizeObserver(() => { instance.resize(); updateRoute() }); resize.observe(container.value)
  } catch { if (!disposed && mine === attempt) { loading.value = false; problem.value = 'The map could not start. Use the places list or retry.' } }
}
watch([() => props.position, () => props.heading], followPosition)
watch(() => props.follow, following => { if (following) followPosition() })
watch(() => props.headingUp, () => { map?.easeTo({ bearing: bearing(), duration: motion() }) })
watch(() => props.route, updateRoute)
watch(() => props.rangeCenter, updateRange)
watch(() => props.members, updatePeople, { deep: true })
watch(() => props.places, setPlaces)
watch([() => props.selected?.placeId, () => props.target?.[0], () => props.target?.[1]], updateSelected)
watch(() => props.districtId, () => void initialise())
onMounted(() => void initialise())
onBeforeUnmount(() => { disposed = true; attempt++; clear() })
function zoomIn(): void { map?.zoomIn({ duration: motion() }) }
function zoomOut(): void { map?.zoomOut({ duration: motion() }) }
defineExpose({ centre, focus, city, zoomIn, zoomOut })
</script>

<template>
  <div class="street-map" aria-label="Interactive street map. Use the places list for keyboard navigation.">
    <div ref="container" class="street-canvas"></div>
    <div v-if="loading || problem" class="street-notice" role="status">
      <span>{{ problem || 'Opening the street map…' }}</span>
      <button v-if="problem" class="btn sm" @click="initialise">Retry map</button>
    </div>
  </div>
</template>

<style>
.street-map,.street-map .street-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.street-map { z-index: 0; background: #e8e9e1; }
.street-notice { position: absolute; top: 70px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 100px); width: 360px; padding: 12px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); display: grid; gap: 8px; font-size: 13px; z-index: 2; }
.street-me { z-index: 3; width: 36px; height: 36px; border: 3px solid white; border-radius: 50%; background: #263a60; box-shadow: 0 3px 9px #151c3650; pointer-events: none; }
.street-me span { display: block; width: 20px; height: 24px; margin: 2px auto; background: white; clip-path: polygon(50% 0, 100% 100%, 50% 75%, 0 100%); }
.street-person { z-index: 4; width: 44px; height: 44px; padding: 0; border: 3px solid #fffdf9; border-radius: 50%; background: #433a50; box-shadow: 0 3px 8px #24203250; }
.street-person.friend { border-color: #ffb020; }
.street-person img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.street-arrival { border: 3px solid white; border-radius: 10px; width: 32px; height: 32px; font-weight: 800; color: white; background: #287451; box-shadow: 0 2px 5px #0003; }
.street-selected { display: grid; place-items: center; font-size: 23px; z-index: 2; width: 49px; height: 49px; border: 3px solid #1c1a24; border-radius: 50%; pointer-events: none; box-shadow: 0 0 0 3px #fffdf9, 0 3px 9px #1c1a2450; }
.street-selected-name { position: absolute; top: calc(100% + 7px); left: 50%; transform: translateX(-50%); max-width: 168px; padding: 2px 9px; border-radius: 10px; background: #1c1a24; color: #fffdf9; font-size: 12px; font-weight: 650; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.street-map .maplibregl-ctrl-attrib { font-size: 10px; line-height: 16px; background: #fffdf9ed; }
.street-map .maplibregl-ctrl-bottom-left { bottom: 4px; }
@media (max-width: 600px) { .street-map .maplibregl-ctrl-bottom-left { bottom: 31px; } }
</style>
