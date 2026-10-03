import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { IdentityCalibration, IdentityDisplacementField } from './avatarIdentity.ts'

interface Node { id: number; axis: number; left: Node | null; right: Node | null }
const clamp = (value: number): number => Math.max(0, Math.min(1, value))
const smooth = (a: number, b: number, value: number): number => {
  const t = clamp((value - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Reproduce the existing face fit's vertex ordering for the unfitted head. Caller disposes it. */
export function compactIdentityStock(source: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!source.index) throw new Error('The stock head has no triangle indices.')
  const used = [...new Set(Array.from(source.index.array))]
  const remap = new Map(used.map((id, i) => [id, i]))
  const compact = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const values = name === 'skinIndex' ? new Uint16Array(used.length * attribute.itemSize) : new Float32Array(used.length * attribute.itemSize)
    for (let i = 0; i < used.length; i++) for (let axis = 0; axis < attribute.itemSize; axis++) {
      values[i * attribute.itemSize + axis] = attribute.getComponent(used[i]!, axis)
    }
    compact.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize))
  }
  compact.setIndex(Array.from(source.index.array, id => remap.get(id)!))
  const merged = mergeVertices(compact, 0.0001)
  compact.dispose()
  return merged
}

function treeFor(positions: Float32Array, ids: number[], depth = 0): Node | null {
  if (ids.length === 0) return null
  const axis = depth % 3
  ids.sort((a, b) => positions[a * 3 + axis]! - positions[b * 3 + axis]!)
  const middle = ids.length >> 1
  return { id: ids[middle]!, axis, left: treeFor(positions, ids.slice(0, middle), depth + 1), right: treeFor(positions, ids.slice(middle + 1), depth + 1) }
}

function nearest(positions: Float32Array, root: Node | null, point: THREE.Vector3): { id: number; distance: number }[] {
  const best: { id: number; distance: number }[] = []
  const visit = (node: Node | null): void => {
    if (!node) return
    const at = node.id * 3
    const distance = (positions[at]! - point.x) ** 2 + (positions[at + 1]! - point.y) ** 2 + (positions[at + 2]! - point.z) ** 2
    if (best.length < 8 || distance < best[best.length - 1]!.distance) {
      best.push({ id: node.id, distance })
      best.sort((a, b) => a.distance - b.distance)
      if (best.length > 8) best.pop()
    }
    const coordinate = node.axis === 0 ? point.x : node.axis === 1 ? point.y : point.z
    const gap = coordinate - positions[at + node.axis]!
    visit(gap < 0 ? node.left : node.right)
    if (best.length < 8 || gap * gap <= best[best.length - 1]!.distance) visit(gap < 0 ? node.right : node.left)
  }
  visit(root)
  return best
}

function weldNormals(geometry: THREE.BufferGeometry): void {
  geometry.computeVertexNormals()
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal')
  const sums = new Map<string, THREE.Vector3>(), keys: string[] = []
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].map(value => Math.round(value * 10000)).join('|')
    keys.push(key)
    const sum = sums.get(key) ?? new THREE.Vector3()
    sum.add(new THREE.Vector3().fromBufferAttribute(normal, i))
    sums.set(key, sum)
  }
  for (const sum of sums.values()) sum.normalize()
  for (let i = 0; i < normal.count; i++) {
    const value = sums.get(keys[i]!)!
    normal.setXYZ(i, value.x, value.y, value.z)
  }
  if (geometry.hasAttribute('tangent')) geometry.computeTangents()
}

export interface IdentityWrapResult {
  geometry: THREE.BufferGeometry
  movedVertices: number
  maxDisplacement: number
  protectedEyeVertices: number
  protectedNeckVertices: number
}

/** Small shape payload for a room client. Store separately for each head LOD. */
export interface IdentityHeadDelta {
  kind: 'gnm-wrapped-head-v1'
  templateRevision: string
  vertexCount: number
  /** Local-coordinate units per Int16 step. */
  step: number
  data: string
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

/** Bake the approved preview into the stock head's own topology; no GNM model is needed to replay it. */
export function encodeIdentityHeadDelta(args: {
  baseline: THREE.BufferGeometry; wrapped: THREE.BufferGeometry; templateRevision: string
}): IdentityHeadDelta {
  const { baseline, wrapped, templateRevision } = args
  const before = baseline.getAttribute('position'), after = wrapped.getAttribute('position')
  if (!templateRevision || !before || !after || before.count !== after.count || before.itemSize !== 3 || after.itemSize !== 3) {
    throw new Error('Identity head delta needs matching template and wrapped positions.')
  }
  if (!baseline.index || !wrapped.index || baseline.index.count !== wrapped.index.count ||
      Array.from(baseline.index.array).some((value, i) => value !== wrapped.index!.array[i])) {
    throw new Error('Identity head delta topology changed.')
  }
  let maximum = 0
  for (let i = 0; i < before.count; i++) for (let axis = 0; axis < 3; axis++) {
    const difference = after.getComponent(i, axis) - before.getComponent(i, axis)
    if (!Number.isFinite(difference)) throw new Error('Identity head delta contains a non-finite position.')
    maximum = Math.max(maximum, Math.abs(difference))
  }
  const step = maximum === 0 ? 1 : maximum / 32767
  const bytes = new Uint8Array(before.count * 3 * 2), view = new DataView(bytes.buffer)
  for (let i = 0; i < before.count; i++) for (let axis = 0; axis < 3; axis++) {
    view.setInt16((i * 3 + axis) * 2, Math.round((after.getComponent(i, axis) - before.getComponent(i, axis)) / step), true)
  }
  return { kind: 'gnm-wrapped-head-v1', templateRevision, vertexCount: before.count, step, data: encodeBytes(bytes) }
}

/** Replays a reviewed shape onto the matching fitted baseline, preserving UVs, skin weights and rig. */
export function replayIdentityHeadDelta(args: {
  baseline: THREE.BufferGeometry; payload: IdentityHeadDelta; templateRevision: string
}): THREE.BufferGeometry {
  const { baseline, payload, templateRevision } = args
  const original = baseline.getAttribute('position')
  if (payload.kind !== 'gnm-wrapped-head-v1' || payload.templateRevision !== templateRevision ||
      !original || original.count !== payload.vertexCount || !Number.isFinite(payload.step) || payload.step <= 0) {
    throw new Error('Identity head delta does not match this avatar template.')
  }
  if (payload.data.length !== Math.ceil(original.count * 3 * 2 / 3) * 4) throw new Error('Identity head delta has the wrong length.')
  const binary = atob(payload.data)
  if (binary.length !== original.count * 3 * 2) throw new Error('Identity head delta has the wrong length.')
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), view = new DataView(bytes.buffer)
  const geometry = baseline.clone(), position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) for (let axis = 0; axis < 3; axis++) {
    position.setComponent(i, axis, original.getComponent(i, axis) + view.getInt16((i * 3 + axis) * 2, true) * payload.step)
  }
  position.needsUpdate = true
  weldNormals(geometry)
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return geometry
}

/** Pure wrap of one LOD; never mutates the fitted baseline or stock head. Caller disposes the clone. */
export function wrapSurfaceIdentityGeometry(args: {
  baseline: THREE.BufferGeometry
  stock: THREE.BufferGeometry
  bind: THREE.Matrix4
  field: IdentityDisplacementField
  calibration: IdentityCalibration
  strength?: number
}): IdentityWrapResult {
  const { baseline, stock, bind, field, calibration } = args
  const strength = args.strength ?? 1
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Identity strength must be between zero and one.')
  const basePosition = baseline.getAttribute('position'), stockPosition = stock.getAttribute('position'), faceUv = baseline.getAttribute('faceUv')
  if (!basePosition || !stockPosition || !faceUv || basePosition.count !== stockPosition.count || faceUv.count !== basePosition.count) {
    throw new Error('Identity wrap needs matching stock and fitted head vertices with face UVs.')
  }
  if (!baseline.index || !stock.index || baseline.index.count !== stock.index.count ||
      Array.from(baseline.index.array).some((value, i) => value !== stock.index!.array[i])) {
    throw new Error('Identity wrap needs matching stock and fitted head topology.')
  }
  if (field.calibrationRevision !== calibration.revision) throw new Error('Identity fit belongs to a different avatar calibration.')
  if (field.neutral.length !== field.delta.length || field.neutral.length % 3 || field.skinVertices.length === 0 || field.span <= 0) {
    throw new Error('Identity displacement field is invalid.')
  }
  if (field.skinVertices.some(index => index * 3 + 2 >= field.neutral.length)) throw new Error('Identity skin vertices are invalid.')
  if (calibration.faceLandmarks.length !== 468 * 3) throw new Error('Identity face calibration is invalid.')
  const geometry = baseline.clone(), position = geometry.getAttribute('position')
  const inverse = bind.clone().invert()
  const tree = treeFor(field.neutral, Array.from(field.skinVertices))
  const old = new THREE.Vector3(), base = new THREE.Vector3(), delta = new THREE.Vector3()
  const eyes = [new THREE.Vector3(...calibration.eyes.left), new THREE.Vector3(...calibration.eyes.right)]
  const span = field.span, chin = calibration.faceLandmarks[152 * 3 + 1]!, eyeY = field.target[1], eyeZ = field.target[2]
  let movedVertices = 0, maxDisplacement = 0, protectedEyeVertices = 0, protectedNeckVertices = 0
  for (let i = 0; i < position.count; i++) {
    old.fromBufferAttribute(stockPosition, i).applyMatrix4(bind)
    base.fromBufferAttribute(basePosition, i).applyMatrix4(bind)
    const neck = smooth(chin - span * 0.18, chin + span * 0.18, old.y)
    const eyeDistance = Math.min(...eyes.map(eye => Math.hypot((old.x - eye.x) / (span * 0.27), (old.y - eye.y) / (span * 0.22), (old.z - eye.z) / (span * 0.27))))
    const eyeMask = smooth(1, 1.8, eyeDistance)
    if (eyeMask === 0) protectedEyeVertices++
    if (neck === 0) protectedNeckVertices++
    const jaw = 1 - smooth(chin + span * 0.35, eyeY - span * 0.15, old.y)
    const front = smooth(eyeZ - span * 0.5, eyeZ, old.z) * clamp(faceUv.getZ(i))
    const blend = strength * neck * eyeMask * THREE.MathUtils.lerp(0.9, THREE.MathUtils.lerp(0.18, 0.7, jaw), front)
    delta.set(0, 0, 0)
    const nearby = nearest(field.neutral, tree, old)
    let total = 0
    for (const item of nearby) {
      const weight = 1 / Math.max(item.distance, span * span * 0.0001)
      total += weight
      delta.x += field.delta[item.id * 3]! * weight
      delta.y += field.delta[item.id * 3 + 1]! * weight
      delta.z += field.delta[item.id * 3 + 2]! * weight
    }
    delta.multiplyScalar(1 / total).clampLength(0, span * 0.55)
    // Replace the corresponding stock-to-baseline shift so identity is not applied twice.
    delta.add(old).sub(base).multiplyScalar(blend).clampLength(0, span * 0.4)
    const movement = delta.length()
    if (movement > 1e-6) movedVertices++
    maxDisplacement = Math.max(maxDisplacement, movement)
    base.add(delta).applyMatrix4(inverse)
    position.setXYZ(i, base.x, base.y, base.z)
  }
  position.needsUpdate = true
  weldNormals(geometry)
  geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  return { geometry, movedVertices, maxDisplacement, protectedEyeVertices, protectedNeckVertices }
}
