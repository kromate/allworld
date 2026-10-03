// Explicit CLI configuration only. No default state file, audience, guest admission or public bind.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createHostedWorldServer } from './hostedServer.ts'
import type { GuestAdmission } from './hostedServer.ts'
import { createHostedFiles } from './hostedFiles.ts'
import type { HostedBinding } from './hostedIdentity.ts'
import { createFirebaseRestProvider } from './accountProvider.ts'
const { values } = parseArgs({ options: {
  state: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '5188' },
  audience: { type: 'string' }, origin: { type: 'string' }, site: { type: 'string' }, package: { type: 'string' },
  channel: { type: 'string' }, build: { type: 'string' }, artifact: { type: 'string' },
  guests: { type: 'string', default: 'disabled' }, 'invitation-hash': { type: 'string', multiple: true },
  'firebase-project': { type: 'string' }, 'firebase-project-number': { type: 'string' }, 'firebase-api-key-file': { type: 'string' },
  'session-key-file': { type: 'string' }, 'max-connections': { type: 'string', default: '1000' },
  'build-root': { type: 'string' },
  'creator-account': { type: 'string' }, 'creator-subject': { type: 'string' }, 'creator-since': { type: 'string' },
  'trust-cloudflare-loopback': { type: 'boolean', default: false },
} })
function required(value: string | undefined, name: string): string { if (!value) throw new Error(`--${name} is required.`); return value }
const channel = values.channel
if (channel !== 'test' && channel !== 'store') throw new Error('--channel must be test or store.')
let admission: GuestAdmission
if (values.guests === 'disabled') admission = { kind: 'disabled' }
else if (values.guests === 'public') admission = { kind: 'public' }
else if (values.guests === 'invite' && values['invitation-hash']?.length) admission = { kind: 'invite', hashes: values['invitation-hash'] }
else throw new Error('Use --guests disabled, public, or invite with --invitation-hash.')
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.')
// Reading CF-Connecting-IP is only sound when nothing but the tunnel on this machine can connect.
const trustCloudflareLoopback = values['trust-cloudflare-loopback']
if (trustCloudflareLoopback && values.host !== '127.0.0.1' && values.host !== '::1') throw new Error('--trust-cloudflare-loopback needs --host 127.0.0.1 or ::1: the listener must not be reachable except through the tunnel.')
const hasCreator = Boolean(values['creator-account'] || values['creator-subject'] || values['creator-since'])
const creator = hasCreator ? {
  account: { accountId: required(values['creator-account'], 'creator-account'), subjectId: required(values['creator-subject'], 'creator-subject') },
  onboardedSince: Date.parse(required(values['creator-since'], 'creator-since')),
} : undefined
if (creator && !Number.isFinite(creator.onboardedSince)) throw new Error('--creator-since must be an ISO date for the first eligible onboarding.')
const binding = { siteId: required(values.site, 'site'), packageId: required(values.package, 'package'), channel,
    audience: required(values.audience, 'audience'), origin: required(values.origin, 'origin'),
    buildId: required(values.build, 'build'), artifactId: required(values.artifact, 'artifact'),
    ...(admission.kind === 'disabled' ? {} : { guestAdmission: admission.kind }) } satisfies HostedBinding
// Accounts are all or nothing, and nothing about them is defaulted. With none of the three, the host is guests only.
const accountFlags = [values['firebase-project'], values['firebase-api-key-file'], values['session-key-file']]
if (accountFlags.some(Boolean) && !accountFlags.every(Boolean)) throw new Error('Accounts need --firebase-project, --firebase-api-key-file and --session-key-file together.')
if (values['firebase-project-number'] && !values['firebase-project']) throw new Error('--firebase-project-number needs --firebase-project.')
/** 32 random bytes as hex or base64, from a file that is not kept beside the state: a copy of the state must not carry the key. */
function sessionKey(path: string, statePath: string): Buffer {
  if (dirname(resolve(path)) === dirname(resolve(statePath))) throw new Error('Keep --session-key-file outside the state folder.')
  const text = readFileSync(path, 'utf8').trim()
  const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, 'hex') : /^[A-Za-z0-9+/_-]{43}=?$/.test(text) ? Buffer.from(text, 'base64') : null
  if (!key || key.length !== 32) throw new Error('--session-key-file must hold exactly 32 random bytes as hex or base64.')
  return key
}
const account = values['firebase-project'] ? {
  provider: createFirebaseRestProvider({
    projectId: values['firebase-project'], apiKey: readFileSync(required(values['firebase-api-key-file'], 'firebase-api-key-file'), 'utf8').trim(),
    ...(values['firebase-project-number'] ? { projectNumber: values['firebase-project-number'] } : {}),
  }),
  sessionKey: sessionKey(required(values['session-key-file'], 'session-key-file'), required(values.state, 'state')),
} : undefined
const staticFiles = values['build-root'] ? await createHostedFiles(values['build-root'], {
  origin: binding.origin, audience: binding.audience, siteId: binding.siteId,
  packageId: binding.packageId, channel, buildId: binding.buildId,
  ...(binding.guestAdmission ? { guestAdmission: binding.guestAdmission } : {}),
}) : null
const hosted = createHostedWorldServer({
  binding,
  state: { path: required(values.state, 'state') }, guestAdmission: admission,
  ...(account ? { account } : {}),
  maxConnections: Number(values['max-connections']),
  ...(creator ? { creator } : {}),
  trustCloudflareLoopback,
})
const server = createServer((request, response) => {
  void (async () => {
    if (staticFiles && await staticFiles(request, response)) return
    await hosted.handle(request, response)
  })().catch(() => {
    if (response.headersSent) response.destroy()
    else { response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('This playtest is temporarily unavailable.') }
  })
})
server.requestTimeout = 10_000; server.headersTimeout = 8000; server.keepAliveTimeout = 5000; server.maxConnections = 2000
hosted.attach(server)
let stopping = false
function stop(): void {
  if (stopping) return
  stopping = true; hosted.stop(); server.close(); server.closeAllConnections()
}
server.on('error', error => { console.error('[hosted-world]', error.message); stop(); process.exitCode = 1 })
server.listen(port, values.host, () => console.log(`[hosted-world] ready on port ${port}; accounts ${account ? 'configured' : 'unavailable'}; rate keys from ${trustCloudflareLoopback ? 'CF-Connecting-IP on loopback' : 'the socket address'}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop)
