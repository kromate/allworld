// One-use transfer of an existing guest from the legacy page origin to the new serving origin.
//
// The guest's scope is not touched: the world keeps its stable audience, so the same capability
// keeps meaning the same member. What moves is the capability itself, from the old origin's
// storage to the new one's, without ever being put in a URL:
//
//   start    The legacy page presents its capability to this service, from the legacy Origin, the
//            one Origin this route accepts (non-credentialed CORS). The capability is checked like
//            any resume. A random code is issued; only its SHA-256 is kept, beside the capability
//            sealed for 120 seconds under the auth seal key with an AAD naming this transfer.
//   consume  The new page sends the code from its URL fragment, from the target Origin only. The
//            record is consumed and its seal erased in one step, the durable sync runs, the guest
//            is checked again, and only then is the same capability answered.
//
// The old capability is never revoked here: a lost final answer is recovered by starting again from
// the legacy page. A claimed, revoked or expired guest is never brought back: the guest service
// decides that at start, at consume, and again after the sync. Nothing here touches an account, and
// nothing here logs a capability, a code or a body.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isGuestToken } from '../src/shared/guest.ts'
import type { GuestStatus } from '../src/shared/guest.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { GuestService } from './guests.ts'
import type { World } from './kernel.ts'

export const GUEST_TRANSFER = {
  ttlMs: 120_000,
  /** Code records (open and consumed) one world holds at a time. */
  capacity: 1024,
  perGuest: 3,
  start: { perSource: 6, overall: 120, windowMs: 60_000 },
  consume: { perSource: 30, windowMs: 60_000 },
  bodyLimit: 6144,
} as const
export const GUEST_TRANSFER_PATHS: ReadonlySet<string> = new Set(['/world/guest-transfer/start', '/world/guest-transfer/consume'])
const CODE = /^gtx_[A-Za-z0-9_-]{43}$/
const SWEEP_EVERY_MS = 5000

export interface GuestTransferOptions {
  world: World
  guests: GuestService
  /** Exact HTTPS origin of the legacy page. Accepted on start only. */
  legacyOrigin: string
  /** Exact HTTPS origin the App is now served from. Accepted on consume only. */
  targetOrigin: string
  /** The existing 32-byte auth seal key. Never in state. */
  sealKey: Uint8Array
  /** The listener's own admission check for a capability. Throws when it is not admitted. */
  admitted: (token: string) => void
  /** Durable barrier: resolves (or returns) only once the consumed record is stored. */
  sync: () => void | Promise<void>
  now?: () => number
  capacity?: number
}
export interface TransferRequest {
  path: string
  method: string
  origin: string | undefined
  contentType?: string | undefined
  accessControlRequestMethod?: string | undefined
  accessControlRequestHeaders?: string | undefined
  /** The body as text, already bounded by the listener. */
  body: string
  /** The listener's rate key for the caller. Not identity. */
  source: string
}
export interface TransferAnswer { status: number; headers: Record<string, string>; body: string | null }

interface TransferRecord {
  memberId: MemberId
  target: string
  expiresAt: number
  state: 'open' | 'consumed'
  /** Erased when the record is consumed. */
  sealed: { keyId: string; nonce: string; ciphertext: string } | null
}
interface TransferSlice { scope: string; records: Record<string, TransferRecord> }

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function exactOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Transfer origins must be exact HTTPS origins.')
  return value
}
const REFUSED = 'This transfer link is not valid. Open your old Allworld page and choose Continue with my character again.'
const registered = new WeakSet<World>()

/** Preserve the original hosted origin only during this exact approved v1 transition. */
export function guestTransferOrigins(legacyOrigin: string, targetOrigin: string): readonly string[] {
  const legacy = exactOrigin(legacyOrigin), target = exactOrigin(targetOrigin)
  if (legacy === target) throw new Error('The legacy and target origins must differ.')
  return target === 'https://v1.joinallworld.com' && legacy === 'https://joinallworld.com'
    ? [legacy, 'https://allworld.akpananthony33.workers.dev'] : [legacy]
}

export function createGuestTransfers(options: GuestTransferOptions) {
  const { world, guests } = options
  if (registered.has(world)) throw new Error('Guest transfers registered twice on one world.')
  const target = exactOrigin(options.targetOrigin)
  const legacy = guestTransferOrigins(options.legacyOrigin, target)
  if (options.sealKey.length !== 32) throw new Error('The seal key must be exactly 32 bytes.')
  const key = Buffer.from(options.sealKey)
  const keyId = createHash('sha256').update('allworld-guest-transfer-key-id\n').update(key).digest('hex').slice(0, 16)
  const scope = JSON.stringify([guests.scope.appId, guests.scope.packageId, guests.scope.siteId, guests.scope.channel])
  const now = options.now ?? (() => world.now())
  const capacity = options.capacity ?? GUEST_TRANSFER.capacity
  registered.add(world)

  const slice = (): TransferSlice => world.slice<TransferSlice>('guestTransfers', () => ({ scope, records: {} }))
  const aad = (hash: string, rec: Pick<TransferRecord, 'memberId' | 'target' | 'expiresAt'>): Buffer =>
    Buffer.from(JSON.stringify(['allworld-guest-transfer', 1, keyId, hash, rec.memberId, rec.target, scope, rec.expiresAt]))
  function seal(token: string, hash: string, rec: Pick<TransferRecord, 'memberId' | 'target' | 'expiresAt'>): NonNullable<TransferRecord['sealed']> {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(aad(hash, rec))
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()])
    return { keyId, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') }
  }
  function unseal(hash: string, rec: TransferRecord): string {
    const sealed = rec.sealed
    if (!sealed || sealed.keyId !== keyId) throw new WorldError('unauthorized', REFUSED)
    const nonce = Buffer.from(sealed.nonce, 'base64url'), data = Buffer.from(sealed.ciphertext, 'base64url')
    if (nonce.length !== 12 || data.length <= 16) throw new WorldError('unauthorized', REFUSED)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAAD(aad(hash, rec)); decipher.setAuthTag(data.subarray(data.length - 16))
      return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8')
    } catch { throw new WorldError('unauthorized', REFUSED) }
  }
  /** Drop every record past its expiry, open or consumed, seal and all. A consumed one is kept until then so a replay is refused. */
  function sweep(state: TransferSlice, at: number): void {
    for (const [hash, rec] of Object.entries(state.records)) if (rec.expiresAt <= at) { rec.sealed = null; delete state.records[hash]; world.touch() }
  }
  // No expired seal waits for the next start: it leaves saved state, backups and exports within seconds.
  let lastSweep = -Infinity
  world.onTick(at => {
    if (at - lastSweep < SWEEP_EVERY_MS) return
    lastSweep = at
    const state = world.peek<TransferSlice>('guestTransfers')
    if (state && Object.values(state.records).some(rec => rec.expiresAt <= at)) world.scoped(() => sweep(slice(), at))
  })
  /** Active, unclaimed, admitted guest of this scope, or a refusal. Looks only; moves nothing. */
  function stillGuest(token: string, memberId: MemberId): GuestStatus {
    options.admitted(token)
    const status = guests.status(memberId)
    if (!status || !guests.isGuest(memberId)) throw new WorldError('unauthorized', REFUSED)
    return status
  }

  function start(token: unknown, source: string): { code: string; expiresAt: number; next: string } {
    world.limit(`guest-transfer-start:${source}`, GUEST_TRANSFER.start.perSource, GUEST_TRANSFER.start.windowMs)
    world.limit('guest-transfer-start', GUEST_TRANSFER.start.overall, GUEST_TRANSFER.start.windowMs)
    if (!isGuestToken(token)) throw new WorldError('unauthorized', 'This guest session is not valid. Start again as a guest, or sign in.')
    options.admitted(token)
    // The guest service's own check: scope, state, expiry and its attempt limit. Claimed, revoked or expired refuse here.
    const { actor } = guests.resume({ token, source })
    return world.scoped(() => {
      const at = now()
      const state = slice()
      if (state.scope !== scope) throw new WorldError('unavailable', 'Transfers are not available for this world.')
      sweep(state, at)
      const records = Object.values(state.records)
      if (records.length >= capacity) throw new WorldError('unavailable', 'Too many transfers are under way. Try again in a minute.')
      if (records.filter(rec => rec.memberId === actor.memberId && rec.state === 'open').length >= GUEST_TRANSFER.perGuest) throw new WorldError('rate_limited', 'You are doing that too quickly. Wait a moment and try again.')
      stillGuest(token, actor.memberId)
      let code: string, hash: string
      do { code = `gtx_${randomBytes(32).toString('base64url')}`; hash = digest(code) } while (state.records[hash])
      const shape = { memberId: actor.memberId, target, expiresAt: at + GUEST_TRANSFER.ttlMs }
      state.records[hash] = { ...shape, state: 'open', sealed: seal(token, hash, shape) }
      world.touch()
      return { code, expiresAt: shape.expiresAt, next: `${target}/#transfer=${code}` }
    })
  }

  async function consume(code: unknown, source: string): Promise<{ token: string; status: GuestStatus }> {
    world.limit(`guest-transfer-consume:${source}`, GUEST_TRANSFER.consume.perSource, GUEST_TRANSFER.consume.windowMs)
    if (typeof code !== 'string' || !CODE.test(code)) throw new WorldError('unauthorized', REFUSED)
    const hash = digest(code)
    // One synchronous step: nothing else can consume, claim or revoke between the look and the mark.
    const taken = world.scoped(() => {
      const at = now()
      const state = slice()
      const rec = state.records[hash]
      if (!rec || state.scope !== scope || rec.state !== 'open') throw new WorldError('unauthorized', REFUSED)
      if (rec.expiresAt <= at) {
        delete state.records[hash]; world.touch()
        throw new WorldError('expired', 'This transfer link has expired. Open your old Allworld page and choose Continue with my character again.')
      }
      if (rec.target !== target) throw new WorldError('unauthorized', REFUSED)
      const token = unseal(hash, rec)
      rec.state = 'consumed'; rec.sealed = null
      world.touch()
      if (!isGuestToken(token)) throw new WorldError('unauthorized', REFUSED)
      stillGuest(token, rec.memberId)
      return { token, memberId: rec.memberId }
    })
    const unsaved = (): WorldError => new WorldError('unavailable', 'The world could not save the transfer. Open your old Allworld page and choose Continue with my character again.')
    try { await options.sync() } catch { throw unsaved() }
    // A store that failed or was taken over while the sync ran has acknowledged nothing.
    if (world.superseded || world.saveStats.lastError !== null) throw unsaved()
    // Anything may have happened while the sync ran. A claim, a revocation or an expiry wins.
    const status = world.scoped(() => stillGuest(taken.token, taken.memberId))
    return { token: taken.token, status }
  }

  const base = (extra: Record<string, string> = {}): Record<string, string> =>
    ({ 'content-type': 'application/json', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', ...extra })
  function answer(status: number, body: unknown, extra?: Record<string, string>): TransferAnswer {
    return { status, headers: base(extra), body: JSON.stringify(body) }
  }
  function failure(error: unknown, extra?: Record<string, string>): TransferAnswer {
    const code = error instanceof WorldError ? error.code : 'unavailable'
    const status = code === 'rate_limited' ? 429 : code === 'expired' ? 410 : code === 'invalid' ? 400 : code === 'unavailable' ? 503 : code === 'forbidden' ? 403 : 401
    return answer(status, { code, message: error instanceof WorldError ? error.message : 'The service could not authorize this request.' }, extra)
  }
  function parse(request: TransferRequest, field: 'token' | 'code'): unknown {
    if (request.contentType?.split(';')[0]?.trim() !== 'application/json') throw new WorldError('invalid', 'Use a JSON request.')
    if (Buffer.byteLength(request.body) > GUEST_TRANSFER.bodyLimit) throw new WorldError('invalid', 'The request is too large.')
    let value: unknown
    try { value = JSON.parse(request.body) } catch { throw new WorldError('invalid', 'Invalid JSON request.') }
    if (!object(value) || Object.keys(value).some(name => name !== field)) throw new WorldError('invalid', 'Unexpected request field.')
    return value[field]
  }

  /** The two routes, for any listener. Null for any other path. Never reads or sets a cookie. */
  async function respond(request: TransferRequest): Promise<TransferAnswer | null> {
    if (request.path === '/world/guest-transfer/start') {
      if (!request.origin || !legacy.includes(request.origin)) return failure(new WorldError('forbidden', 'This page origin is not allowed.'))
      const cors = { 'access-control-allow-origin': request.origin, vary: 'Origin' }
      try {
        if (request.method === 'OPTIONS') {
          const headers = (request.accessControlRequestHeaders ?? '').toLowerCase().split(',').map(value => value.trim())
          if (request.accessControlRequestMethod !== 'POST' || headers.some(value => value !== 'content-type' && value !== '')) throw new WorldError('forbidden', 'Preflight is not allowed.')
          return { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'Content-Type', 'access-control-max-age': '300', 'cache-control': 'no-store' }, body: null }
        }
        if (request.method !== 'POST') throw new WorldError('invalid', 'Use POST.')
        return answer(200, start(parse(request, 'token'), request.source), cors)
      } catch (error) { return failure(error, cors) }
    }
    if (request.path === '/world/guest-transfer/consume') {
      try {
        if (request.origin !== target) throw new WorldError('forbidden', 'This page origin is not allowed.')
        if (request.method !== 'POST') throw new WorldError('invalid', 'Use POST.')
        return answer(200, await consume(parse(request, 'code'), request.source))
      } catch (error) {
        const refused = failure(error)
        return error instanceof WorldError && error.message === 'Use POST.' ? { ...refused, status: 405 } : refused
      }
    }
    return null
  }

  return {
    start, consume, respond,
    counts(): { open: number; consumed: number; capacity: number } {
      const records = Object.values(world.peek<TransferSlice>('guestTransfers')?.records ?? {})
      return { open: records.filter(rec => rec.state === 'open').length, consumed: records.filter(rec => rec.state === 'consumed').length, capacity }
    },
  }
}
