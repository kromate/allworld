// Avatars: realistic rigged adults from the Microsoft Rocketbox library (MIT licence).
//
// A member picks one of the cast, then adjusts skin tone, clothing colour and height. Each
// avatar loads on demand from its own pack; the animation set is shared per skeleton.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import castIndex from '../assets/cast.index.json'
import type { AvatarBody, AvatarLook, FaceScan } from '../shared/model.ts'
import { loadPack, parseModel } from './packs.ts'
import type { Pack } from './packs.ts'
import { buildFaceProjection, projectFace, clearFaceProjection, fitHeadGeometry, decodeFacePoints, scheduleFaceFit } from './faces.ts'
import { createHair, disposeHair, createScalpHair } from './surfaceHair.ts'
import type { HairStyle } from './surfaceHair.ts'
import { compactIdentityStock, wrapSurfaceIdentityGeometry } from './surfaceIdentityWrap.ts'
import type { FittedSurfaceIdentity } from './avatarIdentity.ts'
import { eraseBakedScalp, paintClippedScalp, paintBeard, scalpFibreGeometry } from './surfaceScalp.ts'
import { applyBodyBuild, bodyBuildFade } from './surfaceBuild.ts'
import type { BuildFade } from './surfaceBuild.ts'
import { SeatedPose } from './avatarVehiclePose.ts'
import type { VehicleAvatarPose } from './avatarVehiclePose.ts'
import { confirmFaceTone, measureSkinTone, skinTransfer, toneSkin } from './surfaceAlbedo.ts'
import { parseAvatarAppearance } from '../shared/appearance.ts'
import type { AvatarAppearance } from '../shared/appearance.ts'
import type { FaceProjection, HeadAnchors } from './faces.ts'
import { outfit, outfitBodyGeometry, outfitMeshes, outfitOcclusion, paintOutfit } from './wardrobe.ts'

export type { VehicleAvatarPose } from './avatarVehiclePose.ts'
export type AvatarMotion = 'idle' | 'walk' | 'sprint' | 'sit' | 'wave' | 'nod' | 'work' | 'talk' | 'clap' | 'cheer' | 'dance'
const CLIP_FOR: Record<AvatarMotion, string> = { idle: 'idle', walk: 'walk', sprint: 'run', sit: 'sit', wave: 'wave', nod: 'nod', work: 'work', talk: 'talk', clap: 'clap', cheer: 'cheer', dance: 'dance' }

export interface CastMember {
  id: AvatarBody
  source: string
  sex: 'f' | 'm'
  eyes: { left: [number, number, number]; right: [number, number, number] }
  head: [number, number, number]
  root: [number, number, number]
  bounds: { min: [number, number, number]; max: [number, number, number] }
  skin: string
  hair: boolean
  faceLandmarks?: number[]
  faceLandmarkDepth?: number[]
}

export const CAST = castIndex as unknown as CastMember[]
export const castMember = (id: AvatarBody): CastMember => CAST.find(member => member.id === id) ?? CAST[0]!
export const portraitUrl = (id: AvatarBody): string => `/avatars/${castMember(id).id}.jpg`

/** Initial metadata-only suggestion within the member's chosen casting category. */
export function recommendCast(scan: FaceScan, skin: string, sex: 'f' | 'm'): AvatarBody {
  const target = rgb(skin), points = decodeFacePoints(scan.mesh)
  const proportions = (p: ArrayLike<number>): number[] => {
    const distance = (a: number, b: number): number => Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!)
    const width = Math.max(0.01, distance(234, 454))
    return [distance(10, 152), distance(33, 263), distance(172, 397), distance(61, 291), distance(98, 327)].map(v => v / width)
  }
  const desired = proportions(points)
  const score = (member: CastMember): number => {
    const colour = rgb(member.skin), shape = member.faceLandmarks ? proportions(member.faceLandmarks) : desired
    const skinDistance = Math.hypot(...colour.map((c, i) => c - target[i]!)) / 255
    const shapeDistance = Math.hypot(...shape.map((v, i) => (v - desired[i]!) * 3))
    // Prefer unobscured heads for a fitted face; this is a property of the supplied clothing/hair.
    const coverage = ['f06', 'm15', 'm18'].includes(member.id) ? 1 : member.hair ? 0.28 : 0
    return skinDistance * 0.5 + shapeDistance + coverage
  }
  const candidates = CAST.filter(member => member.sex === sex)
  return candidates.reduce((best, member) => score(member) < score(best) ? member : best, candidates[0] ?? CAST[0]!).id
}

/** Models are authored in centimetres. */
const UNIT = 0.01
/** Seconds a vehicle pose takes to come in over the sitting clip. */
const SEAT_BLEND = 0.3

interface Model { template: THREE.Object3D; body: ImageBitmap; head: ImageBitmap; headMask: ImageBitmap | null; hair: THREE.Texture | null; meta: CastMember; low: Map<string, THREE.BufferGeometry>; normals: Map<string, THREE.Texture>; skin: { head: string }; build: BuildFade }
const models = new Map<string, Promise<Model>>()

async function bitmap(pack: Pack, name: string, resizeQuality: ImageBitmapOptions['resizeQuality'] = 'high'): Promise<ImageBitmap> {
  const entry = pack.entries.get(name)
  if (!entry) throw new Error(`${name} is missing from the avatar pack`)
  const start = pack.base + entry.offset
  // The mesh keeps three.js texture coordinates (v up), so pictures are flipped once here.
  return createImageBitmap(new Blob([pack.bytes.slice(start, start + entry.length)], { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }), { imageOrientation: 'flipY', resizeWidth: 512, resizeHeight: 512, resizeQuality })
}

function plainTexture(source: TexImageSource | HTMLCanvasElement): THREE.Texture {
  const texture = source instanceof HTMLCanvasElement ? new THREE.CanvasTexture(source) : new THREE.Texture(source as ImageBitmap)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

function loadModel(id: AvatarBody): Promise<Model> {
  const meta = castMember(id)
  let pending = models.get(meta.id)
  if (!pending) {
    pending = (async () => {
      const pack = await loadPack(`/avatars/${meta.id}.pack.gz`)
      const [gltf, body, head] = await Promise.all([parseModel(pack, 'model.glb'), bitmap(pack, 'body.jpg'), bitmap(pack, 'head.jpg')])
      const headMask = pack.entries.has('head-skin-mask.png') ? await bitmap(pack, 'head-skin-mask.png', 'pixelated') : null
      let hair: THREE.Texture | null = null
      if (pack.entries.has('hair.jpg')) {
        // Hair cards ship as colour plus a separate alpha picture; join them once.
        const alphaName = pack.entries.has('hair-alpha.png') ? 'hair-alpha.png' : 'hair-alpha.jpg'
        const [colour, alpha] = await Promise.all([bitmap(pack, 'hair.jpg'), bitmap(pack, alphaName)])
        const canvas = document.createElement('canvas')
        canvas.width = colour.width
        canvas.height = colour.height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(alpha, 0, 0)
        const mask = context.getImageData(0, 0, canvas.width, canvas.height).data
        context.drawImage(colour, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
        for (let i = 0; i < mask.length; i += 4) pixels.data[i + 3] = mask[i]!
        context.putImageData(pixels, 0, 0)
        hair = plainTexture(canvas)
        colour.close()
        alpha.close()
      }
      const low = new Map<string, THREE.BufferGeometry>()
      if (pack.entries.has('model-lod.glb')) {
        const reduced = await parseModel(pack, 'model-lod.glb')
        reduced.scene.traverse(child => {
          if (child instanceof THREE.SkinnedMesh && !Array.isArray(child.material)) low.set(child.material.name, child.geometry)
        })
      }
      const normals = new Map<string, THREE.Texture>()
      for (const part of ['head', 'body']) {
        if (!pack.entries.has(`${part}-normal.jpg`)) continue
        const texture = plainTexture(await bitmap(pack, `${part}-normal.jpg`))
        texture.colorSpace = THREE.NoColorSpace
        normals.set(part, texture)
      }
      const skin = { head: stockSkin(sampleSkin(gltf.scene, head, 'head', meta), head, headMask, meta) }
      return { template: gltf.scene, body, head, headMask, hair, meta, low, normals, skin, build: bodyBuildFade(gltf.scene, meta) }
    })()
    models.set(meta.id, pending)
    pending.catch(() => models.delete(meta.id))
  }
  return pending
}

/**
 * The one stock tone both atlases are repainted from. Cheeks are what a chosen or photographed
 * tone describes; the masked head median stands in when they cannot be sampled or look implausible.
 */
function stockSkin(cheeks: string | null, head: ImageBitmap, headMask: ImageBitmap | null, meta: CastMember): string {
  if (!headMask) return cheeks ?? meta.skin
  const read = (image: ImageBitmap): Uint8ClampedArray => {
    const canvas = document.createElement('canvas')
    canvas.width = head.width; canvas.height = head.height
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    context.imageSmoothingEnabled = false
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return context.getImageData(0, 0, canvas.width, canvas.height).data
  }
  const mask = read(headMask)
  const masked = medianSkin(read(head), pixel => mask[pixel * 4]! >= 250, meta.skin)
  const sampled = cheeks ? rgb(cheeks) : null
  if (sampled?.every((value, channel) => value >= masked[channel]! * 0.75 && value <= masked[channel]! * 1.45)) return cheeks!
  return '#' + masked.map(value => value.toString(16).padStart(2, '0')).join('')
}

/** Sample visible cheeks and hands, rather than the atlas background or baked-in hair. */
function sampleSkin(scene: THREE.Object3D, image: ImageBitmap, part: 'head' | 'body', meta: CastMember): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const samples: number[][] = [[], [], []]
  const point = new THREE.Vector3(), normal = new THREE.Vector3()
  scene.updateMatrixWorld(true)
  scene.traverse(child => {
    if (!(child instanceof THREE.SkinnedMesh) || Array.isArray(child.material) || child.material.name !== part) return
    const position = child.geometry.getAttribute('position'), normals = child.geometry.getAttribute('normal'), uv = child.geometry.getAttribute('uv')
    const indices = child.geometry.index
    if (!uv || !normals || !indices) return
    const transform = new THREE.Matrix3().getNormalMatrix(child.matrixWorld)
    const seen = new Set<number>()
    for (let i = 0; i < indices.count; i++) {
      const index = indices.getX(i)
      if (seen.has(index)) continue
      seen.add(index)
      point.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld)
      normal.fromBufferAttribute(normals, index).applyMatrix3(transform)
      const x = Math.abs(point.x)
      const cheek = x > 2 && x < 5.5 && point.y > meta.eyes.left[1] - 4.5 && point.y < meta.eyes.left[1] - 1.5 && point.z > meta.eyes.left[2]
      const hand = x > Math.max(Math.abs(meta.bounds.min[0]), Math.abs(meta.bounds.max[0])) * 0.93 && point.y > 100
      if (!(part === 'head' ? cheek : hand) || normal.z < 0.2) continue
      const u = Math.min(image.width - 1, Math.max(0, Math.round(uv.getX(index) * image.width)))
      const v = Math.min(image.height - 1, Math.max(0, Math.round(uv.getY(index) * image.height)))
      const at = (v * image.width + u) * 4
      if (pixels[at]! < 25) continue
      for (let c = 0; c < 3; c++) samples[c]!.push(pixels[at + c]!)
    }
  })
  if (samples[0]!.length < 5) return null
  return '#' + samples.map(values => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]!.toString(16).padStart(2, '0') }).join('')
}

// ── Animation clips, shared per skeleton ──

const clipSets = new Map<string, Promise<Map<string, THREE.AnimationClip>>>()

function loadClips(sex: 'f' | 'm'): Promise<Map<string, THREE.AnimationClip>> {
  let pending = clipSets.get(sex)
  if (!pending) {
    pending = (async () => {
      const pack = await loadPack(`/avatars/clips-${sex}.pack.gz`)
      const index = pack.entries.get('index')!.meta as { bones: string[]; fps: number; rootReference: number[] | null }
      const clips = new Map<string, THREE.AnimationClip>()
      for (const entry of pack.entries.values()) {
        if (entry.name === 'index') continue
        const meta = entry.meta as { frames: number; duration: number; rotationBytes: number; loop: boolean; groundSpeed?: number }
        const start = pack.base + entry.offset
        const bytes = pack.bytes.slice(start, start + entry.length)
        const rotations = new Int16Array(bytes.buffer, 0, meta.rotationBytes / 2)
        const root = new Float32Array(bytes.buffer.slice(meta.rotationBytes))
        const times = new Float32Array(meta.frames)
        for (let f = 0; f < meta.frames; f++) times[f] = (f / (meta.frames - 1)) * meta.duration
        const tracks: THREE.KeyframeTrack[] = index.bones.map((bone, b) => {
          const values = new Float32Array(meta.frames * 4)
          for (let f = 0; f < meta.frames; f++) for (let c = 0; c < 4; c++) values[f * 4 + c] = rotations[(f * index.bones.length + b) * 4 + c]! / 32767
          return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values)
        })
        // The hips move relative to the clip's own standing height, so any avatar keeps its feet on the ground.
        const reference = index.rootReference ?? [root[0]!, root[1]!, root[2]!]
        const offsets = new Float32Array(root.length)
        for (let i = 0; i < root.length; i++) offsets[i] = root[i]! - reference[i % 3]!
        const clip = new THREE.AnimationClip(entry.name, meta.duration, tracks)
        clip.userData = { rootOffsets: offsets, times, loop: meta.loop, groundSpeed: meta.groundSpeed }
        clips.set(entry.name, clip)
      }
      return clips
    })()
    clipSets.set(sex, pending)
    pending.catch(() => clipSets.delete(sex))
  }
  return pending
}

// ── Look: exact body skin masks, original clothing colour, and wardrobe packs ──

const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
interface BodyMask { width: number; height: number; labels: Uint8Array }
const bodyMasks = new Map<AvatarBody, Promise<BodyMask>>()

function bodyMask(body: AvatarBody): Promise<BodyMask> {
  let pending = bodyMasks.get(body)
  if (!pending) {
    pending = (async () => {
      const pack = await loadPack('/wardrobe/masks.pack.gz')
      const entry = pack.entries.get(`${body}.png`)
      if (!entry) throw new Error(`Skin mask for ${body} is missing`)
      const start = pack.base + entry.offset
      const image = await createImageBitmap(new Blob([pack.bytes.slice(start, start + entry.length)], { type: 'image/png' }))
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        const labels = new Uint8Array(canvas.width * canvas.height)
        for (let i = 0; i < labels.length; i++) {
          const at = i * 4, red = pixels[at], green = pixels[at + 1], blue = pixels[at + 2]
          labels[i] = red === 237 && green === 165 && blue === 143 ? 1
            : red === 47 && green === 177 && blue === 220 ? 2
              : red === 181 && green === 133 && blue === 237 ? 3
                : red === 248 && green === 202 && blue === 81 ? 4 : red || green || blue ? 5 : 0
        }
        return { width: canvas.width, height: canvas.height, labels }
      } finally { image.close() }
    })()
    bodyMasks.set(body, pending)
    void pending.catch(() => { if (bodyMasks.get(body) === pending) bodyMasks.delete(body) })
  }
  return pending
}

/** Preserve skin at downsampled atlas edges without expanding into clothing or trim. */
function bodyLabelAt(mask: BodyMask, x: number, y: number, size: number): number {
  const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) * mask.width / size))
  const my = Math.min(mask.height - 1, Math.floor((y + 0.5) * mask.height / size))
  const centre = mask.labels[my * mask.width + mx]!
  if (centre || size >= mask.width) return centre
  const left = Math.floor(x * mask.width / size), right = Math.min(mask.width, Math.ceil((x + 1) * mask.width / size))
  const top = Math.floor(y * mask.height / size), bottom = Math.min(mask.height, Math.ceil((y + 1) * mask.height / size))
  let skin = false
  for (let row = top; row < bottom; row++) for (let column = left; column < right; column++) {
    const label = mask.labels[row * mask.width + column]!
    if (label > 1) return 0
    if (label === 1) skin = true
  }
  return skin ? 1 : 0
}

function medianSkin(data: Uint8ClampedArray, eligible: (pixel: number) => boolean, fallback: string): [number, number, number] {
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let count = 0
  for (let pixel = 0; pixel < data.length / 4; pixel++) {
    if (!eligible(pixel)) continue
    const at = pixel * 4
    if (data[at]! + data[at + 1]! + data[at + 2]! < 30) continue
    for (let channel = 0; channel < 3; channel++) bins[channel]![data[at + channel]!]!++
    count++
  }
  if (!count) return rgb(fallback)
  const median = (histogram: Uint32Array): number => {
    let total = 0
    for (let value = 0; value < 256; value++) { total += histogram[value]!; if (total >= count / 2) return value }
    return 255
  }
  return [median(bins[0]!), median(bins[1]!), median(bins[2]!)]
}

function turnPixel(data: Uint8ClampedArray, at: number, hue: number): void {
  const r = data[at]!, g = data[at + 1]!, b = data[at + 2]!
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (max - min < 18) return
  const l = (max + min) / 510, d = (max - min) / 255
  const s = d / (1 - Math.abs(2 * l - 1) || 1)
  let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4
  h = (h / 6 + hue / 360 + 2) % 1
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = l - c / 2
  const [rr, gg, bb] = h < 1 / 6 ? [c, x, 0] : h < 2 / 6 ? [x, c, 0] : h < 3 / 6 ? [0, c, x] : h < 4 / 6 ? [0, x, c] : h < 5 / 6 ? [x, 0, c] : [c, 0, x]
  data[at] = (rr + m) * 255; data[at + 1] = (gg + m) * 255; data[at + 2] = (bb + m) * 255
}

function replacesScalp(look: AvatarLook): boolean { return Boolean(look.appearance?.hairStyle && look.appearance.hairStyle !== 'auto' && !['f06', 'm15', 'm18'].includes(look.body)) }

function scalpKey(look: AvatarLook): string {
  if (!replacesScalp(look)) return `${look.appearance?.beard ?? ''}|${look.appearance?.hairColour ?? ''}`
  const a = look.appearance!
  const beard = `|${a.beard}|${a.hairColour ?? ''}`
  return (a.hairStyle === 'bald' || a.hairStyle === 'head-wrap' ? 'clear' : `${a.hairStyle === 'fade' ? 'fade' : 'low-cut'}|${a.hairColour ?? '#211713'}|${a.hairline}`) + beard
}

function paintHead(model: Model, look: AvatarLook, size: number): THREE.Texture {
  if (!look.skin && !replacesScalp(look) && !['on', 'chin-strap'].includes(look.appearance?.beard ?? '') && size === model.head.width) return plainTexture(model.head)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(model.head, 0, 0, size, size)
  if (look.skin) {
    const pixels = context.getImageData(0, 0, size, size), data = pixels.data
    // The same transfer as the body, so the neck seam and the hands follow the face at any tone.
    const transfer = skinTransfer(rgb(model.skin.head), rgb(look.skin))
    if (model.headMask) {
      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = maskCanvas.height = size
      const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })!
      maskContext.imageSmoothingEnabled = false
      maskContext.drawImage(model.headMask, 0, 0, size, size)
      const mask = maskContext.getImageData(0, 0, size, size).data
      for (let pixel = 0; pixel < size * size; pixel++) {
        // The mask's gutter is 0.85 of its edge. Seam texels are repainted in full, or a line of stock tone stays round the neck.
        const opacity = Math.min(1, mask[pixel * 4]! / 216)
        if (opacity) toneSkin(data, pixel * 4, transfer, opacity)
      }
    } else {
      const [cr, cg, cb] = rgb(model.skin.head), sumBase = cr + cg + cb
      for (let at = 0; at < data.length; at += 4) {
        const r = data[at]!, g = data[at + 1]!, b = data[at + 2]!, sum = r + g + b
        if (sum < 30) continue
        const distance = Math.hypot(r / sum - cr / sumBase, g / sum - cg / sumBase)
        const opacity = distance < 0.035 ? 1 : distance > 0.085 ? 0 : 1 - (distance - 0.035) / 0.05
        if (opacity) toneSkin(data, at, transfer, opacity)
      }
    }
    context.putImageData(pixels, 0, 0)
  }
  if (replacesScalp(look)) eraseBakedScalp(canvas, model.template, model.meta, look.skin ?? model.skin.head)
  const a = look.appearance
  if (replacesScalp(look) && a && a.hairStyle !== 'bald' && a.hairStyle !== 'head-wrap') paintClippedScalp(canvas, model.template, model.meta, a.hairColour ?? '#211713', a.hairStyle === 'fade' ? 'fade' : 'low-cut', a.hairline)
  if (a?.beard === 'on' || a?.beard === 'chin-strap') paintBeard(canvas, model.template, model.meta, a.hairColour ?? '#241c18', a.beard)
  return plainTexture(canvas)
}

async function paintBody(model: Model, look: AvatarLook, size: number): Promise<THREE.Texture> {
  const selected = look.outfit ? outfit(look.outfit) : null
  if (look.outfit && (!selected || !selected.fits.includes(look.body))) throw new Error('This outfit is not available for this character.')
  if (!look.skin && !selected && look.outfitHue === 0 && size === model.body.width) return plainTexture(model.body)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.save()
  context.translate(0, size); context.scale(1, -1)
  context.drawImage(model.body, 0, 0, size, size)
  context.restore()
  if (look.skin || (!selected && look.outfitHue !== 0)) {
    const mask = await bodyMask(look.body)
    const pixels = context.getImageData(0, 0, size, size), data = pixels.data
    const labelAt = (pixel: number): number => {
      const x = pixel % size, y = Math.floor(pixel / size)
      return bodyLabelAt(mask, x, y, size)
    }
    // Not the body's own median: hands, arms and legs are repainted from the stock face tone.
    const transfer = look.skin ? skinTransfer(rgb(model.skin.head), rgb(look.skin)) : null
    for (let pixel = 0; pixel < size * size; pixel++) {
      const label = labelAt(pixel), at = pixel * 4
      if (label === 1 && transfer) toneSkin(data, at, transfer)
      else if (label >= 2 && label <= 4 && !selected && look.outfitHue !== 0) turnPixel(data, at, look.outfitHue)
    }
    context.putImageData(pixels, 0, 0)
  }
  if (selected) await paintOutfit(context, look.body, selected.id)
  const flipped = document.createElement('canvas')
  flipped.width = flipped.height = size
  const display = flipped.getContext('2d')!
  display.translate(0, size); display.scale(1, -1)
  display.drawImage(canvas, 0, 0)
  return plainTexture(flipped)
}

interface PaintedEntry { users: number; texture: THREE.Texture | null; pending: Promise<THREE.Texture> }
const painted = new Map<string, PaintedEntry>()
function acquireTexture(model: Model, look: AvatarLook, part: 'head' | 'body', size: number): { key: string; ready: Promise<THREE.Texture> } {
  const key = `${model.meta.id}|${part}|${look.skin ?? ''}|${part === 'body' ? `${look.outfit ?? ''}|${look.outfit ? 0 : look.outfitHue}` : scalpKey(look)}|${size}`
  let entry = painted.get(key)
  if (!entry) {
    const pending = Promise.resolve().then(() => part === 'head' ? paintHead(model, look, size) : paintBody(model, look, size))
    entry = { users: 0, texture: null, pending }
    const created = entry
    painted.set(key, created)
    void pending.then(texture => {
      created.texture = texture
      if (created.users === 0) { texture.dispose(); if (painted.get(key) === created) painted.delete(key) }
    }).catch(() => { if (painted.get(key) === created) painted.delete(key) })
  }
  entry.users++
  return { key, ready: entry.pending }
}
function releaseTexture(key: string): void {
  const entry = painted.get(key)
  if (!entry || --entry.users > 0) return
  if (entry.texture) { entry.texture.dispose(); painted.delete(key) }
}

interface ActorMesh { mesh: THREE.SkinnedMesh; full: THREE.BufferGeometry; low: THREE.BufferGeometry }
interface BodyCover { entry: ActorMesh; baseFull: THREE.BufferGeometry; baseLow: THREE.BufferGeometry; coveredFull: THREE.BufferGeometry; coveredLow: THREE.BufferGeometry }
interface HairCover { entry: ActorMesh; visible: boolean }
interface WardrobeStage { outfitId: string | null; textureKeys: string[]; scenes: THREE.Object3D[]; skeletons: Set<THREE.Skeleton>; covers: BodyCover[]; hair: HairCover[]; attached: boolean }
interface PreparedLook { reuseWardrobe: boolean; keys: string[]; head: THREE.Texture; body: THREE.Texture; wardrobe: WardrobeStage; skin: string | null }
async function prepareLook(model: Model, look: AvatarLook, size: number, reuseWardrobe = false): Promise<PreparedLook> {
  const head = acquireTexture(model, look, 'head', size)
  const body = acquireTexture(model, look, 'body', size)
  try {
    const [headTexture, bodyTexture] = await Promise.all([head.ready, body.ready])
    const scenes = !reuseWardrobe && look.outfit ? await outfitMeshes(look.body, look.outfit) : []
    const wardrobe: WardrobeStage = { outfitId: look.outfit ?? null, textureKeys: [], scenes, skeletons: new Set(), covers: [], hair: [], attached: false }
    shareWardrobeTextures(wardrobe, look.body)
    return { reuseWardrobe, keys: [head.key, body.key], head: headTexture, body: bodyTexture, wardrobe, skin: look.skin ?? null }
  } catch (error) {
    releaseTexture(head.key); releaseTexture(body.key)
    throw error
  }
}
const wardrobeTextures = new Map<string, { texture: THREE.Texture; users: number }>()
const wardrobeTextureRefs = new Map<THREE.Texture, number>()
const surfaceMaps = ['map', 'normalMap', 'roughnessMap', 'aoMap'] as const
function shareWardrobeTextures(stage: WardrobeStage, body: AvatarBody): void {
  const materials = new Set<THREE.MeshStandardMaterial>()
  for (const scene of stage.scenes) scene.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material instanceof THREE.MeshStandardMaterial) materials.add(material)
  })
  const originals = new Set<THREE.Texture>()
  let index = 0
  for (const material of materials) {
    for (const property of surfaceMaps) {
      const texture = material[property]
      if (!texture) continue
      originals.add(texture)
      const key = `${body}|${stage.outfitId}|${index}|${property}`
      let cached = wardrobeTextures.get(key)
      if (!cached) {
        cached = { texture, users: 0 }; wardrobeTextures.set(key, cached)
        wardrobeTextureRefs.set(texture, (wardrobeTextureRefs.get(texture) ?? 0) + 1)
      }
      cached.users++
      stage.textureKeys.push(key)
      material[property] = cached.texture
    }
    index++
  }
  for (const texture of originals) if (!wardrobeTextureRefs.has(texture)) texture.dispose()
}
function releaseWardrobeTexture(key: string): void {
  const cached = wardrobeTextures.get(key)
  if (!cached || --cached.users > 0) return
  wardrobeTextures.delete(key)
  const remaining = (wardrobeTextureRefs.get(cached.texture) ?? 1) - 1
  if (remaining > 0) wardrobeTextureRefs.set(cached.texture, remaining)
  else { wardrobeTextureRefs.delete(cached.texture); cached.texture.dispose() }
}

function releasePrepared(prepared: PreparedLook): void {
  for (const key of prepared.keys) releaseTexture(key)
  disposeWardrobe(prepared.wardrobe)
}
function disposeWardrobe(stage: WardrobeStage): void {
  if (stage.attached) {
    for (const cover of stage.covers) {
      cover.entry.full = cover.baseFull; cover.entry.low = cover.baseLow
      cover.entry.mesh.geometry = cover.entry.mesh.geometry === cover.coveredLow ? cover.baseLow : cover.baseFull
    }
    for (const cover of stage.hair) cover.entry.mesh.visible = cover.visible
  }
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  for (const scene of stage.scenes) {
    scene.removeFromParent()
    scene.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return
      geometries.add(node.geometry)
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        materials.add(material)
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
      }
    })
  }
  for (const cover of stage.covers) { geometries.add(cover.coveredFull); geometries.add(cover.coveredLow) }
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  const unshared = [...textures].filter(texture => !wardrobeTextureRefs.has(texture))
  for (const key of stage.textureKeys) releaseWardrobeTexture(key)
  stage.textureKeys = []
  for (const texture of unshared) texture.dispose()
  for (const skeleton of stage.skeletons) skeleton.dispose()
  stage.scenes = []; stage.covers = []; stage.hair = []; stage.skeletons.clear(); stage.attached = false
}

async function stageWardrobe(prepared: PreparedLook, rig: THREE.Object3D, entries: ActorMesh[], look: AvatarLook, active?: WardrobeStage | null): Promise<void> {
  if (!look.outfit || prepared.reuseWardrobe) return
  const stage = prepared.wardrobe
  const bones = new Map<string, THREE.Bone>()
  const actorSkeletons = new Set<THREE.Skeleton>()
  rig.traverse(node => { if (node instanceof THREE.Bone) bones.set(node.name, node); if (node instanceof THREE.SkinnedMesh) actorSkeletons.add(node.skeleton) })
  const reusable = [...actorSkeletons]
  for (const scene of stage.scenes) scene.traverse(node => {
    if (!(node instanceof THREE.SkinnedMesh)) return
    const source = node.skeleton
    stage.skeletons.add(source)
    const mapped = source.bones.map(bone => {
      const target = bones.get(bone.name)
      if (!target) throw new Error(`Outfit needs missing bone ${bone.name}`)
      return target
    })
    let skeleton = reusable.find(candidate => mapped.length === candidate.bones.length && mapped.every((bone, i) => bone === candidate.bones[i] && source.boneInverses[i]!.equals(candidate.boneInverses[i]!)))
    if (!skeleton) { skeleton = new THREE.Skeleton(mapped, source.boneInverses.map(matrix => matrix.clone())); reusable.push(skeleton); stage.skeletons.add(skeleton) }
    const bind = node.bindMatrix.clone(), mode = node.bindMode
    node.bind(skeleton, bind)
    node.bindMode = mode
  })
  const occlusion = outfitOcclusion(look.body, look.outfit)
  if (occlusion.hair) stage.hair = entries.filter(entry => !Array.isArray(entry.mesh.material) && entry.mesh.material.name === 'hair').map(entry => ({ entry, visible: active?.hair.find(cover => cover.entry === entry)?.visible ?? entry.mesh.visible }))
  if (!occlusion.bodyClasses.length) return
  for (const entry of entries) {
    if (Array.isArray(entry.mesh.material) || entry.mesh.material.name !== 'body') continue
    const previous = active?.covers.find(cover => cover.entry === entry)
    const baseFull = previous?.baseFull ?? entry.full, baseLow = previous?.baseLow ?? entry.low
    const full = await outfitBodyGeometry(baseFull, look.body, look.outfit)
    if (!full) throw new Error('Outfit body coverage is missing')
    let low: THREE.BufferGeometry
    try {
      if (baseLow === baseFull) low = full
      else {
        const coveredLow = await outfitBodyGeometry(baseLow, look.body, look.outfit)
        if (!coveredLow) throw new Error('Reduced outfit body coverage is missing')
        low = coveredLow
      }
    }
    catch (error) { full.dispose(); throw error }
    stage.covers.push({ entry, baseFull, baseLow, coveredFull: full, coveredLow: low })
  }
}

/** Preload what an avatar needs, so the first frame it appears in is complete. */
export async function loadAvatarLibrary(): Promise<void> { await Promise.all([loadClips('f'), loadClips('m')]) }

interface StagedRig { rig: THREE.Object3D; materials: THREE.MeshStandardMaterial[]; meshes: ActorMesh[] }
function disposeStagedRig(staged: StagedRig): void {
  const skeletons = new Set<THREE.Skeleton>()
  staged.rig.traverse(node => { if (node instanceof THREE.SkinnedMesh) skeletons.add(node.skeleton) })
  for (const skeleton of skeletons) skeleton.dispose()
  for (const material of staged.materials) material.dispose()
}

/**
 * One attempt to prepare a picture. `generation` fences it against newer ones, `tone` is the skin
 * tone its picture was built to show, and `staged` settles when it is ready to mount or has failed.
 */
interface FaceJob { generation: number; tone: string | null; state: 'building' | 'staged' | 'mounted' | 'failed'; staged: Promise<void> }

export class AvatarActor {
  readonly group = new THREE.Group()
  private readonly scaler = new THREE.Group()
  private rig: THREE.Object3D | null = null
  private root: THREE.Object3D | null = null
  private rootBind = new THREE.Vector3()
  private mixer: THREE.AnimationMixer | null = null
  private actions = new Map<string, THREE.AnimationAction>()
  private current: THREE.AnimationAction | null = null
  private materials: THREE.MeshStandardMaterial[] = []
  private textureKeys: string[] = []
  private activeWardrobe: WardrobeStage | null = null
  private motion: AvatarMotion = 'idle'
  private oneShotUntil = 0
  private look: AvatarLook
  private model: Model | null = null
  private face: FaceProjection | null = null
  private faceFitDirty = true
  private identityFit: FittedSurfaceIdentity | null = null
  private appearance: AvatarAppearance = parseAvatarAppearance(undefined)
  private hairGroup: THREE.Group | null = null
  private hairKey = ''
  private faceGeneration = 0
  /** Resolves when the photo texture is ready. */
  faceReady: Promise<void> = Promise.resolve()
  private faceKey = ''
  private faceScan: { scan: FaceScan; key: string } | null = null
  /** The tone the mounted photo shows, measured once per scan; it paints the body until a tone is chosen. */
  private faceTone: string | null = null
  private faceCanvas: HTMLCanvasElement | null = null
  private paintedSkin: string | null = null
  private toneReady: Promise<void> = Promise.resolve()
  /** The latest attempt to prepare a picture. What is shown changes only when one is mounted. */
  private faceJob: FaceJob | null = null
  /** The tone an untracked repaint is working on; `undefined` when none is. */
  private tonePainting: string | null | undefined = undefined
  private disposed = false
  private generation = 0
  private lookGeneration = 0
  lookReady: Promise<void> = Promise.resolve()
  lookLoading = false
  lookError = ''
  private detail: 'auto' | 'full' | 'reduced' = 'auto'
  private distance = 0
  private reduced = false
  private textureSize = 512
  private elapsed = 0
  private blinkClock = Math.random() * 3
  private blinkAt = 3 + Math.random() * 2
  private eyelids: { bone: THREE.Object3D; bind: THREE.Vector3; offset: THREE.Vector3 }[] = []
  private meshes: ActorMesh[] = []
  private fittedHeads: { entry: { mesh: THREE.SkinnedMesh; full: THREE.BufferGeometry; low: THREE.BufferGeometry }; full: THREE.BufferGeometry; low: THREE.BufferGeometry }[] = []
  private travelSpeed: number | null = null
  /** The seat the actor is in, and the posing of its bones. Cleared on exit, and with the rig it was made for. */
  private vehicle: VehicleAvatarPose | null = null
  private seated: SeatedPose | null = null
  private seatBlend = 0
  private placeholder: THREE.Mesh | null = null
  /** Resolves once the model is on screen. */
  ready: Promise<void>

  constructor(look: AvatarLook) {
    this.look = look
    this.appearance = parseAvatarAppearance('appearance' in look ? look.appearance : undefined)
    this.group.add(this.scaler)
    this.placeholder = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 1.05, 3, 6), new THREE.MeshStandardMaterial({ color: '#8b929e', roughness: 1 }))
    this.placeholder.position.y = 0.78
    this.group.add(this.placeholder)
    this.ready = this.beginLook(token => this.rebuild(token))
  }

  static async create(look: AvatarLook): Promise<AvatarActor> {
    const actor = new AvatarActor(look)
    await actor.ready
    return actor
  }

  /** Standing height in metres, for name tags and camera framing. */
  /** A failed replacement look may leave the previous character visible. */
  get shown(): boolean { return this.rig !== null && !this.disposed }

  get height(): number { return castMember(this.look.body).bounds.max[2] * UNIT * this.look.height }

  private beginLook(work: (token: number) => Promise<void>): Promise<void> {
    const token = ++this.lookGeneration
    this.lookLoading = true
    this.lookError = ''
    const pending = work(token).then(() => {
      if (this.disposed || token !== this.lookGeneration) return
      this.lookLoading = false
      this.lookError = ''
      this.syncTone()
    }).catch((error: unknown) => {
      if (this.disposed || token !== this.lookGeneration) return
      this.lookLoading = false
      this.lookError = error instanceof Error ? error.message : 'The clothes could not load.'
      throw error
    })
    this.lookReady = pending
    void pending.catch(() => {})
    return pending
  }

  /** A member's chosen tone wins. Without one, a mounted photo sets the tone of the whole body. */
  private paintLook(): AvatarLook {
    const look = { ...this.look }
    if (!look.skin && this.faceScan && this.faceTone) look.skin = this.faceTone
    return look
  }

  /** A photo's tone is known only after it is analysed; repaint skin that was painted before then. */
  private syncTone(): void {
    const model = this.model
    if (this.disposed || this.lookLoading || !model || !this.rig || model.meta.id !== this.look.body) return
    const skin = this.paintLook().skin ?? null
    if (skin === this.paintedSkin || (this.tonePainting !== undefined && skin === this.tonePainting)) return
    this.tonePainting = skin
    // Not a new look: `ready` and `lookReady` keep their identity for callers that track them.
    const pending: Promise<void> = this.applyLook(++this.lookGeneration).catch(() => {}).then(() => { if (this.toneReady === pending) this.tonePainting = undefined })
    this.toneReady = pending
  }

  private async rebuild(token: number): Promise<void> {
    const mine = ++this.generation
    const look = this.paintLook()
    const meta = castMember(look.body)
    const size = this.detail === 'reduced' || (this.detail === 'auto' && this.reduced) ? 256 : 512
    this.textureSize = size
    const [model, clips] = await Promise.all([loadModel(look.body), loadClips(meta.sex)])
    if (this.disposed || mine !== this.generation || token !== this.lookGeneration) return
    const staged = this.makeRig(model)
    let prepared: PreparedLook | null = null
    let outfitError: unknown = null
    try {
      prepared = await prepareLook(model, look, size)
      await stageWardrobe(prepared, staged.rig, staged.meshes, look)
    }
    catch (error) {
      if (prepared) releasePrepared(prepared)
      if (!look.outfit) { disposeStagedRig(staged); throw error }
      outfitError = error
      try { prepared = await prepareLook(model, { ...look, outfit: null }, size) }
      catch (fallbackError) { disposeStagedRig(staged); throw fallbackError }
    }
    if (this.disposed || mine !== this.generation || token !== this.lookGeneration) { releasePrepared(prepared); disposeStagedRig(staged); return }
    // The picture changed while this was loading: paint again, so the new rig never shows the old picture's tone.
    if ((this.paintLook().skin ?? null) !== prepared.skin) { releasePrepared(prepared); disposeStagedRig(staged); return this.rebuild(token) }
    this.clearRig()
    this.model = model
    this.rig = staged.rig
    this.meshes = staged.meshes
    this.materials = staged.materials
    this.removePlaceholder()
    this.eyelids = []
    this.rig.updateMatrixWorld(true)
    for (const side of ['L', 'R']) for (const part of ['Top', 'Bottom']) {
      const bone = this.rig.getObjectByName(`Bip01_${side}EyeBlink${part}`)
      if (bone?.parent) {
        const offset = new THREE.Vector3(0, part === 'Top' ? -0.95 : 0.4, 0.06).applyQuaternion(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
        this.eyelids.push({ bone, bind: bone.position.clone(), offset })
      }
    }
    this.applyPrepared(prepared)
    this.applyAppearance()
    this.scaler.scale.setScalar(UNIT * this.look.height)
    this.scaler.add(this.rig)
    this.root = this.rig.getObjectByName('Bip01') ?? null
    if (this.root) this.rootBind.copy(this.root.position)
    this.mixer = new THREE.AnimationMixer(this.rig)
    for (const clip of clips.values()) this.actions.set(clip.name, this.mixer.clipAction(clip))
    this.current = null
    this.play(this.playing, 0)
    this.mixer.update(0)
    if (this.faceScan) { this.faceKey = this.faceScan.key; this.mountFace(this.faceScan.scan, this.faceScan.key) }
    if (outfitError) throw outfitError
  }

  private makeRig(model: Model): StagedRig {
    const rig = cloneSkinned(model.template)
    const materials: THREE.MeshStandardMaterial[] = []
    const meshes: ActorMesh[] = []
    let skeleton: THREE.Skeleton | null = null
    rig.traverse(child => {
      const mesh = child as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      const shared = skeleton
      if (shared && mesh.skeleton.bones.every((bone, i) => bone === shared.bones[i])) mesh.skeleton = shared
      else skeleton = mesh.skeleton
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = true
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 90), 125)
      // One material per slot name, shared by every piece of the mesh that uses it.
      const slot = (Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material).name
      let material = materials.find(entry => entry.name === slot)
      if (!material) {
        material = new THREE.MeshStandardMaterial({ name: slot, roughness: slot === 'head' ? 0.62 : 0.86, metalness: 0 })
        material.normalMap = model.normals.get(slot) ?? null
        material.normalScale.set(0.55, 0.55)
        if (slot === 'hair') {
          material.map = model.hair
          material.alphaTest = 0.38
          material.alphaToCoverage = true
          material.side = THREE.DoubleSide
          material.roughness = 0.7
        }
        materials.push(material)
      }
      mesh.material = material
      meshes.push({ mesh, full: mesh.geometry, low: model.low.get(slot) ?? mesh.geometry })
      mesh.onBeforeRender = (_renderer, _scene, camera) => {
        const a = this.group.matrixWorld.elements, b = camera.matrixWorld.elements
        this.distance = Math.hypot(a[12]! - b[12]!, a[13]! - b[13]!, a[14]! - b[14]!)
      }
    })
    return { rig, materials, meshes }
  }

  private applyPrepared(prepared: PreparedLook): void {
    const previousKeys = this.textureKeys
    const previousWardrobe = this.activeWardrobe
    if (previousWardrobe && !prepared.reuseWardrobe) disposeWardrobe(previousWardrobe)
    for (const material of this.materials) {
      if (material.name !== 'head' && material.name !== 'body') continue
      material.map = material.name === 'head' ? prepared.head : prepared.body
      material.needsUpdate = true
    }
    this.textureKeys = prepared.keys
    this.paintedSkin = prepared.skin
    if (!prepared.reuseWardrobe) {
      const wardrobe = prepared.wardrobe
      for (const cover of wardrobe.covers) {
        cover.entry.full = cover.coveredFull; cover.entry.low = cover.coveredLow
        cover.entry.mesh.geometry = this.reduced ? cover.coveredLow : cover.coveredFull
      }
      for (const cover of wardrobe.hair) cover.entry.mesh.visible = false
      for (const scene of wardrobe.scenes) this.scaler.add(scene)
      wardrobe.attached = true
      this.activeWardrobe = wardrobe
    }
    for (const key of previousKeys) releaseTexture(key)
    this.applyAppearance()
  }

  /** `failedBefore` is a picture attempt that had already failed when this look began; it is tried again. */
  private async applyLook(token: number, failedBefore: FaceJob | null = this.faceJob?.state === 'failed' ? this.faceJob : null): Promise<void> {
    const model = this.model
    if (!model || !this.rig || model.meta.id !== this.look.body) return
    const look = this.paintLook(), size = this.textureSize
    const prepared = await prepareLook(model, look, size, this.activeWardrobe?.outfitId === (look.outfit ?? null))
    try { await stageWardrobe(prepared, this.rig, this.meshes, look, this.activeWardrobe) }
    catch (error) { releasePrepared(prepared); throw error }
    // A mounted picture shows the tone the body has now. Textures in another tone wait for the picture rebuilt for them.
    const picture = this.face && prepared.skin !== this.paintedSkin ? await this.stagedPicture(failedBefore) : null
    if (this.disposed || token !== this.lookGeneration || this.model !== model || this.textureSize !== size) { releasePrepared(prepared); return }
    // A picture removed or replaced while this was painting must not leave its tone on the newer look: paint again.
    if ((this.paintLook().skin ?? null) !== prepared.skin) { releasePrepared(prepared); return this.applyLook(token, failedBefore) }
    // Without that picture the body keeps the tone of the picture that is shown, and the caller is told.
    if (this.face && prepared.skin !== this.paintedSkin && !(picture && picture.generation === this.faceGeneration && picture.state === 'staged' && picture.tone === prepared.skin)) {
      releasePrepared(prepared)
      throw new Error('The skin tone was not changed, because the picture could not be rebuilt to match it.')
    }
    this.applyPrepared(prepared)
  }

  /** The picture that will be mounted with a repaint, once it is ready. One that had already failed, or is already mounted, is prepared again. */
  private async stagedPicture(failedBefore: FaceJob | null): Promise<FaceJob | null> {
    const current = this.faceJob
    if (this.faceScan && (!current || current.generation !== this.faceGeneration || current.state === 'mounted' || current === failedBefore)) this.mountFace(this.faceScan.scan, this.faceScan.key, false)
    let job = this.faceJob
    // A change of detail can replace the attempt while this waits.
    for (let waits = 0; job && waits < 4; waits++) { await job.staged; if (job === this.faceJob) break; job = this.faceJob }
    return job
  }

  private clearRig(): void {
    if (this.hairGroup) disposeHair(this.hairGroup)
    this.hairGroup = null; this.hairKey = ''
    this.clearHeadFit()
    this.seated?.dispose(); this.seated = null
    this.mixer?.stopAllAction()
    if (this.rig) this.mixer?.uncacheRoot(this.rig)
    const skeletons = new Set<THREE.Skeleton>()
    this.rig?.traverse(child => { if (child instanceof THREE.SkinnedMesh) skeletons.add(child.skeleton) })
    for (const skeleton of skeletons) skeleton.dispose()
    this.meshes = []
    this.eyelids = []
    this.actions.clear()
    this.rig?.removeFromParent()
    for (const material of this.materials) material.dispose()
    this.materials = []
    for (const key of this.textureKeys) releaseTexture(key)
    this.textureKeys = []
    if (this.activeWardrobe) disposeWardrobe(this.activeWardrobe)
    this.activeWardrobe = null
    this.face?.texture.dispose()
    this.face?.featureTexture.dispose()
    this.face = null
    this.faceCanvas = null
    this.faceJob = null
    this.faceReady = Promise.resolve()
    this.faceGeneration++
    this.faceKey = ''
  }

  /** Keep the previous look visible until a new one is fully painted. */
  setLook(look: AvatarLook): void {
    const previous = this.look
    const appearance = parseAvatarAppearance('appearance' in look ? look.appearance : undefined)
    const appearanceChanged = JSON.stringify(appearance) !== JSON.stringify(this.appearance)
    this.appearance = appearance
    this.look = look
    const paintChanged = look.skin !== previous.skin || look.outfitHue !== previous.outfitHue || look.outfit !== previous.outfit || scalpKey(look) !== scalpKey(previous)
    if (look.body !== previous.body || ((!this.rig || this.model?.meta.id !== look.body) && paintChanged)) {
      this.ready = this.beginLook(token => this.rebuild(token))
      return
    }
    if (appearanceChanged || look.skin !== previous.skin) {
      this.applyAppearance()
      if (this.faceScan) this.mountFace(this.faceScan.scan, this.faceScan.key)
    }
    if (paintChanged) this.ready = this.beginLook(token => this.applyLook(token))
    if (look.height !== previous.height) { this.scaler.scale.setScalar(UNIT * look.height); this.applyTravelSpeed() }
  }

  retryLook(): Promise<void> {
    if (this.model?.meta.id !== this.look.body || !this.rig) {
      this.ready = this.beginLook(token => this.rebuild(token))
      return this.ready
    }
    // A picture that could not be mounted or re-toned is prepared again along with the look.
    if (this.faceScan && this.faceJob?.state === 'failed' && this.faceJob.generation === this.faceGeneration) this.mountFace(this.faceScan.scan, this.faceScan.key, false)
    this.ready = this.beginLook(token => this.applyLook(token))
    return this.ready
  }

  /** Mount (or remove) a photo face. `key` identifies the scan so repeated calls are free. */
  setFace(scan: FaceScan | null, key = ''): void {
    if (key === this.faceKey && (scan !== null) === (this.face !== null || this.faceScan !== null)) return
    this.faceScan = scan ? { scan, key } : null
    this.hairKey = ''
    if (!scan) this.identityFit = null
    this.clearHeadFit()
    this.faceGeneration++
    this.face?.texture.dispose()
    this.face?.featureTexture.dispose()
    this.face = null
    this.faceCanvas = null
    this.faceTone = null
    this.faceJob = null
    this.faceReady = Promise.resolve()
    for (const material of this.materials) if (material.name === 'head') clearFaceProjection(material)
    // Clearing the projection also cleared the head's shader hook; the neck must not wait for the next picture.
    this.applyBuild()
    this.faceKey = key
    if (scan && this.rig) this.mountFace(scan, key)
    else if (!scan) { this.applyAppearance(); this.syncTone() }
  }

  private manualShapeKey = ''
  private applyManualShape(): void {
    if (this.faceScan || !this.model) { this.manualShapeKey = ''; return }
    const a = this.appearance
    const key = `${this.model.meta.id}|${a.faceWidth}|${a.jaw}|${a.chin}`
    if (key === this.manualShapeKey) return
    this.clearHeadFit()
    this.manualShapeKey = key
    if (a.faceWidth === 1 && a.jaw === 1 && a.chin === 1) return
    const meta = this.model.meta, landmarks = meta.faceLandmarks
    if (!landmarks) return
    const chin = landmarks[152 * 3 + 1]!, eye = meta.eyes.left[1]
    this.model.template.updateMatrixWorld(true)
    for (const entry of this.meshes) {
      if (Array.isArray(entry.mesh.material) || entry.mesh.material.name !== 'head') continue
      const template = this.model.template.getObjectByName(entry.mesh.name)
      const bind = template?.matrixWorld ?? entry.mesh.bindMatrix
      const inverse = bind.clone().invert()
      const fit = (original: THREE.BufferGeometry): THREE.BufferGeometry => {
        const geometry = original.clone(), positions = geometry.getAttribute('position'), point = new THREE.Vector3()
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(bind)
          const weight = THREE.MathUtils.smoothstep(point.y, chin - 3, chin + 1)
          const lower = 1 - THREE.MathUtils.smoothstep(point.y, chin + 1, eye)
          point.x *= 1 + weight * ((a.faceWidth - 1) + (a.jaw - 1) * lower * 0.65)
          if (point.y < eye) point.y += (point.y - eye) * (a.chin - 1) * weight
          point.applyMatrix4(inverse)
          positions.setXYZ(i, point.x, point.y, point.z)
        }
        geometry.computeBoundingBox(); geometry.computeBoundingSphere()
        return geometry
      }
      const full = fit(entry.full), low = entry.low === entry.full ? full : fit(entry.low)
      this.fittedHeads.push({ entry, full: entry.full, low: entry.low })
      entry.full = full; entry.low = low; entry.mesh.geometry = this.reduced ? low : full
    }
  }

  /** Head, body, hair and clothes take one build and one fade, so the vertices they share move together. */
  private applyBuild(): void {
    const fade = this.model?.build
    if (!fade) return
    for (const material of this.materials) applyBodyBuild(material, this.appearance, fade)
    for (const scene of this.activeWardrobe?.scenes ?? []) scene.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material instanceof THREE.MeshStandardMaterial) applyBodyBuild(material, this.appearance, fade)
    })
  }

  private applyAppearance(): void {
    this.applyManualShape()
    for (const material of this.materials) if (material.name === 'head' && !this.faceScan) material.roughness = this.appearance.hairStyle === 'auto' ? 0.62 : 0.88
    this.applyBuild()
    if (!this.rig || !this.model) return
    const chosen = this.appearance.hairStyle === 'auto' ? null : this.appearance.hairStyle
    const style: HairStyle | null | undefined = chosen
    const colour = this.appearance.hairColour ?? this.face?.hair.colour ?? '#211813'
    const hiddenByClothes = this.activeWardrobe?.hair.length || ['f06', 'm15', 'm18'].includes(this.look.body)
    const key = `${style ?? 'stock'}|${colour}|${this.reduced}|${this.appearance.hairline}|${this.appearance.faceWidth}|${this.appearance.chin}|${hiddenByClothes}`
    if (key === this.hairKey) return
    this.hairKey = key
    if (this.hairGroup) disposeHair(this.hairGroup)
    this.hairGroup = null
    for (const entry of this.meshes) if (!Array.isArray(entry.mesh.material) && entry.mesh.material.name === 'hair') entry.mesh.visible = !style && !hiddenByClothes
    if (!style || hiddenByClothes) return
    const meta = this.model.meta, points = meta.faceLandmarks
    if (!points) return
    const skullWidth = Math.abs(points[234 * 3]! - points[454 * 3]!) * UNIT * this.appearance.faceWidth
    const eye = meta.eyes.left[1], bounds = new THREE.Box3(), vertex = new THREE.Vector3()
    this.model.template.updateMatrixWorld(true)
    this.model.template.traverse(node => {
      if (!(node instanceof THREE.Mesh) || Array.isArray(node.material) || node.material.name !== 'head') return
      const positions = node.geometry.getAttribute('position'), used = node.geometry.index?.array
      for (const i of used ?? Array.from({ length: positions.count }, (_, i) => i)) {
        vertex.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld)
        if (vertex.y >= eye + 1) bounds.expandByPoint(vertex)
      }
    })
    const top = bounds.isEmpty() ? points[10 * 3 + 1]! + 6 : bounds.max.y
    const chin = points[152 * 3 + 1]!
    const depth = bounds.isEmpty() ? skullWidth * 1.25 : (bounds.max.z - bounds.min.z) * UNIT
    const centre = new THREE.Vector3(0, (top + chin) / 2 + this.appearance.hairline * 10, bounds.isEmpty() ? meta.eyes.left[2] - 10 : (bounds.min.z + bounds.max.z) / 2)
    const headEntry = this.meshes.find(entry => !Array.isArray(entry.mesh.material) && entry.mesh.material.name === 'head')
    const originalHead = headEntry ? this.model.template.getObjectByName(headEntry.mesh.name) : undefined
    const portrait = this.face && this.faceCanvas ? { canvas: this.faceCanvas, skin: this.face.skin } : undefined
    const fibres = !this.reduced && (style === 'low-cut' || style === 'fade') && headEntry && originalHead
      ? scalpFibreGeometry(headEntry.full, originalHead.matrixWorld, meta, centre, style, this.appearance.hairline, portrait) : null
    const group = fibres ? createScalpHair(fibres, colour)
      : createHair(style === 'low-cut' || style === 'fade' ? 'bald' : style, colour, this.reduced ? 'reduced' : 'near', { width: skullWidth * 1.04, height: (top - chin) * UNIT, depth: depth * 1.04 })
    // Convert the library's skull frame to the head bone's centimetre bind frame.
    group.scale.setScalar(100)
    group.position.copy(centre)
    const templateHead = this.model.template.getObjectByName('Bip01_Head')
    const head = this.rig.getObjectByName('Bip01_Head')
    if (!templateHead || !head) { disposeHair(group); return }
    this.model.template.updateMatrixWorld(true)
    group.updateMatrix()
    group.applyMatrix4(templateHead.matrixWorld.clone().invert())
    head.add(group)
    this.hairGroup = group
  }

  private clearHeadFit(): void {
    for (const saved of this.fittedHeads) {
      saved.entry.full.dispose()
      if (saved.entry.low !== saved.entry.full) saved.entry.low.dispose()
      saved.entry.full = saved.full; saved.entry.low = saved.low
      saved.entry.mesh.geometry = this.reduced ? saved.low : saved.full
    }
    this.fittedHeads = []
    this.manualShapeKey = ''
    for (const material of this.materials) if (material.name === 'head') { material.normalMap = this.model?.normals.get('head') ?? null; material.normalScale.set(0.55, 0.55); material.roughness = 0.62 }
  }

  /** Creator-only fitted shape; saved appearance remains independent of the optional model. */
  setIdentity(identity: FittedSurfaceIdentity | null): void {
    if (this.identityFit === identity) return
    this.identityFit = identity
    if (this.faceScan && this.rig) this.mountFace(this.faceScan.scan, this.faceScan.key)
  }

  /** Record the tone the picture shows, ease its rim to that tone, and keep its edge from fringing dark. */
  private matchPhotoTone(photo: FaceProjection, scan: FaceScan): HTMLCanvasElement | null {
    const canvas: unknown = photo.texture.image, features: unknown = photo.featureTexture.image
    if (!(canvas instanceof HTMLCanvasElement)) return null
    const points = decodeFacePoints(scan.mesh)
    if (!this.look.skin && !this.faceTone) {
      this.faceTone = measureSkinTone(canvas, points) ?? photo.skin
      // A picture built with a tone was eased on the way here; this is the same pass for the first one.
      if (features instanceof HTMLCanvasElement) confirmFaceTone(canvas, features, points, this.faceTone, this.faceTone)
    }
    const tone = rgb(this.look.skin ?? this.faceTone ?? photo.skin)
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height), data = pixels.data
    // A canvas keeps black under clear pixels, and smaller mip levels would average that into a dark outline.
    for (let at = 0; at < data.length; at += 4) if (data[at + 3]! < 32) { data[at] = tone[0]; data[at + 1] = tone[1]; data[at + 2] = tone[2] }
    photo.texture.image = pixels
    photo.texture.needsUpdate = true
    return canvas
  }

  private mountFace(scan: FaceScan, key: string, refit = true): void {
    const model = this.model
    if (!model) return
    if (refit) this.faceFitDirty = true
    refit = refit || this.faceFitDirty
    const mine = ++this.faceGeneration
    const meta = model.meta
    const eyeY = (meta.eyes.left[1] + meta.eyes.right[1]) / 2
    const spread = Math.abs(meta.eyes.left[0] - meta.eyes.right[0])
    const point = (name: string): THREE.Vector3 => model.template.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, eyeY - spread, 0)
    model.template.updateMatrixWorld(true)
    const mouth = point('Bip01_LMouthCorner'), otherMouth = point('Bip01_RMouthCorner')
    const anchors: HeadAnchors = {
      eyes: eyeY, nose: point('Bip01_MNose').y, mouth: (mouth.y + otherMouth.y) / 2,
      chin: eyeY - spread * 1.85, brow: eyeY + spread * 0.95,
      spread, mouthWidth: Math.abs(mouth.x - otherMouth.x), front: meta.eyes.left[2],
    }
    let bind = new THREE.Matrix4()
    model.template.traverse(child => {
      if (child instanceof THREE.SkinnedMesh && !Array.isArray(child.material) && child.material.name === 'head') bind = child.matrixWorld.clone()
    })
    type StagedHead = { entry: ActorMesh; full: THREE.BufferGeometry; low: THREE.BufferGeometry }
    // A newer picture, look or rig bumps the generation; nothing from this one may be applied after that.
    const stale = (): boolean => this.disposed || mine !== this.faceGeneration || this.faceKey !== key
    const discard = (photo: FaceProjection, staged: StagedHead[]): void => {
      for (const item of staged) { item.full.dispose(); if (item.low !== item.full) item.low.dispose() }
      photo.texture.dispose(); photo.featureTexture.dispose()
    }
    const job: FaceJob = { generation: mine, tone: this.look.skin ?? this.faceTone, state: 'building', staged: Promise.resolve() }
    this.faceJob = job
    // Near and reduced pictures are confirmed to one tone, so a change of detail does not change colour.
    const staging = buildFaceProjection(scan, this.appearance, this.look.skin ?? this.faceTone, this.reduced ? 128 : 512).then(photo => scheduleFaceFit(() => {
      if (stale()) { discard(photo, []); return null }
      const canonical = meta.faceLandmarks
      const staged: StagedHead[] = []
      try {
        if (refit && canonical?.length === 468 * 3) for (const entry of this.meshes) {
          if (Array.isArray(entry.mesh.material) || entry.mesh.material.name !== 'head') continue
          const source = this.fittedHeads.find(saved => saved.entry === entry)
          const originalFull = source?.full ?? entry.full, originalLow = source?.low ?? entry.low
          const fit = (original: THREE.BufferGeometry): THREE.BufferGeometry => {
            const eyeBones = entry.mesh.skeleton.bones.flatMap((bone, index) => /^Bip01_[LR]Eye$/.test(bone.name) ? [index] : [])
            const manual = fitHeadGeometry(original, bind, canonical, scan, meta.faceLandmarkDepth, this.appearance, eyeBones)
            if (!this.identityFit || this.identityFit.parameters.calibrationRevision !== `rocketbox-${meta.id}-v1`) return manual
            const baseline = fitHeadGeometry(original, bind, canonical, scan, meta.faceLandmarkDepth, parseAvatarAppearance(null), eyeBones)
            const stock = compactIdentityStock(original)
            try {
              const wrapped = wrapSurfaceIdentityGeometry({ baseline, stock, bind, field: this.identityFit.field, calibration: { revision: `rocketbox-${meta.id}-v1`, eyes: meta.eyes, faceLandmarks: canonical } }).geometry
              const positions = wrapped.getAttribute('position'), adjusted = manual.getAttribute('position'), neutral = baseline.getAttribute('position')
              for (let i = 0; i < positions.count; i++) positions.setXYZ(i, positions.getX(i) + adjusted.getX(i) - neutral.getX(i), positions.getY(i) + adjusted.getY(i) - neutral.getY(i), positions.getZ(i) + adjusted.getZ(i) - neutral.getZ(i))
              wrapped.setAttribute('faceUv', manual.getAttribute('faceUv').clone())
              wrapped.computeVertexNormals(); wrapped.computeBoundingBox(); wrapped.computeBoundingSphere()
              manual.dispose()
              return wrapped
            } catch { return manual }
            finally { baseline.dispose(); stock.dispose() }
          }
          const full = fit(originalFull)
          try {
            const low = originalLow === originalFull ? full : fit(originalLow)
            staged.push({ entry, full, low })
          } catch (error) { full.dispose(); throw error }
        }
      } catch (error) { discard(photo, staged); throw error }
      const canvas = this.matchPhotoTone(photo, scan)
      job.tone = this.look.skin ?? this.faceTone
      job.state = 'staged'
      return { photo, staged, canvas }
    }))
    job.staged = staging.then(() => {}, () => { job.state = 'failed' })
    this.faceReady = staging.then(async ready => {
      if (!ready) return
      // The body takes the picture's tone first, so the picture never shows over skin of another tone.
      for (let attempt = 0; attempt < 2 && !stale(); attempt++) {
        for (let waits = 0; this.lookLoading && !stale() && waits < 8; waits++) await this.lookReady.catch(() => {})
        if (stale() || (this.paintLook().skin ?? null) === this.paintedSkin) break
        this.syncTone()
        await this.toneReady
      }
      if (stale()) { discard(ready.photo, ready.staged); return }
      // The body could not take this picture's tone. What was shown before stays as it was, whole.
      if ((this.paintLook().skin ?? null) !== this.paintedSkin) {
        discard(ready.photo, ready.staged)
        throw new Error('The picture was not applied, because the body could not be repainted to match it.')
      }
      const { photo, staged } = ready
      this.face?.texture.dispose(); this.face?.featureTexture.dispose()
      if (refit) { this.clearHeadFit(); this.faceFitDirty = false }
      for (const item of staged) {
        const { entry, full, low } = item
        this.fittedHeads.push({ entry, full: entry.full, low: entry.low })
        entry.full = full; entry.low = low
        entry.mesh.geometry = this.reduced ? low : full
      }
      this.face = photo
      this.faceCanvas = ready.canvas
      this.hairKey = ''
      this.applyAppearance()
      for (const material of this.materials) if (material.name === 'head') {
        material.normalMap = null
        material.normalScale.set(0.18, 0.18)
        material.roughness = 0.78
        projectFace(material, photo, anchors, bind, this.fittedHeads.length > 0)
      }
      // The projection replaced the head's shader hook; the build goes back on top of it.
      this.applyBuild()
      job.state = 'mounted'
    }).catch((error: unknown) => {
      if (!stale()) {
        job.state = 'failed'
        // With no picture shown, one that could not be mounted leaves no tone behind it. With one
        // shown, that picture and the body under it are already a pair and are left alone.
        if (!this.face) { this.faceTone = null; this.syncTone() }
      }
      throw error
    })
    // The caller can await faceReady; keep an unobserved failed image from becoming a global rejection.
    void this.faceReady.catch(() => {})
  }

  private play(motion: AvatarMotion, fade = 0.22): void {
    const next = this.actions.get(CLIP_FOR[motion]) ?? this.actions.get('idle')
    if (!next || next === this.current) return
    const loops = (next.getClip().userData as { loop?: boolean }).loop !== false
    next.reset().setEffectiveWeight(1).setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    next.clampWhenFinished = true
    // A zero-length fade divides by zero inside the mixer and corrupts the pose.
    if (fade > 0 && this.current) { next.fadeIn(fade); this.current.fadeOut(fade) } else this.current?.stop()
    next.play()
    this.current = next
    this.applyTravelSpeed()
  }

  setMotion(motion: AvatarMotion): void {
    if (motion === this.motion) return
    this.motion = motion
    if (!this.vehicle && performance.now() >= this.oneShotUntil) this.play(motion)
  }

  /** What the actor plays: a seated avatar sits, whatever motion it was last asked for; that motion comes back on exit. */
  private get playing(): AvatarMotion { return this.vehicle ? 'sit' : this.motion }

  get vehiclePose(): VehicleAvatarPose | null { return this.vehicle }

  /**
   * Seat the avatar in a vehicle, or (null) stand it up. The engine places `group` (see avatarVehiclePose.ts);
   * this plays the sitting clip and then, after the mixer, poses legs, torso, arms and hands to the seat.
   * Clearing puts back the animation the mixer last wrote. Gestures are ignored while seated.
   */
  setVehiclePose(pose: VehicleAvatarPose | null): void {
    if (this.disposed || pose === this.vehicle) return
    if (!this.vehicle && pose) { this.oneShotUntil = 0; this.seatBlend = 0 }
    this.vehicle = pose
    if (!pose) { this.seated?.restore(); this.seated = null }
    this.play(this.playing)
  }

  private poseSeated(delta: number): void {
    const pose = this.vehicle, model = this.model
    if (!pose || !this.rig || !model) return
    if (this.seated && this.seated.rig !== this.rig) { this.seated.dispose(); this.seated = null }
    this.seated ??= new SeatedPose(this.rig, model.template)
    this.seatBlend = Math.min(1, this.seatBlend + delta / SEAT_BLEND)
    this.seated.apply(pose, this.look.height, this.appearance, model.build, this.seatBlend * this.seatBlend * (3 - 2 * this.seatBlend))
  }

  /** Play a short gesture, then return to the current motion. */
  gesture(motion: 'wave' | 'nod' | 'work' | 'clap' | 'cheer' | 'talk' | 'dance', seconds = 2.6): void {
    if (this.vehicle) return
    this.oneShotUntil = performance.now() + seconds * 1000
    this.play(motion)
  }

  /** The engine may pass actual metres/second to match the stride, including height changes. */
  setTravelSpeed(metresPerSecond: number | null): void {
    this.travelSpeed = metresPerSecond
    this.applyTravelSpeed()
  }

  private applyTravelSpeed(): void {
    const action = this.current
    if (!action) return
    const speed = action.getClip().userData.groundSpeed as number | undefined
    action.setEffectiveTimeScale(speed && this.travelSpeed !== null ? Math.max(0.2, this.travelSpeed / (speed * this.look.height)) : 1)
  }

  setDetail(detail: 'auto' | 'full' | 'reduced'): void { this.detail = detail }

  private removePlaceholder(): void {
    if (!this.placeholder) return
    this.placeholder.removeFromParent()
    this.placeholder.geometry.dispose()
    const material = this.placeholder.material
    if (!Array.isArray(material)) material.dispose()
    this.placeholder = null
  }

  update(deltaSeconds: number): void {
    if (this.oneShotUntil && performance.now() >= this.oneShotUntil) { this.oneShotUntil = 0; this.play(this.playing) }
    if (!this.mixer) return
    const reduced = this.detail === 'reduced' || (this.detail === 'auto' && this.distance > (this.reduced ? 9 : 11))
    if (this.reduced !== reduced) { this.reduced = reduced; this.applyAppearance(); if (this.faceScan) this.mountFace(this.faceScan.scan, this.faceScan.key, false) }
    const size = reduced ? 256 : 512
    if (size !== this.textureSize) {
      this.textureSize = size
      if (this.model?.meta.id === this.look.body && this.rig) this.ready = this.beginLook(token => this.applyLook(token))
      else this.ready = this.beginLook(token => this.rebuild(token))
    }
    for (const entry of this.meshes) {
      entry.mesh.geometry = reduced ? entry.low : entry.full
      entry.mesh.castShadow = this.distance < 25
    }
    this.elapsed += deltaSeconds
    if (reduced && this.elapsed < 1 / 20) return
    const delta = this.elapsed
    this.elapsed = 0
    // The mixer sees the bones as it left them, not as the seat posed them.
    this.seated?.restore()
    this.mixer.update(delta)
    this.blinkClock += delta
    const phase = this.blinkClock - this.blinkAt
    const blink = phase > 0 && phase < 0.18 ? Math.sin(phase / 0.18 * Math.PI) : 0
    if (phase >= 0.18) { this.blinkClock = 0; this.blinkAt = 2.6 + Math.random() * 3 }
    if (this.face) this.face.blink.value = blink
    for (const lid of this.eyelids) lid.bone.position.copy(lid.bind).addScaledVector(lid.offset, blink)
    if (!this.root) return
    // Blend hip offsets using the same weights as the crossfading bone rotations.
    let vertical = 0, total = 0
    for (const action of this.actions.values()) {
      const weight = action.getEffectiveWeight()
      if ((!action.isRunning() && !action.paused) || weight <= 0) continue
      const data = action.getClip().userData as { rootOffsets: Float32Array; times: Float32Array }
      const frames = data.times.length
      const position = Math.min(frames - 1, (action.time / action.getClip().duration) * (frames - 1))
      const a = Math.floor(position), b = Math.min(frames - 1, a + 1), t = position - a
      vertical += (data.rootOffsets[a * 3 + 1]! * (1 - t) + data.rootOffsets[b * 3 + 1]! * t) * weight
      total += weight
    }
    this.root.position.set(this.rootBind.x, this.rootBind.y + (total ? vertical / total : 0), this.rootBind.z)
    this.poseSeated(delta)
  }

  dispose(): void {
    this.disposed = true
    this.vehicle = null
    this.lookGeneration++
    this.clearRig()
    this.faceScan = null
    this.removePlaceholder()
    this.group.removeFromParent()
  }
}
