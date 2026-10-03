// Travel, documents and the play-money wallet.
//
// The avatar is somewhere in the world. Moving it to another city costs a fare; crossing a
// border needs a passport and, outside visa-free blocs, a visa. Fares and fees are paid in
// coins earned by playing (work shifts, games). Coins are play money: not Goalmatic credits,
// not real money, not transferable. The rules are a simplified game inspired by real travel —
// they are not visa or immigration advice.
import type { Iso } from './ids.ts'
import type { LatLon } from './geo.ts'
import type { CoarseArea } from './model.ts'

export type TravelMode = 'local' | 'bus' | 'rail' | 'flight'

export type LedgerKind = 'starting' | 'work' | 'game' | 'fare' | 'passport' | 'visa' | 'refund' | 'food' | 'gift' | 'home'
export interface LedgerEntry { id: string; at: Iso; amount: number; kind: LedgerKind; text: string; balanceAfter: number }

export type DocumentStatus = 'none' | 'processing' | 'valid' | 'expired' | 'refused'

export interface Passport {
  status: DocumentStatus
  /** Country that issued it: the member's home country at the time of applying. */
  countryCode: string | null
  appliedAt: Iso | null
  readyAt: Iso | null
  expiresAt: Iso | null
}

export interface Visa {
  countryCode: string
  status: DocumentStatus
  appliedAt: Iso
  readyAt: Iso | null
  validUntil: Iso | null
  /** Plain reason when refused, for example "Funds were below the required 400 coins". */
  note: string
}

export interface TravelRequirement { kind: 'passport' | 'visa' | 'funds'; met: boolean; text: string }

export interface TravelQuote {
  to: CoarseArea
  distanceKm: number
  mode: TravelMode
  fare: number
  /** How long the trip takes in real seconds. */
  seconds: number
  international: boolean
  requirements: TravelRequirement[]
  allowed: boolean
  /** Why not, when `allowed` is false. Empty otherwise. */
  reason: string
}

export type TripStatus = 'in-transit' | 'arrived'
export interface Trip { id: string; from: CoarseArea; to: CoarseArea; mode: TravelMode; fare: number; distanceKm: number; departedAt: Iso; arrivesAt: Iso; status: TripStatus }

export interface TravelState {
  /** Where the avatar is now. Null until the member first arrives somewhere. */
  location: CoarseArea | null
  /** The centre local walking range is measured from (a coarse area anchor, never a device reading). */
  walkingOrigin: LatLon | null
  /** Home country for documents: the country of the member's first arrival. */
  homeCountry: string | null
  balance: number
  passport: Passport
  visas: Visa[]
  /** The trip in progress, if any. The avatar is in no room while travelling. */
  trip: Trip | null
  recentTrips: Trip[]
}

// ── Rules shared by the service (which enforces them) and the App (which explains them) ──

export const TRAVEL = {
  startingCoins: 150,
  /** Districts within this distance of the avatar's location can be walked into without a trip. */
  localRangeKm: 45,
  passport: { fee: 400, seconds: 90, validDays: 60 },
  visa: { seconds: 75, validDays: 30, minShifts: 2 },
} as const

/** Groups of countries whose members travel between each other without a visa in this game. */
export const VISA_FREE_BLOCS: { id: string; name: string; countries: string[] }[] = [
  { id: 'ecowas', name: 'ECOWAS', countries: ['NG', 'GH', 'SN', 'CI', 'TG', 'BJ', 'GM', 'LR', 'SL', 'GN', 'GW', 'CV'] },
  { id: 'eac', name: 'East African Community', countries: ['KE', 'UG', 'TZ', 'RW', 'BI', 'SS'] },
  { id: 'sadc', name: 'Southern Africa', countries: ['ZA', 'BW', 'NA', 'LS', 'SZ', 'ZM', 'ZW', 'MZ', 'MW'] },
  { id: 'schengen', name: 'Schengen area', countries: ['FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'SE', 'DK', 'FI', 'NO', 'PL', 'CZ', 'GR', 'CH', 'HU', 'IS', 'LU', 'SK', 'SI', 'EE', 'LV', 'LT', 'MT', 'HR'] },
  { id: 'cta', name: 'UK and Ireland', countries: ['GB', 'IE'] },
  { id: 'gcc', name: 'Gulf states', countries: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'] },
  { id: 'mercosur', name: 'Mercosur', countries: ['BR', 'AR', 'UY', 'PY', 'CL', 'CO', 'PE', 'BO', 'EC'] },
  { id: 'asean', name: 'ASEAN', countries: ['ID', 'PH', 'TH', 'VN', 'MY', 'SG', 'KH', 'LA', 'BN', 'MM'] },
  { id: 'northamerica', name: 'USA and Canada', countries: ['US', 'CA'] },
  { id: 'anz', name: 'Australia and New Zealand', countries: ['AU', 'NZ'] },
]

export function visaFreeBetween(from: string, to: string): { free: boolean; bloc: string | null } {
  if (from === to) return { free: true, bloc: null }
  const bloc = VISA_FREE_BLOCS.find(entry => entry.countries.includes(from) && entry.countries.includes(to))
  return { free: Boolean(bloc), bloc: bloc?.name ?? null }
}

export function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** How a trip of this length is made, what it costs and how long it takes. */
export function tripTerms(km: number): { mode: TravelMode; fare: number; seconds: number } {
  if (km <= TRAVEL.localRangeKm) return { mode: 'local', fare: 0, seconds: 0 }
  if (km <= 180) return { mode: 'bus', fare: Math.round(25 + km * 0.5), seconds: 15 }
  if (km <= 900) return { mode: 'rail', fare: Math.round(70 + km * 0.28), seconds: 25 }
  return { mode: 'flight', fare: Math.round(260 + km * 0.11), seconds: Math.min(75, Math.round(35 + km / 400)) }
}

/** Visa fee for a destination, and the funds an applicant must hold. */
export function visaTerms(km: number): { fee: number; funds: number } {
  const fee = km > 6000 ? 650 : km > 2500 ? 450 : 300
  return { fee, funds: fee + tripTerms(km).fare }
}
