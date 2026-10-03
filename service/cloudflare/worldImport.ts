// Operator-only, one-time import of a saved world into an empty target store.
//
// The import is the authority handoff: once it is accepted and durable, the target is the one
// writer and the source must never write again. Nothing here makes the source a writer, and a
// target that holds a receipt or any state refuses every further import.
//
// The saved world is taken as the exact text the source's store wrote (service/persist.ts): its
// SHA-256 must match the declared one, `$meta` is dropped the way `filePersistence.load` drops it,
// and every slice is kept as it was. Nothing is stripped or repaired: anything this helper will not
// accept is refused whole and the source is left as it is. In particular a photo face, its crop,
// mesh or landmark views, or any data URL is refused, never removed. A world that names any account
// owner is refused too, since the source's owners came from the old issuer and cannot be assumed to
// be the new one's accounts.
//
// Completion has two durable phases (root C13), and gameplay opens only after the second:
//
//   prepared  The exact imported world and a PREPARED receipt are written in one atomic step, then
//             the store syncs. The world is read back and checked against the receipt's slice
//             digest, scope, build and hash. No World exists yet, so nothing can have changed it.
//   verified  The receipt alone is replaced by a VERIFIED one, and the store syncs again. Only then
//             is the target ready and may the adapter construct the World.
//
// A PREPARED receipt never opens anything by itself: after a crash, a failed sync or a failed read-
// back the target stays closed until the same import (same id and hash, with the secret) resumes
// verification, which writes no world data. Nothing is reset, stripped or defaulted to recover.
// After VERIFIED the import digest is provenance only: gameplay changes the world and restarts
// normally, and nothing compares the current state with it again.
//
// The secret is external, compared in constant time, and forgotten once verified. Errors and the
// receipt carry digests and counts only, never a record.
import { createHash, timingSafeEqual } from 'node:crypto'
import { WorldError } from '../../src/shared/model.ts'

export interface ImportScope { audience: string; siteId: string; packageId: string; channel: 'test' | 'store' }
export interface ImportReceipt {
  importId: string
  /** SHA-256 of the exact text that was presented. */
  sha256: string
  bytes: number
  buildId: string
  /** The guest scope string the world carries, unchanged. */
  scope: string
  /** SHA-256 over the sorted list of [slice name, SHA-256 of the slice's JSON]. */
  sliceDigest: string
  slices: number
  counts: {
    members: number; guests: number; activeGuests: number; claimedGuests: number; owners: number
    /** Active guests whose capability hash is not in `hostedAdmission.tokens`: the listener refuses them, so they cannot move. */
    unadmittedActiveGuests: number
  }
  acceptedAt: string
  /** 'prepared' never opens gameplay. 'verified' is written only after the read-back matched. */
  phase: 'prepared' | 'verified'
  verifiedAt: string | null
  /** From here on the target is the only writer. */
  handoff: 'target-is-writer'
}
/** The native adapter's side. Each phase is one atomic write; `sync` resolves once everything written so far is durable. */
export interface ImportStore {
  /** The target's saved world as text, or null when it has none. */
  loadText(): Promise<string | null>
  receipt(): Promise<ImportReceipt | null>
  /** Phase 1: write the world text and the PREPARED receipt together, in one atomic step. */
  commitPrepared(text: string, receipt: ImportReceipt): Promise<void>
  /** Phase 2: replace the receipt alone with the VERIFIED one, in one atomic step. Writes no world data. */
  markVerified(receipt: ImportReceipt): Promise<void>
  sync(): Promise<void>
}
/** What a repeated, identical import is told once the target holds its receipt. No counts. */
export interface ImportReplay { imported: true; importId: string; sha256: string; sliceDigest: string; handoff: 'target-is-writer' }
export interface ImportRequest { secret: unknown; importId: unknown; scope: unknown; buildId: unknown; sha256: unknown; text: unknown }
export interface WorldImportOptions {
  store: ImportStore
  expected: { scope: ImportScope; buildId: string }
  /** The external import secret: at least 32 random bytes as base64url. Null when no import is allowed. */
  secret: string | null
  /** Largest text accepted. Default 64 MiB. */
  maxBytes?: number
  now?: () => number
}

const MAX_DEPTH = 64
/** Slices only a target makes. `worldImport` is reserved for an adapter that keeps the receipt as a slice. */
const TARGET_ONLY = ['accountSessions', 'guestTransfers', 'worldImport'] as const
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const refuse = (code: 'unauthorized' | 'invalid' | 'conflict' | 'forbidden' | 'unavailable', message: string): WorldError => new WorldError(code, message)
/** The guest scope string `service/guests.ts` and `service/hostedServer.ts` derive from a binding, in their key order. */
const guestScopeOf = (scope: ImportScope): Record<string, string> => ({ appId: scope.audience, packageId: scope.packageId, siteId: scope.siteId, channel: scope.channel })
const sameScope = (a: unknown, b: Record<string, string>): boolean =>
  object(a) && Object.keys(a).length === 4 && a.appId === b.appId && a.packageId === b.packageId && a.siteId === b.siteId && a.channel === b.channel

/** Canonical per-slice digest: what root compares between source and target without printing a record. */
export function sliceDigest(slices: Record<string, unknown>): string {
  return sha256(JSON.stringify(Object.keys(slices).sort().map(name => [name, sha256(JSON.stringify(slices[name]) ?? 'null')])))
}

/** Walk one slice: unsafe keys, depth, and anything that is or holds a picture. Counts only. */
function inspect(value: unknown): { unsafe: number; deep: boolean; pictures: number } {
  const out = { unsafe: 0, deep: false, pictures: 0 }
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length) {
    const [item, depth] = stack.pop()!
    if (depth > MAX_DEPTH) { out.deep = true; continue }
    // An image data URL, not any text that starts with "data:".
    if (typeof item === 'string') { if (/^\s*data:image\//i.test(item)) out.pictures++; continue }
    if (Array.isArray(item)) { for (const entry of item) stack.push([entry, depth + 1]); continue }
    if (!object(item)) continue
    // A face scan's shape, wherever it sits.
    if ('texture' in item && 'mesh' in item) out.pictures++
    for (const key of Object.keys(item)) {
      if (UNSAFE_KEYS.has(key)) out.unsafe++
      stack.push([item[key], depth + 1])
    }
  }
  return out
}

export function createWorldImport(options: WorldImportOptions) {
  const { store } = options
  const expected = options.expected
  if (!expected.buildId || !expected.scope.audience || !expected.scope.siteId || !expected.scope.packageId || (expected.scope.channel !== 'test' && expected.scope.channel !== 'store')) throw new Error('An exact import scope and build are required.')
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const now = options.now ?? Date.now
  const guestScope = guestScopeOf(expected.scope)
  const scopeText = JSON.stringify(guestScope)
  // Only the secret's digest is held, so a comparison takes the same time whatever is presented.
  let secretDigest: Buffer | null = options.secret && /^[A-Za-z0-9_-]{43,256}$/.test(options.secret) ? createHash('sha256').update(options.secret).digest() : null
  if (options.secret !== null && !secretDigest) throw new Error('The import secret must be at least 32 random bytes as base64url.')
  let open = false, busy = false

  /**
   * Call before constructing any World. Only a VERIFIED receipt opens gameplay. 'prepared' means an
   * import was written but not verified: stay closed, construct nothing, and let the same import resume.
   */
  async function ready(): Promise<'awaiting-import' | 'prepared' | 'imported'> {
    const receipt = await store.receipt()
    if (receipt?.phase === 'verified') { open = true; secretDigest = null; return 'imported' }
    return receipt ? 'prepared' : 'awaiting-import'
  }

  function validate(text: string): { slices: Record<string, unknown>; counts: ImportReceipt['counts'] } {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw refuse('invalid', 'The world text is not JSON.') }
    if (!object(parsed)) throw refuse('invalid', 'The world text is not a saved world.')
    const slices: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (name === '$meta') continue
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw refuse('invalid', 'The world has a slice with an unexpected name.')
      slices[name] = value
    }
    // Per slice, so a refusal names where to look without naming a record.
    const unsafe: string[] = [], pictured: string[] = []
    let pictures = 0
    for (const [name, value] of Object.entries(slices)) {
      const seen = inspect(value)
      if (seen.unsafe || seen.deep) unsafe.push(`${name}: ${seen.unsafe} unsafe keys${seen.deep ? ', nesting too deep' : ''}`)
      if (seen.pictures) { pictures += seen.pictures; pictured.push(`${name}: ${seen.pictures}`) }
    }
    if (unsafe.length) throw refuse('invalid', `The world has unsafe content (${unsafe.join('; ')}).`)
    // Private material: refused, never stripped.
    const members = slices.members
    if (!object(members) || !object(members.members)) throw refuse('invalid', 'The world has no member records.')
    const faces = object(members.faces) ? Object.keys(members.faces).length : members.faces === undefined ? 0 : 1
    let pointers = 0
    for (const entry of Object.values(members.members)) {
      const look = object(entry) && object(entry.profile) ? entry.profile.look : undefined
      if (object(look) && look.face !== null && look.face !== undefined) pointers++
    }
    if (faces || pointers || pictures) throw refuse('forbidden', `The world holds private photo material (${faces} face scans, ${pointers} face pointers, ${pictures} pictures${pictured.length ? ` in ${pictured.join(', ')}` : ''}). Nothing was imported; the source is unchanged.`)
    // Scope: the admission scope and every guest record name exactly this world. Nothing is rewritten.
    const admission = slices.hostedAdmission
    if (!object(admission) || admission.scope !== scopeText) throw refuse('forbidden', 'The world belongs to another App, site, package, channel or audience.')
    const guestSlice = slices.guests
    const guests = object(guestSlice) && object(guestSlice.guests) ? Object.values(guestSlice.guests) : []
    if (guestSlice !== undefined && (!object(guestSlice) || !object(guestSlice.guests) || !object(guestSlice.tokens) || !object(guestSlice.owners))) throw refuse('invalid', 'The guest records are not in the saved shape.')
    const foreign = guests.filter(rec => !object(rec) || !sameScope(rec.scope, guestScope)).length
    if (foreign) throw refuse('forbidden', `${foreign} guest records belong to another scope.`)
    // Owners: every one came from the old issuer. Cutover waits for a separately reviewed ownership migration.
    const owners = object(guestSlice) && object(guestSlice.owners) ? Object.keys(guestSlice.owners).length : 0
    const accountMembers = Object.keys(members.members).filter(id => id.startsWith('m_gm_')).length
    if (owners || accountMembers) throw refuse('conflict', `The world has ${owners} claimed-guest owners and ${accountMembers} account members from the old issuer. Import waits for a reviewed ownership migration.`)
    if (TARGET_ONLY.some(name => slices[name] !== undefined)) throw refuse('conflict', 'The world already carries target-only records.')
    const states = guests.map(rec => object(rec) ? rec.state : null)
    const admitted = new Set(object(admission.tokens) ? Object.keys(admission.tokens) : [])
    const unadmittedActiveGuests = guests.filter(rec => object(rec) && rec.state === 'active' && (typeof rec.tokenHash !== 'string' || !admitted.has(rec.tokenHash))).length
    return { slices, counts: {
      members: Object.keys(members.members).length, guests: guests.length,
      activeGuests: states.filter(state => state === 'active').length, claimedGuests: states.filter(state => state === 'claimed').length, owners, unadmittedActiveGuests,
    } }
  }

  const sameRequest = (receipt: ImportReceipt, request: ImportRequest): boolean => request.importId === receipt.importId && request.sha256 === receipt.sha256
  const failed = (step: string): WorldError => refuse('unavailable', `The import could not be ${step}. Gameplay stays closed; the same import can be sent again.`)

  /** The stored world and receipt are exactly what this receipt says was imported, and pass every import rule again. */
  async function verifyStored(receipt: ImportReceipt, phase: ImportReceipt['phase']): Promise<void> {
    const [back, stored] = await Promise.all([store.loadText(), store.receipt()])
    if (!stored || stored.phase !== phase || stored.importId !== receipt.importId || stored.sha256 !== receipt.sha256
      || stored.sliceDigest !== receipt.sliceDigest || stored.scope !== scopeText || stored.buildId !== expected.buildId) throw failed('read back')
    if (back === null) throw failed('read back')
    let slices: Record<string, unknown>
    try { slices = validate(back).slices } catch { throw failed('read back') }
    if (sliceDigest(slices) !== receipt.sliceDigest || Object.keys(slices).length !== receipt.slices) throw failed('read back')
  }

  /** Phase 2, from a PREPARED receipt: sync, read back, mark VERIFIED, sync, confirm. Writes no world data. */
  async function complete(prepared: ImportReceipt): Promise<ImportReceipt> {
    try { await store.sync() } catch { throw failed('made durable') }
    await verifyStored(prepared, 'prepared')
    const verified: ImportReceipt = { ...prepared, phase: 'verified', verifiedAt: new Date(now()).toISOString() }
    try { await store.markVerified(verified) } catch { throw failed('marked verified') }
    try { await store.sync() } catch { throw failed('made durable') }
    const stored = await store.receipt()
    if (!stored || stored.phase !== 'verified' || stored.importId !== verified.importId || stored.sliceDigest !== verified.sliceDigest) throw failed('marked verified')
    open = true
    secretDigest = null
    return verified
  }

  /** Everything about the request itself, before the target is looked at. */
  function checkRequest(request: ImportRequest): { importId: string; sha256: string; text: string; bytes: number } {
    if (typeof request.importId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(request.importId)) throw refuse('invalid', 'Give a 16 to 64 character import id.')
    const scope = request.scope
    if (!object(scope) || Object.keys(scope).length !== 4 || scope.audience !== expected.scope.audience || scope.siteId !== expected.scope.siteId
      || scope.packageId !== expected.scope.packageId || scope.channel !== expected.scope.channel) throw refuse('forbidden', 'The import is for another scope.')
    if (request.buildId !== expected.buildId) throw refuse('forbidden', 'The import is for another build.')
    if (typeof request.text !== 'string' || typeof request.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.sha256)) throw refuse('invalid', 'Give the world text and its SHA-256.')
    const bytes = Buffer.byteLength(request.text)
    if (bytes > maxBytes) throw refuse('invalid', `The world text is larger than ${maxBytes} bytes.`)
    if (sha256(request.text) !== request.sha256) throw refuse('invalid', 'The world text does not match its SHA-256.')
    return { importId: request.importId, sha256: request.sha256, text: request.text, bytes }
  }

  async function accept(request: ImportRequest): Promise<ImportReceipt | ImportReplay> {
    // The secret first, in constant time, before anything about the request is looked at or said.
    const presented = typeof request.secret === 'string' && request.secret.length <= 256 ? createHash('sha256').update(request.secret).digest() : Buffer.alloc(32)
    const matches = secretDigest !== null && timingSafeEqual(presented, secretDigest)
    const found = await store.receipt()
    if (found?.phase === 'verified') {
      // The same import asked again is told it happened, with digests only; anything else is refused. The secret was spent at verification.
      if (sameRequest(found, request)) return { imported: true, importId: found.importId, sha256: found.sha256, sliceDigest: found.sliceDigest, handoff: found.handoff }
      throw refuse('conflict', 'This world has already been imported. It is the only writer now.')
    }
    if (!matches) throw refuse('unauthorized', 'Import is not authorized.')
    if (busy) throw refuse('conflict', 'An import is already under way.')
    busy = true
    try {
      const checked = checkRequest(request)
      if (found) {
        // PREPARED and never opened: only the same import may resume, and it writes no world data.
        if (!sameRequest(found, request)) throw refuse('conflict', 'Another import was prepared here. It can only be resumed by the same import.')
        const { slices } = validate(checked.text)
        if (sliceDigest(slices) !== found.sliceDigest) throw refuse('conflict', 'Another import was prepared here. It can only be resumed by the same import.')
        return await complete(found)
      }
      const existing = await store.loadText()
      let occupied = false
      if (existing !== null && existing.trim() !== '') {
        try { occupied = Object.keys(JSON.parse(existing) as object).some(name => name !== '$meta') } catch { occupied = true }
      }
      if (occupied) throw refuse('conflict', 'The target already holds a world. Import only into an empty target.')
      const { slices, counts } = validate(checked.text)
      const prepared: ImportReceipt = {
        importId: checked.importId, sha256: checked.sha256, bytes: checked.bytes, buildId: expected.buildId, scope: scopeText,
        sliceDigest: sliceDigest(slices), slices: Object.keys(slices).length, counts, acceptedAt: new Date(now()).toISOString(),
        phase: 'prepared', verifiedAt: null, handoff: 'target-is-writer',
      }
      // Anything may have happened while the store was read: a receipt now means another import got there first.
      if (await store.receipt()) throw refuse('conflict', 'Another import was prepared here. It can only be resumed by the same import.')
      try { await store.commitPrepared(JSON.stringify(slices), prepared) } catch { throw failed('stored') }
      return await complete(prepared)
    } finally { busy = false }
  }

  return {
    ready, accept,
    /** False until a VERIFIED receipt is durable (now, or found by `ready`). Construct no World and refuse every ordinary route while false. */
    gameplayOpen: (): boolean => open,
  }
}
