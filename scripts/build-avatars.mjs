// Builds the realistic avatar cast and its animations from the Microsoft Rocketbox library
// (MIT licence, https://github.com/microsoft/Microsoft-Rocketbox).
//
//   node scripts/build-avatars.mjs            build anything missing
//   node scripts/build-avatars.mjs --force    rebuild everything
//
// For each cast member: fetch the rigged FBX and its colour textures, convert the mesh to GLB,
// shrink the textures, cut a portrait, and write one pack to public/avatars/. Animations are
// resampled into a compact shared clip set per skeleton (female, male).
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'avatars')
const CACHE = join(tmpdir(), 'rocketbox-cache')
const REPO = 'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master'
const LICENSE_URL = 'https://github.com/microsoft/Microsoft-Rocketbox/blob/master/LICENSE.md'
const FACE_OVAL = JSON.parse(await readFile(join(ROOT, 'src', 'assets', 'face-topology.json'), 'utf8')).oval
const FORCE = process.argv.includes('--force')

/** The cast: a varied set of adults in everyday clothes. `id` is what the App stores. */
export const CAST = [
  { id: 'f01', source: 'Female_Adult_01' }, { id: 'f03', source: 'Female_Adult_03' }, { id: 'f06', source: 'Female_Adult_06' },
  { id: 'f08', source: 'Female_Adult_08' }, { id: 'f11', source: 'Female_Adult_11' }, { id: 'f12', source: 'Female_Adult_12' },
  { id: 'f17', source: 'Female_Adult_17' },
  { id: 'm01', source: 'Male_Adult_01' }, { id: 'm04', source: 'Male_Adult_04' }, { id: 'm08', source: 'Male_Adult_08' },
  { id: 'm10', source: 'Male_Adult_10' }, { id: 'm12', source: 'Male_Adult_12' }, { id: 'm15', source: 'Male_Adult_15' },
  { id: 'm18', source: 'Male_Adult_18' },
]

/** Clip name in the App → preferred source animations, first match wins. `dir` picks the motion-extraction set. */
const CLIPS = [
  { name: 'idle', dir: 'static', pick: ['idle_neutral_01', 'idle_breathe_01'], maxSeconds: 12 },
  { name: 'walk', dir: 'xy', pick: ['walk_neutral', 'walk_neutral_01'] },
  { name: 'run', dir: 'xy', pick: ['run_neutral', 'run_neutral_01', 'run_slow_01'] },
  { name: 'sit', dir: 'static', pick: ['sit_chair_idle_neutral_01'], maxSeconds: 10 },
  { name: 'wave', dir: 'static', pick: ['wave_01'] },
  { name: 'talk', dir: 'static', pick: ['gestic_talk_neutral_01'], maxSeconds: 8 },
  { name: 'nod', dir: 'static', pick: ['gestic_listen_accept_01'] },
  { name: 'clap', dir: 'static', pick: ['claphands_01'], maxSeconds: 6 },
  { name: 'cheer', dir: 'static', pick: ['cheer_01'], maxSeconds: 6 },
  { name: 'dance', dir: 'static', pick: ['dancing_neutral'], maxSeconds: 10 },
  { name: 'work', dir: 'static', pick: ['work_mid'], maxSeconds: 8 },
]
const CLIP_FPS = 15
/** Face bones stay in their bind pose; leaving them out keeps clips small. */
const FACE_BONE = /Eye|Jaw|Lip|Mouth|Tongue|Cheek|Nose|Masseter|Caninus|Eyebrow/

// FBXLoader asks a TextureLoader for images even when only geometry is wanted. Give it an inert
// DOM, and GLTFExporter the one browser API it needs to return binary.
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(_) {}, style: {} }) }
globalThis.window = globalThis
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(buffer => { this.result = buffer; this.onloadend?.() }) }
  readAsDataURL(blob) { blob.arrayBuffer().then(buffer => { this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`; this.onloadend?.() }) }
}
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
const { SimplifyModifier } = await import('three/examples/jsm/modifiers/SimplifyModifier.js')
const { mergeGeometries, mergeVertices } = await import('three/examples/jsm/utils/BufferGeometryUtils.js')

const exists = path => stat(path).then(() => true, () => false)

async function fetchCached(repoPath) {
  const target = join(CACHE, repoPath.replaceAll('/', '__'))
  if (await exists(target)) return target
  await mkdir(CACHE, { recursive: true })
  const response = await fetch(`${REPO}/${repoPath.split('/').map(encodeURIComponent).join('/')}`)
  if (!response.ok) throw new Error(`${response.status} fetching ${repoPath}`)
  await writeFile(target, Buffer.from(await response.arrayBuffer()))
  return target
}

let treeCache = null
async function repoTree() {
  treeCache ??= (await (await fetch('https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/master?recursive=1')).json()).tree.map(entry => entry.path)
  return treeCache
}

async function loadFbx(file) {
  const bytes = await readFile(file)
  return new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')
}

function writePack(entries) {
  const index = []
  let offset = 0
  for (const entry of entries) { index.push({ name: entry.name, offset, length: entry.data.length, ...(entry.meta ? { meta: entry.meta } : {}) }); offset += entry.data.length }
  const indexBytes = Buffer.from(JSON.stringify({ version: 1, entries: index }), 'utf8')
  const header = Buffer.alloc(8)
  header.write('NWPK', 0, 'ascii')
  header.writeUInt32LE(indexBytes.length, 4)
  return gzipSync(Buffer.concat([header, indexBytes, ...entries.map(entry => entry.data)]), { level: 9 })
}

const ffmpeg = args => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** Typical skin colour of a head texture: the median of its skin-like pixels (red > green > blue). */
async function skinColour(file) {
  const raw = join(CACHE, `patch-${process.pid}.rgb`)
  await ffmpeg(['-i', file, '-vf', 'scale=64:64', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  const data = await readFile(raw)
  const pixels = []
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    if (r > 45 && r > g + 8 && g > b + 4 && r - b < 150) pixels.push([r, g, b])
  }
  const median = channel => pixels.map(pixel => pixel[channel]).sort((x, y) => x - y)[pixels.length >> 1] ?? 128
  return '#' + [0, 1, 2].map(channel => median(channel).toString(16).padStart(2, '0')).join('')
}

const rounded = value => +value.toFixed(3)
const point = vector => vector.toArray().map(rounded)

async function headAtlas(headImage, work) {
  const size = 512
  const rgbFile = join(work, 'head-512.rgb')
  await ffmpeg(['-i', headImage, '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rgbFile])
  const rgb = await readFile(rgbFile)
  const sample = []
  for (const [cx, cy] of [[210, 190], [302, 190]]) {
    for (let y = cy - 5; y <= cy + 5; y++) for (let x = cx - 5; x <= cx + 5; x++) {
      const offset = (y * size + x) * 3
      sample.push([rgb[offset], rgb[offset + 1], rgb[offset + 2]])
    }
  }
  const median = channel => sample.map(v => v[channel]).sort((a, b) => a - b)[sample.length >> 1]
  const base = [median(0), median(1), median(2)]
  const baseSum = base.reduce((sum, value) => sum + value, 0)
  return { size, rgb, base, baseSum }
}

function atlasSkin(atlas, x, y) {
  if (x < 0 || x >= atlas.size || y < 0 || y >= atlas.size) return false
  const at = (Math.floor(y) * atlas.size + Math.floor(x)) * 3
  const r = atlas.rgb[at], g = atlas.rgb[at + 1], blue = atlas.rgb[at + 2], sum = r + g + blue
  if (sum < atlas.baseSum * 0.48 || r < g + 5 || g < blue) return false
  return Math.hypot(r / sum - atlas.base[0] / atlas.baseSum, g / sum - atlas.base[1] / atlas.baseSum) < 0.095
}

/** Find face landmarks on the actual head surface; the bones only locate search regions. */
function faceFit(scene, skinned, atlas) {
  const geometry = skinned.geometry
  const position = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const headSlot = skinned.material.findIndex(material => material.name === 'head')
  const vertices = []
  const skinVertices = []
  for (const group of geometry.groups.filter(entry => entry.materialIndex === headSlot)) {
    for (let i = group.start; i < group.start + group.count; i++) {
      const vertex = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(skinned.matrixWorld)
      vertices.push(vertex)
      if (atlasSkin(atlas, uv.getX(i) * atlas.size, (1 - uv.getY(i)) * atlas.size)) skinVertices.push(vertex)
    }
  }
  const bone = name => scene.getObjectByName(`Bip01_${name}`).getWorldPosition(new THREE.Vector3())
  const leftSeed = bone('LEye'), rightSeed = bone('REye'), noseSeed = bone('MNose')
  const mouthSeed = bone('LMouthCorner').add(bone('RMouthCorner')).multiplyScalar(0.5)
  const browSeed = bone('MMiddleEyebrow')
  const surface = (seed, radius = 2) => {
    const nearby = vertices.filter(v => Math.abs(v.x - seed.x) < radius && Math.abs(v.y - seed.y) < radius && v.z > seed.z - 1)
    if (!nearby.length) throw new Error(`No head surface near ${seed.toArray()}`)
    return nearby.reduce((best, v) => v.distanceToSquared(seed) < best.distanceToSquared(seed) ? v : best)
  }
  const eyes = [surface(leftSeed), surface(rightSeed)]
  const eye = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5)
  const nose = vertices.filter(v => Math.abs(v.x - noseSeed.x) < 1.5 && Math.abs(v.y - noseSeed.y) < 3)
    .reduce((best, v) => v.z > best.z ? v : best)
  const mouth = surface(mouthSeed)
  const chinCandidates = skinVertices.filter(v => Math.abs(v.x) < 2 && v.y < mouth.y - 2 && v.y > mouth.y - 9.5 && v.z > eye.z - 3)
  if (!chinCandidates.length) throw new Error('No chin surface')
  const chin = chinCandidates.reduce((best, v) => v.y < best.y ? v : best)
  const brow = surface(browSeed)
  const widthAt = (y, front) => {
    const band = skinVertices.filter(v => Math.abs(v.y - y) < 1.2 && v.z > front)
    if (!band.length) throw new Error(`No head width at ${y}`)
    return Math.max(...band.map(v => v.x)) - Math.min(...band.map(v => v.x))
  }
  const cheekWidth = widthAt((eye.y + mouth.y) / 2, eye.z - 2)
  const jawWidth = widthAt((mouth.y + chin.y) / 2, eye.z - 4)
  const mouthCorners = [surface(bone('LMouthCorner')), surface(bone('RMouthCorner'))]
  return {
    eyes: point(eye), eyeSpread: rounded(Math.abs(eyes[0].x - eyes[1].x)),
    brow: point(brow), noseTip: point(nose), mouth: point(mouth), chin: point(chin),
    cheekWidth: rounded(cheekWidth), jawWidth: rounded(jawWidth),
    mouthWidth: rounded(Math.abs(mouthCorners[0].x - mouthCorners[1].x)),
    faceWidth: rounded(cheekWidth), front: rounded(eye.z),
  }
}

const smooth = (value, low, high) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

/** Project source-derived face-oval landmarks onto the cast's head UV island. */
function faceOvalUv(skinned, landmarks) {
  if (!landmarks || landmarks.length !== 468 * 3) return null
  const geometry = skinned.geometry
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
  const headSlot = skinned.material.findIndex(material => material.name === 'head')
  const candidates = []
  for (const group of geometry.groups.filter(entry => entry.materialIndex === headSlot)) {
    for (let i = group.start; i < group.start + group.count; i++) {
      const u = uv.getX(i) * 512, v = (1 - uv.getY(i)) * 512
      if (u < 60 || u > 450 || v < 30 || v > 360) continue
      const world = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(skinned.matrixWorld)
      candidates.push([world.x, world.y, world.z, u, v])
    }
  }
  return FACE_OVAL.map(index => {
    const target = landmarks.slice(index * 3, index * 3 + 3)
    let nearest = null, error = Infinity
    for (const candidate of candidates) {
      const distance = (candidate[0] - target[0]) ** 2 + (candidate[1] - target[1]) ** 2 + (candidate[2] - target[2]) ** 2
      if (distance < error) { nearest = candidate; error = distance }
    }
    if (!nearest || error > 9) throw new Error(`Face oval cannot map landmark ${index}`)
    return [nearest[3], nearest[4]]
  })
}

function faceOvalWeight(x, y, oval) {
  if (!oval) return 1
  let inside = false, nearest = Infinity
  for (let i = 0; i < oval.length; i++) {
    const [ax, ay] = oval[i], [bx, by] = oval[(i + 1) % oval.length]
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)))
    nearest = Math.min(nearest, Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)))
  }
  return inside ? 1 : 1 - smooth(nearest, 20, 40)
}

/** Follow the face's UV island, then use colour and a soft front/back fade to protect hair. */
async function headSkinMask(skinned, fit, atlas, foreheadY, oval, work) {
  const size = atlas.size
  const mask = new Uint8Array(size * size)
  const covered = new Uint8Array(mask.length)
  const depth = new Float32Array(mask.length)
  const height = new Float32Array(mask.length)
  const geometry = skinned.geometry
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
  const headSlot = skinned.material.findIndex(material => material.name === 'head')
  let triangles = 0
  for (const group of geometry.groups.filter(entry => entry.materialIndex === headSlot)) {
    for (let i = group.start; i < group.start + group.count; i += 3) {
      const world = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(position, i + j).applyMatrix4(skinned.matrixWorld))
      const pixel = [0, 1, 2].map(j => [(uv.getX(i + j)) * size, (1 - uv.getY(i + j)) * size])
      const x0 = Math.max(0, Math.floor(Math.min(...pixel.map(v => v[0])))), x1 = Math.min(size - 1, Math.ceil(Math.max(...pixel.map(v => v[0]))))
      const y0 = Math.max(0, Math.floor(Math.min(...pixel.map(v => v[1])))), y1 = Math.min(size - 1, Math.ceil(Math.max(...pixel.map(v => v[1]))))
      const denominator = (pixel[1][1] - pixel[2][1]) * (pixel[0][0] - pixel[2][0]) + (pixel[2][0] - pixel[1][0]) * (pixel[0][1] - pixel[2][1])
      if (Math.abs(denominator) < 1e-6) continue
      triangles++
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const a = ((pixel[1][1] - pixel[2][1]) * (x + 0.5 - pixel[2][0]) + (pixel[2][0] - pixel[1][0]) * (y + 0.5 - pixel[2][1])) / denominator
        const b = ((pixel[2][1] - pixel[0][1]) * (x + 0.5 - pixel[2][0]) + (pixel[0][0] - pixel[2][0]) * (y + 0.5 - pixel[2][1])) / denominator
        const c = 1 - a - b
        if (a < -0.001 || b < -0.001 || c < -0.001) continue
        const at = y * size + x
        covered[at] = 1
        height[at] = a * world[0].y + b * world[1].y + c * world[2].y
        depth[at] = a * world[0].z + b * world[1].z + c * world[2].z
      }
    }
  }
  // Eye, teeth, cap and scarf UV islands can share the head material. Keep the single
  // connected atlas island containing the cheek, regardless of its physical width or height.
  const component = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  const seeds = [[210, 190], [302, 190]].map(([x, y]) => y * size + x)
  let first = 0, last = 0
  for (const seed of seeds) if (covered[seed] && !component[seed]) { component[seed] = 1; queue[last++] = seed }
  while (first < last) {
    const at = queue[first++], x = at % size, y = (at / size) | 0
    for (const next of [x ? at - 1 : -1, x < size - 1 ? at + 1 : -1, y ? at - size : -1, y < size - 1 ? at + size : -1]) {
      if (next >= 0 && covered[next] && !component[next]) { component[next] = 1; queue[last++] = next }
    }
  }
  if (triangles < 100 || last < 1000) throw new Error('Face UV island is unexpectedly empty')
  for (let at = 0; at < mask.length; at++) {
    if (!component[at]) continue
    const r = atlas.rgb[at * 3], g = atlas.rgb[at * 3 + 1], blue = atlas.rgb[at * 3 + 2]
    const sum = r + g + blue
    if (!sum) continue
    const chroma = Math.hypot(r / sum - atlas.base[0] / atlas.baseSum, g / sum - atlas.base[1] / atlas.baseSum)
    const neck = 1 - smooth(height[at], fit.chin[1] + 1, fit.chin[1] + 6)
    const colour = (1 - smooth(chroma, 0.07, 0.13))
      * smooth(r - g, 2, 12) * smooth(g - blue, -2, 8)
      * smooth(sum / atlas.baseSum, 0.48 - 0.18 * neck, 0.77 - 0.21 * neck)
    const upper = smooth(height[at], fit.eyes[1] + 1, fit.eyes[1] + 4)
    const front = Math.max(neck, smooth(depth[at], fit.front - 10 + upper * 4, fit.front - 7 + upper * 5))
    const hairline = 1 - smooth(height[at], foreheadY + 2, foreheadY + 5)
    const face = Math.max(neck, faceOvalWeight(at % size + 0.5, (at / size | 0) + 0.5, oval))
    mask[at] = Math.round(255 * colour * front * hairline * face)
  }
  // Copy the edge a few texels into unused atlas gutters for bilinear and mip sampling.
  for (let pass = 0; pass < 3; pass++) {
    const previous = mask.slice()
    for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
      const at = y * size + x
      if (covered[at]) continue
      mask[at] = Math.max(previous[at], Math.round(Math.max(previous[at - 1], previous[at + 1], previous[at - size], previous[at + size]) * 0.85))
    }
  }
  if (mask.filter(value => value > 127).length < 1000) throw new Error('Head skin mask is unexpectedly empty')
  const output = join(work, 'head-skin-mask.png')
  const raw = join(work, 'head-skin-mask.raw')
  await writeFile(raw, mask)
  await ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${size}x${size}`, '-i', raw, '-frames:v', '1', '-compression_level', '9', output])
  return output
}

/** FBX groups alternate material slots. Reorder whole triangles so each slot exports once. */
function consolidateGroups(geometry, materialCount) {
  if (geometry.index) throw new Error('Expected non-indexed Rocketbox geometry')
  const originalCount = geometry.getAttribute('position').count
  const order = []
  const counts = Array(materialCount).fill(0)
  for (let material = 0; material < materialCount; material++) {
    for (const group of geometry.groups) {
      if (group.materialIndex !== material) continue
      for (let vertex = group.start; vertex < group.start + group.count; vertex++) order.push(vertex)
      counts[material] += group.count
    }
  }
  if (order.length !== originalCount || counts.some(count => count % 3)) throw new Error('Invalid FBX material groups')
  const result = new THREE.BufferGeometry()
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const array = new attribute.array.constructor(attribute.array.length)
    for (let vertex = 0; vertex < order.length; vertex++) {
      for (let component = 0; component < attribute.itemSize; component++) {
        array[vertex * attribute.itemSize + component] = attribute.getComponent(order[vertex], component)
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize, attribute.normalized))
  }
  let start = 0
  for (let material = 0; material < counts.length; material++) {
    if (counts[material]) result.addGroup(start, counts[material], material)
    start += counts[material]
  }
  return result
}

/** Reduce each material separately so the low mesh retains exactly the full mesh's slots. */
async function reducedGeometry(geometry) {
  const modifier = new SimplifyModifier()
  const parts = []
  for (const group of geometry.groups) {
    const part = new THREE.BufferGeometry()
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      const values = attribute.array.slice(group.start * attribute.itemSize, (group.start + group.count) * attribute.itemSize)
      part.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized))
    }
    // SimplifyModifier measures removals against welded vertices, not FBX's expanded triangles.
    const welded = mergeVertices(part)
    parts.push(await modifier.modify(welded, Math.round(welded.getAttribute('position').count * 0.45)))
  }
  const reduced = mergeGeometries(parts, true)
  if (!reduced) throw new Error('Could not merge reduced material groups')
  for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
    if (!reduced.hasAttribute(name)) throw new Error(`Reduced mesh lost ${name}`)
  }
  return reduced
}

async function buildAvatar(member) {
  const target = join(OUT, `${member.id}.pack.gz`)
  if (!FORCE && await exists(target)) {
    const known = JSON.parse(await readFile(join(ROOT, 'src', 'assets', 'cast.index.json'), 'utf8').catch(() => '[]')).find(entry => entry.id === member.id)
    if (known) return known
  }
  const tree = await repoTree()
  const base = `Assets/Avatars/Adults/${member.source}`
  const texture = (suffix, optional = false) => {
    const found = tree.find(path => path.startsWith(`${base}/Textures/`) && path.endsWith(`_${suffix}.tga`))
    if (!found && !optional) throw new Error(`${member.source} has no ${suffix} texture`)
    return found ?? null
  }
  // Short-haired avatars paint the hair onto the head and have no separate hair texture.
  const hairPath = texture('opacity_color', true)
  const [fbx, body, head, bodyNormal, headNormal, opacity, preview] = await Promise.all([
    fetchCached(`${base}/Export/${member.source}.fbx`), fetchCached(texture('body_color')), fetchCached(texture('head_color')),
    fetchCached(texture('body_normal')), fetchCached(texture('head_normal')),
    hairPath ? fetchCached(hairPath) : null, fetchCached(`${base}/${member.source}.png`),
  ])

  const work = join(CACHE, `work-${member.id}`)
  await mkdir(work, { recursive: true })
  const image = name => join(work, name)
  await Promise.all([
    ffmpeg(['-i', body, '-vf', 'scale=1024:1024:flags=lanczos', '-q:v', '3', image('body.jpg')]),
    ffmpeg(['-i', head, '-vf', 'scale=1024:1024:flags=lanczos', '-q:v', '3', image('head.jpg')]),
    ffmpeg(['-i', bodyNormal, '-vf', 'scale=512:512:flags=lanczos', '-q:v', '2', image('body-normal.jpg')]),
    ffmpeg(['-i', headNormal, '-vf', 'scale=512:512:flags=lanczos', '-q:v', '2', image('head-normal.jpg')]),
    opacity && ffmpeg(['-i', opacity, '-vf', 'scale=1024:1024:flags=lanczos', '-q:v', '4', image('hair.jpg')]),
    opacity && ffmpeg(['-i', opacity, '-vf', "alphaextract,scale=1024:1024:flags=lanczos,lut=y='round(val/8)*8'", '-pix_fmt', 'gray', '-compression_level', '9', image('hair-alpha.png')]),
    ffmpeg(['-i', preview, '-vf', 'crop=250:250:515:14,scale=160:160:flags=lanczos', '-q:v', '4', join(OUT, `${member.id}.jpg`)]),
  ])

  const scene = await loadFbx(fbx)
  const mesh = []
  scene.traverse(object => { if (object.isSkinnedMesh) mesh.push(object) })
  if (mesh.length !== 1) throw new Error(`${member.source}: expected one skinned mesh, found ${mesh.length}`)
  const skinned = mesh[0]
  for (const light of scene.children.filter(child => child.isLight)) scene.remove(light)
  // Three material slots, named for what the App binds to them.
  const slot = name => (name.includes('head') ? 'head' : name.includes('opacity') ? 'hair' : 'body')
  skinned.material = (Array.isArray(skinned.material) ? skinned.material : [skinned.material]).map(material => {
    const plain = new THREE.MeshStandardMaterial({ name: slot(material.name) })
    return plain
  })
  skinned.name = 'avatar'
  skinned.geometry.deleteAttribute('uv1')
  skinned.geometry = consolidateGroups(skinned.geometry, skinned.material.length)

  scene.updateMatrixWorld(true)
  const previous = JSON.parse(await readFile(join(ROOT, 'src', 'assets', 'cast.index.json'), 'utf8').catch(() => '[]')).find(entry => entry.id === member.id)
  const atlas = await headAtlas(image('head.jpg'), work)
  const fit = faceFit(scene, skinned, atlas)
  const foreheadY = previous?.faceLandmarks?.[10 * 3 + 1] ?? fit.brow[1] + 4
  const oval = faceOvalUv(skinned, previous?.faceLandmarks)
  await headSkinMask(skinned, fit, atlas, foreheadY, oval, work)
  const world = name => { const bone = scene.getObjectByName(name); return bone ? bone.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)) : null }
  const box = new THREE.Box3().setFromBufferAttribute(skinned.geometry.attributes.position)
  const meta = {
    ...(previous?.faceLandmarks ? { faceLandmarks: previous.faceLandmarks, faceLandmarkDepth: previous.faceLandmarkDepth } : {}),
    id: member.id, source: member.source, sex: member.id[0],
    /** Bind-pose landmarks in the model's own units, for mounting a photo face and sizing. */
    eyes: { left: world('Bip01_LEye'), right: world('Bip01_REye') }, head: world('Bip01_Head'), root: world('Bip01'),
    bounds: { min: box.min.toArray().map(v => +v.toFixed(2)), max: box.max.toArray().map(v => +v.toFixed(2)) },
    skin: await skinColour(image('head.jpg')), hair: Boolean(opacity), faceFit: fit,
    vertices: skinned.geometry.attributes.position.count, license: LICENSE_URL,
  }

  const glb = Buffer.from(await new Promise((resolve, reject) => new GLTFExporter().parse(scene, resolve, reject, { binary: true, onlyVisible: false })))
  const fullGeometry = skinned.geometry
  skinned.geometry = await reducedGeometry(fullGeometry)
  const lodVertices = skinned.geometry.getAttribute('position').count
  const lodTriangles = skinned.geometry.index.count / 3
  const lodGlb = Buffer.from(await new Promise((resolve, reject) => new GLTFExporter().parse(scene, resolve, reject, { binary: true, onlyVisible: false })))
  skinned.geometry = fullGeometry
  meta.lodVertices = lodVertices
  meta.lodTriangles = lodTriangles
  const files = await Promise.all(['body.jpg', 'head.jpg', 'head-skin-mask.png', 'body-normal.jpg', 'head-normal.jpg', ...(opacity ? ['hair.jpg', 'hair-alpha.png'] : [])].map(async name => ({ name, data: await readFile(image(name)) })))
  const pack = writePack([{ name: 'model.glb', data: glb, meta }, { name: 'model-lod.glb', data: lodGlb }, ...files, { name: 'LICENSE.md', data: licenseBytes }])
  await writeFile(target, pack)
  await rm(work, { recursive: true, force: true })
  console.log(`${member.id} ${member.source}: ${meta.vertices} full / ${lodVertices} LOD vertices, ${lodTriangles} LOD triangles, pack ${(pack.length / 1024).toFixed(0)} KB, skin ${meta.skin}`)
  return meta
}

/** Sample a keyframe track at a time, with the interpolation three.js would use. */
function sampler(track) {
  const interpolant = track.createInterpolant()
  return time => Array.from(interpolant.evaluate(Math.min(time, track.times[track.times.length - 1])))
}

async function buildAnimations(sex, boneNames) {
  const target = join(OUT, `clips-${sex}.pack.gz`)
  if (!FORCE && await exists(target)) return
  const tree = await repoTree()
  const bones = boneNames.filter(name => !FACE_BONE.test(name))
  const entries = []
  let rootReference = null
  for (const clip of CLIPS) {
    const folder = `Assets/Animations/all_animations_max_motextr_${clip.dir}`
    const path = clip.pick.map(name => `${folder}/${sex}_${name}.max.fbx`).find(candidate => tree.includes(candidate))
    if (!path) { console.warn(`  no ${sex} source for "${clip.name}"`); continue }
    const source = (await loadFbx(await fetchCached(path))).animations[0]
    const duration = Math.min(source.duration, clip.maxSeconds ?? source.duration)
    const frames = Math.max(2, Math.round(duration * CLIP_FPS) + 1)
    const byName = new Map(source.tracks.map(track => [track.name, track]))
    const rotations = new Int16Array(frames * bones.length * 4)
    bones.forEach((bone, b) => {
      const track = byName.get(`${bone}.quaternion`)
      const at = track ? sampler(track) : () => [0, 0, 0, 1]
      for (let f = 0; f < frames; f++) {
        const q = at((f / (frames - 1)) * duration)
        for (let c = 0; c < 4; c++) rotations[(f * bones.length + b) * 4 + c] = Math.round(Math.max(-1, Math.min(1, q[c])) * 32767)
      }
    })
    const rootTrack = byName.get('Bip01.position')
    const root = new Float32Array(frames * 3)
    if (rootTrack) { const at = sampler(rootTrack); for (let f = 0; f < frames; f++) root.set(at((f / (frames - 1)) * duration), f * 3) }
    // Rocketbox is authored in centimetres, Y up. X/Z root travel gives metres per second.
    const groundSpeed = ['walk', 'run'].includes(clip.name) && rootTrack
      ? Math.hypot(root[root.length - 3] - root[0], root[root.length - 1] - root[2]) / (100 * duration)
      : null
    if (clip.name === 'idle') rootReference = Array.from(root.subarray(0, 3)).map(v => +v.toFixed(3))
    entries.push({
      name: clip.name, data: Buffer.concat([Buffer.from(rotations.buffer), Buffer.from(root.buffer)]),
      meta: { source: path.split('/').pop(), duration: +duration.toFixed(3), frames, rotationBytes: rotations.byteLength, loop: !['wave', 'nod', 'cheer', 'clap'].includes(clip.name), ...(groundSpeed === null ? {} : { groundSpeed: +groundSpeed.toFixed(4) }) },
    })
    console.log(`  ${sex} ${clip.name} ← ${path.split('/').pop()} (${duration.toFixed(1)} s, ${frames} frames)`)
  }
  const pack = writePack([{ name: 'index', data: Buffer.alloc(0), meta: { bones, fps: CLIP_FPS, rootReference } }, ...entries])
  await writeFile(target, pack)
  console.log(`clips-${sex}: ${entries.length} clips, ${(pack.length / 1024).toFixed(0)} KB`)
}

await mkdir(OUT, { recursive: true })
const licenseBytes = await readFile(await fetchCached('LICENSE.md'))
await writeFile(join(OUT, 'LICENSE.md'), licenseBytes)
const cast = []
for (const member of CAST) cast.push(await buildAvatar(member))
await writeFile(join(ROOT, 'src', 'assets', 'cast.index.json'), JSON.stringify(cast, null, 1) + '\n')

// Bone names come from one avatar per skeleton; every adult of that sex shares them.
for (const sex of ['f', 'm']) {
  const member = CAST.find(entry => entry.id[0] === sex)
  const scene = await loadFbx(await fetchCached(`Assets/Avatars/Adults/${member.source}/Export/${member.source}.fbx`))
  const names = []
  scene.traverse(object => { if (object.isBone) names.push(object.name) })
  await buildAnimations(sex, names)
}
console.log('done')
