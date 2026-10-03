// Region configuration. Countries, units, currencies and starter places are data, so supporting
// another country never needs a code change. Nothing here assigns a member's language, look or
// identity: these are only defaults a member can override in Settings.
import type { LatLon } from './geo.ts'

export interface CountryDefaults { units: 'metric' | 'imperial'; currency: string }

const IMPERIAL = new Set(['US', 'LR', 'MM'])
const CURRENCY: Record<string, string> = {
  NG: 'NGN', KE: 'KES', GH: 'GHS', ZA: 'ZAR', UG: 'UGX', TZ: 'TZS', RW: 'RWF', ET: 'ETB', EG: 'EGP', MA: 'MAD', SN: 'XOF', CI: 'XOF',
  GB: 'GBP', IE: 'EUR', FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR', SE: 'SEK', PL: 'PLN',
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CO: 'COP', IN: 'INR', PK: 'PKR', BD: 'BDT', ID: 'IDR', PH: 'PHP',
  JP: 'JPY', KR: 'KRW', CN: 'CNY', AU: 'AUD', NZ: 'NZD', AE: 'AED', SA: 'SAR', TR: 'TRY',
}

export function countryDefaults(countryCode: string): CountryDefaults {
  const code = countryCode.toUpperCase()
  return { units: IMPERIAL.has(code) ? 'imperial' : 'metric', currency: CURRENCY[code] ?? 'USD' }
}

export interface StarterPlace { label: string; countryCode: string; anchor: LatLon; /** First-level administrative area: the state, county, nation or prefecture. */ region: string }

/**
 * Well-known public places offered as quick starts. They are gazetteer points, not anyone's
 * location, and the list is only a convenience: any place the geocoder knows can be chosen.
 */
export const STARTER_PLACES: StarterPlace[] = [
  { label: 'Bodija, Ibadan', countryCode: 'NG', anchor: { lat: 7.4352, lon: 3.914 }, region: 'Oyo' },
  { label: 'Wuse, Abuja', countryCode: 'NG', anchor: { lat: 9.0765, lon: 7.476 }, region: 'Federal Capital Territory' },
  { label: 'Yaba, Lagos', countryCode: 'NG', anchor: { lat: 6.5095, lon: 3.3711 }, region: 'Lagos' },
  { label: 'Kilimani, Nairobi', countryCode: 'KE', anchor: { lat: -1.2921, lon: 36.7856 }, region: 'Nairobi' },
  { label: 'Osu, Accra', countryCode: 'GH', anchor: { lat: 5.556, lon: -0.182 }, region: 'Greater Accra' },
  { label: 'Northern Quarter, Manchester', countryCode: 'GB', anchor: { lat: 53.4839, lon: -2.2364 }, region: 'England' },
  { label: 'Camden Town, London', countryCode: 'GB', anchor: { lat: 51.539, lon: -0.1426 }, region: 'England' },
  { label: 'Downtown Austin, Texas', countryCode: 'US', anchor: { lat: 30.2672, lon: -97.7431 }, region: 'Texas' },
  { label: 'Williamsburg, Brooklyn', countryCode: 'US', anchor: { lat: 40.7081, lon: -73.9571 }, region: 'New York' },
  { label: 'Bandra West, Mumbai', countryCode: 'IN', anchor: { lat: 19.0596, lon: 72.8295 }, region: 'Maharashtra' },
  { label: 'Vila Madalena, São Paulo', countryCode: 'BR', anchor: { lat: -23.5505, lon: -46.6903 }, region: 'São Paulo' },
  { label: 'Shimokitazawa, Tokyo', countryCode: 'JP', anchor: { lat: 35.6614, lon: 139.668 }, region: 'Tokyo' },
]
