// Collects primitive shapes into one merged geometry per material, and remembers the boxes of the
// solid ones so a check can test that nobody's legs are inside a seat back. Every piece is placed
// in the vehicle's frame (see types.ts): +Z forward, +X left, +Y up.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type MaterialKey = 'paint' | 'trim' | 'glass' | 'rubber' | 'metal' | 'fabric' | 'plastic' | 'canvas' | 'lampHead' | 'lampTail' | 'plate' | 'floor'
export const MATERIAL_KEYS: readonly MaterialKey[] = ['paint', 'trim', 'glass', 'rubber', 'metal', 'fabric', 'plastic', 'canvas', 'lampHead', 'lampTail', 'plate', 'floor']

export interface Obstacle { tag: string; box: THREE.Box3 }
export interface PieceOptions {
  /** Left out of the far silhouette. Small details only. Default: kept. */
  near?: boolean
  /** Names a solid thing a seated person must not overlap. `own:seat:<id>` belongs to that seat. */
  solid?: string
  /** Euler rotation in radians, applied about the geometry's own origin before it is placed. */
  rot?: readonly [number, number, number]
}
type Triple = readonly [number, number, number]

const euler = new THREE.Euler()
const matrix = new THREE.Matrix4()

/** A flat, attribute-light copy: position and normal only, so every shape merges with every other. */
function plain(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone()
  for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name)
  geometry.clearGroups()
  return geometry
}

export class Pieces {
  private readonly all = new Map<MaterialKey, THREE.BufferGeometry[]>()
  private readonly far = new Map<MaterialKey, THREE.BufferGeometry[]>()
  readonly obstacles: Obstacle[] = []

  /** Places a geometry that is already in its final frame. The builder keeps a copy. */
  add(material: MaterialKey, source: THREE.BufferGeometry, at: Triple = [0, 0, 0], options: PieceOptions = {}): void {
    const geometry = plain(source)
    source.dispose()
    if (options.rot) geometry.applyMatrix4(matrix.makeRotationFromEuler(euler.set(options.rot[0], options.rot[1], options.rot[2])))
    geometry.translate(at[0], at[1], at[2])
    if (options.solid) {
      geometry.computeBoundingBox()
      this.obstacles.push({ tag: options.solid, box: geometry.boundingBox!.clone() })
    }
    const list = this.all.get(material) ?? []
    list.push(geometry)
    this.all.set(material, list)
    if (options.near !== true) {
      const farList = this.far.get(material) ?? []
      farList.push(geometry)
      this.far.set(material, farList)
    }
  }

  box(material: MaterialKey, size: Triple, at: Triple, options: PieceOptions = {}): void {
    this.add(material, new THREE.BoxGeometry(size[0], size[1], size[2]), at, options)
  }

  /** A box with rounded edges along its depth: cushions, trim, bodywork. `radius` is kept below half of width and height. */
  soft(material: MaterialKey, size: Triple, at: Triple, radius: number, options: PieceOptions = {}): void {
    const r = Math.min(radius, Math.min(size[0], size[1]) / 2 - 0.002)
    const shape = new THREE.Shape()
    const hx = size[0] / 2 - r, hy = size[1] / 2 - r
    shape.moveTo(-hx, -hy - r); shape.lineTo(hx, -hy - r)
    shape.absarc(hx, -hy, r, -Math.PI / 2, 0, false); shape.lineTo(hx + r, hy)
    shape.absarc(hx, hy, r, 0, Math.PI / 2, false); shape.lineTo(-hx, hy + r)
    shape.absarc(-hx, hy, r, Math.PI / 2, Math.PI, false); shape.lineTo(-hx - r, -hy)
    shape.absarc(-hx, -hy, r, Math.PI, Math.PI * 1.5, false)
    // Flat faces front and back, rounded edges along the length: exactly the size asked for, so clearances can be trusted.
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: size[2], bevelEnabled: false, curveSegments: 3 })
    geometry.translate(0, 0, -size[2] / 2)
    this.add(material, geometry, at, options)
  }

  /** `axis` is the direction the cylinder's length runs. */
  cylinder(material: MaterialKey, axis: 'x' | 'y' | 'z', radiusTop: number, radiusBottom: number, length: number, segments: number, at: Triple, options: PieceOptions = {}): void {
    const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments)
    if (axis === 'x') geometry.rotateZ(-Math.PI / 2)
    else if (axis === 'z') geometry.rotateX(Math.PI / 2)
    this.add(material, geometry, at, options)
  }

  /** A thin plate from a side outline, `points` as [z, y], between world x0 and x1. */
  profileX(material: MaterialKey, points: readonly (readonly [number, number])[], x0: number, x1: number, options: PieceOptions = {}): void {
    const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)))
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(x1 - x0), bevelEnabled: false })
    geometry.rotateY(-Math.PI / 2)
    this.add(material, geometry, [Math.max(x0, x1), 0, 0], options)
  }

  /** A slab from a plan outline, `points` as [x, z], between world y0 and y1. */
  profileY(material: MaterialKey, points: readonly (readonly [number, number])[], y0: number, y1: number, options: PieceOptions = {}): void {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)))
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(y1 - y0), bevelEnabled: false })
    geometry.rotateX(-Math.PI / 2)
    this.add(material, geometry, [0, Math.min(y0, y1), 0], options)
  }

  /** A section from a front outline, `points` as [x, y], between world z0 and z1. */
  profileZ(material: MaterialKey, points: readonly (readonly [number, number])[], z0: number, z1: number, options: PieceOptions = {}): void {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: Math.abs(z1 - z0), bevelEnabled: false })
    this.add(material, geometry, [0, 0, Math.min(z0, z1)], options)
  }

  /** A flat panel standing between two ground-plane points, `from` to `to` in y, thickness across. Used for glass and skins at an angle. */
  quad(material: MaterialKey, a: Triple, b: Triple, c: Triple, d: Triple, options: PieceOptions = {}): void {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3))
    geometry.computeVertexNormals()
    this.add(material, geometry, [0, 0, 0], options)
  }

  /** One geometry per material, merged. The result is owned by the caller. */
  merged(): Map<MaterialKey, THREE.BufferGeometry> { return mergeMap(this.all) }

  /** The far silhouette: pieces not marked `near`, one geometry per material. */
  mergedFar(): Map<MaterialKey, THREE.BufferGeometry> { return mergeMap(this.far) }

  isEmpty(): boolean { return this.all.size === 0 }

  /** Frees the unmerged copies once the merged geometries exist. */
  release(): void {
    for (const list of this.all.values()) for (const geometry of list) geometry.dispose()
    this.all.clear(); this.far.clear()
  }
}

function mergeMap(source: Map<MaterialKey, THREE.BufferGeometry[]>): Map<MaterialKey, THREE.BufferGeometry> {
  const out = new Map<MaterialKey, THREE.BufferGeometry>()
  for (const [key, list] of source) {
    if (!list.length) continue
    const geometry = mergeGeometries(list, false)
    if (!geometry) throw new Error(`Vehicle model: could not merge the ${key} pieces`)
    geometry.computeBoundingSphere()
    out.set(key, geometry)
  }
  return out
}

/**
 * A side-panel outline between z0 and z1 and yBottom and yTop, with the bottom edge lifted over any
 * wheel arch it passes, including one that carries on past either end. Points are [z, y] for
 * `Pieces.profileX`.
 */
export function skinOutline(z0: number, z1: number, yBottom: number, yTop: number, arches: readonly { z: number; radius: number }[] = []): [number, number][] {
  const samples = new Set<number>([z0, z1])
  for (const arch of arches) {
    for (const z of [arch.z - arch.radius, arch.z + arch.radius]) if (z > z0 && z < z1) samples.add(z)
    for (let step = 1; step < 12; step++) {
      const z = arch.z - arch.radius + (2 * arch.radius * step) / 12
      if (z > z0 && z < z1) samples.add(z)
    }
  }
  const bottom = (z: number): number => {
    let height = yBottom
    for (const arch of arches) {
      const across = (z - arch.z) / arch.radius
      if (Math.abs(across) < 1) height = Math.max(height, yBottom + Math.sqrt(1 - across * across) * (arch.radius + 0.02))
    }
    return height
  }
  const points: [number, number][] = [...samples].sort((a, b) => a - b).map(z => [z, bottom(z)])
  points.push([z1, yTop], [z0, yTop])
  return points
}

/** Axis-aligned box of a point cloud given as centre and size. */
export function boxAt(centre: Triple, size: Triple): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2),
    new THREE.Vector3(centre[0] + size[0] / 2, centre[1] + size[1] / 2, centre[2] + size[2] / 2),
  )
}
