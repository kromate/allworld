import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { pointInPolygon } from './nav.ts'
import type { Vec2 } from '../shared/geo.ts'
import type { HomeExteriorScenery } from '../shared/homes.ts'
import type { Building } from '../geo/district.ts'

export function exteriorCameraBuildings(spec: HomeExteriorScenery): Building[] {
  return spec.footprints.map(footprint => {
    const { pos, angle, width, depth } = footprint
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const corner = (x: number, z: number): Vec2 => ({ x: pos.x + x * cos + z * sin, z: pos.z - x * sin + z * cos })
    return { outer: [corner(-width / 2, -depth / 2), corner(width / 2, -depth / 2), corner(width / 2, depth / 2), corner(-width / 2, depth / 2)], holes: [], base: 0, height: footprint.height + (spec.exterior.style === 'bungalow' || spec.exterior.style === 'house' ? 1.77 : 0.95), seed: 0 }
  })
}

/** Original architecture follows approved shell solids and the approved front door exactly. */
export function buildHomeExterior(spec: HomeExteriorScenery): { root: THREE.Group; dispose(): void } {
  const root = new THREE.Group()
  root.name = 'generated-allworld-home'
  root.userData.buildingId = spec.buildingId
  root.userData.scenery = 'Original fictional Allworld house; no claim of real property ownership'
  const base = spec.footprints[0]?.pos ?? spec.frontDoor.pos
  root.position.set(base.x, 0.13, base.z)
  const geometries: THREE.BufferGeometry[] = []
  const materials = [
    new THREE.MeshStandardMaterial({ color: spec.exterior.wall, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: '#f3ece0', roughness: 0.85 }),
    new THREE.MeshStandardMaterial({ color: spec.exterior.roof, roughness: 0.87 }),
    new THREE.MeshStandardMaterial({ color: '#294958', roughness: 0.28, metalness: 0.08 }),
    new THREE.MeshStandardMaterial({ color: '#754c31', roughness: 0.79 }),
    new THREE.MeshStandardMaterial({ color: '#d4b261', roughness: 0.4, metalness: 0.65 }),
  ]
  const mesh = (geometry: THREE.BufferGeometry, material: number, pos: Vec2, y: number, angle = 0): THREE.Mesh => {
    geometries.push(geometry)
    const object = new THREE.Mesh(geometry, materials[material])
    object.position.set(pos.x - base.x, y, pos.z - base.z)
    object.rotation.y = angle
    root.add(object)
    return object
  }
  const box = (width: number, height: number, depth: number, material: number, pos: Vec2, y: number, angle = 0): THREE.Mesh => mesh(new THREE.BoxGeometry(width, height, depth), material, pos, y, angle)
  const solids = exteriorCameraBuildings(spec)
  const gable = spec.exterior.style === 'bungalow' || spec.exterior.style === 'house'
  for (const [index, footprint] of spec.footprints.entries()) {
    const { width, depth, angle, pos } = footprint
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const point = (x: number, z: number): Vec2 => ({ x: pos.x + x * cos + z * sin, z: pos.z - x * sin + z * cos })
    const height = footprint.height
    box(width, height - 0.24, depth, 0, pos, (height + 0.24) / 2, angle)
    box(width, 0.24, depth, 1, pos, 0.12, angle)
    box(width + 0.12, 0.24, depth + 0.12, 1, pos, 0.4, angle)
    if (gable) {
      const rise = Math.min(1.4, Math.min(width, depth) * 0.3)
      const shape = new THREE.Shape()
      shape.moveTo(-width / 2 - 0.2, 0); shape.lineTo(0, rise); shape.lineTo(width / 2 + 0.2, 0); shape.closePath()
      mesh(new THREE.ExtrudeGeometry(shape, { depth: depth + 0.4, bevelEnabled: false }), 2, point(0, -depth / 2 - 0.2), height + 0.24, angle)
      if (spec.exterior.style === 'house') box(0.18, 0.14, depth + 0.32, 1, pos, height + rise + 0.27, angle)
    } else {
      box(width + 0.32, 0.25, depth + 0.32, 2, pos, height + 0.37, angle)
      if (spec.exterior.style === 'villa') {
        for (const side of [-1, 1]) box(width + 0.16, 0.5, 0.15, 1, point(0, side * depth / 2), height + 0.7, angle)
        for (const side of [-1, 1]) box(0.15, 0.5, depth + 0.16, 1, point(side * width / 2, 0), height + 0.7, angle)
      }
    }
    // Hide windows on shared walls. A compound house keeps its actual L-shaped open ground.
    for (const side of [0, 1, 2, 3]) {
      const horizontal = side % 2 === 0, sign = side < 2 ? 1 : -1
      const length = horizontal ? width : depth
      if (length < 2) continue
      const count = Math.max(1, Math.floor((length - 1) / 2.8))
      for (let window = 0; window < count; window++) {
        const along = (window + 1) * length / (count + 1) - length / 2
        const x = horizontal ? along : sign * (width / 2 + 0.05)
        const z = horizontal ? sign * (depth / 2 + 0.05) : along
        const center = point(x, z)
        const outside = point(x + (horizontal ? 0 : sign * 0.2), z + (horizontal ? sign * 0.2 : 0))
        if (solids.some((solid, other) => other !== index && pointInPolygon(outside, solid))) continue
        if (Math.hypot(center.x - spec.frontDoor.pos.x, center.z - spec.frontDoor.pos.z) < 1.5) continue
        const yaw = angle + (horizontal ? 0 : Math.PI / 2)
        box(1.35, 1.5, 0.12, 1, center, 1.72, yaw)
        box(1.12, 1.22, 0.16, 3, center, 1.72, yaw)
        box(0.065, 1.26, 0.18, 1, center, 1.72, yaw)
      }
    }
  }
  const { pos: door, facing } = spec.frontDoor
  const cos = Math.cos(facing), sin = Math.sin(facing)
  const doorPoint = (x: number, z: number): Vec2 => ({ x: door.x + x * cos + z * sin, z: door.z - x * sin + z * cos })
  box(1.45, 2.58, 0.15, 1, doorPoint(0, 0.045), 1.49, facing)
  box(1.13, 2.34, 0.18, 4, doorPoint(0, 0.075), 1.41, facing)
  box(0.12, 0.12, 0.16, 5, doorPoint(0.39, 0.16), 1.35, facing)
  box(1.7, 0.12, 0.2, 1, doorPoint(0, 0.105), 0.3, facing)
  box(0.2, 0.28, 0.22, 5, doorPoint(1.04, 0.075), 2.46, facing)
  box(spec.exterior.style === 'villa' ? 3.6 : 2.4, 0.16, 0.65, 2, doorPoint(0, -0.2), 2.94, facing)
  root.userData.frontDoor = { x: door.x, z: door.z, facing }
  const merged: THREE.BufferGeometry[] = []
  for (const material of materials) {
    const parts: THREE.BufferGeometry[] = []
    for (const child of [...root.children]) {
      if (!(child instanceof THREE.Mesh) || child.material !== material) continue
      child.updateMatrix()
      const geometry = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()
      geometry.applyMatrix4(child.matrix); parts.push(geometry); root.remove(child)
    }
    const geometry = mergeGeometries(parts, false)
    for (const part of parts) part.dispose()
    if (!geometry) continue
    merged.push(geometry)
    const object = new THREE.Mesh(geometry, material)
    object.castShadow = object.receiveShadow = true
    root.add(object)
  }
  for (const geometry of geometries) geometry.dispose()
  return { root, dispose() { root.removeFromParent(); for (const geometry of merged) geometry.dispose(); for (const material of materials) material.dispose() } }
}
