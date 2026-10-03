// A local package gate. No upload occurs unless the caller explicitly selects deploy.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, openSync, closeSync, realpathSync, constants } from 'node:fs'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROAD = Object.freeze({ path: '/__world-data/yaba-vehicles.json', bytes: 23347699, sha256: '44cf0458af265d8ceb5ad84216dc722e0df6e289e29b0acfcaf92b78127919e2' })
const HEADERS = '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: no-cache\n\n/app-build.json\n  Cache-Control: no-store\n\n/playtest-config.json\n  Cache-Control: no-store\n\n/playtest-build.json\n  Cache-Control: no-store\n'
const STATIC = ['/*', '!/assets/*', '!/avatars/*', '!/packs/*', '!/regions/*', '!/wardrobe/*']
const PUBLIC_KEYS = ['origin', 'audience', 'siteId', 'packageId', 'channel', 'buildId', 'guestAdmission', 'endpoint']
const CONFIG_KEYS = ['$schema', 'name', 'account_id', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'durable_objects', 'migrations', 'observability', 'vars', 'assets', 'minify', 'send_metrics']
const VAR_KEYS = ['WORLD_BINDING', 'WORLD_GUEST_ADMISSION', 'WORLD_MAX_CONNECTIONS', 'WORLD_ACCOUNT', 'WORLD_LEGACY_ORIGIN', 'WORLD_IMPORT_MAX_BYTES']
const fail = code => { throw new Error(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const within = (root, path) => { const r = relative(root, path); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)) }

// Reject lexical escapes and every symlink ancestor before opening any input. Use
// canonical /private/tmp paths on macOS, because /tmp itself is a symlink.
function safePath(path, kind) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) fail('PATH_INVALID')
  if (path.split(sep).some(p => p === 'nw-private' || p === '.goalmatic' || /^\.env(?:\.|$)/.test(p))) fail('PRIVATE_PATH_REFUSED')
  let cursor = sep
  for (const part of path.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    let stat
    try { stat = lstatSync(cursor) } catch { fail('PATH_MISSING') }
    if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED')
  }
  const stat = lstatSync(path)
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('NONREGULAR_PATH')
  return path
}
function assetName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) fail('ASSET_PATH_INVALID')
  if (!/^(?:assets|avatars|packs|regions|wardrobe)\/[A-Za-z0-9_./-]+$/.test(name) && !['index.html', 'app-build.json', 'playtest-config.json', 'playtest-build.json', '_headers', '__world-data/yaba-vehicles.json', 'favicon.png', 'apple-touch-icon.png', 'robots.txt', 'sitemap.xml', 'social/allworld-og.png', 'social/NOTICE.md'].includes(name)) fail('UNREVIEWED_ASSET_PATH')
  return name
}
function inventory(root, prefix = '') {
  const files = []
  for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = prefix + e.name
    if (!(e.isDirectory() && (name === '__world-data' || name === 'social'))) assetName(e.isDirectory() ? name + '/placeholder' : name)
    if (e.isSymbolicLink()) fail('ASSET_SYMLINK_REFUSED')
    if (e.isDirectory()) files.push(...inventory(root, name + '/'))
    else if (e.isFile()) { safePath(join(root, name), 'file'); files.push(name) }
    else fail('ASSET_NONREGULAR_PATH')
  }
  return files.sort()
}
function bytes(path) {
  // O_NOFOLLOW also rejects a leaf replaced with a symlink after inventory.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return readFileSync(fd) } finally { closeSync(fd) }
}
function json(path, code) { try { return JSON.parse(bytes(path)) } catch { fail(code) } }
function publicConfig(value) {
  if (!object(value) || !same(Object.keys(value).sort(), PUBLIC_KEYS.slice().sort())) fail('PUBLIC_CONFIG_SHAPE')
  for (const key of PUBLIC_KEYS) if (typeof value[key] !== 'string' || !value[key] || value[key].length > 256 || /[\x00-\x20\x7f`\\]/.test(value[key])) fail('PUBLIC_CONFIG_FIELD')
  for (const key of ['origin', 'audience', 'endpoint']) {
    let url
    try { url = new URL(value[key]) } catch { fail('PUBLIC_CONFIG_ORIGIN') }
    if (url.protocol !== 'https:' || url.origin !== value[key] || url.username || url.password) fail('PUBLIC_CONFIG_ORIGIN')
  }
  if (value.endpoint !== value.origin || value.channel !== 'test' || value.guestAdmission !== 'public') fail('PUBLIC_CONFIG_CONTRACT')
  return value
}
function binding(raw) { try { return JSON.parse(raw) } catch { fail('BINDING_JSON') } }
export function verifyPackage(options, road = ROAD) {
  const root = safePath(options.package, 'directory')
  const configPath = options.config, artifact = options.artifact
  if (!within(root, configPath) || relative(root, configPath) !== 'wrangler.json' || !within(root, artifact) || relative(root, artifact) !== 'assets') fail('PACKAGE_PATH_MISMATCH')
  safePath(configPath, 'file'); safePath(artifact, 'directory')
  const actual = inventory(artifact) // All paths validated before any package file content is read.
  for (const name of ['playtest-build.json', 'playtest-config.json', 'app-build.json', 'index.html', '_headers', road.path.slice(1)]) if (!actual.includes(name)) fail(name === road.path.slice(1) ? 'ROAD_MISSING' : 'REQUIRED_ASSET_MISSING')
  if (bytes(join(artifact, '_headers')).toString() !== HEADERS) fail('HEADERS_MISMATCH')
  const initialConfigSha = hash(bytes(configPath))
  if (!/^[a-f0-9]{64}$/.test(options.configSha) || initialConfigSha !== options.configSha) fail('CONFIG_DIGEST_MISMATCH')
  const initialMetadataSha = hash(bytes(join(artifact, 'playtest-build.json')))
  const config = json(configPath, 'CONFIG_JSON')
  if (!object(config) || !same(Object.keys(config).sort(), CONFIG_KEYS.slice().sort())) fail('CONFIG_SHAPE')
  if (typeof config.main !== 'string' || !config.main.endsWith('/service/cloudflare/worker.ts')) fail('WORKER_ENTRY_PATH')
  safePath(config.main, 'file')
  if (!object(config.assets) || config.assets.directory !== './assets' || config.assets.binding !== 'ASSETS' || config.assets.not_found_handling !== 'none' || !same(config.assets.run_worker_first, STATIC) || !same(Object.keys(config.assets).sort(), ['directory', 'binding', 'run_worker_first', 'not_found_handling'].sort())) fail('STATIC_PROTECTION_MISMATCH')
  if (!object(config.vars) || !same(Object.keys(config.vars).sort(), VAR_KEYS.slice().sort())) fail('PUBLIC_VARS_SHAPE')
  const account = binding(config.vars.WORLD_ACCOUNT)
  if (!object(account) || !same(Object.keys(account).sort(), ['projectId', 'projectNumber']) || typeof account.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/.test(account.projectId) || !/^\d+$/.test(account.projectNumber) || !/^\d+$/.test(config.vars.WORLD_MAX_CONNECTIONS) || !/^\d+$/.test(config.vars.WORLD_IMPORT_MAX_BYTES)) fail('PUBLIC_VARS_FIELD')
  const metadata = json(join(artifact, 'playtest-build.json'), 'METADATA_JSON')
  if (!object(metadata) || metadata.schema !== 1 || !same(Object.keys(metadata).sort(), ['schema', 'config', 'assetRevision', 'routes', 'files', 'artifactSha256'].sort()) || !object(metadata.files) || !Array.isArray(metadata.routes) || !metadata.routes.includes('/')) fail('METADATA_SHAPE')
  const { artifactSha256, ...unsigned } = metadata
  if (!/^[a-f0-9]{64}$/.test(options.artifactSha) || artifactSha256 !== options.artifactSha || hash(JSON.stringify(unsigned)) !== artifactSha256) fail('ARTIFACT_DIGEST_MISMATCH')
  const pub = publicConfig(metadata.config)
  if (pub.buildId !== options.buildId || !same(json(join(artifact, 'playtest-config.json'), 'PUBLIC_CONFIG_JSON'), pub)) fail('BUILD_CONFIG_MISMATCH')
  const world = binding(config.vars.WORLD_BINDING)
  const legacyOrigin = options.legacyOrigin ?? pub.audience
  const legacyUrl = new URL(legacyOrigin)
  if (legacyUrl.protocol !== 'https:' || legacyUrl.origin !== legacyOrigin || legacyUrl.username || legacyUrl.password || legacyOrigin === pub.origin) fail('LEGACY_ORIGIN_INVALID')
  if (!object(world) || !same(Object.keys(world).sort(), [...PUBLIC_KEYS.filter(k => k !== 'endpoint'), 'artifactId'].sort()) || PUBLIC_KEYS.filter(k => k !== 'endpoint').some(k => world[k] !== pub[k]) || world.artifactId !== artifactSha256 || config.vars.WORLD_LEGACY_ORIGIN !== legacyOrigin) fail('BINDING_METADATA_MISMATCH')
  if (!same(binding(config.vars.WORLD_GUEST_ADMISSION), { kind: pub.guestAdmission })) fail('ADMISSION_MISMATCH')
  const app = json(join(artifact, 'app-build.json'), 'APP_BUILD_JSON')
  if (!object(app) || !/^[a-f0-9]{12}$/.test(app.id) || app.assets !== metadata.assetRevision || !/^[a-f0-9]{12}$/.test(metadata.assetRevision)) fail('ASSET_REVISION_MISMATCH')
  const declared = Object.keys(metadata.files)
  for (const name of declared) {
    assetName(name)
    const entry = metadata.files[name]
    if (!object(entry) || !same(Object.keys(entry).sort(), ['bytes', 'sha256', 'immutable'].sort()) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.immutable !== 'boolean') fail('MANIFEST_ENTRY_INVALID')
  }
  const complete = [...new Set([...declared, 'playtest-build.json', '_headers', road.path.slice(1)])].sort()
  if (!same(actual, complete)) fail('ASSET_MANIFEST_CLOSURE_MISMATCH')
  const roadBytes = bytes(join(artifact, road.path.slice(1)))
  if (roadBytes.length !== road.bytes) fail('ROAD_SIZE_MISMATCH')
  if (hash(roadBytes) !== road.sha256) fail('ROAD_HASH_MISMATCH')
  for (const name of declared) {
    const content = bytes(join(artifact, name)), entry = metadata.files[name]
    if (content.length !== entry.bytes || hash(content) !== entry.sha256) fail('ASSET_BYTES_MISMATCH')
  }
  const html = bytes(join(artifact, 'index.html')).toString()
  const script = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"?#]+\.js)"/)
  if (!script || !declared.includes(script[1].slice(1))) fail('ENTRY_MISSING')
  const entry = bytes(join(artifact, script[1].slice(1))).toString()
  // Reviewed135 emits quoted or template-literal config values. Check the entry's
  // actual public values without evaluating JavaScript or logging them.
  for (const key of PUBLIC_KEYS.filter(k => k !== 'origin')) {
    if (!entry.includes(`${key}:\`${pub[key]}\``) && !entry.includes(`${key}:${JSON.stringify(pub[key])}`)) fail('ENTRY_CONFIG_MISMATCH')
  }
  if (!entry.includes(`location.origin!==\`${pub.origin}\``) && !entry.includes(`location.origin!==${JSON.stringify(pub.origin)}`)) fail('ENTRY_ORIGIN_MISMATCH')
  const fileSnapshot = actual.map(name => { const content = bytes(join(artifact, name)); return { path: name, bytes: content.length, sha256: hash(content) } })
  if (!same(inventory(artifact), actual)) fail('PACKAGE_FILE_DRIFT')
  for (const file of fileSnapshot) {
    const expected = file.path === 'playtest-build.json' ? { sha256: initialMetadataSha } : file.path === '_headers' ? { sha256: hash(HEADERS), bytes: Buffer.byteLength(HEADERS) } : file.path === road.path.slice(1) ? road : metadata.files[file.path]
    if (file.sha256 !== expected.sha256 || expected.bytes !== undefined && file.bytes !== expected.bytes) fail('PACKAGE_FILE_DRIFT')
  }
  const configSha256 = hash(bytes(configPath))
  if (configSha256 !== initialConfigSha) fail('PACKAGE_CONFIG_DRIFT')
  const guardSha256 = hash(JSON.stringify({ configSha256, files: fileSnapshot }))
  return { status: 'PASS', files: actual.length, buildId: pub.buildId, artifactSha256, configSha256, guardSha256 }
}
function cli() {
  const args = process.argv.slice(2), mode = args.shift()
  if (!['check', 'deploy'].includes(mode) || args.length % 2) fail('USAGE')
  const opts = {}, names = { '--package': 'package', '--config': 'config', '--artifact': 'artifact', '--build-id': 'buildId', '--artifact-sha': 'artifactSha', '--config-sha': 'configSha', '--road-source': 'roadSource', '--deploy-executable': 'deployExecutable', '--legacy-origin': 'legacyOrigin' }
  while (args.length) { const key = names[args.shift()], value = args.shift(); if (!key || opts[key] !== undefined || !value) fail('USAGE'); opts[key] = value }
  if (['package', 'config', 'artifact', 'buildId', 'artifactSha', 'configSha', 'roadSource'].some(k => !opts[k])) fail('USAGE')
  if (mode === 'check' && opts.deployExecutable) fail('USAGE')
  if (mode === 'deploy' && !opts.deployExecutable) fail('USAGE')
  safePath(opts.roadSource, 'file')
  if (!opts.roadSource.endsWith('/service/cloudflare/roads.ts')) fail('ROAD_SOURCE_PATH')
  const source = bytes(opts.roadSource).toString()
  const block = source.match(/export const ROAD_ASSET = \{([\s\S]*?)\} as const/)
  if (!block || !block[1].includes(`path: '${ROAD.path}'`) || !block[1].includes(`bytes: ${ROAD.bytes},`) || !block[1].includes(`sha256: '${ROAD.sha256}'`)) fail('ROAD_AUTHORITY_CHANGED')
  const result = verifyPackage(opts)
  console.log(JSON.stringify(result))
  if (mode === 'deploy') {
    safePath(opts.deployExecutable, 'file')
    if (verifyPackage(opts).guardSha256 !== result.guardSha256) fail('PACKAGE_PREDEPLOY_DRIFT')
    // No caller-supplied flags can replace the checked config or assets directory.
    const child = spawnSync(opts.deployExecutable, ['deploy', '--config', opts.config], { cwd: opts.package, stdio: 'inherit', shell: false })
    if (child.error) fail('DEPLOY_EXEC_FAILED')
    process.exitCode = child.status ?? 1
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli() } catch (error) { console.error(`FAIL ${/^[A-Z_]+$/.test(error.message) ? error.message : 'CHECK_FAILED'}`); process.exitCode = 1 }
}
