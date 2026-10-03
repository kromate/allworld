import * as THREE from 'three'
import { AvatarActor } from './avatars.ts'
import type { AvatarLook, FaceScan } from '../shared/model.ts'

let cacheEpoch = 0
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, string>()
const cancelled = (signal?: AbortSignal): void => { if (signal?.aborted) throw new DOMException('Portrait cancelled', 'AbortError') }

/** Pass only a face the current viewer is allowed to see. No photo or portrait is persisted. */
export function renderAvatarPortrait(look: AvatarLook, face: FaceScan | null, options: { key: string; signal?: AbortSignal; size?: number }): Promise<string> {
  const epoch = cacheEpoch
  const guard = (): void => { cancelled(options.signal); if (epoch !== cacheEpoch) throw new DOMException('Portrait access changed', 'AbortError') }
  const size = Math.max(64, Math.min(256, options.size ?? 128))
  const stamp = JSON.stringify([options.key, look, Boolean(face), size])
  const existing = cache.get(stamp)
  if (existing) { guard(); return Promise.resolve(existing) }
  const work = async (): Promise<string> => {
    guard()
    const cached = cache.get(stamp)
    if (cached) return cached
    const actor = new AvatarActor(look)
    let renderer: THREE.WebGLRenderer | null = null
    try {
      await actor.ready
      guard()
      actor.setFace(face, face ? options.key : '')
      await actor.faceReady
      guard()
      const canvas = document.createElement('canvas')
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
      renderer.setSize(size, size)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      const scene = new THREE.Scene()
      scene.background = new THREE.Color('#343342')
      const key = new THREE.DirectionalLight('#fff8f0', 2.2)
      key.position.set(2, 3, 4)
      scene.add(key, new THREE.HemisphereLight('#edf2ff', '#6a5b50', 1.5), actor.group)
      actor.update(0)
      const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10)
      camera.position.set(0, actor.height - 0.14, 0.82)
      camera.lookAt(0, actor.height - 0.16, 0)
      // Authored hair swaps into the same group once its pack is ready.
      const pending: Promise<unknown>[] = []
      actor.group.traverse(node => { if (node.userData.hairReady instanceof Promise) pending.push(node.userData.hairReady) })
      if (pending.length) await Promise.allSettled(pending)
      guard()
      renderer.render(scene, camera)
      const image = canvas.toDataURL('image/jpeg', 0.88)
      cache.set(stamp, image)
      while (cache.size > 32) cache.delete(cache.keys().next().value!)
      return image
    } finally { actor.dispose(); renderer?.dispose(); renderer?.forceContextLoss() }
  }
  const pending = queue.then(work, work)
  queue = pending.catch(() => undefined)
  return pending
}

/** Call on account/audience changes; images never outlive a viewer's access deliberately. */
export function clearAvatarPortraits(): void { cacheEpoch++; cache.clear() }
