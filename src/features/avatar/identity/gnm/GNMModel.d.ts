/** Typed boundary for the pinned Apache-2.0 XR Blocks JavaScript model. */
export function parseContainer(buffer: ArrayBuffer): { meta: unknown; sections: unknown }
export class GNMHeadModel {
  constructor(meta: unknown, sections: unknown)
  readonly numVertices: number
  readonly identityDim: number
  readonly materialId: Uint8Array
  resetIdentity(): void
  resetExpression(): void
  resetPose(): void
  setIdentityVector(values: Float32Array): void
  computeVertices(out: Float32Array): void
  computeLandmarks(vertices: Float32Array, out: Float32Array): void
}
