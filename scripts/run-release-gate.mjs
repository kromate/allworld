// The only way the release workflow reaches the package gate. It builds the guard's argument list
// itself from reviewed pins, so no workflow step can add a flag, swap the config or point at other
// assets. `check` is local. `deploy` also needs the main-branch workflow context and a provider token
// in the environment; the token is passed to the guard's child and never printed or logged.
//
//   node scripts/run-release-gate.mjs check  --package P --build-id B --artifact-sha A --config-sha C --legacy-origin O
//   node scripts/run-release-gate.mjs deploy … --wrangler /absolute/path/to/wrangler.js
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fail = code => { throw new Error(code) }
const PASS_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']
const FLAGS = { '--package': 'package', '--build-id': 'buildId', '--artifact-sha': 'artifactSha', '--config-sha': 'configSha', '--legacy-origin': 'legacyOrigin', '--wrangler': 'wrangler' }

export function parseGateArgs(argv) {
  const args = [...argv], mode = args.shift(), opts = {}
  if (!['check', 'deploy'].includes(mode) || args.length % 2) fail('USAGE')
  while (args.length) { const key = FLAGS[args.shift()], value = args.shift(); if (!key || opts[key] !== undefined || !value) fail('USAGE'); opts[key] = value }
  for (const key of ['package', 'buildId', 'artifactSha', 'configSha', 'legacyOrigin']) if (!opts[key]) fail('USAGE')
  if ((mode === 'deploy') !== (opts.wrangler !== undefined)) fail('USAGE')
  if (!isAbsolute(opts.package) || resolve(opts.package) !== opts.package) fail('PACKAGE_PATH')
  if (opts.wrangler !== undefined && (!isAbsolute(opts.wrangler) || resolve(opts.wrangler) !== opts.wrangler)) fail('WRANGLER_PATH')
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(opts.buildId)) fail('BUILD_ID')
  if (!/^[a-f0-9]{64}$/.test(opts.artifactSha) || !/^[a-f0-9]{64}$/.test(opts.configSha)) fail('DIGEST')
  if (!/^https:\/\/[a-z0-9.-]+$/.test(opts.legacyOrigin)) fail('LEGACY_ORIGIN')
  return { mode, ...opts }
}

/** The exact guard argument list. Nothing outside this function adds to it. */
export function guardArgv(parsed, root) {
  const argv = [parsed.mode, '--package', parsed.package, '--config', join(parsed.package, 'wrangler.json'), '--artifact', join(parsed.package, 'assets'),
    '--build-id', parsed.buildId, '--artifact-sha', parsed.artifactSha, '--config-sha', parsed.configSha, '--road-source', join(root, 'service/cloudflare/roads.ts'), '--legacy-origin', parsed.legacyOrigin]
  if (parsed.mode === 'deploy') argv.push('--deploy-executable', parsed.wrangler)
  return argv
}

/** Deploy is refused outside the reviewed workflow context, and for packages built from reserved hosts. */
export function deployContext(env, parsed) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main') fail('DEPLOY_CONTEXT')
  if (!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) fail('DEPLOY_CREDENTIALS')
  if (parsed.legacyOrigin.endsWith('.invalid')) fail('SYNTHETIC_PACKAGE')
}

/** `spawn` is injectable so a probe can observe the exact command without starting anything. */
export function runGate(argv, env, { root = realpathSync(join(here, '..')), spawn = spawnSync } = {}) {
  const parsed = parseGateArgs(argv)
  if (parsed.mode === 'deploy') deployContext(env, parsed)
  // The guard and wrangler get a short allowlist, not the runner's environment. Only a deploy sees
  // the provider token, and only wrangler needs it.
  const base = Object.fromEntries(PASS_ENV.filter(key => env[key] !== undefined).map(key => [key, env[key]]))
  const childEnv = parsed.mode === 'deploy' ? { ...base, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' } : base
  const child = spawn(process.execPath, [join(root, 'scripts/guard-release-package.mjs'), ...guardArgv(parsed, root)], { env: childEnv, stdio: 'inherit', shell: false })
  if (child.error) fail('GUARD_EXEC_FAILED')
  return child.status ?? 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runGate(process.argv.slice(2), process.env) } catch (error) { console.error(`FAIL ${/^[A-Z_]+$/.test(error.message) ? error.message : 'GATE_FAILED'}`); process.exitCode = 1 }
}
