// Photo likeness fitted to the existing skinned head from on-device landmarks.
//
// A scan is 468 landmark positions plus a square picture of the face region. Positions are in
// "face widths" around the picture centre, so texture coordinates follow from x and y alone.
import * as THREE from 'three'
import { analyseFaceSurface, confirmFaceTone } from './surfaceAlbedo.ts'
import { neutralizePortraitLighting } from './surfaceLighting.ts'
import { analyseHair } from './surfaceHair.ts'
import { DEFAULT_APPEARANCE } from '../shared/appearance.ts'
import type { AvatarAppearance } from '../shared/appearance.ts'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import topology from '../assets/face-topology.json'
import { FACE_LANDMARKS } from '../shared/model.ts'
import type { FaceScan } from '../shared/model.ts'

/** The picture covers this many face widths, centred on the face. */
export const FACE_CROP_SPAN = 1.5
/** Int16 steps per face width in the stored mesh. */
export const FACE_MESH_SCALE = 8192
export function encodeFacePoints(points: { x: number; y: number; z: number }[]): string {
  const data = new Int16Array(FACE_LANDMARKS * 3)
  const clamp = (value: number): number => Math.max(-32767, Math.min(32767, Math.round(value * FACE_MESH_SCALE)))
  for (let i = 0; i < FACE_LANDMARKS; i++) {
    const point = points[i]!
    data.set([clamp(point.x), clamp(point.y), clamp(point.z)], i * 3)
  }
  let binary = ''
  for (const byte of new Uint8Array(data.buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeFacePoints(mesh: string): Float32Array {
  const binary = atob(mesh)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const stored = new Int16Array(bytes.buffer, 0, FACE_LANDMARKS * 3)
  const points = new Float32Array(FACE_LANDMARKS * 3)
  for (let i = 0; i < stored.length; i++) points[i] = stored[i]! / FACE_MESH_SCALE
  return points
}

/** Eye midpoint and eye-to-eye distance of a scan, in face widths. Used to fit it to a head. */
export function faceEyes(scan: FaceScan): { centre: { x: number; y: number; z: number }; spread: number } {
  return eyesOf(decodeFacePoints(scan.mesh))
}

function eyesOf(points: ArrayLike<number>): { centre: { x: number; y: number; z: number }; spread: number } {
  const mid = (a: number, b: number): [number, number, number] => [0, 1, 2].map(axis => (points[a * 3 + axis]! + points[b * 3 + axis]!) / 2) as [number, number, number]
  // Landmarks 33/133 are the corners of one eye, 362/263 of the other.
  const one = mid(33, 133), other = mid(362, 263)
  return {
    centre: { x: (one[0] + other[0]) / 2, y: (one[1] + other[1]) / 2, z: ((one[2] + other[2]) / 2) },
    spread: Math.hypot(one[0] - other[0], one[1] - other[1]),
  }
}

/** The edge of the kept photo region is erased and blurred over this share of the picture's side. */
export const FACE_MASK_FEATHER = 1 / 128

/**
 * The outline of the photo region a head keeps: the landmark oval, a little wider, raised over the
 * forehead and lowered under the lip. In face widths around the picture centre, y up.
 */
export function facePhotoOutline(points: ArrayLike<number>): { x: number; y: number }[] {
  const eyeY = eyesOf(points).centre.y
  return topology.oval.map(index => {
    const py = points[index * 3 + 1]!
    const extension = py > eyeY ? 0.25 * THREE.MathUtils.smoothstep(py - eyeY, 0, 0.25) : py < points[14 * 3 + 1]! ? -0.075 : 0
    return { x: points[index * 3]! * 1.025, y: py + extension }
  })
}

export function sampleFaceSkin(context: CanvasRenderingContext2D, points: ArrayLike<number>): string {
  return analyseFaceSurface(context.canvas, points).skin
}

export interface FaceProjection {
  texture: THREE.Texture
  featureTexture: THREE.Texture
  skin: string
  iris: string
  hair: ReturnType<typeof analyseHair>
  hasBeard: boolean
  hairline: number
  blink: { value: number }
  eyes: number
  nose: number
  mouth: number
  chin: number
  brow: number
  spread: number
  mouthWidth: number
  centre: number
}

/** Feather the crop once; the existing skinned head carries the photo, including its eyelids. */
export async function buildFaceProjection(scan: FaceScan, appearance: AvatarAppearance = DEFAULT_APPEARANCE, skinTone: string | null = null, textureLimit = 512): Promise<FaceProjection> {
  const points = decodeFacePoints(scan.mesh)
  const image = new Image()
  image.src = scan.texture
  await image.decode()
  const canvas = document.createElement('canvas')
  const size = Math.min(textureLimit, image.naturalWidth)
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0, size, size)
  const surface = analyseFaceSurface(canvas, points)
  const hair = analyseHair(canvas, points)
  const neutral = neutralizePortraitLighting(canvas, points, FACE_CROP_SPAN)
  if (skinTone) confirmFaceTone(neutral, surface.features, points, surface.skin, skinTone)
  context.clearRect(0, 0, size, size)
  context.drawImage(neutral, 0, 0)
  const photoWidth = Math.abs(points[234 * 3]! - points[454 * 3]!)
  const mouthY = (points[13 * 3 + 1]! + points[14 * 3 + 1]!) / 2
  const features = surface.features.getContext('2d')!.getImageData(0, 0, size, size)
  const pixels = context.getImageData(0, 0, size, size)
  const skin = [1, 3, 5].map(at => parseInt((skinTone ?? surface.skin).slice(at, at + 2), 16))
  for (let i = 0; i < pixels.data.length; i += 4) {
    const x = ((i / 4 % size) / size - 0.5) * FACE_CROP_SPAN
    const y = (0.5 - Math.floor(i / 4 / size) / size) * FACE_CROP_SPAN
    const facial = y < mouthY + photoWidth * 0.14
    let alpha = features.data[i + 3]! / 255
    if (appearance.beard === 'off' && facial) {
      for (let c = 0; c < 3; c++) pixels.data[i + c] = pixels.data[i + c]! * (1 - alpha) + skin[c]! * alpha
      features.data[i + 3] = 0
    } else if (appearance.beard === 'on' && facial) {
      const edge = points[152 * 3 + 1]! + photoWidth * 0.38 * Math.pow(Math.abs(x) / (photoWidth * 0.48), 1.7)
      const strap = (1 - THREE.MathUtils.smoothstep(Math.abs(y - edge), photoWidth * 0.045, photoWidth * 0.09)) * (1 - THREE.MathUtils.smoothstep(Math.abs(x), photoWidth * 0.45, photoWidth * 0.52))
      alpha = Math.max(alpha, strap)
      features.data[i + 3] = alpha * 255
    }
    if (features.data[i + 3]! > 0) for (let c = 0; c < 3; c++) pixels.data[i + c] = pixels.data[i + c]! * (1 - alpha * 0.12)
  }
  context.putImageData(pixels, 0, 0)
  surface.features.getContext('2d')!.putImageData(features, 0, 0)
  const featureTexture = new THREE.CanvasTexture(surface.features)

  const mask = document.createElement('canvas')
  mask.width = mask.height = size
  const ink = mask.getContext('2d')!
  ink.beginPath()
  facePhotoOutline(points).forEach((point, i) => {
    const x = (point.x / FACE_CROP_SPAN + 0.5) * size
    const y = (0.5 - point.y / FACE_CROP_SPAN) * size
    if (i === 0) ink.moveTo(x, y); else ink.lineTo(x, y)
  })
  ink.closePath()
  ink.fillStyle = '#fff'
  ink.fill()
  // Erase the edge before blurring so the photo's background never reaches the head.
  ink.globalCompositeOperation = 'destination-out'
  ink.lineWidth = size * FACE_MASK_FEATHER
  ink.stroke()
  context.globalCompositeOperation = 'destination-in'
  context.filter = `blur(${size * FACE_MASK_FEATHER}px)`
  context.drawImage(mask, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const eyes = faceEyes(scan)
  return {
    texture, featureTexture, skin: skinTone ?? surface.skin, iris: surface.iris, hair, hairline: appearance.hairline, hasBeard: appearance.beard === 'on' || (appearance.beard !== 'off' && surface.hasBeard), blink: { value: 0 }, eyes: eyes.centre.y, spread: eyes.spread, centre: eyes.centre.x,
    nose: points[1 * 3 + 1]!, mouth: (points[13 * 3 + 1]! + points[14 * 3 + 1]!) / 2,
    chin: points[152 * 3 + 1]!, brow: points[10 * 3 + 1]!,
    mouthWidth: Math.abs(points[291 * 3]! - points[61 * 3]!),
  }
}

export interface HeadAnchors {
  eyes: number
  nose: number
  mouth: number
  chin: number
  brow: number
  spread: number
  mouthWidth: number
  front: number
}

interface PhotoUniforms {
  photoMap: { value: THREE.Texture | null }
  photoFeatures: { value: THREE.Texture | null }
  photoHairline: { value: number }
  photoIris: { value: THREE.Color }
  photoBeard: { value: number }
  photoBlink: { readonly value: number }
  photoBind: { value: THREE.Matrix4 }
  photoSource: { value: THREE.Vector4 }
  photoTarget: { value: THREE.Vector4 }
  photoFit: { value: THREE.Vector4 }
  photoBrow: { value: THREE.Vector2 }
}
interface PhotoBinding { photo: FaceProjection | null; uniforms: PhotoUniforms }
const photoBindings = new WeakMap<THREE.MeshStandardMaterial, PhotoBinding>()

/**
 * One set of uniform objects per head material, for as long as it lives. The renderer reuses a
 * program it has already compiled without running the shader hook again, so a hook that made new
 * objects for each picture left the first picture on the head. Every hook hands out these same
 * objects, and a picture is written into them.
 */
function photoBinding(material: THREE.MeshStandardMaterial): PhotoBinding {
  const known = photoBindings.get(material)
  if (known) return known
  const binding: PhotoBinding = {
    photo: null,
    uniforms: {
      photoMap: { value: null }, photoFeatures: { value: null },
      photoHairline: { value: 0 }, photoIris: { value: new THREE.Color() }, photoBeard: { value: 0 },
      // Read from the picture that is shown, so no earlier picture's blink is left attached.
      photoBlink: { get value(): number { return binding.photo?.blink.value ?? 0 } },
      photoBind: { value: new THREE.Matrix4() },
      photoSource: { value: new THREE.Vector4() }, photoTarget: { value: new THREE.Vector4() }, photoFit: { value: new THREE.Vector4() },
      photoBrow: { value: new THREE.Vector2() },
    },
  }
  photoBindings.set(material, binding)
  material.addEventListener('dispose', () => releasePhoto(binding))
  return binding
}

/** Nothing of a picture that is no longer shown stays reachable from the material. */
function releasePhoto(binding: PhotoBinding): void {
  binding.photo = null
  binding.uniforms.photoMap.value = null
  binding.uniforms.photoFeatures.value = null
}

/** Project in the bind pose; interpolated coordinates follow every skinned vertex during animation. */
export function projectFace(material: THREE.MeshStandardMaterial, photo: FaceProjection, anchors: HeadAnchors, bind: THREE.Matrix4, fitted = false): void {
  const binding = photoBinding(material), uniforms = binding.uniforms
  binding.photo = photo
  uniforms.photoMap.value = photo.texture
  uniforms.photoFeatures.value = photo.featureTexture
  uniforms.photoHairline.value = photo.hairline
  uniforms.photoIris.value.set(photo.iris)
  uniforms.photoBeard.value = photo.hasBeard ? 1 : 0
  uniforms.photoBind.value.copy(bind)
  uniforms.photoSource.value.set(photo.chin, photo.mouth, photo.nose, photo.eyes)
  uniforms.photoTarget.value.set(anchors.chin, anchors.mouth, anchors.nose, anchors.eyes)
  uniforms.photoFit.value.set(photo.spread / anchors.spread, photo.mouthWidth / anchors.mouthWidth, photo.centre, anchors.front)
  uniforms.photoBrow.value.set(photo.brow, anchors.brow)
  // On a fitted head the eyeball takes the picture's own eye where the mask covers it, and keeps the
  // recoloured stock eye where it does not. The lids close over it, so a blink fades only the lids.
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = `${fitted ? 'attribute vec3 faceUv; attribute float faceEye; varying vec3 fittedFaceUv; varying float fittedEye;' : ''} uniform mat4 photoBind; varying vec3 photoPosition;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\nphotoPosition = (photoBind * vec4(position, 1.0)).xyz; ${fitted ? 'fittedFaceUv = faceUv; fittedEye = faceEye;' : ''}`)
    shader.fragmentShader = `${fitted ? 'varying vec3 fittedFaceUv; varying float fittedEye;' : ''} uniform sampler2D photoMap, photoFeatures;
      uniform float photoBeard, photoHairline;
      uniform vec3 photoIris;
      uniform float photoBlink;
      uniform vec4 photoSource, photoTarget, photoFit;
      uniform vec2 photoBrow;
      varying vec3 photoPosition;
      float photoBetween(float v, float a, float b, float c, float d) { return mix(c, d, (v-a)/(b-a)); }
      ${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      float py = photoPosition.y;
      float sy = py < photoTarget.y ? photoBetween(py, photoTarget.x, photoTarget.y, photoSource.x, photoSource.y)
        : py < photoTarget.z ? photoBetween(py, photoTarget.y, photoTarget.z, photoSource.y, photoSource.z)
        : py < photoTarget.w ? photoBetween(py, photoTarget.z, photoTarget.w, photoSource.z, photoSource.w)
        : photoBetween(py, photoTarget.w, photoBrow.y, photoSource.w, photoBrow.x);
      float sx = photoPosition.x * mix(photoFit.y, photoFit.x, smoothstep(photoTarget.y, photoTarget.w, py)) + photoFit.z;
      vec2 photoSample = ${fitted ? 'fittedFaceUv.xy' : 'vec2(sx / 1.5 + 0.5, sy / 1.5 + 0.5)'};
      photoSample.y += photoHairline / 1.5 * smoothstep(photoSource.w + 0.12, photoBrow.x, (photoSample.y - 0.5) * 1.5);
      vec4 portrait = texture2D(photoMap, photoSample);
      float front = ${fitted ? 'fittedFaceUv.z' : 'smoothstep(photoFit.w - 2.0, photoFit.w + 1.5, photoPosition.z)'};
      ${fitted ? 'sx = (fittedFaceUv.x - 0.5) * 1.5; sy = (fittedFaceUv.y - 0.5) * 1.5;' : ''}
      float eyes = (1.0 - smoothstep(0.04, 0.09, abs(sy - photoSource.w))) * (1.0 - smoothstep(0.07, 0.12, abs(abs(sx - photoFit.z) - photoFit.x * 3.0)));
      vec2 featureUv = photoSample;
      float feature = texture2D(photoFeatures, featureUv).a;
      float eyeSurface = ${fitted ? 'smoothstep(0.5, 0.9, fittedEye)' : '0.0'};
      float luminance = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      float iris = eyeSurface * smoothstep(0.003, 0.018, luminance) * (1.0 - smoothstep(0.18, 0.5, luminance));
      diffuseColor.rgb = mix(diffuseColor.rgb, photoIris * clamp(luminance / max(0.01, dot(photoIris, vec3(0.2126, 0.7152, 0.0722))), 0.3, 1.5), iris);
      float coverage = (1.0 - eyeSurface) * max(portrait.a * front, feature * smoothstep(0.05, 0.4, front));${fitted ? ' coverage += eyeSurface * portrait.a * front;' : ''}
      float jaw = photoBeard * (1.0 - smoothstep(photoTarget.x - 0.6, photoTarget.x + 1.5, photoPosition.y)) * smoothstep(photoTarget.x - 3.0, photoTarget.x - 1.0, photoPosition.y) * smoothstep(photoFit.w - 3.0, photoFit.w, photoPosition.z);
      diffuseColor.rgb *= 1.0 - jaw * 0.72;
      diffuseColor.rgb = mix(diffuseColor.rgb, portrait.rgb, coverage * (1.0 - eyes * photoBlink${fitted ? ' * (1.0 - eyeSurface)' : ''}));
    `)
  }
  material.customProgramCacheKey = () => fitted ? 'photo-head-fit-v4' : 'photo-head-v1'
  material.needsUpdate = true
}

export function clearFaceProjection(material: THREE.MeshStandardMaterial): void {
  const binding = photoBinding(material)
  releasePhoto(binding)
  // The plain head keeps the same objects in its uniform set: whichever set the renderer holds
  // when a picture is added again, the picture's program finds them there.
  material.onBeforeCompile = shader => { Object.assign(shader.uniforms, binding.uniforms) }
  material.customProgramCacheKey = () => 'head'
  material.needsUpdate = true
}

interface FaceBinding { indices: number[]; weights: number[]; influence: number; morphIndices?: number[]; morphWeights?: number[] }
interface BoundHead { geometry: THREE.BufferGeometry; bindings: FaceBinding[] }
const headBindings = new WeakMap<THREE.BufferGeometry, BoundHead>()
const facePoint = (points: ArrayLike<number>, index: number): THREE.Vector3 => new THREE.Vector3(points[index * 3]!, points[index * 3 + 1]!, points[index * 3 + 2]!)

function bindHead(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, canonical: readonly number[]): BoundHead {
  const cached = headBindings.get(geometry)
  if (cached) return cached
  const indices = geometry.index
  if (!indices) throw new Error('The character head has no triangle indices')
  const used = [...new Set(Array.from(indices.array))]
  const remap = new Map(used.map((index, i) => [index, i]))
  let compact = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const values = name === 'skinIndex' ? new Uint16Array(used.length * attribute.itemSize) : new Float32Array(used.length * attribute.itemSize)
    used.forEach((index, i) => {
      const components = [attribute.getX(index), attribute.getY(index), attribute.getZ(index), attribute.getW(index)]
      for (let c = 0; c < attribute.itemSize; c++) values[i * attribute.itemSize + c] = components[c]!
    })
    compact.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize))
  }
  compact.setIndex(Array.from(indices.array, index => remap.get(index)!))
  compact = mergeVertices(compact, 0.0001)
  const position = compact.getAttribute('position')
  const source = Array.from({ length: FACE_LANDMARKS }, (_, i) => facePoint(canonical, i))
  const cells = new Map<string, number[]>(), triangles = new Map<string, number[]>()
  const cell = (x: number, y: number): string => `${Math.floor(x)}|${Math.floor(y)}`
  source.forEach((point, index) => { const key = cell(point.x, point.y); const list = cells.get(key) ?? []; list.push(index); cells.set(key, list) })
  for (let t = 0; t < topology.triangles.length; t += 3) {
    const points = [0, 1, 2].map(i => source[topology.triangles[t + i]!]!)
    const minX = Math.floor(Math.min(...points.map(p => p.x))), maxX = Math.floor(Math.max(...points.map(p => p.x)))
    const minY = Math.floor(Math.min(...points.map(p => p.y))), maxY = Math.floor(Math.max(...points.map(p => p.y)))
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) { const key = cell(x, y); const list = triangles.get(key) ?? []; list.push(t); triangles.set(key, list) }
  }
  const edge = (source[234]!.z + source[454]!.z) / 2
  const bindings: FaceBinding[] = []
  for (let i = 0; i < position.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix)
    const nearby: number[] = []
    for (let x = Math.floor(point.x) - 2; x <= Math.floor(point.x) + 2; x++) for (let y = Math.floor(point.y) - 2; y <= Math.floor(point.y) + 2; y++) nearby.push(...(cells.get(cell(x, y)) ?? []))
    const candidates = nearby.length >= 16 ? nearby : source.map((_, i) => i)
    const nearest = candidates.map(index => { const p = source[index]!; return { index, d: (p.x - point.x) ** 2 + (p.y - point.y) ** 2 } }).sort((a, b) => a.d - b.d).slice(0, 16)
    const front = THREE.MathUtils.smoothstep(point.z, edge - 7, edge - 1)
    const falloff = 1 - THREE.MathUtils.smoothstep(Math.sqrt(nearest[0]!.d), 1.3, 5)
    const influence = front * falloff
    let binding: FaceBinding | null = null
    if (influence > 0) for (const t of triangles.get(cell(point.x, point.y)) ?? []) {
      const ai = topology.triangles[t]!, bi = topology.triangles[t + 1]!, ci = topology.triangles[t + 2]!
      const a = source[ai]!, b = source[bi]!, c = source[ci]!
      const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
      if (Math.abs(det) < 0.00001) continue
      const wa = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / det
      const wb = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / det
      const wc = 1 - wa - wb
      if (wa >= -0.0001 && wb >= -0.0001 && wc >= -0.0001) { binding = { indices: [ai, bi, ci], weights: [wa, wb, wc], influence }; break }
    }
    if (!binding) {
      const weights = nearest.map(p => 1 / Math.max(0.02, p.d))
      const sum = weights.reduce((a, b) => a + b, 0)
      binding = { indices: nearest.map(p => p.index), weights: weights.map(w => w / sum), influence }
    }
    binding.morphIndices = binding.indices
    binding.morphWeights = binding.weights
    bindings.push(binding)
  }
  const result = { geometry: compact, bindings }
  headBindings.set(geometry, result)
  return result
}

/** A private compact position/normal buffer; source skin weights, UVs and rigs remain unchanged. */
export function fitHeadGeometry(geometry: THREE.BufferGeometry, bind: THREE.Matrix4, canonical: readonly number[], scan: FaceScan, canonicalDepth?: readonly number[], appearance: AvatarAppearance = DEFAULT_APPEARANCE, eyeBones: readonly number[] = []): THREE.BufferGeometry {
  const source = decodeFacePoints(scan.mesh)
  const base = bindHead(geometry, bind, canonical)
  const fitted = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(base.geometry.attributes)) fitted.setAttribute(name, attribute.clone())
  fitted.setIndex(base.geometry.index!.clone())
  const sourceEyes = [33, 133, 362, 263].reduce((sum, index) => sum.add(facePoint(canonical, index)), new THREE.Vector3()).multiplyScalar(0.25)
  const photoEyes = [33, 133, 362, 263].reduce((sum, index) => sum.add(facePoint(source, index)), new THREE.Vector3()).multiplyScalar(0.25)
  const span = facePoint(canonical, 234).distanceTo(facePoint(canonical, 454))
  const photoWidth = facePoint(source, 234).distanceTo(facePoint(source, 454))
  const sourceHeight = facePoint(canonical, 10).y - facePoint(canonical, 152).y
  const photoHeight = facePoint(source, 10).y - facePoint(source, 152).y
  const widthFactor = THREE.MathUtils.clamp(Math.sqrt((sourceHeight / span) / (photoHeight / photoWidth)), 0.92, 1.16) * appearance.faceWidth
  const scale = span * widthFactor / Math.max(photoWidth, 0.1)
  const jawRatio = THREE.MathUtils.clamp((Math.abs(source[172 * 3]! - source[397 * 3]!) / photoWidth) / (Math.abs(canonical[172 * 3]! - canonical[397 * 3]!) / span), 0.88, 1.22) * appearance.jaw

  const referenceDepth = canonicalDepth ? [33, 133, 362, 263].reduce((sum, i) => sum + canonicalDepth[i]!, 0) / 4 : 0
  const targets = Array.from({ length: FACE_LANDMARKS }, (_, i) => {
    const old = facePoint(canonical, i), p = facePoint(source, i)
    return new THREE.Vector3(
      sourceEyes.x + (p.x - photoEyes.x) * scale * THREE.MathUtils.lerp(appearance.jaw, 1, THREE.MathUtils.smoothstep(p.y, source[152 * 3 + 1]!, photoEyes.y)),
      sourceEyes.y + (p.y - photoEyes.y) * scale * (p.y < photoEyes.y ? appearance.chin : 1),
      old.z + (canonicalDepth ? ((p.z - photoEyes.z) / photoWidth - (canonicalDepth[i]! - referenceDepth)) * span * 0.6 : 0),
    ).sub(old).clamp(new THREE.Vector3(-4, -4, -1.8), new THREE.Vector3(4, 4, 1.8))
  })
  const inverse = bind.clone().invert(), position = fitted.getAttribute('position'), uvs = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    const binding = base.bindings[i]!, point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(bind)
    const delta = new THREE.Vector3(), photo = new THREE.Vector3(), reference = new THREE.Vector3()
    binding.indices.forEach((index, n) => {
      const w = binding.weights[n]!
      photo.addScaledVector(facePoint(source, index), w)
      reference.addScaledVector(facePoint(canonical, index), w)
    })
    binding.morphIndices?.forEach((index, n) => delta.addScaledVector(targets[index]!, binding.morphWeights![n]!))
    // Extrapolate the photograph a little beyond the landmark oval for beard and hairline pixels.
    const px = photo.x + (point.x - reference.x) / scale
    const py = photo.y + (point.y - reference.y) / scale
    const chin = canonical[152 * 3 + 1]!, brow = canonical[10 * 3 + 1]!
    const headWeight = THREE.MathUtils.smoothstep(point.y, chin - 5, chin + 1)
    const lower = 1 - THREE.MathUtils.smoothstep(point.y, chin + 1, sourceEyes.y)
    const whole = (1 - binding.influence) * headWeight
    point.x = sourceEyes.x + (point.x - sourceEyes.x) * (1 + ((widthFactor - 1) + (jawRatio - 1) * lower * 0.55) * whole)
    if (point.y < sourceEyes.y) point.y += (point.y - sourceEyes.y) * (appearance.chin - 1) * whole
    const forehead = THREE.MathUtils.clamp((source[10 * 3 + 1]! - photoEyes.y) * scale / Math.max(1, brow - sourceEyes.y), 0.9, 1.14)
    if (point.y > sourceEyes.y) point.y += (point.y - sourceEyes.y) * (forehead - 1) * whole
    point.addScaledVector(delta, binding.influence).applyMatrix4(inverse)
    position.setXYZ(i, point.x, point.y, point.z)
    uvs.set([px / FACE_CROP_SPAN + 0.5, py / FACE_CROP_SPAN + 0.5, binding.influence], i * 3)
  }
  fitted.setAttribute('faceUv', new THREE.BufferAttribute(uvs, 3))
  const eye = new Float32Array(position.count), joints = fitted.getAttribute('skinIndex'), weights = fitted.getAttribute('skinWeight')
  for (let i = 0; i < position.count; i++) for (let c = 0; c < 4; c++) if (eyeBones.includes(joints.getComponent(i, c))) eye[i] = eye[i]! + weights.getComponent(i, c)
  fitted.setAttribute('faceEye', new THREE.BufferAttribute(eye, 1))
  // FBX repeats vertices at UV seams; accumulate by position to retain a smooth face after fitting.
  const sums = new Map<string, THREE.Vector3>(), keys: string[] = []
  for (let i = 0; i < position.count; i++) keys.push([position.getX(i), position.getY(i), position.getZ(i)].map(v => Math.round(v * 10000)).join('|'))
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3()
  const index = fitted.index!
  for (let i = 0; i < index.count; i += 3) {
    const ai = index.getX(i), bi = index.getX(i + 1), ci = index.getX(i + 2)
    a.fromBufferAttribute(position, ai); b.fromBufferAttribute(position, bi); c.fromBufferAttribute(position, ci)
    normal.crossVectors(b.sub(a), c.sub(a))
    for (const at of [ai, bi, ci]) { const key = keys[at]!; if (!sums.has(key)) sums.set(key, new THREE.Vector3()); sums.get(key)!.add(normal) }
  }
  const normals = fitted.getAttribute('normal')
  for (let i = 0; i < position.count; i++) {
    normal.fromBufferAttribute(normals, i).lerp(sums.get(keys[i]!)!.normalize(), base.bindings[i]!.influence).normalize()
    normals.setXYZ(i, normal.x, normal.y, normal.z)
  }
  fitted.computeBoundingSphere()
  return fitted
}

const fittingJobs: (() => void)[] = []
let fittingScheduled = false
/** Yield between people so a room of new faces cannot occupy one long browser task. */
export function scheduleFaceFit<T>(work: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    fittingJobs.push(() => { try { resolve(work()) } catch (error) { reject(error) } })
    if (fittingScheduled) return
    fittingScheduled = true
    const next = (): void => {
      fittingJobs.shift()?.()
      if (fittingJobs.length) setTimeout(next, 0)
      else fittingScheduled = false
    }
    setTimeout(next, 0)
  })
}
