// Architecture verification: checks the dependency rules and documented paths that
// docs/ARCHITECTURE.md and docs/CONTRIBUTOR-MAP.md state. It reads file names and import lines
// only, and prints rule names, counts and paths — never file contents.
// Run: node scripts/check-structure.mjs
// Prints one PASS/DEBT/FAIL line per rule, then the zone-to-zone import table. Exits non-zero when
// a rule is broken or a recorded debt no longer exists (remove it below).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rel = path => relative(root, path).split(sep).join('/')
const exists = path => existsSync(join(root, path))
const read = path => readFileSync(join(root, path), 'utf8')

// ── Files ──

const CODE = new Set(['.ts', '.vue', '.mjs', '.js'])
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', '.git'])

function walk(dir, keep, out = []) {
  if (!exists(dir)) return out
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(path, keep, out) }
    else if (keep(path)) out.push(path)
  }
  return out
}

const isCode = path => CODE.has(extname(path))
const sources = [...['main.ts', 'App.vue', 'vite.config.mjs'].filter(exists), ...walk('src', isCode), ...walk('service', isCode), ...walk('scripts', isCode)].sort()

// ── Zones: the folders docs/ARCHITECTURE.md names ──

function zoneOf(path) {
  if (path === 'main.ts' || path === 'App.vue') return 'shell'
  if (path === 'src/brand.ts' || path.startsWith('src/shared/')) return 'contract'
  if (path.startsWith('src/features/')) return `feature:${path.split('/')[2]}`
  if (path.startsWith('src/')) return path.split('/')[1]
  if (path.startsWith('service/')) return 'service'
  if (path.startsWith('scripts/')) return 'scripts'
  return 'tooling'
}
const isApp = zone => zone !== 'service' && zone !== 'scripts' && zone !== 'tooling'

// ── Imports ──

const PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/g,
  /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bnew\s+URL\(\s*['"](\.[^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
]
const builtins = new Set(builtinModules)
const RESOLVE_AS = ['', '.ts', '.mjs', '.js', '.vue', '/index.ts']

/** A commented-out line can still look like an import; blank those lines and keep the numbering. */
const withoutCommentLines = text => text.split('\n').map(line => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line)).join('\n')

function importsOf(path) {
  const text = withoutCommentLines(read(path))
  const found = []
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      const line = text.slice(0, match.index).split('\n').length
      if (spec.startsWith('.')) {
        // `new URL('../', import.meta.url)` names a folder to read from, not a module.
        if (spec.endsWith('/')) continue
        const base = posix.normalize(posix.join(posix.dirname(path), spec.replace(/[?#].*$/, '')))
        const hit = RESOLVE_AS.map(suffix => base + suffix).find(candidate => exists(candidate) && statSync(join(root, candidate)).isFile())
        found.push({ from: path, line, spec, to: hit ?? base, resolved: Boolean(hit), zone: hit ? zoneOf(hit) : 'unresolved' })
      } else if (spec.startsWith('node:') || builtins.has(spec)) {
        found.push({ from: path, line, spec, to: null, resolved: true, zone: 'node' })
      } else if (!/^(https?:|data:|\/)/.test(spec)) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        found.push({ from: path, line, spec, to: null, resolved: true, zone: `pkg:${name}` })
      }
    }
  }
  return found
}

const imports = sources.flatMap(importsOf)
const at = edge => `${edge.from}:${edge.line} → ${edge.to ?? edge.spec}`

// ── Recorded debt ──
// Couplings that exist today and break a rule. They are listed so the rule can still hold for
// everything else. An entry here is work to do, not permission: adding one needs the same review as
// the code that causes it, and the check fails once an entry stops matching so it gets deleted.
const DEBT = []
// Asset folders shipped without a notice beside them. Same terms as above: work to do.
const NOTICE_DEBT = []
const usedDebt = new Set()
function owed(rule, edge) {
  const index = DEBT.findIndex(entry => entry.rule === rule && entry.from === edge.from && entry.to === edge.to)
  if (index === -1) return false
  usedDebt.add(index)
  return true
}

// ── Reporting ──

let failed = 0
function report(rule, checked, broken, describe = String) {
  if (broken.length === 0) { console.log(`PASS  ${rule} — ${checked}`); return }
  failed++
  console.log(`FAIL  ${rule} — ${broken.length} broken, ${checked}`)
  for (const item of broken) console.log(`        ${describe(item)}`)
}

function importRule(rule, inScope, allowed, what) {
  const scoped = imports.filter(edge => inScope(zoneOf(edge.from), edge))
  const broken = scoped.filter(edge => !allowed(edge) && !owed(rule, edge))
  const files = new Set(scoped.map(edge => edge.from)).size
  report(rule, `${scoped.length} imports in ${files} files; ${what}`, broken, at)
}

// ── Rules ──

// 1. The contract (src/shared and src/brand.ts) is plain TypeScript both sides can run: no Vue,
//    no three.js, no Node built-ins, no packages, nothing from the App or the service.
importRule('contract-is-pure', zone => zone === 'contract', edge => edge.zone === 'contract', 'src/shared and src/brand.ts import only each other')

// 2. The service knows the contract and nothing else of the App: no windows, no scene, no Vue.
//    It may read a generated catalogue (src/assets/*.index.json): data both sides validate against.
const SERVICE_PACKAGES = new Set(['pkg:ws', 'pkg:tz-lookup'])
const isCloudflareAdapter = edge => edge.from === 'service/cloudflare/worker.ts' && edge.spec === 'cloudflare:workers'
const isCatalogue = edge => /^src\/assets\/[\w.-]+\.index\.json$/.test(edge.to ?? '')
importRule('service-imports-contract-only', zone => zone === 'service', edge => edge.zone === 'service' || edge.zone === 'contract' || edge.zone === 'node' || SERVICE_PACKAGES.has(edge.zone) || isCatalogue(edge) || isCloudflareAdapter(edge), 'service/ imports service/, the contract, generated catalogues, Node and ws/tz-lookup; only the Cloudflare worker adapter imports cloudflare:workers')

// 3. The App is browser code: it never reaches into the service or the scripts, and never needs Node.
importRule('app-never-imports-server', zone => isApp(zone), edge => !['service', 'scripts', 'tooling', 'node', 'pkg:ws'].includes(edge.zone), 'App code imports no service/, scripts/ or Node built-ins')

// 4. The engine sits below the windows: scene, map data, config and platform code never import a feature window.
const BELOW_WINDOWS = new Set(['world', 'geo', 'config', 'platform', 'assets'])
importRule('engine-below-windows', zone => BELOW_WINDOWS.has(zone), edge => !edge.zone.startsWith('feature:') && edge.zone !== 'shell', 'src/world, src/geo, src/config and src/platform import no feature window')

// 5. Map data and platform adapters stay free of Vue, so they can be probed from Node scripts.
importRule('geo-is-framework-free', zone => zone === 'geo', edge => !['pkg:vue', 'pkg:vue-router', 'pkg:three'].includes(edge.zone), 'src/geo imports no Vue or three.js')

// 6. Every relative import points at a file that exists (vue-tsc does not read the .mjs scripts).
report('relative-imports-resolve', `${imports.filter(edge => edge.spec.startsWith('.')).length} relative imports in ${sources.length} files`, imports.filter(edge => !edge.resolved), at)

// 7. Nothing in the App, the service, the shipped assets or the probes names a developer's home
//    folder. The authoring and browser-evidence scripts in HOME_PATH_DEBT still do, so they run on
//    one machine only; that is counted below as debt and nothing new may join it.
const HOME_PATH_DEBT = []
let homePathDebt = 0
{
  const texty = path => /\.(ts|vue|mjs|js|json|md|html|css|py|sh|txt)$/.test(path)
  const scanned = [...new Set([...sources, ...walk('scripts', texty), ...walk('public', texty), ...['index.html', 'package.json', 'tsconfig.json', 'env.d.ts', '.goalmatic/app.json'].filter(exists)])]
  const self = 'scripts/check-structure.mjs'
  const named = scanned.filter(path => path !== self && /\/(Users|home)\/[A-Za-z0-9._-]+\//.test(read(path)))
  homePathDebt = named.filter(path => HOME_PATH_DEBT.some(dir => path.startsWith(dir))).length
  report('no-home-folder-paths', `${scanned.length} source, script and public text files`, named.filter(path => !HOME_PATH_DEBT.some(dir => path.startsWith(dir))))
}

// 8. The contributor documents only name paths that exist.
const GUIDES = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md', 'docs/ARCHITECTURE.md', 'docs/CONTRIBUTOR-MAP.md', ...walk('src', path => path.endsWith('/README.md')), ...['service/README.md', 'scripts/README.md', 'public/README.md'].filter(exists)].filter(exists)
{
  const ROOTS = /^(src|service|scripts|docs|public|assets-src|\.github)\//
  const ROOT_FILES = new Set(['main.ts', 'App.vue', 'index.html', 'env.d.ts', 'vite.config.mjs', 'package.json', 'tsconfig.json', 'README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md', '.gitignore', '.goalmaticignore', '.goalmatic/app.json'])
  let named = 0
  const broken = []
  for (const guide of GUIDES) {
    const text = read(guide)
    const tokens = [...text.matchAll(/`([^`\n]+)`/g)].map(match => ({ raw: match[1], base: '' }))
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) if (!/^(https?:|mailto:|#)/.test(match[1])) tokens.push({ raw: match[1], base: posix.dirname(guide) })
    for (const { raw, base } of tokens) {
      // `src/world/engine.ts:33` and `src/shared/…` both name a path; commands and code do not.
      let path = raw.replace(/[#?].*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/\/$/, '')
      if (!path || /\s|[<>{}|=…]/.test(path)) continue
      if (base !== '') path = posix.normalize(posix.join(base, path))
      // A folder's own README names its files without the folder: `kernel.ts`, `arena/`.
      const folder = posix.dirname(guide)
      const ownFile = /^[\w*-][\w./*-]*\.(ts|vue|mjs|js|json)$/.test(path), ownFolder = /^[\w-]+\/$/.test(raw) && !exists(path)
      if (base === '' && folder !== '.' && folder !== 'docs' && !ROOTS.test(path) && (ownFile || ownFolder)) path = `${folder}/${path}`
      if (!ROOTS.test(path) && !ROOT_FILES.has(path)) continue
      const star = path.indexOf('*')
      if (star !== -1) path = path.slice(0, path.lastIndexOf('/', star))
      named++
      if (!exists(path)) broken.push(`${guide} names ${raw}`)
    }
  }
  report('documented-paths-exist', `${named} paths named in ${GUIDES.length} contributor documents`, broken)
}

// 9. Every evidence probe is findable: scripts/verify-*.ts appears in the contributor map, and every
//    file an npm script runs exists.
{
  const probes = walk('scripts', path => /^scripts\/verify-[\w-]+\.ts$/.test(path))
  const map = exists('docs/CONTRIBUTOR-MAP.md') ? read('docs/CONTRIBUTOR-MAP.md') : ''
  const broken = probes.filter(path => !map.includes(path)).map(path => `${path} is not in docs/CONTRIBUTOR-MAP.md`)
  const scripts = Object.entries(JSON.parse(read('package.json')).scripts ?? {})
  for (const [name, command] of scripts) for (const match of String(command).matchAll(/\b((?:scripts|service)\/[\w./-]+\.(?:ts|mjs))\b/g)) if (!exists(match[1])) broken.push(`npm run ${name} runs ${match[1]}, which does not exist`)
  report('probes-are-findable', `${probes.length} probes, ${scripts.length} npm scripts`, broken)
}

// 10. Each folder of shipped third-party or generated assets carries its notice beside the files.
{
  const folders = exists('public') ? readdirSync(join(root, 'public'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `public/${entry.name}`) : []
  const hasNotice = folder => readdirSync(join(root, folder)).some(name => /^(LICEN[CS]ES?|NOTICE)(\.md|\.txt)?$/i.test(name))
  report('asset-folders-carry-notices', `${folders.length} folders under public/`, folders.filter(folder => !hasNotice(folder) && !NOTICE_DEBT.includes(folder)).map(folder => `${folder} has no LICENSE/NOTICE file beside its assets`))
  for (const folder of NOTICE_DEBT) {
    if (exists(folder) && !hasNotice(folder)) { console.log(`DEBT  asset-folders-carry-notices — ${folder} has no LICENSE/NOTICE file: list each pack's source and terms (docs/OPEN-SOURCE-TAKEOVER.md, licence gaps)`); continue }
    failed++
    console.log(`FAIL  asset-folders-carry-notices — recorded debt no longer exists, delete ${folder} from NOTICE_DEBT`)
  }
}

// 11. Local state, caches, build output and unreviewed evidence are ignored before a repository exists.
{
  const REQUIRED = ['node_modules/', 'dist/', '.env', '.env.*', '.goalmatic/local/', '__pycache__/', '*.pyc', '.DS_Store', 'docs/3d/evidence/', 'docs/evidence/', 'docs/playtest/round-*/']
  const lines = new Set(exists('.gitignore') ? read('.gitignore').split('\n').map(line => line.trim()) : [])
  report('local-state-is-ignored', `${REQUIRED.length} required ignore patterns`, REQUIRED.filter(pattern => !lines.has(pattern)).map(pattern => `.gitignore does not list ${pattern}`))
}

// ── Debt and graph ──

DEBT.forEach((entry, index) => {
  if (usedDebt.has(index)) { console.log(`DEBT  ${entry.rule} — ${entry.from} → ${entry.to}: ${entry.fix}`); return }
  failed++
  console.log(`FAIL  ${entry.rule} — recorded debt no longer exists, delete it from DEBT: ${entry.from} → ${entry.to}`)
})

if (homePathDebt > 0) console.log(`DEBT  no-home-folder-paths — ${homePathDebt} files under ${HOME_PATH_DEBT.join(', ')} name a home folder: take the project root from import.meta.url and outputs from an argument`)
else if (HOME_PATH_DEBT.length) { failed++; console.log('FAIL  no-home-folder-paths — recorded debt no longer exists, empty HOME_PATH_DEBT') }

// The table is for reading, not a rule: scripts are left out because probes may import anything.
const edges = new Map()
for (const edge of imports) {
  const from = zoneOf(edge.from)
  if (from === edge.zone || from === 'scripts' || from === 'tooling' || edge.zone === 'node' || edge.zone === 'unresolved') continue
  const key = `${from} → ${edge.zone}`
  edges.set(key, (edges.get(key) ?? 0) + 1)
}
console.log('\nImports between zones (import statements; same-zone, scripts and Node built-ins left out)')
for (const [key, count] of [...edges].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${String(count).padStart(4)}  ${key}`)

console.log(`\n${sources.length} files, ${imports.length} imports, ${DEBT.length + NOTICE_DEBT.length + (homePathDebt > 0 ? 1 : 0)} recorded debts, ${failed} failing rules`)
process.exit(failed ? 1 : 0)
