// Keep Tab inside an open dialog: from its last control to its first, and back. The rest of the page
// is inert while a dialog is open, but the window's own header buttons are outside the dialog.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export function trapTab(event: KeyboardEvent, root: HTMLElement | null): void {
  if (event.key !== 'Tab' || !root) return
  const controls = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.getClientRects().length > 0)
  if (!controls.length) { event.preventDefault(); root.focus(); return }
  const first = controls[0]!, last = controls[controls.length - 1]!
  const here = document.activeElement
  if (event.shiftKey && (here === first || here === root)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && here === last) { event.preventDefault(); first.focus() }
}
