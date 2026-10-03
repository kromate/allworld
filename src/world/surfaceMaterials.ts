import * as THREE from 'three'
import { loadPack } from './packs.ts'
import type { Quality } from './districtScene.ts'

export type SurfaceName = 'asphalt' | 'paving' | 'concrete' | 'brick' | 'plaster' | 'grass' | 'soil' | 'wood' | 'roof'
interface SurfaceOptions { projection?: 'world' | 'uv'; metresPerTile?: number }
type TextureKind = 'albedo' | 'normal' | 'roughness'
interface Bundle {
  refs: number
  textures: Partial<Record<TextureKind, THREE.Texture>>
  ready: Promise<void>
  cancelled: boolean
  bytes: number
}
const bundles = new Map<string, Bundle>()
const failures = new Set<string>()
const SCALE: Record<SurfaceName, number> = { asphalt: 2.1, paving: 1.8, concrete: 2, brick: 1, plaster: 1, grass: 2.51, soil: 1.3, wood: 1.7, roof: 8 }

async function decode(bundle: Bundle, name: SurfaceName, tier: 'low' | 'standard'): Promise<void> {
  const pack = await loadPack(`/packs/surfaces-${tier}.pack.gz`)
  const kinds: TextureKind[] = tier === 'low' ? ['albedo'] : ['albedo', 'normal', 'roughness']
  await Promise.all(kinds.map(async kind => {
    const entry = pack.entries.get(`${name}/${kind}`)
    if (!entry) throw new Error(`Missing local surface ${name}/${kind}`)
    const bytes = pack.bytes.slice(pack.base + entry.offset, pack.base + entry.offset + entry.length)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'flipY', colorSpaceConversion: 'none' })
    if (bundle.cancelled) { bitmap.close(); return }
    const texture = new THREE.Texture(bitmap)
    texture.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = tier === 'low' ? 2 : 4
    texture.needsUpdate = true
    bundle.textures[kind] = texture
    bundle.bytes += bitmap.width * bitmap.height * 4
  }))
}

function releaseBundle(key: string, bundle: Bundle): void {
  if (--bundle.refs > 0) return
  bundle.cancelled = true
  if (bundles.get(key) === bundle) bundles.delete(key)
  for (const texture of Object.values(bundle.textures)) {
    texture.dispose()
    const bitmap: unknown = texture.image
    if (bitmap instanceof ImageBitmap) bitmap.close()
  }
  bundle.textures = {}
}

/** Shared licensed images, one material lifetime per caller, bounded to 256/512px. */
export function acquireSurface(name: SurfaceName, quality: Quality, options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const tier = quality === 'low' ? 'low' : 'standard', key = `${name}/${tier}`
  let bundle = bundles.get(key)
  if (!bundle) {
    bundle = { refs: 0, textures: {}, ready: Promise.resolve(), cancelled: false, bytes: 0 }
    const loading = bundle
    loading.ready = decode(loading, name, tier).catch(() => { failures.add(key) })
    bundles.set(key, loading)
  }
  const owned = bundle
  owned.refs++
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0 })
  material.name = `surface:${name}`
  material.normalScale.setScalar(name === 'plaster' ? 0.12 : name === 'concrete' ? 0.18 : name === 'grass' || name === 'soil' ? 0.55 : 0.35)
  let disposed = false
  material.addEventListener('dispose', () => {
    if (disposed) return
    disposed = true
    releaseBundle(key, owned)
  })
  if (options.projection !== 'uv') {
    const scale = 1 / (options.metresPerTile ?? SCALE[name])
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        vec3 surfacePosition = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 surfaceNormal = normalize(mat3(modelMatrix) * normal);
        #ifdef USE_INSTANCING
          surfacePosition = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
          surfaceNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        #endif
        vec2 surfaceUv = abs(surfaceNormal.y) > 0.65 ? surfacePosition.xz : vec2(dot(surfacePosition, normalize(vec3(surfaceNormal.z, 0.0, -surfaceNormal.x))), surfacePosition.y);
        surfaceUv *= ${scale.toFixed(6)};
        #ifdef USE_MAP
          vMapUv = surfaceUv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = surfaceUv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = surfaceUv;
        #endif`)
    }
    material.customProgramCacheKey = () => `metre-surface-${scale}`
  }
  void owned.ready.then(() => {
    if (disposed) return
    material.map = owned.textures.albedo ?? null
    material.normalMap = owned.textures.normal ?? null
    material.roughnessMap = owned.textures.roughness ?? null
    material.needsUpdate = true
  })
  return material
}

export function releaseSurface(material: THREE.Material): void { material.dispose() }

export function surfaceDiagnostics(): { textureCount: number; estimatedGpuBytes: number; decodedBytes: number; pending: number; failures: string[] } {
  let textureCount = 0, decodedBytes = 0, pending = 0
  for (const bundle of bundles.values()) {
    textureCount += Object.keys(bundle.textures).length
    decodedBytes += bundle.bytes
    if (!bundle.textures.albedo) pending++
  }
  return { textureCount, estimatedGpuBytes: Math.ceil(decodedBytes * 4 / 3), decodedBytes, pending, failures: [...failures] }
}
