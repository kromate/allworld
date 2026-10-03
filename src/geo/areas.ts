// Build the coarse area record for a named public place.
import tzlookup from 'tz-lookup'
import { areaIdOf, districtIdOf } from '../shared/geo.ts'
import type { LatLon } from '../shared/geo.ts'
import type { CoarseArea } from '../shared/model.ts'

export function timezoneAt(point: LatLon): string {
  try { return tzlookup(point.lat, point.lon) } catch { return 'UTC' }
}

/** `anchor` must be a gazetteer point for the named place — never a device reading. */
export function areaFromPlace(place: { label: string; countryCode: string; anchor: LatLon; region?: string | null }): CoarseArea {
  return {
    areaId: areaIdOf(place.anchor), label: place.label, countryCode: place.countryCode.toUpperCase(), timezone: timezoneAt(place.anchor),
    anchor: place.anchor, arrivalDistrict: districtIdOf(place.anchor),
    // The first-level administrative area ("Lagos", "Texas"), carried only when the gazetteer named one.
    ...(place.region ? { region: place.region } : {}),
  }
}
