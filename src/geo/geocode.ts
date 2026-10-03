// Place search and the optional one-time device suggestion.
//
// Privacy rule: a device reading is reduced to the centre of its coarse cell (about 6–10 km)
// before it is used for anything. That coarse point is the only thing sent to the geocoder, and
// the result offered to the member is the geocoder's public point for a named place.
import { coarsen } from '../shared/geo.ts'
import type { LatLon } from '../shared/geo.ts'
import { providers } from '../config/providers.ts'

export interface PlaceResult { label: string; detail: string; countryCode: string; anchor: LatLon; /** First-level administrative area ("Lagos", "Texas"), when the gazetteer names one. */ region?: string | null }

let lastRequest = 0
/** Nominatim's usage policy allows one request per second. */
async function politely<T>(run: () => Promise<T>): Promise<T> {
  const wait = lastRequest + providers.geocoder.minIntervalMs - Date.now()
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastRequest = Date.now()
  return run()
}

interface NominatimPlace {
  lat: string; lon: string; display_name?: string; name?: string; addresstype?: string
  address?: Record<string, string>
}

const LOCAL_KEYS = ['neighbourhood', 'quarter', 'suburb', 'city_district', 'borough', 'village', 'town', 'hamlet']
const CITY_KEYS = ['city', 'town', 'municipality', 'county', 'state_district', 'state']

function toResult(place: NominatimPlace): PlaceResult | null {
  const lat = Number(place.lat), lon = Number(place.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const address = place.address ?? {}
  const pick = (keys: string[]): string | undefined => keys.map(key => address[key]).find(Boolean)
  const local = pick(LOCAL_KEYS) ?? place.name
  const city = pick(CITY_KEYS)
  const label = [local, city && city !== local ? city : null].filter(Boolean).join(', ') || place.display_name?.split(',').slice(0, 2).join(',') || 'Unnamed place'
  return {
    label, detail: [address.state && address.state !== city ? address.state : null, address.country].filter(Boolean).join(', '),
    countryCode: (address.country_code ?? '').toUpperCase() || 'ZZ', anchor: { lat, lon },
    region: (address.state ?? address.province ?? address.region ?? '').trim().slice(0, 60) || null,
  }
}

export class GeocodeError extends Error {}

/** Search named places. Runs on submit, never per keystroke. */
export async function searchPlaces(query: string, language: string): Promise<PlaceResult[]> {
  const url = new URL(providers.geocoder.search)
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: '6', 'accept-language': language }).toString()
  return politely(async () => {
    let response: Response
    try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }) } catch { throw new GeocodeError('The place search did not answer. Check your connection and try again.') }
    if (response.status === 429) throw new GeocodeError('The place search is busy. Wait a few seconds and search again.')
    if (!response.ok) throw new GeocodeError(`The place search returned an error (${response.status}).`)
    const seen = new Set<string>()
    return ((await response.json()) as NominatimPlace[]).map(toResult).filter((result): result is PlaceResult => {
      if (!result || seen.has(`${result.label}|${result.detail}`)) return false
      seen.add(`${result.label}|${result.detail}`)
      return true
    })
  })
}

export type DeviceFailure = 'denied' | 'unavailable' | 'blocked-by-host' | 'timeout'
export class DeviceSuggestionError extends Error {
  readonly reason: DeviceFailure
  constructor(reason: DeviceFailure, message: string) { super(message); this.reason = reason }
}

/**
 * Ask the device once, coarsen the reading immediately, and name the area around it.
 * The exact coordinates never leave this function.
 */
export async function suggestFromDevice(language: string): Promise<PlaceResult & { coarseWidthKm: number }> {
  if (!('geolocation' in navigator)) throw new DeviceSuggestionError('unavailable', 'This device does not offer a location.')
  const policy = (document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } })
  const allows = policy.permissionsPolicy ?? policy.featurePolicy
  if (allows && !allows.allowsFeature('geolocation')) throw new DeviceSuggestionError('blocked-by-host', 'Device location is switched off for this page by the host. Choose your area by name instead.')
  const coarse = await new Promise<LatLon>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve(coarsen({ lat: position.coords.latitude, lon: position.coords.longitude })),
      error => reject(error.code === error.PERMISSION_DENIED
        ? new DeviceSuggestionError('denied', 'Location permission was not given. You can choose your area by name.')
        : error.code === error.TIMEOUT
          ? new DeviceSuggestionError('timeout', 'The device took too long to find a location. Choose your area by name.')
          : new DeviceSuggestionError('unavailable', 'The device could not find a location. Choose your area by name.')),
      { enableHighAccuracy: false, maximumAge: 600_000, timeout: 12_000 },
    )
  })
  const url = new URL(providers.geocoder.reverse)
  url.search = new URLSearchParams({ lat: coarse.lat.toFixed(3), lon: coarse.lon.toFixed(3), format: 'jsonv2', addressdetails: '1', zoom: '13', 'accept-language': language }).toString()
  return politely(async () => {
    let response: Response
    try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }) } catch { throw new GeocodeError('The place lookup did not answer. Choose your area by name.') }
    if (!response.ok) throw new GeocodeError(`The place lookup returned an error (${response.status}).`)
    const result = toResult((await response.json()) as NominatimPlace)
    if (!result) throw new GeocodeError('No named place was found around that spot. Choose your area by name.')
    const widthKm = (40_075 * Math.cos((coarse.lat * Math.PI) / 180)) / 4096
    return { ...result, coarseWidthKm: Math.round(widthKm) }
  })
}
