import * as THREE from 'three'
import type { District, Poi } from '../../geo/district.ts'
import type { Vec2 } from '../../shared/geo.ts'

export interface FrontagePlacement {
  model: string
  pos: Vec2
  angle: number
  seed: number
}

export interface FrontageSignsInput {
  district: District
  placements: readonly FrontagePlacement[]
  quality: 'low' | 'medium' | 'high'
  countryCode: string
}

export interface FrontageSigns {
  root: THREE.Group
  update(placements: readonly FrontagePlacement[]): void
  setNight(amount: number): void
  setView(camera: THREE.Vector3, focus: THREE.Vector3): void
  dispose(): void
  stats: { instances: number; triangles: number; textureBytes: number; obscured: number }
}

type SignKind = 'shop' | 'stall' | 'food' | 'pos' | 'repairs'

interface SignStyle {
  kind: SignKind
  width: number
  height: number
  y: number
  forward: number
  background: string
  foreground: string
  accent: string
}

interface SignLabel {
  title: string
  mapped: boolean
}

const ATLAS_SIZE = 512
const COLUMNS = 4
const ROWS = 8
const CELL_WIDTH = ATLAS_SIZE / COLUMNS
const CELL_HEIGHT = ATLAS_SIZE / ROWS
const QUALITY_CAP = { low: 8, medium: 16, high: 24 } satisfies Record<FrontageSignsInput['quality'], number>
const ATLAS_BYTES = ATLAS_SIZE * ATLAS_SIZE * 4

const FICTIONAL_NAMES: Record<SignKind, readonly string[]> = {
  shop: ['Ayo Provisions', 'Ireti Tailoring', 'Daybreak Bakery', 'Palm Pharmacy', 'Next Cut Barbing', 'Market Boutique'],
  stall: ['Ayo Provisions', 'Ireti Tailoring', 'Market Boutique'],
  food: ['Mama Put', 'Daybreak Bakery'],
  pos: ['Corner POS'],
  repairs: ['Bayo Repairs'],
}

const STYLES: Record<SignKind, Omit<SignStyle, 'kind'>> = {
  shop: { width: 2.35, height: 0.72, y: 2.05, forward: 2.15, background: '#174c3a', foreground: '#fff1c5', accent: '#e9a72f' },
  stall: { width: 1.75, height: 0.58, y: 2.02, forward: 1.55, background: '#9f352c', foreground: '#fff0ce', accent: '#f1bd3f' },
  food: { width: 1.9, height: 0.64, y: 2.08, forward: 1.62, background: '#d06a20', foreground: '#fff4d6', accent: '#4c7e48' },
  pos: { width: 1.25, height: 0.62, y: 2.12, forward: 1.18, background: '#235f92', foreground: '#fff9de', accent: '#e8b63f' },
  repairs: { width: 2.15, height: 0.68, y: 2.35, forward: 1.8, background: '#343b3b', foreground: '#f4d778', accent: '#c84a34' },
}

function random(seed: number, salt: number): number {
  let value = (seed + Math.imul(salt + 1, 0x9e3779b1)) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad)
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97)
  return ((value ^ (value >>> 15)) >>> 0) / 0x1_0000_0000
}

function signStyle(model: string): SignStyle | null {
  const name = model.trim().toLowerCase()
  let kind: SignKind | null = null
  if (name === 'pos' || name === 'pos-kiosk') kind = 'pos'
  else if (name === 'vulcanizer') kind = 'repairs'
  else if (name === 'food') kind = 'food'
  else if (name === 'stall' || name === 'stall-red' || name === 'stall-green') kind = 'stall'
  else if (name === 'kiosk' || name === 'container-shop' || name === 'shop-goods' || name === 'shopgoods') kind = 'shop'
  return kind ? { kind, ...STYLES[kind] } : null
}

function suitablePoi(poi: Poi, kind: SignKind): boolean {
  const category = `${poi.category} ${poi.subclass}`.toLowerCase().replaceAll('_', ' ')
  const contains = (...words: readonly string[]): boolean => words.some(word => category.includes(word))
  if (kind === 'pos') return contains('bank', 'atm', 'money', 'finance', 'payment')
  if (kind === 'repairs') return contains('car repair', 'vehicle', 'tyre', 'tire', 'mechanic', 'automotive')
  if (kind === 'food') return contains('food', 'restaurant', 'cafe', 'bakery', 'fast food', 'bar')
  if (kind === 'stall') return contains('market', 'shop', 'clothes', 'tailor', 'food', 'retail')
  return contains('shop', 'market', 'retail', 'supermarket', 'bakery', 'pharmacy', 'hairdresser', 'clothes', 'convenience')
}

function labelFor(district: District, placement: FrontagePlacement, kind: SignKind): SignLabel {
  let nearest: Poi | null = null, nearestDistance = 20.0001
  for (const poi of district.pois) {
    if (!suitablePoi(poi, kind)) continue
    const distance = Math.hypot(poi.pos.x - placement.pos.x, poi.pos.z - placement.pos.z)
    if (distance < nearestDistance || distance === nearestDistance && poi.rank < (nearest?.rank ?? Infinity)) {
      nearest = poi; nearestDistance = distance
    }
  }
  if (nearest) return { title: nearest.name, mapped: true }
  const names = FICTIONAL_NAMES[kind]
  return { title: names[Math.floor(random(placement.seed, 7) * names.length)] ?? names[0]!, mapped: false }
}

function fitFont(context: CanvasRenderingContext2D, text: string, maximumWidth: number): number {
  for (let size = 21; size >= 9; size--) {
    context.font = `800 ${size}px system-ui, sans-serif`
    if (context.measureText(text).width <= maximumWidth) return size
  }
  return 9
}

function paintSign(context: CanvasRenderingContext2D, cell: number, style: SignStyle, label: SignLabel, seed: number): void {
  const column = cell % COLUMNS, row = Math.floor(cell / COLUMNS)
  const left = column * CELL_WIDTH, top = row * CELL_HEIGHT
  context.save()
  context.beginPath(); context.rect(left, top, CELL_WIDTH, CELL_HEIGHT); context.clip()
  context.translate(left + CELL_WIDTH / 2, top + CELL_HEIGHT / 2)
  context.rotate((random(seed, 13) - 0.5) * 0.018)
  context.fillStyle = style.background; context.fillRect(-62, -30, 124, 60)
  context.strokeStyle = style.accent; context.lineWidth = 3
  context.strokeRect(-59.5, -27.5, 119, 55)
  context.globalAlpha = 0.22
  context.fillStyle = style.foreground
  for (let mark = 0; mark < 18; mark++) {
    const x = -57 + random(seed, 50 + mark * 2) * 114
    const y = -25 + random(seed, 51 + mark * 2) * 50
    const size = 0.6 + random(seed, 90 + mark) * 1.4
    context.fillRect(x, y, size, random(seed, 120 + mark) > 0.5 ? 0.7 : 1.5)
  }
  context.globalAlpha = 1
  const fontSize = fitFont(context, label.title, 110)
  context.font = `800 ${fontSize}px system-ui, sans-serif`
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillStyle = style.foreground
  context.fillText(label.title, 0, -4, 110)
  context.fillStyle = style.accent
  context.fillRect(-47, 10, 94, 1.5)
  context.font = '700 7px system-ui, sans-serif'
  context.letterSpacing = '0.65px'
  context.fillStyle = style.foreground
  context.fillText(label.mapped ? 'NEAR MAPPED PLACE' : 'ILLUSTRATIVE', 0, 20, 106)
  context.restore()
}

export function createFrontageSigns(input: FrontageSignsInput): FrontageSigns {
  const root = new THREE.Group()
  root.name = 'region:frontage-signs'
  const stats = { instances: 0, triangles: 0, textureBytes: 0, obscured: 0 }
  const country = input.countryCode.trim().toUpperCase()
  if (country !== 'NG') {
    return { root, stats, update() {}, setNight() {}, setView() {}, dispose() { root.removeFromParent(); root.clear() } }
  }

  const capacity = QUALITY_CAP[input.quality]
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ATLAS_SIZE
  const context = canvas.getContext('2d')
  if (!context) return { root, stats, update() {}, setNight() {}, setView() {}, dispose() { root.removeFromParent(); root.clear() } }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, side: THREE.DoubleSide, toneMapped: true })
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(capacity * 4 * 3)
  const uvs = new Float32Array(capacity * 4 * 2)
  const colors = new Float32Array(capacity * 4 * 3)
  colors.fill(1)
  const indices = new Uint16Array(capacity * 6)
  for (let sign = 0; sign < capacity; sign++) {
    const vertex = sign * 4, index = sign * 6
    indices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], index)
  }
  const positionAttribute = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage)
  const uvAttribute = new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage)
  const colorAttribute = new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', positionAttribute)
  geometry.setAttribute('uv', uvAttribute)
  geometry.setAttribute('color', colorAttribute)
  const indexAttribute = new THREE.BufferAttribute(indices, 1).setUsage(THREE.DynamicDrawUsage)
  geometry.setIndex(indexAttribute)
  geometry.setDrawRange(0, 0)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'region:frontage-sign-quads'
  mesh.frustumCulled = false
  root.add(mesh)
  stats.textureBytes = ATLAS_BYTES
  let disposed = false
  let selected: { placement: FrontagePlacement; style: SignStyle }[] = []
  const cameraPosition = new THREE.Vector3(), characterFocus = new THREE.Vector3()
  let hasView = false, visibleMask = -1

  const refreshVisibility = (): void => {
    let mask = 0, visible = 0
    const dx = characterFocus.x - cameraPosition.x, dy = characterFocus.y - cameraPosition.y, dz = characterFocus.z - cameraPosition.z
    for (let sign = 0; sign < selected.length; sign++) {
      const { placement, style } = selected[sign]!
      const sin = Math.sin(placement.angle), cos = Math.cos(placement.angle)
      const cx = placement.pos.x + sin * style.forward, cz = placement.pos.z + cos * style.forward
      const denominator = dx * sin + dz * cos
      const t = hasView && Math.abs(denominator) > 0.0001
        ? ((cx - cameraPosition.x) * sin + (cz - cameraPosition.z) * cos) / denominator : -1
      const across = (cameraPosition.x + dx * t - cx) * cos - (cameraPosition.z + dz * t - cz) * sin
      const height = cameraPosition.y + dy * t
      // Clear an upper-body corridor only between the camera and character. Keep world depth.
      const wasObscured = visibleMask >= 0 && (visibleMask & 1 << sign) === 0
      const clearance = wasObscured ? 0.12 : 0
      const obscures = t > 0 && t < 1 && Math.abs(across) < style.width / 2 + 0.42 + clearance && Math.abs(height - style.y) < style.height / 2 + 0.48 + clearance
      if (obscures) continue
      mask |= 1 << sign
      const vertex = sign * 4, index = visible++ * 6
      indices[index] = vertex; indices[index + 1] = vertex + 1; indices[index + 2] = vertex + 2
      indices[index + 3] = vertex; indices[index + 4] = vertex + 2; indices[index + 5] = vertex + 3
    }
    if (mask !== visibleMask) {
      visibleMask = mask
      indexAttribute.needsUpdate = true
      geometry.setDrawRange(0, visible * 6)
      mesh.visible = visible > 0
    }
    stats.instances = visible; stats.triangles = visible * 2; stats.obscured = selected.length - visible
    root.userData.obscuredSigns = stats.obscured
  }

  const setView = (camera: THREE.Vector3, focus: THREE.Vector3): void => {
    if (disposed) return
    cameraPosition.copy(camera); characterFocus.copy(focus); hasView = true
    refreshVisibility()
  }

  const update = (placements: readonly FrontagePlacement[]): void => {
    if (disposed) return
    selected = placements.flatMap(placement => {
      const style = signStyle(placement.model)
      return style ? [{ placement, style }] : []
    }).slice(0, capacity)
    context.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE)
    for (let sign = 0; sign < selected.length; sign++) {
      const { placement, style } = selected[sign]!
      const label = labelFor(input.district, placement, style.kind)
      paintSign(context, sign, style, label, placement.seed)
      const cos = Math.cos(placement.angle), sin = Math.sin(placement.angle)
      const halfWidth = style.width / 2
      const localX = [-halfWidth, halfWidth, halfWidth, -halfWidth]
      const localY = [style.y - style.height / 2, style.y - style.height / 2, style.y + style.height / 2, style.y + style.height / 2]
      const positionOffset = sign * 12
      for (let corner = 0; corner < 4; corner++) {
        const x = localX[corner]!, offset = positionOffset + corner * 3
        positions[offset] = placement.pos.x + cos * x + sin * style.forward
        positions[offset + 1] = localY[corner]!
        positions[offset + 2] = placement.pos.z - sin * x + cos * style.forward
      }
      const column = sign % COLUMNS, row = Math.floor(sign / COLUMNS)
      const u0 = column / COLUMNS, u1 = (column + 1) / COLUMNS
      const v0 = 1 - (row + 1) / ROWS, v1 = 1 - row / ROWS
      const uvOffset = sign * 8
      uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], uvOffset)
    }
    positionAttribute.needsUpdate = true; uvAttribute.needsUpdate = true
    geometry.setDrawRange(0, selected.length * 6)
    geometry.computeBoundingSphere()
    texture.needsUpdate = true
    visibleMask = -1
    refreshVisibility()
  }

  const setNight = (amount: number): void => {
    if (disposed) return
    const night = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0
    material.color.setRGB(1 - night * 0.14, 1 - night * 0.12, 1 - night * 0.08)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    root.removeFromParent(); root.clear()
    geometry.dispose(); material.dispose(); texture.dispose()
  }

  update(input.placements)
  return { root, stats, update, setNight, setView, dispose }
}
