// Device and viewport facts the HUD reacts to, and the things it may ask of the browser on a
// press: full screen and a once-per-session hint. Fullscreen never locks orientation or the keyboard.
// Capability and refusal are reported to the control; browser change events own the displayed state.
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
export const fullscreenAvailable = (doc: FullscreenHost): boolean => Boolean(
  (doc.fullscreenEnabled && doc.documentElement.requestFullscreen) ||
  (doc.webkitFullscreenEnabled && doc.documentElement.webkitRequestFullscreen),
)
export const inFullscreen = (doc: FullscreenHost): boolean => Boolean(doc.fullscreenElement || doc.webkitFullscreenElement)

/** Request from a direct press only. The document stays mounted, including dialogs and forms. */
export async function toggleFullscreen(doc: FullscreenHost): Promise<'requested' | 'left' | 'unsupported' | 'refused'> {
  try {
    // Exiting must remain available even if the browser's capability flag changes while full screen.
    if (inFullscreen(doc)) {
      const exit = doc.fullscreenElement ? doc.exitFullscreen : doc.webkitExitFullscreen
      if (!exit) return 'refused'
      await exit.call(doc)
      return 'left'
    }
    if (!fullscreenAvailable(doc)) return 'unsupported'
    if (doc.fullscreenEnabled && doc.documentElement.requestFullscreen) {
      await doc.documentElement.requestFullscreen({ navigationUI: 'hide' })
    } else {
      await doc.documentElement.webkitRequestFullscreen?.()
    }
    return 'requested'
  } catch { return 'refused' }
}
