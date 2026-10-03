import type { GNMHeadModel } from './GNMModel.js'

export interface FacePoint { x: number; y: number; z: number }
export interface FitFrame { landmarks: FacePoint[]; aspect: number }
export function fitIdentity(model: GNMHeadModel, points: FacePoint[], aspect: number, options: { frames: FitFrame[] }): {
  identity: Float32Array
  points: number
  frameCount: number
  rmsBefore: number
  rmsAfter: number
}
