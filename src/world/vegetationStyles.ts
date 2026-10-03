import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { VegetationFamily } from './facadeStyles.ts'

export interface VegetationGeometrySet {
  broadTrunk: THREE.BufferGeometry
  broadCrown: THREE.BufferGeometry
  palmTrunk: THREE.BufferGeometry
  palmCrown: THREE.BufferGeometry
  broadColour: string
  palmColour: string
  palmRate: number
  dispose(): void
}

function merged(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts, false)
  parts.forEach(part => part.dispose())
  if (!geometry) throw new Error(`Could not create ${label}`)
  geometry.computeVertexNormals()
  return geometry
}

function broadTrunkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.CylinderGeometry(0.1, 0.23, 3.6, 8).translate(0, 1.8, 0)]
  for (let index = 0; index < 7; index++) {
    const angle = index * 2.399963 + 0.45
    const direction = new THREE.Vector3(Math.sin(angle) * (0.72 + index % 2 * 0.25), 0.9 + index % 3 * 0.16, Math.cos(angle) * (0.72 + index % 2 * 0.25))
    const branch = new THREE.CylinderGeometry(0.025, 0.065, direction.length(), 5)
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()))
    branch.translate(direction.x * 0.5, 2.45 + direction.y * 0.5, direction.z * 0.5)
    parts.push(branch)
  }
  return merged(parts, 'broad tree trunk')
}

function branchCard(width: number, height: number): THREE.PlaneGeometry {
  const card = new THREE.PlaneGeometry(width, height)
  const uv = card.getAttribute('uv')
  const u0 = 292 / 512, u1 = 425 / 512, v0 = 1 - 338 / 512, v1 = 1 - 22 / 512
  for (let vertex = 0; vertex < uv.count; vertex++) uv.setXY(vertex, u0 + uv.getX(vertex) * (u1 - u0), v0 + uv.getY(vertex) * (v1 - v0))
  return card
}

function broadCrownGeometry(family: VegetationFamily): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const temperate = family === 'temperate'
  for (let index = 0; index < 20; index++) {
    const level = index < 8 ? 0 : index < 15 ? 1 : 2
    const angle = index * 2.399963
    const reach = (temperate ? 0.58 : 0.76) * (1 - level * 0.22)
    const height = (temperate ? 1.42 : 1.58) * (1 - level * 0.07)
    const card = branchCard(height * 0.39, height)
    card.rotateZ((index % 2 ? 1 : -1) * (0.22 + level * 0.035))
    card.rotateX((index % 3 - 1) * 0.18)
    card.rotateY(angle + (index % 2) * Math.PI * 0.42)
    card.translate(Math.sin(angle) * reach, (temperate ? 3.55 : 3.42) + level * 0.48 + index % 3 * 0.08, Math.cos(angle) * reach)
    parts.push(card)
  }
  return merged(parts, 'textured broad tree crown')
}

function palmTrunkGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  for (let index = 0; index < 4; index++) {
    const y = index * 1.3
    const radius = 0.2 - index * 0.025
    const section = new THREE.CylinderGeometry(radius - 0.018, radius, 1.38, 8)
    section.rotateZ(index * 0.012)
    section.translate(index * 0.035, y + 0.69, 0)
    parts.push(section)
  }
  return merged(parts, 'palm trunk')
}

function palmCrownGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const pushTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    positions.push(...a.toArray(), ...b.toArray(), ...c.toArray())
  }
  for (let frond = 0; frond < 8; frond++) {
    const angle = frond / 8 * Math.PI * 2
    const length = frond % 2 ? 2.45 : 2.75
    const side = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
    const center = (at: number): THREE.Vector3 => new THREE.Vector3(
      Math.sin(angle) * length * at,
      5.18 + Math.sin(at * Math.PI) * 0.34 - at * at * 0.86,
      Math.cos(angle) * length * at,
    )
    for (let segment = 0; segment < 3; segment++) {
      const from = segment / 3, to = (segment + 1) / 3
      const widthFrom = 0.055 * (1 - from * 0.62), widthTo = 0.055 * (1 - to * 0.62)
      const a = center(from), b = center(to)
      const al = a.clone().addScaledVector(side, widthFrom), ar = a.clone().addScaledVector(side, -widthFrom)
      const bl = b.clone().addScaledVector(side, widthTo), br = b.clone().addScaledVector(side, -widthTo)
      positions.push(...al.toArray(), ...ar.toArray(), ...br.toArray(), ...al.toArray(), ...br.toArray(), ...bl.toArray())
    }
    for (const at of [0.34, 0.64]) {
      const base = center(at)
      const ahead = center(Math.min(1, at + 0.08)).sub(base).normalize()
      const leafletLength = (0.72 - at * 0.38) * (frond % 2 ? 0.94 : 1.06)
      for (const direction of [-1, 1]) {
        const rootA = base.clone().addScaledVector(ahead, -0.07).addScaledVector(side, direction * 0.025)
        const rootB = base.clone().addScaledVector(ahead, 0.08).addScaledVector(side, direction * 0.018)
        const tip = base.clone().addScaledVector(side, direction * leafletLength).addScaledVector(ahead, -0.14)
        tip.y -= 0.1 + at * 0.12
        pushTriangle(rootA, rootB, tip)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

export function createVegetationGeometrySet(family: VegetationFamily): VegetationGeometrySet {
  const broadTrunk = broadTrunkGeometry()
  const broadCrown = broadCrownGeometry(family)
  const palmTrunk = palmTrunkGeometry()
  const palmCrown = palmCrownGeometry()
  const tropical = family === 'tropical'
  return {
    broadTrunk,
    broadCrown,
    palmTrunk,
    palmCrown,
    broadColour: tropical ? '#48743f' : family === 'temperate' ? '#597849' : '#557948',
    palmColour: '#3f7a42',
    palmRate: tropical ? 0.24 : 0,
    dispose() { broadTrunk.dispose(); broadCrown.dispose(); palmTrunk.dispose(); palmCrown.dispose() },
  }
}
