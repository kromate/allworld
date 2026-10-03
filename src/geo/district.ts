// Turn one vector tile of real map data into a walkable district: streets, building footprints,
// water, green space and public places, in metres around the tile centre.
import type { DistrictId, PlaceId } from '../shared/ids.ts'
import { parseDistrictId, tileSpanMetres, tileToLatLon } from '../shared/geo.ts'
import type { LatLon, Tile, Vec2 } from '../shared/geo.ts'
import { providers } from '../config/providers.ts'
import { navigationFor } from '../world/nav.ts'
import { decodeTile, ringArea } from './mvt.ts'
import type { TileFeature, TileLayer } from './mvt.ts'

export type RoadKind = 'motorway' | 'major' | 'street' | 'service' | 'path' | 'pedestrian' | 'rail'
export interface Road { kind: RoadKind; points: Vec2[]; width: number; bridge: boolean; tunnel: boolean }
export interface StreetName { name: string; points: Vec2[]; major: boolean }
export interface Polygon { outer: Vec2[]; holes: Vec2[][] }
export interface Building extends Polygon {
  height: number; base: number; seed: number
  heightSource?: 'tile-render-height' | 'illustrative'
  kind?: string; levels?: number; roofShape?: string; roofHeight?: number; roofDirection?: number
  roofMaterial?: string; facadeMaterial?: string; facadeColor?: string
}
export type GroundKind = 'water' | 'park' | 'wood' | 'grass' | 'sand' | 'civic' | 'commercial' | 'industrial' | 'residential' | 'pitch'
export interface Ground extends Polygon { kind: GroundKind }
export interface Poi { placeId: PlaceId; name: string; category: string; subclass: string; rank: number; pos: Vec2 }
export interface PlaceLabel { name: string; kind: string; pos: Vec2 }

export type CoverageLevel = 'detailed' | 'streets-only' | 'sparse' | 'empty'
export interface Coverage {
  level: CoverageLevel
  roads: number
  namedStreets: number
  buildings: number
  places: number
  /** One honest sentence for the interface. */
  summary: string
}

export interface District {
  id: DistrictId
  tile: Tile
  /** Side length in metres. */
  span: number
  center: LatLon
  roads: Road[]
  streetNames: StreetName[]
  buildings: Building[]
  ground: Ground[]
  pois: Poi[]
  labels: PlaceLabel[]
  coverage: Coverage
  /** Dated tileset path, so evidence can name the exact data revision. */
  dataVersion: string
  attribution: string
}

export class DistrictLoadError extends Error {
  readonly kind: 'network' | 'not-found' | 'invalid'
  constructor(kind: 'network' | 'not-found' | 'invalid', message: string) {
    super(message)
    this.kind = kind
    this.name = 'DistrictLoadError'
  }
}

const ROAD_WIDTH: Record<RoadKind, number> = { motorway: 15, major: 11, street: 7.5, service: 4.5, path: 2.6, pedestrian: 6, rail: 3 }

function roadKind(tags: TileFeature['tags']): RoadKind | null {
  const cls = String(tags.class ?? '')
  const sub = String(tags.subclass ?? '')
  if (cls === 'motorway') return 'motorway'
  if (cls === 'trunk' || cls === 'primary' || cls === 'secondary') return 'major'
  if (cls === 'tertiary' || cls === 'minor' || cls === 'busway') return 'street'
  if (cls === 'service' || cls === 'track' || cls === 'raceway') return 'service'
  if (cls === 'path') {
    // Platform outlines are areas rendered as closed lines in this tileset, not routing centre-lines.
    if (sub === 'platform') return null
    return sub === 'pedestrian' || sub === 'footway' || sub === 'crossing' || sub === 'steps' ? 'pedestrian' : 'path'
  }
  if (cls === 'rail' || cls === 'transit') return 'rail'
  return null
}

const GROUND_FROM_LANDUSE: Record<string, GroundKind> = {
  residential: 'residential', suburb: 'residential', neighbourhood: 'residential', commercial: 'commercial', retail: 'commercial',
  industrial: 'industrial', railway: 'industrial', school: 'civic', university: 'civic', college: 'civic', kindergarten: 'civic',
  hospital: 'civic', library: 'civic', stadium: 'pitch', pitch: 'pitch', playground: 'park', cemetery: 'park', garages: 'industrial',
}
const GROUND_FROM_LANDCOVER: Record<string, GroundKind> = { wood: 'wood', grass: 'grass', farmland: 'grass', sand: 'sand', wetland: 'grass' }

let templatePromise: Promise<{ template: string; version: string }> | null = null

function tileTemplate(): Promise<{ template: string; version: string }> {
  templatePromise ??= (async () => {
    const versionOf = (template: string): string => /planet\/([^/]+)\//.exec(template)?.[1] ?? 'unknown'
    try {
      const response = await fetch(providers.tiles.tileJson, { signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error(`TileJSON ${response.status}`)
      const body = (await response.json()) as { tiles?: unknown }
      const template = Array.isArray(body.tiles) && typeof body.tiles[0] === 'string' ? body.tiles[0] : null
      if (!template) throw new Error('TileJSON has no tile template')
      return { template, version: versionOf(template) }
    } catch {
      return { template: providers.tiles.fallbackTemplate, version: versionOf(providers.tiles.fallbackTemplate) }
    }
  })()
  return templatePromise
}

/** Fetch the raw tile for a district. Exposed separately so checks can run without a browser. */
export async function fetchDistrictTile(tile: Tile): Promise<{ bytes: Uint8Array; version: string }> {
  const { template, version } = await tileTemplate()
  const url = template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  } catch {
    throw new DistrictLoadError('network', 'The map service did not answer. Check your connection and try again.')
  }
  if (response.status === 404 || response.status === 204) throw new DistrictLoadError('not-found', 'There is no map data for this spot.')
  if (!response.ok) throw new DistrictLoadError('network', `The map service returned an error (${response.status}).`)
  return { bytes: new Uint8Array(await response.arrayBuffer()), version }
}

function hashSeed(a: number, b: number): number {
  let h = (Math.round(a * 10) * 73856093) ^ (Math.round(b * 10) * 19349663)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return (h ^ (h >>> 15)) >>> 0
}

function describe(coverage: Omit<Coverage, 'summary' | 'level'>): Pick<Coverage, 'level' | 'summary'> {
  if (coverage.roads === 0) return { level: 'empty', summary: 'No streets are mapped here yet. You can still browse the list of nearby districts.' }
  if (coverage.roads < 12) return { level: 'sparse', summary: `Only ${coverage.roads} mapped streets here. This area is thinly mapped, so the scene is mostly open ground.` }
  if (coverage.buildings < 25) return { level: 'streets-only', summary: `${coverage.roads} mapped streets, but few building outlines. Streets are real; most buildings are missing from the map data.` }
  return { level: 'detailed', summary: `${coverage.roads} street segments, ${coverage.buildings.toLocaleString()} building outlines and ${coverage.places} public places from the map.` }
}

export function buildDistrict(id: DistrictId, bytes: Uint8Array, version: string): District {
  const tile = parseDistrictId(id)
  if (!tile) throw new DistrictLoadError('invalid', 'That district id is not valid.')
  let layers: Map<string, TileLayer>
  try { layers = decodeTile(bytes) } catch { throw new DistrictLoadError('invalid', 'The map data for this district could not be read.') }
  const span = tileSpanMetres(tile)

  const project = (layer: TileLayer) => ([x, y]: [number, number]): Vec2 => ({ x: (x / layer.extent - 0.5) * span, z: (y / layer.extent - 0.5) * span })
  const inside = (p: Vec2): boolean => Math.abs(p.x) <= span / 2 && Math.abs(p.z) <= span / 2
  const polygonsOf = (layer: TileLayer, feature: TileFeature): Polygon[] => {
    const to = project(layer)
    const out: Polygon[] = []
    for (const ring of feature.rings) {
      if (ring.length < 3) continue
      const points = ring.map(to)
      if (ringArea(ring) > 0 || out.length === 0) out.push({ outer: points, holes: [] })
      else out[out.length - 1]!.holes.push(points)
    }
    return out
  }

  const roads: Road[] = []
  const transportation = layers.get('transportation')
  if (transportation) {
    const to = project(transportation)
    for (const feature of transportation.features) {
      if (feature.type !== 2) continue
      const kind = roadKind(feature.tags)
      if (!kind) continue
      const brunnel = String(feature.tags.brunnel ?? '')
      for (const ring of feature.rings) {
        if (ring.length < 2) continue
        roads.push({ kind, points: ring.map(to), width: ROAD_WIDTH[kind], bridge: brunnel === 'bridge', tunnel: brunnel === 'tunnel' })
      }
    }
  }

  const streetNames: StreetName[] = []
  const names = layers.get('transportation_name')
  if (names) {
    const to = project(names)
    for (const feature of names.features) {
      const name = String(feature.tags['name:latin'] ?? feature.tags.name ?? '').trim()
      if (!name || feature.type !== 2) continue
      const cls = String(feature.tags.class ?? '')
      for (const ring of feature.rings) if (ring.length >= 2) streetNames.push({ name, points: ring.map(to), major: ['motorway', 'trunk', 'primary', 'secondary'].includes(cls) })
    }
  }

  const buildings: Building[] = []
  const buildingLayer = layers.get('building')
  if (buildingLayer) {
    for (const feature of buildingLayer.features) {
      if (feature.type !== 3 || feature.tags.hide_3d === true) continue
      for (const polygon of polygonsOf(buildingLayer, feature)) {
        const first = polygon.outer[0]!
        const seed = hashSeed(first.x, first.z)
        const mapped = Number(feature.tags.render_height)
        // Render heights may be provider defaults; this field does not prove a survey.
        const height = Number.isFinite(mapped) && mapped > 0 ? Math.min(mapped, 220) : 4 + (seed % 7)
        const base = Math.max(0, Math.min(Number(feature.tags.render_min_height) || 0, height - 1))
        const text = (...keys: string[]): string | undefined => {
          for (const key of keys) { const value = feature.tags[key]; if (typeof value === 'string' && value.trim()) return value.trim() }
          return undefined
        }
        const number = (...keys: string[]): number | undefined => {
          for (const key of keys) { const value = Number(feature.tags[key]); if (Number.isFinite(value) && value > 0) return value }
          return undefined
        }
        buildings.push({ ...polygon, height, base, seed, heightSource: Number.isFinite(mapped) && mapped > 0 ? 'tile-render-height' : 'illustrative',
          kind: text('class', 'subclass', 'building'), levels: number('building:levels', 'levels'),
          roofShape: text('roof:shape', 'roof_shape'), roofHeight: number('roof:height', 'roof_height'), roofDirection: (() => { const direction = Number(feature.tags['roof:direction'] ?? feature.tags.roof_direction); return Number.isFinite(direction) && direction >= 0 && direction < 360 ? direction : undefined })(),
          roofMaterial: text('roof:material', 'roof_material'), facadeMaterial: text('building:material', 'facade_material'), facadeColor: text('building:colour', 'facade_color'),
        })
      }
    }
  }

  const ground: Ground[] = []
  const pushGround = (layerName: string, kindOf: (tags: TileFeature['tags']) => GroundKind | null): void => {
    const layer = layers.get(layerName)
    if (!layer) return
    for (const feature of layer.features) {
      if (feature.type !== 3) continue
      const kind = kindOf(feature.tags)
      if (!kind) continue
      for (const polygon of polygonsOf(layer, feature)) ground.push({ ...polygon, kind })
    }
  }
  pushGround('landuse', tags => GROUND_FROM_LANDUSE[String(tags.class ?? '')] ?? null)
  pushGround('landcover', tags => GROUND_FROM_LANDCOVER[String(tags.class ?? '')] ?? null)
  pushGround('park', () => 'park')
  pushGround('water', tags => (tags.brunnel === 'tunnel' ? null : 'water'))

  const pois: Poi[] = []
  const poiLayer = layers.get('poi')
  if (poiLayer) {
    const to = project(poiLayer)
    const seen = new Set<string>()
    for (const feature of poiLayer.features) {
      const name = String(feature.tags['name:latin'] ?? feature.tags.name ?? '').trim()
      const point = feature.rings[0]?.[0]
      if (!name || !point) continue
      const pos = to(point)
      if (!inside(pos)) continue
      const placeId = (feature.id !== null ? `p${feature.id}` : `h${hashSeed(pos.x, pos.z)}`) as PlaceId
      if (seen.has(placeId)) continue
      seen.add(placeId)
      pois.push({ placeId, name, category: String(feature.tags.class ?? 'place'), subclass: String(feature.tags.subclass ?? ''), rank: Number(feature.tags.rank) || 99, pos })
    }
  }

  const labels: PlaceLabel[] = []
  const placeLayer = layers.get('place')
  if (placeLayer) {
    const to = project(placeLayer)
    for (const feature of placeLayer.features) {
      const name = String(feature.tags['name:latin'] ?? feature.tags.name ?? '').trim()
      const point = feature.rings[0]?.[0]
      if (name && point) labels.push({ name, kind: String(feature.tags.class ?? ''), pos: to(point) })
    }
  }

  const counts = { roads: roads.filter(road => road.kind !== 'rail').length, namedStreets: new Set(streetNames.map(entry => entry.name)).size, buildings: buildings.length, places: pois.length }
  return {
    id, tile, span, center: tileToLatLon(tile), roads, streetNames, buildings, ground, pois, labels,
    coverage: { ...counts, ...describe(counts) }, dataVersion: version, attribution: providers.tiles.attribution,
  }
}

async function fetchAndBuildDistrict(id: DistrictId): Promise<District> {
  const tile = parseDistrictId(id)
  if (!tile) throw new DistrictLoadError('invalid', 'That district id is not valid.')
  const { bytes, version } = await fetchDistrictTile(tile)
  if (bytes.length === 0) throw new DistrictLoadError('not-found', 'There is no map data for this spot.')
  return buildDistrict(id, bytes, version)
}

const districtCache = new Map<DistrictId, { loadedAt: number; district: Promise<District> }>()

/** Keep only the current tile and its two most recently used neighbours. */
export function loadDistrict(id: DistrictId): Promise<District> {
  const cached = districtCache.get(id)
  if (cached && Date.now() - cached.loadedAt < 600_000) {
    districtCache.delete(id); districtCache.set(id, cached)
    return cached.district
  }
  const district = fetchAndBuildDistrict(id)
  districtCache.set(id, { loadedAt: Date.now(), district })
  while (districtCache.size > 3) {
    const oldest = districtCache.keys().next().value
    if (oldest !== undefined) districtCache.delete(oldest)
  }
  void district.catch(() => { if (districtCache.get(id)?.district === district) districtCache.delete(id) })
  return district
}

// ── Public arrival point ──────────────────────────────────────────────────────────────────────

/** Categories that make a sensible public place to arrive at, best first. */
const ARRIVAL_CATEGORIES = ['railway', 'bus', 'town_hall', 'park', 'library', 'college', 'school', 'stadium', 'shop', 'grocery', 'mall', 'cafe', 'restaurant', 'fast_food', 'bank', 'post']
const ARRIVAL_WALK_METRES = 400
const ARRIVAL_CANDIDATE_LIMIT = 64

export interface Arrival { pos: Vec2; heading: number; label: string; placeId: PlaceId | null; basis: 'public-place' | 'main-street' | 'district-centre' }

const arrivalCache = new WeakMap<District, Arrival>()

function nearestOnRoads(roads: Road[], target: Vec2): { pos: Vec2; distance: number } | null {
  let best: { pos: Vec2; distance: number } | null = null
  for (const road of roads) {
    if (road.kind === 'rail' || road.kind === 'motorway' || road.tunnel) continue
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!, b = road.points[i + 1]!
      const dx = b.x - a.x, dz = b.z - a.z
      const length2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.z - a.z) * dz) / length2))
      const pos = { x: a.x + dx * t, z: a.z + dz * t }
      const d = Math.hypot(pos.x - target.x, pos.z - target.z)
      if (!best || d < best.distance) best = { pos, distance: d }
    }
  }
  return best
}

/**
 * Choose where avatars arrive in a district: beside a well-known public place when the map has
 * one, otherwise on the main street nearest the centre. The same input always gives the same
 * point, so everyone arriving in a district meets at one public spot. It is never derived from
 * a member's device position.
 */
export function chooseArrival(district: District): Arrival {
  const cached = arrivalCache.get(district)
  if (cached) return cached
  const navigator = navigationFor(district)
  const reach = district.span * 0.32
  const publicPlaces = district.pois
    .map(poi => ({ poi, street: navigator.publicStreetPoint(poi.pos) }))
    .filter((entry): entry is { poi: Poi; street: { pos: Vec2; distance: number } } => entry.street !== null)
  const candidates = publicPlaces
    .filter(entry => Math.hypot(entry.poi.pos.x, entry.poi.pos.z) <= reach)
    .map(entry => ({ ...entry, order: ARRIVAL_CATEGORIES.indexOf(entry.poi.category) }))
    .filter(entry => entry.order >= 0)
    .sort((a, b) => a.poi.rank - b.poi.rank || a.order - b.order || Math.hypot(a.poi.pos.x, a.poi.pos.z) - Math.hypot(b.poi.pos.x, b.poi.pos.z) || a.poi.name.localeCompare(b.poi.name))
    .slice(0, ARRIVAL_CANDIDATE_LIMIT)
  if (candidates.length) {
    const coverage = navigator.walkingCoverage(candidates.map(entry => entry.street.pos), publicPlaces.map(entry => entry.street.pos), ARRIVAL_WALK_METRES)
    const selected = candidates
      .map((entry, index) => ({ ...entry, coverage: coverage[index] ?? 0 }))
      .sort((a, b) => b.coverage - a.coverage || a.poi.rank - b.poi.rank || a.order - b.order || a.poi.name.localeCompare(b.poi.name))[0]!
    const arrival = {
      pos: selected.street.pos,
      heading: Math.atan2(selected.poi.pos.x - selected.street.pos.x, selected.poi.pos.z - selected.street.pos.z),
      label: selected.poi.name,
      placeId: selected.poi.placeId,
      basis: 'public-place' as const,
    }
    arrivalCache.set(district, arrival)
    return arrival
  }
  const connected = navigator.connectedStreetPoint({ x: 0, z: 0 }, true)
  const street = connected ? { pos: connected } : nearestOnRoads(district.roads, { x: 0, z: 0 })
  if (street) {
    const name = nearestStreetName(district, street.pos)
    const arrival = { pos: street.pos, heading: 0, label: name ?? 'a mapped street', placeId: null, basis: 'main-street' as const }
    arrivalCache.set(district, arrival)
    return arrival
  }
  const arrival = { pos: { x: 0, z: 0 }, heading: 0, label: 'the district centre', placeId: null, basis: 'district-centre' as const }
  arrivalCache.set(district, arrival)
  return arrival
}

export function nearestStreetName(district: District, pos: Vec2, within = 45): string | null {
  let best: { name: string; distance: number } | null = null
  for (const street of district.streetNames) {
    for (let i = 0; i < street.points.length - 1; i++) {
      const a = street.points[i]!, b = street.points[i + 1]!
      const dx = b.x - a.x, dz = b.z - a.z
      const length2 = dx * dx + dz * dz || 1
      const t = Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / length2))
      const d = Math.hypot(a.x + dx * t - pos.x, a.z + dz * t - pos.z)
      if (d <= within && (!best || d < best.distance)) best = { name: street.name, distance: d }
    }
  }
  return best?.name ?? null
}
