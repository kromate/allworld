// Session lifetimes measured on one clock at a time (contract 135). The server says how long a grant,
// session or lease lasts as two readings of its own clock (`serverTime`, `expiresAt`); only their
// difference is used here. This page then counts that many milliseconds on its own monotonic clock,
// from a moment taken before the request was sent. A server epoch is never compared with the
// browser's wall clock, which may be minutes off or jump.

/** No grant, session or lease the browser accepts lasts longer than this, by the server's own reckoning. */
export const MAX_SERVER_LIFETIME_MS = 30_000

/** `expiresAt - serverTime` from a server answer, or null unless both are safe integers and 0 < lifetime <= 30 s. */
export function serverRelativeLifetime(value: Record<string, unknown>): number | null {
  const { serverTime, expiresAt } = value
  if (typeof serverTime !== 'number' || typeof expiresAt !== 'number' || !Number.isSafeInteger(serverTime) || !Number.isSafeInteger(expiresAt)) return null
  const lifetime = expiresAt - serverTime
  return lifetime > 0 && lifetime <= MAX_SERVER_LIFETIME_MS ? lifetime : null
}

/** Milliseconds on this page's monotonic clock. Not an epoch: only the difference between two readings means anything. */
export const monotonicNow = (): number => performance.now()
