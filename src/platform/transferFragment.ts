// The one-use transfer link (`#transfer=gtx_…`, contract 125), taken out of the address before
// anything else in the page can see it. This module imports nothing, and every entry imports it
// first, so it is evaluated before the router, the App and anything that could read or log the
// address. The code is kept in this module's memory only, handed over once, and never written to
// the address, storage or a log.
export type CapturedTransfer = { kind: 'none' } | { kind: 'malformed' } | { kind: 'code'; code: string }

const PREFIX = '#transfer='
let captured: CapturedTransfer = { kind: 'none' }

try {
  const hash = location.hash
  if (hash.startsWith(PREFIX)) {
    const value = hash.slice(PREFIX.length)
    captured = /^gtx_[A-Za-z0-9_-]{43}$/.test(value) ? { kind: 'code', code: value } : { kind: 'malformed' }
    // Same entry in the history, without the fragment: Back does not bring the code back either.
    history.replaceState(history.state, '', location.pathname + location.search)
  }
} catch { /* No address or history here (a worker, a probe): nothing is captured and nothing kept. */ }

/** The link this page was opened with, once. Every later call answers `none`. */
export function takeTransfer(): CapturedTransfer {
  const value = captured
  captured = { kind: 'none' }
  return value
}
