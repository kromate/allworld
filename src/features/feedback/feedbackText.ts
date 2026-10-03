// Words and small rules for the neighbourhood noticeboard: where it lives in the App, what a
// member can pin, and the label they may choose to put on it. Nothing here talks to the board;
// the board's addresses are in src/config/feedback.ts.
import type { NavItem } from '../../ui/shell.ts'

/** The noticeboard's own page. The shell registers this route and may list `FEEDBACK_NAV` under More. */
export const FEEDBACK_PATH = '/feedback'
export const FEEDBACK_TITLE = 'Noticeboard'
/**
 * The section entry, in the shell's own shape, for the shell's owner to add to `NAV`. Not one of
 * the five on the bar, so on a phone it sits under More; not `menuOnly`, so a wide screen lists it too.
 */
export const FEEDBACK_NAV: NavItem = { to: FEEDBACK_PATH, label: FEEDBACK_TITLE, glyph: 'note', icon: '📌', key: '' }

export type FeedbackKind = 'idea' | 'problem'
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['idea', 'problem']
export const KIND: Record<FeedbackKind, { label: string; icon: string; action: string; tag: string; help: string }> = {
  idea: {
    label: 'Suggest an idea', icon: '💡', action: 'Open the board to add your idea', tag: 'Idea',
    help: 'Say what you would like to be able to do, and why it would make the neighbourhood better for you.',
  },
  problem: {
    label: 'Report a problem', icon: '🛠', action: 'Open the board to report it', tag: 'Problem',
    help: 'Say what you did, what you expected, and what happened instead. The device and browser you use help too, if you are happy to say.',
  },
}

/**
 * Parts of the game a member may choose to name on their note. It is their choice: nothing is
 * chosen for them, and the choice goes nowhere unless they copy it into what they write.
 */
export type FeedbackTopic = 'streets' | 'people' | 'work' | 'home' | 'games' | 'travel' | 'market' | 'character' | 'other'
export const FEEDBACK_TOPICS: readonly FeedbackTopic[] = ['streets', 'people', 'work', 'home', 'games', 'travel', 'market', 'character', 'other']
export const TOPIC: Record<FeedbackTopic, { label: string; icon: string }> = {
  streets: { label: 'Streets and map', icon: '🗺' },
  people: { label: 'People and chat', icon: '👋' },
  work: { label: 'Work and food', icon: '💼' },
  home: { label: 'My home', icon: '🏠' },
  games: { label: 'Games', icon: '♟️' },
  travel: { label: 'Travel', icon: '✈️' },
  market: { label: 'Market and jobs', icon: '🛋' },
  character: { label: 'My character', icon: '🧍' },
  other: { label: 'Something else', icon: '✨' },
}
export const isTopic = (value: unknown): value is FeedbackTopic => typeof value === 'string' && (FEEDBACK_TOPICS as readonly string[]).includes(value)

/** The short label a member can copy to the start of their note, for example "Idea · Games: ". */
export const starterLine = (kind: FeedbackKind, topic: FeedbackTopic | null): string => `${KIND[kind].tag}${topic ? ` · ${TOPIC[topic].label}` : ''}: `

/**
 * Where the sign is standing, for its wording. `arrival` is the public arrival point of a
 * district, `street` anywhere else outdoors, `indoors` a venue or a home, `menu` the More menu.
 */
export type FeedbackContext = 'arrival' | 'street' | 'indoors' | 'menu'
export const SIGN: Record<FeedbackContext, { title: string; line: string }> = {
  arrival: { title: 'Allworld noticeboard', line: 'Help shape Allworld' },
  street: { title: 'Noticeboard', line: 'Seen something to improve out here?' },
  indoors: { title: 'Suggestion box', line: 'Drop in an idea, or tell us what went wrong' },
  menu: { title: FEEDBACK_TITLE, line: 'Suggest an idea or report a problem' },
}

/** The noticeboard's address inside the App, with the part of the game the sign was standing beside, if any. */
export const feedbackLink = (topic?: FeedbackTopic | null): { path: string; query?: { about: FeedbackTopic } } =>
  (topic ? { path: FEEDBACK_PATH, query: { about: topic } } : { path: FEEDBACK_PATH })
