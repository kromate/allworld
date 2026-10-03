import * as THREE from 'three'

/** Conservative uncompressed residency estimate; excludes geometry, driver overhead and the canvas. */
export function textureMemory(scene: THREE.Scene): { textureCount: number; textureBytes: number } {
  const textures = new Set<THREE.Texture>()
  const keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap', 'bumpMap', 'envMap']
  if (scene.environment) textures.add(scene.environment)
  if (scene.background instanceof THREE.Texture) textures.add(scene.background)
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite)) return
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const key of keys) {
        const value: unknown = Reflect.get(material, key)
        if (value instanceof THREE.Texture) textures.add(value)
      }
    }
  })
  let textureBytes = 0
  for (const texture of textures) {
    const image: unknown = texture.image
    const images: unknown[] = Array.isArray(image) ? image : [image]
    for (const source of images) {
      if (!source || typeof source !== 'object' || !('width' in source) || !('height' in source)) continue
      if (typeof source.width !== 'number' || typeof source.height !== 'number') continue
      const channelBytes = texture.type === THREE.FloatType ? 4 : texture.type === THREE.HalfFloatType ? 2 : 1
      textureBytes += source.width * source.height * 4 * channelBytes * (texture.generateMipmaps ? 4 / 3 : 1)
    }
  }
  return { textureCount: textures.size, textureBytes: Math.ceil(textureBytes) }
}
