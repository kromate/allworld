// Come-back nudges: what is prepared for a member who has been away, and why.
// Owned by its track. Operations and events declared here are merged into the protocol.
//
// Every word a member can receive lives in this file (COPY and WHATSAPP_TEMPLATES), so a
// translation is one new locale object and one more set of approved WhatsApp templates.
import { brand } from '../brand.ts'
import type { Id, Iso } from './ids.ts'
import { TIERS } from './life.ts'
import type { ExternalChannel } from './notify.ts'

export type NudgeId = Id<'nudge'>

// ── Away ──────────────────────────────────────────────────────────────────────────────────────

export const AWAY_STATES = ['active', 'away-today', 'away-3-days', 'away-week', 'lapsed'] as const
export type AwayState = (typeof AWAY_STATES)[number]

/** Why a nudge may lead a message, strongest first. The order is the priority. */
export const NUDGE_GROUPS = ['person', 'invite', 'character', 'progress', 'checkin'] as const
export type NudgeGroup = (typeof NUDGE_GROUPS)[number]

/** One message type = one email layout, one push shape and one approved WhatsApp template. */
export const MESSAGE_TYPES = ['message', 'person', 'invite', 'hungry', 'tired', 'promotion', 'news', 'digest', 'checkin'] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

/** The numbers the planner works to. docs/COMEBACK.md explains where each one comes from. */
export const COMEBACK_RULES = {
  /**
   * Minutes with nothing heard (no action, no step, no "tab is visible" beat) before a member is
   * treated as gone, open socket or not. The App beats every two minutes and walking is reported
   * every 30 seconds, so ten minutes is five missed beats: a stalled network or a throttled timer
   * does not make someone look away, and a tab left open overnight does not make them look here.
   */
  idleAfterMinutes: 10,
  beatEveryMinutes: 2,
  /** Hours since last heard from before a member counts as away for messages. */
  awayAfterHours: 3,
  awayThreeDaysHours: 72,
  awayWeekHours: 168,
  /** After this the member has lapsed and nothing further is prepared. */
  lapsedAfterDays: 30,
  /** Hours away before each kind of thing is allowed to start a message. */
  leadAfterHours: { person: 3, invite: 3, character: 24, progress: 24, checkin: 168 } as Record<NudgeGroup, number>,
  /** A new event waits this long so a burst becomes one message. */
  settleMinutes: 30,
  /** Days to wait after the 1st, 2nd and 3rd message that brought no visit. */
  backoffDays: [1, 3, 7] as readonly number[],
  /** After this many messages without a visit, nothing more is sent until the member returns. */
  maxPerAbsence: 4,
  /** A visit within this many hours of a message counts as a return after it. */
  returnWindowHours: 48,
  defaultCaps: { perDay: 1, perWeek: 3 },
  capLimits: { perDay: { min: 1, max: 2 }, perWeek: { min: 1, max: 5 } },
  /** Lines listed in one digest; the rest are counted. */
  digestMaxItems: 5,
  /** Back after this long with a hungry character: the price of one meal, in play coins, once in `everyHours`. */
  welcomeMeal: { afterHours: 20, everyHours: 24, coins: TIERS.meal.price },
} as const

export interface ComebackPrefs {
  /** Master switch for messages outside the App. */
  enabled: boolean
  groups: Record<NudgeGroup, boolean>
  /** Explicit opt-in per channel, on top of the consent and destination kept by notifications. */
  channels: Record<ExternalChannel, boolean>
  /** null lets the planner pick by what the message is about. */
  prefer: ExternalChannel | null
  caps: { perDay: number; perWeek: number }
}

export const defaultComebackPrefs = (): ComebackPrefs => ({
  enabled: true,
  groups: { person: true, invite: true, character: true, progress: true, checkin: true },
  channels: { email: false, whatsapp: false, push: false },
  prefer: null,
  caps: { ...COMEBACK_RULES.defaultCaps },
})

// ── Which event belongs to which group ────────────────────────────────────────────────────────

const KIND_GROUP: Record<string, NudgeGroup> = {
  // "They got a message" and "someone is looking for them": a message, a wave (or a wave back),
  // an introduction, an invitation to join someone, a friend who called at their home, their move in a game.
  'direct.message': 'person', 'social.wave': 'person', 'social.wave-back': 'person', 'social.join-me': 'person', 'intro.received': 'person',
  'home.visited': 'person', 'match.played': 'person', 'arena.turn': 'person', 'arena.started': 'person',
  'quote.requested': 'person', 'application.received': 'person',
  'meetup.invited': 'invite', 'meetup.revised': 'invite', 'meetup.cancelled': 'invite', 'match.invited': 'invite', 'arena.challenge': 'invite',
  'hangout.soon': 'invite', 'community.invited': 'invite', 'quote.offered': 'invite',
  'life.hungry': 'character', 'life.exhausted': 'character',
  'work.levelup': 'progress', 'intro.accepted': 'progress', 'meetup.answered': 'progress', 'passport.ready': 'progress',
  'visa.approved': 'progress', 'visa.refused': 'progress', 'travel.arrived': 'progress', 'seller.reviewed': 'progress',
  'application.decided': 'progress', 'quote.accepted': 'progress', 'match.finished': 'progress', 'arena.finished': 'progress', 'community.post': 'progress',
  'social.join-accepted': 'progress', 'social.invite-joined': 'progress', 'hangout.going': 'progress',
}
/** Recorded in the inbox, never a reason to message someone outside the App. */
const NEVER_NUDGED = new Set(['work.closed', 'quote.expired', 'quote.declined', 'application.withdrawn'])

/** The group an event belongs to, or null when it should stay in the inbox only. */
export function groupOfKind(kind: string, shape: { actor: boolean; expires: boolean }): Exclude<NudgeGroup, 'checkin'> | null {
  if (NEVER_NUDGED.has(kind)) return null
  const known = KIND_GROUP[kind]
  if (known && known !== 'checkin') return known
  if (kind.startsWith('life.')) return 'character'
  // Kinds added by other tracks later: a deadline makes it an invitation, a person makes it personal.
  if (shape.expires) return 'invite'
  if (shape.actor) return 'person'
  return 'progress'
}

/** The message type used when this event is the only thing in a message. */
export function typeOfKind(kind: string, group: NudgeGroup, expires: boolean): MessageType {
  if (kind === 'direct.message') return 'message'
  if (kind === 'life.hungry') return 'hungry'
  if (kind === 'life.exhausted') return 'tired'
  if (kind === 'work.levelup') return 'promotion'
  if (kind === 'meetup.cancelled') return 'news'
  if (group === 'person') return 'person'
  if (group === 'invite') return expires ? 'invite' : 'person'
  return 'news'
}

// ── Copy (English). Sentence fragments: no full stop at the end of a line. ─────────────────────

export interface LineInput {
  kind: string
  title: string
  body: string
  /** Display name of the person behind the event, when there is one the member may see. */
  actor: string | null
  count: number
  /** When the event happened, and "now", in ms. */
  at: number
  now: number
  timezone: string
  /** When the character last ate, if the daily-life module knows of a meal. */
  lastMealAt?: number | null
}

const localDay = (at: number, timezone: string): number => {
  const [year = '1970', month = '01', day = '01'] = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at).split('-')
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000
}

/** "earlier today", "yesterday", "Tuesday", "12 September" — always true for the member's own calendar. */
export function sinceWord(at: number, now: number, timezone: string): string {
  const days = localDay(now, timezone) - localDay(at, timezone)
  if (days <= 0) return 'earlier today'
  if (days === 1) return 'yesterday'
  if (days < 7) return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(at)
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long' }).format(at)
}
/** The same moment inside a sentence: "today", "yesterday", "on Tuesday", "on 12 September". */
export function onDay(at: number, now: number, timezone: string): string {
  const word = sinceWord(at, now, timezone)
  return word === 'earlier today' ? 'today' : word === 'yesterday' ? word : `on ${word}`
}

const trimStop = (text: string): string => text.trim().replace(/[.!\s]+$/, '')
/** Meetup events carry "Venue · Sat 3 Oct, 18:00" in the body. */
const venueWhen = (body: string): { venue: string; when: string } | null => {
  const match = /^(?:Now )?(.+?) · ([^.]+)/.exec(body)
  return match ? { venue: match[1]!, when: match[2]! } : null
}

type Line = (event: LineInput) => string
const LINES: Record<string, Line> = {
  'direct.message': event => event.actor
    ? (event.count > 1 ? `${event.actor} sent you ${event.count} messages` : `${event.actor} sent you a message`)
    : (event.count > 1 ? `You have ${event.count} new messages` : 'You have a new message'),
  'social.wave': event => (event.actor ? `${event.actor} waved at you` : trimStop(event.title)),
  'intro.received': event => (event.actor ? `${event.actor} would like to connect with you` : trimStop(event.title)),
  'match.played': event => (event.body.startsWith('Your turn') ? `${trimStop(event.title)}, and it is your turn` : trimStop(event.title)),
  'quote.requested': event => `A buyer asked you for a quote: ${trimStop(event.body)}`,
  'meetup.invited': event => {
    const plan = venueWhen(event.body)
    return plan && event.actor ? `${event.actor} is waiting for your answer: ${plan.venue}, ${plan.when}` : trimStop(event.title)
  },
  'meetup.revised': event => {
    const plan = venueWhen(event.body)
    return plan && event.actor ? `${event.actor} changed the meetup and needs your answer again: ${plan.venue}, ${plan.when}` : 'A meetup plan changed and needs your answer again'
  },
  'meetup.cancelled': event => {
    const plan = venueWhen(event.body)
    return plan && event.actor ? `${event.actor} cancelled the meetup at ${plan.venue} on ${plan.when}` : 'A meetup you were going to was cancelled'
  },
  'meetup.answered': event => {
    const plan = venueWhen(event.body)
    return plan ? `${trimStop(event.title)}: ${plan.venue}, ${plan.when}` : trimStop(event.title)
  },
  'life.hungry': event => {
    const meal = event.lastMealAt ? sinceWord(event.lastMealAt, event.now, event.timezone) : 'earlier today'
    if (meal !== 'earlier today') return `Your character has not eaten since ${meal}`
    const since = sinceWord(event.at, event.now, event.timezone)
    return since === 'earlier today' ? 'Your character is hungry' : `Your character has been hungry since ${since}`
  },
  'life.exhausted': event => {
    const since = sinceWord(event.at, event.now, event.timezone)
    return since === 'earlier today' ? 'Your character is worn out' : `Your character has been worn out since ${since}`
  },
  'work.levelup': event => `You were promoted to ${promotedTo(event.title)}`,
  'community.post': event => {
    const community = trimStop(event.title).replace(/^New in /, '')
    return event.count > 1 ? `${event.count} new posts in ${community}` : `A new post in ${community}`
  },
}
/** The work module titles a level-up "Level up: Shift lead". */
export const promotedTo = (title: string): string => trimStop(title).replace(/^Level up:\s*/, '')

/** One true sentence fragment about an event, written for someone who is not in the App. */
export const lineFor = (event: LineInput): string => (LINES[event.kind] ?? ((input: LineInput) => trimStop(input.title)))(event)

/** The same event without its date, for places that state the closing time separately. */
export function shortLineFor(event: LineInput): string {
  const plan = venueWhen(event.body)
  if (plan && event.actor && event.kind === 'meetup.invited') return `${event.actor} asked to meet at ${plan.venue}`
  if (plan && event.actor && event.kind === 'meetup.revised') return `${event.actor} changed the meetup to ${plan.venue}`
  return lineFor(event)
}

/** Events whose body text is written by the service, not by a member, and so may be quoted outside the App. */
const SERVICE_WRITTEN = new Set(['passport.ready', 'visa.approved', 'visa.refused', 'travel.arrived', 'intro.accepted', 'seller.reviewed', 'quote.accepted', 'match.finished'])
/** A second sentence for an event, or '' when there is nothing true and useful to add. */
function detailFor(kind: string, body: string, when: string): string {
  if (kind === 'social.wave') return `That was ${when}. You can wave back or say hello.`
  if (kind === 'intro.received') return `They asked ${when}. You can accept or decline.`
  if (kind === 'match.played') return `They played ${when}.`
  if (SERVICE_WRITTEN.has(kind) && body.trim()) return /[.!?]$/.test(body.trim()) ? body.trim() : `${body.trim()}.`
  return when === 'today' ? '' : `That was ${when}.`
}

/** What the button or link next to a line says. At most 25 characters (a WhatsApp button limit). */
const CTA: Record<string, string> = {
  'direct.message': 'Read the message', 'social.wave': 'Wave back', 'intro.received': 'See the request', 'match.played': 'Open the match',
  'quote.requested': 'Open the request', 'application.received': 'Read the application', 'meetup.invited': 'Answer the invitation',
  'meetup.revised': 'See the new plan', 'meetup.cancelled': 'See the meetup', 'meetup.answered': 'See the meetup', 'match.invited': 'See the challenge',
  'community.invited': 'See the community', 'quote.offered': 'See the offer', 'life.hungry': 'Find somewhere to eat', 'life.exhausted': 'Open the game',
  'work.levelup': 'See your new title', 'community.post': 'Read the posts', 'travel.arrived': 'Step out', 'passport.ready': 'See your passport',
  'social.wave-back': 'Say hello', 'social.join-me': 'See the invitation', 'arena.challenge': 'See the challenge', 'arena.turn': 'Make your move',
  'arena.started': 'Open the game', 'arena.finished': 'See the game', 'home.visited': 'See who called',
}
export const ctaFor = (kind: string, count = 1): string => (kind === 'direct.message' && count > 1 ? 'Read the messages' : CTA[kind] ?? 'Open it')

export const GROUP_COPY: Record<NudgeGroup, { label: string; detail: string; icon: string; tone: 'coral' | 'grape' | 'leaf' | 'amber' | 'sky' }> = {
  person: { label: 'Someone is waiting for you', detail: 'A message, a wave, an introduction, or your turn in a game.', icon: '👋', tone: 'coral' },
  invite: { label: 'Plans and invitations', detail: 'Meetups, challenges and offers that close at a set time, and changes to them.', icon: '📅', tone: 'grape' },
  character: { label: 'Your character', detail: 'When your character has been hungry or worn out for a day.', icon: '🍲', tone: 'leaf' },
  progress: { label: 'Good news', detail: 'A promotion at work, a passport or visa ready, an arrival, replies in your communities.', icon: '🎉', tone: 'amber' },
  checkin: { label: 'One check-in after a week', detail: 'A single short note after seven days away, and then nothing more.', icon: '🌤', tone: 'sky' },
}

export const TYPE_LABEL: Record<MessageType, string> = {
  message: 'A message is waiting', person: 'Someone is waiting', invite: 'An invitation', hungry: 'Character is hungry', tired: 'Character is worn out',
  promotion: 'A promotion', news: 'An update', digest: 'Several things at once', checkin: 'Check-in after a week',
}

/** Everything a message type needs, as plain strings. The service lays them out per channel. */
export interface MessageCopy {
  subject: string
  /** Body paragraphs, each a complete sentence or two. */
  paragraphs: string[]
  /** Label of the main link. */
  cta: string
  /** Honesty note shown small under the body, or null. */
  finePrint: string | null
  push: { title: string; body: string }
  /** Ordered values for the WhatsApp template of this type. */
  variables: string[]
}

export interface CopyContext {
  /** The member's display name. */
  name: string
  /** Lines in priority order; the first leads. */
  lines: { text: string; short: string; body: string; count: number; cta: string; kind: string; actor: string | null; at: number; expiresAt: number | null }[]
  /** Things beyond the listed lines. */
  more: number
  /** Already mentioned in an earlier message and still unanswered. */
  earlier: number
  now: number
  timezone: string
  lastSeenAt: number
  /** Whole days away. */
  days: number
  /** Game coins. Play money, shown only in the check-in. */
  coins: number
  /** Coins the first meal back is covered with, when that is certain to be given on return. Otherwise null. */
  meal: number | null
}

const things = (count: number): string => (count === 1 ? '1 more thing' : `${count} more things`)
const until = (at: number, timezone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/** Build the copy for one message. Every sentence states something the service knows to be true. */
export function composeMessage(type: MessageType, context: CopyContext): MessageCopy {
  const lead = context.lines[0]
  const line = lead?.text ?? ''
  const when = lead ? onDay(lead.at, context.now, context.timezone) : ''
  const earlier = context.earlier > 0 ? ` ${context.earlier === 1 ? 'One earlier thing is' : `${context.earlier} earlier things are`} still in your inbox.` : ''
  const detail = lead ? detailFor(lead.kind, lead.body, when) : ''
  switch (type) {
    case 'message': return {
      subject: line,
      paragraphs: [`${line} ${when}. ${lead && lead.count > 1 ? 'They are' : 'It is'} waiting in your messages.${earlier}`],
      cta: lead?.cta ?? 'Read the message', finePrint: null,
      push: { title: line, body: clip(`Sent ${when}. Open to read and reply.`, 120) },
      variables: [context.name, lead?.actor ?? 'A friend'],
    }
    case 'person': return {
      subject: line,
      paragraphs: [`${line}.${detail ? ` ${detail}` : ''}${earlier}`],
      cta: lead?.cta ?? 'Open it', finePrint: null,
      push: { title: line, body: clip(detail || 'Open to answer.', 120) },
      variables: [context.name, line],
    }
    case 'invite': {
      const closes = lead?.expiresAt ? until(lead.expiresAt, context.timezone) : ''
      // A meetup closes when it starts, and its line already says when that is.
      const open = line.includes(closes) ? '' : ` It stays open until ${closes}.`
      return {
        subject: line,
        paragraphs: [`${line}.${open}${earlier}`],
        cta: lead?.cta ?? 'See the invitation', finePrint: null,
        push: { title: lead?.short ?? line, body: clip(`Open until ${closes}.`, 120) },
        variables: [context.name, lead?.short ?? line, closes],
      }
    }
    case 'hungry': {
      const since = lead ? sinceWord(lead.at, context.now, context.timezone) : 'earlier today'
      const treat = context.meal ? ` The first meal back is on us: ${context.meal} game coins are added when you return.` : ' A plain meal at home is free, and any café or restaurant nearby will do.'
      return {
        subject: 'Your character is hungry',
        paragraphs: [`${line}.${treat}${earlier}`],
        cta: lead?.cta ?? 'Find somewhere to eat', finePrint: null,
        push: { title: 'Your character is hungry', body: clip(`Since ${since}.${treat}`, 150) },
        variables: [context.name, since, context.meal ? `The first meal back is on us: ${context.meal} game coins are added when you return` : 'A plain meal at home is free'],
      }
    }
    case 'tired': {
      const since = lead ? sinceWord(lead.at, context.now, context.timezone) : 'earlier today'
      return {
        subject: 'Your character is worn out',
        paragraphs: [`${line}. A rest in the game will sort that out.${earlier}`],
        cta: lead?.cta ?? 'Open the game', finePrint: null,
        push: { title: 'Your character is worn out', body: clip(`Since ${since}. A rest in the game will do.`, 120) },
        variables: [context.name, since],
      }
    }
    case 'promotion': {
      const title = line.replace(/^You were promoted to /, '')
      return {
        subject: line,
        paragraphs: [`Your last shift earned you a promotion: you are now ${title}. The new title is on your work page.${earlier}`],
        cta: lead?.cta ?? 'See your new title',
        finePrint: `Work in ${brand.name} is part of the game. A title is not a real job or a qualification.`,
        push: { title: line, body: 'Earned on your last shift. The new title is on your work page.' },
        variables: [context.name, title],
      }
    }
    case 'news': return {
      subject: line,
      paragraphs: [`${line}.${detail ? ` ${detail}` : ''}${earlier}`],
      cta: lead?.cta ?? 'See it', finePrint: null,
      push: { title: line, body: clip(detail || 'Open to see it.', 120) },
      variables: [context.name, line],
    }
    case 'digest': {
      const total = context.lines.length + context.more
      const rest = context.lines.slice(1).map(entry => entry.text)
      const promoted = context.lines.some(entry => entry.kind === 'work.levelup')
      return {
        subject: `${line}, and ${things(total - 1)}`,
        paragraphs: [`Since you were last here ${sinceWord(context.lastSeenAt, context.now, context.timezone) === 'earlier today' ? 'earlier today' : onDay(context.lastSeenAt, context.now, context.timezone)}:`],
        cta: 'See everything in your inbox',
        finePrint: promoted ? `Work in ${brand.name} is part of the game. A title is not a real job or a qualification.` : null,
        push: { title: line, body: clip(total === 2 ? `Also: ${rest[0]}.` : `Also: ${rest[0]}, and ${things(total - 2)}.`, 140) },
        variables: [context.name, String(total), line],
      }
    }
    case 'checkin': {
      const waiting = context.earlier > 0
        ? `${context.earlier === 1 ? 'One thing from earlier is' : `${context.earlier} things from earlier are`} still in your inbox`
        : 'nothing is waiting for an answer'
      return {
        subject: `Your home in ${brand.name} is as you left it`,
        paragraphs: [
          `It has been ${context.days} days since you were last in ${brand.name}. Your home is as you left it, you have ${context.coins.toLocaleString('en-GB')} game coins, and ${waiting}.`,
          'This is the only check-in we send. After it, you will only hear from us if something happens that involves you.',
        ],
        cta: 'Step back in', finePrint: null,
        push: { title: `It has been ${context.days} days`, body: clip(`Your home is as you left it and you have ${context.coins.toLocaleString('en-GB')} game coins. This is our only check-in.`, 160) },
        variables: [context.name, String(context.days), context.coins.toLocaleString('en-GB')],
      }
    }
  }
}

/** Words around every message, in one place. */
export const FRAME = {
  greeting: (name: string): string => `Hi ${name},`,
  alsoWaiting: 'Also waiting for you:',
  more: (count: number): string => `And ${things(count)} in your inbox`,
  why: (channel: string, perDay: number, perWeek: number): string =>
    `You are getting this because you turned on come-back messages by ${channel} in ${brand.name}. We send at most ${perDay} a day and ${perWeek} a week, never repeat the same thing, and stop after ${COMEBACK_RULES.maxPerAbsence} messages if you stay away.`,
  manage: 'Choose what we send',
  stop: (channel: string): string => `Stop all ${channel} from ${brand.name}`,
} as const

export const CHANNEL_WORD: Record<ExternalChannel, string> = { email: 'email', whatsapp: 'WhatsApp', push: 'push' }

// ── WhatsApp templates, in the form WhatsApp Business reviews them ─────────────────────────────

export interface WhatsAppTemplate {
  /** Name registered with WhatsApp. Lower case, digits and underscores only. */
  name: string
  type: MessageType
  /** What we will ask for. WhatsApp decides and may change it. */
  category: 'UTILITY' | 'MARKETING'
  language: string
  /** Body with {{1}}, {{2}}… It never starts or ends with a variable. */
  body: string
  /** At most 60 characters. */
  footer: string
  /** Two URL buttons. Each URL ends in one variable; APP stands for the App's public address. */
  buttons: [{ text: string; url: 'APP/{{1}}' }, { text: string; url: 'APP/world/comeback/unsubscribe?token={{1}}' }]
  /** What each body variable holds, in order. */
  variables: string[]
  /** Sample values for the reviewer, in order. Not real members. */
  sample: string[]
  /** Why this category. */
  why: string
}

const WA_FOOTER = 'You turned these on in Settings'
const waButtons = (open: string): WhatsAppTemplate['buttons'] => [
  { text: open, url: 'APP/{{1}}' },
  { text: 'Stop these messages', url: 'APP/world/comeback/unsubscribe?token={{1}}' },
]
export const WHATSAPP_LANGUAGE = 'en_GB'

export const WHATSAPP_TEMPLATES: Record<MessageType, WhatsAppTemplate> = {
  message: {
    name: 'nw_message_waiting', type: 'message', category: 'UTILITY', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, {{2}} sent you a message in ${brand.name}. It is waiting in your messages.`,
    footer: WA_FOOTER, buttons: waButtons('Read the message'),
    variables: ['Your name', 'Who sent the message'], sample: ['Sam', 'Alex'],
    why: 'An alert about the member’s own account: a specific person wrote to them. Nothing promotional.',
  },
  person: {
    name: 'nw_person_waiting', type: 'person', category: 'UTILITY', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, this is waiting for you in ${brand.name}: {{2}}. Open the game to answer it.`,
    footer: WA_FOOTER, buttons: waButtons('Open it'),
    variables: ['Your name', 'What is waiting'], sample: ['Sam', 'Alex would like to connect with you'],
    why: 'An alert about a request addressed to the member by another person. Nothing promotional.',
  },
  invite: {
    name: 'nw_invite_waiting', type: 'invite', category: 'UTILITY', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, an invitation is waiting for you in ${brand.name}: {{2}}. It stays open until {{3}}.`,
    footer: WA_FOOTER, buttons: waButtons('See the invitation'),
    variables: ['Your name', 'The invitation', 'When it closes'], sample: ['Sam', 'Alex asked to meet at Central Market', 'Sat 3 Oct, 18:00'],
    why: 'An invitation addressed to the member with a real closing time. The time is the invitation’s own, not a sales deadline.',
  },
  hungry: {
    name: 'nw_character_hungry', type: 'hungry', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, your character in ${brand.name} has been hungry since {{2}}. {{3}}. Open the game to find somewhere to eat.`,
    footer: WA_FOOTER, buttons: waButtons('Find somewhere to eat'),
    variables: ['Your name', 'Since when', 'What helps'], sample: ['Sam', 'yesterday', 'The first meal back is on us: 22 game coins are added when you return'],
    why: 'Its purpose is to bring the member back to the game, so it is re-engagement: marketing.',
  },
  tired: {
    name: 'nw_character_tired', type: 'tired', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, your character in ${brand.name} has been worn out since {{2}}. A rest in the game will sort that out.`,
    footer: WA_FOOTER, buttons: waButtons('Open the game'),
    variables: ['Your name', 'Since when'], sample: ['Sam', 'yesterday'],
    why: 'Re-engagement: marketing.',
  },
  promotion: {
    name: 'nw_promotion', type: 'promotion', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, your last shift in ${brand.name} earned you a promotion to {{2}}. The new title is on your work page. Work here is part of the game.`,
    footer: WA_FOOTER, buttons: waButtons('See your new title'),
    variables: ['Your name', 'The new title'], sample: ['Sam', 'Shift lead'],
    why: 'True and about the member’s own play, but its purpose is to bring them back: marketing.',
  },
  news: {
    name: 'nw_update', type: 'news', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, an update from ${brand.name}: {{2}}. Open the game to see it.`,
    footer: WA_FOOTER, buttons: waButtons('See it'),
    variables: ['Your name', 'What happened'], sample: ['Sam', 'Your passport is ready'],
    why: 'A general update with free text. WhatsApp treats mixed or open content as marketing.',
  },
  digest: {
    name: 'nw_away_digest', type: 'digest', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, {{2}} things happened in ${brand.name} while you were away. The first: {{3}}. The rest are in your inbox.`,
    footer: WA_FOOTER, buttons: waButtons('See what happened'),
    variables: ['Your name', 'How many things', 'The most important one'], sample: ['Sam', '4', 'Alex sent you a message'],
    why: 'A summary sent because the member has been away is re-engagement: marketing.',
  },
  checkin: {
    name: 'nw_checkin', type: 'checkin', category: 'MARKETING', language: WHATSAPP_LANGUAGE,
    body: `Hi {{1}}, it has been {{2}} days since you were last in ${brand.name}. Your home is as you left it and you have {{3}} game coins. This is the only check-in we send.`,
    footer: WA_FOOTER, buttons: waButtons('Step back in'),
    variables: ['Your name', 'Days away', 'Game coins'], sample: ['Sam', '8', '240'],
    why: 'A “you have been away” note is the plainest kind of re-engagement: marketing.',
  },
}

/** How many {{n}} a template body declares. */
export const variableCount = (body: string): number => new Set(body.match(/\{\{\d+\}\}/g) ?? []).size

/** A value safe to put in a WhatsApp variable: one line, no runs of spaces, bounded. */
export const whatsappValue = (text: string): string => clip(text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim(), 160)

/** The template body with its variables filled in: what the member would read. */
export const fillTemplate = (body: string, values: string[]): string => body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => values[Number(index) - 1] ?? '')

// ── What the App sees ─────────────────────────────────────────────────────────────────────────

export interface EmailRender {
  from: string
  /** Masked destination. */
  to: string
  subject: string
  text: string
  html: string
  /** Headers a real send must carry (one-click unsubscribe). */
  headers: Record<string, string>
}
export interface WhatsAppRender {
  to: string
  template: string
  language: string
  category: 'UTILITY' | 'MARKETING'
  /** Body variables in order. */
  variables: string[]
  /** The value for each button's URL variable, in order. */
  buttons: { text: string; url: string }[]
  footer: string
  /** The body with the variables filled in. */
  preview: string
}
export interface PushRender { title: string; body: string; link: string }
export interface Rendered { email: EmailRender; whatsapp: WhatsAppRender; push: PushRender }

export interface NudgeItem { kind: string; group: NudgeGroup; line: string; cta: string; link: string }

export type NudgeState =
  | 'held-quiet-hours'
  /** Prepared in full. Nothing left the service because the channel is in dry-run. */
  | 'ready-not-sent'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'

export interface Nudge {
  id: NudgeId
  channel: ExternalChannel
  type: MessageType
  state: NudgeState
  createdAt: Iso
  scheduledFor: Iso
  /** When it was (or would have been) handed to the provider. */
  readyAt: Iso | null
  sentAt: Iso | null
  openedAt: Iso | null
  returnedAt: Iso | null
  /** Hours the member had been away when it was prepared. */
  awayHours: number
  items: NudgeItem[]
  /** Things counted but not listed. */
  more: number
  /** Plain reason for the current state. */
  reason: string
  /** Exactly what the adapter would send on this nudge's channel. Null once part of it concerned a person since blocked. */
  preview: Rendered | null
}

export type DecisionOutcome = 'prepared' | 'held' | 'waiting' | 'skipped' | 'cancelled' | 'stopped' | 'returned'
/** One planner decision, kept so a member (or the owner) can see why something was or was not sent. */
export interface Decision {
  at: Iso
  outcome: DecisionOutcome
  /** Machine name of the rule that decided. */
  code: string
  text: string
  nudgeId: NudgeId | null
}

export interface ComebackChannel {
  channel: ExternalChannel
  /** Consent and a destination exist in notification settings. */
  consented: boolean
  /** Masked. */
  destination: string
  /** The member switched come-back messages on for this channel. */
  enabled: boolean
  mode: 'dry-run' | 'live'
  /** Why the channel cannot send yet, or what it would use. */
  note: string
}

export interface ComebackStatus {
  away: { state: AwayState; online: boolean; lastSeenAt: Iso | null }
  prefs: ComebackPrefs
  channels: ComebackChannel[]
  /** Outside messages prepared for this member in the last day and week, against the caps. */
  usage: { last24h: number; last7d: number }
  nudges: Nudge[]
  decisions: Decision[]
}

export interface ComebackPreview {
  /** 'waiting' when real things are waiting now; 'checkin' when nothing is, so the week-away note is shown. */
  basis: 'waiting' | 'checkin'
  type: MessageType
  items: NudgeItem[]
  more: number
  /** The channel the planner would pick now, or null with the reason below. */
  channel: ExternalChannel | null
  /** When and why this would or would not be sent. */
  explanation: string
  rendered: Rendered
}

export interface ComebackCounts {
  prepared: number
  /** Released to a channel in dry-run: complete, never sent. */
  readyNotSent: number
  sent: number
  failed: number
  opened: number
  /** The member came back within the return window after the message was ready or sent. */
  returned: number
  cancelledOnReturn: number
  cancelledOther: number
  unsubscribed: number
}
/** Aggregate numbers for the owner. Counts only: no member, destination or message text. */
export interface ComebackStats {
  returnWindowHours: number
  totals: ComebackCounts
  byType: { type: MessageType; counts: ComebackCounts }[]
  byChannel: { channel: ExternalChannel; counts: ComebackCounts }[]
  /** How often each rule held a message back. */
  notPrepared: { code: string; count: number }[]
  absences: { ended: number; endedAfterMessage: number; endedWithoutMessage: number }
  /** Welcome-back meals given. */
  welcomeMeals: number
  /** Members seen at least once, by away state now. */
  members: Record<AwayState, number>
}

export interface ComebackOps {
  'comeback.status': { in: Record<string, never>; out: { status: ComebackStatus } }
  'comeback.setPrefs': { in: { prefs: ComebackPrefs }; out: { status: ComebackStatus } }
  /** What this member would get if they were away now, rendered from the real templates. `origin` is the App's own address, for the links. */
  'comeback.preview': { in: { origin: string | null }; out: { preview: ComebackPreview } }
  /**
   * The App's beat: once when its tab becomes visible or hidden, and every two minutes while it is
   * visible. This is how someone reading without touching anything still counts as here.
   */
  'comeback.here': { in: { visible: boolean; origin: string | null }; out: { here: boolean } }
  /** Called when a link from a message is opened. The link carries `?nudge=<id>`. */
  'comeback.opened': { in: { nudgeId: NudgeId }; out: { opened: boolean } }
  /** Honours the signed token from a message's unsubscribe link. Withdraws consent and forgets the destination. */
  'comeback.unsubscribe': { in: { token: string }; out: { channel: ExternalChannel; stopped: true } }
  /** Reviewer only. */
  'comeback.stats': { in: Record<string, never>; out: { stats: ComebackStats } }
}

/** Events this track pushes. */
export type ComebackEvent =
  /** Sent once when a member returns after being away, so the App can greet them with what happened. */
  | { type: 'comeback.welcome'; awayHours: number; total: number; items: NudgeItem[] }
  | { type: 'comeback.changed' }

/** The query parameter a message link carries so the App can report that it was opened. */
export const NUDGE_PARAM = 'nudge'
/** The service's own unsubscribe page and one-click endpoint (service/server.ts). */
export const UNSUBSCRIBE_PATH = '/world/comeback/unsubscribe'
/** Shown on the Welcome back card when the first meal back was covered. */
export const WELCOME_MEAL_LINE = `Your character is hungry, so the first meal back is on us: ${TIERS.meal.price} game coins were added`

/**
 * Tell the service while this tab is on screen. Call once when the App is ready:
 *   startPresenceBeat(visible => { void api('comeback.here', { visible, origin: location.origin }).catch(() => undefined) })
 * Returns a function that stops it.
 */
export function startPresenceBeat(send: (visible: boolean) => void, page: Document = document): () => void {
  const report = (): void => send(page.visibilityState === 'visible')
  const timer = setInterval(() => { if (page.visibilityState === 'visible') send(true) }, COMEBACK_RULES.beatEveryMinutes * 60_000)
  page.addEventListener('visibilitychange', report)
  report()
  return () => { clearInterval(timer); page.removeEventListener('visibilitychange', report) }
}
