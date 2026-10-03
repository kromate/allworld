/** Creator-only GNM fitting. The saved 468-point meshes contain shape, not the source photos. */
export interface IdentityCalibration {
  /** Change when the cast's eye anchors or landmark template changes. */
  revision: string
  eyes: { left: readonly [number, number, number]; right: readonly [number, number, number] }
  /** Existing cast landmark positions in the head bind frame (468 xyz triples). */
  faceLandmarks: readonly number[]
}

export interface FittedIdentityParameters {
  kind: 'gnm24-mesh468-v1'
  modelSha256: '3a8553ee5587bf4a6a6117cf2c7be50a51b925834c5b2dd0c39abdf5039e426a'
  calibrationRevision: string
  coefficients: number[]
  frames: number
  points: number
  rmsBeforeMm: number
  rmsAfterMm: number
}

/** Transient creator preview data. These arrays are never part of FaceScan. */
export interface IdentityDisplacementField {
  calibrationRevision: string
  neutral: Float32Array
  delta: Float32Array
  skinVertices: Uint32Array
  span: number
  target: readonly [number, number, number]
}

export interface FittedSurfaceIdentity {
  parameters: FittedIdentityParameters
  field: IdentityDisplacementField
}

