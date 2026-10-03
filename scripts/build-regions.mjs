// Builds original, texture-free regional street models into the NWPK container used by src/world/packs.ts.
import { mkdir, writeFile } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { REGION_MODELS, validateModel } from './regions/models.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'regions')
const SOURCE = 'scripts/regions/models.mjs'
const LICENCE = 'CC0-1.0'
const LICENCE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/legalcode'

globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(buffer => {
      this.result = buffer
      this.onloadend?.()
    }, error => this.onerror?.(error))
  }
}

function writePack(entries) {
  let offset = 0
  const index = entries.map(entry => {
    const item = { name: entry.name, offset, length: entry.data.length, meta: entry.meta }
    offset += entry.data.length
    return item
  })
  const indexBytes = Buffer.from(JSON.stringify({ version: 1, entries: index }), 'utf8')
  const header = Buffer.alloc(8)
  header.write('NWPK', 0, 'ascii')
  header.writeUInt32LE(indexBytes.length, 4)
  return gzipSync(Buffer.concat([header, indexBytes, ...entries.map(entry => entry.data)]), { level: 9 })
}

async function exportGlb(object) {
  const result = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(object, resolve, reject, {
      binary: true,
      onlyVisible: false,
      truncateDrawRange: true,
    })
  })
  return Buffer.from(result)
}

function inspectPack(compressed, expected) {
  const bytes = gunzipSync(compressed)
  if (bytes.subarray(0, 4).toString('ascii') !== 'NWPK') throw new Error('Pack has no NWPK header')
  const indexLength = bytes.readUInt32LE(4)
  const index = JSON.parse(bytes.subarray(8, 8 + indexLength).toString('utf8'))
  if (index.entries.length !== expected) throw new Error(`Pack has ${index.entries.length} entries; expected ${expected}`)
  const base = 8 + indexLength
  for (const entry of index.entries) {
    if (bytes.readUInt32LE(base + entry.offset) !== 0x46546c67) throw new Error(`${entry.name} is not a GLB`)
    if (entry.offset + entry.length > bytes.length - base) throw new Error(`${entry.name} overruns its pack`)
  }
  return index
}

async function buildRegion(region, definitions) {
  const entries = []
  for (const [name, type, create] of definitions) {
    const object = create()
    const stats = validateModel(object, name)
    const data = await exportGlb(object)
    entries.push({
      name,
      data,
      meta: { type, ...stats, source: SOURCE, licence: LICENCE },
    })
    object.traverse(child => {
      child.geometry?.dispose()
      child.material?.dispose()
    })
  }
  const data = writePack(entries)
  inspectPack(data, entries.length)
  const file = `${region}.pack.gz`
  await writeFile(join(OUT, file), data)
  return {
    region,
    url: `/regions/${file}`,
    bytes: data.length,
    uncompressedGlbBytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
    entries: entries.map(entry => ({ name: entry.name, ...entry.meta, glbBytes: entry.data.length })),
  }
}

await mkdir(OUT, { recursive: true })
const packs = []
for (const [region, definitions] of Object.entries(REGION_MODELS)) packs.push(await buildRegion(region, definitions))

const manifest = {
  format: 'NWPK',
  version: 1,
  units: 'metres',
  ground: 'y=0',
  forward: '+Z',
  licence: LICENCE,
  licenceUrl: LICENCE_URL,
  source: SOURCE,
  packs,
}
await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const licence = `# Regional asset pack licence

All geometry, vertex colours, generic sign lettering, pack metadata, and build code in these regional asset packs were authored for this project and are dedicated to the public domain under CC0 1.0.

Legal text: ${LICENCE_URL}

Original source paths:

- \`scripts/regions/models.mjs\`
- \`scripts/build-regions.mjs\`

Generated files:

- \`public/regions/nigeria.pack.gz\`
- \`public/regions/manchester.pack.gz\`
- \`public/regions/manifest.json\`

No external models, textures, logos, fonts, or downloaded artwork are included. The signs use generic category words built from original box geometry.

The runtime paving pattern in \`src/world/regions/index.ts\` and synthesized sounds in \`src/world/ambience.ts\` are original CC0 assets. No field recording, voice, or third-party music is embedded.
`
await writeFile(join(OUT, 'LICENSE.md'), licence)

console.log(JSON.stringify(manifest, null, 2))
