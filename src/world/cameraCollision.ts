import type { Building } from '../geo/district.ts'
import { pointInPolygon } from './nav.ts'

interface Point3 { x: number; y: number; z: number }
const CELL = 24
const RADIUS = 0.28

/** A small sphere swept along the camera boom, using map footprints rather than render triangles. */
export class CameraObstacles {
  private readonly cells = new Map<string, Building[]>()

  constructor(buildings: Building[]) {
    for (const building of buildings) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (const p of building.outer) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
      }
      for (let x = Math.floor((minX - RADIUS) / CELL); x <= Math.floor((maxX + RADIUS) / CELL); x++) {
        for (let z = Math.floor((minZ - RADIUS) / CELL); z <= Math.floor((maxZ + RADIUS) / CELL); z++) {
          const key = `${x}:${z}`
          const cell = this.cells.get(key)
          if (cell) cell.push(building); else this.cells.set(key, [building])
        }
      }
    }
  }

  distance(origin: Point3, direction: Point3, wanted: number): number {
    const steps = Math.ceil(wanted / 0.16)
    for (let step = 1; step <= steps; step++) {
      const distance = wanted * step / steps
      const x = origin.x + direction.x * distance, y = origin.y + direction.y * distance, z = origin.z + direction.z * distance
      const buildings = this.cells.get(`${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`)
      if (!buildings) continue
      for (const building of buildings) {
        if (y + RADIUS < building.base || y - RADIUS > building.height + 0.35) continue
        if (pointInPolygon({ x, z }, building) || pointInPolygon({ x: x + RADIUS, z }, building)
          || pointInPolygon({ x: x - RADIUS, z }, building) || pointInPolygon({ x, z: z + RADIUS }, building)
          || pointInPolygon({ x, z: z - RADIUS }, building)) return Math.max(0.18, distance - 0.25)
      }
    }
    return wanted
  }
}
