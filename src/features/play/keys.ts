// Keyboard handling for the play windows. The world behind a window listens on `window` too
// (walking, chat on Enter, dock shortcuts on digits), so a game claims its keys before those
// listeners see them: a capture listener on `window` that stops the event when it was handled.
import { onBeforeUnmount, onMounted } from 'vue'

const isField = (element: HTMLElement): boolean => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable

/**
 * `handle` returns true when it used the key. Without a handler this still keeps Enter working
 * on the buttons and links of the open window, which the world would otherwise take for chat.
 */
export function usePlayKeys(handle?: (event: KeyboardEvent) => boolean): void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target && isField(target)) return
    if (handle?.(event)) { event.preventDefault(); event.stopPropagation(); return }
    if (event.key === 'Enter' && target?.closest('button, a, summary') && target.closest('.panel-page')) event.stopPropagation()
  }
  onMounted(() => window.addEventListener('keydown', onKey, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
}
