// Builds src/assets/public-assets.index.json: the list of shipped game files the App may download
// and keep on a device, each with its size and the SHA-256 of its unpacked content. The loader
// (src/assets/assetStore.ts) refuses anything that does not match, so this must be run after any
// builder changes a pack.
//
//   node scripts/build-asset-manifest.mjs              write the manifest, print the summary
//   node scripts/build-asset-manifest.mjs --check      write nothing; exit non-zero when the manifest is
//                                                      stale, a file is unclassified, or a budget is broken
//   node scripts/build-asset-manifest.mjs --inventory  write nothing; print the inventory as Markdown
//
// Needs only Node. The output depends on file contents alone: no dates, no machine paths, sorted keys.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'public')
const OUT = join(ROOT, 'src', 'assets', 'public-assets.index.json')
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--inventory') ? 'inventory' : 'write'

// Budgets. PACK_LIMIT is the one in docs/PERFORMANCE.md. LIVE_LIMIT keeps the whole live set inside
// the device store's budget (LIMIT_BYTES in src/assets/publicAssets.ts, 48 MiB) with room to spare,
// so a member who has seen everything is never evicting files the game still uses.
const MIB = 1024 * 1024
const PACK_LIMIT = 15 * MIB
const LIVE_LIMIT = 40 * MIB

// Folders of work in progress that the App does not load. They are listed, never entered in the manifest.
const EXPERIMENTS = [{ prefix: 'cast/', why: 'foundry cast (docs/3d/CAST-FOUNDRY.md); no App code loads it' }]
// Packs still on disk that no App code loads.
const RETIRED = new Map([['packs/characters.pack.gz', 'the first, low-poly cast; replaced by avatars/*.pack.gz']])

/** What a pack is for, in the words the loading view uses. First match wins. */
const GROUPS = [
  [/^avatars\/clips-[fm]\.pack\.gz$/, 'movement'],
  [/^avatars\/[fm]\d\d\.pack\.gz$/, 'character'],
  [/^avatars\/hair\/[\w-]+\.pack\.gz$/, 'hair'],
  [/^avatars\/(hair-analysis|identity)\/[\w-]+\.pack\.gz$/, 'photo'],
  [/^wardrobe\/(meshes\/)?[\w-]+\.pack\.gz$/, 'clothes'],
  [/^packs\/(surfaces-[\w-]+|vegetation)\.pack\.gz$/, 'street'],
  [/^regions\/[\w-]+\.pack\.gz$/, 'street'],
  [/^packs\/(interior-[\w-]+|furniture)\.pack\.gz$/, 'room'],
]
const FORMATS = new Map([['NWPK', 'nwpk'], ['GNMW', 'gnmw']])

function walk(dir, out = []) {
  for (const entry of readdirSync(join(PUBLIC, dir), { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(path, out); else out.push(path)
  }
  return out
}

// ── What the App's source asks for ──
// Every quoted path under a public folder, with `${…}` read as "any one name". This cannot see a path
// assembled some other way, so it only reports; it does not decide what enters the manifest.
function references() {
  const found = []
  const scan = dir => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) scan(path)
      else if (/\.(ts|vue|js|json)$/.test(entry.name) && path !== 'src/assets/public-assets.index.json') read(path)
    }
  }
  const read = path => {
    const text = readFileSync(join(ROOT, path), 'utf8')
    for (const pattern of [/'(\/(?:avatars|cast|packs|regions|wardrobe)\/[^'\n]*)'/g, /"(\/(?:avatars|cast|packs|regions|wardrobe)\/[^"\n]*)"/g, /`(\/(?:avatars|cast|packs|regions|wardrobe)\/[^`\n]*)`/g]) {
      for (const match of text.matchAll(pattern)) {
        const literal = !match[1].includes('${')
        const source = match[1].split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')).join('[^/]*')
        found.push({ from: path, text: match[1], literal, test: new RegExp(`^${source}$`) })
      }
    }
  }
  for (const file of ['App.vue', 'main.ts']) if (existsSync(join(ROOT, file))) read(file)
  scan('src')
  return found
}

// ── Inventory ──

const refs = references()
const problems = []
const rows = []
for (const path of walk('').sort()) {
  const file = readFileSync(join(PUBLIC, path))
  const referenced = refs.some(ref => ref.test.test(`/${path}`))
  const experiment = EXPERIMENTS.find(entry => path.startsWith(entry.prefix))
  const row = { path, bytes: file.byteLength, referenced, kind: 'other', group: '', note: '' }
  if (experiment) { row.kind = 'experiment'; row.note = experiment.why; if (referenced) problems.push(`${path} is in an experiment folder but App source names it`) }
  else if (RETIRED.has(path)) { row.kind = 'retired'; row.note = RETIRED.get(path); if (referenced) problems.push(`${path} is marked retired but App source names it`) }
  else if (/\.(md|txt)$/.test(path)) row.kind = 'notice'
  else if (/\.json$/.test(path) || path === 'sitemap.xml') row.kind = 'record'
  else if (/\.(jpg|png)$/.test(path)) row.kind = 'image'
  else if (path.endsWith('.pack.gz')) {
    const group = GROUPS.find(([test]) => test.test(path))
    if (!group) { problems.push(`${path} is a pack with no group: add a rule to GROUPS`); rows.push(row); continue }
    const packed = file[0] === 0x1f && file[1] === 0x8b
    const content = packed ? gunzipSync(file) : file
    row.kind = 'pack'
    row.group = group[1]
    row.unpacked = content.byteLength
    row.sha256 = createHash('sha256').update(content).digest('hex')
    row.format = FORMATS.get(content.subarray(0, 4).toString('latin1')) ?? 'raw'
    if (file.byteLength > PACK_LIMIT) problems.push(`${path} is ${(file.byteLength / MIB).toFixed(1)} MiB; the limit for one pack is ${PACK_LIMIT / MIB} MiB`)
    if (!referenced) row.note = 'no App source names it'
  } else problems.push(`${path} is not classified: say what it is in scripts/build-asset-manifest.mjs`)
  rows.push(row)
}
for (const ref of refs) if (ref.literal && !existsSync(join(PUBLIC, ref.text.slice(1)))) problems.push(`${ref.from} names ${ref.text}, which is not in public/`)

const packs = rows.filter(row => row.kind === 'pack')
const live = packs.reduce((sum, row) => sum + row.bytes, 0)
if (live > LIVE_LIMIT) problems.push(`the live packs total ${(live / MIB).toFixed(1)} MiB; the device store is sized for ${LIVE_LIMIT / MIB} MiB`)

const assets = Object.fromEntries(packs.map(row => [`/${row.path}`, { bytes: row.bytes, unpacked: row.unpacked, sha256: row.sha256, format: row.format, group: row.group }]))
// One short name for the whole set, so a build can be told from another at a glance.
const revision = createHash('sha256').update(packs.map(row => `${row.path} ${row.sha256}\n`).join('')).digest('hex').slice(0, 12)
const manifest = `${JSON.stringify({ schema: 1, revision, assets }, null, 1)}\n`

// ── Output ──

const mb = bytes => `${(bytes / 1e6).toFixed(2)} MB`
const sum = list => list.reduce((total, row) => total + row.bytes, 0)
const KINDS = [
  ['pack', 'Live packs: in the manifest, kept on the device'],
  ['image', 'Pictures: shown by the browser, kept by its own cache'],
  ['notice', 'Licences and notices: shipped beside the assets, never loaded'],
  ['record', 'Build records: never loaded'],
  ['retired', 'Retired packs: nothing loads them'],
  ['experiment', 'Experiments: nothing loads them'],
]
const GROUP_ORDER = ['character', 'movement', 'hair', 'clothes', 'street', 'room', 'photo']

function summary() {
  const lines = [`public/ holds ${rows.length} files, ${mb(sum(rows))}. Asset set ${revision}.`]
  for (const [kind, title] of KINDS) { const list = rows.filter(row => row.kind === kind); lines.push(`  ${String(list.length).padStart(4)}  ${mb(sum(list)).padStart(9)}  ${title}`) }
  for (const group of GROUP_ORDER) { const list = packs.filter(row => row.group === group); lines.push(`        ${group.padEnd(10)} ${String(list.length).padStart(3)} packs  ${mb(sum(list)).padStart(9)}  largest ${mb(Math.max(...list.map(row => row.bytes)))}`) }
  return lines.join('\n')
}

function inventory() {
  const out = [`Asset set \`${revision}\`. ${rows.length} files, ${mb(sum(rows))} under \`public/\`.`, '', '| Kind | Files | Size | Loaded by the App |', '| --- | ---: | ---: | --- |']
  for (const [kind, title] of KINDS) { const list = rows.filter(row => row.kind === kind); out.push(`| ${title.split(':')[0]} | ${list.length} | ${mb(sum(list))} | ${title.split(': ')[1]} |`) }
  out.push('', '| Live packs | Packs | On the wire | Unpacked | Largest |', '| --- | ---: | ---: | ---: | ---: |')
  for (const group of GROUP_ORDER) { const list = packs.filter(row => row.group === group); out.push(`| ${group} | ${list.length} | ${mb(sum(list))} | ${mb(list.reduce((total, row) => total + row.unpacked, 0))} | ${mb(Math.max(...list.map(row => row.bytes)))} |`) }
  out.push(`| all | ${packs.length} | ${mb(live)} | ${mb(packs.reduce((total, row) => total + row.unpacked, 0))} | ${mb(Math.max(...packs.map(row => row.bytes)))} |`)
  out.push('', '| Pack | On the wire | Unpacked | Group |', '| --- | ---: | ---: | --- |')
  for (const row of packs) out.push(`| \`${row.path}\` | ${mb(row.bytes)} | ${mb(row.unpacked)} | ${row.group}${row.note ? ` · ${row.note}` : ''} |`)
  return out.join('\n')
}

if (mode === 'inventory') console.log(inventory())
else console.log(summary())
for (const row of packs.filter(entry => entry.note)) console.log(`NOTE  ${row.path}: ${row.note}`)

if (mode === 'write') {
  if (problems.length === 0) { writeFileSync(OUT, manifest); console.log(`Wrote src/assets/public-assets.index.json (${packs.length} packs).`) }
} else if (mode === 'check') {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== manifest) problems.push('src/assets/public-assets.index.json is out of date: run node scripts/build-asset-manifest.mjs')
  else console.log('PASS  the manifest matches public/')
}
for (const problem of problems) console.log(`FAIL  ${problem}`)
process.exit(problems.length ? 1 : 0)
