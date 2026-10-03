// Assembles the complete Worker deployment package that scripts/guard-release-package.mjs checks:
// the frontend build, the internal road data, _headers and wrangler.json. It deploys nothing, reads
// no environment file and calls no provider. Settings are public values taken from the environment;
// secrets are never read here.
//
//   node scripts/assemble-release-package.mjs --out /fresh/package --synthetic
//   ALLWORLD_ORIGIN=… node scripts/assemble-release-package.mjs --out /fresh/package [--github-output "$GITHUB_OUTPUT"]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(message) }

// The reviewed _headers text. The guard compares it byte for byte, so drift fails closed there.
const HEADERS = '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: no-cache\n\n/app-build.json\n  Cache-Control: no-store\n\n/playtest-config.json\n  Cache-Control: no-store\n\n/playtest-build.json\n  Cache-Control: no-store\n'
const STATIC = ['/*', '!/assets/*', '!/avatars/*', '!/packs/*', '!/regions/*', '!/wardrobe/*']

// Reserved .invalid hosts never resolve. A package built from them can pass the gate and never deploy.
const SYNTHETIC = Object.freeze({
  ALLWORLD_ORIGIN: 'https://allworld-ci.invalid', ALLWORLD_AUDIENCE: 'https://allworld-ci-legacy.invalid', ALLWORLD_SITE_ID: 'ci-site', ALLWORLD_PACKAGE_ID: 'ci-package',
  ALLWORLD_BUILD_ID: 'ci-synthetic', ALLWORLD_WORKER_NAME: 'allworld-ci', ALLWORLD_CF_ACCOUNT_ID: '0'.repeat(32), ALLWORLD_FIREBASE_PROJECT_ID: 'allworld-ci', ALLWORLD_FIREBASE_PROJECT_NUMBER: '1',
})
const REQUIRED = Object.keys(SYNTHETIC)

const exactOrigin = (name, value) => {
  let url
  try { url = new URL(value) } catch { fail(`${name} must be an exact HTTPS origin.`) }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail(`${name} must be an exact HTTPS origin.`)
  return value
}
const pattern = (name, value, expression) => { if (typeof value !== 'string' || !expression.test(value)) fail(`${name} is missing or malformed.`); return value }

/** Validates the public settings. `env` is any object, so a probe can pass its own. */
export function releaseSettings(env, synthetic = false) {
  const source = synthetic ? { ...SYNTHETIC, ...Object.fromEntries(['ALLWORLD_BUILD_ID'].filter(k => env[k]).map(k => [k, env[k]])) } : env
  const missing = REQUIRED.filter(name => !source[name])
  if (missing.length) fail(`Missing settings: ${missing.join(', ')}.`)
  const origin = exactOrigin('ALLWORLD_ORIGIN', source.ALLWORLD_ORIGIN)
  const audience = exactOrigin('ALLWORLD_AUDIENCE', source.ALLWORLD_AUDIENCE)
  const legacyOrigin = exactOrigin('ALLWORLD_LEGACY_ORIGIN', source.ALLWORLD_LEGACY_ORIGIN || audience)
  if (legacyOrigin === origin) fail('The legacy origin must differ from the serving origin.')
  if (!synthetic && [origin, audience, legacyOrigin].some(value => new URL(value).hostname.endsWith('.invalid'))) fail('A real release cannot use a reserved .invalid host.')
  const settings = {
    origin, audience, legacyOrigin,
    siteId: pattern('ALLWORLD_SITE_ID', source.ALLWORLD_SITE_ID, /^[A-Za-z0-9._-]{1,128}$/),
    packageId: pattern('ALLWORLD_PACKAGE_ID', source.ALLWORLD_PACKAGE_ID, /^[A-Za-z0-9._-]{1,128}$/),
    buildId: pattern('ALLWORLD_BUILD_ID', source.ALLWORLD_BUILD_ID, /^[A-Za-z0-9._-]{3,64}$/),
    workerName: pattern('ALLWORLD_WORKER_NAME', source.ALLWORLD_WORKER_NAME, /^[a-z0-9][a-z0-9-]{0,62}$/),
    accountId: pattern('ALLWORLD_CF_ACCOUNT_ID', source.ALLWORLD_CF_ACCOUNT_ID, /^[a-f0-9]{32}$/),
    firebaseProjectId: pattern('ALLWORLD_FIREBASE_PROJECT_ID', source.ALLWORLD_FIREBASE_PROJECT_ID, /^[a-z][a-z0-9-]{4,62}$/),
    firebaseProjectNumber: pattern('ALLWORLD_FIREBASE_PROJECT_NUMBER', source.ALLWORLD_FIREBASE_PROJECT_NUMBER, /^\d{1,20}$/),
    maxConnections: pattern('ALLWORLD_MAX_CONNECTIONS', source.ALLWORLD_MAX_CONNECTIONS || '4', /^[1-9]\d{0,2}$/),
    importMaxBytes: pattern('ALLWORLD_IMPORT_MAX_BYTES', source.ALLWORLD_IMPORT_MAX_BYTES || '65536', /^[1-9]\d{0,9}$/),
    migrationTag: pattern('ALLWORLD_DO_MIGRATION_TAG', source.ALLWORLD_DO_MIGRATION_TAG || 'v1', /^[A-Za-z0-9._-]{1,32}$/),
  }
  return settings
}

/** The public config the frontend builder embeds. Key set and values are exactly what the guard expects. */
export function publicConfig(settings) {
  return { origin: settings.origin, audience: settings.audience, siteId: settings.siteId, packageId: settings.packageId, channel: 'test', buildId: settings.buildId, guestAdmission: 'public', endpoint: settings.origin }
}

/** wrangler.json with only the keys the guard accepts. `main` is absolute because the guard requires it. */
export function wranglerConfig(settings, artifactSha256, root) {
  const { endpoint: _endpoint, ...shared } = publicConfig(settings)
  const binding = { ...shared, artifactId: artifactSha256 }
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: settings.workerName,
    account_id: settings.accountId,
    main: join(root, 'service/cloudflare/worker.ts'),
    compatibility_date: '2026-10-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    preview_urls: false,
    durable_objects: { bindings: [{ name: 'WORLD', class_name: 'WorldDurableObject' }] },
    migrations: [{ tag: settings.migrationTag, new_sqlite_classes: ['WorldDurableObject'] }],
    observability: { enabled: false },
    minify: true,
    send_metrics: false,
    assets: { directory: './assets', binding: 'ASSETS', run_worker_first: STATIC, not_found_handling: 'none' },
    vars: {
      WORLD_BINDING: JSON.stringify(binding),
      WORLD_GUEST_ADMISSION: '{"kind":"public"}',
      WORLD_MAX_CONNECTIONS: settings.maxConnections,
      WORLD_ACCOUNT: JSON.stringify({ projectId: settings.firebaseProjectId, projectNumber: settings.firebaseProjectNumber }),
      WORLD_LEGACY_ORIGIN: settings.legacyOrigin,
      WORLD_IMPORT_MAX_BYTES: settings.importMaxBytes,
    },
  }
}

/** The reviewed road constants as declared by the Worker source, so a road change cannot be missed here. */
export function reviewedRoad(root) {
  const block = readFileSync(join(root, 'service/cloudflare/roads.ts'), 'utf8').match(/export const ROAD_ASSET = \{([\s\S]*?)\} as const/)
  const bytes = block?.[1].match(/bytes: (\d+),/)?.[1], sha256 = block?.[1].match(/sha256: '([a-f0-9]{64})'/)?.[1]
  if (!bytes || !sha256) fail('ROAD_ASSET is not declared in service/cloudflare/roads.ts.')
  return { bytes: Number(bytes), sha256 }
}

const absent = path => { try { lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return true; throw error } return false }

export function assemble({ out, settings, root = realpathSync(join(here, '..')), build = (output, config) => spawnSync(process.execPath, [join(root, 'scripts/build-private-playtest.mjs'), '--out', output, '--config', config], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], shell: false }) }) {
  if (typeof out !== 'string' || !isAbsolute(out) || resolve(out) !== out) fail('--out must be an absolute, normalized path.')
  if (realpathSync(dirname(out)) !== dirname(out)) fail('--out needs an existing parent with no symlink ancestors.')
  const outside = relative(root, out)
  if (outside === '' || (!outside.startsWith('..') && !isAbsolute(outside))) fail('--out must be outside the source tree.')
  if (!absent(out)) fail('--out already exists. Use a fresh path.')
  const road = reviewedRoad(root), source = join(root, 'service/data/transport/yaba-vehicles.json')
  const roadBytes = readFileSync(source)
  if (roadBytes.length !== road.bytes || hash(roadBytes) !== road.sha256) fail('The shipped road data differs from the reviewed ROAD_ASSET.')
  mkdirSync(out) // Exclusive: never adopts an existing directory.
  const config = publicConfig(settings), assets = join(out, 'assets')
  writeFileSync(join(out, 'public-config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' })
  const run = build(assets, join(out, 'public-config.json'))
  if (run.status !== 0) fail('The frontend build failed.')
  mkdirSync(join(assets, '__world-data'))
  copyFileSync(source, join(assets, '__world-data/yaba-vehicles.json'), constants.COPYFILE_EXCL)
  writeFileSync(join(assets, '_headers'), HEADERS, { flag: 'wx' })
  const metadata = JSON.parse(readFileSync(join(assets, 'playtest-build.json'), 'utf8'))
  if (metadata.config?.buildId !== settings.buildId) fail('The build metadata does not carry the requested build ID.')
  const wrangler = JSON.stringify(wranglerConfig(settings, metadata.artifactSha256, root), null, 2) + '\n'
  writeFileSync(join(out, 'wrangler.json'), wrangler, { flag: 'wx' })
  const pins = { buildId: settings.buildId, artifactSha256: metadata.artifactSha256, configSha256: hash(wrangler), legacyOrigin: settings.legacyOrigin }
  writeFileSync(join(out, 'release-pins.json'), JSON.stringify(pins, null, 2) + '\n', { flag: 'wx' })
  return pins
}

function cli() {
  const args = process.argv.slice(2), opts = {}, flags = new Set()
  while (args.length) {
    const name = args.shift()
    if (name === '--synthetic') flags.add('synthetic')
    else if ((name === '--out' || name === '--github-output') && args.length && opts[name] === undefined) opts[name] = args.shift()
    else fail('Usage: assemble-release-package.mjs --out <fresh absolute dir> [--synthetic] [--github-output <file>]')
  }
  if (!opts['--out']) fail('Usage: assemble-release-package.mjs --out <fresh absolute dir> [--synthetic] [--github-output <file>]')
  const settings = releaseSettings(process.env, flags.has('synthetic'))
  const pins = assemble({ out: opts['--out'], settings })
  if (opts['--github-output']) {
    appendFileSync(opts['--github-output'], Object.entries({ 'build-id': pins.buildId, 'artifact-sha': pins.artifactSha256, 'config-sha': pins.configSha256, 'legacy-origin': pins.legacyOrigin }).map(([k, v]) => `${k}=${v}\n`).join(''))
  }
  console.log(JSON.stringify({ status: 'ASSEMBLED', ...pins, synthetic: flags.has('synthetic') }))
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli() } catch (error) { console.error(`FAIL ${error instanceof Error ? error.message : 'ASSEMBLE_FAILED'}`); process.exitCode = 1 }
}
