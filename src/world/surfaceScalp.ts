import * as THREE from 'three'

interface ScalpMeta {
  eyes: { left: readonly [number, number, number]; right: readonly [number, number, number] }
  faceLandmarks?: readonly number[]
  skin: string
}

const masks = new WeakMap<THREE.Object3D, Map<string, Uint8Array>>()
const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const smooth = (low: number, high: number, value: number): number => {
  const t = clamp((value - low) / (high - low))
  return t * t * (3 - 2 * t)
}

function scalpMask(template: THREE.Object3D, meta: ScalpMeta, width: number, height: number, mode: 'erase' | 'low-cut' | 'fade' | 'beard' | 'chin-strap' = 'erase', hairline = 0): Uint8Array {
  let bySize = masks.get(template)
  if (!bySize) { bySize = new Map(); masks.set(template, bySize) }
  const key = `${width}x${height}|${mode}|${hairline}`
  const cached = bySize.get(key)
  if (cached) return cached

  const span = Math.hypot(...meta.eyes.left.map((value, axis) => value - meta.eyes.right[axis]!))
  if (!Number.isFinite(span) || span < 1) throw new Error('The scalp mask needs valid cast eye anchors.')
  const eyeY = (meta.eyes.left[1] + meta.eyes.right[1]) / 2
  const eyeZ = (meta.eyes.left[2] + meta.eyes.right[2]) / 2
  const landmarkTop = meta.faceLandmarks?.length === 468 * 3 ? meta.faceLandmarks[10 * 3 + 1] : undefined
  // Landmark 10 is upper forehead, not the hairline. Erasure reaches below the
  // authored edge; clipped hair starts higher so the forehead is not painted over.
  const forehead = Math.max(Number.isFinite(landmarkTop) ? landmarkTop! : eyeY + span * 0.6, eyeY + span * 0.6)
  const frontStart = forehead + (mode === 'low-cut' || mode === 'fade' ? span * 0.34 : 0)
  const backStart = eyeY - span * (mode === 'erase' ? 1.65 : 1.3)
  const mask = new Uint8Array(width * height)
  const covered = new Uint8Array(mask.length)
  const protectedPixel = new Uint8Array(mask.length)
  const cheekSeeds = [-1, -1], cheekDistance = [Infinity, Infinity]
  const point = new THREE.Vector3(), normal = new THREE.Vector3()
  template.updateMatrixWorld(true)
  let triangles = 0

  template.traverse(object => {
    if (!(object instanceof THREE.SkinnedMesh)) return
    const geometry = object.geometry
    const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv'), normals = geometry.getAttribute('normal')
    if (!position || !uv || !normals) return
    const material = object.material
    const groups = Array.isArray(material)
      ? geometry.groups.filter((group: { materialIndex: number }) => material[group.materialIndex]?.name === 'head')
      : material.name === 'head'
        ? (geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? position.count, materialIndex: 0 }])
        : []
    const index = geometry.index
    const transform = new THREE.Matrix3().getNormalMatrix(object.matrixWorld)
    for (const group of groups) for (let at = group.start; at < group.start + group.count; at += 3) {
      const ids = [0, 1, 2].map(offset => index ? index.getX(at + offset) : at + offset)
      const world = ids.map(id => {
        point.fromBufferAttribute(position, id).applyMatrix4(object.matrixWorld)
        normal.fromBufferAttribute(normals, id).applyMatrix3(transform).normalize()
        return [point.x, point.y, point.z, normal.x, normal.y, normal.z]
      })
      const pixels = ids.map(id => [uv.getX(id) * width, uv.getY(id) * height])
      if (Math.max(...pixels.map(value => value[0]!)) - Math.min(...pixels.map(value => value[0]!)) > width * 0.5 ||
          Math.max(...pixels.map(value => value[1]!)) - Math.min(...pixels.map(value => value[1]!)) > height * 0.5) continue
      const [[ax, ay], [bx, by], [cx, cy]] = pixels as [[number, number], [number, number], [number, number]]
      const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
      if (Math.abs(determinant) < 1e-7) continue
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)))
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)))
      triangles++
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const a = ((by - cy) * (px + 0.5 - cx) + (cx - bx) * (py + 0.5 - cy)) / determinant
        const b = ((cy - ay) * (px + 0.5 - cx) + (ax - cx) * (py + 0.5 - cy)) / determinant
        const c = 1 - a - b
        if (a < -0.001 || b < -0.001 || c < -0.001) continue
        const x = a * world[0]![0]! + b * world[1]![0]! + c * world[2]![0]!
        const y = a * world[0]![1]! + b * world[1]![1]! + c * world[2]![1]!
        const z = a * world[0]![2]! + b * world[1]![2]! + c * world[2]![2]!
        const nx = a * world[0]![3]! + b * world[1]![3]! + c * world[2]![3]!
        const nz = a * world[0]![5]! + b * world[1]![5]! + c * world[2]![5]!
        // The front starts above landmark 10; side/back scalp reaches toward the
        // ear base. The transition follows surface position, not hair colour.
        const front = smooth(eyeZ - span * 1.25, eyeZ + span * 0.1, z)
        const curvedFront = frontStart - (mode === 'low-cut' || mode === 'fade' ? span * 0.15 * Math.min(1, (x / span) ** 2) : 0)
        const start = backStart + (curvedFront - backStart + hairline * 10) * front
        const upper = smooth(start, start + span * (mode === 'erase' ? 0.16 : 0.035), y)
        // A side-facing, protruding lower surface is likely ear, not skull.
        const ear = smooth(span * 0.88, span * 1.1, Math.abs(x))
          * (1 - smooth(eyeY + span * 0.05, eyeY + span * 0.55, y))
          * smooth(0.1, 0.45, nx * Math.sign(x))
          * smooth(eyeZ - span * 1.9, eyeZ - span * 1.3, z)
        const fade = mode === 'fade' ? smooth(eyeY - span * 0.75, eyeY + span * 0.7, y) * (1 - front) + front : 1
        let weight = upper * (1 - ear) * fade
        if (mode === 'beard' || mode === 'chin-strap') {
          const points = meta.faceLandmarks
          const chin = points?.[152 * 3 + 1] ?? eyeY - span * 1.65
          const mouth = points?.[14 * 3 + 1] ?? eyeY - span * 1.05
          const nose = points?.[2 * 3 + 1] ?? eyeY - span * 0.74
          const side = smooth(span * 0.38, span * 0.76, Math.abs(x))
          const cheekTop = mode === 'chin-strap' ? chin + span * 0.29 + side * span * 0.77 : mouth + span * 0.02 + side * span * 0.78
          const jawBase = chin + (mode === 'chin-strap' ? side * span * 0.48 : 0)
          const jaw = smooth(jawBase - span * 0.08, jawBase + span * 0.06, y) * (1 - smooth(cheekTop - span * 0.20, cheekTop + span * 0.10, y))
          const lipClearance = 1 - (1 - smooth(span * 0.24, span * 0.41, Math.abs(x))) * smooth(mouth - span * 0.14, mouth - span * 0.05, y)
          const moustache = smooth(mouth + span * 0.10, mouth + span * 0.14, y) * (1 - smooth(nose - span * 0.14, nose - span * 0.06, y)) * (1 - smooth(span * 0.26, span * 0.45, Math.abs(x)))
          const faceSurface = smooth(eyeZ - span * 0.7, eyeZ - span * 0.1, z) * (1 - ear)
          weight = Math.max(jaw * lipClearance, moustache) * faceSurface
        }
        const pixel = py * width + px
        covered[pixel] = 1
        const side = x < 0 ? 0 : 1
        if (Math.abs(x) > span * 0.24 && Math.abs(x) < span * 0.7 &&
            y < eyeY - span * 0.15 && y > eyeY - span * 0.8 && z > eyeZ && nz > 0.2) {
          const targetX = (side === 0 ? -1 : 1) * span * 0.48
          const distance = (x - targetX) ** 2 + (y - (eyeY - span * 0.42)) ** 2
          if (distance < cheekDistance[side]!) { cheekDistance[side] = distance; cheekSeeds[side] = pixel }
        }
        if (weight < 0.025) protectedPixel[pixel] = 1
        else mask[pixel] = Math.max(mask[pixel]!, Math.round(weight * 255))
      }
    }
  })

  if (triangles < 100) throw new Error('The cast head has no usable scalp UV surface.')
  // The head slot also has cap/scarf/eye islands. Keep only the atlas island
  // connected to a real cheek, just as the asset builder does for its skin mask.
  const connected = new Uint8Array(mask.length), queue = new Int32Array(mask.length)
  let first = 0, last = 0
  for (const seed of cheekSeeds) if (seed >= 0 && covered[seed] && !connected[seed]) { connected[seed] = 1; queue[last++] = seed }
  if (last === 0) throw new Error('The cast head has no identifiable face UV island.')
  while (first < last) {
    const pixel = queue[first++]!, x = pixel % width, y = Math.floor(pixel / width)
    for (const next of [x ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, y ? pixel - width : -1, y < height - 1 ? pixel + width : -1]) {
      if (next >= 0 && covered[next] && !connected[next]) { connected[next] = 1; queue[last++] = next }
    }
  }
  let painted = 0
  for (let i = 0; i < mask.length; i++) {
    if (protectedPixel[i] || !connected[i]) mask[i] = 0
    if (mask[i]) painted++
  }
  if (mode !== 'beard' && mode !== 'chin-strap' && painted < width * height * 0.005) throw new Error('The cast scalp UV area is unexpectedly small.')
  // Extend colour into uncovered atlas gutters to avoid hair-coloured bilinear seams.
  for (let pass = 0; pass < 2; pass++) {
    const previous = mask.slice()
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const at = y * width + x
      if (covered[at]) continue
      mask[at] = Math.max(previous[at]!, Math.round(Math.max(previous[at - 1]!, previous[at + 1]!, previous[at - width]!, previous[at + width]!) * 0.85))
    }
  }
  bySize.set(key, mask)
  return mask
}

/** Replace baked scalp hair in an already-painted, flipped head canvas. Caller chooses when. */
export function eraseBakedScalp(canvas: HTMLCanvasElement, template: THREE.Object3D, meta: ScalpMeta, tone: string): void {
  const colour = /^#[0-9a-fA-F]{6}$/.test(tone) ? tone : meta.skin
  if (!/^#[0-9a-fA-F]{6}$/.test(colour)) throw new Error('A valid skin tone is required for scalp repainting.')
  const mask = scalpMask(template, meta, canvas.width, canvas.height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The head texture cannot be painted.')
  const image = context.getImageData(0, 0, canvas.width, canvas.height), data = image.data
  const target = [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16))
  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i]! / 255
    if (!alpha) continue
    const x = i % canvas.width, y = Math.floor(i / canvas.width)
    const grain = (((x * 73856093) ^ (y * 19349663)) & 255) / 255 - 0.5
    const at = i * 4
    for (let channel = 0; channel < 3; channel++) {
      const skin = target[channel]! * (0.995 + grain * 0.008)
      data[at + channel] = data[at + channel]! * (1 - alpha) + skin * alpha
    }
  }
  context.putImageData(image, 0, 0)
}

/** Close-cropped hair follows the real scalp and rig; no intersecting cap mesh. */
export function paintClippedScalp(canvas: HTMLCanvasElement, template: THREE.Object3D, meta: ScalpMeta, colour: string, style: 'low-cut' | 'fade', hairline: number): void {
  const mask = scalpMask(template, meta, canvas.width, canvas.height, style, hairline)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const tone = [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16))
  for (let i = 0; i < mask.length; i++) {
    const alpha = mask[i]! / 255
    if (!alpha) continue
    const x = i % canvas.width, y = Math.floor(i / canvas.width)
    const grain = (((x * 73856093) ^ (y * 19349663) ^ (x * y * 83492791)) >>> 0) % 255 / 255
    const coverage = alpha * (0.86 + grain * 0.12)
    for (let c = 0; c < 3; c++) pixels.data[i * 4 + c] = pixels.data[i * 4 + c]! * (1 - coverage) + tone[c]! * (0.8 + grain * 0.4) * coverage
  }
  context.putImageData(pixels, 0, 0)
}

/** Short facial hair follows the actual jaw surface and retains its light response. */
export function paintBeard(canvas: HTMLCanvasElement, template: THREE.Object3D, meta: ScalpMeta, colour: string, style: 'on' | 'chin-strap'): void {
  const mask = scalpMask(template, meta, canvas.width, canvas.height, style === 'on' ? 'beard' : 'chin-strap')
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const tone = [1, 3, 5].map(at => parseInt(colour.slice(at, at + 2), 16))
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const x = i % canvas.width, y = Math.floor(i / canvas.width)
    const grain = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 255 / 255
    const alpha = mask[i]! / 255 * (0.32 + grain * 0.36)
    for (let c = 0; c < 3; c++) image.data[i * 4 + c] = image.data[i * 4 + c]! * (1 - alpha) + tone[c]! * (0.75 + grain * 0.65) * alpha
  }
  context.putImageData(image, 0, 0)
}

/** Near-view short fibres follow the actual head surface; the far view uses scalp paint only. */
export function scalpFibreGeometry(geometry: THREE.BufferGeometry, bind: THREE.Matrix4, meta: ScalpMeta, origin: THREE.Vector3, style: 'low-cut' | 'fade', hairline: number, portrait?: { canvas: HTMLCanvasElement; skin: string }): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), index = geometry.index
  const output = new THREE.BufferGeometry()
  const photoUv = geometry.getAttribute('faceUv')
  const picture = portrait?.canvas.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, portrait.canvas.width, portrait.canvas.height)
  const skin = portrait ? [1, 3, 5].map(at => parseInt(portrait.skin.slice(at, at + 2), 16)) : null
  const brightness = (red: number, green: number, blue: number): number => red * 0.2126 + green * 0.7152 + blue * 0.0722
  const skinLight = skin ? brightness(skin[0]!, skin[1]!, skin[2]!) : 0
  if (!positions || !normals || !index) return output
  const span = Math.abs(meta.eyes.left[0] - meta.eyes.right[0])
  const eyeY = (meta.eyes.left[1] + meta.eyes.right[1]) / 2, eyeZ = (meta.eyes.left[2] + meta.eyes.right[2]) / 2
  const forehead = Math.max(meta.faceLandmarks?.[10 * 3 + 1] ?? eyeY + span * 0.6, eyeY + span * 0.6) + span * 0.34
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(bind)
  const coverage = (point: THREE.Vector3, normal: THREE.Vector3): number => {
    const front = smooth(eyeZ - span * 1.25, eyeZ + span * 0.1, point.z)
    const top = forehead - span * 0.15 * Math.min(1, (point.x / span) ** 2)
    const start = eyeY - span * 1.3 + (top - eyeY + span * 1.3 + hairline * 10) * front
    const ear = smooth(span * 0.88, span * 1.1, Math.abs(point.x)) * (1 - smooth(eyeY + span * 0.05, eyeY + span * 0.55, point.y)) * smooth(0.1, 0.45, normal.x * Math.sign(point.x))
    const fade = style === 'fade' ? smooth(eyeY - span * 0.75, eyeY + span * 0.7, point.y) * (1 - front) + front : 1
    return smooth(start, start + span * 0.08, point.y) * (1 - ear) * fade
  }
  const triangles: { ids: number[]; points: THREE.Vector3[]; limit: number }[] = []
  let area = 0
  for (let at = 0; at < index.count; at += 3) {
    const ids = [index.getX(at), index.getX(at + 1), index.getX(at + 2)]
    const points = ids.map(id => new THREE.Vector3().fromBufferAttribute(positions, id).applyMatrix4(bind))
    const centre = points[0]!.clone().add(points[1]!).add(points[2]!).multiplyScalar(1 / 3)
    const normal = ids.reduce((sum, id) => sum.add(new THREE.Vector3().fromBufferAttribute(normals, id).applyMatrix3(normalMatrix)), new THREE.Vector3()).normalize()
    if (coverage(centre, normal) < 0.1) continue
    const size = points[1]!.clone().sub(points[0]!).cross(points[2]!.clone().sub(points[0]!)).length() / 2
    if (size <= 0) continue
    area += size
    triangles.push({ ids, points, limit: area })
  }
  let seed = 3181
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const vertices: number[] = [], colours: number[] = []
  const count = Math.min(1200, Math.round(area * 2.1))
  const centre = new THREE.Vector3(), normal = new THREE.Vector3(), tangent = new THREE.Vector3(), across = new THREE.Vector3()
  for (let sample = 0; sample < count && triangles.length; sample++) {
    const pick = random() * area
    let low = 0, high = triangles.length - 1
    while (low < high) { const middle = (low + high) >> 1; if (triangles[middle]!.limit < pick) low = middle + 1; else high = middle }
    const triangle = triangles[low]!, u = Math.sqrt(random()), v = random(), weights = [1 - u, u * (1 - v), u * v]
    centre.set(0, 0, 0); normal.set(0, 0, 0)
    for (let i = 0; i < 3; i++) {
      centre.addScaledVector(triangle.points[i]!, weights[i]!)
      normal.addScaledVector(new THREE.Vector3().fromBufferAttribute(normals, triangle.ids[i]!).applyMatrix3(normalMatrix), weights[i]!)
    }
    normal.normalize()
    if (random() > coverage(centre, normal)) continue
    if (picture && photoUv && triangle.ids.reduce((sum, id, i) => sum + photoUv.getZ(id) * weights[i]!, 0) > 0.2) {
      const u = triangle.ids.reduce((sum, id, i) => sum + photoUv.getX(id) * weights[i]!, 0)
      const v = triangle.ids.reduce((sum, id, i) => sum + photoUv.getY(id) * weights[i]!, 0)
      const x = Math.floor(u * picture.width), y = Math.floor((1 - v) * picture.height)
      if (x >= 0 && x < picture.width && y >= 0 && y < picture.height) {
        const at = (y * picture.width + x) * 4, rgba = picture.data
        if (rgba[at + 3]! > 128 && brightness(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!) > skinLight * 0.6) continue
      }
    }
    tangent.crossVectors(normal, Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize()
    across.crossVectors(normal, tangent)
    centre.addScaledVector(normal, 0.015)
    const length = 0.055 + random() * 0.13, radius = 0.035 + random() * 0.02
    const tip = centre.clone().addScaledVector(normal, length).addScaledVector(tangent, (random() - 0.5) * 0.07)
    const shade = 0.65 + random() * 0.7
    for (let side = 0; side < 3; side++) {
      const a = side * Math.PI * 2 / 3, b = (side + 1) * Math.PI * 2 / 3
      const first = centre.clone().addScaledVector(tangent, Math.cos(a) * radius).addScaledVector(across, Math.sin(a) * radius)
      const second = centre.clone().addScaledVector(tangent, Math.cos(b) * radius).addScaledVector(across, Math.sin(b) * radius)
      for (const point of [first, second, tip]) {
        vertices.push((point.x - origin.x) / 100, (point.y - origin.y) / 100, (point.z - origin.z) / 100)
        colours.push(shade, shade, shade)
      }
    }
  }
  output.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  output.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
  output.computeVertexNormals(); output.computeBoundingSphere()
  return output
}
