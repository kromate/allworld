import { timingSafeEqual, createHash } from 'node:crypto'
import { DurableObject } from 'cloudflare:workers'
import { prepareCloudflareRoads } from './roads.ts'
import { checkedCreatorConfig } from '../creator.ts'
import type { HostedBinding } from '../hostedIdentity.ts'
import { createFirebaseRestProvider } from '../accountProvider.ts'
import { cloudflareIdentityFetch } from './identityFetch.ts'
import { createCloudflareWorldServer } from './transport.ts'
import type { GuestAdmission } from './transport.ts'
import { ACCOUNT_PATHS, boundedText } from './accountHttp.ts'
import { createWorldImport } from './worldImport.ts'
import { createNativeImportStore } from './importPhases.ts'
import { GUEST_TRANSFER_PATHS, guestTransferOrigins } from '../guestTransfers.ts'
import { WorldError } from '../../src/shared/model.ts'
import { pageMetadata } from '../pageMetadata.ts'

export interface Env {
  ASSETS: Fetcher
  WORLD: DurableObjectNamespace<WorldDurableObject>
  WORLD_BINDING: string
  WORLD_GUEST_ADMISSION: string
  /** Refused: standalone worlds never accept a remote identity exchange. */
  WORLD_REDEEM_URL?: string
  WORLD_CREATOR_CONFIG?: string
  WORLD_MAX_CONNECTIONS?: string
  /** Public provider config: {"projectId","projectNumber","googleClientId"?}. */
  WORLD_ACCOUNT?: string
  /** Server-only Worker secrets. Never build vars, static assets or runtime metadata. */
  WORLD_FIREBASE_API_KEY?: string
  WORLD_SESSION_KEY?: string
  /** Exact legacy page origin, accepted on the guest transfer start route only. */
  WORLD_LEGACY_ORIGIN?: string
  /** Operator import secret. Delete it once root accepts the receipt. */
  WORLD_IMPORT_SECRET?: string
  WORLD_IMPORT_MAX_BYTES?: string
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
const IMPORT_PATH = '/world/operator/import'
const paths = new Set(['/world/health', '/world/socket', '/world/guest-session', '/world/guest-claim', '/world/guest-revoke', '/world/hosted-challenge', '/world/hosted-session', '/world/counts/snapshot', '/world/counts/view', ...ACCOUNT_PATHS, ...GUEST_TRANSFER_PATHS, IMPORT_PATH])
const DEFAULT_IMPORT_BYTES = 16 * 1024 * 1024
const MAX_IMPORT_BYTES = 48 * 1024 * 1024

export function worldKey(binding: Pick<HostedBinding, 'siteId' | 'packageId' | 'channel'>): string {
  return JSON.stringify([binding.siteId, binding.packageId, binding.channel])
}

function exactOrigin(value: unknown): string {
  if (!text(value)) throw new Error('Invalid world origin configuration.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Invalid world origin configuration.')
  return value
}

export function configuration(env: Omit<Env, 'ASSETS' | 'WORLD'>) {
  const binding: unknown = JSON.parse(env.WORLD_BINDING)
  if (!object(binding) || !text(binding.siteId) || !text(binding.packageId) || !text(binding.buildId) || !text(binding.artifactId)
    || (binding.channel !== 'test' && binding.channel !== 'store') || !text(binding.origin) || !text(binding.audience)
    || ('guestAdmission' in binding && binding.guestAdmission !== 'public' && binding.guestAdmission !== 'invite')
    || Object.keys(binding).some(key => !['siteId', 'packageId', 'channel', 'buildId', 'artifactId', 'origin', 'audience', 'guestAdmission'].includes(key))) throw new Error('Invalid world binding configuration.')
  exactOrigin(binding.origin); exactOrigin(binding.audience)
  const exact: HostedBinding = { siteId: binding.siteId, packageId: binding.packageId, buildId: binding.buildId, artifactId: binding.artifactId, channel: binding.channel, origin: binding.origin, audience: binding.audience, ...(binding.guestAdmission === 'public' || binding.guestAdmission === 'invite' ? { guestAdmission: binding.guestAdmission } : {}) }
  const raw: unknown = JSON.parse(env.WORLD_GUEST_ADMISSION)
  let guestAdmission: GuestAdmission
  if (object(raw) && raw.kind === 'disabled' && Object.keys(raw).length === 1) guestAdmission = { kind: 'disabled' }
  else if (object(raw) && raw.kind === 'public' && Object.keys(raw).length === 1) guestAdmission = { kind: 'public' }
  else if (object(raw) && raw.kind === 'invite' && Object.keys(raw).length === 2 && Array.isArray(raw.hashes) && raw.hashes.length <= 100
    && raw.hashes.every((hash: unknown): hash is string => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) guestAdmission = { kind: 'invite', hashes: raw.hashes }
  else throw new Error('Invalid guest admission configuration.')
  if (exact.guestAdmission !== undefined && guestAdmission.kind !== exact.guestAdmission) throw new Error('Guest admission must match the reviewed hosted build.')
  // Measured: the native heap leaves too little margin above four players. Hosted QA starts at two.
  const maxConnections = env.WORLD_MAX_CONNECTIONS === undefined ? 4 : Number(env.WORLD_MAX_CONNECTIONS)
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4) throw new Error('Free friend playtests allow 1 to 4 connections.')
  if (env.WORLD_REDEEM_URL !== undefined) throw new Error('Standalone worlds do not accept a remote identity exchange.')
  const accountParts = [env.WORLD_ACCOUNT, env.WORLD_FIREBASE_API_KEY, env.WORLD_SESSION_KEY].filter(value => value !== undefined).length
  if (accountParts !== 0 && accountParts !== 3) throw new Error('Accounts need the provider config, its API key and the session key together.')
  let account: { provider: ReturnType<typeof createFirebaseRestProvider>; sessionKey: Uint8Array } | undefined
  if (accountParts === 3) {
    const provider: unknown = JSON.parse(env.WORLD_ACCOUNT ?? '')
    if (!object(provider) || typeof provider.projectId !== 'string' || (provider.projectNumber !== undefined && typeof provider.projectNumber !== 'string')
      || (provider.googleClientId !== undefined && (typeof provider.googleClientId !== 'string' || !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(provider.googleClientId)))
      || Object.keys(provider).some(key => key !== 'projectId' && key !== 'projectNumber' && key !== 'googleClientId')) throw new Error('Invalid account provider configuration.')
    if (!/^[A-Za-z0-9_-]{43}$/.test(env.WORLD_SESSION_KEY ?? '')) throw new Error('The session key must be 32 random bytes as base64url.')
    const sessionKey = new Uint8Array(Buffer.from(env.WORLD_SESSION_KEY ?? '', 'base64url'))
    if (sessionKey.length !== 32) throw new Error('The session key must be 32 random bytes as base64url.')
    account = { provider: createFirebaseRestProvider({ projectId: provider.projectId, ...(provider.projectNumber ? { projectNumber: provider.projectNumber } : {}), apiKey: env.WORLD_FIREBASE_API_KEY ?? '', ...(provider.googleClientId ? { googleClientId: provider.googleClientId } : {}),
      // Workers rejects redirect:'error'; the reviewed adapter keeps the no-follow contract and refuses any redirect.
      fetch: cloudflareIdentityFetch }), sessionKey }
  }
  const legacyOrigin = env.WORLD_LEGACY_ORIGIN === undefined ? undefined : exactOrigin(env.WORLD_LEGACY_ORIGIN)
  if (legacyOrigin && (!account || legacyOrigin === exact.origin)) throw new Error('Guest transfer needs accounts configured and a legacy origin other than the serving origin.')
  const creator = env.WORLD_CREATOR_CONFIG === undefined ? undefined : checkedCreatorConfig(JSON.parse(env.WORLD_CREATOR_CONFIG))
  if (creator && creator.account.accountId !== account?.provider.issuer) throw new Error('The creator must be an account of the configured provider.')
  const importBytes = env.WORLD_IMPORT_MAX_BYTES === undefined ? DEFAULT_IMPORT_BYTES : Number(env.WORLD_IMPORT_MAX_BYTES)
  if (!Number.isSafeInteger(importBytes) || importBytes < 1 || importBytes > MAX_IMPORT_BYTES) throw new Error('Invalid import size limit.')
  return { binding: exact, guestAdmission, maxConnections, importBytes, ...(account ? { account } : {}), ...(legacyOrigin ? { transfer: { legacyOrigin } } : {}), ...(creator ? { creator } : {}) }
}

function unavailable(): Response {
  return Response.json({ code: 'unavailable', message: 'The world is unavailable. Retry shortly.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
}
const assetPath = (path: string): string => path.split('/').map(part => {
  try { return decodeURIComponent(part) } catch { return part }
}).join('/').replace(/\/+/g, '/')
const notFound = (): Response => new Response('Not found.', { status: 404, headers: { 'cache-control': 'no-store' } })

const scriptLiteral = (value: string): string => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029')

function legacyLanding(binding: HostedBinding, head: boolean): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const target = binding.origin
  // This is the exact key used by src/platform/guestService.ts. The stable audience keeps the
  // guest's logical scope unchanged while this old origin hands the capability to the new one.
  const guestKey = `nw:guest:${JSON.stringify([binding.audience, binding.siteId, binding.packageId, binding.channel])}`
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>Allworld has moved</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: ui-rounded, system-ui, sans-serif; background: #1c1a24; color: #f8f5ef; }
    body { min-height: 100vh; min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 20px; box-sizing: border-box; }
    main { width: min(100%, 430px); padding: 28px; box-sizing: border-box; border: 1px solid #3a3648; border-radius: 24px; background: #25222e; box-shadow: 0 20px 60px #0007; }
    h1 { margin: 0 0 12px; font-size: clamp(1.8rem, 8vw, 2.5rem); line-height: 1.05; }
    p { color: #cbc5d4; line-height: 1.55; }
    .actions { display: grid; gap: 12px; margin-top: 24px; }
    button, a { min-height: 48px; display: grid; place-items: center; box-sizing: border-box; border-radius: 999px; font: inherit; font-weight: 750; text-align: center; cursor: pointer; }
    button { border: 0; padding: 0 20px; background: #ffb020; color: #1c1a24; }
    button:disabled { cursor: wait; opacity: .65; }
    a { padding: 11px 20px; border: 1px solid #575064; color: #f8f5ef; text-decoration: none; }
    button:focus-visible, a:focus-visible { outline: 3px solid #72b8ff; outline-offset: 3px; }
    #guest, #none { display: none; }
    #status { min-height: 1.6em; color: #ffd28a; }
  </style>
</head>
<body>
  <main>
    <h1>Allworld has moved</h1>
    <p>Your original world and character are preserved. Continue to the world below.</p>
    <section id="guest">
      <p>This browser has a guest character from the old address. Choose when you are ready to open that same character at the new address.</p>
      <div class="actions">
        <button id="move" type="button">Continue with my character</button>
        <a id="guest-new" rel="noreferrer">Go without moving it</a>
      </div>
      <p id="status" role="status" aria-live="polite"></p>
    </section>
    <section id="none">
      <p>No guest character is stored in this browser. If you saved yours to an account, sign in again at the new address.</p>
      <div class="actions"><a id="open-new" rel="noreferrer">Open Allworld</a></div>
    </section>
  </main>
  <script nonce="${nonce}">
    'use strict';
    const target = ${scriptLiteral(target)};
    const guestKey = ${scriptLiteral(guestKey)};
    const guest = document.getElementById('guest');
    const none = document.getElementById('none');
    const move = document.getElementById('move');
    const status = document.getElementById('status');
    const destination = target + '/';
    document.getElementById('guest-new').href = destination;
    document.getElementById('open-new').href = destination;
    let token = null;
    try { token = localStorage.getItem(guestKey); } catch {}
    if (typeof token === 'string' && /^gst_[A-Za-z0-9_-]{43}$/.test(token)) guest.style.display = 'block';
    else none.style.display = 'block';
    move.addEventListener('click', async () => {
      if (move.disabled || token === null) return;
      move.disabled = true;
      status.textContent = 'Preparing your character…';
      try {
        const response = await fetch(target + '/world/guest-transfer/start', {
          method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
        });
        const value = await response.json();
        if (!response.ok || value === null || typeof value !== 'object' || typeof value.next !== 'string') throw new Error('refused');
        const next = new URL(value.next);
        if (next.origin !== target || next.pathname !== '/' || next.search !== '' || !/^#transfer=gtx_[A-Za-z0-9_-]{43}$/.test(next.hash)) throw new Error('invalid');
        location.assign(next.href);
      } catch {
        status.textContent = 'Your character is still kept in this browser. Try again in a moment, or open the new address and sign in.';
        move.disabled = false;
      }
    });
  </script>
</body>
</html>`
  const headers = new Headers({
    'cache-control': 'private, no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src ${target}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
    'content-type': 'text/html; charset=utf-8',
    'permissions-policy': 'camera=(), geolocation=(), microphone=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  return new Response(head ? null : body, { status: 200, headers })
}

type Phases = ReturnType<typeof createNativeImportStore>

export class WorldDurableObject extends DurableObject<Env> {
  private server: ReturnType<typeof createCloudflareWorldServer> | null = null
  private readonly importer: ReturnType<typeof createWorldImport>
  private readonly phases: Phases
  private readonly open: () => Promise<void>
  private readonly ready: Promise<void>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const config = configuration(env)
    if (!ctx.id.equals(env.WORLD.idFromName(worldKey(config.binding)))) throw new Error('Wrong world owner.')
    const { audience, siteId, packageId, channel, buildId } = config.binding
    const phases = createNativeImportStore(ctx.storage, { scope: worldKey(config.binding) })
    this.phases = phases
    // The one migration module decides readiness and every import transition; this object only gates on it.
    this.importer = createWorldImport({ store: phases.store, expected: { scope: { audience, siteId, packageId, channel }, buildId }, secret: env.WORLD_IMPORT_SECRET ?? null, maxBytes: config.importBytes })
    // Only a durably VERIFIED import ever becomes a World. Before it nothing is constructed, flushed or written.
    this.open = async () => {
      if (!this.importer.gameplayOpen()) throw new Error('The import is not verified.')
      await prepareCloudflareRoads(env.ASSETS)
      const persistence = phases.domainPersistence()
      const { importBytes: _, ...options } = config
      // A local candidate until its first durable sync: no request, account attempt or socket can reach it before.
      const candidate = createCloudflareWorldServer({ ...options, persistence, waitUntil: promise => ctx.waitUntil(promise) })
      try { await persistence.sync() } catch (error) { candidate.stop(); throw error }
      this.server = candidate
    }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      // 'prepared' stays closed here: only the operator's identical import resumes it, inside the module.
      if (await this.importer.ready() === 'imported') await this.open()
    })
  }

  private async importRoute(request: Request): Promise<Response> {
    const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
    // Operator only: a browser always sends Origin on a POST, and Fetch Metadata where supported. No CORS is ever answered.
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site') || request.headers.has('cookie')) return json(403, { code: 'forbidden', message: 'Not allowed.' })
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(405, { code: 'invalid', message: 'Use POST.' })
    const bearer = /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
    // The configured secret is checked first, for every target, before any body byte is read.
    const configured = this.env.WORLD_IMPORT_SECRET
    const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
    const authorized = configured !== undefined && timingSafeEqual(digest(bearer), digest(configured))
    try {
      if (!authorized) {
        await request.body?.cancel().catch(() => undefined)
        // Once anything is stored the route does not exist without the secret; an empty target says unauthorized.
        if (await this.phases.store.receipt() || this.phases.foreign()) return notFound()
        return json(401, { code: 'unauthorized', message: 'Import is not authorized.' })
      }
      const config = configuration(this.env)
      const scope: unknown = JSON.parse(request.headers.get('x-world-import-scope') ?? 'null')
      const worldText = await boundedText(request, config.importBytes)
      const result = await this.importer.accept({ secret: bearer, importId: request.headers.get('x-world-import-id'), scope, buildId: request.headers.get('x-world-import-build'), sha256: request.headers.get('x-world-import-sha256'), text: worldText })
      if (this.importer.gameplayOpen() && !this.server) {
        // Errors are returned, not thrown, so a failed open does not reset the object mid-phase.
        const failed = await this.ctx.blockConcurrencyWhile(async () => { try { if (!this.server) await this.open(); return null } catch (error) { return error } })
        if (failed) throw failed
      }
      return json(200, result)
    } catch (error) {
      const code = error instanceof WorldError ? error.code : 'unavailable'
      const status = code === 'conflict' ? 409 : code === 'invalid' ? 400 : code === 'forbidden' ? 403 : code === 'unauthorized' ? 401 : 503
      return json(status, { code, message: error instanceof WorldError ? error.message : 'The import could not be completed.' })
    }
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.ready
      if (new URL(request.url).pathname === IMPORT_PATH) return await this.importRoute(request)
      return this.server ? await this.server.fetch(request) : unavailable()
    } catch { return unavailable() }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url)
      const decoded = assetPath(url.pathname)
      if (decoded === '/__world-data' || decoded.startsWith('/__world-data/') || decoded === '/world'
        || (decoded.startsWith('/world/') && decoded !== url.pathname)) return notFound()
      const config = configuration(env)
      if (config.transfer && guestTransferOrigins(config.transfer.legacyOrigin, config.binding.origin).includes(url.origin) && ['GET', 'HEAD'].includes(request.method)
        && !url.pathname.startsWith('/world/') && !/\.[^/]+$/.test(decoded)) return pageMetadata(request, legacyLanding(config.binding, request.method === 'HEAD'))
      if (!url.pathname.startsWith('/world/')) {
        const asset = await env.ASSETS.fetch(request)
        if (asset.status !== 404 || !['GET', 'HEAD'].includes(request.method) || /\.[^/]+$/.test(decoded)) return pageMetadata(request, asset)
        const entry = new URL('/', url)
        return pageMetadata(request, await env.ASSETS.fetch(new Request(entry, request)))
      }
      if (url.search || url.hash) return Response.json({ code: 'invalid', message: 'Query parameters are not accepted.' }, { status: 400 })
      if (url.pathname === '/world/runtime-config') {
        if (request.method !== 'GET' || url.origin !== config.binding.origin) return notFound()
        const { audience, siteId, packageId, channel, buildId, guestAdmission } = config.binding
        // `audience` stays the preserved logical scope; `endpoint` is where clients send every request.
        return Response.json({ schemaVersion: 1, audience, endpoint: config.binding.origin, siteId, packageId, channel, buildId, ...(guestAdmission ? { guestAdmission } : {}), claimAvailable: Boolean(config.account) }, { headers: { 'cache-control': 'no-store' } })
      }
      if (!paths.has(url.pathname)) return notFound()
      const from = request.headers.get('origin')
      const forbidden = (): Response => Response.json({ code: 'forbidden', message: 'This App origin is not allowed.' }, { status: 403, headers: { 'cache-control': 'no-store' } })
      if (url.pathname === IMPORT_PATH) { if (from !== null) return forbidden() }
      else if (url.pathname === '/world/guest-transfer/start') { if (!config.transfer || !from || !guestTransferOrigins(config.transfer.legacyOrigin, config.binding.origin).includes(from)) return forbidden() }
      else if (url.pathname !== '/world/health' && from !== config.binding.origin) return forbidden()
      const forwarded = new Request(request)
      // Replace client supplied values, including absent CF IP in local diagnostics.
      forwarded.headers.set('x-world-source', request.headers.get('cf-connecting-ip') ?? 'unknown')
      const id = env.WORLD.idFromName(worldKey(config.binding))
      return await env.WORLD.get(id).fetch(forwarded)
    } catch { return unavailable() }
  },
} satisfies ExportedHandler<Env>
