// Bringing something into view inside a game window.
//
// `scrollIntoView` and a plain `focus()` scroll every ancestor they can, including the clipped
// layers behind the window. On a phone that slides the whole sheet off the screen. These helpers
// move only the window's own scrolling body.
import { app } from '../../state/app.ts'

const calm = (): boolean => Boolean(app.me?.preferences.reducedMotion) || window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Scrolls the window body until `element` can be seen.
 * `nearest` moves as little as possible and leaves room for a bar stuck to the bottom of the window.
 */
export function reveal(element: HTMLElement | null | undefined, align: 'start' | 'center' | 'nearest' = 'nearest'): void {
  const scroller = element?.closest<HTMLElement>('.panel-body')
  if (!element || !scroller) return
  const box = element.getBoundingClientRect(), view = scroller.getBoundingClientRect()
  const margin = 12, bar = 96
  let shift = 0
  if (align === 'start') shift = box.top - view.top - margin
  else if (align === 'center') shift = box.top - view.top - Math.max(margin, (view.height - box.height) / 2)
  else if (box.top < view.top + margin || box.height > view.height - bar) shift = box.top - view.top - margin
  else if (box.bottom > view.bottom - bar) shift = box.bottom - (view.bottom - bar)
  if (Math.abs(shift) < 1) return
  scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: calm() ? 'auto' : 'smooth' })
}

/** Moves the keyboard focus to `element` and shows it, without shifting anything outside the window body. */
export function focusIn(element: HTMLElement | null | undefined): void {
  if (!element) return
  element.focus({ preventScroll: true })
  reveal(element)
}
