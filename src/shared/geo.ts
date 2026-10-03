// Geography shared by the client and the world service.
//
// Four locations are kept apart on purpose:
//   current area   – coarse physical cell the member confirmed (AreaId, zoom 12)
//   browsing area  – a district the member chose to look at; asserts nothing about where they are
//   virtual position – metres inside one district scene; used for movement and proximity chat
//   virtual home   – a fictional room with a district label; unrelated to a real residence
import type { AreaId, DistrictId } from './ids.ts'

export interface LatLon { lat: number; lon: number }
export interface Tile { z: number; x: number; y: number }
/** Metres inside a district. +x is east, +z is south. Origin is the tile centre. */
export interface Vec2 { x: number; z: number }

export const AREA_ZOOM = 12
export const DISTRICT_ZOOM = 14
const EARTH_CIRCUMFERENCE = 40_075_016.686

export function tileAt(point: LatLon, z: number): Tile {
  const n = 2 ** z
  const lat = Math.max(-85.0511, Math.min(85.0511, point.lat))
  const x = Math.floor(((point.lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n)
  return { z, x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) }
}

export function tileToLatLon(tile: Tile, fx = 0.5, fy = 0.5): LatLon {
  const n = 2 ** tile.z
  const lon = ((tile.x + fx) / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + fy)) / n))) * 180) / Math.PI
  return { lat, lon }
}

/** Ground width of a tile in metres at the tile's own latitude. */
export function tileSpanMetres(tile: Tile): number {
  const { lat } = tileToLatLon(tile)
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 2 ** tile.z
}

export const areaIdOf = (point: LatLon): AreaId => {
  const t = tileAt(point, AREA_ZOOM)
  return `a:${t.z}/${t.x}/${t.y}` as AreaId
}
export const districtIdOf = (point: LatLon): DistrictId => {
  const t = tileAt(point, DISTRICT_ZOOM)
  return `d:${t.z}/${t.x}/${t.y}` as DistrictId
}

const TILE_ID = /^([ad]):(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/

function parseTileId(id: string, prefix: 'a' | 'd', zoom: number): Tile | null {
  const match = TILE_ID.exec(id)
  if (!match || match[1] !== prefix) return null
  const z = Number(match[2]), x = Number(match[3]), y = Number(match[4])
  if (z !== zoom || x >= 2 ** z || y >= 2 ** z) return null
  return { z, x, y }
}
export const parseAreaId = (id: string): Tile | null => parseTileId(id, 'a', AREA_ZOOM)
export const parseDistrictId = (id: string): Tile | null => parseTileId(id, 'd', DISTRICT_ZOOM)

/** The area a district belongs to. */
export function areaOfDistrict(id: DistrictId): AreaId | null {
  const tile = parseDistrictId(id)
  if (!tile) return null
  const shift = DISTRICT_ZOOM - AREA_ZOOM
  return `a:${AREA_ZOOM}/${tile.x >> shift}/${tile.y >> shift}` as AreaId
}

/**
 * Reduce a device reading to the centre of its coarse cell. This is the only form in which a
 * device location may leave the browser: the exact reading is never stored or sent.
 */
export function coarsen(point: LatLon): LatLon {
  return tileToLatLon(tileAt(point, AREA_ZOOM))
}

/** Areas whose cells touch `id`, including itself. Used for "nearby" without exact distance. */
export function neighbouringAreas(id: AreaId): AreaId[] {
  const tile = parseAreaId(id)
  if (!tile) return []
  const n = 2 ** tile.z
  const out: AreaId[] = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const y = tile.y + dy
    if (y < 0 || y >= n) continue
    out.push(`a:${tile.z}/${(((tile.x + dx) % n) + n) % n}/${y}` as AreaId)
  }
  return out
}

export function neighbouringDistricts(id: DistrictId): { north: DistrictId; south: DistrictId; east: DistrictId; west: DistrictId } | null {
  const tile = parseDistrictId(id)
  if (!tile) return null
  const n = 2 ** tile.z
  const at = (dx: number, dy: number) => `d:${tile.z}/${(((tile.x + dx) % n) + n) % n}/${Math.max(0, Math.min(n - 1, tile.y + dy))}` as DistrictId
  return { north: at(0, -1), south: at(0, 1), east: at(1, 0), west: at(-1, 0) }
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z)

/** Half the side of the largest district the service will accept positions for (metres). */
export const DISTRICT_HALF_SPAN_LIMIT = 1300
