import { loadAsset } from '../../assets/publicAssets.ts'
import type { HairStyle } from '../../world/surfaceHair.ts'

/** Raw MediaPipe Face Landmarker points in the original capture canvas, x/y in [0,1]. */
export interface HairFacePoint { x: number; y: number; z: number }

export interface HairMeasurements {
  /** Segmented hair pixels in the head ROI divided by projected face width squared. */
  area: number
  /** Hair height above landmark 10 divided by projected face width. */
  crownHeight: number
  /** Maximum hair width in the upper head divided by projected face width. */
  width: number
  /** Hair extent below the chin divided by projected face width. */
  lengthBelowChin: number
}

export interface HairSuggestion {
  style: HairStyle | 'auto'
  colour: string | null
  confidence: number
  measurements: HairMeasurements | null
  reason?: 'unavailable' | 'timeout' | 'landmarks' | 'mask' | 'uncertain'
}

const MODEL_URL = '/avatars/hair-analysis/hair-segmenter.pack.gz'
const MODEL_SHA256 = '2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84'
const MODEL_BYTES = 781_618
const MAX_WAIT_MS = 8_000
const fallback = (reason: HairSuggestion['reason']): HairSuggestion => ({ style: 'auto', colour: null, confidence: 0, measurements: null, reason })
const clamp = (value: number): number => Math.max(0, Math.min(1, value))

type Segmenter = import('@mediapipe/tasks-vision').ImageSegmenter
let segmenterPromise: Promise<Segmenter> | null = null

async function modelBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const unpacked = await loadAsset(MODEL_URL)
  if (unpacked.byteLength !== MODEL_BYTES) throw new Error('hair model size mismatch')
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', unpacked)), value => value.toString(16).padStart(2, '0')).join('')
  if (hash !== MODEL_SHA256) throw new Error('hair model hash mismatch')
  return unpacked
}

function loadSegmenter(): Promise<Segmenter> {
  segmenterPromise ??= (async () => {
    const [vision, loader, binary, modelAssetBuffer] = await Promise.all([
      import('@mediapipe/tasks-vision'),
      import('@mediapipe/tasks-vision/vision_wasm_internal.js?url'),
      import('@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'),
      modelBytes(),
    ])
    return vision.ImageSegmenter.createFromOptions({ wasmLoaderPath: loader.default, wasmBinaryPath: binary.default }, {
      baseOptions: { modelAssetBuffer, delegate: 'CPU' }, runningMode: 'IMAGE',
      outputCategoryMask: true, outputConfidenceMasks: true,
    })
  })()
  void segmenterPromise.catch(() => { segmenterPromise = null })
  return segmenterPromise
}

async function withinTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), MAX_WAIT_MS) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

function colourOf(samples: [number[], number[], number[]]): string | null {
  if (samples[0].length < 24) return null
  return '#' + samples.map(channel => Math.round(median(channel)).toString(16).padStart(2, '0')).join('')
}

function scalpLooksVisible(pixels: Uint8ClampedArray, canvas: HTMLCanvasElement, centerX: number, eyeY: number, foreheadY: number, faceWidth: number): boolean {
  const patch = (cx: number, cy: number): number[] | null => {
    const channels: [number[], number[], number[]] = [[], [], []]
    const radius = Math.max(2, Math.round(faceWidth * 0.035))
    if (cx - radius < 0 || cx + radius >= canvas.width || cy - radius < 0 || cy + radius >= canvas.height) return null
    for (let y = Math.floor(cy - radius); y <= cy + radius; y += 2) for (let x = Math.floor(cx - radius); x <= cx + radius; x += 2) {
      const at = (y * canvas.width + x) * 4
      for (let channel = 0; channel < 3; channel++) channels[channel]!.push(pixels[at + channel]!)
    }
    return channels.map(median)
  }
  const cheekLeft = patch(centerX - faceWidth * 0.22, eyeY + faceWidth * 0.25)
  const cheekRight = patch(centerX + faceWidth * 0.22, eyeY + faceWidth * 0.25)
  const scalp = patch(centerX, foreheadY - faceWidth * 0.34)
  if (!cheekLeft || !cheekRight || !scalp) return false
  const skin = cheekLeft.map((value, channel) => (value + cheekRight[channel]!) / 2)
  const brightness = skin.reduce((sum, value) => sum + value, 0) / 3
  const scalpBrightness = scalp.reduce((sum, value) => sum + value, 0) / 3
  return Math.hypot(...skin.map((value, channel) => value - scalp[channel]!)) < 42 &&
    scalpBrightness > brightness * 0.65 && scalpBrightness < brightness * 1.45
}

/** Analyse original capture pixels locally. A suggestion is never a locked hairstyle choice. */
export async function analyseCapturedHair(canvas: HTMLCanvasElement, faceLandmarks?: readonly HairFacePoint[]): Promise<HairSuggestion> {
  if (!canvas.width || !canvas.height) return fallback('unavailable')
  let segmenter: Segmenter
  try { segmenter = await withinTimeout(loadSegmenter()) }
  catch (error) {
    // Loading fetches code and the model, never the picture, so the cause is safe to show a developer.
    console.warn('[hair] the hair reader could not load:', error instanceof Error ? `${error.name}: ${error.message}` : error instanceof Event ? `${error.type} event from the loader script` : String(error))
    return fallback(error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unavailable')
  }

  const labels = segmenter.getLabels().map(label => label.toLowerCase())
  const hairClass = labels.findIndex(label => label.includes('hair'))
  if (hairClass < 0) return fallback('mask')
  const landmarks = faceLandmarks?.length && faceLandmarks.length >= 468 ? faceLandmarks : null
  if (!landmarks) return fallback('landmarks')
  const left = landmarks[234]!, right = landmarks[454]!, top = landmarks[10]!, chin = landmarks[152]!
  const faceWidth = Math.hypot((right.x - left.x) * canvas.width, (right.y - left.y) * canvas.height)
  const centerX = (left.x + right.x) * canvas.width / 2
  const foreheadY = top.y * canvas.height, chinY = chin.y * canvas.height
  const eyeY = (landmarks[33]!.y + landmarks[263]!.y) * canvas.height / 2
  if (!Number.isFinite(faceWidth) || faceWidth < 50 || !Number.isFinite(centerX) || !Number.isFinite(foreheadY)) return fallback('landmarks')

  let result: ReturnType<Segmenter['segment']>
  try { result = segmenter.segment(canvas) }
  catch { return fallback('mask') }
  try {
    const category = result.categoryMask
    const confidence = result.confidenceMasks?.[hairClass]
    if (!category || !confidence || category.width !== confidence.width || category.height !== confidence.height) return fallback('mask')
    const classes = category.getAsUint8Array(), scores = confidence.getAsFloat32Array()
    const { width, height } = category
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return fallback('unavailable')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const x0 = Math.max(0, centerX - faceWidth * 1.15), x1 = Math.min(canvas.width, centerX + faceWidth * 1.15)
    const y0 = Math.max(0, foreheadY - faceWidth * 1.3), y1 = Math.min(canvas.height, chinY + faceWidth * 0.75)
    let area = 0, topHair = Infinity, bottomHair = -Infinity, upperLeft = Infinity, upperRight = -Infinity
    let sideBelowChin = 0, sideRows = 0
    const channels: [number[], number[], number[]] = [[], [], []]
    for (let my = 0; my < height; my++) {
      const sy = (my + 0.5) * canvas.height / height
      if (sy < y0 || sy > y1) continue
      let rowSides = 0
      for (let mx = 0; mx < width; mx++) {
        const sx = (mx + 0.5) * canvas.width / width
        if (sx < x0 || sx > x1) continue
        const at = my * width + mx
        if (classes[at] !== hairClass || scores[at]! < 0.62) continue
        area++
        topHair = Math.min(topHair, sy); bottomHair = Math.max(bottomHair, sy)
        if (sy < foreheadY + faceWidth * 0.1) { upperLeft = Math.min(upperLeft, sx); upperRight = Math.max(upperRight, sx) }
        if (sy > chinY && Math.abs(sx - centerX) > faceWidth * 0.35) rowSides++
        if (scores[at]! >= 0.78 && sy < foreheadY + faceWidth * 0.2 && Math.abs(sx - centerX) < faceWidth * 0.85) {
          const px = Math.min(canvas.width - 1, Math.floor(sx)), py = Math.min(canvas.height - 1, Math.floor(sy))
          const pixel = (py * canvas.width + px) * 4
          for (let channel = 0; channel < 3; channel++) channels[channel]!.push(pixels[pixel + channel]!)
        }
      }
      if (sy > chinY) { sideRows++; if (rowSides >= Math.max(2, width * faceWidth / canvas.width * 0.08)) sideBelowChin++ }
    }
    const scale = canvas.width / width * (canvas.height / height)
    const measurements: HairMeasurements = {
      area: area * scale / (faceWidth * faceWidth),
      crownHeight: Number.isFinite(topHair) ? Math.max(0, (foreheadY - topHair) / faceWidth) : 0,
      width: Number.isFinite(upperLeft) ? (upperRight - upperLeft) / faceWidth : 0,
      lengthBelowChin: Number.isFinite(bottomHair) ? Math.max(0, (bottomHair - chinY) / faceWidth) : 0,
    }
    const colour = colourOf(channels)
    const visibleScalp = scalpLooksVisible(pixels, canvas, centerX, eyeY, foreheadY, faceWidth)
    const { area: coverage, crownHeight, width: volume, lengthBelowChin } = measurements
    const sustainedSides = sideRows > 0 && sideBelowChin / sideRows > 0.36
    let style: HairStyle | 'auto' = 'auto', confidenceValue = 0
    if (coverage < 0.025 && crownHeight < 0.08 && visibleScalp) { style = 'bald'; confidenceValue = 0.6 }
    else if (lengthBelowChin > 0.22 && sustainedSides && volume < 1.7) { style = 'long-straight'; confidenceValue = 0.55 }
    else if (crownHeight > 0.5 && volume > 1.35 && coverage > 0.25) { style = 'big-afro'; confidenceValue = 0.62 }
    else if (crownHeight > 0.22 && volume > 1.12 && coverage > 0.13 && lengthBelowChin < 0.15) { style = 'short-afro'; confidenceValue = 0.57 }
    else if (crownHeight < 0.55 && volume < 1.15 && coverage > 0.025 && coverage < 0.30 && lengthBelowChin < 0.12) { style = 'low-cut'; confidenceValue = 0.52 }
    // Boundary crops and thin strands are precisely where silhouette claims fail.
    const touchesEdge = topHair <= y0 + faceWidth * 0.03 || upperLeft <= x0 + faceWidth * 0.03 || upperRight >= x1 - faceWidth * 0.03
    if (touchesEdge || foreheadY < faceWidth * 0.50) { style = 'auto'; confidenceValue = 0 }
    return { style, colour, confidence: clamp(confidenceValue), measurements, ...(style === 'auto' ? { reason: 'uncertain' as const } : {}) }
  } catch { return fallback('mask') }
  finally { result.close() }
}
