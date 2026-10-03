import { providers } from '../../config/providers.ts'
import { searchPlaces } from '../../geo/geocode.ts'
import type { PlaceResult } from '../../geo/geocode.ts'
import type { LatLon } from '../../shared/geo.ts'
import type { CoarseArea } from '../../shared/model.ts'
import { distanceKm } from '../../shared/travel.ts'
import type { TravelMode } from '../../shared/travel.ts'

export type HubResult =
  | { kind: 'found'; name: string; anchor: LatLon; distance: number; source: string; category: string }
  | { kind: 'missing'; reason: string }

let queue: Promise<void> = Promise.resolve()
let lastFinished = 0
const cache = new Map<string, { value: HubResult; until: number }>()

// Place search and hub lookup share one queue within the Travel window.
function politely<T>(run: () => Promise<T>): Promise<T> {
  const work = queue.then(async () => {
    const wait = lastFinished + providers.geocoder.minIntervalMs - Date.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    try { return await run() } finally { lastFinished = Date.now() }
  })
  queue = work.then(() => undefined, () => undefined)
  return work
}

export function searchDestinations(query: string, language: string): Promise<PlaceResult[]> {
  return politely(() => searchPlaces(query, language))
}

function hubFrom(value: unknown, origin: LatLon, mode: TravelMode): Extract<HubResult, { kind: 'found' }> | null {
  if (!value || typeof value !== 'object' || !('lat' in value) || !('lon' in value) || !('name' in value) || !('type' in value)) return null
  if (typeof value.name !== 'string' || !value.name.trim()) return null
  if (typeof value.lat !== 'string' || typeof value.lon !== 'string') return null
  const lat = Number(value.lat), lon = Number(value.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const category = 'category' in value ? value.category : 'class' in value ? value.class : null
  const matches = mode === 'flight' ? category === 'aeroway' && value.type === 'aerodrome'
    : mode === 'rail' ? category === 'railway' && value.type === 'station'
    : category === 'amenity' && value.type === 'bus_station'
  if (!matches) return null
  const extra = 'extratags' in value ? value.extratags : null
  if (extra && typeof extra === 'object') {
    if ('access' in extra && (extra.access === 'private' || extra.access === 'no')) return null
    if ('military' in extra || ('aerodrome:type' in extra && extra['aerodrome:type'] === 'military')) return null
  }
  const anchor = { lat, lon }
  const distance = distanceKm(origin, anchor)
  if (distance > 75) return null
  const type = 'osm_type' in value ? value.osm_type : null
  const id = 'osm_id' in value ? value.osm_id : null
  const source = (type === 'node' || type === 'way' || type === 'relation') && (typeof id === 'number' || typeof id === 'string') && /^\d+$/.test(String(id))
    ? `https://www.openstreetmap.org/${type}/${id}` : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`
  return { kind: 'found', name: value.name.trim(), anchor, distance, source, category: mode === 'flight' ? 'airport' : mode === 'rail' ? 'railway station' : 'bus station' }
}

/** One query, nearest suitable returned result; not an exhaustive transport search. */
export async function findDepartureHub(area: CoarseArea, mode: TravelMode): Promise<HubResult> {
  if (mode === 'local') return { kind: 'missing', reason: 'This is a walk, so no transport hub is needed.' }
  const key = `${area.anchor.lat},${area.anchor.lon}:${mode}`
  const saved = cache.get(key)
  if (saved && saved.until > Date.now()) return saved.value
  const category = mode === 'flight' ? 'airport' : mode === 'rail' ? 'railway station' : 'bus station'
  const { lat, lon } = area.anchor
  const latSpan = 75 / 111.32, lonSpan = latSpan / Math.max(0.1, Math.cos(lat * Math.PI / 180))
  const url = new URL(providers.geocoder.search)
  url.search = new URLSearchParams({
    q: category, extratags: '1', format: 'jsonv2', limit: '20', bounded: '1',
    viewbox: [Math.max(-180, lon - lonSpan), Math.min(85, lat + latSpan), Math.min(180, lon + lonSpan), Math.max(-85, lat - latSpan)].join(','),
    countrycodes: area.countryCode.toLowerCase(), 'accept-language': 'en',
  }).toString()
  const result = await politely(async (): Promise<HubResult> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(7000) })
      if (!response.ok) return { kind: 'missing', reason: 'The map provider could not confirm a departure hub. This game journey can still depart from your city.' }
      const raw: unknown = await response.json()
      const matches = Array.isArray(raw) ? raw.map(item => hubFrom(item, area.anchor, mode)).filter(item => item !== null).sort((a, b) => a.distance - b.distance) : []
      return matches[0] ?? { kind: 'missing', reason: `No named ${category} was returned within 75 km. Departure is shown from the city.` }
    } catch {
      return { kind: 'missing', reason: 'Departure-hub lookup did not answer. This game journey can still depart from your city.' }
    }
  })
  if (cache.size >= 16) cache.delete(cache.keys().next().value ?? '')
  cache.set(key, { value: result, until: Date.now() + (result.kind === 'found' ? 3_600_000 : 30_000) })
  return result
}
