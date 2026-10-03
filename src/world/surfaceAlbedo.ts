/** Illumination-resistant face colour and a separate, white-alpha hair feature mask.
 * Landmark coordinates are x right, y up, in face-width units around the crop centre.
 */

type Lab = { l: number; a: number; b: number }
type Sample = { x: number; y: number; lab: Lab }

const SKIN_POINTS = [50, 280, 101, 330, 118, 347, 117, 346, 151, 108, 337]
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const median = (values: number[]): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const linear = (value: number): number => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const encoded = (value: number): number => {
  const c = clamp(value, 0, 1)
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
}
const labCurve = (value: number): number => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116
const xyzCurve = (value: number): number => value ** 3 > 0.008856 ? value ** 3 : (value - 16 / 116) / 7.787

function rgbToLab(r: number, g: number, b: number): Lab {
  const red = linear(r), green = linear(g), blue = linear(b)
  const x = labCurve((0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047)
  const y = labCurve(0.2126729 * red + 0.7151522 * green + 0.072175 * blue)
  const z = labCurve((0.0193339 * red + 0.119192 * green + 0.9503041 * blue) / 1.08883)
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

function labToRgb(lab: Lab): [number, number, number] {
  const fy = (lab.l + 16) / 116
  const fx = fy + lab.a / 500, fz = fy - lab.b / 200
  const x = 0.95047 * xyzCurve(fx), y = xyzCurve(fy), z = 1.08883 * xyzCurve(fz)
  return [
    encoded(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    encoded(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    encoded(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ]
}

function hex(rgb: readonly number[]): string {
  return '#' + rgb.map(value => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')).join('')
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function point(points: ArrayLike<number>, index: number): { x: number; y: number } {
  return { x: points[index * 3] ?? 0, y: points[index * 3 + 1] ?? 0 }
}

function imagePoint(points: ArrayLike<number>, index: number, width: number, height: number, span: number): { x: number; y: number } {
  const p = point(points, index)
  return { x: (p.x / span + 0.5) * width, y: (0.5 - p.y / span) * height }
}

function patchLab(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, radius: number): Lab | null {
  const reds: number[] = [], greens: number[] = [], blues: number[] = []
  for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(height - 1, Math.ceil(y + radius)); py++) {
    for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(width - 1, Math.ceil(x + radius)); px++) {
      const i = (py * width + px) * 4
      if (data[i + 3]! < 200) continue
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
      reds.push(r); greens.push(g); blues.push(b)
    }
  }
  if (reds.length < 4) return null
  // Median channels reject isolated freckles, highlights, and compression noise.
  return rgbToLab(median(reds), median(greens), median(blues))
}

function sampleSkin(data: Uint8ClampedArray, width: number, height: number, points: ArrayLike<number>, span: number): Sample[] {
  const samples: Sample[] = []
  for (const index of SKIN_POINTS) {
    const p = imagePoint(points, index, width, height, span)
    if (p.x < 3 || p.y < 3 || p.x >= width - 3 || p.y >= height - 3) continue
    const lab = patchLab(data, width, height, p.x, p.y, Math.max(2, width / 180))
    if (lab) samples.push({ x: p.x, y: p.y, lab })
  }
  return samples
}

function fieldAt(samples: Sample[], x: number, y: number, scale: number): Lab {
  let weight = 0, l = 0, a = 0, b = 0
  for (const sample of samples) {
    const dx = (x - sample.x) / scale, dy = (y - sample.y) / scale
    const w = 1 / (1 + dx * dx + dy * dy) ** 2
    weight += w; l += w * sample.lab.l; a += w * sample.lab.a; b += w * sample.lab.b
  }
  return { l: l / weight, a: a / weight, b: b / weight }
}

function paintRegion(context: CanvasRenderingContext2D, points: ArrayLike<number>, indices: number[], width: number, height: number, span: number, lineWidth: number): void {
  if (!indices.length) return
  const first = imagePoint(points, indices[0]!, width, height, span)
  context.beginPath(); context.moveTo(first.x, first.y)
  for (const index of indices.slice(1)) {
    const p = imagePoint(points, index, width, height, span)
    context.lineTo(p.x, p.y)
  }
  context.lineWidth = lineWidth; context.lineCap = 'round'; context.lineJoin = 'round'; context.stroke()
}

function featureRegions(points: ArrayLike<number>, width: number, height: number, span: number): Uint8ClampedArray {
  const mask = makeCanvas(width, height)
  const context = mask.getContext('2d', { willReadFrequently: true })!
  context.strokeStyle = '#fff'; context.fillStyle = '#fff'
  const faceWidth = Math.abs(imagePoint(points, 234, width, height, span).x - imagePoint(points, 454, width, height, span).x)
  const browWidth = Math.max(3, faceWidth * 0.052)
  paintRegion(context, points, [70, 63, 105, 66, 107], width, height, span, browWidth)
  paintRegion(context, points, [336, 296, 334, 293, 300], width, height, span, browWidth)
  const left = imagePoint(points, 61, width, height, span), right = imagePoint(points, 291, width, height, span)
  const upperLip = imagePoint(points, 13, width, height, span)
  const nose = imagePoint(points, 2, width, height, span)
  const centreX = (left.x + right.x) / 2
  const lipHalf = Math.max(2, Math.abs(left.x - right.x) / 2)
  // Upper lip band stops below the nostrils and above the visible lip.
  const moustacheTop = Math.max(nose.y + faceWidth * 0.035, upperLip.y - faceWidth * 0.105)
  const moustacheBottom = upperLip.y - faceWidth * 0.012
  if (moustacheBottom > moustacheTop) {
    context.beginPath()
    context.ellipse(centreX, (moustacheTop + moustacheBottom) / 2, lipHalf * 1.12, (moustacheBottom - moustacheTop) / 2, 0, 0, Math.PI * 2)
    context.fill()
  }
  const lowerLip = imagePoint(points, 14, width, height, span)
  const chin = imagePoint(points, 152, width, height, span)
  const beardTop = lowerLip.y + faceWidth * 0.035
  const beardBottom = chin.y + faceWidth * 0.04
  if (beardBottom > beardTop) {
    context.beginPath()
    context.ellipse(centreX, (beardTop + beardBottom) / 2, faceWidth * 0.37, (beardBottom - beardTop) / 2, 0, 0, Math.PI * 2)
    context.fill()
    paintRegion(context, points, [172, 136, 150, 149, 176, 152, 400, 378, 379, 365, 397], width, height, span, faceWidth * 0.12)
  }
  // This thin strip captures the hairline at the top of the projected face.
  paintRegion(context, points, [103, 67, 109, 10, 338, 297, 332], width, height, span, faceWidth * 0.09)
  return context.getImageData(0, 0, width, height).data
}

function irisColour(data: Uint8ClampedArray, width: number, height: number, points: ArrayLike<number>, span: number): string {
  const picks: Lab[] = []
  for (const corners of [[33, 133], [362, 263]]) {
    const a = imagePoint(points, corners[0]!, width, height, span)
    const b = imagePoint(points, corners[1]!, width, height, span)
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2
    const radius = clamp(Math.abs(a.x - b.x) * 0.14, 2, width * 0.025)
    const sample = patchLab(data, width, height, x, y, radius)
    if (sample && sample.l < 65) picks.push(sample)
  }
  if (!picks.length) return '#4a3325'
  const chosen = { l: clamp(median(picks.map(p => p.l)), 14, 42), a: clamp(median(picks.map(p => p.a)), -3, 13), b: clamp(median(picks.map(p => p.b)), 3, 23) }
  return hex(labToRgb(chosen))
}

export interface FaceSurfaceAnalysis {
  albedo: HTMLCanvasElement
  /** White RGB with alpha marking brows, hairline, moustache, and beard pixels. */
  features: HTMLCanvasElement
  skin: string
  iris: string
  hairColour: string
  hasBeard: boolean
  metrics: { medianBeforeL: number; medianAfterL: number; correctionL: number; sampleCount: number; beardCoverage: number }
}

export function analyseFaceSurface(source: HTMLCanvasElement, points: ArrayLike<number>, span = 1.5): FaceSurfaceAnalysis {
  const width = source.width, height = source.height
  const original = source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height)
  const albedo = makeCanvas(width, height)
  const features = makeCanvas(width, height)
  const sourceData = original.data
  const samples = sampleSkin(sourceData, width, height, points, span)
  const medianBeforeL = median(samples.map(sample => sample.lab.l))
  const reference: Lab = {
    l: medianBeforeL,
    a: median(samples.map(sample => sample.lab.a)),
    b: median(samples.map(sample => sample.lab.b)),
  }
  const corrected = new ImageData(new Uint8ClampedArray(sourceData), width, height)
  const regions = featureRegions(points, width, height, span)
  const featureImage = new ImageData(width, height)
  const faceWidth = Math.abs(imagePoint(points, 234, width, height, span).x - imagePoint(points, 454, width, height, span).x)
  const scale = Math.max(1, faceWidth * 0.3)
  const residuals: { index: number; strength: number }[] = []
  const lowerLip = imagePoint(points, 14, width, height, span).y
  const chin = imagePoint(points, 152, width, height, span)
  const mouth = imagePoint(points, 13, width, height, span)
  let beardCandidates = 0, beardHits = 0

  if (samples.length >= 3) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (sourceData[i + 3]! < 200) continue
    const field = fieldAt(samples, x, y, scale)
    const originalLab = rgbToLab(sourceData[i]!, sourceData[i + 1]!, sourceData[i + 2]!)
    const residual = field.l - originalLab.l
    const region = regions[i + 3]! > 0
    // A little local contrast survives in the colour layer; dense dark features get their own mask.
    const highlight = region ? 0 : clamp(originalLab.l - field.l - 15, 0, 28) * 0.35
    const changed: Lab = {
      l: clamp(originalLab.l + clamp((reference.l - field.l) * 0.8, -12, 12) - highlight, 0, 100),
      a: originalLab.a + clamp((reference.a - field.a) * 0.65, -5, 5),
      b: originalLab.b + clamp((reference.b - field.b) * 0.65, -5, 5),
    }
    const rgb = labToRgb(changed)
    corrected.data[i] = rgb[0]; corrected.data[i + 1] = rgb[1]; corrected.data[i + 2] = rgb[2]
    if (region) {
      const beard = y > lowerLip + faceWidth * 0.035 && y < chin.y - faceWidth * 0.02 && Math.abs(x - chin.x) < faceWidth * (0.38 - 0.18 * clamp((y - mouth.y) / Math.max(1, chin.y - mouth.y), 0, 1))
      if (beard) beardCandidates++
      const strength = clamp((residual - 8) / 22, 0, 1) * regions[i + 3]! / 255
      if (strength > 0.65 && beard && originalLab.l < reference.l * 0.55 && residual > 15) beardHits++
      if (strength > 0) residuals.push({ index: i, strength })
    }
  }

  // Evaluate exactly the same skin patches on both images. The global offset may only darken.
  const initialAfter = sampleSkin(corrected.data, width, height, points, span)
  const initialMedian = median(initialAfter.map(sample => sample.lab.l))
  // Leave a small margin for round-trip RGB quantisation.
  const correctionL = Math.min(0, medianBeforeL - initialMedian - 0.3)
  if (correctionL < -0.02) for (let i = 0; i < corrected.data.length; i += 4) {
    if (corrected.data[i + 3]! < 200) continue
    const lab = rgbToLab(corrected.data[i]!, corrected.data[i + 1]!, corrected.data[i + 2]!)
    const rgb = labToRgb({ ...lab, l: clamp(lab.l + correctionL, 0, 100) })
    corrected.data[i] = rgb[0]; corrected.data[i + 1] = rgb[1]; corrected.data[i + 2] = rgb[2]
  }
  const after = sampleSkin(corrected.data, width, height, points, span)
  const medianAfterL = median(after.map(sample => sample.lab.l))
  const skin = hex(labToRgb({ l: medianAfterL, a: median(after.map(sample => sample.lab.a)), b: median(after.map(sample => sample.lab.b)) }))
  for (const residual of residuals) {
    const alpha = Math.round(residual.strength * 255)
    featureImage.data[residual.index] = 255
    featureImage.data[residual.index + 1] = 255
    featureImage.data[residual.index + 2] = 255
    featureImage.data[residual.index + 3] = alpha
  }
  albedo.getContext('2d')!.putImageData(corrected, 0, 0)
  features.getContext('2d')!.putImageData(featureImage, 0, 0)
  const beardCoverage = beardHits / Math.max(1, beardCandidates)
  return {
    albedo, features,
    skin: samples.length ? skin : '#785b49',
    iris: irisColour(sourceData, width, height, points, span),
    hairColour: '#302720',
    hasBeard: beardCandidates > 20 && beardCoverage > 0.42,
    metrics: { medianBeforeL, medianAfterL, correctionL, sampleCount: samples.length, beardCoverage },
  }
}

function skinLab(data: Uint8ClampedArray, width: number, height: number, points: ArrayLike<number>, span: number): Lab | null {
  const samples = sampleSkin(data, width, height, points, span)
  if (samples.length < 3) return null
  return { l: median(samples.map(sample => sample.lab.l)), a: median(samples.map(sample => sample.lab.a)), b: median(samples.map(sample => sample.lab.b)) }
}

/** The tone a prepared portrait actually shows at its cheek and forehead patches. */
export function measureSkinTone(canvas: HTMLCanvasElement, points: ArrayLike<number>, span = 1.5): string | null {
  const lab = skinLab(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, points, span)
  return lab ? hex(labToRgb(lab)) : null
}

// Every second point of the landmark face oval, starting at the top of the forehead.
const EDGE_POINTS = [10, 297, 284, 389, 454, 361, 397, 379, 400, 152, 176, 150, 172, 132, 234, 162, 54, 67]

/** Where the portrait's rim is lit differently from its cheeks, in Lab steps towards the cheek tone. */
export function faceEdgeSamples(data: Uint8ClampedArray, mask: Uint8ClampedArray, width: number, height: number, points: ArrayLike<number>, reference: Lab, span = 1.5): Sample[] {
  const centre = EDGE_POINTS.reduce((sum, index) => { const p = point(points, index); return { x: sum.x + p.x / EDGE_POINTS.length, y: sum.y + p.y / EDGE_POINTS.length } }, { x: 0, y: 0 })
  const samples: Sample[] = []
  for (const index of EDGE_POINTS) {
    const p = point(points, index)
    // Step inside the outline, where the picture still shows the face and not its background.
    const x = ((centre.x + (p.x - centre.x) * 0.86) / span + 0.5) * width, y = (0.5 - (centre.y + (p.y - centre.y) * 0.86) / span) * height
    if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) continue
    if (mask[(Math.round(y) * width + Math.round(x)) * 4 + 3]! > 50) continue
    const lab = patchLab(data, width, height, x, y, Math.max(2, width / 180))
    // A large step is hair, beard or a cast shadow, which is detail to keep and not a gradient.
    if (!lab || Math.abs(reference.l - lab.l) > 22) continue
    samples.push({ x, y, lab: { l: clamp((reference.l - lab.l) * 0.75, -9, 9), a: clamp((reference.a - lab.a) * 0.75, -4, 4), b: clamp((reference.b - lab.b) * 0.75, -4, 4) } })
  }
  return samples.length >= 6 ? samples : []
}

/**
 * Move skin to the member's confirmed tone with the transfer the head and body are painted with,
 * leaving eyes, an open mouth, hair and facial hair as they are, and ease the rim of the face
 * towards that tone so it meets the head around it. Local contrast is kept.
 */
export function confirmFaceTone(canvas: HTMLCanvasElement, features: HTMLCanvasElement, points: ArrayLike<number>, measured: string, chosen: string): void {
  const channels = (value: string): [number, number, number] => [1, 3, 5].map(at => parseInt(value.slice(at, at + 2), 16)) as [number, number, number]
  const context = canvas.getContext('2d')!
  const size = canvas.width, height = canvas.height
  const pixels = context.getImageData(0, 0, size, height), data = pixels.data
  const mask = features.getContext('2d')!.getImageData(0, 0, size, height).data
  // The picture in hand is the authority; the reported measurement came from another pass over it.
  const source = skinLab(data, size, height, points, 1.5) ?? rgbToLab(...channels(measured)), target = rgbToLab(...channels(chosen))
  const shifted = Math.hypot(target.l - source.l, target.a - source.a, target.b - source.b) >= 1
  const width = Math.abs(points[454 * 3]! - points[234 * 3]!)
  const centre = (a: number, b: number): { x: number; y: number } => ({ x: (points[a * 3]! + points[b * 3]!) / 2, y: (points[a * 3 + 1]! + points[b * 3 + 1]!) / 2 })
  const eyeCentres = [centre(33, 133), centre(362, 263)]
  // Between parted lips are teeth, which no skin tone changes.
  const mouth = centre(13, 14), parted = Math.abs(points[13 * 3 + 1]! - points[14 * 3 + 1]!) / 2, mouthHalf = Math.abs(points[78 * 3]! - points[308 * 3]!) / 2
  const untouched = (x: number, y: number): boolean => eyeCentres.some(p => ((x - p.x) / (width * 0.12)) ** 2 + ((y - p.y) / (width * 0.045)) ** 2 < 1)
    || (parted > width * 0.01 && ((x - mouth.x) / Math.max(0.001, mouthHalf)) ** 2 + ((y - mouth.y) / (parted * 1.15)) ** 2 < 1)
  const lumaAt = (at: number): number => 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!
  if (shifted) {
    // A texel keeps its own relation to the cheeks, as on the body: shading is neither flattened nor crushed.
    const from = labToRgb(source), to = channels(chosen), transfer = skinTransfer(from, to, 1)
    const skinLuma = Math.max(1, luma(from)), darkest = luma(to) / 2
    for (let i = 0; i < data.length; i += 4) {
      if (untouched((i / 4 % size / size - 0.5) * 1.5, (0.5 - Math.floor(i / 4 / size) / height) * 1.5)) continue
      // Hair, brows, lashes and nostrils are far darker than the skin beside them.
      const before = lumaAt(i), shade = clamp((before / skinLuma - 0.35) / 0.3, 0, 1)
      const keep = Math.max(mask[i + 3]! / 255, 1 - shade * shade * (3 - 2 * shade))
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
      toneSkin(data, i, transfer)
      if (!keep) continue
      // They stay as photographed. Under a darker tone they follow it down as far as half that tone, never left lighter than the skin.
      const kept = Math.min(1, Math.max(darkest, lumaAt(i)) / Math.max(1, before)) * keep
      data[i] = r * kept + data[i]! * (1 - keep); data[i + 1] = g * kept + data[i + 1]! * (1 - keep); data[i + 2] = b * kept + data[i + 2]! * (1 - keep)
    }
  }
  // The rim is compared with the cheeks as they are now, so the step is the one the head will show.
  const edge = faceEdgeSamples(data, mask, size, height, points, shifted ? skinLab(data, size, height, points, 1.5) ?? target : source)
  if (!edge.length && !shifted) return
  const middle = centre(454, 234).x, level = centre(10, 152).y
  const tall = Math.max(0.01, Math.abs(points[10 * 3 + 1]! - points[152 * 3 + 1]!) / 2), wide = Math.max(0.01, width / 2)
  const scale = Math.max(1, width / 1.5 * size * 0.3)
  if (edge.length) for (let i = 0; i < data.length; i += 4) {
    const column = i / 4 % size, row = Math.floor(i / 4 / size)
    const x = (column / size - 0.5) * 1.5
    const y = (0.5 - row / height) * 1.5
    if (untouched(x, y)) continue
    const rim = Math.hypot((x - middle) / wide, (y - level) / tall)
    // Nothing changes in the middle of the face; the correction grows towards the outline.
    const reach = rim <= 0.6 ? 0 : rim >= 1 ? 1 : ((rim - 0.6) / 0.4) ** 2 * (3 - 2 * (rim - 0.6) / 0.4)
    if (!reach) continue
    const keep = mask[i + 3]! / 255
    const lab = rgbToLab(data[i]!, data[i + 1]!, data[i + 2]!)
    const ease = fieldAt(edge, column, row, scale)
    const adjusted = labToRgb({ l: clamp(lab.l + ease.l * reach, 0, 100), a: lab.a + ease.a * reach, b: lab.b + ease.b * reach })
    for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! * keep + adjusted[c]! * (1 - keep)
  }
  context.putImageData(pixels, 0, 0)
}

const SKIN_CONTRAST = 0.82
const SKIN_CEILING = 245
const luma = (colour: readonly number[]): number => 0.2126 * colour[0]! + 0.7152 * colour[1]! + 0.0722 * colour[2]!

export interface SkinTransfer { source: readonly number[]; target: readonly number[]; contrast: number; lift: number }

/**
 * One transfer for every skin texel of a character, on the head and the body alike. `source` is
 * the stock tone of the cheeks, so a texel keeps its authored relation to the face at any tone.
 * A photo passes its own cheeks and a `contrast` of 1: its shading is the member's, not authored.
 */
export function skinTransfer(source: readonly number[], target: readonly number[], contrast = SKIN_CONTRAST): SkinTransfer {
  // Palms and highlights were painted for the stock tone; a lighter tone keeps less of their lift.
  return { source, target, contrast, lift: contrast * Math.min(1, luma(source) / Math.max(1, luma(target))) }
}

export function toneSkin(data: Uint8ClampedArray, at: number, transfer: SkinTransfer, opacity = 1): void {
  for (let channel = 0; channel < 3; channel++) {
    const old = data[at + channel]!, target = transfer.target[channel]!
    const ratio = old / Math.max(1, transfer.source[channel]!)
    let toned = target * ratio ** transfer.contrast
    if (ratio > 1) {
      // Above the reference the curve bends towards a ceiling, so light areas keep detail and hue.
      const room = Math.max(1, SKIN_CEILING - target)
      toned = target + room * (1 - Math.exp(-target * (ratio ** transfer.lift - 1) / room))
    }
    data[at + channel] = Math.min(255, old * (1 - opacity) + toned * opacity)
  }
}
