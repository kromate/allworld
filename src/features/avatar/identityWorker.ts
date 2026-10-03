import { loadAsset } from '../../assets/publicAssets.ts'
import type { FittedSurfaceIdentity, IdentityCalibration } from '../../world/avatarIdentity.ts'
import { GNMHeadModel, parseContainer } from './identity/gnm/GNMModel.js'
import { fitIdentity } from './identity/gnm/FaceFit.js'

interface FitMessage { front: string; left?: string; right?: string; calibration: IdentityCalibration }
type Point = { x: number; y: number; z: number }

const PACK = '/avatars/identity/gnm-identity24.pack.gz'
const MODEL_SHA = '3a8553ee5587bf4a6a6117cf2c7be50a51b925834c5b2dd0c39abdf5039e426a'
const MESH_POINTS = 468

function decodeMesh(encoded: string): Point[] {
  const binary = atob(encoded)
  if (binary.length !== MESH_POINTS * 3 * 2) throw new Error('The face shape is incomplete.')
  const view = new DataView(Uint8Array.from(binary, char => char.charCodeAt(0)).buffer)
  const points: Point[] = []
  for (let i = 0; i < MESH_POINTS; i++) {
    const at = i * 6
    // The saved mesh has y up and z forward. FaceFit negates MediaPipe y/z;
    // reverse those signs here so its model-axis conversion reproduces the mesh.
    points.push({
      x: view.getInt16(at, true) / 8192,
      y: -view.getInt16(at + 2, true) / 8192,
      z: -view.getInt16(at + 4, true) / 8192,
    })
  }
  const width = Math.abs(points[454]!.x - points[234]!.x)
  if (!Number.isFinite(width) || width < 0.1) throw new Error('The face shape has invalid scale.')
  return points
}

function anchor(vertices: Float32Array, landmarks: Float32Array, calibration: IdentityCalibration): {
  positions: Float32Array; span: number; target: readonly [number, number, number]
} {
  const midpoint = (a: number, b: number): [number, number, number] => [0, 1, 2].map(axis =>
    (landmarks[a * 3 + axis]! + landmarks[b * 3 + axis]!) / 2,
  ) as [number, number, number]
  const left = midpoint(36, 39), right = midpoint(42, 45)
  const source = left.map((v, axis) => (v + right[axis]!) / 2)
  const target: [number, number, number] = [0, 1, 2].map(axis =>
    (calibration.eyes.left[axis]! + calibration.eyes.right[axis]!) / 2,
  ) as [number, number, number]
  const sourceSpan = Math.hypot(...left.map((v, axis) => v - right[axis]!))
  const span = Math.hypot(...calibration.eyes.left.map((v, axis) => v - calibration.eyes.right[axis]!))
  if (!Number.isFinite(span) || sourceSpan < 1e-8 || span < 1e-8) throw new Error('The avatar eye anchors are invalid.')
  const scale = span / sourceSpan
  return { positions: Float32Array.from(vertices, (v, i) => (v - source[i % 3]!) * scale + target[i % 3]!), span, target }
}

async function fit(message: FitMessage): Promise<FittedSurfaceIdentity> {
  const { calibration } = message
  if (!calibration.revision || calibration.faceLandmarks.length !== MESH_POINTS * 3) {
    throw new Error('The avatar face calibration is unavailable.')
  }
  const meshes = [message.front, message.left, message.right].filter((value): value is string => Boolean(value))
  const frames = meshes.map(mesh => ({ landmarks: decodeMesh(mesh), aspect: 1 }))
  const unpacked = (await loadAsset(PACK)).buffer
  const magic = new TextDecoder().decode(new Uint8Array(unpacked, 0, Math.min(4, unpacked.byteLength)))
  if (magic !== 'GNMW') throw new Error('The identity model URL returned a page or an invalid pack.')
  if (unpacked.byteLength !== 2_193_736) throw new Error('The identity model has the wrong size.')
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', unpacked)), byte => byte.toString(16).padStart(2, '0')).join('')
  if (digest !== MODEL_SHA) throw new Error('The identity model failed its integrity check.')
  const { meta, sections } = parseContainer(unpacked)
  const model = new GNMHeadModel(meta, sections)
  if (model.identityDim !== 24) throw new Error('The identity model revision does not match the fitter.')
  model.resetIdentity(); model.resetExpression(); model.resetPose()
  const neutral = new Float32Array(model.numVertices * 3)
  model.computeVertices(neutral)
  const neutralLandmarks = new Float32Array(68 * 3)
  model.computeLandmarks(neutral, neutralLandmarks)
  const result = fitIdentity(model, frames[0]!.landmarks, 1, { frames })
  if (result.identity.length !== 24 || result.identity.some(value => !Number.isFinite(value) || Math.abs(value) > 3.0001)) {
    throw new Error('The identity fit was unstable.')
  }
  model.setIdentityVector(result.identity)
  const fitted = new Float32Array(neutral.length)
  model.computeVertices(fitted)
  const fittedLandmarks = new Float32Array(68 * 3)
  model.computeLandmarks(fitted, fittedLandmarks)
  const anchoredNeutral = anchor(neutral, neutralLandmarks, calibration)
  const anchoredFit = anchor(fitted, fittedLandmarks, calibration)
  const skinVertices = Uint32Array.from(Array.from({ length: model.numVertices }, (_, i) => i).filter(i => model.materialId[i] === 0))
  if (skinVertices.length === 0) throw new Error('The identity model has no skin surface.')
  return {
    parameters: {
      kind: 'gnm24-mesh468-v1', modelSha256: MODEL_SHA,
      calibrationRevision: calibration.revision,
      coefficients: Array.from(result.identity), frames: result.frameCount,
      points: result.points, rmsBeforeMm: result.rmsBefore, rmsAfterMm: result.rmsAfter,
    },
    field: {
      calibrationRevision: calibration.revision,
      neutral: anchoredNeutral.positions,
      delta: Float32Array.from(anchoredFit.positions, (value, i) => value - anchoredNeutral.positions[i]!),
      skinVertices, span: anchoredNeutral.span, target: anchoredNeutral.target,
    },
  }
}

self.onmessage = (event: MessageEvent<FitMessage>): void => {
  void fit(event.data).then(result => {
    const { neutral, delta, skinVertices } = result.field
    self.postMessage({ kind: 'fitted', result }, { transfer: [neutral.buffer, delta.buffer, skinVertices.buffer] })
  }).catch(error => {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Identity fitting failed.' })
  })
}
