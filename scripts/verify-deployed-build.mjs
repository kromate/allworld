// After a deploy: confirms the public origin serves the build that was just released and keeps the
// internal road data private. Read-only GET requests to the origin you pass; nothing is changed.
//
//   node scripts/verify-deployed-build.mjs --origin https://example.invalid --build-id <build-id>
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fail = code => { throw new Error(code) }
const sleep = ms => new Promise(done => setTimeout(done, ms))

/** `request` is injectable for probes. It must behave like fetch and must not follow redirects. */
export async function verifyDeployed({ origin, buildId, request = fetch, attempts = 6, delayMs = 5000, wait = sleep }) {
  let url
  try { url = new URL(origin) } catch { fail('ORIGIN') }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) fail('ORIGIN')
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(buildId)) fail('BUILD_ID')
  let last = 'HEALTH_UNAVAILABLE'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await request(`${origin}/world/health`, { redirect: 'manual', headers: { accept: 'application/json' } })
      const body = response.status === 200 ? await response.json() : null
      if (body?.ok === true && body.buildId === buildId && body.channel === 'test') {
        // The road data is server-only: no public variant may answer 200.
        const road = await request(`${origin}/__world-data/yaba-vehicles.json`, { redirect: 'manual' })
        if (road.status === 200) fail('ROAD_PUBLIC')
        return { status: 'PASS', buildId, attempt, roadStatus: road.status }
      }
      last = body && body.buildId !== buildId ? 'BUILD_MISMATCH' : 'HEALTH_UNAVAILABLE'
    } catch (error) { if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) throw error; last = 'HEALTH_UNAVAILABLE' }
    if (attempt < attempts) await wait(delayMs)
  }
  fail(last)
}

async function cli() {
  const args = process.argv.slice(2), opts = {}
  while (args.length) { const key = args.shift(), value = args.shift(); if (!['--origin', '--build-id'].includes(key) || !value || opts[key]) fail('USAGE'); opts[key] = value }
  if (!opts['--origin'] || !opts['--build-id']) fail('USAGE')
  console.log(JSON.stringify(await verifyDeployed({ origin: opts['--origin'], buildId: opts['--build-id'] })))
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(`FAIL ${/^[A-Z_]+$/.test(error.message) ? error.message : 'VERIFY_FAILED'}`); process.exitCode = 1 })
}
