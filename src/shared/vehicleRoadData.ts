import type { DistrictId, PlaceId } from './ids.ts'
import type { Vec2 } from './geo.ts'

export interface VehicleRoad {
  id: string
  kind: 'motorway' | 'major' | 'street' | 'service'
  width: number
  bridge: boolean
  points: Vec2[]
}
export interface VehicleObstacle {
  id: string
  kind: 'building' | 'water' | 'prop'
  outer: Vec2[]
  holes: Vec2[][]
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}
export interface VehicleRoadPlace {
  id: PlaceId
  name: string
  pos: Vec2
  roadPos: Vec2
  nodeId: number
}
export interface VehicleDepot {
  id: string
  pos: Vec2
  heading: number
  nodeId: number
  exits: Vec2[]
}
export interface VehicleRoadDistrict {
  id: DistrictId
  span: number
  roads: VehicleRoad[]
  obstacles: VehicleObstacle[]
  places: VehicleRoadPlace[]
  depots: VehicleDepot[]
}
export interface VehicleRoadNode { id: number; districtId: DistrictId; pos: Vec2 }
export interface VehicleRoadEdge {
  id: string
  a: number
  b: number
  length: number
  width: number
  bridge: boolean
  kind: 'road' | 'portal'
  bidirectional: true
  directionSource: 'inferred-game-two-way'
}
export interface VehicleRoadDataset {
  schemaVersion: 1
  id: string
  dataVersion: string
  mapDataVersion: string
  coordinateSystem: 'district-metres-east-south'
  source: {
    provider: string
    tileTemplate: string
    license: string
    licenseUrl: string
    attribution: string
    tiles: { districtId: DistrictId; url: string; sha256: string }[]
    sceneHash: string
    sceneSources: { path: string; sha256: string }[]
    regionPackSha256: string
  }
  districts: VehicleRoadDistrict[]
  nodes: VehicleRoadNode[]
  edges: VehicleRoadEdge[]
}

export interface VehicleRoadSceneVersion {
  mapDataVersion: string
  tileSha256: string
  sceneHash: string
  regionPackSha256: string
}

/** Keys are sorted; arrays keep their deterministic source order. No timestamp enters a hash. */
export function canonicalVehicleRoadJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalVehicleRoadJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalVehicleRoadJson(entry)}`).join(',')}}`
  throw new Error('Vehicle road data contains a non-JSON value')
}

/** This protects scene compatibility; the service still uses only its own dataset for physics. */
export function vehicleRoadCapability(dataset: VehicleRoadDataset, districtId: DistrictId, scene: VehicleRoadSceneVersion): { available: boolean; reason: string } {
  if (!dataset.districts.some(district => district.id === districtId)) return { available: false, reason: 'Vehicles are available in the supported Yaba/Lagos map districts and the Wuse starter district. Walking and Travel remain available here.' }
  const sourceTile = dataset.source.tiles.find(tile => tile.districtId === districtId)
  if (scene.mapDataVersion !== dataset.mapDataVersion || scene.tileSha256 !== sourceTile?.sha256 || scene.sceneHash !== dataset.source.sceneHash || scene.regionPackSha256 !== dataset.source.regionPackSha256) return { available: false, reason: 'The street map has changed. Reload the supported vehicle map before driving. Walking and Travel remain available.' }
  return { available: true, reason: '' }
}

/** Preserve the exact normalized map location when a vehicle crosses between tile-local scenes. */
export function vehicleDistrictPoint(pos: Vec2, from: { span: number; tileX: number; tileY: number }, to: { span: number; tileX: number; tileY: number }): Vec2 {
  return {
    x: ((pos.x / from.span) + from.tileX - to.tileX) * to.span,
    z: ((pos.z / from.span) + from.tileY - to.tileY) * to.span,
  }
}
