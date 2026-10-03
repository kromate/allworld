import * as THREE from 'three'

/** Multipliers around 1, clamped to a modest visual range before reaching GLSL. */
export interface BodyBuild { shoulders: number; torso: number }
/** Bind-pose heights in centimetres: the build is whole below `from` and gone at `to`, under the face. */
export interface BuildFade { from: number; to: number }

type Shader = Parameters<THREE.Material['onBeforeCompile']>[0]
type Compile = THREE.Material['onBeforeCompile']
type CacheKey = THREE.Material['customProgramCacheKey']

interface BuildHook {
  scale: THREE.Vector2
  fade: THREE.Vector2
  shaders: Set<Shader>
  baseCompile: Compile
  baseCacheKey: CacheKey
  compile: Compile
  cacheKey: CacheKey
}

const hooks = new WeakMap<THREE.MeshStandardMaterial, BuildHook>()
const KEY = 'surface-build-v2'
const GLSL = `
vec2 surfaceBuildScales(float buildHeight) {
  float buildNeck = 1.0 - smoothstep(bodyBuildFade.x, bodyBuildFade.y, buildHeight);
  float buildTorso = smoothstep(70.0, 90.0, buildHeight) * (1.0 - smoothstep(126.0, 151.0, buildHeight)) * buildNeck;
  float buildShoulders = smoothstep(122.0, 135.0, buildHeight) * buildNeck;
  float buildWidth = mix(1.0, bodyBuildScale.x, buildShoulders);
  buildWidth = mix(buildWidth, bodyBuildScale.y, buildTorso * (1.0 - buildShoulders));
  float buildDepth = mix(1.0, bodyBuildScale.y, smoothstep(70.0, 90.0, buildHeight) * buildNeck);
  return vec2(buildWidth, buildDepth);
}
`

/**
 * Where a character's build fades out. It starts at the collar bone and ends five centimetres
 * under the chin, the height below which the face fitting changes nothing. Heights are in the
 * frame of the rig's meshes, read from the character itself.
 */
export function bodyBuildFade(template: THREE.Object3D, meta: { eyes: { left: readonly number[]; right: readonly number[] }; faceLandmarks?: readonly number[] }): BuildFade {
  template.updateMatrixWorld(true)
  let frame: THREE.Matrix4 | null = null
  template.traverse(child => { if (!frame && child instanceof THREE.SkinnedMesh) frame = child.matrixWorld.clone().invert() })
  const height = (worldUp: number): number => new THREE.Vector3(0, worldUp, 0).applyMatrix4(frame ?? new THREE.Matrix4()).z
  const eyes = (meta.eyes.left[1]! + meta.eyes.right[1]!) / 2
  const chin = meta.faceLandmarks?.[152 * 3 + 1] ?? eyes - Math.abs(meta.eyes.left[0]! - meta.eyes.right[0]!) * 1.85
  const to = height(chin - 5)
  const collar = template.getObjectByName('Bip01_L_Clavicle')?.getWorldPosition(new THREE.Vector3()).y
  // The two heights are never allowed to meet: GLSL leaves smoothstep undefined for equal edges.
  return { from: Math.min(collar === undefined ? to - 6 : height(collar), to - 3), to }
}

/**
 * Apply a bounded build to Rocketbox centimetre geometry (x width, y depth,
 * z height). The rig's x rotation maps z to world up. Every material of one
 * character takes the same build and fade: head, body, hair and garments. The
 * scale depends only on a vertex's bind-pose height, so vertices two materials
 * share stay together, and it is exactly 1 from `fade.to` up, so the face is
 * left as fitted. Reapplying updates live uniforms without stacking shader
 * hooks. If another feature replaces onBeforeCompile, call this again to
 * compose with that hook; if another feature wraps it, nothing is added twice.
 */
export function applyBodyBuild(material: THREE.MeshStandardMaterial, appearance: BodyBuild, fade: BuildFade): void {
  const shoulders = Number.isFinite(appearance.shoulders) ? THREE.MathUtils.clamp(appearance.shoulders, 0.82, 1.18) : 1
  const torso = Number.isFinite(appearance.torso) ? THREE.MathUtils.clamp(appearance.torso, 0.82, 1.18) : 1
  let hook = hooks.get(material)
  if (hook) {
    hook.scale.set(shoulders, torso)
    hook.fade.set(fade.from, fade.to)
    for (const shader of hook.shaders) { shader.uniforms.bodyBuildScale = { value: hook.scale }; shader.uniforms.bodyBuildFade = { value: hook.fade } }
    if (material.onBeforeCompile === hook.compile && material.customProgramCacheKey === hook.cacheKey) return
    // Wrapped by another feature, such as headwear coverage: the build is still in the chain.
    if (material.customProgramCacheKey().includes(KEY)) return
    hook.shaders.clear()
  } else {
    hook = {
      scale: new THREE.Vector2(shoulders, torso), fade: new THREE.Vector2(fade.from, fade.to), shaders: new Set(),
      baseCompile: material.onBeforeCompile, baseCacheKey: material.customProgramCacheKey,
      compile: material.onBeforeCompile, cacheKey: material.customProgramCacheKey,
    }
    hooks.set(material, hook)
    material.addEventListener('dispose', () => { hook?.shaders.clear(); hooks.delete(material) })
  }

  const baseCompile = material.onBeforeCompile === hook.compile ? hook.baseCompile : material.onBeforeCompile
  const baseCacheKey = material.customProgramCacheKey === hook.cacheKey ? hook.baseCacheKey : material.customProgramCacheKey
  const current = hook
  const compile: Compile = function (this: THREE.MeshStandardMaterial, shader, renderer): void {
    baseCompile.call(this, shader, renderer)
    shader.uniforms.bodyBuildScale = { value: current.scale }
    shader.uniforms.bodyBuildFade = { value: current.fade }
    current.shaders.add(shader)
    if (shader.vertexShader.includes('vec2 surfaceBuildScales(')) return
    shader.vertexShader = `uniform vec2 bodyBuildScale;\nuniform vec2 bodyBuildFade;\n${GLSL}\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      vec2 buildNormalScale = surfaceBuildScales(position.z);
      objectNormal.x /= buildNormalScale.x;
      objectNormal.y /= buildNormalScale.y;
    `)
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>
      vec2 buildPositionScale = surfaceBuildScales(position.z);
      transformed.x *= buildPositionScale.x;
      transformed.y *= buildPositionScale.y;
    `)
  }
  const cacheKey: CacheKey = function (this: THREE.MeshStandardMaterial): string {
    return `${baseCacheKey.call(this)}|${KEY}`
  }
  current.compile = compile
  current.cacheKey = cacheKey
  current.baseCompile = baseCompile
  current.baseCacheKey = baseCacheKey
  material.onBeforeCompile = compile
  material.customProgramCacheKey = cacheKey
  material.needsUpdate = true
}
