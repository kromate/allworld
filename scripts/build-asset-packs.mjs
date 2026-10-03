// Builds the runtime asset packs in public/packs/ from the licensed source models in assets-src/.
//
// Why packs: the hosted Goalmatic import accepts .gz as a binary asset type but not .glb, and the
// release validator caps the number of files. One gzip container per asset family satisfies both.
//
// Characters are rewritten so every vertex points at one of eight "role" cells (skin, hair, top,
// bottom, shoes, accent, eyes, sole). A member's avatar is then a tiny per-avatar palette texture.
import { readFile, writeFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { gzipSync, inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'assets-src')
const OUT = join(ROOT, 'public', 'packs')

export const ROLES = ['skin', 'hair', 'top', 'bottom', 'shoes', 'accent', 'eyes', 'sole']
const ROLE = Object.fromEntries(ROLES.map((role, index) => [role, index]))
const JOINTS = ['root', 'leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head']
// Animations the App uses. The rest of Kenney's set (weapons, attacks) is left out of the pack.
const KEEP_ANIMATIONS = new Set([
  'static', 'idle', 'walk', 'sprint', 'jump', 'sit', 'pick-up', 'emote-yes', 'emote-no',
  'interact-right', 'interact-left', 'holding-both', 'wheelchair-sit', 'wheelchair-move-forward',
])

const INTERIOR_ASSETS = [
  { id: 'Sofa_01', family: 'seating', material: 'carpet', size: 512 },
  { id: 'ArmChair_01', family: 'seating', material: 'carpet', size: 512 },
  { id: 'dining_chair_02', family: 'seating', material: 'wood', size: 512 },
  { id: 'bar_chair_round_01', family: 'seating', material: 'wood', size: 512 },
  { id: 'painted_wooden_bench', family: 'seating', material: 'wood', size: 512 },
  { id: 'Ottoman_01', family: 'seating', material: 'carpet', size: 512 },
  { id: 'dining_table', family: 'tables', material: 'wood', size: 512 },
  { id: 'coffee_table_round_01', family: 'tables', material: 'wood', size: 512 },
  { id: 'side_table_01', family: 'tables', material: 'wood', size: 512 },
  { id: 'GothicBed_01', family: 'bedroom', material: 'carpet', size: 512 },
  { id: 'Shelf_01', family: 'bedroom', material: 'wood', size: 512 },
  { id: 'drawer_cabinet', family: 'bedroom', material: 'wood', size: 512 },
  { id: 'throw_pillows_01', family: 'bedroom', material: 'carpet', size: 256 },
  { id: 'potted_plant_04', family: 'props', material: 'plant', size: 512 },
  { id: 'desk_lamp_arm_01', family: 'props', material: 'metal', size: 256 },
  { id: 'Television_01', family: 'props', material: 'metalDark', size: 256 },
  { id: 'cardboard_box_01', family: 'props', material: 'wood', size: 256 },
  { id: 'classic_laptop', family: 'props', material: 'metalLight', size: 256 },
  { id: 'boombox', family: 'props', material: 'metalDark', size: 256 },
  { id: 'electric_stove', family: 'kitchen', material: 'metalLight', size: 512 },
  { id: 'vintage_microwave', family: 'kitchen', material: 'metalLight', size: 256 },
]

function interiorAlias(name) {
  if (/^(floor|wall|doorway|paneling|stairs)/i.test(name)) return null
  if (/^(bathroom|bathtub|shower|toilet|rug|ceilingFan|coatRack|trashcan)/i.test(name)) return null
  if (/^pillow/i.test(name)) return 'throw_pillows_01'
  if (/^cardboardBox/i.test(name)) return 'cardboard_box_01'
  if (name === 'laptop') return 'classic_laptop'
  if (/^computer/i.test(name)) return null
  if (name === 'radio') return 'boombox'
  if (/^speaker/i.test(name)) return null
  if (name === 'televisionVintage' || name === 'televisionAntenna') return 'Television_01'
  if (/^television/i.test(name)) return null
  if (/plant/i.test(name)) return 'potted_plant_04'
  if (/lamp.*Table/i.test(name)) return 'desk_lamp_arm_01'
  if (/lamp/i.test(name)) return null
  if (/loungeSofaOttoman/i.test(name)) return 'Ottoman_01'
  if (/SofaCorner/i.test(name)) return null
  if (/^(lounge.*Sofa)/i.test(name)) return 'Sofa_01'
  if (name === 'bench') return 'painted_wooden_bench'
  if (/bench/i.test(name)) return null
  if (/^(lounge|chair)/i.test(name)) return /Desk/i.test(name) ? 'dining_chair_02' : 'ArmChair_01'
  if (/stool/i.test(name)) return 'bar_chair_round_01'
  if (name === 'bedSingle' || name === 'bedDouble') return 'GothicBed_01'
  if (/bed/i.test(name)) return null
  if (name === 'sideTable') return 'side_table_01'
  if (name === 'sideTableDrawers') return null
  if (/^tableCoffeeGlass/i.test(name)) return null
  if (name === 'tableCoffeeSquare') return null
  if (/^tableCoffee/i.test(name)) return 'coffee_table_round_01'
  if (name === 'tableRound') return 'coffee_table_round_01'
  if (/^tableCross/i.test(name)) return null
  if (/^tableGlass/i.test(name)) return null
  if (/^table/i.test(name)) return 'dining_table'
  if (/^(desk|kitchenBar)/i.test(name)) return null
  if (name === 'bookcaseClosedDoors') return null
  if (/^bookcase/i.test(name)) return 'Shelf_01'
  if (/^kitchenCabinet/i.test(name)) return null
  if (/^cabinetTelevision/i.test(name)) return null
  if (/^(dryer|washer|kitchenFridge)/i.test(name)) return null
  if (/^(kitchenSink|hood)/i.test(name)) return null
  if (/^kitchenStove/i.test(name)) return 'electric_stove'
  if (name === 'kitchenMicrowave') return 'vintage_microwave'
  if (/^kitchen/i.test(name) || /toaster/i.test(name)) return null
  return null
}

function interiorHeight(name) {
  if (/^(pillow|bear)/i.test(name)) return 0.42
  if (/Ottoman/i.test(name)) return 0.5
  if (/bedBunk/i.test(name)) return 1.72
  if (/bed/i.test(name)) return 0.92
  if (/bookcase/i.test(name)) return /Low/i.test(name) ? 0.92 : 1.9
  if (/Fridge|washerDryerStacked/i.test(name)) return 1.86
  if (/cabinet/i.test(name)) return /Upper/i.test(name) ? 0.82 : 0.95
  if (/lamp.*Floor/i.test(name)) return 1.65
  if (/lamp/i.test(name)) return 0.58
  if (/plantSmall/i.test(name)) return 0.48
  if (/pottedPlant/i.test(name)) return 1.18
  if (/Sofa|lounge|chair|bench|stool/i.test(name)) return /stoolBar/i.test(name) ? 1.05 : 0.94
  if (/tableCoffee|sideTable/i.test(name)) return 0.48
  if (/^(table|desk|kitchenBar)/i.test(name)) return 0.76
  if (/Television|computerScreen/i.test(name)) return 0.72
  if (/pillow|books|computer|laptop|radio|speaker|toaster|kitchen/i.test(name)) return 0.42
  return 1
}

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a GLB file')
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength + 8
  const binLength = buffer.readUInt32LE(20 + jsonLength)
  return { json, bin: Buffer.from(buffer.subarray(binStart, binStart + binLength)) }
}

function writeGlb(json, bin) {
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  if (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(4 - (jsonBytes.length % 4), 0x20)])
  let binBytes = bin
  if (binBytes.length % 4) binBytes = Buffer.concat([binBytes, Buffer.alloc(4 - (binBytes.length % 4))])
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binBytes.length, 8)
  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonBytes.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(binBytes.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binBytes])
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const READERS = {
  5126: [4, (b, o) => b.readFloatLE(o), (b, o, v) => b.writeFloatLE(v, o)],
  5123: [2, (b, o) => b.readUInt16LE(o), (b, o, v) => b.writeUInt16LE(v, o)],
  5121: [1, (b, o) => b.readUInt8(o), (b, o, v) => b.writeUInt8(v, o)],
  5125: [4, (b, o) => b.readUInt32LE(o), (b, o, v) => b.writeUInt32LE(v, o)],
}

function accessorLayout(json, index) {
  const accessor = json.accessors[index]
  const view = json.bufferViews[accessor.bufferView]
  const [size, read, write] = READERS[accessor.componentType]
  const width = COMPONENTS[accessor.type]
  return {
    count: accessor.count, width, size, read, write,
    offset: (view.byteOffset || 0) + (accessor.byteOffset || 0),
    stride: view.byteStride || size * width,
  }
}

function readAccessor(json, bin, index) {
  const layout = accessorLayout(json, index)
  const rows = []
  for (let i = 0; i < layout.count; i++) {
    const row = []
    for (let c = 0; c < layout.width; c++) row.push(layout.read(bin, layout.offset + i * layout.stride + c * layout.size))
    rows.push(row)
  }
  return rows
}

function writeAccessor(json, bin, index, rows) {
  const layout = accessorLayout(json, index)
  rows.forEach((row, i) => row.forEach((value, c) => layout.write(bin, layout.offset + i * layout.stride + c * layout.size, value)))
}

/** Decode an 8-bit indexed or RGB(A) PNG far enough to sample palette swatches. */
function decodePng(buffer) {
  let offset = 8
  let width = 0, height = 0, colorType = 0, palette = null
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; if (data[8] !== 8) throw new Error('Only 8-bit PNG is supported') }
    if (type === 'PLTE') palette = data
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const channels = { 2: 3, 3: 1, 6: 4 }[colorType]
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      let out = value
      if (filter === 1) out = value + left
      else if (filter === 2) out = value + up
      else if (filter === 3) out = value + ((left + up) >> 1)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
        out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      }
      pixels[y * stride + x] = out & 255
    }
  }
  return {
    width, height,
    at(x, y) {
      const i = y * stride + x * channels
      if (colorType === 3) return [palette[pixels[i] * 3], palette[pixels[i] * 3 + 1], palette[pixels[i] * 3 + 2]]
      return [pixels[i], pixels[i + 1], pixels[i + 2]]
    },
  }
}

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
// Each swatch is a flat half and a gradient half; both halves are the same colour family.
const cellKey = uv => `${Math.min(7, Math.floor(uv[0] * 8))}:${Math.min(3, Math.floor(uv[1] * 4))}`
const swatch = (colormap, key) => { const [col, row] = key.split(':').map(Number); return hex(colormap.at(col * 64 + 48, row * 128 + 20)) }

/** Connected components. `weld` also joins vertices that share a position. */
function islands(positions, indices, weld) {
  const parent = positions.map((_, i) => i)
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b }
  if (weld) {
    const byPosition = new Map()
    positions.forEach((p, i) => {
      const key = p.map(v => Math.round(v * 2000)).join(',')
      if (byPosition.has(key)) union(i, byPosition.get(key)); else byPosition.set(key, i)
    })
  }
  for (let i = 0; i < indices.length; i += 3) { union(indices[i], indices[i + 1]); union(indices[i], indices[i + 2]) }
  return positions.map((_, i) => find(i))
}

function assignCharacterRoles(json, bin, colormap) {
  const meshByName = Object.fromEntries(json.meshes.map(mesh => [mesh.name, mesh.primitives[0]]))
  const load = primitive => {
    const mesh = {
      primitive,
      pos: readAccessor(json, bin, primitive.attributes.POSITION),
      uv: readAccessor(json, bin, primitive.attributes.TEXCOORD_0),
      joints: readAccessor(json, bin, primitive.attributes.JOINTS_0),
      weights: readAccessor(json, bin, primitive.attributes.WEIGHTS_0),
      indices: readAccessor(json, bin, primitive.indices).map(row => row[0]),
    }
    mesh.cell = mesh.uv.map(cellKey)
    mesh.joint = mesh.pos.map((_, i) => JOINTS[mesh.joints[i][mesh.weights[i].indexOf(Math.max(...mesh.weights[i]))]])
    return mesh
  }
  const head = load(meshByName['head-mesh'])
  const body = load(meshByName['body-mesh'])
  const tally = (mesh, filter) => {
    const totals = new Map()
    mesh.cell.forEach((key, i) => { if (filter(i)) totals.set(key, (totals.get(key) || 0) + 1) })
    return totals
  }
  const largest = totals => [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  // Every face in this set is the same 220-vertex block, whatever the hair or hat.
  const headCells = tally(head, () => true)
  const skinCell = [...headCells.entries()].find(([, total]) => total === 220)?.[0]
  if (!skinCell) throw new Error(`Could not find the face block: ${JSON.stringify([...headCells])}`)

  // Eyes are small detached blocks low on the front of the face.
  const headIsland = islands(head.pos, head.indices, true)
  const islandStats = new Map()
  head.pos.forEach((p, i) => {
    const stat = islandStats.get(headIsland[i]) || { n: 0, y: 0, zMax: -9, cell: head.cell[i] }
    stat.n++; stat.y += p[1]; stat.zMax = Math.max(stat.zMax, p[2])
    islandStats.set(headIsland[i], stat)
  })
  const faceFront = Math.max(...head.pos.filter((_, i) => head.cell[i] === skinCell).map(p => p[2]))
  const isEye = i => {
    const stat = islandStats.get(headIsland[i])
    const y = stat.y / stat.n
    return stat.n <= 16 && y > 0.40 && y < 0.52 && stat.zMax >= faceFront - 0.004 && stat.cell !== skinCell
  }
  const hairCell = largest(tally(head, i => head.cell[i] !== skinCell && !isEye(i)))
  const headRoles = head.cell.map((key, i) => {
    if (key === skinCell) return ROLE.skin
    if (isEye(i)) return ROLE.eyes
    return key === hairCell ? ROLE.hair : ROLE.accent
  })

  // Body faces are flat-shaded, so each face is its own component and can be judged by height.
  const face = islands(body.pos, body.indices, false)
  const faceTop = new Map()
  body.pos.forEach((p, i) => faceTop.set(face[i], Math.max(faceTop.get(face[i]) ?? -9, p[1])))
  const groupRange = new Map()
  body.pos.forEach((p, i) => {
    const key = `${body.joint[i]}|${body.cell[i]}`
    const range = groupRange.get(key) || { n: 0, min: 9, max: -9 }
    range.n++; range.min = Math.min(range.min, p[1]); range.max = Math.max(range.max, p[1])
    groupRange.set(key, range)
  })
  const isLeg = i => body.joint[i].startsWith('leg')
  const isHand = i => {
    const range = groupRange.get(`${body.joint[i]}|${body.cell[i]}`)
    return body.joint[i].startsWith('arm') && range.n === 64 && range.min >= 0.22 && range.max <= 0.35
  }
  const legRole = i => {
    if (body.cell[i] === skinCell) return ROLE.skin
    const top = faceTop.get(face[i])
    return top <= 0.035 ? ROLE.sole : top <= 0.095 ? ROLE.shoes : ROLE.bottom
  }
  const bottomCell = largest(tally(body, i => isLeg(i) && legRole(i) === ROLE.bottom))
  const isHip = i => body.joint[i] === 'torso' && body.cell[i] === bottomCell && groupRange.get(`torso|${body.cell[i]}`).max <= 0.22
  const topCell = largest(tally(body, i => !isLeg(i) && !isHand(i) && !isHip(i) && body.cell[i] !== skinCell))
  const bodyRoles = body.cell.map((key, i) => {
    if (isLeg(i)) return legRole(i)
    if (key === skinCell) return ROLE.skin
    if (isHand(i)) return ROLE.accent
    if (isHip(i)) return ROLE.bottom
    return key === topCell ? ROLE.top : ROLE.accent
  })

  // Remember the artist's colours so the preset look can be restored.
  const sample = role => {
    const totals = new Map()
    headRoles.forEach((r, i) => { if (r === role) totals.set(head.cell[i], (totals.get(head.cell[i]) || 0) + 1) })
    bodyRoles.forEach((r, i) => { if (r === role) totals.set(body.cell[i], (totals.get(body.cell[i]) || 0) + 1) })
    const key = largest(totals)
    return key ? swatch(colormap, key) : null
  }
  const defaults = {}
  for (const role of ROLES) defaults[role] = sample(ROLE[role])
  defaults.eyes ||= '#43434c'
  defaults.sole ||= '#f4f4f8'
  defaults.shoes ||= defaults.sole
  defaults.bottom ||= defaults.top
  defaults.accent ||= defaults.top

  // Where a photo face mounts: the face block's centre and front, relative to the head joint.
  const jointPosition = name => {
    const at = [0, 0, 0]
    const walk = (index, offset) => {
      const node = json.nodes[index]
      const here = (node.translation || [0, 0, 0]).map((v, i) => v + offset[i])
      if (node.name === name) { at[0] = here[0]; at[1] = here[1]; at[2] = here[2]; return true }
      return (node.children || []).some(child => walk(child, here))
    }
    json.scenes[json.scene || 0].nodes.some(root => walk(root, [0, 0, 0]))
    return at
  }
  const headJoint = jointPosition('head')
  const block = head.pos.filter((_, i) => head.cell[i] === skinCell)
  const range = axis => [Math.min(...block.map(p => p[axis])), Math.max(...block.map(p => p[axis]))]
  const [xs, ys, zs] = [range(0), range(1), range(2)]
  const round = v => +v.toFixed(4)
  const faceMount = {
    y: round((ys[0] + ys[1]) / 2 - headJoint[1]), z: round(zs[1] - headJoint[2]),
    width: round(xs[1] - xs[0]), height: round(ys[1] - ys[0]),
  }

  // Point every vertex at its role cell. v keeps its place inside the cell so the gradient survives.
  const remap = (mesh, roles) => writeAccessor(json, bin, mesh.primitive.attributes.TEXCOORD_0,
    mesh.uv.map((uv, i) => [(roles[i] + 0.5) / ROLES.length, Math.min(0.98, Math.max(0.02, (uv[1] * 4) % 1))]))
  remap(head, headRoles)
  remap(body, bodyRoles)
  return { defaults, faceMount }
}

function stripCharacter(json, keepAnimations) {
  delete json.images
  delete json.textures
  delete json.samplers
  for (const material of json.materials || []) {
    if (material.pbrMetallicRoughness) delete material.pbrMetallicRoughness.baseColorTexture
  }
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    delete primitive.attributes.TANGENT
    delete primitive.attributes.TEXCOORD_1
  }
  if (keepAnimations) json.animations = json.animations.filter(animation => KEEP_ANIMATIONS.has(animation.name))
  else delete json.animations
}

function writePack(entries) {
  const index = []
  let offset = 0
  for (const entry of entries) {
    index.push({ name: entry.name, offset, length: entry.data.length, ...(entry.meta ? { meta: entry.meta } : {}) })
    offset += entry.data.length
  }
  const indexBytes = Buffer.from(JSON.stringify({ version: 1, entries: index }), 'utf8')
  const header = Buffer.alloc(8)
  header.write('NWPK', 0, 'ascii')
  header.writeUInt32LE(indexBytes.length, 4)
  return gzipSync(Buffer.concat([header, indexBytes, ...entries.map(entry => entry.data)]), { level: 9 })
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${error}`)))
  })
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

async function resizeJpeg(bytes, width, directory, name) {
  const input = join(directory, `${name}-source.jpg`)
  const output = join(directory, `${name}-${width}.jpg`)
  await writeFile(input, bytes)
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-vf', `scale=${width}:${width}:force_original_aspect_ratio=decrease`, '-q:v', '4', output])
  return readFile(output)
}

const pad4 = bytes => bytes.length % 4 ? Buffer.concat([bytes, Buffer.alloc(4 - bytes.length % 4)]) : bytes

async function buildInteriorModel(asset, directory) {
  const apiUrl = `https://api.polyhaven.com/files/${asset.id}`
  const files = await fetch(apiUrl).then(response => {
    if (!response.ok) throw new Error(`Could not read ${apiUrl} (${response.status})`)
    return response.json()
  })
  const descriptor = files.gltf?.['1k']?.gltf
  if (!descriptor) throw new Error(`${asset.id} has no 1k glTF download`)
  const gltfBytes = await download(descriptor.url)
  const json = JSON.parse(gltfBytes.toString('utf8'))
  if (json.buffers?.length !== 1) throw new Error(`${asset.id} has ${json.buffers?.length ?? 0} buffers; expected one`)
  const includes = descriptor.include ?? {}
  const sourceFor = uri => includes[uri]?.url ?? new URL(uri, descriptor.url).href
  const sourceBin = await download(sourceFor(json.buffers[0].uri))
  const chunks = [pad4(sourceBin)]
  let offset = chunks[0].length
  for (const [index, image] of (json.images ?? []).entries()) {
    if (!image.uri) continue
    const original = await download(sourceFor(image.uri))
    const resized = await resizeJpeg(original, asset.size, directory, `${asset.id}-${index}`)
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: resized.length })
    image.bufferView = json.bufferViews.length - 1
    image.mimeType = 'image/jpeg'
    delete image.uri
    chunks.push(pad4(resized))
    offset += pad4(resized).length
  }
  json.buffers = [{ byteLength: offset }]
  const downloaded = descriptor.size + Object.values(includes).reduce((total, file) => total + file.size, 0)
  const data = writeGlb(json, Buffer.concat(chunks))
  return {
    name: asset.id,
    data,
    meta: {
      source: `https://polyhaven.com/a/${asset.id}`,
      licence: 'CC0-1.0',
      downloadBytes: downloaded,
      textureSize: asset.size,
      material: asset.material,
    },
  }
}

async function buildInteriorPacks() {
  const directory = await mkdtemp(join(tmpdir(), 'neighbourhood-interiors-'))
  try {
    const entries = []
    for (const asset of INTERIOR_ASSETS) entries.push({ asset, entry: await buildInteriorModel(asset, directory) })
    return [...new Set(INTERIOR_ASSETS.map(asset => asset.family))].map(family => {
      const familyEntries = entries.filter(candidate => candidate.asset.family === family).map(candidate => candidate.entry)
      return { file: `interior-${family}.pack.gz`, data: writePack(familyEntries), count: familyEntries.length, meta: familyEntries.map(entry => ({ name: entry.name, ...entry.meta })) }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function furnitureIndex(meta) {
  const assets = new Map(INTERIOR_ASSETS.map(asset => [asset.id, asset]))
  return meta.map(entry => {
    const alias = interiorAlias(entry.name)
    const asset = alias ? assets.get(alias) : undefined
    return asset ? {
      ...entry,
      asset: asset.id,
      pack: `/packs/interior-${asset.family}.pack.gz`,
      material: asset.material,
      height: interiorHeight(entry.name),
    } : {
      ...entry,
      generator: 'original-detail',
      // Preserve the exact legacy world-space height just as min/max preserve its footprint.
      height: +((entry.max[1] - entry.min[1]) * 2.2).toFixed(4),
    }
  })
}

async function buildCharacters() {
  const dir = join(SRC, 'kenney-mini-characters')
  const colormap = decodePng(await readFile(join(dir, 'colormap.png')))
  const names = (await readdir(dir)).filter(name => name.startsWith('character-') && name.endsWith('.glb')).sort()
  const entries = []
  for (const [position, file] of names.entries()) {
    const { json, bin } = parseGlb(await readFile(join(dir, file)))
    const { defaults, faceMount } = assignCharacterRoles(json, bin, colormap)
    stripCharacter(json, position === 0)
    entries.push({ name: file.replace('.glb', ''), data: writeGlb(json, bin), meta: { defaults, faceMount, rig: position === 0 } })
  }
  // Mobility and sensory aids keep their own small palette, baked to vertex-free flat colours at load.
  for (const file of (await readdir(dir)).filter(name => /^(aid|wheelchair)/.test(name) && name.endsWith('.glb')).sort()) {
    const { json, bin } = parseGlb(await readFile(join(dir, file)))
    // Aids are sampled from the shared colormap; ship the colormap swatches as vertex colours instead.
    for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
      const uv = readAccessor(json, bin, primitive.attributes.TEXCOORD_0)
      const rgb = uv.map(value => colormap.at(Math.min(511, Math.floor(value[0] * 512)), Math.min(511, Math.floor(value[1] * 512))))
      primitive.extras = { colors: rgb.map(hex) }
    }
    stripCharacter(json, false)
    entries.push({ name: file.replace('.glb', '').replace('_', '-'), data: writeGlb(json, bin), meta: { aid: true } })
  }
  return { file: 'characters.pack.gz', data: writePack(entries), count: entries.length, meta: entries.map(e => ({ name: e.name, ...e.meta })) }
}

async function buildFurniture() {
  const dir = join(SRC, 'kenney-furniture-kit')
  const names = (await readdir(dir)).filter(name => name.endsWith('.glb')).sort()
  const entries = []
  for (const file of names) {
    const { json, bin } = parseGlb(await readFile(join(dir, file)))
    // Child meshes can be rotated/scaled pillows and covers; raw accessor bounds are not room bounds.
    const bounds = new Box3()
    const visit = (index, parent) => {
      const node = json.nodes[index]
      const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
        new Vector3(...(node.translation || [0, 0, 0])),
        new Quaternion(...(node.rotation || [0, 0, 0, 1])),
        new Vector3(...(node.scale || [1, 1, 1])),
      )
      const world = parent.clone().multiply(local)
      if (node.mesh !== undefined) for (const primitive of json.meshes[node.mesh].primitives) {
        for (const position of readAccessor(json, bin, primitive.attributes.POSITION)) bounds.expandByPoint(new Vector3(...position).applyMatrix4(world))
      }
      for (const child of node.children || []) visit(child, world)
    }
    for (const node of json.scenes[json.scene || 0].nodes) visit(node, new Matrix4())
    const min = bounds.min.toArray(), max = bounds.max.toArray()
    entries.push({
      name: file.replace('.glb', ''), data: writeGlb(json, bin),
      meta: { materials: (json.materials || []).map(material => material.name), min: min.map(v => +v.toFixed(3)), max: max.map(v => +v.toFixed(3)) },
    })
  }
  return { file: 'furniture.pack.gz', data: writePack(entries), count: entries.length, meta: entries.map(e => ({ name: e.name, ...e.meta })) }
}

if (process.argv.includes('--furniture-index-only')) {
  const pack = await buildFurniture()
  await writeFile(join(ROOT, 'src', 'assets', 'furniture.index.json'), JSON.stringify(furnitureIndex(pack.meta), null, 1) + '\n')
  console.log(JSON.stringify({ furnitureIndex: pack.count }))
} else if (process.argv.includes('--interiors')) {
  await mkdir(OUT, { recursive: true })
  const report = {}
  for (const pack of await buildInteriorPacks()) {
    await writeFile(join(OUT, pack.file), pack.data)
    report[pack.file] = { bytes: pack.data.length, entries: pack.count, sources: pack.meta }
  }
  const furniture = await buildFurniture()
  await writeFile(join(ROOT, 'src', 'assets', 'furniture.index.json'), JSON.stringify(furnitureIndex(furniture.meta), null, 1) + '\n')
  console.log(JSON.stringify(report, null, 2))
} else {
  await mkdir(OUT, { recursive: true })
  const report = {}
  for (const pack of [await buildCharacters(), await buildFurniture(), ...await buildInteriorPacks()]) {
    await writeFile(join(OUT, pack.file), pack.data)
    report[pack.file] = { bytes: pack.data.length, entries: pack.count }
    const index = pack.file === 'furniture.pack.gz' ? furnitureIndex(pack.meta) : pack.meta
    await writeFile(join(ROOT, 'src', 'assets', pack.file.replace('.pack.gz', '.index.json')), JSON.stringify(index, null, 1) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
}
