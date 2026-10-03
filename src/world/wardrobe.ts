import * as THREE from 'three'
import { loadPack, parseModel } from './packs.ts'

export interface Outfit { id: string; name: string; description: string; fits: string[]; regions: string[]; thumbnail: string }
const fits = ['f01', 'f03', 'f06', 'f08', 'f11', 'f12', 'f17', 'm01', 'm04', 'm08', 'm10', 'm12', 'm15', 'm18']
export const OUTFITS: Outfit[] = [
  { id: 'wax-indigo', name: 'Indigo petal', description: 'Original Ankara-inspired indigo and gold rosettes on the existing upper garment, with slate separates.', regions: ['NG', 'KE', 'west-africa', 'east-africa'] },
  { id: 'wax-ochre', name: 'Ochre orbit', description: 'Original ochre and rust wax-print-inspired fabric, with charcoal separates.', regions: ['NG', 'TG', 'GH', 'west-africa'] },
  { id: 'wax-coral', name: 'Coral frond', description: 'Original coral petals on teal wax-print-inspired fabric, with deep teal separates.', regions: ['TG', 'GH', 'west-africa'] },
  { id: 'coastal-linen', name: 'Coastal linen', description: 'Warm natural linen texture with sage separates, on the selected character’s existing cut.', regions: ['ES', 'europe'] },
  { id: 'city-navy', name: 'City navy', description: 'Ink-blue woven fabric with soft charcoal separates.', regions: ['GB', 'europe'] },
  { id: 'olive-casual', name: 'Olive field', description: 'Olive twill texture with sand-coloured separates.', regions: ['KE', 'US', 'east-africa', 'north-america'] },
  { id: 'denim-weekend', name: 'Denim weekend', description: 'Blue woven denim texture with graphite separates.', regions: ['US', 'GB', 'north-america', 'global'] },
  { id: 'everyday-cream', name: 'Everyday cream', description: 'Soft cream woven fabric with slate-blue separates.', regions: ['global', 'ES'] },
  { id: 'wax-river', name: 'River wave', description: 'Original flowing indigo, sand and terracotta ribbons with fine resist marks.', regions: ['GH', 'TG', 'west-africa'] },
  { id: 'wax-sunrise', name: 'Sunrise lozenge', description: 'Original ochre lozenges and rust sun motifs with dark green separates.', regions: ['KE', 'east-africa'] },
  { id: 'indigo-dash', name: 'Indigo dash', description: 'Small original indigo and pale-blue woven marks with graphite separates.', regions: ['JP', 'east-asia'] },
  { id: 'marigold-cotton', name: 'Marigold cotton', description: 'Warm golden cotton with light natural separates.', regions: ['IN', 'south-asia'] },
].map(value => ({ ...value, fits: [...fits], thumbnail: `/wardrobe/${value.id}.jpg` })).concat([
  { id: 'kaftan-sand', name: 'Sand kaftan and fila', description: 'A shaped long kaftan with a folded soft cap, cream cloth and sage trousers.', fits: ['m08', 'm12'], regions: ['NG', 'west-africa'], thumbnail: '/wardrobe/kaftan-sand.jpg' },
  { id: 'kaftan-kufi', name: 'Sand kaftan and kufi', description: 'A cream long kaftan with a fitted round cap and an embroidered band.', fits: ['m08', 'm12'], regions: ['NG', 'west-africa'], thumbnail: '/wardrobe/kaftan-kufi.jpg' },
  { id: 'kitenge-sunrise', name: 'Sunrise kitenge shirt', description: 'A relaxed stand-collar or open-collar shirt in an original rust-and-ochre print.', fits: ['m01', 'm08', 'f03', 'f17'], regions: ['KE', 'east-africa'], thumbnail: '/wardrobe/kitenge-sunrise.jpg' },
])

export function outfit(id: string): Outfit | null { return OUTFITS.find(entry => entry.id === id) ?? null }

// The shared pack cache deduplicates downloads; decoded pictures live only for this paint.
async function picture(url: string, name: string): Promise<ImageBitmap> {
  const pack = await loadPack(url)
  const entry = pack.entries.get(name)
  if (!entry) throw new Error(`Wardrobe image ${name} is missing from ${url}`)
  const start = pack.base + entry.offset
  return createImageBitmap(new Blob([pack.bytes.slice(start, start + entry.length)]))
}

const BOTTOM: Record<string, string> = {
  'wax-indigo': '#303b49', 'wax-ochre': '#353430', 'wax-coral': '#243d3f', 'coastal-linen': '#747b6b',
  'city-navy': '#53545a', 'olive-casual': '#c0ad8a', 'denim-weekend': '#4a4948', 'everyday-cream': '#3d5367',
  'wax-river': '#293d4c', 'wax-sunrise': '#333e35', 'indigo-dash': '#363c46', 'marigold-cotton': '#ddd2b8',
}
const colourBytes = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

function pixels(image: ImageBitmap, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Wardrobe canvas is unavailable')
  context.imageSmoothingEnabled = false
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height).data
}

function garmentClass(red: number, green: number, blue: number): number {
  if (red === 47 && green === 177 && blue === 220) return 2
  if (red === 181 && green === 133 && blue === 237) return 3
  if (red === 248 && green === 202 && blue === 81) return 4
  return 0
}

/** Original unflipped body orientation. Keeps the caller's skin and trim byte-for-byte. */
export async function paintOutfit(context: CanvasRenderingContext2D, castId: string, outfitId: string): Promise<void> {
  const selected = outfit(outfitId)
  if (!selected?.fits.includes(castId)) return
  const spec = garmentSpec(castId, outfitId)
  if (spec?.bodyPaint === false) return
  const fabricId = spec?.fabric ?? selected.id
  const width = context.canvas.width, height = context.canvas.height
  const results = await Promise.allSettled([
    picture('/wardrobe/masks.pack.gz', `${castId}.png`),
    picture(`/wardrobe/basis-${castId}.pack.gz`, 'field.png'),
    picture(`/wardrobe/fabric-${fabricId}.pack.gz`, 'colour.png'),
    picture(`/wardrobe/basis-${castId}.pack.gz`, 'shade.jpg'),
  ])
  const images: ImageBitmap[] = []
  try {
    for (const result of results) if (result.status === 'fulfilled') images.push(result.value)
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [maskImage, fieldImage, tileImage, shadeImage] = images
    if (!maskImage || !fieldImage || !tileImage || !shadeImage) throw new Error('Wardrobe images are incomplete')
    const labels = pixels(maskImage, width, height), field = pixels(fieldImage, fieldImage.width, fieldImage.height)
    const fw = fieldImage.width, fh = fieldImage.height
    const tile = pixels(tileImage, tileImage.width, tileImage.height), tw = tileImage.width, th = tileImage.height
    const shading = pixels(shadeImage, width, height)
    const lower = colourBytes(BOTTOM[fabricId] ?? '#303b49'), shoe = colourBytes('#393732')
    const output = context.getImageData(0, 0, width, height)
    for (let i = 0; i < output.data.length; i += 4) {
      const part = garmentClass(labels[i]!, labels[i + 1]!, labels[i + 2]!)
      if (!part) continue
      const shade = shading[i]! / 255 * 1.3
      const px = (i / 4 % width + 0.5) / width * fw - 0.5, py = (Math.floor(i / 4 / width) + 0.5) / height * fh - 0.5
      const fx = Math.max(0, Math.floor(px)), fy = Math.max(0, Math.floor(py)), ux = Math.max(0, px - fx), uy = Math.max(0, py - fy)
      const offsets = [(fy * fw + fx) * 4, (fy * fw + Math.min(fw - 1, fx + 1)) * 4, (Math.min(fh - 1, fy + 1) * fw + fx) * 4, (Math.min(fh - 1, fy + 1) * fw + Math.min(fw - 1, fx + 1)) * 4]
      const repeat = (channel: number): number => {
        const a = field[offsets[0]! + channel]!
        // Interpolate over the repeat boundary without smearing the opposite end of the tile.
        const delta = (offset: number): number => ((field[offset + channel]! - a + 384) % 256) - 128
        const value = a + delta(offsets[1]!) * ux * (1 - uy) + delta(offsets[2]!) * (1 - ux) * uy + delta(offsets[3]!) * ux * uy
        return (value + 256) % 256 / 256
      }
      const x = repeat(0) * tw, y = repeat(1) * th
      const x0 = Math.floor(x) % tw, y0 = Math.floor(y) % th, dx = x - Math.floor(x), dy = y - Math.floor(y)
      for (let channel = 0; channel < 3; channel++) {
        let colour: number
        if (part === 2) {
          const a = tile[(y0 * tw + x0) * 4 + channel]!, b = tile[(y0 * tw + (x0 + 1) % tw) * 4 + channel]!
          const c = tile[(((y0 + 1) % th) * tw + x0) * 4 + channel]!, d = tile[(((y0 + 1) % th) * tw + (x0 + 1) % tw) * 4 + channel]!
          colour = (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy
        } else colour = (part === 3 ? lower : shoe)[channel]!
        output.data[i + channel] = Math.round(Math.min(255, colour * shade))
      }
    }
    context.putImageData(output, 0, 0)
  } finally { for (const image of images) image.close() }
}

interface GarmentSpec { style: string; fabric: string; bodyClasses: number[]; hair: boolean; donor?: string; layers?: string[]; trim?: string; headwear?: 'fila' | 'kufi'; bodyPaint?: boolean }
// Only styles that pass the motion review are listed here.
const GARMENTS: Record<string, GarmentSpec> = {
  'kaftan-sand': { style: 'kaftan-fila', fabric: 'coastal-linen', bodyClasses: [2], hair: true, headwear: 'fila' },
  'kaftan-kufi': { style: 'kaftan-fila', fabric: 'coastal-linen', bodyClasses: [2], hair: true, headwear: 'kufi' },
  'kitenge-sunrise': { style: 'kitenge-shirt', fabric: 'wax-sunrise', bodyClasses: [2, 5], hair: false },
}
const garmentSpec = (castId: string, outfitId: string): GarmentSpec | null => {
  if (!outfit(outfitId)?.fits.includes(castId)) return null
  return Object.hasOwn(GARMENTS, outfitId) ? GARMENTS[outfitId] ?? null : null
}

export function outfitOcclusion(castId: string, outfitId: string): { bodyClasses: number[]; hair: boolean } {
  const spec = garmentSpec(castId, outfitId)
  return { bodyClasses: [...spec?.bodyClasses ?? []], hair: spec?.hair ?? false }
}

/** Clone and filter only the original body mesh. Caller owns the clone and restores its source on change. */
export async function outfitBodyGeometry(geometry: THREE.BufferGeometry, castId: string, outfitId: string): Promise<THREE.BufferGeometry | null> {
  const spec = garmentSpec(castId, outfitId)
  if (!spec) return null
  const mask = await picture(`/wardrobe/occlusion-${spec.style}-${castId}.pack.gz`, 'covered.png')
  try {
    const labels = pixels(mask, mask.width, mask.height), uv = geometry.getAttribute('uv')
    const index = geometry.index, kept: number[] = []
    if (!uv || !index) throw new Error('Wardrobe occlusion requires indexed body UVs')
    for (let at = 0; at < index.count; at += 3) {
      const a = index.getX(at), b = index.getX(at + 1), c = index.getX(at + 2)
      const x = Math.max(0, Math.min(mask.width - 1, Math.floor((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3 * mask.width)))
      const y = Math.max(0, Math.min(mask.height - 1, Math.floor((1 - (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3) * mask.height)))
      const p = (y * mask.width + x) * 4
      if (labels[p]! < 128) kept.push(a, b, c)
    }
    const result = geometry.clone()
    result.setIndex(kept)
    result.clearGroups()
    return result
  } finally { mask.close() }
}

async function fabricTexture(fabric: string, channel: 'colour' | 'normal' | 'roughness', donor = false): Promise<THREE.CanvasTexture> {
  const image = await picture(`/wardrobe/${donor ? 'donor' : 'fabric'}-${fabric}.pack.gz`, donor ? channel === 'normal' ? 'normal.jpg' : 'ao.jpg' : `${channel}.png`)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Wardrobe fabric canvas is unavailable')
    context.drawImage(image, 0, 0)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = channel === 'colour' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.wrapS = texture.wrapT = donor ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
    if (donor) texture.channel = 1
    texture.anisotropy = 4
    return texture
  } finally { image.close() }
}

/** Returned scene uses source centimetres. Mount beside the actor rig and rebind bones by name. */
export async function outfitMeshes(castId: string, outfitId: string): Promise<THREE.Object3D[]> {
  const spec = garmentSpec(castId, outfitId)
  if (!spec) return []
  if (spec.bodyPaint === false && spec.headwear) return [await loadHeadwear(castId, spec.headwear)]
  const pack = await loadPack(`/wardrobe/meshes/${spec.style}-${castId}.pack.gz`)
  const source = await parseModel(pack, 'model.glb')
  const scene = source.scene
  for (const layer of spec.layers ?? []) {
    const extra = await parseModel(await loadPack(`/wardrobe/meshes/${layer}-${castId}.pack.gz`), 'model.glb')
    scene.add(extra.scene)
  }
  scene.updateMatrixWorld(true)
  const results = await Promise.allSettled((['colour', 'normal', 'roughness'] as const).map(channel => fabricTexture(spec.fabric, channel)))
  const textures: THREE.CanvasTexture[] = []
  for (const result of results) if (result.status === 'fulfilled') textures.push(result.value)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') { for (const texture of textures) texture.dispose(); throw failure.reason }
  const [colour, normal, roughness] = textures
  const donorFor = (material: THREE.Material): string | null => {
    const donor: unknown = material.userData.donorId
    return typeof donor === 'string' && ['f01', 'f06', 'm15'].includes(donor) ? donor : spec.donor ?? null
  }
  const donorIds = new Set<string>()
  scene.traverse(child => {
    if (!(child instanceof THREE.SkinnedMesh)) return
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) { const donor = donorFor(material); if (donor) donorIds.add(donor) }
  })
  const donorMaps = new Map<string, { normal: THREE.CanvasTexture; ao: THREE.CanvasTexture }>()
  try {
    for (const donor of donorIds) {
      const details = await Promise.allSettled([fabricTexture(donor, 'normal', true), fabricTexture(donor, 'roughness', true)])
      for (const detail of details) if (detail.status === 'fulfilled') textures.push(detail.value)
      for (const detail of details) if (detail.status === 'rejected') throw detail.reason
      if (details[0].status === 'fulfilled' && details[1].status === 'fulfilled') donorMaps.set(donor, { normal: details[0].value, ao: details[1].value })
    }
  } catch (error) { for (const texture of textures) texture.dispose(); throw error }
  const materials = new Map<string, THREE.MeshStandardMaterial>()
  scene.traverse(child => {
    if (!(child instanceof THREE.SkinnedMesh)) return
    const replace = (original: THREE.Material): THREE.MeshStandardMaterial => {
      const donor = donorMaps.get(donorFor(original) ?? '')
      const donorNormal = donor?.normal ?? null, donorAO = donor?.ao ?? null
      const corrective: unknown = original.userData.wardrobeCorrective
      const key = `${original.name}|${donorFor(original) ?? ''}|${corrective === 'skirt' ? child.uuid : ''}`
      const cached = materials.get(key)
      if (cached) return cached
      const cloth = original.name === 'cloth' || original.name === 'hat'
      const material = new THREE.MeshStandardMaterial({ name: original.name, color: cloth ? '#ffffff' : original.name === 'lining' ? '#ece4d2' : spec.trim ?? (spec.style === 'kaftan-fila' ? '#927a4b' : '#173e50'), map: cloth ? colour : null, normalMap: original.name === 'cloth' && donorNormal ? donorNormal : cloth ? normal : null, aoMap: original.name === 'cloth' ? donorAO : null, aoMapIntensity: 1.4, roughnessMap: cloth ? roughness : null, roughness: 1, metalness: 0, side: THREE.DoubleSide })
      material.normalScale.set(original.name === 'cloth' && donorNormal ? .65 : .3, original.name === 'cloth' && donorNormal ? .65 : .3)
      if (corrective === 'skirt') skirtClearance(child, material)
      materials.set(key, material)
      return material
    }
    child.material = Array.isArray(child.material) ? child.material.map(replace) : replace(child.material)
    child.frustumCulled = false
    child.castShadow = true
  })
  if (spec.headwear) {
    const oldHats: THREE.Object3D[] = []
    scene.traverse(node => { if (node instanceof THREE.Mesh && !Array.isArray(node.material) && ['hat','lining'].includes(node.material.name)) oldHats.push(node) })
    for (const hat of oldHats) { hat.removeFromParent(); if (hat instanceof THREE.Mesh) {hat.geometry.dispose();if(!Array.isArray(hat.material))hat.material.dispose()} }
    scene.add(await loadHeadwear(castId,spec.headwear))
    scene.addEventListener('added',()=>fitHeadwear([scene]))
  }
  scene.userData.outfitId = outfitId
  scene.userData.hideBodyClasses = [...spec.bodyClasses]
  scene.userData.hideHair = spec.hair
  return [scene]
}

/** Small pose-space collision correction; only dense authored skirt surfaces opt in. */
function skirtClearance(mesh: THREE.SkinnedMesh, material: THREE.MeshStandardMaterial): void {
  const names = ['Bip01_L_Thigh', 'Bip01_L_Calf', 'Bip01_L_Foot', 'Bip01_R_Thigh', 'Bip01_R_Calf', 'Bip01_R_Foot']
  const indices = names.map(name => mesh.skeleton.bones.findIndex(bone => bone.name === name))
  if (indices.some(index => index < 0)) throw new Error('Skirt correction needs thigh, calf and foot bones')
  const points = names.map(() => new THREE.Vector3())
  const inverse = new THREE.Matrix4()
  const starts = [points[0]!, points[1]!, points[3]!, points[4]!]
  const ends = [points[1]!, points[2]!, points[4]!, points[5]!]
  const radii = [new THREE.Vector2(12, 9), new THREE.Vector2(9, 7.5), new THREE.Vector2(12, 9), new THREE.Vector2(9, 7.5)]
  const restMatrix = mesh.matrixWorld.clone()
  const localFrame = restMatrix.clone().invert()
  const up = new THREE.Vector3(0, 1, 0).transformDirection(localFrame)
  const right = new THREE.Vector3(1, 0, 0).transformDirection(localFrame)
  const layer = mesh.geometry.getAttribute('_cloth_layer') ?? new THREE.Float32BufferAttribute(new Float32Array(mesh.geometry.getAttribute('position').count), 1)
  mesh.geometry.setAttribute('wardrobeClothLayer', layer)
  material.flatShading = true
  const compile: THREE.Material['onBeforeCompile'] = shader => {
    shader.uniforms.wardrobeCapsuleA = { value: starts }
    shader.uniforms.wardrobeCapsuleB = { value: ends }
    shader.uniforms.wardrobeCapsuleR = { value: radii }
    shader.uniforms.wardrobeUp = { value: up }
    shader.uniforms.wardrobeRight = { value: right }
    shader.uniforms.wardrobeRestMatrix = { value: restMatrix }
    shader.vertexShader = `attribute float wardrobeClothLayer;\nuniform vec3 wardrobeCapsuleA[4];\nuniform vec3 wardrobeCapsuleB[4];\nuniform vec2 wardrobeCapsuleR[4];\nuniform vec3 wardrobeUp;\nuniform vec3 wardrobeRight;\nuniform mat4 wardrobeRestMatrix;\n` + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>
      vec3 restCloth = (wardrobeRestMatrix * vec4(position, 1.0)).xyz;
      float skirtT = clamp((102.0 - restCloth.y) / 93.0, 0.0, 1.0);
      vec3 waist = (wardrobeCapsuleA[0] + wardrobeCapsuleA[2]) * 0.5 + wardrobeUp * 12.0;
      vec3 knee = (wardrobeCapsuleB[0] + wardrobeCapsuleB[2]) * 0.5;
      vec3 ankle = (wardrobeCapsuleB[1] + wardrobeCapsuleB[3]) * 0.5 + wardrobeUp * 2.0;
      vec3 p0 = skirtT < 0.53 ? waist : knee;
      vec3 p1 = skirtT < 0.53 ? knee : ankle;
      vec3 m0 = skirtT < 0.53 ? knee - waist : (ankle - waist) * 0.5;
      vec3 m1 = skirtT < 0.53 ? (ankle - waist) * 0.5 : ankle - knee;
      float u = skirtT < 0.53 ? skirtT / 0.53 : (skirtT - 0.53) / 0.47;
      float u2 = u*u, u3 = u2*u;
      vec3 centre = (2.0*u3-3.0*u2+1.0)*p0 + (u3-2.0*u2+u)*m0 + (-2.0*u3+3.0*u2)*p1 + (u3-u2)*m1;
      vec3 tangent = normalize((6.0*u2-6.0*u)*p0 + (3.0*u2-4.0*u+1.0)*m0 + (-6.0*u2+6.0*u)*p1 + (3.0*u2-2.0*u)*m1);
      vec3 side = normalize(wardrobeRight - tangent*dot(wardrobeRight,tangent));
      vec3 forward = normalize(cross(tangent,side));
      float angle = atan(restCloth.x, restCloth.z);
      vec3 ray = sin(angle)*side + cos(angle)*forward;
      float radius = max(0.0, length(restCloth.xz) - wardrobeClothLayer);
      for (int part = 0; part < 4; part++) {
        vec3 a = wardrobeCapsuleA[part], b = wardrobeCapsuleB[part];
        float r = max(wardrobeCapsuleR[part].x, wardrobeCapsuleR[part].y) + 1.7;
        float da = dot(a-centre,tangent), db = dot(b-centre,tangent), change = db-da;
        float lo = 0.0, hi = 1.0;
        bool intersects = true;
        if (abs(change) < 0.001) intersects = abs(da) <= r;
        else { float t0=(-r-da)/change, t1=(r-da)/change; lo=max(0.0,min(t0,t1)); hi=min(1.0,max(t0,t1)); intersects=lo<=hi; }
        if (intersects) {
          vec3 q0=mix(a,b,lo), q1=mix(a,b,hi);
          radius=max(radius,max(dot(q0-centre,ray),dot(q1-centre,ray))+r);
        }
      }
      vec3 envelope = centre + ray*(radius + wardrobeClothLayer);
      transformed = mix(transformed, envelope, smoothstep(0.0,0.13,skirtT));
    `)
  }
  material.onBeforeCompile = compile
  material.customProgramCacheKey = () => 'wardrobe-skirt-envelope-v4'
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide })
  depth.onBeforeCompile = compile
  depth.customProgramCacheKey = material.customProgramCacheKey
  mesh.customDepthMaterial = depth
  material.addEventListener('dispose', () => depth.dispose())
  const refresh = (): void => {
    inverse.copy(mesh.matrixWorld).invert()
    for (let i = 0; i < indices.length; i++) points[i]!.setFromMatrixPosition(mesh.skeleton.bones[indices[i]!]!.matrixWorld).applyMatrix4(inverse)
  }
  const before = mesh.onBeforeRender, beforeShadow = mesh.onBeforeShadow
  mesh.onBeforeRender = function (...args): void { before.apply(this, args); refresh() }
  mesh.onBeforeShadow = function (...args): void { beforeShadow.apply(this, args); refresh() }
}

interface HeadwearState {
  scene: THREE.Object3D
  mesh: THREE.SkinnedMesh
  sourceFrame: THREE.Matrix4
  headFrame: THREE.Matrix4
  base: number
  top: number
  crown: number
  eye: number
  front: number
  brow: number
  origin: THREE.Vector3
  scale: { value: THREE.Vector3 }
  heights: { value: THREE.Vector4 }
  rim: { value: Float32Array }
  enabled: { value: number }
  lastGeometry: THREE.BufferGeometry | null
  binding: { bone: THREE.Bone; meshes: THREE.SkinnedMesh[] } | null
  headIndex: number
  cleanups: (() => void)[]
}
const headwearStates = new WeakMap<THREE.Object3D, HeadwearState>()
let headwearAtlas: Promise<THREE.CanvasTexture[]> | null = null

async function headwearTextures(): Promise<THREE.CanvasTexture[]> {
  headwearAtlas ??= Promise.all((['colour', 'normal', 'roughness'] as const).map(async channel => {
    const bitmap = await picture('/wardrobe/headwear-cloth.pack.gz', `${channel}.png`)
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close()
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = channel === 'colour' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    texture.anisotropy = 4
    return texture
  })).catch(error => { headwearAtlas = null; throw error })
  // Clones share THREE.Source GPU storage, but callers can dispose their own texture handles.
  return (await headwearAtlas).map(texture => texture.clone())
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  return typeof record[key] === 'number' ? record[key] : fallback
}
function numericArray(value: unknown, length: number): number[] | null {
  return Array.isArray(value) && value.length === length && value.every(v => typeof v === 'number' && Number.isFinite(v)) ? value : null
}
function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Call after head fitting or wardrobe attachment; the render fallback also notices geometry swaps. */
export function fitHeadwear(scenes: readonly THREE.Object3D[]): void {
  for (const root of scenes) root.traverse(object => {
    const state = headwearStates.get(object)
    if (state) refreshHeadwear(state)
  })
}

function headwearRig(state: HeadwearState): { bone: THREE.Bone; meshes: THREE.SkinnedMesh[] } | null {
  const bone = state.mesh.skeleton.bones[state.headIndex]
  if (!bone) return null
  if (state.binding?.bone === bone) return state.binding
  let ancestor: THREE.Object3D | null = bone.parent
  while (ancestor) {
    const meshes: THREE.SkinnedMesh[] = []
    ancestor.traverse(node => {
      if (node instanceof THREE.SkinnedMesh && !Array.isArray(node.material) && ['head', 'body'].includes(node.material.name)) meshes.push(node)
    })
    if (meshes.some(mesh => !Array.isArray(mesh.material) && mesh.material.name === 'head')) { state.binding = { bone, meshes }; return state.binding }
    ancestor = ancestor.parent
  }
  return null
}

function refreshHeadwear(state: HeadwearState): void {
  const rig = headwearRig(state)
  if (!rig) return
  const head = rig.meshes.find(mesh => !Array.isArray(mesh.material) && mesh.material.name === 'head')!
  if (state.lastGeometry === head.geometry) return
  rig.bone.updateWorldMatrix(true, false)
  head.updateWorldMatrix(true, false)
  state.lastGeometry = head.geometry
  let widthScale = 1, crownShift = 0
  if (head.geometry.hasAttribute('faceUv')) {
    const toSource = state.headFrame.clone().multiply(rig.bone.matrixWorld.clone().invert()).multiply(head.matrixWorld)
    const position = head.geometry.getAttribute('position'), index = head.geometry.index
    const used = index ? new Set(Array.from(index.array)) : new Set(Array.from({ length: position.count }, (_, i) => i))
    const xs: number[] = []; let crown = -Infinity
    const point = new THREE.Vector3()
    for (const at of used) {
      point.fromBufferAttribute(position, at); head.applyBoneTransform(at, point); point.applyMatrix4(toSource)
      crown = Math.max(crown, point.y)
      if (Math.abs(point.y - state.eye) < 2 && point.z >= state.front - 3) xs.push(point.x)
    }
    xs.sort((a, b) => a - b)
    if (xs.length > 8) {
      const width = xs[Math.floor(xs.length * .95)]! - xs[Math.floor(xs.length * .05)]!
      widthScale = THREE.MathUtils.clamp(width / state.brow, .88, 1.34)
    }
    if (Number.isFinite(crown)) crownShift = THREE.MathUtils.clamp(crown - state.crown, -1.7, 3.5)
  }
  state.scale.value.set(widthScale, 1, 1 + (widthScale - 1) * .3)
  state.heights.value.set(state.base, state.top, state.base + crownShift * .35, state.top + crownShift)
  const positions = state.mesh.geometry.getAttribute('position'), uv = state.mesh.geometry.getAttribute('uv'), point = new THREE.Vector3()
  state.rim.value.fill(state.heights.value.z)
  for (let i = 0; i < positions.count; i++) if (uv.getY(i) < .001) {
    point.fromBufferAttribute(positions, i).applyMatrix4(state.sourceFrame)
    const at = Math.round(uv.getX(i) * 32) % 32
    state.rim.value[at] = state.heights.value.z + (point.y - state.base) / (state.top - state.base) * (state.heights.value.w - state.heights.value.z)
  }
  if (!state.cleanups.length) for (const mesh of rig.meshes) headwearCoverage(state, mesh, rig.bone)
  state.scene.userData.fitDiagnostics = { widthScale, crownShift, headGeometry: head.geometry.uuid }
}

function headwearCoverage(state: HeadwearState, mesh: THREE.SkinnedMesh, bone: THREE.Bone): void {
  if (Array.isArray(mesh.material)) return
  const material = mesh.material
  const matrix = { value: new THREE.Matrix4() }, inverseBone = new THREE.Matrix4()
  const previousRender = mesh.onBeforeRender
  const install = (): void => {
    const previousCompile = material.onBeforeCompile, previousKey = material.customProgramCacheKey.bind(material)
    const compile: THREE.Material['onBeforeCompile'] = (shader, renderer) => {
      previousCompile(shader, renderer)
      shader.uniforms.wardrobeCoverMatrix = matrix
      shader.uniforms.wardrobeCoverRest = { value: state.sourceFrame }
      shader.uniforms.wardrobeCoverRim = state.rim
      shader.uniforms.wardrobeCoverOrigin = { value: state.origin }
      shader.uniforms.wardrobeCoverEye = { value: state.eye }
      shader.uniforms.wardrobeCoverOn = state.enabled
      if (shader.vertexShader.includes('varying vec3 wardrobeCoverPoint')) return
      shader.vertexShader = 'uniform mat4 wardrobeCoverMatrix; uniform mat4 wardrobeCoverRest; uniform float wardrobeCoverEye; varying vec3 wardrobeCoverPoint; varying float wardrobeCoverRegion;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>
        wardrobeCoverPoint = (wardrobeCoverMatrix * vec4(transformed,1.0)).xyz;
        vec3 coverRest = (wardrobeCoverRest * vec4(position,1.0)).xyz;
        wardrobeCoverRegion = coverRest.y > wardrobeCoverEye - 8.0 && abs(coverRest.x) < 22.0 ? 1.0 : 0.0;`)
      shader.fragmentShader = 'uniform float wardrobeCoverRim[32]; uniform vec3 wardrobeCoverOrigin; uniform float wardrobeCoverOn; varying vec3 wardrobeCoverPoint; varying float wardrobeCoverRegion;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float capAngle = mod(atan(wardrobeCoverPoint.x-wardrobeCoverOrigin.x,wardrobeCoverPoint.z-wardrobeCoverOrigin.z)+6.283185307,6.283185307)/6.283185307*32.0;
        int capA=int(floor(capAngle)); int capB=(capA+1)%32;
        float capRim=mix(wardrobeCoverRim[capA],wardrobeCoverRim[capB],fract(capAngle));
        if(wardrobeCoverOn>.5 && wardrobeCoverRegion>.5 && wardrobeCoverPoint.y>capRim-.08) discard;`)
    }
    material.onBeforeCompile = compile
    material.customProgramCacheKey = () => previousKey() + '|wardrobe-cover-r4'
    material.needsUpdate = true
    state.cleanups.push(() => {
      if (material.onBeforeCompile === compile) { material.onBeforeCompile = previousCompile; material.customProgramCacheKey = previousKey; material.needsUpdate = true }
    })
  }
  install()
  const own = material.onBeforeCompile
  mesh.onBeforeRender = function (...args): void {
    previousRender.apply(this, args)
    matrix.value.copy(state.headFrame).multiply(inverseBone.copy(bone.matrixWorld).invert()).multiply(mesh.matrixWorld)
    if (state.lastGeometry !== mesh.geometry && material.name === 'head') refreshHeadwear(state)
    if (material.onBeforeCompile !== own && !material.customProgramCacheKey().includes('wardrobe-cover-r4')) install()
  }
  const wrappedRender = mesh.onBeforeRender
  state.cleanups.push(() => { if (mesh.onBeforeRender === wrappedRender) mesh.onBeforeRender = previousRender })
}

async function loadHeadwear(castId: string, style: 'fila' | 'kufi'): Promise<THREE.Object3D> {
  const source = await parseModel(await loadPack(`/wardrobe/headwear-${style}-${castId}.pack.gz`), 'model.glb')
  const scene = source.scene; scene.updateMatrixWorld(true)
  const fit = recordValue(scene.userData.headwearFit)
  const anchor = recordValue(fit.anchorFrame)
  const origin = new THREE.Vector3().fromArray(numericArray(anchor.originCm, 3) ?? [0, 0, 0])
  const eyes = recordValue(fit.eyesCm), eyeLeft = numericArray(eyes.left, 3) ?? [0, origin.y + 10, origin.z + 8]
  const bounds = recordValue(fit.headBoundsCm), maximum = numericArray(bounds.max, 3) ?? [9, origin.y + 22, 14]
  const [colour, normal, roughness] = await headwearTextures()
  scene.traverse(node => {
    if (!(node instanceof THREE.SkinnedMesh)) return
    const material = new THREE.MeshStandardMaterial({name:'headwear',map:colour,normalMap:normal,roughnessMap:roughness,roughness:1,metalness:0,side:THREE.DoubleSide})
    material.normalScale.set(.28,.28); node.material=material; node.frustumCulled=false
    const head = node.skeleton.bones.find(bone => bone.name === 'Bip01_Head')!
    const state: HeadwearState = {scene,mesh:node,sourceFrame:node.matrixWorld.clone(),headFrame:head.matrixWorld.clone(),base:numberField(fit,'capBaseYcm',origin.y+14),top:numberField(fit,'capTopYcm',maximum[1]!+1),crown:numberField(fit,'rawCrownYcm',maximum[1]!),eye:eyeLeft[1]!,front:eyeLeft[2]!,brow:numberField(fit,'frontBrowWidthCm',14),origin,scale:{value:new THREE.Vector3(1,1,1)},heights:{value:new THREE.Vector4()},rim:{value:new Float32Array(32)},enabled:{value:1},lastGeometry:null,binding:null,headIndex:node.skeleton.bones.indexOf(head),cleanups:[]}
    state.heights.value.set(state.base,state.top,state.base,state.top)
    const inverse = state.sourceFrame.clone().invert()
    material.onBeforeCompile = shader => {
      shader.uniforms.capFitFrame={value:state.sourceFrame};shader.uniforms.capFitInverse={value:inverse};shader.uniforms.capFitOrigin={value:origin};shader.uniforms.capFitScale=state.scale;shader.uniforms.capFitHeights=state.heights
      shader.vertexShader='uniform mat4 capFitFrame;uniform mat4 capFitInverse;uniform vec3 capFitOrigin;uniform vec3 capFitScale;uniform vec4 capFitHeights;\n'+shader.vertexShader
      shader.vertexShader=shader.vertexShader.replace('#include <skinning_vertex>',`vec3 capP=(capFitFrame*vec4(transformed,1.0)).xyz;capP.xz=capFitOrigin.xz+(capP.xz-capFitOrigin.xz)*capFitScale.xz;capP.y=capFitHeights.z+(capP.y-capFitHeights.x)/(capFitHeights.y-capFitHeights.x)*(capFitHeights.w-capFitHeights.z);transformed=(capFitInverse*vec4(capP,1.0)).xyz;\n#include <skinning_vertex>`)
    }
    material.customProgramCacheKey=()=> 'headwear-fit-r4'
    const before=node.onBeforeRender
    node.onBeforeRender=function(...args):void{before.apply(this,args);refreshHeadwear(state)}
    headwearStates.set(scene,state)
    scene.addEventListener('added',()=>refreshHeadwear(state))
    const release=():void=>{state.enabled.value=0;for(const cleanup of state.cleanups.reverse())cleanup();state.cleanups=[]}
    scene.addEventListener('removed',release)
    material.addEventListener('dispose',release)
  })
  return scene
}
