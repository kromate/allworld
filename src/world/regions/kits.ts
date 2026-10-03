export type RegionQuality = 'low' | 'medium' | 'high'
export type ModelName = 'danfo' | 'keke' | 'okada' | 'bus' | 'car' | 'stall' | 'kiosk' | 'food' | 'generator' | 'cart' | 'pole' | 'drain' | 'gate' | 'palm' | 'shelter' | 'bump' | 'billboard' | 'postbox' | 'bollards' | 'pubsign' | 'beacon' | 'stall-red' | 'stall-green' | 'produce-goods' | 'shop-goods' | 'tyres' | 'container-shop' | 'pos-kiosk' | 'vulcanizer' | 'water-tank' | 'rubbish-bin' | 'lamp' | 'canoe' | 'mooring-posts' | 'net-crates'
export interface RegionKit {
  id: string; countryCode: string; cities: readonly string[]; description: string; pack: string
  models: readonly ModelName[]; residential: readonly ModelName[]; commercial: readonly ModelName[]; arterial: readonly ModelName[]
  ground: string; density: number; profile: 'market' | 'urban' | 'estate' | 'planned' | 'temperate'
}
const nigerian = {
  countryCode: 'NG', pack: '/regions/nigeria.pack.gz',
  models: ['danfo', 'keke', 'okada', 'bus', 'car', 'stall', 'kiosk', 'food', 'generator', 'cart', 'pole', 'drain', 'gate', 'palm', 'shelter', 'bump', 'billboard', 'stall-red', 'stall-green', 'produce-goods', 'shop-goods', 'tyres', 'container-shop', 'pos-kiosk', 'vulcanizer', 'water-tank', 'rubbish-bin', 'lamp', 'canoe', 'mooring-posts', 'net-crates'],
  residential: ['water-tank', 'palm', 'gate', 'rubbish-bin', 'lamp', 'drain', 'car', 'pole'],
  commercial: ['stall-red', 'stall-green', 'container-shop', 'pos-kiosk', 'food', 'vulcanizer', 'shop-goods', 'kiosk'],
  arterial: ['danfo', 'car', 'pole', 'drain', 'lamp', 'billboard'], ground: '#b29d7f', density: 0.65, profile: 'urban',
} satisfies Omit<RegionKit, 'id' | 'cities' | 'description'>
const nigeriaKit = (id: string, cities: string[], label: string, profile: RegionKit['profile'], density: number): RegionKit => ({ ...nigerian, id, cities, profile, density, description: `Street details are illustrative of ${label}; streets and places are from the map.` })
export const REGION_KITS: readonly RegionKit[] = [
  nigeriaKit('lagos-island', ['balogun', 'idumota', 'island'], 'Lagos Island', 'market', 1),
  nigeriaKit('lekki', ['lekki'], 'Lekki', 'estate', 0.45),
  nigeriaKit('ajah', ['ajah'], 'Ajah', 'urban', 0.72),
  nigeriaKit('ikeja', ['ikeja'], 'Ikeja', 'urban', 0.8),
  nigeriaKit('surulere', ['surulere'], 'Surulere', 'urban', 0.8),
  nigeriaKit('abuja', ['abuja', 'wuse', 'garki', 'maitama'], 'Abuja', 'planned', 0.42),
  nigeriaKit('ibadan', ['ibadan', 'bodija'], 'Ibadan', 'market', 0.88),
  nigeriaKit('lagos', ['lagos', 'yaba', 'ikorodu', 'obalende'], 'Lagos', 'urban', 0.88),
  nigeriaKit('nigeria', [], 'Nigeria', 'urban', 0.65),
  { id: 'manchester', countryCode: 'GB', cities: ['manchester'], description: 'Street details are illustrative of Manchester; streets and places are from the map.', pack: '/regions/manchester.pack.gz', models: ['postbox', 'bollards', 'pubsign', 'beacon'], residential: ['bollards'], commercial: ['bollards'], arterial: ['bollards'], ground: '#7e7c78', density: 0.45, profile: 'temperate' },
]
export const REGION_BUDGETS = {
  low: { radius: 100, instances: 48, triangles: 75_000, wires: 5 },
  medium: { radius: 150, instances: 105, triangles: 140_000, wires: 14 },
  high: { radius: 210, instances: 175, triangles: 230_000, wires: 26 },
} satisfies Record<RegionQuality, { radius: number; instances: number; triangles: number; wires: number }>
export function regionKitFor(countryCode: string, areaLabel: string): RegionKit | null {
  const country = countryCode.trim().toUpperCase() === 'UK' ? 'GB' : countryCode.trim().toUpperCase()
  const words = areaLabel.toLowerCase().split(/[^a-z]+/)
  return REGION_KITS.find(kit => kit.countryCode === country && kit.cities.some(city => words.includes(city)))
    ?? REGION_KITS.find(kit => kit.countryCode === country && !kit.cities.length) ?? null
}
