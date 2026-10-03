// What the shell shares with the things it frames: the list of sections (the bar, the More menu and
// the keyboard shortcuts all read it) and the half-height sheet a page can ask about.
import type { ComputedRef, InjectionKey } from 'vue'
import type { HudIconName } from './hudIcons.ts'

export interface NavItem {
  to: string
  label: string
  /** Drawn by HudIcon: the one icon set for the bar, the menu and the world screen. */
  glyph: HudIconName
  /** The old emoji. Nothing draws it any more; `FEEDBACK_NAV` still carries one, so the field stays optional. */
  icon?: string
  /** Keyboard shortcut. Empty when the section has none. */
  key: string
  /** One of the five always on the bar. The rest sit under More on a narrow screen. */
  primary?: boolean
  /** Reached from More only: on a wide screen the mini-map and the player chip already lead there. */
  menuOnly?: boolean
}

export const NAV: readonly NavItem[] = [
  { to: '/', label: 'World', glyph: 'globe', key: '1', primary: true },
  { to: '/people', label: 'People', glyph: 'people', key: '3', primary: true },
  { to: '/messages', label: 'Chat', glyph: 'chat', key: 'm', primary: true },
  { to: '/work', label: 'Work', glyph: 'work', key: '5', primary: true },
  { to: '/arena', label: 'Games', glyph: 'dice', key: '6', primary: true },
  { to: '/travel', label: 'Travel', glyph: 'plane', key: '2' },
  { to: '/home', label: 'Home', glyph: 'home', key: '9' },
  { to: '/inbox', label: 'Inbox', glyph: 'bell', key: '0' },
  { to: '/communities', label: 'Groups', glyph: 'groups', key: '4' },
  { to: '/market', label: 'Market', glyph: 'bag', key: '7' },
  { to: '/jobs', label: 'Jobs', glyph: 'clipboard', key: '8' },
  { to: '/map', label: 'Map', glyph: 'map', key: '', menuOnly: true },
  { to: '/settings', label: 'Settings', glyph: 'sliders', key: ',', menuOnly: true },
  { to: '/feedback', label: 'Feedback', glyph: 'note', key: '', menuOnly: true },
]

/**
 * The section a path belongs to. A route may name it (`meta.nav`) when its own path does not say:
 * the older quick games live under Games.
 */
export function sectionOf(path: string, named?: unknown): string {
  if (typeof named === 'string') return named
  if (path === '/') return '/'
  return NAV.find(item => item.to !== '/' && (path === item.to || path.startsWith(`${item.to}/`)))?.to ?? ''
}

/**
 * On a phone a page can sit in the lower half of the screen with the world live above it. The
 * shell decides when (`capable`), the page header offers the button that grows it to full height.
 */
export interface Sheet {
  /** This page may be a half-height sheet right now. */
  capable: ComputedRef<boolean>
  /** It is one right now: the world above it is drawn. False once grown to full height. */
  half: ComputedRef<boolean>
  toggle(): void
}
export const SHEET: InjectionKey<Sheet> = Symbol('sheet')
