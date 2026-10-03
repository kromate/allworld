import type { GuestClaimResult, GuestSession, GuestStatus } from '../shared/guest.ts'
import { isGuestToken } from '../shared/guest.ts'
import { AVATAR_BODIES, WorldError } from '../shared/model.ts'
import { parseAvatarAppearance } from '../shared/appearance.ts'
import type { MemberId, Iso } from '../shared/ids.ts'
import { assertHostedRuntime } from './hostedService.ts'
import type { HostedWorldConfig } from './hostedService.ts'
import { worldUrl } from './worldEndpoint.ts'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export const guestStorageScope = (config: HostedWorldConfig): string => JSON.stringify([config.audience, config.siteId, config.packageId, config.channel])
const key = (config: HostedWorldConfig): string => `nw:guest:${guestStorageScope(config)}`
export type SessionChoice = 'guest' | 'account' | 'welcome'
const choices = new Map<string, SessionChoice>()
export function storedSessionChoice(config: HostedWorldConfig): SessionChoice | null {
  const scope = guestStorageScope(config)
  try {
    const value = localStorage.getItem(`nw:session-choice:${scope}`)
    if (value === 'guest' || value === 'account' || value === 'welcome') return value
  } catch { /* Keep the explicit choice in this tab when storage is unavailable. */ }
  return choices.get(scope) ?? null
}
export function rememberSessionChoice(config: HostedWorldConfig, choice: SessionChoice): void {
  const scope = guestStorageScope(config)
  choices.set(scope, choice)
  try { localStorage.setItem(`nw:session-choice:${scope}`, choice) } catch { /* No capability is stored in this preference. */ }
}
export function storedGuest(config: HostedWorldConfig): string | null {
  try { const token = localStorage.getItem(key(config)); return isGuestToken(token) ? token : null } catch { return null }
}
export function forgetGuest(config: HostedWorldConfig): void { try { localStorage.removeItem(key(config)) } catch { /* Storage may be unavailable on an opaque App preview. */ } }
export async function guestRequest(config: HostedWorldConfig, path: '/world/guest-session' | '/world/guest-claim' | '/world/guest-revoke', body: unknown, signal?: AbortSignal): Promise<unknown> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
  const response = await fetch(worldUrl(config, path), { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: bounded,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const fallback = response.status === 429 ? 'The world service is busy. Try again later.' : 'The world service is unavailable. Try again later.'
  let value: unknown
  try { value = await response.json() }
  catch (error) {
    if (bounded.aborted) throw error
    if (response.ok) throw new WorldError('unavailable', 'The world service returned an invalid reply. Try again.')
    throw new WorldError(response.status === 429 ? 'rate_limited' : 'unavailable', fallback)
  }
  if (!response.ok) {
    const code = object(value) && value.code === 'expired' ? 'expired' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 429 ? 'rate_limited' : 'unavailable'
    throw new WorldError(code, object(value) && typeof value.message === 'string' ? value.message : fallback)
  }
  return value
}
function status(value: unknown): GuestStatus {
  if (!object(value) || value.state !== 'guest' || typeof value.memberId !== 'string' || !/^m_guest_[A-Za-z0-9_-]+$/.test(value.memberId)
    || typeof value.createdAt !== 'string' || typeof value.lastSeenAt !== 'string' || typeof value.expiresAt !== 'string' || typeof value.endsAt !== 'string'
    || ![value.createdAt, value.lastSeenAt, value.expiresAt, value.endsAt].every(time => Number.isFinite(Date.parse(time)))) throw new WorldError('unavailable', 'Invalid guest session response.')
  return { state: 'guest', memberId: value.memberId as MemberId, createdAt: value.createdAt as Iso, lastSeenAt: value.lastSeenAt as Iso, expiresAt: value.expiresAt as Iso, endsAt: value.endsAt as Iso }
}
export async function openGuest(config: HostedWorldConfig, input: { token: string } | { admission?: string }, signal?: AbortSignal): Promise<GuestSession & { claimAvailable: boolean; persisted: boolean }> {
  const value = await guestRequest(config, '/world/guest-session', input, signal)
  if (!object(value)) throw new WorldError('unavailable', 'Invalid guest session response.')
  const token = 'token' in input ? input.token : value.token
  if (!isGuestToken(token)) throw new WorldError('unavailable', 'No guest capability was returned.')
  assertHostedRuntime(value.runtime, config)
  const guestStatus = status(value.status)
  let persisted = false
  try { localStorage.setItem(key(config), token); persisted = localStorage.getItem(key(config)) === token } catch { /* Report the storage limit; keep this tab usable. */ }
  return { token, status: guestStatus, claimAvailable: value.claimAvailable === true, persisted }
}
export async function submitGuestClaim(config: HostedWorldConfig, token: string, accountToken: string, signal?: AbortSignal): Promise<GuestClaimResult> {
  const value = await guestRequest(config, '/world/guest-claim', { token, accountToken }, signal)
  // Detailed conflict character data is subsequently read through the typed member API by the UI.
  if (!object(value)) throw new WorldError('unavailable', 'Invalid claim response.')
  if (value.outcome === 'claimed' && typeof value.memberId === 'string' && /^m_guest_[A-Za-z0-9_-]+$/.test(value.memberId)
    && typeof value.claimedAt === 'string' && Number.isFinite(Date.parse(value.claimedAt)) && typeof value.repeated === 'boolean') {
    return { outcome: 'claimed', memberId: value.memberId as MemberId, claimedAt: value.claimedAt as Iso, repeated: value.repeated }
  }
  if (value.outcome === 'conflict' && object(value.existing) && typeof value.existing.memberId === 'string'
    && typeof value.existing.displayName === 'string' && typeof value.existing.createdAt === 'string'
    && typeof value.existing.onboarded === 'boolean' && object(value.existing.look) && value.existing.look.face === null
    && Array.isArray(value.choices) && value.choices[0] === 'use-saved' && value.choices[1] === 'keep-guest') {
    const look = value.existing.look
    const body = AVATAR_BODIES.find(body => body === look.body)
    if (!body || (look.skin !== null && (typeof look.skin !== 'string' || !/^#[a-f0-9]{6}$/i.test(look.skin)))
      || typeof look.outfitHue !== 'number' || !Number.isFinite(look.outfitHue) || typeof look.height !== 'number' || !Number.isFinite(look.height)
      || (look.outfit !== undefined && look.outfit !== null && typeof look.outfit !== 'string')) throw new WorldError('unavailable', 'Invalid saved character response.')
    return { outcome: 'conflict', choices: ['use-saved', 'keep-guest'], existing: {
      memberId: value.existing.memberId as MemberId, displayName: value.existing.displayName, createdAt: value.existing.createdAt as Iso, onboarded: value.existing.onboarded,
      look: { body, skin: look.skin, outfitHue: look.outfitHue, height: look.height, outfit: look.outfit, face: null,
        ...(look.appearance ? { appearance: parseAvatarAppearance(look.appearance) } : {}) },
    } }
  }
  throw new WorldError('unavailable', 'Invalid claim response.')
}
