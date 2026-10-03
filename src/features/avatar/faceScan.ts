// Turn one photo into a face scan, entirely on this device.
//
// The picture is analysed in the browser (MediaPipe Face Landmarker). Only a compact crop of
// the face region and 468 shape points are kept; the original picture is discarded.
import { FACE_LANDMARKS, FACE_TEXTURE_MAX_BYTES, FACE_TEXTURE_SIZE } from '../../shared/model.ts'
import type { AvatarBody, FaceScan } from '../../shared/model.ts'
import { providers } from '../../config/providers.ts'
import { FACE_CROP_SPAN, FACE_MASK_FEATHER, decodeFacePoints, encodeFacePoints, facePhotoOutline } from '../../world/faces.ts'
import { analyseFaceSurface } from '../../world/surfaceAlbedo.ts'
import { analyseHair } from '../../world/surfaceHair.ts'
import { parseAvatarAppearance } from '../../shared/appearance.ts'
import type { HairSuggestion } from './hairAnalysis.ts'
import type { AvatarAppearance } from '../../shared/appearance.ts'
import topology from '../../assets/face-topology.json'
import castIndex from '../../assets/cast.index.json'

export type FaceScanFailure = 'no-face' | 'too-small' | 'turned' | 'blurry' | 'engine' | 'too-large'
export class FaceScanError extends Error {
  readonly reason: FaceScanFailure
  constructor(reason: FaceScanFailure, message: string) { super(message); this.reason = reason }
}

export type FaceCaptureResult =
  | { mode: 'match'; body: AvatarBody; skin: string; appearance: AvatarAppearance }
  | (FaceScanResult & { mode: 'photo'; body: AvatarBody; appearance: AvatarAppearance })

/**
 * `eligible` says the part of the picture a head would show is all there. It is not a verdict on
 * how the face will look: when eligible, `reasons` are things the member may notice and can
 * judge in the preview; when not, `reasons` says what is missing from the picture.
 */
export interface PhotoQuality { eligible: boolean; reasons: string[] }

export interface FaceScanResult {
  photoQuality?: PhotoQuality
  scan: FaceScan
  skin: string
  hair: string | null
  hairSuggestion?: HairSuggestion
  body?: AvatarBody
  appearance?: AvatarAppearance
  /** Side images are discarded; their landmark meshes may be saved with the face. */
  views?: { left?: string; right?: string }
  /** Corrected 2D crop for review only; scan.texture keeps the original crop. */
  correctedTexture?: string
}

/** What the member is waiting on, in the order a photo goes through them. `tools` is shown only while the face reader is not yet ready. */
export type ScanPhase = 'tools' | 'face' | 'hair'

interface Landmarker { detect(image: HTMLCanvasElement): { faceLandmarks: { x: number; y: number; z: number }[][] }; close(): void }
let landmarker: Promise<Landmarker> | null = null
let landmarkerReady = false
/**
 * A total limit on one attempt to start the face reader, so a stalled script or model request cannot
 * hold every caller for good. The engine has no deadline of its own and cannot be cancelled: when the
 * limit passes the attempt is only ignored, and whatever it was fetching may still be running. This is
 * a judgement, not an inactivity timeout and not calibrated to any measured speed; nothing was timed.
 */
const LANDMARKER_WAIT_MS = 120_000

/**
 * One live attempt at a time, shared by every caller. An attempt that fails, or runs out of time, is
 * forgotten so the next call starts a new one. A detector that arrives after its attempt was given up
 * on is closed here, once: nobody holds it, and the attempt now in the slot is a different detector.
 * The shared detector itself is never closed; a cancelled capture only stops listening for it.
 */
function loadLandmarker(): Promise<Landmarker> {
  if (landmarker) return landmarker
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt: Promise<Landmarker> = new Promise<Landmarker>((resolve, reject) => {
    const forget = (): void => { if (landmarker === attempt) landmarker = null }
    timer = setTimeout(() => {
      abandoned = true
      forget()
      reject(new FaceScanError('engine', 'The face reader is taking too long to start. Check your connection and try again.'))
    }, LANDMARKER_WAIT_MS)
    void (async (): Promise<Landmarker> => {
      const [vision, loader, binary] = await Promise.all([
        import('@mediapipe/tasks-vision'),
        import('@mediapipe/tasks-vision/vision_wasm_internal.js?url'),
        import('@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'),
      ])
      return vision.FaceLandmarker.createFromOptions({ wasmLoaderPath: loader.default, wasmBinaryPath: binary.default }, {
        baseOptions: { modelAssetPath: providers.face.model, delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 2,
      }) as unknown as Landmarker
    })().then(found => {
      clearTimeout(timer)
      if (!abandoned) { landmarkerReady = true; resolve(found); return }
      try { found.close() } catch (cause) { console.warn('[face] a face reader that started too late could not be closed:', cause) }
    }, cause => {
      clearTimeout(timer)
      // After the deadline the member has already been told; a late failure changes nothing.
      if (abandoned) return
      forget()
      reject(cause)
    })
  })
  landmarker = attempt
  // Callers handle the rejection; this only keeps one nobody is waiting for from being reported as unhandled.
  attempt.catch(() => {})
  return attempt
}

// The member reads one sentence; a developer needs the cause. Loading fetches code and the model
// and never touches the picture, so the cause holds no photo data.
let lastLoadFailure = ''
function reportLoadFailure(cause: unknown): void {
  const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause instanceof Event ? `${cause.type} event from the loader script` : String(cause)
  // Camera guidance retries about once a second; say each distinct cause once.
  if (text !== lastLoadFailure) console.warn(`[face] the face reader could not load: ${text}`)
  lastLoadFailure = text
}

const OVAL = (topology as { oval: number[] }).oval

type Point = { x: number; y: number; z: number }
type Source = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement

async function readFace(source: Source, onPhase?: (phase: ScanPhase) => void): Promise<{ work: HTMLCanvasElement; level: Point[]; width: number; roll: number; yaw: number; cx: number; cy: number; landmarks: Point[] }> {
  const sourceWidth = 'videoWidth' in source ? source.videoWidth : source.width
  const sourceHeight = 'videoHeight' in source ? source.videoHeight : source.height
  if (!sourceWidth || !sourceHeight) throw new FaceScanError('no-face', 'That picture could not be read.')
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight))
  const work = document.createElement('canvas')
  work.width = Math.round(sourceWidth * scale)
  work.height = Math.round(sourceHeight * scale)
  work.getContext('2d')!.drawImage(source, 0, 0, work.width, work.height)

  let detector: Landmarker
  if (!landmarkerReady) onPhase?.('tools')
  try { detector = await loadLandmarker() } catch (cause) {
    reportLoadFailure(cause)
    throw cause instanceof FaceScanError ? cause : new FaceScanError('engine', 'The face reader could not load. Check your connection and try again.')
  }
  onPhase?.('face')
  const faces = detector.detect(work).faceLandmarks
  if (faces.length > 1) throw new FaceScanError('no-face', 'Use a picture with only your own face in it.')
  const found = faces[0]
  if (!found || found.length < FACE_LANDMARKS) throw new FaceScanError('no-face', 'No face was found. Use a clear picture with your whole face in view.')

  const points = found.slice(0, FACE_LANDMARKS).map(p => ({ x: p.x * work.width, y: p.y * work.height, z: p.z * work.width }))
  const leftEye = points[33]!, rightEye = points[263]!
  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x)
  const cos = Math.cos(-roll), sin = Math.sin(-roll)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y) }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const level = points.map(p => ({ x: (p.x - cx) * cos - (p.y - cy) * sin, y: (p.x - cx) * sin + (p.y - cy) * cos, z: p.z }))
  const width = Math.hypot(level[454]!.x - level[234]!.x, level[454]!.y - level[234]!.y)
  if (width < 90) throw new FaceScanError('too-small', 'The face is too small in this picture. Move closer or use a larger picture.')
  const middle = (level[234]!.x + level[454]!.x) / 2
  const yaw = (level[1]!.x - middle) / width
  return { work, level, width, roll, yaw, cx, cy, landmarks: found }
}

function normaliseFace(level: Point[], width: number): { mesh: Point[]; ox: number; oy: number; framing: number } {
  let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity
  for (const p of level) { lx = Math.min(lx, p.x); hx = Math.max(hx, p.x); ly = Math.min(ly, p.y); hy = Math.max(hy, p.y) }
  const ox = (lx + hx) / 2, oy = (ly + hy) / 2 - width * 0.06
  const framing = width * 1.22
  const rim = OVAL.reduce((sum, index) => sum + level[index]!.z, 0) / OVAL.length
  const mesh = level.map(p => ({ x: (p.x - ox) / framing, y: -(p.y - oy) / framing, z: (rim - p.z) / framing }))
  return { mesh, ox, oy, framing }
}

interface CropPlacement { centreX: number; centreY: number; framing: number; roll: number; width: number; height: number }

/**
 * Whether the picture holds every pixel a head would show. The region is the one the projection
 * masks, limited to the crop, since nothing beyond the crop is ever read. It is widened by about
 * two feather widths because the softened edge also takes in pixels just outside the outline;
 * that allowance is deliberately on the safe side and is not an exact measure of the blur.
 */
function keptRegionInPicture(points: ArrayLike<number>, placement: CropPlacement): boolean {
  const outline = facePhotoOutline(points)
  const middle = { x: outline.reduce((sum, p) => sum + p.x, 0) / outline.length, y: outline.reduce((sum, p) => sum + p.y, 0) / outline.length }
  const margin = 2 * FACE_MASK_FEATHER * FACE_CROP_SPAN
  let kept = outline.map(p => {
    const grow = 1 + margin / Math.max(margin, Math.hypot(p.x - middle.x, p.y - middle.y))
    return { x: middle.x + (p.x - middle.x) * grow, y: middle.y + (p.y - middle.y) * grow }
  })
  // Cut the outline at each side of the crop in turn.
  const half = FACE_CROP_SPAN / 2
  for (const [axis, side] of [['x', -1], ['x', 1], ['y', -1], ['y', 1]] as const) {
    const cut: { x: number; y: number }[] = []
    kept.forEach((to, i) => {
      const from = kept[(i + kept.length - 1) % kept.length]!
      const fromIn = from[axis] * side <= half, toIn = to[axis] * side <= half
      if (fromIn !== toIn) {
        const t = (half * side - from[axis]) / (to[axis] - from[axis])
        cut.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
      }
      if (toIn) cut.push(to)
    })
    kept = cut
  }
  // The same placement the crop was cut with: out from its centre, turned back by the roll.
  const cos = Math.cos(placement.roll), sin = Math.sin(placement.roll)
  return kept.every(p => {
    const dx = p.x * placement.framing, dy = -p.y * placement.framing
    const x = placement.centreX + dx * cos - dy * sin, y = placement.centreY + dx * sin + dy * cos
    return x >= 0 && x <= placement.width && y >= 0 && y <= placement.height
  })
}

function photoQuality(crop: HTMLCanvasElement, pose: { yaw: number; width: number }, inPicture: boolean): PhotoQuality {
  // Black where the picture ran out would be drawn on the head as if it were the face.
  if (!inPicture) return { eligible: false, reasons: ['Part of your face or hairline is outside this picture. Use one with some space around your head.'] }
  const sample = document.createElement('canvas')
  sample.width = sample.height = 256
  const context = sample.getContext('2d', { willReadFrequently: true })!
  context.drawImage(crop, 0, 0, 256, 256)
  const { data, width, height } = context.getImageData(0, 0, 256, 256)
  let edges = 0, count = 0
  const light = (index: number): number => data[index]! * 0.2126 + data[index + 1]! * 0.7152 + data[index + 2]! * 0.0722
  for (let y = Math.floor(height * 0.28); y < height * 0.72; y += 3) for (let x = Math.floor(width * 0.25); x < width * 0.75; x += 3) {
    const i = (y * width + x) * 4
    edges += Math.abs(4 * light(i) - light(i - 4) - light(i + 4) - light(i - width * 4) - light(i + width * 4))
    count++
  }
  // None of these stops a photo face. A tilted head is levelled before the crop is cut, so it is
  // not mentioned; a turned one is not straightened, and uneven light is only partly evened out.
  // The limits are where a note becomes worth showing, not measures of how accurate the face is.
  const reasons: string[] = []
  if (Math.abs(pose.yaw) > 0.045) reasons.push('Your face is turned a little in this picture. The photo face may look uneven from side to side.')
  if (pose.width < 180) reasons.push('Your face is small in this picture, so it may look soft up close.')
  if (edges / Math.max(1, count) < 5) reasons.push('This picture may be too soft to show fine detail.')
  const meanPatch = (x0: number, x1: number): number => {
    let total = 0, n = 0
    for (let y = 112; y < 155; y += 2) for (let x = x0; x < x1; x += 2) { total += light((y * width + x) * 4); n++ }
    return total / Math.max(1, n)
  }
  const left = meanPatch(80, 105), right = meanPatch(151, 176)
  if (Math.abs(left - right) / Math.max(30, (left + right) / 2) > 0.3) reasons.push('One side of your face is darker in this picture. Some of that shading may stay on your character.')
  return { eligible: true, reasons }
}

function estimateShoulders(work: HTMLCanvasElement, level: Point[], faceWidth: number, cx: number, cy: number): number {
  const chinY = level[152]!.y + cy
  const row = Math.round(chinY + faceWidth * 0.6)
  if (row < 0 || row >= work.height - 4 || faceWidth * 2.6 > work.width) return 1
  const { data } = work.getContext('2d', { willReadFrequently: true })!.getImageData(0, row, work.width, 1)
  const pixel = (x: number): [number, number, number] => [data[x * 4]!, data[x * 4 + 1]!, data[x * 4 + 2]!]
  const difference = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
  const background = [pixel(2), pixel(work.width - 3)]
  if (difference(background[0]!, background[1]!) > 25) return 1
  const centre = Math.round(cx)
  if (centre < 5 || centre >= work.width - 5) return 1
  let left = centre, right = centre
  while (left > 4 && difference(pixel(left), background[0]!) > 32) left--
  while (right < work.width - 5 && difference(pixel(right), background[1]!) > 32) right++
  const ratio = (right - left) / faceWidth
  if (left < 5 || right > work.width - 6 || ratio < 1.55 || ratio > 3.2 || Math.abs(centre - (left + right) / 2) > faceWidth * 0.3) return 1
  return Math.max(0.9, Math.min(1.16, +(ratio / 2.1).toFixed(2)))
}

/** Bounded starting proportions relative to the body the member explicitly chose. */
function shapeForBody(mesh: readonly Point[], body?: AvatarBody): Pick<AvatarAppearance, 'faceWidth' | 'jaw' | 'chin'> {
  const canonical = body ? castIndex.find(entry => entry.id === body)?.faceLandmarks : undefined
  if (!canonical) return { faceWidth: 1, jaw: 1, chin: 1 }
  const ratios = (point: (index: number) => { x: number; y: number }) => {
    const width = Math.max(0.001, Math.abs(point(454).x - point(234).x))
    const eye = [33, 133, 362, 263].reduce((sum, index) => sum + point(index).y, 0) / 4
    return { upper: Math.abs(point(10).y - eye) / width, lower: Math.abs(eye - point(152).y) / width, jaw: Math.abs(point(397).x - point(172).x) / width }
  }
  const target = ratios(index => mesh[index]!)
  const base = ratios(index => ({ x: canonical[index * 3]!, y: canonical[index * 3 + 1]! }))
  const faceWidth = Math.max(0.9, Math.min(1.12, base.upper / Math.max(0.01, target.upper)))
  return {
    faceWidth,
    chin: Math.max(0.9, Math.min(1.1, target.lower * faceWidth / Math.max(0.01, base.lower))),
    jaw: Math.max(0.85, Math.min(1.18, 1 + faceWidth * (target.jaw / Math.max(0.01, base.jaw) - 1) / 0.65)),
  }
}

/** Analyse a picture and build the scan. Throws FaceScanError with a reason the UI can explain. */
export async function scanFace(source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, body?: AvatarBody, onPhase?: (phase: ScanPhase) => void): Promise<FaceScanResult> {
  const { work, level, width, roll, yaw, cx, cy, landmarks } = await readFace(source, onPhase)
  if (Math.abs(roll) > 0.40) throw new FaceScanError('turned', 'Hold the camera level and face it straight on.')
  if (Math.abs(yaw) > 0.23) throw new FaceScanError('turned', 'Face the camera straight on. The picture is turned too far to one side.')
  const { mesh, ox, oy, framing } = normaliseFace(level, width)

  const crop = document.createElement('canvas')
  crop.width = crop.height = FACE_TEXTURE_SIZE
  const context = crop.getContext('2d', { willReadFrequently: true })!
  const zoom = FACE_TEXTURE_SIZE / (framing * FACE_CROP_SPAN)
  // Centre of the levelled face, back in picture coordinates.
  const centreX = cx + ox * Math.cos(roll) - oy * Math.sin(roll)
  const centreY = cy + ox * Math.sin(roll) + oy * Math.cos(roll)
  context.translate(FACE_TEXTURE_SIZE / 2, FACE_TEXTURE_SIZE / 2)
  context.scale(zoom, zoom)
  context.rotate(-roll)
  context.translate(-centreX, -centreY)
  // Landmarks use the small analysis canvas; crop directly from the original
  // pixels at the same coordinates to avoid downsampling the face twice.
  context.drawImage(source, 0, 0, work.width, work.height)
  context.setTransform(1, 0, 0, 1, 0, 0)

  // Judged on the points as they are stored, which are the ones a head is fitted to.
  const stored = encodeFacePoints(mesh)
  const quality = photoQuality(crop, { yaw, width }, keptRegionInPicture(decodeFacePoints(stored), { centreX, centreY, framing, roll, width: work.width, height: work.height }))
  const flat = new Float32Array(mesh.flatMap(point => [point.x, point.y, point.z]))
  const surface = analyseFaceSurface(crop, flat, FACE_CROP_SPAN)
  const visibleHair = analyseHair(crop, flat)
  const { analyseCapturedHair } = await import('./hairAnalysis.ts')
  onPhase?.('hair')
  const hairSuggestion = await analyseCapturedHair(work, landmarks)
  const hair = hairSuggestion.colour ?? visibleHair.colour
  const appearance = parseAvatarAppearance({
    beard: surface.hasBeard ? 'chin-strap' : 'off',
    ...shapeForBody(mesh, body),
    hairStyle: hairSuggestion.confidence >= 0.5 ? hairSuggestion.style : 'auto',
    hairColour: hair,
    shoulders: estimateShoulders(work, level, width, cx, cy),
  })

  let texture = ''
  for (const quality of [0.86, 0.76, 0.64, 0.5]) {
    texture = crop.toDataURL('image/jpeg', quality)
    if (texture.length * 0.75 <= FACE_TEXTURE_MAX_BYTES) break
  }
  if (texture.length * 0.75 > FACE_TEXTURE_MAX_BYTES) throw new FaceScanError('too-large', 'That picture could not be made small enough. Try another one.')
  return { photoQuality: quality, scan: { texture, mesh: stored }, skin: surface.skin, hair, hairSuggestion, appearance, correctedTexture: surface.albedo.toDataURL('image/jpeg', 0.78) }
}

/** Camera guidance runs only while framing, never while a capture is being processed. */
export async function captureGuidance(source: HTMLVideoElement, side: 'front' | 'left' | 'right'): Promise<string> {
  try {
    const { roll, yaw } = await readFace(source)
    if (Math.abs(roll) > 0.27) return 'Keep your head level.'
    if (side === 'front') return Math.abs(yaw) > 0.13 ? 'Look straight at the camera.' : 'Ready. Keep still and take the picture.'
    if (Math.abs(yaw) < 0.12) return `Turn a little more to your ${side}.`
    if (Math.abs(yaw) > 0.45) return 'Turn back a little so both eyes are visible.'
    return 'Ready. Keep this angle and take the picture.'
  } catch (error) { return error instanceof FaceScanError ? error.message : 'Keep your whole face in the oval.' }
}

/** Read a left or right profile as landmark points only. The image never enters the saved face scan. */
export async function analyseProfileFace(source: HTMLImageElement | HTMLVideoElement, side: 'left' | 'right', onPhase?: (phase: ScanPhase) => void): Promise<string> {
  const { level, width, roll, yaw } = await readFace(source, onPhase)
  if (Math.abs(roll) > 0.35) throw new FaceScanError('turned', 'Keep your head level in the side photo.')
  if (Math.abs(yaw) < 0.12) throw new FaceScanError('turned', `Turn your face a little more to your ${side}.`)
  if (Math.abs(yaw) > 0.45) throw new FaceScanError('turned', 'This face is turned too far. Show both eyes and try again.')
  return encodeFacePoints(normaliseFace(level, width).mesh)
}

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new FaceScanError('no-face', 'Choose a picture file (JPEG or PNG).')); return }
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new FaceScanError('no-face', 'That picture could not be opened.')) }
    image.src = url
  })
}

/** Whether this page may open the camera. Hosted Goalmatic pages currently may not. */
export function cameraAllowed(): boolean {
  if (!navigator.mediaDevices?.getUserMedia) return false
  const policy = document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } }
  const allows = policy.permissionsPolicy ?? policy.featurePolicy
  return allows ? allows.allowsFeature('camera') : true
}
