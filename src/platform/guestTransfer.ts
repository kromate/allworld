// Moving a guest character here from the world's old address (contract 125). The old page started
// the move and sent only a one-use code; this side spends the code at the world's own endpoint and
// gets back the same guest capability, for the same member. Nothing here writes it anywhere: the
// session controller holds it in memory until the person confirms, and only then opens it through
// the normal guest path, which stores it under the usual key. The capability is a guest's and
// nothing else: it signs no one in and claims nothing.
import type { GuestStatus } from '../shared/guest.ts'
import { isGuestToken } from '../shared/guest.ts'
import type { Iso, MemberId } from '../shared/ids.ts'
import { WorldError } from '../shared/model.ts'
import { forgetGuest, guestStorageScope, rememberSessionChoice, storedGuest, storedSessionChoice } from './guestService.ts'
import type { SessionChoice } from './guestService.ts'
import type { HostedWorldConfig } from './hostedService.ts'
import { worldEndpoint, worldUrl } from './worldEndpoint.ts'

/** The moved guest. Held in memory by the caller and nowhere else until the person confirms. */
export interface ReceivedGuest { token: string; status: GuestStatus }
/** What this device held for this world before the move wrote anything. Raw values: kept private by the caller, never shown or made reactive. */
export interface DeviceHeld { guest: string | null; choice: SessionChoice | null }

/**
 * What is true after any failed or declined move, and no more: the world still keeps the character,
 * and the browser it came from still holds access. Whether the old address works again is not known
 * here, so nothing is promised about starting over from it.
 */
export const TRANSFER_KEPT = 'A failed move does not delete a character. Keep your original browser open; the old address may be unavailable.'
const AGAIN = TRANSFER_KEPT
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function statusOf(value: unknown): GuestStatus {
  if (!object(value) || value.state !== 'guest' || typeof value.memberId !== 'string' || !/^m_guest_[A-Za-z0-9_-]+$/.test(value.memberId)
    || typeof value.createdAt !== 'string' || typeof value.lastSeenAt !== 'string' || typeof value.expiresAt !== 'string' || typeof value.endsAt !== 'string'
    || ![value.createdAt, value.lastSeenAt, value.expiresAt, value.endsAt].every(time => Number.isFinite(Date.parse(time)))) throw new WorldError('unavailable', `The world returned an invalid reply. ${AGAIN}`)
  return { state: 'guest', memberId: value.memberId as MemberId, createdAt: value.createdAt as Iso, lastSeenAt: value.lastSeenAt as Iso, expiresAt: value.expiresAt as Iso, endsAt: value.endsAt as Iso }
}

/** Spend the code once. Never retried: a refusal is said as it is, with no promise about the old address. */
export async function consumeTransfer(config: HostedWorldConfig & { endpoint?: string }, code: string, signal?: AbortSignal): Promise<ReceivedGuest> {
  if (!/^gtx_[A-Za-z0-9_-]{43}$/.test(code)) throw new WorldError('invalid', `The transfer link is incomplete, so it was not used. ${AGAIN}`)
  let url: string
  try {
    // Only the world's own new address takes the code; this page must be that address exactly.
    if (worldEndpoint(config) !== location.origin) throw new Error('elsewhere')
    url = worldUrl(config, '/world/guest-transfer/consume')
  } catch { throw new WorldError('unavailable', `This page is not the world's address, so the transfer link was not used. ${AGAIN}`) }
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  let response: Response
  try {
    // A guest route never carries the account cookie.
    response = await fetch(url, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: bounded,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new WorldError('unavailable', `The world could not be reached, so the move may not have happened. ${AGAIN}`)
  }
  let value: unknown
  try { value = await response.json() } catch (error) { if (signal?.aborted) throw error }
  if (!response.ok) {
    switch (response.status) {
      case 401: throw new WorldError('unauthorized', `This transfer link was already used, or is not valid here. ${AGAIN}`)
      case 410: throw new WorldError('expired', `This transfer link ran out of time. ${AGAIN}`)
      case 403: throw new WorldError('forbidden', `The world did not admit this character here. ${AGAIN}`)
      case 429: throw new WorldError('rate_limited', `Too many tries just now. Wait a minute. ${AGAIN}`)
      default: throw new WorldError('unavailable', `The world could not finish the move. ${AGAIN}`)
    }
  }
  if (!object(value) || !isGuestToken(value.token)) throw new WorldError('unavailable', `The world returned an invalid reply. ${AGAIN}`)
  return { token: value.token, status: statusOf(value.status) }
}

/** The guest key `openGuest` writes (src/platform/guestService.ts). It is a saved format and does not change. */
const guestKey = (config: HostedWorldConfig): string => `nw:guest:${guestStorageScope(config)}`

export function deviceHeld(config: HostedWorldConfig): DeviceHeld {
  return { guest: storedGuest(config), choice: storedSessionChoice(config) }
}

/** What the moved character would replace here. Either one needs the person's explicit choice. */
export function transferReplaces(held: DeviceHeld, token: string): { guest: boolean; account: boolean } {
  return { guest: held.guest !== null && held.guest !== token, account: held.choice === 'account' }
}

/**
 * The moved character did not open. Put back what this move replaced, and only where nothing else
 * has written since: a newer choice made in another tab is left as it is.
 */
export function restoreDevice(config: HostedWorldConfig, held: DeviceHeld, token: string): void {
  if (held.guest !== token && storedGuest(config) === token) {
    if (held.guest) { try { localStorage.setItem(guestKey(config), held.guest) } catch { /* storage unavailable: nothing was kept to undo */ } }
    else forgetGuest(config)
  }
  if (held.choice && held.choice !== 'guest' && storedSessionChoice(config) === 'guest') rememberSessionChoice(config, held.choice)
}
