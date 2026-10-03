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
import { GUEST_TRANSFER_PATHS } from '../guestTransfers.ts'
import { WorldError } from '../../src/shared/model.ts'

export interface Env {
  ASSETS: Fetcher
  WORLD: DurableObjectNamespace<WorldDurableObject>
  WORLD_BINDING: string
  WORLD_GUEST_ADMISSION: string
  /** Refused: standalone worlds never accept a remote identity exchange. */
  WORLD_REDEEM_URL?: string
  WORLD_CREATOR_CONFIG?: string
  WORLD_MAX_CONNECTIONS?: string
  /** Public provider config: {"projectId","projectNumber"}. */
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
      || Object.keys(provider).some(key => key !== 'projectId' && key !== 'projectNumber')) throw new Error('Invalid account provider configuration.')
    if (!/^[A-Za-z0-9_-]{43}$/.test(env.WORLD_SESSION_KEY ?? '')) throw new Error('The session key must be 32 random bytes as base64url.')
    const sessionKey = new Uint8Array(Buffer.from(env.WORLD_SESSION_KEY ?? '', 'base64url'))
    if (sessionKey.length !== 32) throw new Error('The session key must be 32 random bytes as base64url.')
    account = { provider: createFirebaseRestProvider({ projectId: provider.projectId, ...(provider.projectNumber ? { projectNumber: provider.projectNumber } : {}), apiKey: env.WORLD_FIREBASE_API_KEY ?? '',
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
      if (!url.pathname.startsWith('/world/')) {
        const asset = await env.ASSETS.fetch(request)
        if (asset.status !== 404 || !['GET', 'HEAD'].includes(request.method) || /\.[^/]+$/.test(decoded)) return asset
        const entry = new URL('/', url)
        return env.ASSETS.fetch(new Request(entry, request))
      }
      if (url.search || url.hash) return Response.json({ code: 'invalid', message: 'Query parameters are not accepted.' }, { status: 400 })
      const config = configuration(env)
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
      else if (url.pathname === '/world/guest-transfer/start') { if (!config.transfer || from !== config.transfer.legacyOrigin) return forbidden() }
      else if (url.pathname !== '/world/health' && from !== config.binding.origin) return forbidden()
      const forwarded = new Request(request)
      // Replace client supplied values, including absent CF IP in local diagnostics.
      forwarded.headers.set('x-world-source', request.headers.get('cf-connecting-ip') ?? 'unknown')
      const id = env.WORLD.idFromName(worldKey(config.binding))
      return await env.WORLD.get(id).fetch(forwarded)
    } catch { return unavailable() }
  },
} satisfies ExportedHandler<Env>
