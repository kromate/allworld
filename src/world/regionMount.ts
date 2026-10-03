import * as THREE from 'three'
import type { District } from '../geo/district.ts'
import type { Vec2 } from '../shared/geo.ts'
import type { FootObstacleGrid } from '../shared/worldCollision.ts'
import type { StreetNavigator, NavigationFootprint } from './nav.ts'
import type { Quality } from './districtScene.ts'

export interface RegionInput { district: District; navigator: StreetNavigator; focus: Vec2; quality: Quality; countryCode: string; areaLabel: string; hour: number }
export interface RegionLayer {
  root: THREE.Group
  update?(delta: number, player: Vec2, obstacles?: FootObstacleGrid<string>): void
  peoplePositions?(): Vec2[]
  setNight?(amount: number): void
  setView?(camera: THREE.Vector3, focus: THREE.Vector3): void
  setActivity?(state: { idle: boolean; suspended: boolean }): void
  dispose(): void
  stats: { instances: number; triangles: number; textureBytes: number }
}
interface RegionModule { buildRegionLayer(input: RegionInput): Promise<RegionLayer | null> }
const modules = import.meta.glob<RegionModule>('./regions/index.ts')

/** Optional kit code has its own lifecycle; missing or failed kits never replace the street. */
export async function loadRegionLayer(input: RegionInput): Promise<RegionLayer | null> {
  const load = modules['./regions/index.ts']
  if (!load) return null
  const module = await load()
  const layer = await module.buildRegionLayer(input)
  if (layer && !(layer.root instanceof THREE.Group)) throw new Error('Region kit has no scene group')
  return layer
}

export function regionObstacles(layer: RegionLayer): NavigationFootprint[] {
  const values: unknown = layer.root.userData.regionFootprints
  if (!Array.isArray(values)) return []
  const footprints: NavigationFootprint[] = []
  for (const raw of values) {
    const value: unknown = raw
    if (!value || typeof value !== 'object' || !('pos' in value) || !('angle' in value) || !('width' in value) || !('depth' in value)) continue
    const pos = value.pos
    if (!pos || typeof pos !== 'object' || !('x' in pos) || !('z' in pos) || typeof pos.x !== 'number' || typeof pos.z !== 'number') continue
    if (typeof value.angle !== 'number' || typeof value.width !== 'number' || typeof value.depth !== 'number') continue
    const height = 'height' in value && typeof value.height === 'number' ? value.height : undefined
    if (![pos.x, pos.z, value.angle, value.width, value.depth, height ?? 1].every(Number.isFinite)) continue
    if (value.width <= 0 || value.depth <= 0) continue
    footprints.push({ pos: { x: pos.x, z: pos.z }, angle: value.angle, width: value.width, depth: value.depth, height })
  }
  return footprints
}
