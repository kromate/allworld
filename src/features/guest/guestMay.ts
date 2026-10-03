// One question for any window: may whoever is playing here send this operation? A member may send
// anything; for a guest the answer is the contract's own (`guestAccess`), which the service applies
// too. Windows use it to leave out what would only be refused, never as the enforcement.
import { guestAccess } from '../../shared/guest.ts'
import type { GuestAccess } from '../../shared/guest.ts'
import { app } from '../../state/app.ts'

/** True for a member; for a guest, whether the policy opens `op` with this input. */
export const guestMay = (op: string, input?: unknown): boolean => !app.guest || guestAccess(op, input).allowed

/** The refusal to show a guest, with the contract's sentence. Null for a member, and when the operation is open. */
export function guestRefusal(op: string, input?: unknown): Extract<GuestAccess, { allowed: false }> | null {
  if (!app.guest) return null
  const access = guestAccess(op, input)
  return access.allowed ? null : access
}
