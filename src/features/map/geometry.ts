import { districtIdOf, neighbouringDistricts as neighbouringDistrictIds, parseDistrictId, tileToLatLon } from '../../shared/geo.ts'
import type { Tile } from '../../shared/geo.ts'
import type { DistrictId } from '../../shared/ids.ts'

export type PolygonCoordinates = [number, number][][]
export interface AdjacentDistrict {
  id: DistrictId
  label: string
  coordinates: PolygonCoordinates
}

const EARTH_CIRCUMFERENCE = 40_075_016.686
const EARTH_RADIUS = EARTH_CIRCUMFERENCE / (2 * Math.PI)
const radians = (degrees: number): number => degrees * Math.PI / 180
const degrees = (radiansValue: number): number => radiansValue * 180 / Math.PI

function tileBounds(tile: Tile): { west: number; east: number; north: number; south: number } {
  const northWest = tileToLatLon(tile, 0, 0)
  const southEast = tileToLatLon(tile, 1, 1)
  return { west: northWest.lon, east: southEast.lon, north: northWest.lat, south: southEast.lat }
}

function polygon(bounds: { west: number; east: number; north: number; south: number }): PolygonCoordinates {
  return [[
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
    [bounds.west, bounds.north],
  ]]
}

function toTile(id: DistrictId): Tile | null {
  return parseDistrictId(id)
}

/** Convert scene metres (+x east, +z south) around the district tile centre to longitude/latitude. */
export function localToLngLat(districtId: DistrictId, pos: { x: number; z: number }): [number, number] {
  const tile = toTile(districtId)
  if (!tile) return [0, 0]
  const center = tileToLatLon(tile)
  const scale = Math.cos(radians(center.lat))
  const centerX = radians(center.lon) * EARTH_RADIUS
  const centerY = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + radians(center.lat) / 2))
  const x = centerX + pos.x / scale
  const y = centerY - pos.z / scale
  const lon = ((degrees(x / EARTH_RADIUS) + 540) % 360) - 180
  const lat = degrees(2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2)
  return [lon, lat]
}

/** Convert longitude/latitude into metres around the district tile centre. */
export function lngLatToLocal(districtId: DistrictId, lng: number, lat: number): { x: number; z: number } {
  const tile = toTile(districtId)
  if (!tile) return { x: 0, z: 0 }
  const center = tileToLatLon(tile)
  const scale = Math.cos(radians(center.lat))
  const centerX = radians(center.lon) * EARTH_RADIUS
  const centerY = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + radians(center.lat) / 2))
  let deltaLng = ((lng - center.lon + 540) % 360) - 180
  if (deltaLng < -180) deltaLng += 360
  const x = (radians(center.lon + deltaLng) * EARTH_RADIUS - centerX) * scale
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + radians(lat) / 2))
  return { x, z: (centerY - y) * scale }
}

/** The geographic outline of a district's exact Web Mercator tile. */
export function districtPolygon(districtId: DistrictId): PolygonCoordinates {
  const tile = toTile(districtId)
  return tile ? polygon(tileBounds(tile)) : []
}

/** Cardinal neighbors, using the same wrapping and polar clamping as shared geography. */
export function adjacentDistricts(districtId: DistrictId): AdjacentDistrict[] {
  const tile = toTile(districtId)
  const canonicalId = tile ? districtIdOf(tileToLatLon(tile)) : null
  const neighbors = canonicalId ? neighbouringDistrictIds(canonicalId) : null
  if (!tile || !neighbors) return []
  const entries = [
    ['North', neighbors.north],
    ['East', neighbors.east],
    ['South', neighbors.south],
    ['West', neighbors.west],
  ] as const
  const seen = new Set<string>([districtId])
  return entries.flatMap(([label, id]) => {
    if (seen.has(id)) return []
    seen.add(id)
    const adjacentTile = toTile(id)
    return adjacentTile ? [{ id, label: `${label} district`, coordinates: polygon(tileBounds(adjacentTile)) }] : []
  })
}

/** Resolve the zoom-14 district that contains a geographic point. */
export function destinationDistrict(lng: number, lat: number): DistrictId {
  return districtIdOf({ lon: lng, lat })
}

/** Circle on Earth's surface, sampled as a closed polygon for the city map. */
export function walkingRange(center: [number, number], km: number): PolygonCoordinates {
  const [lng, lat] = center
  const angularDistance = Math.max(0, km) * 1000 / EARTH_RADIUS
  const startLat = radians(lat)
  const startLng = radians(lng)
  const ring: [number, number][] = []
  for (let index = 0; index < 64; index++) {
    const bearing = 2 * Math.PI * index / 64
    const pointLat = Math.asin(
      Math.sin(startLat) * Math.cos(angularDistance) +
      Math.cos(startLat) * Math.sin(angularDistance) * Math.cos(bearing),
    )
    const pointLng = startLng + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(startLat),
      Math.cos(angularDistance) - Math.sin(startLat) * Math.sin(pointLat),
    )
    const normalizedLng = ((degrees(pointLng) + 540) % 360) - 180
    ring.push([normalizedLng, degrees(pointLat)])
  }
  ring.push(ring[0] ?? center)
  return [ring]
}
