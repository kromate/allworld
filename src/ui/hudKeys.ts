// What a key means on the world screen, as plain functions so the rules about typing, native
// activation and open overlays can be run without a browser. The stage and every component that
// listens for a world key use the same tests, so a letter typed into a field never walks the avatar,
// and Enter or Space on a focused button or link is left to the button.

export interface KeyFacts {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  /** `tagName` of the focused element, upper case, or '' when there is none. */
  tag: string
  editable: boolean
  /** The focused element is something Enter or Space activates natively: a button, link, summary, or an ARIA control. */
  interactive: boolean
  /** Another listener already handled this key. */
  handled: boolean
  /** The key is being held down. */
  repeat: boolean
}

export type WorldKey = 'interact' | 'chat' | 'places' | 'people' | 'help' | 'wave'

export const isTyping = (facts: Pick<KeyFacts, 'tag' | 'editable'>): boolean => facts.editable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(facts.tag)

const ACTIVATES = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="option"], [role="link"]'
export const factsOf = (event: KeyboardEvent): KeyFacts => {
  const target = event.target as HTMLElement | null
  return {
    key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, tag: target?.tagName ?? '', editable: Boolean(target?.isContentEditable),
    interactive: Boolean(target?.closest?.(ACTIVATES)), handled: event.defaultPrevented, repeat: event.repeat,
  }
}

/**
 * `covered`: something in front holds the world's keys (gameInput's `keysBlocked`). `ready`: the scene is standing.
 * A key another listener already handled, a key held down, and Enter or Space meant for a focused control are never the world's.
 */
export function worldKey(facts: KeyFacts, state: { covered: boolean; ready: boolean }): WorldKey | null {
  if (isTyping(facts) || state.covered || !state.ready || facts.metaKey || facts.ctrlKey || facts.altKey || facts.handled || facts.repeat) return null
  if (facts.interactive && (facts.key === 'Enter' || facts.key === ' ')) return null
  switch (facts.key) {
    case 'Enter': return 'chat'
    case 'e': case 'E': return 'interact'
    case 'l': case 'L': return 'places'
    case 'p': case 'P': return 'people'
    case '?': return 'help'
    case 'g': case 'G': return 'wave'
    default: return null
  }
}

/**
 * For a component that owns one more world key (F, J, N, G). True only for a plain, first press of one of
 * `keys`, with nobody typing, nothing else having handled it, and `allowed` (the caller's gameInput `permits`) true.
 */
export function hotkey(facts: KeyFacts, keys: readonly string[], allowed: boolean): boolean {
  if (!allowed || isTyping(facts) || facts.metaKey || facts.ctrlKey || facts.altKey || facts.handled || facts.repeat) return false
  return keys.includes(facts.key)
}
