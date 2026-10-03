// The home in the street: the parcel a house stands on, the building everyone sees, and going in
// and out by its door. The contract is src/shared/homes.ts.
//
// Parcels come from one bundled file (service/data/homes/yaba-homes.json) built offline from the
// trusted map (scripts/build-home-parcels.ts). The file is used only when it matches its own
// hash and the versions the App is built with. Nothing about a place comes from a request.
//
// A home is entered only by a member whose character the rooms module has standing at its door,
// and left only to the door they came in by. The door a member went in by is kept with their
// stay, so nothing done to the home afterwards moves it.
//
// service/homes.ts owns who may come in and who is told where a home stands; it passes those
// answers in. On a sharded service the state process cannot say where a character stands at this
// moment, so every door operation there is refused before anything is changed.
import { createHash } from 'node:crypto'
import homeParcelFile from './data/homes/yaba-homes.json' with { type: 'json' }
import type { DistrictId, HomeId, Iso, MemberId } from '../src/shared/ids.ts'
import { iso, randomToken } from '../src/shared/ids.ts'
import { distance, parseDistrictId } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import { WorldError, roomKey } from '../src/shared/model.ts'
import type { ChatMessage, CoarseArea, RoomRef, RoomSnapshot } from '../src/shared/model.ts'
import { HOME_PHYSICAL, exteriorFootprints, houseType, roomAt, sameParcelSource, shellFits } from '../src/shared/homes.ts'
import type {
  HomeApproach, HomeBuilding, HomeEnvelope, HomeExteriorEntry, HomeExteriorFootprint, HomeExteriorScenery, HomeLeft, HomeParcelAnchor, HomeParcelManifest,
  HomeParcelOption, HomeParcelSource, HomePlan, HomePresence, HomeSite, HomeSiteStatus, HomeStay, HomeUnavailableReason,
} from '../src/shared/homes.ts'
import type { BuildingState, BuiltHome, EstateRecord, SiteRecord } from './homeBuilding.ts'
import { estateOf, furnitureInTheWay, ownEstate, planOf } from './homeBuilding.ts'
import type { World } from './kernel.ts'
import { parseCoarseArea } from './members.ts'
import { admitTo, heldReason, occupantsOfRoom, placeOf, spaceIn, standingIn } from './rooms.ts'
import { streetAdmission, whereIs } from './travel.ts'
import { trustedStreetAvailable } from './streetEntry.ts'

// ── The parcel data ───────────────────────────────────────────────────────────────────────────

export interface HomeParcel {
  id: string; label: string; door: Vec2; facing: number; standing: Vec2; exit: Vec2; alternates: Vec2[]; envelope: HomeEnvelope; access: Vec2
  /** The builder's proved walk from the district's public arrival point to `standing`, metres. Parcels are listed nearest first by it. */
  walk: { length: number; viaStreets: boolean }
}
export interface HomeParcelData {
  schemaVersion: 1
  id: string
  /** SHA-256 of the canonical JSON of everything else in the file. */
  dataVersion: string
  mapDataVersion: string
  coordinateSystem: 'district-metres-east-south'
  /** What the parcels were worked out from. The road data is named so the two can be held to each other. */
  derivedFrom: { roadData: { id: string; dataVersion: string }; sceneHash: string; regionPackSha256: string } & Record<string, unknown>
  /** `area`: where a trip to the district is booked to, a place of the public gazetteer. `arrival`: the public point its parcels' walks are measured from. */
  districts: { districtId: DistrictId; tileSha256: string; span: number; area: CoarseArea; arrival: { pos: Vec2; label: string; basis: string }; parcels: HomeParcel[] }[]
}

/** Keys sorted, arrays in their own order: the rule the road data's version uses. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  throw new Error('Parcel data contains a value that is not JSON')
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const HEX = /^[0-9a-f]{64}$/

/**
 * The parcel data this service is built to run: the `dataVersion` printed by
 * scripts/build-home-parcels.ts. A bundled file of any other version is not loaded. When the map,
 * the scene or the region pack is refreshed, the parcels are built again and this line changes
 * with them; homes placed under the old version are kept where they are and marked, not moved.
 */
export const HOME_PARCEL_DATA_VERSION = '2ca55507802572512f5025f9dd65cf4403b1ff6e468e11b9b25b8781d81b871f'

/** What the App's manifest (src/assets/homes/yaba-home-scene.json) must say for this data: the builder writes exactly this. */
export const manifestOf = (data: HomeParcelData): HomeParcelManifest => ({
  schemaVersion: 1, id: data.id, dataVersion: data.dataVersion, mapDataVersion: data.mapDataVersion, sceneHash: data.derivedFrom.sceneHash, regionPackSha256: data.derivedFrom.regionPackSha256,
  districts: data.districts.map(district => ({ districtId: district.districtId, tileSha256: district.tileSha256, parcels: district.parcels.length })),
})

/**
 * Read parcel data, or throw saying what is wrong with it. It is accepted only whole: its own
 * hash and every parcel's numbers, and the versions in a manifest when one is given to hold it to.
 */
export function readHomeParcels(text: string, manifest?: HomeParcelManifest): HomeParcelData {
  const data = JSON.parse(text) as HomeParcelData
  const fail = (why: string): never => { throw new Error(`Home parcel data refused: ${why}`) }
  if (data.schemaVersion !== 1 || data.coordinateSystem !== 'district-metres-east-south' || !Array.isArray(data.districts)) fail('not a parcel file this service reads')
  const { dataVersion, ...payload } = data
  if (!HEX.test(String(dataVersion)) || sha256(canonicalJson(payload)) !== dataVersion) fail('it does not match its own version')
  if (manifest && canonicalJson(manifest) !== canonicalJson(manifestOf(data))) fail('it is not the version the App is built with')
  const finite = (...values: number[]): boolean => values.every(Number.isFinite)
  for (const district of data.districts) {
    if (!parseDistrictId(district.districtId) || !HEX.test(district.tileSha256)) fail(`district ${district.districtId} is not one`)
    district.area = parseCoarseArea(district.area)
    const ids = new Set<string>(), half = district.span / 2
    // The default lot is the first free one that fits, so the order is part of what is trusted: nearest first.
    if (district.parcels.some((parcel, index) => index > 0 && parcel.walk?.length < district.parcels[index - 1]!.walk?.length)) fail(`district ${district.districtId} does not list its parcels nearest first`)
    for (const parcel of district.parcels) {
      if (typeof parcel.id !== 'string' || ids.has(parcel.id)) fail('two parcels share an id')
      ids.add(parcel.id)
      const points = [parcel.door, parcel.standing, parcel.exit, parcel.access, ...parcel.alternates]
      if (!finite(parcel.facing, parcel.envelope.xMin, parcel.envelope.xMax, parcel.envelope.depth, ...points.flatMap(p => [p.x, p.z])) || points.some(p => Math.abs(p.x) > half || Math.abs(p.z) > half)) fail(`parcel ${parcel.id} has a position outside its district`)
      if (parcel.envelope.xMin > 0 || parcel.envelope.xMax < 0 || parcel.envelope.depth <= 0 || parcel.alternates.length > HOME_PHYSICAL.alternates) fail(`parcel ${parcel.id} has no usable envelope`)
      if (!parcel.walk || !Number.isFinite(parcel.walk.length) || parcel.walk.length <= 0) fail(`parcel ${parcel.id} has no proved walk from the arrival point`)
      // Where a character stands to go in must itself pass the door rule, and every way out must be clear of the wall.
      const out = (p: Vec2): number => (p.x - parcel.door.x) * Math.sin(parcel.facing) + (p.z - parcel.door.z) * Math.cos(parcel.facing)
      if (distance(parcel.standing, parcel.door) > HOME_PHYSICAL.doorRange || [parcel.standing, parcel.exit, ...parcel.alternates].some(p => out(p) < HOME_PHYSICAL.clearRadius)) fail(`parcel ${parcel.id} has a standing point that is not at its door`)
    }
  }
  return data
}

let bundled: { data: HomeParcelData | null; problem: string } | null = null
/** The file this service ships with, read once. A file that is missing or wrong is no data, with the reason kept. */
function bundledParcels(): { data: HomeParcelData | null; problem: string } {
  if (bundled) return bundled
  try {
    // Bundled with the module so a Worker has it too; read as text, through the same checks as any other parcel file.
    const data = readHomeParcels(JSON.stringify(homeParcelFile))
    if (data.dataVersion !== HOME_PARCEL_DATA_VERSION) throw new Error(`Home parcel data refused: it is version ${data.dataVersion.slice(0, 12)}…, and this service is built to run ${HOME_PARCEL_DATA_VERSION.slice(0, 12)}…`)
    bundled = { data, problem: '' }
  } catch (error) {
    bundled = { data: null, problem: error instanceof Error ? error.message : String(error) }
    console.error('[homes] no home can be placed or entered: the parcel data was not loaded.', bundled.problem)
  }
  return bundled
}

// ── Per-world state that is not saved ─────────────────────────────────────────────────────────

/** A wall rectangle, ready to test points against. */
interface Solid { pos: Vec2; cos: number; sin: number; hx: number; hz: number }
export interface HomeObstacle { id: string; kind: 'home'; outer: Vec2[]; holes: []; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }
interface Street { revision: string; buildings: HomeExteriorScenery[]; homes: HomeId[]; obstacles: HomeObstacle[]; solids: Solid[] }
/** What the vehicle module answers for homes. See `setHomeVehicleAuthority`. */
export interface HomeVehicleAuthority {
  /** Why this member is being carried and may not walk through a door, or null. */
  held(memberId: MemberId): string | null
  /** Is a vehicle in this street instance over the disc at `point`? */
  blocked(districtId: DistrictId, instance: number, point: Vec2, radius: number): boolean
}
interface Runtime {
  /** `undefined`: use the bundled file. */
  data: HomeParcelData | null | undefined
  problem: string
  /** Does this service have vehicles? Asked once: operations are registered before any is called. */
  carries: boolean | null
  streets: Map<DistrictId, Street>
  vehicles: HomeVehicleAuthority | null
  listeners: ((districtId: DistrictId, revision: string) => void)[]
  /** Members who have a last exit, so that a step by anyone else costs one lookup. Null until first asked. */
  exitHolders: Set<string> | null
}
const runtimes = new WeakMap<World, Runtime>()
const runtime = (world: World): Runtime => {
  let found = runtimes.get(world)
  if (!found) { found = { data: undefined, problem: '', carries: null, streets: new Map(), vehicles: null, listeners: [], exitHolders: null }; runtimes.set(world, found) }
  return found
}
function parcelData(world: World): HomeParcelData | null {
  const rt = runtime(world)
  return rt.data === undefined ? bundledParcels().data : rt.data
}

/** Use this parcel data, or none, in place of the bundled file. For integration and for checks; the data must have come through `readHomeParcels`. */
export function useHomeParcels(world: World, data: HomeParcelData | null, problem = ''): void {
  const rt = runtime(world)
  rt.data = data
  rt.problem = problem
  rt.streets.clear()
}

/**
 * Hold the parcels to the road data the service is running. Call it where both are loaded. If
 * they were not made from the same map, scene and region pack, the parcels are withdrawn: every
 * placed home becomes unavailable, in so many words, and none is moved.
 */
export function holdHomeParcelsToRoads(world: World, roads: { id: string; dataVersion: string; mapDataVersion: string; source: { sceneHash: string; regionPackSha256: string; tiles: { districtId: DistrictId; sha256: string }[] } }): boolean {
  const data = parcelData(world)
  if (!data) return false
  const same = data.derivedFrom.roadData.id === roads.id && data.derivedFrom.roadData.dataVersion === roads.dataVersion && data.mapDataVersion === roads.mapDataVersion
    && data.derivedFrom.sceneHash === roads.source.sceneHash && data.derivedFrom.regionPackSha256 === roads.source.regionPackSha256
    && data.districts.every(district => roads.source.tiles.some(tile => tile.districtId === district.districtId && tile.sha256 === district.tileSha256))
  if (!same) {
    useHomeParcels(world, null, 'The home parcels were built from another version of the street map than the one this service runs. Build them again.')
    console.error('[homes] the parcel data does not belong to the road data in use; homes are unavailable until it is rebuilt.')
  }
  return same
}

/**
 * The vehicle module's part in a door: who is being carried, and whether a vehicle stands over a
 * way out. With vehicle operations registered and this not set, no door opens: an unknown seat is
 * never taken for a free one.
 */
export function setHomeVehicleAuthority(world: World, authority: HomeVehicleAuthority | null): void { runtime(world).vehicles = authority }

/** Told when the buildings standing in a district change. For the module that collides vehicles with them. */
export function onHomeObstaclesChanged(world: World, listener: (districtId: DistrictId, revision: string) => void): void { runtime(world).listeners.push(listener) }

const NO_LIVE = 'This service cannot say where a character is standing at this moment, so homes cannot be gone to here.'
const NO_VEHICLES = 'Homes are closed until the vehicle service is connected to them.'
/** Why no door can be used on this service at all, or null. Asked before anything is changed. */
function doorsClosed(world: World): string | null {
  if (world.roomHost) return NO_LIVE
  if (parcelData(world)?.districts.some(district => !trustedStreetAvailable(world, district.districtId))) return 'Homes are closed until trusted street entry is available.'
  const rt = runtime(world)
  if (!rt.vehicles && (rt.carries ??= world.registered().includes('vehicle.state'))) return NO_VEHICLES
  return null
}
const held = (world: World, memberId: MemberId): string | null => heldReason(world, memberId) ?? runtime(world).vehicles?.held(memberId) ?? null

// ── What is saved ─────────────────────────────────────────────────────────────────────────────

/** The door a member went in by: the anchor as it was then, and the street instance they came from. */
interface StayRecord { homeId: HomeId; buildingId: string; districtId: DistrictId; since: Iso; state: HomeStay['state']; instance: number; anchor: HomeParcelAnchor }
/** Where the last `home.leave` put a member. */
interface ExitRecord { districtId: DistrictId; instance: number; pos: Vec2; heading: number; anchor: HomeParcelAnchor; at: Iso }
type PlacedHome = BuiltHome & { name: string }
/** The homes slice as this module reads it. `parcels` says which home stands on which parcel. */
export interface PhysicalState extends BuildingState {
  homes: Record<string, PlacedHome>
  parcels?: Record<string, HomeId>
  stays?: Record<string, StayRecord>
  exits?: Record<string, ExitRecord>
}
/** The homes slice. service/homes.ts opens it the same way. */
export const physicalState = (world: World): PhysicalState => world.slice<PhysicalState>('homes', () => ({ homes: {} }))
const parcelKey = (districtId: DistrictId, parcelId: string): string => `${districtId}|${parcelId}`
const streetRef = (districtId: DistrictId): RoomRef => ({ kind: 'district', districtId })

export function sourceOf(world: World, districtId: DistrictId): HomeParcelSource | null {
  const data = parcelData(world)
  const district = data?.districts.find(entry => entry.districtId === districtId)
  return data && district ? {
    id: data.id, dataVersion: data.dataVersion, mapDataVersion: data.mapDataVersion, tileSha256: district.tileSha256,
    sceneHash: data.derivedFrom.sceneHash, regionPackSha256: data.derivedFrom.regionPackSha256,
  } : null
}
function anchorStatus(world: World, districtId: DistrictId, anchor: HomeParcelAnchor): HomeSiteStatus {
  const source = sourceOf(world, districtId)
  return !source ? 'source-missing' : sameParcelSource(source, anchor.source) ? 'valid' : 'source-stale'
}
const siteView = (world: World, site: SiteRecord): HomeSite => ({
  districtId: site.districtId, areaLabel: site.areaLabel, area: site.area, buildingId: site.buildingId, parcel: site.parcel,
  status: anchorStatus(world, site.districtId, site.parcel), placedAt: site.placedAt,
})

function exteriorOf(home: BuiltHome, estate: EstateRecord, plan: HomePlan): HomeBuilding['exterior'] {
  const type = houseType(estate.houseType), front = plan.rooms.find(room => room.id === plan.entrance.roomId)
  return { style: type.exterior.style, roof: type.exterior.roof, wall: front?.wall ?? home.layout.wall, storeys: type.exterior.storeys }
}

/** `showSite`: service/homes.ts decides who is told where the house stands. Everyone else gets the building with no site. */
export function buildingOf(world: World, home: BuiltHome, showSite: boolean): HomeBuilding {
  const estate = estateOf(home), plan = planOf(home, estate)
  return { houseType: estate.houseType, plan, exterior: exteriorOf(home, estate, plan), site: showSite && estate.site ? siteView(world, estate.site) : null }
}

// ── The buildings in a street ─────────────────────────────────────────────────────────────────

function sceneryOf(world: World, home: BuiltHome): HomeExteriorScenery | null {
  const estate = estateOf(home), site = estate.site
  if (!site || anchorStatus(world, site.districtId, site.parcel) !== 'valid') return null
  const plan = planOf(home, estate), exterior = exteriorOf(home, estate, plan)
  return {
    buildingId: site.buildingId, footprints: exteriorFootprints(plan, site.parcel, exterior.storeys),
    frontDoor: { pos: { x: site.parcel.door.x, z: site.parcel.door.z }, facing: site.parcel.facing }, exterior,
  }
}
const solidOf = (footprint: HomeExteriorFootprint): Solid => ({ pos: footprint.pos, cos: Math.cos(footprint.angle), sin: Math.sin(footprint.angle), hx: footprint.width / 2, hz: footprint.depth / 2 })
const inSolid = (solid: Solid, p: Vec2): Vec2 => { const dx = p.x - solid.pos.x, dz = p.z - solid.pos.z; return { x: dx * solid.cos - dz * solid.sin, z: dx * solid.sin + dz * solid.cos } }
/** Distance from a point to a wall rectangle. Zero inside it. */
const toSolid = (solid: Solid, p: Vec2): number => { const at = inSolid(solid, p); return Math.hypot(Math.max(0, Math.abs(at.x) - solid.hx), Math.max(0, Math.abs(at.z) - solid.hz)) }
function crossesSolid(solid: Solid, from: Vec2, to: Vec2, grow: number): boolean {
  const a = inSolid(solid, from), b = inSolid(solid, to)
  let lo = 0, hi = 1
  for (const [start, delta, half] of [[a.x, b.x - a.x, solid.hx + grow], [a.z, b.z - a.z, solid.hz + grow]] as [number, number, number][]) {
    if (delta === 0) { if (Math.abs(start) >= half) return false; continue }
    const first = (-half - start) / delta, last = (half - start) / delta
    lo = Math.max(lo, Math.min(first, last)); hi = Math.min(hi, Math.max(first, last))
  }
  return lo < hi
}

/** Everything standing in one district, worked out once and kept until something there changes. */
function streetOf(world: World, state: PhysicalState | undefined, districtId: DistrictId): Street {
  const rt = runtime(world)
  const known = rt.streets.get(districtId)
  if (known) return known
  const buildings: HomeExteriorScenery[] = [], homes: HomeId[] = []
  const prefix = `${districtId}|`
  for (const [key, homeId] of Object.entries(state?.parcels ?? {})) {
    if (!key.startsWith(prefix)) continue
    const home = state?.homes[homeId]
    const scenery = home ? sceneryOf(world, home) : null
    if (scenery) { buildings.push(scenery); homes.push(homeId) }
  }
  // In the order of the random building ids, so the list says nothing of who placed first.
  const order = buildings.map((_, index) => index).sort((a, b) => buildings[a]!.buildingId < buildings[b]!.buildingId ? -1 : 1)
  const sorted = order.map(index => buildings[index]!)
  const obstacles: HomeObstacle[] = [], solids: Solid[] = []
  for (const building of sorted) for (const [index, footprint] of building.footprints.entries()) {
    const solid = solidOf(footprint)
    // The corner rule every renderer of these rectangles uses (HOME-EXTERIOR-041).
    const outer = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]).map(([sx, sz]) => {
      const x = sx * solid.hx, z = sz * solid.hz
      return { x: footprint.pos.x + x * solid.cos + z * solid.sin, z: footprint.pos.z - x * solid.sin + z * solid.cos }
    })
    const xs = outer.map(p => p.x), zs = outer.map(p => p.z)
    obstacles.push({ id: `${building.buildingId}:${index}`, kind: 'home', outer, holes: [], bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) } })
    solids.push(solid)
  }
  const street: Street = { revision: sha256(canonicalJson({ source: sourceOf(world, districtId), buildings: sorted })).slice(0, 24), buildings: sorted, homes: order.map(index => homes[index]!), obstacles, solids }
  rt.streets.set(districtId, street)
  return street
}

/**
 * The buildings standing in a district now, as obstacles: exactly the rectangles `home.exteriors`
 * sends. A second list beside the static one of the road data, whose file and hashes it never touches.
 */
export function homeObstacles(world: World, districtId: DistrictId): { revision: string; obstacles: readonly HomeObstacle[] } {
  const street = streetOf(world, world.peek<PhysicalState>('homes'), districtId)
  return { revision: street.revision, obstacles: street.obstacles }
}

/** A walker is kept this far from a wall: a little inside what the App's own walking keeps, so the two never fight at a wall. */
const FOOT_MARGIN = HOME_PHYSICAL.clearRadius - 0.1
/** A billionth of a metre, so a character stood exactly on a limit is inside it whatever the arithmetic rounds to. */
const SLACK = 1e-9
/**
 * May a walker go from `from` to `to` in this district? Not into a building, and not through one.
 * A walker already inside one (it was built round them) may only walk out.
 */
export function homeFootAllowed(world: World, districtId: DistrictId, from: Vec2 | null, to: Vec2): boolean {
  for (const solid of streetOf(world, world.peek<PhysicalState>('homes'), districtId).solids) {
    if (toSolid(solid, to) < FOOT_MARGIN) return false
    if (from && toSolid(solid, from) >= FOOT_MARGIN && crossesSolid(solid, from, to, FOOT_MARGIN)) return false
  }
  return true
}

/** After anything that may have changed a district's buildings, or who is given an entry for one: tell everyone standing there to ask again. */
export function announceExteriors(world: World, state: PhysicalState, districtId: DistrictId): void {
  const rt = runtime(world)
  const before = rt.streets.get(districtId)?.revision
  rt.streets.delete(districtId)
  const street = streetOf(world, state, districtId)
  world.pushMany(occupantsOfRoom(world, roomKey(streetRef(districtId))), { type: 'home.exteriors', districtId, sceneRevision: street.revision })
  if (before !== street.revision) for (const listener of rt.listeners) { try { listener(districtId, street.revision) } catch (error) { console.error('[homes] an obstacle listener failed', error) } }
}
/** The same for every district that has a home standing in it. For changes whose other side is not known here. */
export function announceEverywhere(world: World, state: PhysicalState): void {
  const districts = new Set<DistrictId>()
  for (const key of Object.keys(state.parcels ?? {})) districts.add(key.slice(0, key.indexOf('|')) as DistrictId)
  for (const districtId of districts) announceExteriors(world, state, districtId)
}
/** Run a change to one home, then tell its street if what stands there is different. */
export function watchExterior<T>(world: World, state: PhysicalState, home: BuiltHome, run: () => T): T {
  const seen = (): string => JSON.stringify(sceneryOf(world, home))
  const before = seen()
  const result = run()
  const districtId = estateOf(home).site?.districtId
  if (districtId && seen() !== before) announceExteriors(world, state, districtId)
  return result
}

export function exteriorsFor(world: World, state: PhysicalState, viewer: MemberId, districtId: DistrictId, source: HomeParcelSource, mayEnter: (home: PlacedHome) => boolean): {
  source: HomeParcelSource; sceneRevision: string; buildings: HomeExteriorScenery[]; entries: HomeExteriorEntry[]
} {
  const closed = doorsClosed(world)
  if (closed) throw new WorldError('unavailable', closed)
  const refusal = streetAdmission(world, viewer, streetRef(districtId))
  if (refusal) throw new WorldError('forbidden', refusal)
  const current = sourceOf(world, districtId)
  if (!current) throw new WorldError('unavailable', runtime(world).problem || 'There is no home parcel data for this district, so no homes stand here.')
  if (!sameParcelSource(current, source)) throw new WorldError('conflict', 'The street map has changed. Reload before going to a home here.')
  const street = streetOf(world, state, districtId)
  const entries: HomeExteriorEntry[] = []
  for (const [index, homeId] of street.homes.entries()) {
    const home = state.homes[homeId], site = home ? estateOf(home).site : null
    if (home && site && mayEnter(home)) entries.push({ buildingId: street.buildings[index]!.buildingId, homeId, name: home.name, standing: { x: site.parcel.standing.x, z: site.parcel.standing.z } })
  }
  return { source: current, sceneRevision: street.revision, buildings: street.buildings, entries }
}

// ── Placing a home ────────────────────────────────────────────────────────────────────────────

/** The district the member's character is in and allowed to be in, or the sentence saying why there is none. */
function standingDistrict(world: World, memberId: MemberId): { districtId: DistrictId; areaLabel: string } | string {
  const where = whereIs(world, memberId)
  if (!where.location) return 'Choose where you are first. Then you can place your home there.'
  const place = placeOf(world, memberId)
  const districtId = place && (place.ref.kind === 'district' || place.ref.kind === 'venue') ? place.ref.districtId : where.location.arrivalDistrict
  // The travel rule, asked the way the street guard asks it: walking range, and not on a trip.
  const refusal = streetAdmission(world, memberId, streetRef(districtId))
  return refusal ?? { districtId, areaLabel: where.location.label }
}

const NO_COVERAGE = 'No home can stand in this district: there is no parcel data for it. Homes can be placed in the districts of Yaba, Lagos.'
const optionOf = (parcel: HomeParcel, taken: boolean, fits: boolean): HomeParcelOption => ({
  parcelId: parcel.id, label: parcel.label, door: { ...parcel.door }, facing: parcel.facing, standing: { ...parcel.standing }, envelope: { ...parcel.envelope }, taken, fits,
})

export function sitesFor(world: World, state: PhysicalState, home: BuiltHome): {
  here: { districtId: DistrictId; areaLabel: string } | null; reason: string; unavailable: HomeUnavailableReason | null
  parcels: HomeParcelOption[]; source: HomeParcelSource | null; site: HomeSite | null
} {
  const estate = estateOf(home), site = estate.site ? siteView(world, estate.site) : null
  const none = { parcels: [] as HomeParcelOption[], source: null, site }
  const closed = doorsClosed(world)
  if (closed) return { here: null, reason: closed, unavailable: 'no-live-position', ...none }
  const here = standingDistrict(world, home.owner)
  if (typeof here === 'string') return { here: null, reason: here, unavailable: null, ...none }
  const source = sourceOf(world, here.districtId)
  const district = parcelData(world)?.districts.find(entry => entry.districtId === here.districtId)
  if (!source || !district) return { here, reason: runtime(world).problem || NO_COVERAGE, unavailable: 'no-coverage', ...none }
  const plan = planOf(home, estate), taken = state.parcels ?? {}
  return {
    here, reason: '', unavailable: null, source, site,
    parcels: district.parcels.map(parcel => { const holder = taken[parcelKey(here.districtId, parcel.id)]; return optionOf(parcel, holder !== undefined && holder !== home.id, shellFits(plan, parcel.envelope)) }),
  }
}

const openStays = (state: PhysicalState, homeId: HomeId): number => Object.values(state.stays ?? {}).filter(stay => stay.homeId === homeId).length
/**
 * Would these walls come onto, or closer against, a character standing in the district's street?
 * Each character is judged on their own, by the distance walking keeps from a wall: one already
 * as close to the walls that are there (`before`) is not a reason to refuse, and does not excuse
 * another whom the new walls would reach.
 */
function someoneOn(world: World, districtId: DistrictId, footprints: HomeExteriorFootprint[], before: HomeExteriorFootprint[] = []): boolean {
  const solids = footprints.map(solidOf), old = before.map(solidOf)
  const gap = (list: Solid[], at: Vec2): number => list.reduce((best, solid) => Math.min(best, toSolid(solid, at)), Infinity)
  for (const memberId of occupantsOfRoom(world, roomKey(streetRef(districtId)))) {
    const at = placeOf(world, memberId)?.pos
    if (!at) continue
    const now = gap(solids, at)
    if (now < FOOT_MARGIN && now < gap(old, at) - SLACK) return true
  }
  return false
}

/**
 * Place the member's own home on a parcel in the district their character is in (`parcelId` null:
 * the first free parcel the rooms fit, in the data's order, which is nearest first by the proved
 * walk from the district's arrival point), or take it off the map (`place` null).
 * The service never does this unasked, and never moves a placed home by itself.
 */
export function setSite(world: World, state: PhysicalState, home: BuiltHome, place: { parcelId: string | null } | null, now: number): void {
  const closed = doorsClosed(world)
  if (closed) throw new WorldError('unavailable', closed)
  world.limit(`home-site:${home.owner}`, 12, 3_600_000)
  if (occupantsOfRoom(world, roomKey({ kind: 'home', homeId: home.id })).length > 0 || openStays(state, home.id) > 0) {
    throw new WorldError('conflict', 'Someone is inside your home, or has not yet left by its door. A home stays where it is until everyone is out.')
  }
  const estate = ownEstate(world, home)
  const taken = (state.parcels ??= {})
  let site: SiteRecord | null = null
  if (place) {
    const here = standingDistrict(world, home.owner)
    if (typeof here === 'string') throw new WorldError('conflict', here)
    const data = parcelData(world), source = sourceOf(world, here.districtId)
    const district = data?.districts.find(entry => entry.districtId === here.districtId)
    if (!data || !source || !district) throw new WorldError('unavailable', runtime(world).problem || NO_COVERAGE)
    const plan = planOf(home, estate)
    const holder = (parcel: HomeParcel): HomeId | undefined => taken[parcelKey(here.districtId, parcel.id)]
    let parcel: HomeParcel | undefined
    if (place.parcelId === null) {
      parcel = district.parcels.find(entry => (holder(entry) === undefined || holder(entry) === home.id) && shellFits(plan, entry.envelope))
      if (!parcel) throw new WorldError('conflict', 'There is no free parcel in this district that your rooms fit. Try another district of Yaba, or make the house smaller.')
    } else {
      parcel = district.parcels.find(entry => entry.id === place.parcelId)
      if (!parcel) throw new WorldError('not_found', 'That parcel is not one this service can vouch for in the district you are in.')
      if (holder(parcel) !== undefined && holder(parcel) !== home.id) throw new WorldError('conflict', 'Another home already stands on that parcel.')
      if (!shellFits(plan, parcel.envelope)) throw new WorldError('conflict', `Your rooms do not fit that parcel: it keeps ${parcel.envelope.xMax - parcel.envelope.xMin} metres along the front and ${parcel.envelope.depth} back from the door.`)
    }
    const anchor: HomeParcelAnchor = {
      parcelId: parcel.id, source, door: { ...parcel.door }, facing: parcel.facing, standing: { ...parcel.standing }, exit: { ...parcel.exit },
      alternates: parcel.alternates.map(point => ({ ...point })), envelope: { ...parcel.envelope }, access: { ...parcel.access },
    }
    if (someoneOn(world, here.districtId, exteriorFootprints(plan, anchor, 1))) throw new WorldError('conflict', 'Someone is standing on that ground. Wait until it is clear.')
    // A new building each time: its id is random and says nothing of the home or its owner.
    site = { districtId: here.districtId, areaLabel: district.area.label, area: district.area, buildingId: `hb_${randomToken(16)}`, placedAt: iso(now), parcel: anchor }
  }
  const before = estate.site
  if (before && taken[parcelKey(before.districtId, before.parcel.parcelId)] === home.id) delete taken[parcelKey(before.districtId, before.parcel.parcelId)]
  if (site) taken[parcelKey(site.districtId, site.parcel.parcelId)] = home.id
  estate.site = site
  home.updatedAt = iso(now)
  world.touch()
  if (before) announceExteriors(world, state, before.districtId)
  if (site && site.districtId !== before?.districtId) announceExteriors(world, state, site.districtId)
}

/** Hold a proposed plan of a placed home to its parcel. Called in the quote and again in the commit, before any coin moves. */
export function checkPlanOnParcel(world: World, home: BuiltHome, estate: EstateRecord, plan: HomePlan): void {
  const site = estate.site
  if (!site) return
  if (!shellFits(plan, site.parcel.envelope)) {
    throw new WorldError('conflict', `Those rooms would not fit the parcel your home stands on. It keeps ${site.parcel.envelope.xMax - site.parcel.envelope.xMin} metres along the front and ${site.parcel.envelope.depth} back from the door, and nothing may stand in front of the door’s wall. Change the plan, or place the home on a bigger parcel first.`)
  }
  if (someoneOn(world, site.districtId, exteriorFootprints(plan, site.parcel, 1), exteriorFootprints(planOf(home, estate), site.parcel, 1))) {
    throw new WorldError('conflict', 'Someone is standing in the street where the house would grow. Wait until the ground is clear.')
  }
}

// ── Going to a home ───────────────────────────────────────────────────────────────────────────

const insideOf = (plan: HomePlan): { roomId: string; pos: Vec2; heading: number } => ({ roomId: plan.entrance.roomId, pos: { ...plan.entrance.inside.pos }, heading: plan.entrance.inside.heading })
const UNAVAILABLE: Record<HomeUnavailableReason, string> = {
  unplaced: 'This home has not been placed in a street yet, so it cannot be gone to.',
  'no-coverage': NO_COVERAGE,
  'source-missing': 'This home stands where the service has no street data just now. It has not been moved, and cannot be gone to until that is back.',
  'source-stale': 'The street this home stands in has been redrawn. It has not been moved, and cannot be gone to until its owner places it again.',
  'no-live-position': NO_LIVE,
  'not-shared': 'You may visit this home, but its owner has not shared where it stands.',
}

/** Why this home cannot be gone to at all, or null. */
function unavailable(world: World, home: BuiltHome, showSite: boolean): { reason: HomeUnavailableReason; message: string } | null {
  // First, so that a caller who is not told where a home stands is not told whether it stands anywhere either.
  if (!showSite) return { reason: 'not-shared', message: UNAVAILABLE['not-shared'] }
  const site = estateOf(home).site
  if (!site) return { reason: 'unplaced', message: UNAVAILABLE.unplaced }
  const closed = doorsClosed(world)
  if (closed) return { reason: 'no-live-position', message: closed }
  const status = anchorStatus(world, site.districtId, site.parcel)
  return status === 'valid' ? null : { reason: status, message: runtime(world).problem || UNAVAILABLE[status] }
}

/** Why `viewer` could not go in at this moment, or null. The same check `home.approach` reports and `home.enter` makes. */
function doorRefusal(world: World, state: PhysicalState, home: BuiltHome, site: SiteRecord, viewer: MemberId): string | null {
  const stay = state.stays?.[viewer]
  if (stay && stay.homeId !== home.id) return 'You are inside another home. Leave it by its door first.'
  const carried = held(world, viewer)
  if (carried) return carried
  // The travel rule, asked here and not left to `home.approach`: a character merely looking at a
  // street it has not arrived in (the one preview travel allows) is in the room, and is not let in.
  const away = streetAdmission(world, viewer, streetRef(site.districtId))
  if (away) return away
  const place = placeOf(world, viewer)
  if (!place || place.ref.kind !== 'district' || place.ref.districtId !== site.districtId) return 'Walk to the front door first.'
  const door = site.parcel.door
  if (distance(place.pos, door) > HOME_PHYSICAL.doorRange + SLACK) return 'Walk up to the front door.'
  if ((place.pos.x - door.x) * Math.sin(site.parcel.facing) + (place.pos.z - door.z) * Math.cos(site.parcel.facing) < HOME_PHYSICAL.publicSide - SLACK) return 'The front door is on the street side of the house.'
  if (streetOf(world, state, site.districtId).solids.some(solid => toSolid(solid, place.pos) < HOME_PHYSICAL.clearRadius - SLACK)) return 'Stand clear of the wall, in front of the door.'
  return null
}

/** How `viewer` goes to this home. service/homes.ts has decided they may visit, and whether they are told where it stands. */
export function approachFor(world: World, state: PhysicalState, home: BuiltHome, viewer: MemberId, showSite: boolean): HomeApproach {
  const gone = unavailable(world, home, showSite)
  if (gone) return { kind: 'unavailable', homeId: home.id, reason: gone.reason, message: gone.message }
  const estate = estateOf(home), site = estate.site!
  // The travel rules as they are: only a character they let into that district walks there.
  const away = streetAdmission(world, viewer, streetRef(site.districtId))
  if (away) return { kind: 'travel', homeId: home.id, to: site.area, message: away }
  const refusal = doorRefusal(world, state, home, site, viewer)
  return { kind: 'walk', homeId: home.id, site: siteView(world, site), inside: insideOf(planOf(home, estate)), enter: { allowed: refusal === null, reason: refusal ?? '' } }
}

// ── Stays ─────────────────────────────────────────────────────────────────────────────────────

const stayView = (stay: StayRecord): HomeStay => ({ homeId: stay.homeId, buildingId: stay.buildingId, districtId: stay.districtId, since: stay.since, state: stay.state })

/**
 * The member's open stay, brought up to date with travel: a character that has been moved (a trip
 * booked, or no longer allowed in that district) is no longer inside, and has no door to come out of.
 */
function stayOf(world: World, state: PhysicalState, memberId: MemberId): { stay: StayRecord | null; moved: string } {
  const stay = state.stays?.[memberId]
  if (!stay) return { stay: null, moved: '' }
  const moved = streetAdmission(world, memberId, streetRef(stay.districtId))
  if (!moved) return { stay, moved: '' }
  delete state.stays![memberId]
  world.touch()
  return { stay: null, moved }
}
function holders(world: World): Set<string> {
  const rt = runtime(world)
  return rt.exitHolders ??= new Set(Object.keys(world.peek<PhysicalState>('homes')?.exits ?? {}))
}
function keepExit(world: World, state: PhysicalState, memberId: MemberId, exit: ExitRecord): void {
  ;(state.exits ??= {})[memberId] = exit
  holders(world).add(memberId)
  world.touch()
}
function dropExit(world: World, state: PhysicalState, memberId: MemberId): void {
  holders(world).delete(memberId)
  if (!state.exits?.[memberId]) return
  delete state.exits[memberId]
  world.touch()
}
function exitOf(world: World, state: PhysicalState, memberId: MemberId): ExitRecord | null {
  const exit = state.exits?.[memberId]
  if (!exit) return null
  if (!streetAdmission(world, memberId, streetRef(exit.districtId))) return exit
  // The character is no longer allowed in that street: that way back is gone for good.
  dropExit(world, state, memberId)
  return null
}

/** How far from where the service put them a member may be and still count as not having moved. */
const AT_EXIT = 0.05
/**
 * A member's own accepted step, or entry, has put them somewhere. Once that is anywhere but the
 * spot their last `home.leave` put them, that exit is no longer a place to return to: it is for a
 * reload straight after leaving, not a way back to the door from wherever they walked.
 */
export function stoodAt(world: World, memberId: MemberId, place: { ref: RoomRef; instance: number }, pos: Vec2): void {
  if (!holders(world).has(memberId)) return
  const state = physicalState(world), exit = state.exits?.[memberId]
  if (exit && place.ref.kind === 'district' && place.ref.districtId === exit.districtId && place.instance === exit.instance && distance(pos, exit.pos) < AT_EXIT) return
  dropExit(world, state, memberId)
}

/** A trip was booked: the character has left. A stay and a last exit end there and then, so neither can come back to life when a later trip returns. */
export function departed(world: World, state: PhysicalState, memberId: MemberId): void {
  if (state.stays?.[memberId]) { delete state.stays[memberId]; world.touch() }
  dropExit(world, state, memberId)
}

export function presenceFor(world: World, state: PhysicalState, memberId: MemberId): HomePresence {
  const { stay } = stayOf(world, state, memberId)
  const exit = stay ? null : exitOf(world, state, memberId)
  return { stay: stay ? stayView(stay) : null, lastExit: exit ? { districtId: exit.districtId, pos: { ...exit.pos }, heading: exit.heading } : null }
}

/** The member came into a room they were not in. A last exit is good only for the street instance it was in. */
export function roomEntered(world: World, state: PhysicalState, memberId: MemberId, ref: RoomRef): void {
  const exit = state.exits?.[memberId]
  if (!exit) return
  if (ref.kind === 'district' && ref.districtId === exit.districtId && placeOf(world, memberId)?.instance === exit.instance) return
  dropExit(world, state, memberId)
}

/** Refuse a street room to a member whose stay is open, and a spot inside a building to anyone. The gate on `room.enter`. */
export function streetGate(world: World, memberId: MemberId, input: { ref: RoomRef; pos: Vec2 }): void {
  if (input.ref.kind !== 'district' && input.ref.kind !== 'venue') return
  // Read first without marking the slice; a stay that travel has ended is closed through the slice, so that it is saved.
  if (world.peek<PhysicalState>('homes')?.stays?.[memberId] && stayOf(world, physicalState(world), memberId).stay) throw new WorldError('conflict', 'You are inside a home. Leave by its door.')
  if (input.ref.kind !== 'district') return
  // Coming into the street: not inside a building. Already in it and asking to be elsewhere in it: not through one either.
  const here = placeOf(world, memberId)
  const from = here && here.ref.kind === 'district' && here.ref.districtId === input.ref.districtId ? here.pos : null
  if (!homeFootAllowed(world, input.ref.districtId, from, input.pos)) throw new WorldError('conflict', from ? 'That position cannot be reached: a building is in the way.' : 'That spot is inside a building. Choose a clear place.')
}

/** Visitors who may no longer be inside keep the door they came in by: their stay is marked, not dropped. */
export function showOut(world: World, state: PhysicalState, homeId: HomeId, mayStay: (memberId: MemberId) => boolean): void {
  for (const [memberId, stay] of Object.entries(state.stays ?? {})) {
    if (stay.homeId !== homeId || stay.state !== 'inside' || mayStay(memberId as MemberId)) continue
    stay.state = 'shown-out'
    world.touch()
  }
}

interface Arrived { inside: { roomId: string; pos: Vec2; heading: number }; snapshot: RoomSnapshot; history: ChatMessage[]; stay: HomeStay }
/** One house is one room: everyone inside is together. */
const HOME_INSTANCE = 1
/** Places just inside the front door, nearest first: [metres along the wall, metres further in]. */
const INSIDE_SPOTS: [number, number][] = [[0, 0], [-0.8, 0], [0.8, 0], [0, 0.8], [-0.8, 0.8], [0.8, 0.8], [-1.6, 0], [1.6, 0], [0, 1.6], [-1.6, 0.8], [1.6, 0.8], [-0.8, 1.6], [0.8, 1.6]]
/** Two characters are not stood closer than this, and none closer than half of it to a wall, metres. */
const INSIDE_APART = 0.7
/**
 * Stand a member inside: just within the front door, at the first spot that is in the entrance
 * room, clear of furniture that is in the way and of everyone already there. No furniture is
 * moved for it. A member already standing in the room is left where they are.
 */
function standInside(world: World, home: BuiltHome, memberId: MemberId, stay: StayRecord): Arrived {
  const ref: RoomRef = { kind: 'home', homeId: home.id }, key = roomKey(ref)
  const plan = planOf(home), door = insideOf(plan)
  const current = placeOf(world, memberId)
  if (current && current.key === key) {
    const entered = admitTo(world, memberId, ref, current.instance, current.pos, current.heading)
    return { inside: { roomId: roomAt(plan.rooms, current.pos)?.id ?? door.roomId, pos: { ...current.pos }, heading: current.heading }, snapshot: entered.snapshot, history: entered.history, stay: stayView(stay) }
  }
  if (spaceIn(world, ref, HOME_INSTANCE) < 1) throw new WorldError('conflict', 'This home is full. Try again when someone has left.')
  const others = standingIn(world, key, HOME_INSTANCE)
  const room = plan.rooms.find(entry => entry.id === door.roomId)
  // Into the room is the way the character faces on arriving; along the wall is across that.
  const inward = { x: Math.sin(door.heading), z: Math.cos(door.heading) }, across = { x: Math.cos(door.heading), z: -Math.sin(door.heading) }
  const pos = INSIDE_SPOTS.map(([side, deeper]) => ({ x: door.pos.x + across.x * side + inward.x * deeper, z: door.pos.z + across.z * side + inward.z * deeper })).find(spot =>
    room !== undefined && spot.x >= room.x + INSIDE_APART / 2 && spot.x <= room.x + room.width - INSIDE_APART / 2 && spot.z >= room.z + INSIDE_APART / 2 && spot.z <= room.z + room.depth - INSIDE_APART / 2
    && !furnitureInTheWay(home, spot) && !others.some(other => distance(other.pos, spot) < INSIDE_APART))
  if (!pos) throw new WorldError('conflict', 'There is no clear place to stand just inside the door: furniture or people are in the way. Try again in a moment.')
  // Admitted by the service at a place it chose from the plan: the request names no position.
  const entered = admitTo(world, memberId, ref, HOME_INSTANCE, pos, door.heading)
  return { inside: { roomId: door.roomId, pos, heading: door.heading }, snapshot: entered.snapshot, history: entered.history, stay: stayView(stay) }
}

/** Go in by the front door. service/homes.ts has decided the caller may visit and is told where the home stands. */
export function enterHome(world: World, state: PhysicalState, home: BuiltHome, viewer: MemberId, showSite: boolean, now: number): Arrived {
  const gone = unavailable(world, home, showSite)
  if (gone) throw new WorldError('unavailable', gone.message)
  const open = stayOf(world, state, viewer).stay
  // Asked again after a lost answer, or after a reload: the character never left.
  if (open && open.homeId === home.id) {
    if (open.state !== 'inside') throw new WorldError('forbidden', 'You were shown out of this home. Leave by its door.')
    const carried = held(world, viewer)
    if (carried) throw new WorldError('conflict', carried)
    // The stay this answer reports may still be on its way to the disk. Marking a change makes the
    // answer wait for a save that holds it (kernel: durable acks), as a repeated purchase does.
    world.touch()
    return standInside(world, home, viewer, open)
  }
  const site = estateOf(home).site!
  const refusal = doorRefusal(world, state, home, site, viewer)
  if (refusal) throw new WorldError('conflict', refusal)
  const from = placeOf(world, viewer)!
  const stay: StayRecord = {
    homeId: home.id, buildingId: site.buildingId, districtId: site.districtId, since: iso(now), state: 'inside', instance: from.instance,
    anchor: structuredClone(site.parcel),
  }
  const arrived = standInside(world, home, viewer, stay)
  ;(state.stays ??= {})[viewer] = stay
  dropExit(world, state, viewer)
  world.touch()
  return arrived
}

/** Back inside after a reload or a lost connection. `mayVisit` is asked again: a visitor shut out meanwhile keeps only the way out. */
export function resumeHome(world: World, state: PhysicalState, viewer: MemberId, mayVisit: (home: PlacedHome) => boolean): { home: PlacedHome; arrived: Arrived } {
  const closed = doorsClosed(world)
  if (closed) throw new WorldError('unavailable', closed)
  const { stay, moved } = stayOf(world, state, viewer)
  if (!stay) throw new WorldError('conflict', moved ? `You are no longer inside a home. ${moved}` : 'You are not inside a home.')
  const home = state.homes[stay.homeId]
  if (!home) throw new WorldError('conflict', 'That home is no longer there. Leave by its door.')
  if (stay.state === 'inside' && !mayVisit(home)) { stay.state = 'shown-out'; world.touch() }
  if (stay.state !== 'inside') throw new WorldError('forbidden', 'This home is no longer open to you. Leave by its door.')
  if (anchorStatus(world, stay.districtId, stay.anchor) !== 'valid') throw new WorldError('unavailable', runtime(world).problem || UNAVAILABLE['source-stale'])
  const carried = held(world, viewer)
  if (carried) throw new WorldError('conflict', carried)
  // As for a repeated `home.enter`: the answer waits for a save that holds the stay it reports.
  world.touch()
  return { home, arrived: standInside(world, home, viewer, stay) }
}

/** Put a member in the street instance they came from, at the first way out that is clear. */
function standOutside(world: World, state: PhysicalState, memberId: MemberId, from: { districtId: DistrictId; instance: number; anchor: HomeParcelAnchor }, first: Vec2[], now: number): HomeLeft {
  const carried = held(world, memberId)
  if (carried) throw new WorldError('conflict', carried)
  if (anchorStatus(world, from.districtId, from.anchor) !== 'valid') throw new WorldError('unavailable', runtime(world).problem || 'The street outside this door has been redrawn, so the way out cannot be vouched for just now.')
  const ref = streetRef(from.districtId), key = roomKey(ref)
  const others = standingIn(world, key, from.instance).filter(entry => entry.memberId !== memberId)
  // Room in that exact instance, counting what the rooms module holds back for others. A member already in it needs none. Never another instance instead.
  const there = placeOf(world, memberId)
  const already = there !== null && there.key === key && there.instance === from.instance
  if (!already && spaceIn(world, ref, from.instance) < 1) throw new WorldError('conflict', 'The street outside is full. Try again in a moment.')
  const vehicles = runtime(world).vehicles, solids = streetOf(world, state, from.districtId).solids
  const points = [...first, from.anchor.exit, ...from.anchor.alternates].filter((point, index, all) => all.findIndex(other => other.x === point.x && other.z === point.z) === index)
  const pos = points.find(point =>
    !others.some(other => distance(other.pos, point) < HOME_PHYSICAL.occupiedRadius)
    && !solids.some(solid => toSolid(solid, point) < HOME_PHYSICAL.clearRadius - SLACK)
    && !vehicles?.blocked(from.districtId, from.instance, point, HOME_PHYSICAL.clearRadius))
  if (!pos) throw new WorldError('conflict', 'The way out is blocked. Try again in a moment.')
  // Saved before the member is moved, so the rooms module's own listeners see where they are meant to be.
  const exit: ExitRecord = { districtId: from.districtId, instance: from.instance, pos: { x: pos.x, z: pos.z }, heading: from.anchor.facing, anchor: from.anchor, at: iso(now) }
  if (state.stays?.[memberId]) delete state.stays[memberId]
  keepExit(world, state, memberId, exit)
  const entered = admitTo(world, memberId, ref, from.instance, exit.pos, exit.heading)
  return { exit: { districtId: exit.districtId, pos: { ...exit.pos }, heading: exit.heading }, snapshot: entered.snapshot, history: entered.history }
}

/** Is the member standing, in the street instance of their last exit, where the service put them? */
function atLastExit(world: World, memberId: MemberId, exit: ExitRecord): boolean {
  const place = placeOf(world, memberId)
  return Boolean(place && place.ref.kind === 'district' && place.ref.districtId === exit.districtId && place.instance === exit.instance && distance(place.pos, exit.pos) < AT_EXIT)
}

/** Back to the last exit, for a member in no room. Nothing in the request is used, and everything is checked again. */
export function returnHome(world: World, state: PhysicalState, memberId: MemberId, now: number): HomeLeft {
  const closed = doorsClosed(world)
  if (closed) throw new WorldError('unavailable', closed)
  if (stayOf(world, state, memberId).stay) throw new WorldError('conflict', 'You are inside a home. Leave by its door.')
  const known = state.exits?.[memberId]
  const exit = exitOf(world, state, memberId)
  if (!exit) {
    if (known) throw new WorldError('forbidden', `You have travelled since you left that home. ${streetAdmission(world, memberId, streetRef(known.districtId)) ?? ''}`.trim())
    throw new WorldError('conflict', 'There is no door to go back to. Enter the street where you are.')
  }
  const place = placeOf(world, memberId)
  if (place && !atLastExit(world, memberId, exit)) throw new WorldError('conflict', 'You are already out in the world. Walk from where you are.')
  return standOutside(world, state, memberId, exit, [exit.pos], now)
}

/** Out by the door the member went in by. Asked again after a lost answer, it answers again without moving anyone. */
export function leaveHome(world: World, state: PhysicalState, memberId: MemberId, now: number): HomeLeft {
  const closed = doorsClosed(world)
  if (closed) throw new WorldError('unavailable', closed)
  const { stay, moved } = stayOf(world, state, memberId)
  if (moved) throw new WorldError('forbidden', `You are no longer inside that home. ${moved}`)
  if (stay) return standOutside(world, state, memberId, stay, [], now)
  const exit = exitOf(world, state, memberId)
  // The first answer was lost: the member is where it put them, or in no room at all.
  if (exit && (atLastExit(world, memberId, exit) || !placeOf(world, memberId))) return standOutside(world, state, memberId, exit, [exit.pos], now)
  throw new WorldError('conflict', 'You are not inside a home.')
}
