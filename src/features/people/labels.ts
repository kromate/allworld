// Words, icons and tones shared by the people, meetup and community windows.
import type { Directive } from 'vue'
import type { GameKind } from '../../shared/play.ts'
import type { CommunityRole, CommunityTopic, MeetupAnswer, MeetupStatus } from '../../shared/social.ts'

export type Tone = '' | 'amber' | 'sky' | 'leaf' | 'grape' | 'coral'

const TOPICS: Record<CommunityTopic, { label: string; icon: string; tone: Tone }> = {
  neighbours: { label: 'Neighbours', icon: '🏘', tone: 'amber' },
  games: { label: 'Games', icon: '🎮', tone: 'grape' },
  makers: { label: 'Makers', icon: '🛠', tone: 'sky' },
  food: { label: 'Food', icon: '🍲', tone: 'coral' },
  sport: { label: 'Sport', icon: '⚽', tone: 'leaf' },
  music: { label: 'Music', icon: '🎵', tone: 'grape' },
  work: { label: 'Work', icon: '💼', tone: 'amber' },
  study: { label: 'Study', icon: '📚', tone: 'sky' },
  families: { label: 'Families', icon: '🧸', tone: 'coral' },
  other: { label: 'Other', icon: '✨', tone: '' },
}
export const topicMeta = (topic: string): { label: string; icon: string; tone: Tone } =>
  (TOPICS as Record<string, { label: string; icon: string; tone: Tone }>)[topic] ?? { label: topic, icon: '✨', tone: '' }

export const ROLE: Record<CommunityRole, { label: string; tone: Tone }> = {
  owner: { label: 'Owner', tone: 'amber' }, moderator: { label: 'Moderator', tone: 'sky' }, member: { label: 'Member', tone: '' },
}

export const MEETUP_STATUS: Record<MeetupStatus, { label: string; tone: Tone; icon: string }> = {
  proposed: { label: 'Proposed', tone: 'amber', icon: '⏳' },
  agreed: { label: 'Agreed', tone: 'leaf', icon: '✓' },
  cancelled: { label: 'Cancelled', tone: 'coral', icon: '✕' },
  past: { label: 'Past', tone: '', icon: '🕓' },
}

export const ANSWER: Record<MeetupAnswer, { label: string; tone: Tone; icon: string }> = {
  invited: { label: 'Not answered yet', tone: 'amber', icon: '⏳' },
  accepted: { label: 'Coming', tone: 'leaf', icon: '✓' },
  declined: { label: 'Can’t come', tone: 'coral', icon: '✕' },
}

export const GAME: Record<GameKind, { label: string; icon: string; unit: [string, string] }> = {
  'lane-dash': { label: 'Lane Dash', icon: '🏃', unit: ['point', 'points'] },
  eights: { label: 'Eights', icon: '🃏', unit: ['win', 'wins'] },
}

/** "cafe", "place of worship" — a map category as plain words. */
export const placeKind = (category: string): string => category.replace(/_/g, ' ')

/** "Ada", "Ada and Bola", "Ada, Bola and Chidi", "Ada, Bola, Chidi and 2 others". */
export function nameList(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const rest = names.length - max
  return `${names.slice(0, max).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

/**
 * The world behind a window also listens for keys (Enter opens chat, arrows and letters move the
 * avatar). While focus is inside a window, those keys belong to the window: Enter must press the
 * focused button. Escape and the dock shortcuts (0–9 and comma) still pass through.
 */
export function keepKeysInWindow(event: KeyboardEvent): void {
  if (event.key === 'Escape' || event.metaKey || event.ctrlKey || event.altKey) return
  if (/^[0-9,]$/.test(event.key)) return
  event.stopPropagation()
}

/** Moves keyboard focus to an element when it appears, for example the safe button of a confirmation. */
export const vFocus: Directive<HTMLElement> = { mounted: element => element.focus({ preventScroll: false }) }
