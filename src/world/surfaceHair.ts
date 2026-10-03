// Hair for the rigged cast: CC0 MakeHuman meshes at two detail levels for
// selected styles, plus lightweight original geometry for other styles and fallbacks.
// Coordinates are metres in a skull-centred frame: +x is the subject's right,
// +y is up, and +z is toward the face/camera. The caller positions this group at
// the skull centre in the head bone's bind pose, then supplies measured skull size.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { FACE_CROP_SPAN } from './faces.ts'
import { loadPack } from './packs.ts'

export type HairStyle =
  | 'bald' | 'low-cut' | 'fade' | 'short-afro' | 'big-afro'
  | 'braids' | 'locs' | 'twists' | 'long-straight' | 'bun' | 'head-wrap'

export type HairDetail = 'near' | 'reduced'

export interface HairFit {
  /** Ear-to-ear skull width, excluding hair, in metres. */
  width: number
  /** Chin-to-crown skull height, in metres. */
  height: number
  /** Nose-to-back skull depth, excluding the nose, in metres. */
  depth: number
}

export interface HairStyleDescriptor {
  id: HairStyle
  label: string
  /** Whether the image analyser can make even a conservative front-view suggestion. */
  imageSuggestion: boolean
}

export const HAIR_STYLES: readonly HairStyleDescriptor[] = [
  { id: 'bald', label: 'Bald', imageSuggestion: true },
  { id: 'low-cut', label: 'Low cut', imageSuggestion: true },
  { id: 'fade', label: 'Fade', imageSuggestion: false },
  { id: 'short-afro', label: 'Short afro', imageSuggestion: true },
  { id: 'big-afro', label: 'Big afro', imageSuggestion: true },
  { id: 'braids', label: 'Braids', imageSuggestion: false },
  { id: 'locs', label: 'Locs', imageSuggestion: true },
  { id: 'twists', label: 'Short twists', imageSuggestion: true },
  { id: 'long-straight', label: 'Long straight', imageSuggestion: true },
  { id: 'bun', label: 'Bun', imageSuggestion: false },
  { id: 'head-wrap', label: 'Head wrap', imageSuggestion: false },
] satisfies readonly HairStyleDescriptor[]

const DEFAULT_FIT: HairFit = { width: 0.165, height: 0.22, depth: 0.19 }
interface OwnedResources { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material> }
const owned = new WeakMap<THREE.Group, OwnedResources>()

// The original MakeHuman hair meshes are CC0. Their trimmed, tinted textures and
// mesh data live in separate packs, so a phone only downloads a selected style.
const AUTHORED_SOURCE: Partial<Record<HairStyle, string>> = {
  'short-afro': 'afro01',
  'big-afro': 'afro01',
  braids: 'braid01',
  'long-straight': 'long01',
}
interface AuthoredHair { near: THREE.BufferGeometry; reduced: THREE.BufferGeometry; texture: THREE.Texture }
const authored = new Map<string, AuthoredHair>()
const loading = new Map<string, Promise<boolean>>()

/** Load both detail levels of a selected source asset. Other styles use geometry authored here. */
export function preloadHairAsset(style: HairStyle): Promise<boolean> {
  const source = AUTHORED_SOURCE[style]
  if (!source) return Promise.resolve(false)
  if (authored.has(source)) return Promise.resolve(true)
  const current = loading.get(source)
  if (current) return current
  const task = (async () => {
    const pack = await loadPack(`/avatars/hair/${source}.pack.gz`)
    const entryBytes = (name: string): Uint8Array<ArrayBuffer> => {
      const entry = pack.entries.get(name)
      if (!entry) throw new Error(`${source} hair pack is missing ${name}`)
      const start = pack.base + entry.offset
      return pack.bytes.slice(start, start + entry.length) as Uint8Array<ArrayBuffer>
    }
    const geometry = (suffix: string): THREE.BufferGeometry => {
      const positions = new Float32Array(entryBytes(`position${suffix}.f32`).buffer)
      const uvs = new Float32Array(entryBytes(`uv${suffix}.f32`).buffer)
      const indices = new Uint16Array(entryBytes(`index${suffix}.u16`).buffer)
      if (positions.length % 3 || uvs.length / 2 !== positions.length / 3 || indices.length % 3) throw new Error(`${source} hair mesh is malformed`)
      const result = new THREE.BufferGeometry()
      result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      result.setIndex(new THREE.Uint16BufferAttribute(indices, 1))
      // Put every source mesh in the same skull-centred frame once. The geometry
      // is shared by actors; only the mesh transform varies with each measured fit.
      const points = result.getAttribute('position')
      for (let i = 0; i < points.count; i++) {
        const y = points.getY(i) - 7.3264
        points.setXYZ(i, points.getX(i), y < -1 ? -1 + (y + 1) * 0.42 : y, points.getZ(i) - 0.5701)
      }
      points.needsUpdate = true
      result.computeVertexNormals()
      return result
    }
    const near = geometry('')
    const reduced = geometry('-low')
    const bitmap = await createImageBitmap(new Blob([entryBytes('texture.png')], { type: 'image/png' }), {
      imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    })
    const texture = new THREE.Texture(bitmap)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.needsUpdate = true
    authored.set(source, { near, reduced, texture })
    return true
  })()
  loading.set(source, task)
  void task.catch(() => { loading.delete(source) })
  return task
}

function authoredGeometry(style: HairStyle): AuthoredHair | null {
  const source = AUTHORED_SOURCE[style]
  return source ? authored.get(source) ?? null : null
}

function placeAuthoredHair(group: THREE.Group, resources: OwnedResources, style: HairStyle, colour: THREE.Color, detail: HairDetail, fit: HairFit): boolean {
  const asset = authoredGeometry(style)
  if (!asset) return false
  const volume = style === 'big-afro' ? 1.3 : style === 'short-afro' ? 0.9 : 1
  const crown = style === 'big-afro' ? 1.28 : style === 'short-afro' ? 0.85 : 1
  const h = fit.height / 2
  // These source meshes contain long strands but no crown surface. Lift their
  // highest point to the measured skull crown and fill the exposed scalp below.
  const sourceTop = style === 'braids' ? 7.966 : style === 'long-straight' ? 7.9475 : 0
  const lift = sourceTop ? h - (sourceTop - 7.3264) * fit.height / 2.3352 + 0.004 : 0
  const mat = new THREE.MeshStandardMaterial({
    color: colour, map: asset.texture, roughness: 0.95, metalness: 0,
    side: THREE.DoubleSide, alphaTest: 0.4, depthWrite: true,
  })
  resources.materials.add(mat)
  const part = new THREE.Mesh(detail === 'near' ? asset.near : asset.reduced, mat)
  part.scale.set(fit.width / 1.48 * volume, fit.height / 2.3352 * crown, fit.depth / 1.9221 * volume)
  part.position.set(0, lift, 0)
  part.castShadow = true
  part.receiveShadow = true
  group.add(part)
  return true
}

function mesh(group: THREE.Group, resources: OwnedResources, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  resources.geometries.add(geometry)
  resources.materials.add(material)
  const part = new THREE.Mesh(geometry, material)
  part.castShadow = true
  part.receiveShadow = true
  group.add(part)
  return part
}

function material(resources: OwnedResources, colour: THREE.Color, darken = 1, roughness = 0.9): THREE.MeshStandardMaterial {
  const tone = colour.clone().multiplyScalar(darken)
  const result = new THREE.MeshStandardMaterial({ color: tone, roughness, metalness: 0, side: THREE.DoubleSide })
  resources.materials.add(result)
  return result
}

let clipTexture: THREE.DataTexture | null = null
function clippedHairTexture(): THREE.DataTexture {
  if (clipTexture) return clipTexture
  const size = 128
  const pixels = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = i % size, y = Math.floor(i / size)
    const random = ((x * 73856093) ^ (y * 19349663) ^ ((x * y + 1) * 83492791)) >>> 0
    const value = 174 + random % 66
    pixels.set([value, value, value, 255], i * 4)
  }
  clipTexture = new THREE.DataTexture(pixels, size, size)
  clipTexture.colorSpace = THREE.SRGBColorSpace
  clipTexture.wrapS = clipTexture.wrapT = THREE.RepeatWrapping
  clipTexture.repeat.set(4, 3)
  clipTexture.generateMipmaps = true
  clipTexture.needsUpdate = true
  return clipTexture
}

interface ShellShape {
  width: number
  depth: number
  crown: number
  baseY: number
  phiSegments: number
  thetaSegments: number
  edge: number
  frontLift: number
  irregularity?: number
}

/** One continuous shell, with a slightly broken silhouette instead of piled spheres. */
function shell(shape: ShellShape): THREE.BufferGeometry {
  const vertices: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const { phiSegments: around, thetaSegments: down } = shape
  for (let row = 0; row <= down; row++) {
    const t = row / down
    const polar = t * shape.edge
    const ring = Math.sin(polar)
    for (let col = 0; col <= around; col++) {
      const angle = (col / around) * Math.PI * 2
      const ripple = shape.irregularity ?? 0
      const variation = 1 + ripple * (0.55 * Math.sin(angle * 9 + t * 17) + 0.3 * Math.sin(angle * 17 - t * 11)) * Math.sin(Math.PI * t)
      const x = Math.cos(angle) * shape.width * ring * variation
      const z = Math.sin(angle) * shape.depth * ring * variation
      // Lift the front edge above the brow. Without this, a large style would
      // cover the eyes even though its crown silhouette looked plausible.
      const front = Math.max(0, Math.sin(angle))
      const frontLift = shape.frontLift * Math.pow(t, 4) * front * front
      const edgeDrop = t * t * (front > 0.55 ? 0 : 0.006)
      const y = shape.baseY + (shape.crown - shape.baseY) * Math.cos(polar) + frontLift - edgeDrop
      vertices.push(x, y, z)
      normals.push(x / (shape.width * shape.width), Math.max(0.1, (y - shape.baseY) / Math.max(0.001, shape.crown)), z / (shape.depth * shape.depth))
      uvs.push(col / around, t)
    }
  }
  for (let row = 0; row < down; row++) for (let col = 0; col < around; col++) {
    const a = row * (around + 1) + col
    const b = a + around + 1
    indices.push(a, b, a + 1, a + 1, b, b + 1)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** A flat frontal edge and short vertical temple corners for clipped styles. */
function lineup(width: number, depth: number, height: number): THREE.BufferGeometry {
  const xStops = [-0.88, -0.76, -0.67, -0.34, 0, 0.34, 0.67, 0.76, 0.88]
  const vertices: number[] = [], uvs: number[] = [], indices: number[] = []
  for (const [row, lift] of [0, 0.23].entries()) for (const [column, xRatio] of xStops.entries()) {
    const front = depth * Math.sqrt(1 - xRatio * xRatio)
    const temple = Math.max(0, (Math.abs(xRatio) - 0.67) / 0.21)
    vertices.push(xRatio * width, height * (0.42 - temple * 0.16 + lift), front * (row ? 0.98 : 1.065))
    uvs.push((xRatio + 1) / 2, row)
    if (row && column) {
      const n = xStops.length + column
      indices.push(n - xStops.length - 1, n - 1, n - xStops.length,
        n - xStops.length, n - 1, n)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function wrapFold(width: number, depth: number, lower: number, upper: number, phase: number, detail: HairDetail): THREE.BufferGeometry {
  const around = detail === 'near' ? 28 : 14
  const vertices: number[] = [], indices: number[] = []
  for (let row = 0; row < 2; row++) for (let i = 0; i <= around; i++) {
    const angle = i / around * Math.PI * 2
    const radius = row ? 0.94 : 1.02
    const front = Math.max(0, Math.sin(angle))
    const wave = Math.sin(angle * 2 + phase) * 0.004
    vertices.push(Math.cos(angle) * width * radius,
      (row ? upper : lower) + wave + front * 0.004,
      Math.sin(angle) * depth * radius)
    if (row && i) {
      const n = around + 1 + i
      indices.push(n - around - 2, n - 1, n - around - 1,
        n - around - 1, n - 1, n)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function strand(points: THREE.Vector3[], radius: number, detail: HairDetail): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points)
  return new THREE.TubeGeometry(curve, detail === 'near' ? 10 : 5, radius, detail === 'near' ? 5 : 4, false)
}

function locStrand(points: THREE.Vector3[], radius: number, detail: HairDetail, seed: number): THREE.BufferGeometry {
  const path = new THREE.CatmullRomCurve3(points)
  const segments = detail === 'near' ? 11 : 5
  const sides = detail === 'near' ? 5 : 4
  const geometry = new THREE.TubeGeometry(path, segments, radius, sides, false)
  const positions = geometry.getAttribute('position')
  for (let row = 0; row <= segments; row++) {
    const t = row / segments
    const centre = path.getPointAt(t)
    const taper = (1 - 0.32 * t) * (1 + 0.1 * Math.sin(t * 17 + seed))
    for (let side = 0; side <= sides; side++) {
      const i = row * (sides + 1) + side
      positions.setXYZ(i,
        centre.x + (positions.getX(i) - centre.x) * taper,
        centre.y + (positions.getY(i) - centre.y) * taper,
        centre.z + (positions.getZ(i) - centre.z) * taper)
    }
  }
  positions.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
}

function ribbon(points: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const taper = 1 - 0.55 * i / (points.length - 1)
    positions.push(p.x - width * taper, p.y, p.z, p.x + width * taper, p.y, p.z)
    if (i) { const n = i * 2; indices.push(n - 2, n - 1, n, n - 1, n + 1, n) }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** Build hair around a skull-centred local origin. All geometry and materials belong to this group. */
export function createHair(style: HairStyle, colour: string, detail: HairDetail, fit: HairFit = DEFAULT_FIT): THREE.Group {
  const group = new THREE.Group()
  group.name = `hair:${style}`
  const resources: OwnedResources = { geometries: new Set(), materials: new Set() }
  owned.set(group, resources)
  group.userData.hairReady = Promise.resolve()
  if (style === 'bald') { group.userData.hairAssetState = 'none'; return group }

  const w = fit.width / 2
  const d = fit.depth / 2
  const h = fit.height / 2
  const c = new THREE.Color(colour)
  if (placeAuthoredHair(group, resources, style, c, detail, fit)) {
    group.userData.hairAssetState = 'authored'
    return group
  }
  const base = material(resources, c)
  const light = material(resources, c, 1.12)
  const shade = material(resources, c, 0.78)
  const near = detail === 'near'
  const cap = (width: number, depth: number, crown: number, baseY: number, edge: number, frontLift: number, irregularity = 0): void => {
    mesh(group, resources, shell({ width, depth, crown, baseY, edge, frontLift, irregularity,
      phiSegments: near ? 28 : 16, thetaSegments: near ? 7 : 4 }), base)
  }

  switch (style) {
    case 'low-cut': {
      base.map = clippedHairTexture()
      cap(w * 1.025, d * 1.02, h + 0.005, h * 0.02, 1.45, h * 0.3, 0.018)
      mesh(group, resources, lineup(w, d, h), base)
      break
    }
    case 'fade': {
      base.map = clippedHairTexture()
      cap(w * 1.035, d * 1.03, h + 0.014, h * 0.19, 1.32, h * 0.18, 0.018)
      mesh(group, resources, lineup(w, d, h), base)
      // A narrow lower side band gives the clipped fade a readable profile.
      const side = shell({ width: w * 1.015, depth: d * 1.012, crown: h + 0.002, baseY: -h * 0.015,
        edge: 1.57, frontLift: h * 0.33, phiSegments: near ? 24 : 12, thetaSegments: near ? 5 : 3 })
      mesh(group, resources, side, shade)
      break
    }
    case 'short-afro':
    case 'big-afro': {
      const large = style === 'big-afro'
      cap(w * (large ? 1.62 : 1.24), d * (large ? 1.5 : 1.2), h * (large ? 1.95 : 1.34),
        h * (large ? -0.24 : -0.04), large ? 1.8 : 1.64, h * (large ? 1.04 : 0.45), large ? 0.055 : 0.043)
      break
    }
    case 'braids': {
      cap(w * 1.02, d * 1.02, h + 0.006, h * 0.05, 1.47, h * 0.31)
      const rows = near ? 9 : 5
      for (let i = 0; i < rows; i++) {
        const u = (i - (rows - 1) / 2) / ((rows - 1) / 2)
        const x = u * w * 0.83
        const lift = Math.sqrt(Math.max(0.07, 1 - (x / w) ** 2))
        const points = [
          new THREE.Vector3(x, h * 0.13, d * 0.91 * lift),
          new THREE.Vector3(x * 1.04, h * 0.82 * lift, d * 0.58),
          new THREE.Vector3(x * 1.07, h * 1.02 * lift, -d * 0.16),
          new THREE.Vector3(x * 1.08, h * 0.7 * lift, -d * 0.8),
          new THREE.Vector3(x * 1.09, h * 0.08, -d * 1.02),
        ]
        mesh(group, resources, strand(points, near ? 0.005 : 0.006, detail), i % 2 ? base : light)
      }
      break
    }
    case 'twists':
    case 'locs': {
      // Staggered roots follow the whole crown. Each lock bends away from its root,
      // rather than hanging from one circular row around a smooth cap.
      const short = style === 'twists'
      base.map = clippedHairTexture()
      const parts: THREE.BufferGeometry[] = []
      const count = near ? (short ? 88 : 96) : 34
      for (let i = 0; i < count; i++) {
        const azimuth = i * 2.39996323
        const polar = Math.acos(1 - (i + 0.5) / count * 0.91)
        const dx = Math.cos(azimuth), dz = Math.sin(azimuth)
        const ring = Math.sin(polar)
        const root = new THREE.Vector3(w * ring * dx, h * Math.cos(polar), d * ring * dz)
        const front = dz > 0.3
        const bend = (0.025 + (Math.sin(i * 8.17) + 1) * 0.006) * (short ? 0.65 : 1)
        const length = short ? 0.024 + (i % 5) * 0.004 : (front ? 0.046 : 0.067) + (i % 7) * 0.009
        const tilt = 0.1 + ring * 0.85
        const points: THREE.Vector3[] = []
        for (let j = 0; j <= 6; j++) {
          const t = j / 6
          const curl = Math.sin(t * Math.PI * 3 + i) * 0.003 * Math.sin(Math.PI * t)
          points.push(new THREE.Vector3(
            root.x + dx * bend * Math.sin(t * Math.PI * 0.8) + dz * curl,
            root.y + length * (t * (1.65 - tilt) - t * t * (short ? 0.8 : 1.65)) + Math.sin(Math.PI * t) * 0.018,
            root.z + dz * bend * Math.sin(t * Math.PI * 0.8) - dx * curl,
          ))
        }
        parts.push(locStrand(points, (short ? 0.0040 : 0.0045) * (0.9 + (i % 3) * 0.12), detail, i * 1.7))
      }
      const merged = mergeGeometries(parts, false)
      parts.forEach(part => part.dispose())
      if (merged) mesh(group, resources, merged, base)
      break
    }
    case 'long-straight': {
      cap(w * 1.04, d * 1.03, h + 0.01, h * 0.02, 1.48, h * 0.3)
      const count = near ? 12 : 7
      for (let i = 0; i < count; i++) {
        const angle = Math.PI + (i / (count - 1)) * Math.PI
        const x = Math.cos(angle) * w * 0.99
        const z = Math.sin(angle) * d * 0.99
        const points = [
          new THREE.Vector3(x * 0.65, h * 0.88, z * 0.66),
          new THREE.Vector3(x, h * 0.12, z * 1.03),
          new THREE.Vector3(x * 1.09, -h * 0.58, z * 1.07),
          new THREE.Vector3(x * 1.16, -h * 1.7, z * 1.04),
        ]
        mesh(group, resources, ribbon(points, near ? 0.014 : 0.023), i % 3 ? base : light)
      }
      break
    }
    case 'bun': {
      cap(w * 1.025, d * 1.02, h + 0.007, h * 0.03, 1.48, h * 0.29)
      const centre = new THREE.Vector3(0, h * 0.59, -d * 1.02)
      // Coiled swept locks read as a bun from the side and rear without a ball cap.
      const loops = near ? 5 : 3
      for (let i = 0; i < loops; i++) {
        const points: THREE.Vector3[] = []
        const segments = near ? 12 : 7
        for (let j = 0; j <= segments; j++) {
          const a = (j / segments) * Math.PI * 2 + i * 0.9
          const radius = 0.017 + i * 0.003
          points.push(new THREE.Vector3(centre.x + Math.cos(a) * radius, centre.y + Math.sin(a) * radius * 0.85, centre.z - i * 0.003))
        }
        mesh(group, resources, strand(points, 0.006, detail), i % 2 ? light : base)
      }
      break
    }
    case 'head-wrap': {
      cap(w * 1.15, d * 1.12, h * 1.26, h * 0.035, 1.49, h * 0.28, 0.018)
      mesh(group, resources, wrapFold(w * 1.14, d * 1.11, h * 0.14, h * 0.43, 0.2, detail), shade)
      mesh(group, resources, wrapFold(w * 1.08, d * 1.05, h * 0.49, h * 0.73, 1.6, detail), light)
      // Cloth edge and pleats share the wrap colour but catch light separately.
      const edgePoints: THREE.Vector3[] = []
      for (let i = 0; i <= (near ? 20 : 12); i++) {
        const a = i / (near ? 20 : 12) * Math.PI * 2
        edgePoints.push(new THREE.Vector3(Math.cos(a) * w * 1.145, h * 0.07 - (Math.sin(a) < 0 ? 0.005 : 0), Math.sin(a) * d * 1.115))
      }
      mesh(group, resources, strand(edgePoints, 0.006, detail), shade)
      for (const x of [-0.045, -0.015, 0.018, 0.05]) {
        const points = [
          new THREE.Vector3(x * 0.7, h * 1.18, d * 0.1),
          new THREE.Vector3(x, h * 0.93, d * 0.7),
          new THREE.Vector3(x * 1.35, h * 0.27, d * 1.12),
        ]
        mesh(group, resources, strand(points, 0.0025, detail), light)
      }
      break
    }
    default: {
      const exhaustive: never = style
      return exhaustive
    }
  }
  const batches = new Map<THREE.Material, THREE.Mesh[]>()
  for (const child of [...group.children]) if (child instanceof THREE.Mesh && !Array.isArray(child.material)) {
    const list = batches.get(child.material) ?? []; list.push(child); batches.set(child.material, list)
  }
  for (const [mat, parts] of batches) {
    if (parts.length < 2) continue
    const copies = parts.map(part => { part.updateMatrix(); const copy = part.geometry.clone().applyMatrix4(part.matrix); if (!(mat instanceof THREE.MeshStandardMaterial && mat.map)) copy.deleteAttribute('uv'); if (!copy.index) return copy; const expanded = copy.toNonIndexed(); copy.dispose(); return expanded })
    const geometry = mergeGeometries(copies)
    for (const copy of copies) copy.dispose()
    if (!geometry) continue
    for (const part of parts) { part.removeFromParent(); resources.geometries.delete(part.geometry); part.geometry.dispose() }
    mesh(group, resources, geometry, mat)
  }
  const source = AUTHORED_SOURCE[style]
  if (source) {
    group.userData.hairAssetState = 'loading'
    group.userData.hairReady = preloadHairAsset(style).then(() => {
      if (!owned.has(group)) return
      clearHairParts(group, resources)
      if (placeAuthoredHair(group, resources, style, c, detail, fit)) group.userData.hairAssetState = 'authored'
    }).catch(() => { if (owned.has(group)) group.userData.hairAssetState = 'failed-fallback' })
  } else group.userData.hairAssetState = 'procedural'
  return group
}

function clearHairParts(group: THREE.Group, resources: OwnedResources): void {
  for (const geometry of resources.geometries) geometry.dispose()
  for (const mat of resources.materials) mat.dispose()
  resources.geometries.clear()
  resources.materials.clear()
  group.clear()
}

/** Dispose only resources this factory created; safe if the group was attached to a shared rig. */
export function disposeHair(group: THREE.Group): void {
  group.parent?.remove(group)
  const resources = owned.get(group)
  if (!resources) return
  clearHairParts(group, resources)
  owned.delete(group)
}

export interface HairAnalysis {
  /** A front-view suggestion, never a claim about hair behind the head. */
  style: HairStyle | null
  colour: string | null
  confidence: number
  /** Fraction of checked pixels classified as hair in the visible strip above the forehead. */
  visibleCoverage: number
  /** Visible hair height as a fraction of face width. */
  visibleHeight: number
  /** True when the crop cuts off the upper hair silhouette. */
  clipped: boolean
}

function rgb(data: Uint8ClampedArray, offset: number): [number, number, number] {
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!]
}

function colourDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0]! - b[0]!) * 0.7, a[1]! - b[1]!, (a[2]! - b[2]!) * 0.6)
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

/**
 * Read only the existing levelled 1.5-face-width square crop and 468 decoded points.
 * Pixel sampling does not mutate the canvas. Fine styles, accessories, and concealed
 * back hair cannot be established from a single front view; return low confidence.
 */
export function analyseHair(canvas: HTMLCanvasElement, points: ArrayLike<number>): HairAnalysis {
  const empty: HairAnalysis = { style: null, colour: null, confidence: 0, visibleCoverage: 0, visibleHeight: 0, clipped: false }
  if (points.length < 468 * 3 || !canvas.width || !canvas.height) return empty
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return empty
  let image: ImageData
  try { image = context.getImageData(0, 0, canvas.width, canvas.height) } catch { return empty }
  const { width, height, data } = image
  const at = (x: number, y: number): [number, number, number] | null => {
    const px = Math.round(x), py = Math.round(y)
    if (px < 0 || px >= width || py < 0 || py >= height) return null
    const offset = (py * width + px) * 4
    return data[offset + 3]! < 128 ? null : rgb(data, offset)
  }
  const px = (value: number): number => (value / FACE_CROP_SPAN + 0.5) * width
  const py = (value: number): number => (0.5 - value / FACE_CROP_SPAN) * height
  const topX = px(points[10 * 3]!)
  const topY = py(points[10 * 3 + 1]!)
  const faceWidth = Math.abs(px(points[454 * 3]!) - px(points[234 * 3]!))
  if (!Number.isFinite(topX + topY + faceWidth) || faceWidth < width * 0.15) return empty

  // Cheeks are an image-specific skin reference, making this less sensitive to
  // skin tone than a fixed darkness threshold. Reject samples resembling skin.
  const skinPixels: [number, number, number][] = []
  for (const index of [50, 280, 101, 330, 117, 346]) {
    const colour = at(px(points[index * 3]!), py(points[index * 3 + 1]!))
    if (colour) skinPixels.push(colour)
  }
  if (skinPixels.length < 3) return empty
  const skin: [number, number, number] = [
    median(skinPixels.map(c => c[0])),
    median(skinPixels.map(c => c[1])),
    median(skinPixels.map(c => c[2])),
  ]
  const background = [
    at(topX - faceWidth * 0.64, topY - faceWidth * 0.25),
    at(topX + faceWidth * 0.64, topY - faceWidth * 0.25),
  ].filter((sample): sample is [number, number, number] => sample !== null)
  const roots: [number, number, number][] = []
  for (const lift of [0.06, 0.12, 0.18]) for (const offset of [-0.2, -0.1, 0, 0.1, 0.2]) {
    const c = at(topX + faceWidth * offset, topY - faceWidth * lift)
    if (c) roots.push(c)
  }
  roots.sort((a, b) => a[0] + a[1] + a[2] - b[0] - b[1] - b[2])
  const root = roots[Math.floor(roots.length * 0.25)] ?? skin
  const foreheadPatches = [151, 108, 337].map(i => at(px(points[i * 3]!), py(points[i * 3 + 1]!))).filter((c): c is [number, number, number] => c !== null)
  const forehead = [0, 1, 2].map(c => median(foreheadPatches.map(p => p[c]!)))
  const rootSum = root.reduce((a,b) => a+b,0) || 1, foreheadSum = forehead.reduce((a,b) => a+b,0) || 1
  const sameChroma = Math.hypot(root[0]/rootSum-forehead[0]!/foreheadSum,root[1]/rootSum-forehead[1]!/foreheadSum) < 0.04
  const rootIsSkin = foreheadPatches.length >= 2 && sameChroma && colourDistance(root, forehead) < 45
  if (sameChroma && !rootIsSkin) return empty
  const sampleStep = Math.max(2, Math.round(faceWidth / 34))
  const hairSamples: [number, number, number][] = []
  let checked = 0, hairCount = 0, nearSkin = 0, nearChecked = 0, highest = topY, clipped = false
  const ceiling = Math.max(0, Math.round(topY - faceWidth * 0.7))
  const start = Math.min(height - 1, Math.round(topY - faceWidth * 0.025))
  for (let y = start; y >= ceiling; y -= sampleStep) {
    for (let x = Math.round(topX - faceWidth * 0.36); x <= topX + faceWidth * 0.36; x += sampleStep) {
      const colour = at(x, y)
      if (!colour) continue
      checked++
      const contrast = colourDistance(colour, skin)
      if (y > topY - faceWidth * 0.1 && Math.abs(x - topX) < faceWidth * 0.22) {
        nearChecked++
        if (contrast < 34) nearSkin++
      }
      const chroma = Math.max(...colour) - Math.min(...colour)
      const backgroundLike = background.length > 0 && background.every(sample => colourDistance(colour, sample) < 25)
      if (rootIsSkin || colourDistance(colour, root) > 48 || contrast < 34 || (chroma < 9 && colour[0] > 185) || backgroundLike) continue
      hairCount++
      highest = Math.min(highest, y)
      hairSamples.push(colour)
      if (y <= 2) clipped = true
    }
  }
  if (!checked) return empty
  const coverage = hairCount / checked
  const visibleHeight = Math.max(0, (topY - highest) / faceWidth)
  if (hairSamples.length < 7 || coverage < 0.1) return {
    ...empty, style: rootIsSkin || (nearChecked >= 5 && nearSkin / nearChecked > 0.65) ? 'bald' : null,
    confidence: rootIsSkin ? 0.4 : nearChecked >= 5 && nearSkin / nearChecked > 0.65 ? 0.25 : 0,
    visibleCoverage: coverage,
  }
  const channels = [0, 1, 2].map(channel => median(hairSamples.map(c => c[channel]!)))
  const colour = '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('')

  // The crop shows silhouette scale, but little evidence for parting, plaits,
  // shaved gradients, wrap cloth, or hair concealed at the back.
  let style: HairStyle
  let confidence: number
  if (visibleHeight < 0.17) { style = 'low-cut'; confidence = 0.31 }
  else if (visibleHeight < 0.32) { style = 'short-afro'; confidence = 0.34 }
  else { style = 'big-afro'; confidence = 0.31 }
  const sideX = [topX - faceWidth * 0.55, topX + faceWidth * 0.55]
  const sideY = [topY + faceWidth * 0.12, topY + faceWidth * 0.28]
  let sideHair = 0
  for (const x of sideX) for (const y of sideY) {
    const candidate = at(x, y)
    if (candidate && colourDistance(candidate, skin) > 42 && colourDistance(candidate, channels) < 55) sideHair++
  }
  if (sideHair >= 3) { style = 'long-straight'; confidence = 0.25 }
  if (clipped) confidence *= 0.65
  return { style, colour, confidence, visibleCoverage: coverage, visibleHeight, clipped }
}

/** Own a fitted short-hair surface with the same disposal lifecycle as other hairstyles. */
export function createScalpHair(geometry: THREE.BufferGeometry, colour: string): THREE.Group {
  const group = createHair('bald', colour, 'near')
  group.name = 'hair:short-fibres'
  group.userData.hairAssetState = 'procedural'
  const resources = owned.get(group)!
  const tone = new THREE.Color(colour)
  tone.r = Math.max(0.008, tone.r); tone.g = Math.max(0.007, tone.g); tone.b = Math.max(0.006, tone.b)
  const hair = new THREE.MeshStandardMaterial({ color: tone, vertexColors: true, roughness: 1, side: THREE.DoubleSide })
  mesh(group, resources, geometry, hair)
  return group
}
