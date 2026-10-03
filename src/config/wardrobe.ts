import { AVATAR_BODIES } from '../shared/model.ts'
import type { AvatarBody, AvatarLook } from '../shared/model.ts'
import castIndex from '../assets/cast.index.json'
import { OUTFITS } from '../world/wardrobe.ts'
import type { Outfit } from '../world/wardrobe.ts'

type Sex = 'f' | 'm'

const FEATURED_BY_REGION: Record<string, readonly string[]> = {
  NG: ['kaftan-sand', 'wax-ochre', 'wax-indigo'],
  TG: ['wax-coral', 'wax-ochre'],
  GH: ['wax-river', 'wax-coral'],
  KE: ['kitenge-sunrise', 'wax-sunrise', 'olive-casual'],
  ZA: ['olive-casual', 'denim-weekend'],
  GB: ['city-navy', 'denim-weekend'],
  ES: ['coastal-linen', 'everyday-cream'],
  FR: ['city-navy', 'coastal-linen'],
  US: ['denim-weekend', 'olive-casual'],
  BR: ['wax-coral', 'coastal-linen'],
  IN: ['marigold-cotton', 'everyday-cream'],
  JP: ['indigo-dash', 'city-navy'],
  'west-africa': ['kaftan-sand', 'wax-river', 'wax-ochre'],
  'east-africa': ['kitenge-sunrise', 'wax-sunrise', 'olive-casual'],
  europe: ['city-navy', 'coastal-linen'],
  'north-america': ['denim-weekend', 'olive-casual'],
  'south-america': ['wax-coral', 'coastal-linen'],
  'south-asia': ['marigold-cotton', 'everyday-cream'],
  'east-asia': ['indigo-dash', 'city-navy'],
  global: ['everyday-cream', 'denim-weekend'],
}

const CAST_PRIORITY_BY_REGION: Record<string, readonly AvatarBody[]> = {
  NG: ['m12', 'f03', 'm08', 'f17'],
  TG: ['f11', 'm08'],
  GH: ['f11', 'm08'],
  KE: ['f17', 'm01', 'm08', 'f03'],
  ZA: ['f17', 'm12'],
  GB: ['f06', 'm04'],
  ES: ['f01', 'm08'],
  FR: ['f06', 'm04'],
  US: ['f17', 'm12'],
  BR: ['f11', 'm08'],
  IN: ['f17', 'm12'],
  JP: ['f06', 'm04'],
  'west-africa': ['m12', 'f03', 'm08', 'f17'],
  'east-africa': ['f17', 'm01', 'm08', 'f03'],
  europe: ['f06', 'm04'],
  'north-america': ['f17', 'm12'],
  'south-america': ['f11', 'm08'],
  'south-asia': ['f17', 'm12'],
  'east-asia': ['f06', 'm04'],
  global: ['f17', 'm12'],
}

const FALLBACK_FEATURED = ['everyday-cream', 'denim-weekend'] as const
const FALLBACK_CAST_PRIORITY = ['f17', 'm12'] as const satisfies readonly AvatarBody[]

function regionKey(countryCode: string): string {
  const key = countryCode.trim()
  const countryKey = key.toUpperCase()
  return Object.hasOwn(FEATURED_BY_REGION, countryKey) ? countryKey : key.toLowerCase()
}

function featuredIds(countryCode: string): readonly string[] {
  const key = regionKey(countryCode)
  return Object.hasOwn(FEATURED_BY_REGION, key) ? FEATURED_BY_REGION[key] ?? FALLBACK_FEATURED : FALLBACK_FEATURED
}

/** Merchandising order only; geography never selects a member's appearance. */
export function featuredOutfits(countryCode: string, sex?: Sex): Outfit[] {
  const promotedIds = featuredIds(countryCode)
  const ordered = [
    ...promotedIds.map((id) => OUTFITS.find((outfit) => outfit.id === id)).filter((outfit) => outfit !== undefined),
    ...OUTFITS.filter((outfit) => !promotedIds.includes(outfit.id)),
  ]

  if (!sex) return ordered
  const compatibleBodies = new Set(castIndex.filter((member) => member.sex === sex).map((member) => member.id))
  return ordered.filter((outfit) => outfit.fits.some((body) => compatibleBodies.has(body)))
}

function sexFor(body: AvatarBody): Sex | undefined {
  const entry = castIndex.find((candidate) => candidate.id === body)
  return entry?.sex === 'f' || entry?.sex === 'm' ? entry.sex : undefined
}

/** Keeps the full cast available while ranking silhouettes for the promoted clothing cuts. */
export function suggestedCast(countryCode: string): AvatarBody[] {
  const key = regionKey(countryCode)
  const priority = Object.hasOwn(CAST_PRIORITY_BY_REGION, key) ? CAST_PRIORITY_BY_REGION[key] ?? FALLBACK_CAST_PRIORITY : FALLBACK_CAST_PRIORITY
  const preferred: AvatarBody[] = []
  for (const body of priority) {
    if (sexFor(body) !== undefined) preferred.push(body)
  }
  return [...preferred, ...AVATAR_BODIES.filter((body) => !preferred.includes(body))]
}

/** Supplies a neutral starting look; country controls clothing merchandising only. */
export function defaultLookFor(countryCode: string): AvatarLook {
  const cast = suggestedCast(countryCode)
  const featured = featuredOutfits(countryCode)
  const outfit = featured.find((candidate) => cast.some((body) => candidate.fits.includes(body)))
    ?? OUTFITS.find((candidate) => cast.some((body) => candidate.fits.includes(body)))
  const body = cast.find((candidate) => outfit?.fits.includes(candidate)) ?? cast[0] ?? 'f03'
  return {
    body,
    skin: null,
    outfitHue: 0,
    height: 1,
    outfit: outfit?.id ?? null,
    face: null,
  }
}
