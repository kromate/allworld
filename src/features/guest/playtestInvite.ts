// The invitation a shared private-playtest link carries: a fragment that is `#playtest=<pass>` and
// nothing else. Pure: strings in, strings out. Nothing here stores, logs or sends a pass, and the
// shape of one says nothing about whether the service will take it. The service alone decides that.

/** A pass in the shape the service asks for: 43 base64url characters. */
export type PlaytestPass = string & { readonly __brand: 'PlaytestPass' }

export type PlaytestFragment =
  /** Not a playtest fragment. The address is left exactly as it is. */
  | { kind: 'none' }
  /** A playtest fragment whose pass was cut short or added to. It is taken out of the address and never sent. */
  | { kind: 'malformed' }
  | { kind: 'invite'; pass: PlaytestPass }

const PREFIX = '#playtest='
const isPass = (value: string): value is PlaytestPass => /^[A-Za-z0-9_-]{43}$/.test(value)

/** `hash` is the address's fragment with its `#`, as `location.hash` gives it. It is read as text; nothing in it is decoded or run. */
export function readPlaytestFragment(hash: string): PlaytestFragment {
  if (!hash.startsWith(PREFIX)) return { kind: 'none' }
  const value = hash.slice(PREFIX.length)
  return isPass(value) ? { kind: 'invite', pass: value } : { kind: 'malformed' }
}

/** A path or URL without its fragment, when that fragment is a playtest one. Path and query are kept; any other address comes back unchanged. */
export function withoutPlaytestFragment(address: string): string {
  const at = address.indexOf('#')
  return at >= 0 && readPlaytestFragment(address.slice(at)).kind !== 'none' ? address.slice(0, at) : address
}
