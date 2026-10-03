// The handful of materials every vehicle shares. One material per surface type, not per vehicle:
// a keke, a danfo and a car in the same street add no materials beyond their body colour.
import * as THREE from 'three'
import type { MaterialKey } from './builder.ts'
import type { PaintName } from './types.ts'

const PAINT: Record<PaintName, string> = {
  yellow: '#f2b61c', silver: '#b9bcc0', white: '#e6e6e1', graphite: '#44484d', blue: '#2f5a8f', maroon: '#6d2530',
}
/** The far silhouette bakes these into vertex colours, so one material draws everything but the body. */
export const BAKED: Record<Exclude<MaterialKey, 'paint'>, string> = {
  trim: '#16171a', glass: '#33414b', rubber: '#202124', metal: '#9ea3a6', fabric: '#3a3633', plastic: '#2a2c2f',
  canvas: '#1c1d20', lampHead: '#f3ecd0', lampTail: '#8e1d18', plate: '#d9d9d2', floor: '#2b2a29',
}

export interface MaterialSet {
  /** Paint materials are made on first use, one per colour. */
  paint(name: PaintName): THREE.MeshStandardMaterial
  surface(key: Exclude<MaterialKey, 'paint'>): THREE.MeshStandardMaterial
  /** Tyres and rims: colour comes from the geometry. */
  wheel: THREE.MeshStandardMaterial
  /** Far silhouette body parts other than the paint: colour comes from the geometry. */
  baked: THREE.MeshStandardMaterial
  setNight(amount: number): void
  all(): THREE.Material[]
  dispose(): void
}

export function createMaterials(): MaterialSet {
  const paints = new Map<PaintName, THREE.MeshStandardMaterial>()
  const standard = (parameters: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(parameters)
  const surfaces: Record<Exclude<MaterialKey, 'paint'>, THREE.MeshStandardMaterial> = {
    // Matte black: stripes, skirts, bumpers.
    trim: standard({ color: BAKED.trim, roughness: 0.7, metalness: 0.05 }),
    // See-through, so the people inside stay visible. No depth write: it must not hide what is behind it.
    glass: standard({ color: '#9db7c4', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide }),
    rubber: standard({ color: BAKED.rubber, roughness: 0.95, metalness: 0 }),
    metal: standard({ color: BAKED.metal, roughness: 0.38, metalness: 0.85 }),
    fabric: standard({ color: '#4a4540', roughness: 0.95, metalness: 0 }),
    plastic: standard({ color: BAKED.plastic, roughness: 0.55, metalness: 0.05 }),
    // A keke's hood is a stretched cover, not painted steel.
    canvas: standard({ color: BAKED.canvas, roughness: 0.92, metalness: 0 }),
    lampHead: standard({ color: '#f6efd2', emissive: '#ffe9a8', emissiveIntensity: 0.05, roughness: 0.2, metalness: 0.1 }),
    lampTail: standard({ color: '#a3241c', emissive: '#ff2a1c', emissiveIntensity: 0.05, roughness: 0.3, metalness: 0.05 }),
    // Plain and blank. A number plate would be an invented identity.
    plate: standard({ color: BAKED.plate, roughness: 0.6, metalness: 0.1 }),
    floor: standard({ color: BAKED.floor, roughness: 0.98, metalness: 0 }),
  }
  const wheel = standard({ vertexColors: true, roughness: 0.82, metalness: 0.15 })
  const baked = standard({ vertexColors: true, roughness: 0.6, metalness: 0.1 })
  return {
    paint(name) {
      let material = paints.get(name)
      if (!material) { material = standard({ color: PAINT[name], roughness: 0.42, metalness: 0.28 }); paints.set(name, material) }
      return material
    },
    surface: key => surfaces[key],
    wheel,
    baked,
    setNight(amount) {
      const night = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0))
      surfaces.lampHead.emissiveIntensity = 0.05 + night * 1.6
      surfaces.lampTail.emissiveIntensity = 0.05 + night * 0.9
    },
    all: () => [...paints.values(), ...Object.values(surfaces), wheel, baked],
    dispose() { for (const material of [...paints.values(), ...Object.values(surfaces), wheel, baked]) material.dispose(); paints.clear() },
  }
}
