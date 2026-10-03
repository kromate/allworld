import manifest from '../../assets/transport/yaba-vehicle-scene.json'
import districtSource from '../../geo/district.ts?raw'
import mvtSource from '../../geo/mvt.ts?raw'
import geoSource from '../../shared/geo.ts?raw'
import navSource from '../nav.ts?raw'
import collisionSource from '../cameraCollision.ts?raw'
import placementSource from '../regions/placement.ts?raw'
import kitsSource from '../regions/kits.ts?raw'
import regionSource from '../regions/index.ts?raw'
import mountSource from '../regionMount.ts?raw'
import collisionRuleSource from '../../shared/worldCollision.ts?raw'
import streetLifeSource from '../regions/streetLife.ts?raw'
import facadeDetailSource from '../facadeDetails.ts?raw'
import frontageSource from '../regions/frontages.ts?raw'
import { buildDistrict, loadDistrict } from '../../geo/district.ts'
import type { District } from '../../geo/district.ts'
import type { DistrictId } from '../../shared/ids.ts'
import { STARTER_PLACES } from '../../shared/places.ts'
import { regionKitFor } from '../regions/kits.ts'
import type { VehicleDataVersion } from '../../shared/vehicles.ts'

const sources = [districtSource, mvtSource, geoSource, navSource, collisionSource, placementSource, kitsSource, regionSource, mountSource, collisionRuleSource, streetLifeSource, facadeDetailSource, frontageSource]
const proofs = new WeakMap<District, VehicleDataVersion>()
async function sha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
let sourceProof: Promise<void> | null = null
function verifySources(): Promise<void> {
  sourceProof ??= (async () => {
    const hashes = await Promise.all(sources.map(source => sha(new TextEncoder().encode(source))))
    const actual = manifest.source.sceneSources.map((source, index) => ({ path: source.path, sha256: hashes[index] }))
    if (await sha(new TextEncoder().encode(JSON.stringify(actual))) !== manifest.source.sceneHash) throw new Error('The vehicle street geometry does not match this build.')
    // Hash the compressed file itself, the same representation the road producer measured.
    const response = await fetch(`${import.meta.env.BASE_URL}regions/nigeria.pack.gz`, { cache: 'no-cache' })
    if (!response.ok || await sha(new Uint8Array(await response.arrayBuffer())) !== manifest.source.regionPackSha256) throw new Error('The vehicle street assets do not match this build.')
  })().catch(error => { sourceProof = null; throw error })
  return sourceProof
}

/** Build the actual scene from checked source bytes, never from a server's claimed hash. */
export async function loadVehicleDistrict(id: DistrictId, signal?: AbortSignal): Promise<District> {
  const tile = manifest.source.tiles.find(tile => tile.districtId === id)
  if (!tile) return loadDistrict(id)
  signal?.throwIfAborted()
  await verifySources()
  signal?.throwIfAborted()
  const response = await fetch(tile.url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('The supported vehicle street map could not be loaded.')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (await sha(bytes) !== tile.sha256) throw new Error('The supported vehicle street map has changed. The vehicle remains stopped.')
  signal?.throwIfAborted()
  const district = buildDistrict(id, bytes, manifest.mapDataVersion)
  proofs.set(district, { id: manifest.id, dataVersion: manifest.dataVersion, mapDataVersion: district.dataVersion })
  return district
}
export function vehicleSceneData(district: District): VehicleDataVersion | null { return proofs.get(district) ?? null }
export function supportsVehicleDistrict(id: DistrictId): boolean { return manifest.source.tiles.some(tile => tile.districtId === id) }

const vehicleAreas = [
  { label: 'Yaba, Lagos', ids: ['d:14/8345/7895', 'd:14/8345/7896', 'd:14/8346/7895', 'd:14/8346/7896'] },
  { label: 'Wuse, Abuja', ids: ['d:14/8532/7777'] },
]

/** The same supported starter districts and regional kit labels used by the offline road builder. */
export function vehicleDistrictContext(id: DistrictId): { countryCode: string; areaLabel: string; regionKitId: string } | null {
  if (!supportsVehicleDistrict(id)) return null
  const area = vehicleAreas.find(area => area.ids.includes(id))
  const place = area && STARTER_PLACES.find(place => place.countryCode === 'NG' && place.label === area.label)
  const kit = place && regionKitFor(place.countryCode, place.label)
  return place && kit ? { countryCode: place.countryCode, areaLabel: place.label, regionKitId: kit.id } : null
}
