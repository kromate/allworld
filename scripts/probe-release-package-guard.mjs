// Synthetic fixtures only. Does not copy assets, read state, or call a provider.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyPackage } from './guard-release-package.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
const fixture = mkdtempSync(join(ownRoot, 'synthetic-'))
const guard = join(ownRoot, 'scripts/guard-release-package.mjs')
const headers = '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/\n  Cache-Control: no-cache\n\n/app-build.json\n  Cache-Control: no-store\n\n/playtest-config.json\n  Cache-Control: no-store\n\n/playtest-build.json\n  Cache-Control: no-store\n'
const road = { path: '/__world-data/yaba-vehicles.json', bytes: 3, sha256: hash('{}\n') }
const pub = { origin: 'https://fixture.invalid', audience: 'https://legacy.invalid', siteId: 'synthetic-site', packageId: 'synthetic-package', channel: 'test', buildId: 'synthetic-build', guestAdmission: 'public', endpoint: 'https://fixture.invalid' }
const assets = join(fixture, 'assets'), configPath = join(fixture, 'wrangler.json')
const source = join(fixture, 'service/cloudflare/roads.ts'), marker = join(fixture, 'DEPLOY_STARTED'), executable = join(fixture, 'fake-deploy.sh')
mkdirSync(join(assets, 'assets'), { recursive: true }); mkdirSync(join(assets, '__world-data')); mkdirSync(dirname(source), { recursive: true })
writeFileSync(source, "export const ROAD_ASSET = {\n  path: '/__world-data/yaba-vehicles.json',\n  bytes: 23347699,\n  sha256: '44cf0458af265d8ceb5ad84216dc722e0df6e289e29b0acfcaf92b78127919e2',\n} as const\n")
writeFileSync(executable, '#!/bin/sh\nprintf started > "' + marker + '"\n', { mode: 0o700 })
let options
writeFileSync(join(dirname(source), 'worker.ts'), '// Synthetic Worker entry; never uploaded.\n')
const config = { '$schema': 'synthetic-schema', name: 'synthetic', account_id: 'synthetic', main: join(dirname(source), 'worker.ts'), compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], workers_dev: true, preview_urls: false, durable_objects: { bindings: [] }, migrations: [], observability: { enabled: false }, minify: true, send_metrics: false, assets: { directory: './assets', binding: 'ASSETS', run_worker_first: ['/*', '!/assets/*', '!/avatars/*', '!/packs/*', '!/regions/*', '!/wardrobe/*'], not_found_handling: 'none' }, vars: { WORLD_BINDING: JSON.stringify({ ...Object.fromEntries(Object.entries(pub).filter(([k]) => k !== 'endpoint')), artifactId: '' }), WORLD_GUEST_ADMISSION: '{"kind":"public"}', WORLD_MAX_CONNECTIONS: '2', WORLD_ACCOUNT: '{"projectId":"synthetic-project","projectNumber":"123"}', WORLD_LEGACY_ORIGIN: pub.audience, WORLD_IMPORT_MAX_BYTES: '65536' } }
function reset() {
  rmSync(assets, { recursive: true, force: true }); mkdirSync(join(assets, 'assets'), { recursive: true }); mkdirSync(join(assets, '__world-data'))
  const entry = 'if(location.origin!==`https://fixture.invalid`)throw Error();configureHostedWorld({' + Object.entries(pub).filter(([k]) => k !== 'origin').map(([k, v]) => `${k}:\`${v}\``).join(',') + '});'
  const files = { 'app-build.json': '{"id":"0123456789ab","assets":"abcdef012345"}', 'playtest-config.json': JSON.stringify(pub), 'index.html': '<script type="module" src="/assets/index-abcdefgh.js"></script>', 'assets/index-abcdefgh.js': entry }
  const metadata = { schema: 1, config: pub, assetRevision: 'abcdef012345', routes: ['/'], files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { bytes: Buffer.byteLength(content), sha256: hash(content), immutable: path.startsWith('assets/') }])) }
  metadata.artifactSha256 = hash(JSON.stringify(metadata))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(assets, name), content)
  writeFileSync(join(assets, 'playtest-build.json'), JSON.stringify(metadata)); writeFileSync(join(assets, '_headers'), headers); writeFileSync(join(assets, road.path.slice(1)), '{}\n')
  config.assets.run_worker_first = ['/*', '!/assets/*', '!/avatars/*', '!/packs/*', '!/regions/*', '!/wardrobe/*']
  config.vars.WORLD_ACCOUNT = '{"projectId":"synthetic-project","projectNumber":"123"}'
  config.vars.WORLD_BINDING = JSON.stringify({ ...Object.fromEntries(Object.entries(pub).filter(([k]) => k !== 'endpoint')), artifactId: metadata.artifactSha256 })
  writeFileSync(configPath, JSON.stringify(config))
  options = { package: fixture, config: configPath, artifact: assets, buildId: pub.buildId, artifactSha: metadata.artifactSha256, configSha: hash(readFileSync(configPath)), roadSource: source }
}
function argv(extra = []) { return ['deploy', '--package', options.package, '--config', options.config, '--artifact', options.artifact, '--build-id', options.buildId, '--artifact-sha', options.artifactSha, '--config-sha', options.configSha, '--road-source', options.roadSource, '--deploy-executable', executable, ...extra] }
const results = []
function negative(name, expected, mutate, extra = []) {
  reset(); mutate()
  if (expected !== 'CONFIG_DIGEST_MISMATCH') options.configSha = hash(readFileSync(configPath))
  const run = spawnSync(process.execPath, [guard, ...argv(extra)], { encoding: 'utf8' })
  assert.equal(run.status, 1, name); assert.equal(run.stderr.trim(), 'FAIL ' + expected, name); assert.equal(existsSync(marker), false, name + ' started deploy')
  results.push({ name, status: 'PASS', rejection: expected, deployStarted: false })
}
try {
  reset(); assert.equal(verifyPackage(options, road).status, 'PASS'); results.push({ name: 'synthetic-complete-package', status: 'PASS' })
  reset(); config.vars.WORLD_ACCOUNT = JSON.stringify({ projectId: 'synthetic-project', projectNumber: '123', googleClientId: '123-fixture.apps.googleusercontent.com' }); writeFileSync(configPath, JSON.stringify(config)); options.configSha = hash(readFileSync(configPath)); assert.equal(verifyPackage(options, road).status, 'PASS'); results.push({ name: 'synthetic-google-config-package', status: 'PASS' })
  negative('malformed-google-client-id', 'PUBLIC_VARS_FIELD', () => { config.vars.WORLD_ACCOUNT = JSON.stringify({ projectId: 'synthetic-project', projectNumber: '123', googleClientId: 'https://attacker.invalid/client' }); writeFileSync(configPath, JSON.stringify(config)) })
  negative('google-client-secret-field', 'PUBLIC_VARS_FIELD', () => { config.vars.WORLD_ACCOUNT = JSON.stringify({ projectId: 'synthetic-project', projectNumber: '123', googleClientId: '123-fixture.apps.googleusercontent.com', clientSecret: 'synthetic-refused' }); writeFileSync(configPath, JSON.stringify(config)) })
  negative('google-client-id-wrong-type', 'PUBLIC_VARS_FIELD', () => { config.vars.WORLD_ACCOUNT = JSON.stringify({ projectId: 'synthetic-project', projectNumber: '123', googleClientId: 123 }); writeFileSync(configPath, JSON.stringify(config)) })
  negative('missing-road', 'ROAD_MISSING', () => rmSync(join(assets, road.path.slice(1))))
  negative('wrong-road-size', 'ROAD_SIZE_MISMATCH', () => {})
  negative('wrong-road-hash', 'ROAD_HASH_MISMATCH', () => writeFileSync(join(assets, road.path.slice(1)), Buffer.alloc(23347699)))
  negative('config-digest-drift', 'CONFIG_DIGEST_MISMATCH', () => { const c = JSON.parse(readFileSync(configPath)); c.name = 'changed'; writeFileSync(configPath, JSON.stringify(c)) })
  negative('metadata-tamper', 'ARTIFACT_DIGEST_MISMATCH', () => { const p = join(assets, 'playtest-build.json'), m = JSON.parse(readFileSync(p)); m.config.buildId = 'different-build'; writeFileSync(p, JSON.stringify(m)) })
  negative('binding-artifact-mismatch', 'BINDING_METADATA_MISMATCH', () => { const b = JSON.parse(config.vars.WORLD_BINDING); b.artifactId = '0'.repeat(64); config.vars.WORLD_BINDING = JSON.stringify(b); writeFileSync(configPath, JSON.stringify(config)) })
  negative('extra-manifest-file', 'ASSET_MANIFEST_CLOSURE_MISMATCH', () => writeFileSync(join(assets, 'assets/extra-abcdefgh.js'), 'synthetic'))
  negative('headers-missing', 'REQUIRED_ASSET_MISSING', () => rmSync(join(assets, '_headers')))
  negative('headers-corrupt', 'HEADERS_MISMATCH', () => writeFileSync(join(assets, '_headers'), '/__world-data/*\n  Cache-Control: public\n'))
  negative('internal-road-static-bypass', 'STATIC_PROTECTION_MISMATCH', () => { config.assets.run_worker_first.push('!/__world-data/*'); writeFileSync(configPath, JSON.stringify(config)) })
  negative('asset-symlink', 'ASSET_SYMLINK_REFUSED', () => { rmSync(join(assets, road.path.slice(1))); symlinkSync('/does-not-exist-and-must-not-be-opened', join(assets, road.path.slice(1))) })
  negative('late-config-override', 'USAGE', () => {}, ['--config', '/not-the-reviewed-config'])
  negative('assets-override', 'USAGE', () => {}, ['--assets', '/not-the-reviewed-assets'])
  negative('config-build-hook', 'CONFIG_SHAPE', () => { const c = JSON.parse(readFileSync(configPath)); c.build = { command: 'must never run' }; writeFileSync(configPath, JSON.stringify(c)) })
  negative('config-path-escape', 'PACKAGE_PATH_MISMATCH', () => { options.config = source })
  for (const [name, action, expected] of [
    ['declared-file-missing', () => rmSync(join(assets, 'assets/index-abcdefgh.js')), 'ASSET_MANIFEST_CLOSURE_MISMATCH'],
    ['declared-file-wrong-hash', () => writeFileSync(join(assets, 'assets/index-abcdefgh.js'), 'changed'), 'ASSET_BYTES_MISMATCH'],
  ]) { reset(); action(); assert.throws(() => verifyPackage(options, road), { message: expected }); results.push({ name, status: 'PASS', rejection: expected, mode: 'synthetic-function' }) }
  console.log(JSON.stringify({ status: 'PASS', controls: results.length, providerCalls: 0, results }, null, 2))
} finally { rmSync(fixture, { recursive: true, force: true }) }
