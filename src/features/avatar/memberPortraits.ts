import { ref, watch } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import { AVATAR_BODIES } from '../../shared/model.ts'
import type { AvatarBody, AvatarLook, FaceScan } from '../../shared/model.ts'
import { api, app, onAccountReset, onReconnect, onServerEvent } from '../../state/app.ts'

export const portraitAccessEpoch = ref(0)
const FACE_CACHE_LIMIT = 32
const PENDING_LIMIT = 64
const faces = new Map<string, FaceScan | null>()
interface FaceRequest { promise: Promise<FaceScan | null>; consumers: Set<AbortSignal> }
const requests = new Map<string, FaceRequest>()
let faceQueue: Promise<unknown> = Promise.resolve()
let clearRendered: (() => void) | null = null

/** Metadata-only fallback. Importing it never loads the avatar engine. */
export function stockPortraitUrl(body: AvatarBody): string {
  return `/avatars/${AVATAR_BODIES.includes(body) ? body : AVATAR_BODIES[0]}.jpg`
}

/** Clears access synchronously, including images held by visible consumers. */
export function invalidateMemberPortraits(): void {
  faces.clear()
  requests.clear()
  clearRendered?.()
  portraitAccessEpoch.value++
}

export function portraitWorkAllowed(): boolean {
  return typeof document !== 'undefined' && !document.hidden && app.link === 'online'
}

function authorizedFace(memberId: MemberId, version: number, epoch: number, signal: AbortSignal): Promise<FaceScan | null> {
  const viewer = app.me?.id
  if (!viewer || !portraitWorkAllowed()) return Promise.resolve(null)
  const key = `${viewer}:${memberId}:${version}`
  if (faces.has(key)) return Promise.resolve(faces.get(key) ?? null)
  const existing = requests.get(key)
  if (existing) { existing.consumers.add(signal); return existing.promise }
  if (requests.size >= PENDING_LIMIT) return Promise.resolve(null)
  const consumers = new Set([signal])
  const pending = faceQueue.then(async () => {
    if (epoch !== portraitAccessEpoch.value || viewer !== app.me?.id || !portraitWorkAllowed() || [...consumers].every(consumer => consumer.aborted)) return null
    let scan: FaceScan | null = null
    try { scan = (await api('member.face', { memberId, version })).scan } catch { /* Access denied or unavailable: retain the generic fallback. */ }
    if (epoch !== portraitAccessEpoch.value || viewer !== app.me?.id) return null
    faces.set(key, scan)
    while (faces.size > FACE_CACHE_LIMIT) {
      const oldest = faces.keys().next().value
      if (oldest === undefined) break
      faces.delete(oldest)
    }
    return scan
  })
  faceQueue = pending.catch(() => undefined)
  requests.set(key, { promise: pending, consumers })
  void pending.finally(() => { if (requests.get(key)?.promise === pending) requests.delete(key) })
  return pending
}

/** Visible consumers provide current look and identity; photos are fetched only by exact id/version. */
export async function loadMemberPortrait(options: {
  look: AvatarLook; memberId?: MemberId; face?: FaceScan | null; key: string; size: number; signal: AbortSignal
}): Promise<string> {
  const epoch = portraitAccessEpoch.value
  const viewer = app.me?.id
  const guard = (): void => {
    if (options.signal.aborted || epoch !== portraitAccessEpoch.value || viewer !== app.me?.id || !portraitWorkAllowed()) {
      throw new DOMException('Portrait cancelled', 'AbortError')
    }
  }
  guard()
  const look: AvatarLook = { ...options.look, face: options.look.face ? { ...options.look.face } : null,
    ...(options.look.appearance ? { appearance: { ...options.look.appearance } } : {}) }
  const face = options.memberId && look.face ? await authorizedFace(options.memberId, look.face.version, epoch, options.signal) : options.face ?? null
  guard()
  // Rejected access never falls back to a cached photo or to an obsolete face pointer.
  if (look.face && !face) return stockPortraitUrl(look.body)
  const renderer = await import('../../world/surfacePortrait.ts')
  clearRendered = renderer.clearAvatarPortraits
  guard()
  const image = await renderer.renderAvatarPortrait(look, face, {
    key: `${epoch}:${viewer ?? 'preview'}:${options.memberId ?? options.key}:${look.face?.version ?? 0}`,
    size: app.me?.preferences.powerMode === 'battery' || app.me?.preferences.quality === 'low' ? Math.min(options.size, 96) : options.size,
    signal: options.signal,
  })
  guard()
  return image
}

const stopReset = onAccountReset(invalidateMemberPortraits)
const stopReconnect = onReconnect(invalidateMemberPortraits)
const stopEvents = onServerEvent(event => {
  if (event.type === 'session.replaced' || event.type === 'presence.update'
    || (event.type === 'social.changed' && (event.scope === 'friends' || event.scope === 'intros'))) invalidateMemberPortraits()
})
const stopWatch = watch(() => [app.me?.id, app.me?.revision, app.me?.preferences.powerMode, app.me?.preferences.quality, app.actorKey, app.link, app.blocked.map(member => member.id).join(',')], invalidateMemberPortraits, { flush: 'sync' })
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', invalidateMemberPortraits)
if (import.meta.hot) import.meta.hot.dispose(() => {
  invalidateMemberPortraits()
  stopReset(); stopReconnect(); stopEvents(); stopWatch()
  document.removeEventListener('visibilitychange', invalidateMemberPortraits)
})
