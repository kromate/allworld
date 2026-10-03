// Device and viewport facts the HUD reacts to, and the three things it may ask of the browser on a
// press: full screen, a landscape lock inside it, and a once-per-session hint. Every browser call is
// optional: when it is missing or refused the HUD simply does not offer it, and nothing here assumes
// a phone can be locked (iOS cannot) or that a refused request is an error to show.
import { onBeforeUnmount, ref } from 'vue'
import type { Ref } from 'vue'

/** A media query as a ref, released with the calling component. */
export function useMedia(query: string): Ref<boolean> {
  const list = window.matchMedia(query)
  const matches = ref(list.matches)
  const update = (event: MediaQueryListEvent): void => { matches.value = event.matches }
  list.addEventListener('change', update)
  onBeforeUnmount(() => list.removeEventListener('change', update))
  return matches
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** "Show this once per session". Storage that throws (private modes) falls back to memory for this page. */
export function createOnce(key: string, store: () => Store | null): { seen(): boolean; mark(): void } {
  let remembered = false
  return {
    seen() {
      if (remembered) return true
      try { return store()?.getItem(key) === '1' } catch { return false }
    },
    mark() {
      remembered = true
      try { store()?.setItem(key, '1') } catch { /* memory only */ }
    },
  }
}

export interface FullscreenHost {
  fullscreenEnabled?: boolean
  fullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  exitFullscreen?: () => Promise<void>
  webkitExitFullscreen?: () => Promise<void> | void
  documentElement: { requestFullscreen?: (options?: { navigationUI?: 'hide' }) => Promise<void>; webkitRequestFullscreen?: () => Promise<void> | void }
}
export interface OrientationHost { orientation?: { lock?: (kind: 'landscape') => Promise<void> } }

export const fullscreenAvailable = (doc: FullscreenHost): boolean => Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)
export const inFullscreen = (doc: FullscreenHost): boolean => Boolean(doc.fullscreenElement || doc.webkitFullscreenElement)

/**
 * Enter or leave full screen. Call from a press only. Entering also asks for a landscape lock where
 * the browser has one, and ignores any refusal: the lock is a courtesy, never a requirement.
 */
export async function toggleFullscreen(doc: FullscreenHost, screenHost: OrientationHost): Promise<'entered' | 'left' | 'unsupported' | 'refused'> {
  if (!fullscreenAvailable(doc)) return 'unsupported'
  try {
    if (inFullscreen(doc)) {
      await (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)
      return 'left'
    }
    const request = doc.documentElement.requestFullscreen ?? doc.documentElement.webkitRequestFullscreen
    if (!request) return 'unsupported'
    await request.call(doc.documentElement)
  } catch { return 'refused' }
  try { await screenHost.orientation?.lock?.('landscape') } catch { /* iOS and desktops refuse; that is fine */ }
  return 'entered'
}
