// Read-only check that a chosen area's map can be shown, run before onboarding commits it.
//
// It reads public map data through the same loaders the world uses to enter a district, and
// returns a description of that data. It calls no service operation, writes no state, and says
// nothing about where the member physically is. Cancelling or failing leaves nothing behind
// except the loaders' own public-tile cache.
import type { District } from '../../geo/district.ts'
import { DistrictLoadError, chooseArrival, loadDistrict } from '../../geo/district.ts'
import type { Coverage } from '../../geo/district.ts'
import { parseDistrictId } from '../../shared/geo.ts'
import type { DistrictId } from '../../shared/ids.ts'
import type { CoarseArea } from '../../shared/model.ts'

export type PreflightArea = Pick<CoarseArea, 'areaId' | 'arrivalDistrict'>

export type PreflightFailure = 'invalid-area' | 'network' | 'not-found' | 'invalid-data' | 'timeout' | 'empty'

/** `verified`: the curated, hash-checked scene loaded. `not-curated`: no such scene exists for this district. `verification-failed`: one exists but did not verify. */
export interface PreflightFeature { available: boolean; reason: 'verified' | 'not-curated' | 'verification-failed' }

export interface PreflightMap {
  level: Coverage['level']
  roads: number
  namedStreets: number
  buildings: number
  places: number
  /** The loader's own plain sentence about this data. */
  summary: string
  dataVersion: string
  attribution: string
  /** `verified-pinned`: the curated tile, checked against its recorded hash. `live-tile`: the provider's current tile. */
  source: 'verified-pinned' | 'live-tile'
  /** Where everyone arrives in the game scene. A public map spot, never a device position. */
  arrival: { label: string; basis: 'public-place' | 'main-street' | 'district-centre' } | null
}

export type MapPreflight =
  | { status: 'ready' | 'limited'; canCommit: true; areaId: CoarseArea['areaId']; districtId: DistrictId; map: PreflightMap; homes: PreflightFeature; driving: PreflightFeature }
  | { status: 'unavailable'; canCommit: false; areaId: CoarseArea['areaId']; districtId: DistrictId | null; reason: PreflightFailure; detail: string }
  | { status: 'cancelled'; canCommit: false; areaId: CoarseArea['areaId'] }

/** The three reads preflight needs. Tests replace them; the defaults are the world's own loaders. */
export interface PreflightLoaders {
  curation(id: DistrictId): Promise<{ driving: boolean; homes: boolean }>
  loadPinned(id: DistrictId, signal: AbortSignal): Promise<District>
  loadLive(id: DistrictId): Promise<District>
}

export const PREFLIGHT_TIMEOUT_MS = 20_000

// Loaded on first use: the curated-scene module is bundler-only and would keep this file out of Node probes.
const worldLoaders: PreflightLoaders = {
  async curation(id) {
    const [vehicles, homes] = await Promise.all([import('../../world/vehicles/provenance.ts'), import('../../assets/homes/yaba-home-scene.json')])
    return { driving: vehicles.supportsVehicleDistrict(id), homes: homes.default.districts.some(row => row.districtId === id) }
  },
  async loadPinned(id, signal) { return (await import('../../world/vehicles/provenance.ts')).loadVehicleDistrict(id, signal) },
  loadLive: loadDistrict,
}

class Stopped extends Error {}

/** Reject when `signal` aborts; `release` removes the listener so a finished race leaves nothing attached. */
function stopGate(signal: AbortSignal): { promise: Promise<never>; release(): void } {
  let onAbort = (): void => undefined
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Stopped())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => undefined)
  return { promise, release: () => signal.removeEventListener('abort', onAbort) }
}

function failure(error: unknown): { reason: PreflightFailure; detail: string } {
  if (error instanceof DistrictLoadError) return { reason: error.kind === 'invalid' ? 'invalid-data' : error.kind, detail: error.message }
  return { reason: 'network', detail: 'The map service did not answer. Check your connection and try again.' }
}

/**
 * Check that the map for `area` can be loaded and describe what it supports. Never throws and
 * never touches the world: the caller commits the character and area only after a `ready` or
 * `limited` result for the area it still has selected. Pass `signal` to cancel; compare the
 * returned `areaId` with the current selection before using the result.
 */
export async function preflightArea(area: PreflightArea, signal?: AbortSignal, loaders: PreflightLoaders = worldLoaders, timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<MapPreflight> {
  const { areaId } = area
  if (signal?.aborted) return { status: 'cancelled', canCommit: false, areaId }
  const districtId = parseDistrictId(area.arrivalDistrict) ? area.arrivalDistrict : null
  if (!districtId) return { status: 'unavailable', canCommit: false, areaId, districtId: null, reason: 'invalid-area', detail: 'That area has no valid map district.' }

  const stop = new AbortController()
  const onCaller = (): void => stop.abort()
  signal?.addEventListener('abort', onCaller, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; stop.abort() }, timeoutMs)
  const gate = stopGate(stop.signal)
  const guard = <T>(work: Promise<T>): Promise<T> => { work.catch(() => undefined); return Promise.race([work, gate.promise]) }
  try {
    const curation = await guard(loaders.curation(districtId).catch(() => ({ driving: false, homes: false })))
    let district: District | null = null
    let verified = false
    if (curation.driving) {
      try { district = await guard(loaders.loadPinned(districtId, stop.signal)); verified = true }
      catch (error) { if (error instanceof Stopped) throw error }
    }
    // Mirrors entering a district: a curated tile that fails its check falls back to the live tile, without the curated features.
    district ??= await guard(loaders.loadLive(districtId))
    if (signal?.aborted) return { status: 'cancelled', canCommit: false, areaId }
    const { coverage } = district
    if (coverage.level === 'empty') return { status: 'unavailable', canCommit: false, areaId, districtId, reason: 'empty', detail: coverage.summary }
    let arrival: PreflightMap['arrival'] = null
    try { const chosen = chooseArrival(district); arrival = { label: chosen.label, basis: chosen.basis } } catch { /* the scene picks its own arrival on entry */ }
    const feature = (curated: boolean): PreflightFeature => ({ available: curated && verified, reason: !curated ? 'not-curated' : verified ? 'verified' : 'verification-failed' })
    return {
      status: coverage.level === 'detailed' ? 'ready' : 'limited', canCommit: true, areaId, districtId,
      map: {
        level: coverage.level, roads: coverage.roads, namedStreets: coverage.namedStreets, buildings: coverage.buildings, places: coverage.places,
        summary: coverage.summary, dataVersion: district.dataVersion, attribution: district.attribution, source: verified ? 'verified-pinned' : 'live-tile', arrival,
      },
      homes: feature(curation.homes), driving: feature(curation.driving),
    }
  } catch (error) {
    if (signal?.aborted) return { status: 'cancelled', canCommit: false, areaId }
    if (error instanceof Stopped || timedOut) return { status: 'unavailable', canCommit: false, areaId, districtId, reason: 'timeout', detail: 'The map service took too long. Check your connection and try again.' }
    return { status: 'unavailable', canCommit: false, areaId, districtId, ...failure(error) }
  } finally {
    clearTimeout(timer)
    gate.release()
    signal?.removeEventListener('abort', onCaller)
  }
}
