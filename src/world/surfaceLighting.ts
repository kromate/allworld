/** A bounded illumination-plane correction. This is not recovery of true skin albedo. */
const SKIN_PATCHES = [50, 280, 101, 330, 118, 347, 117, 346, 151, 108, 337]
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const linear = (value: number): number => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
const srgb = (value: number): number => value <= 0.0031308 ? value * 12.92 : 1.055 * Math.max(0, value) ** (1 / 2.4) - 0.055
const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

interface Sample { x: number; y: number; colour: number[] }

function solve(matrix: number[][], values: number[]): number[] | null {
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++) if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row
    ;[matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!]
    ;[values[column], values[pivot]] = [values[pivot]!, values[column]!]
    const divisor = matrix[column]![column]!
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-9) return null
    for (let j = column; j < 3; j++) matrix[column]![j]! /= divisor
    values[column]! /= divisor
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = matrix[row]![column]!
      for (let j = column; j < 3; j++) matrix[row]![j]! -= factor * matrix[column]![j]!
      values[row]! -= factor * values[column]!
    }
  }
  return values.every(Number.isFinite) ? values : null
}

/** Correct broad colour gradients continuously, without hard feature-region boundaries. */
export function neutralizePortraitLighting(source: HTMLCanvasElement, points: ArrayLike<number>, span = 1.5): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width; canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(source, 0, 0)
  const image = context.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data
  const samples: Sample[] = []
  for (const id of SKIN_PATCHES) {
    const x = points[id * 3]!, y = points[id * 3 + 1]!
    const px = Math.round((x / span + 0.5) * canvas.width), py = Math.round((0.5 - y / span) * canvas.height)
    if (px < 3 || py < 3 || px >= canvas.width - 3 || py >= canvas.height - 3) continue
    const colour: number[] = []
    for (let channel = 0; channel < 3; channel++) {
      const patch: number[] = []
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const at = ((py + dy) * canvas.width + px + dx) * 4
        if (pixels[at + 3]! >= 200) patch.push(linear(pixels[at + channel]! / 255))
      }
      colour.push(median(patch))
    }
    if (colour.every(value => value > 0.002)) samples.push({ x, y, colour })
  }
  if (samples.length < 5) return canvas
  const coefficients: number[][] = [], reference: number[] = []
  for (let channel = 0; channel < 3; channel++) {
    const centre = median(samples.map(sample => Math.log(Math.max(0.002, sample.colour[channel]!))))
    reference.push(centre)
    let fit = [centre, 0, 0]
    for (let iteration = 0; iteration < 3; iteration++) {
      const matrix = [[0.0001, 0, 0], [0, 0.1, 0], [0, 0, 0.1]], values = [0, 0, 0]
      for (const sample of samples) {
        const axes = [1, sample.x, sample.y], value = Math.log(Math.max(0.002, sample.colour[channel]!))
        const residual = value - axes.reduce((sum, axis, i) => sum + axis * fit[i]!, 0)
        const weight = Math.min(1, 0.3 / Math.max(Math.abs(residual), 1e-6))
        for (let row = 0; row < 3; row++) {
          values[row]! += weight * axes[row]! * value
          for (let column = 0; column < 3; column++) matrix[row]![column]! += weight * axes[row]! * axes[column]!
        }
      }
      fit = solve(matrix, values) ?? fit
    }
    coefficients.push(fit)
  }
  for (let at = 0; at < pixels.length; at += 4) {
    const x = (at / 4 % canvas.width) / canvas.width * span - span / 2
    const y = span / 2 - Math.floor(at / 4 / canvas.width) / canvas.height * span
    for (let channel = 0; channel < 3; channel++) {
      const fit = coefficients[channel]!
      const predicted = fit[0]! + fit[1]! * x + fit[2]! * y
      const gain = clamp(Math.exp((reference[channel]! - predicted) * 0.65), 0.67, 1.5)
      pixels[at + channel] = clamp(Math.round(srgb(linear(pixels[at + channel]! / 255) * gain) * 255), 0, 255)
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}
