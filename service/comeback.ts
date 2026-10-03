// Come-back engine: notices that a member has been away and decides whether ONE message is worth
// sending now, on which channel, and what it says.
//
// The planner only ever works from what is true in the service: unread inbox entries, the member's
// own consent and preferences, and when they were last here. Every decision is stored with its
// reason. Adapters are in dry-run unless a channel is switched to live in the delivery
// configuration (service/notify.ts), so by default nothing leaves this process and nothing is ever
// recorded as sent.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { brand } from '../src/brand.ts'
import {
  CHANNEL_WORD, COMEBACK_RULES, FRAME, NUDGE_GROUPS, NUDGE_PARAM, UNSUBSCRIBE_PATH, WELCOME_MEAL_LINE, WHATSAPP_TEMPLATES,
  composeMessage, ctaFor, defaultComebackPrefs, fillTemplate, groupOfKind, lineFor, shortLineFor, typeOfKind, whatsappValue,
} from '../src/shared/comeback.ts'
import type {
  AwayState, ComebackChannel, ComebackCounts, ComebackPrefs, ComebackPreview, ComebackStats, ComebackStatus, CopyContext, Decision,
  DecisionOutcome, MessageType, Nudge, NudgeGroup, NudgeId, NudgeItem, Rendered,
} from '../src/shared/comeback.ts'
import type { Iso, MemberId, NotificationId } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import { EXTERNAL_CHANNELS } from '../src/shared/notify.ts'
import type { ExternalChannel, QuietHours } from '../src/shared/notify.ts'
import type { World } from './kernel.ts'
import { exists, isBlockedEitherWay, onBlock, record } from './members.ts'
import {
  channelAdapter, deliveryConfig, externalConsent, onConsentWithdrawn, onEmit, pendingFor, quietHoursFor, quietUntil, remindedExternally,
  withdrawConsent,
} from './notify.ts'
import type { SendRequest, WorkflowTrigger } from './notify.ts'
import { bool, empty, id, num, obj, optOneOf, str } from './parse.ts'
import { needsSummary } from './life.ts'
import { addPoints, careerPoints } from './work.ts'

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const RULES = COMEBACK_RULES
const AWAY_AFTER = RULES.awayAfterHours * HOUR
const IDLE_AFTER = RULES.idleAfterMinutes * MINUTE
const LAPSED_AFTER = RULES.lapsedAfterDays * DAY
/** The planner looks at each away member at most this often. */
const PASS_EVERY = MINUTE
const KEPT_PER_MEMBER = 40
const DECISIONS_KEPT = 40

interface Presence {
  lastSeenAt: Iso
  /** Counts this member's absences, so messages can be tied to one. */
  absence: number
  /** Outside messages prepared in this absence. */
  nudged: number
  lastNudgeAt: Iso | null
  /** Why nothing more is prepared in this absence. A return clears it. */
  stopped: 'max' | 'lapsed' | null
  /** The one check-in of this absence has gone out. */
  checkedIn: boolean
  /**
   * Unread inbox entries already mentioned in a message, with how many events each had folded in
   * at the time. The same thing is never sent twice; a new event in the same entry is new.
   */
  told: Record<string, number>
  /** When the last welcome-back meal was given. */
  giftAt?: Iso | null
  /** The address this member's own App last reported, for links when no public address is configured. */
  origin?: string | null
  /** The last rule recorded, so an unchanged situation is logged once. */
  lastCode: string
}
interface ItemRecord extends NudgeItem { notificationId: NotificationId; actor: MemberId | null; count: number }
interface NudgeRecord extends Omit<Nudge, 'items'> { to: MemberId; absence: number; lead: NudgeGroup; items: ItemRecord[]; /** Why this channel. */ because: string }
interface ComebackState {
  /** Signs unsubscribe tokens. Generated once per service state; not a provider credential. */
  secret: string
  presence: Record<string, Presence>
  prefs: Record<string, ComebackPrefs>
  nudges: NudgeRecord[]
  decisions: Record<string, Decision[]>
  /** Keyed "channel|type". Survives trimming of old nudges. */
  counts: Record<string, ComebackCounts>
  notPrepared: Record<string, number>
  unsubscribes: number
  gifts?: number
  absences: { ended: number; endedAfterMessage: number; endedWithoutMessage: number }
}

const state = (world: World): ComebackState => world.slice<ComebackState>('comeback', () => ({
  secret: randomBytes(32).toString('base64url'), presence: {}, prefs: {}, nudges: [], decisions: {}, counts: {}, notPrepared: {}, unsubscribes: 0,
  absences: { ended: 0, endedAfterMessage: 0, endedWithoutMessage: 0 },
}))

/** When each away member is next worth looking at. Memory only: after a restart everyone is looked at once. */
const checkTimes = new WeakMap<World, Map<string, number>>()
const checks = (world: World): Map<string, number> => {
  let map = checkTimes.get(world)
  if (!map) { map = new Map(); checkTimes.set(world, map) }
  return map
}
const lastPass = new WeakMap<World, number>()

const zeroCounts = (): ComebackCounts => ({ prepared: 0, readyNotSent: 0, sent: 0, failed: 0, opened: 0, returned: 0, cancelledOnReturn: 0, cancelledOther: 0, unsubscribed: 0 })
const countsFor = (world: World, nudge: { channel: ExternalChannel; type: MessageType }): ComebackCounts => (state(world).counts[`${nudge.channel}|${nudge.type}`] ??= zeroCounts())

// ── Preferences, timezone, away state ─────────────────────────────────────────────────────────

function prefsOf(world: World, memberId: MemberId): ComebackPrefs {
  const stored = state(world).prefs[memberId]
  const base = defaultComebackPrefs()
  return stored ? { ...base, ...stored, groups: { ...base.groups, ...stored.groups }, channels: { ...base.channels, ...stored.channels }, caps: { ...base.caps, ...stored.caps } } : base
}

/**
 * Quiet hours as the member set them. If they never chose a timezone (it is still the default
 * "UTC") and the service knows their area, the area's timezone is used, so nobody is woken at
 * three in the morning because of a default.
 */
function quietFor(world: World, memberId: MemberId): QuietHours {
  const quiet = quietHoursFor(world, memberId)
  if (quiet.timezone !== 'UTC') return quiet
  const profile = record(world, memberId).profile
  return { ...quiet, timezone: profile.currentArea?.timezone ?? profile.browsing?.timezone ?? 'UTC' }
}

const stamp = (at: number, timezone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at)
const duration = (span: number): string => {
  if (span < HOUR) return `${Math.max(1, Math.round(span / MINUTE))} minutes`
  if (span < 2 * DAY) { const hours = Math.round(span / HOUR); return hours === 1 ? '1 hour' : `${hours} hours` }
  return `${Math.floor(span / DAY)} days`
}

/** How long a member has been gone, as one of five named states. Server-side only. */
export function awayState(world: World, memberId: MemberId): AwayState {
  const presence = state(world).presence[memberId]
  if (!presence) return 'active'
  const away = world.now() - ms(presence.lastSeenAt)
  if (away < AWAY_AFTER) return 'active'
  if (away < RULES.awayThreeDaysHours * HOUR) return 'away-today'
  if (away < RULES.awayWeekHours * HOUR) return 'away-3-days'
  if (away < LAPSED_AFTER) return 'away-week'
  return 'lapsed'
}

const freshPresence = (now: number): Presence => ({ lastSeenAt: iso(now), absence: 1, nudged: 0, lastNudgeAt: null, stopped: null, checkedIn: false, told: {}, lastCode: '' })

// ── Decisions: why something was or was not prepared ──────────────────────────────────────────

function decide(world: World, memberId: MemberId, presence: Presence, outcome: DecisionOutcome, code: string, text: string, nudgeId: NudgeId | null = null): void {
  // The same rule holding for hours is one decision, not one per pass.
  if (presence.lastCode === code && outcome !== 'prepared' && outcome !== 'held') return
  presence.lastCode = code
  const data = state(world)
  const log = (data.decisions[memberId] ??= [])
  log.unshift({ at: iso(world.now()), outcome, code, text, nudgeId })
  if (log.length > DECISIONS_KEPT) log.length = DECISIONS_KEPT
  if (outcome === 'waiting' || outcome === 'skipped' || outcome === 'stopped') data.notPrepared[code] = (data.notPrepared[code] ?? 0) + 1
  world.touch()
}

// ── What is waiting ───────────────────────────────────────────────────────────────────────────

interface Candidate extends ItemRecord { actorName: string | null; short: string; body: string; createdAt: number; updatedAt: number; at: number; expiresAt: number | null; rank: number }

/** Unread things worth telling this member about, strongest first. Never anything from a blocked person. */
function waiting(world: World, memberId: MemberId, groups: Record<NudgeGroup, boolean>, now: number): { items: Candidate[]; blocked: number; off: number } {
  const timezone = quietFor(world, memberId).timezone
  const items: Candidate[] = []
  let blocked = 0, off = 0
  // The daily-life module is the authority on the character: an old "hungry" entry is only repeated if it is still true.
  const needs = needsSummary(world, memberId)
  for (const entry of pendingFor(world, memberId)) {
    if (needs && ((entry.kind === 'life.hungry' && !needs.hungry) || (entry.kind === 'life.exhausted' && !needs.exhausted))) continue
    const expiresAt = entry.expiresAt ? ms(entry.expiresAt) : null
    if (expiresAt !== null && expiresAt <= now) continue
    const group = groupOfKind(entry.kind, { actor: Boolean(entry.actor), expires: expiresAt !== null })
    if (!group) continue
    if (entry.actor && (!exists(world, entry.actor) || isBlockedEitherWay(world, memberId, entry.actor))) { blocked++; continue }
    if (!groups[group]) { off++; continue }
    const actorName = entry.actor ? record(world, entry.actor).profile.displayName : null
    const createdAt = ms(entry.createdAt)
    // A need is described by when it began; everything else by its latest update.
    const at = entry.kind === 'life.hungry' && needs?.hungrySince ? ms(needs.hungrySince) : group === 'character' ? createdAt : ms(entry.updatedAt)
    const lastMealAt = entry.kind === 'life.hungry' && needs?.lastMeal ? ms(needs.lastMeal.at) : null
    const event = { kind: entry.kind, title: entry.title, body: entry.body, actor: actorName, count: entry.count, at, now, timezone, lastMealAt }
    items.push({
      notificationId: entry.id, actor: entry.actor, actorName, kind: entry.kind, group, link: entry.link, cta: ctaFor(entry.kind, entry.count),
      line: lineFor(event), short: shortLineFor(event), body: entry.body, count: entry.count, createdAt, updatedAt: ms(entry.updatedAt), at, expiresAt,
      // A message leads the people, a promotion leads the good news.
      rank: NUDGE_GROUPS.indexOf(group) * 2 + (entry.kind === 'direct.message' || entry.kind === 'work.levelup' || (group !== 'progress' && group !== 'person') ? 0 : 1),
    })
  }
  items.sort((a, b) => a.rank - b.rank || b.at - a.at)
  return { items, blocked, off }
}

const GROUP_WORD: Record<NudgeGroup, string> = { person: 'someone waiting', invite: 'an invitation or plan', character: 'your character', progress: 'good news', checkin: 'a check-in' }
/** What a message covers, without naming anyone, so the record stays true after a block. */
function describe(items: { group: NudgeGroup }[]): string {
  const groups = NUDGE_GROUPS.filter(group => items.some(item => item.group === group)).map(group => GROUP_WORD[group])
  return `${items.length === 1 ? '1 thing' : `${items.length} things`} (${groups.join(', ')})`
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

/** An App address as a browser reports it: scheme, host, optional port. Anything else is ignored. */
function parseOrigin(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 && /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(value) ? value : null
}
function rememberOrigin(world: World, memberId: MemberId, origin: string): void {
  const presence = state(world).presence[memberId]
  if (presence && presence.origin !== origin) { presence.origin = origin; world.touch() }
}
/**
 * Where links in this member's messages point: the configured public address when there is one,
 * otherwise the address their own App last connected from. Never a guessed host or port. Empty
 * when neither is known; a message with no address cannot be sent (the adapters require one).
 */
const originFor = (world: World, memberId: MemberId): string => deliveryConfig().appOrigin.replace(/\/$/, '') || state(world).presence[memberId]?.origin || ''

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const withParam = (path: string, key: string, value: string): string => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`

function sign(world: World, memberId: MemberId, channel: ExternalChannel): string {
  return createHmac('sha256', state(world).secret).update(`${memberId}|${channel}`).digest('base64url')
}
/** A signed, non-expiring token that stops one channel for one member. It carries no destination. */
export function unsubscribeToken(world: World, memberId: MemberId, channel: ExternalChannel): string {
  return `u1.${Buffer.from(`${memberId}|${channel}`).toString('base64url')}.${sign(world, memberId, channel)}`
}
function readToken(world: World, token: string): { memberId: MemberId; channel: ExternalChannel } | null {
  const [version, payload, signature] = token.split('.')
  if (version !== 'u1' || !payload || !signature) return null
  const [memberId = '', channel = ''] = Buffer.from(payload, 'base64url').toString('utf8').split('|')
  if (!(EXTERNAL_CHANNELS as readonly string[]).includes(channel) || !exists(world, memberId as MemberId)) return null
  const expected = Buffer.from(sign(world, memberId as MemberId, channel as ExternalChannel))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  return { memberId: memberId as MemberId, channel: channel as ExternalChannel }
}

interface Draft { type: MessageType; lead: NudgeGroup; listed: Candidate[]; more: number; earlier: number }

/** Choose the message type for what is new, or the single check-in when nothing is. */
function draftFor(fresh: Candidate[], earlier: number, checkin: boolean): Draft {
  if (checkin || !fresh.length) return { type: 'checkin', lead: 'checkin', listed: [], more: 0, earlier }
  const lead = fresh[0]!
  const listed = fresh.slice(0, RULES.digestMaxItems)
  const type = fresh.length === 1 ? typeOfKind(lead.kind, lead.group, lead.expiresAt !== null) : 'digest'
  return { type, lead: lead.group, listed, more: fresh.length - listed.length, earlier }
}

function emailHtml(parts: {
  subject: string; preheader: string; greeting: string; paragraphs: string[]; items: { line: string; cta: string; url: string }[]; more: string | null
  cta: string; url: string; finePrint: string | null; why: string; manage: string; manageUrl: string; stop: string; stopUrl: string
}): string {
  const p = (text: string, style = ''): string => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;${style}">${esc(text)}</p>`
  const items = parts.items.map(item =>
    `<tr><td style="padding:10px 0;border-top:1px solid #e9e3d8;font-size:16px;line-height:1.45">${esc(item.line)}<br><a href="${esc(item.url)}" style="color:#a05f00;font-size:14px;font-weight:600">${esc(item.cta)}</a></td></tr>`).join('')
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(parts.subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f3ede3;color:#1c1a24;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">',
    `<div style="display:none;max-height:0;overflow:hidden">${esc(parts.preheader)}</div>`,
    '<div style="max-width:520px;margin:0 auto;padding:20px 14px">',
    '<div style="background:#fffdf9;border:1px solid #e9e3d8;border-radius:14px;padding:22px 20px 18px">',
    `<p style="margin:0 0 14px;font-size:13px;font-weight:700;color:#a05f00">${esc(brand.name)}</p>`,
    p(parts.greeting),
    ...parts.paragraphs.map(text => p(text)),
    items ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border-bottom:1px solid #e9e3d8">${items}</table>` : '',
    parts.more ? p(parts.more, 'color:#4a4658;font-size:14px;') : '',
    `<p style="margin:4px 0 6px"><a href="${esc(parts.url)}" style="display:inline-block;padding:12px 18px;border-radius:12px;background:${brand.accent};color:${brand.accentInk};font-size:16px;font-weight:700;text-decoration:none">${esc(parts.cta)}</a></p>`,
    parts.finePrint ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.45;color:#7d7889">${esc(parts.finePrint)}</p>` : '',
    '</div>',
    `<p style="margin:14px 6px 6px;font-size:12px;line-height:1.5;color:#7d7889">${esc(parts.why)}</p>`,
    `<p style="margin:0 6px;font-size:12px;line-height:1.5"><a href="${esc(parts.manageUrl)}" style="color:#4a4658">${esc(parts.manage)}</a> &nbsp;·&nbsp; <a href="${esc(parts.stopUrl)}" style="color:#4a4658">${esc(parts.stop)}</a></p>`,
    '</div></body></html>',
  ].join('')
}

/** Coins a message may truthfully promise for the first meal back: only when the rule in `welcomeMeal` is certain to pay on return. */
function mealPromise(world: World, memberId: MemberId, now: number, lastSeenAt: number): number | null {
  const gift = RULES.welcomeMeal, given = state(world).presence[memberId]?.giftAt
  if (now - lastSeenAt < gift.afterHours * HOUR || (given && now - ms(given) < gift.everyHours * HOUR)) return null
  return needsSummary(world, memberId)?.hungry ? gift.coins : null
}

/** Render one message for all three channels from the shared copy. Destinations are masked. */
function render(world: World, memberId: MemberId, draft: Draft, nudgeId: string, now: number, lastSeenAt: number, daysOverride?: number): Rendered {
  const config = deliveryConfig()
  const origin = originFor(world, memberId)
  const prefs = prefsOf(world, memberId)
  const timezone = quietFor(world, memberId).timezone
  const profile = record(world, memberId).profile
  const context: CopyContext = {
    name: profile.displayName,
    lines: draft.listed.map(item => ({ text: item.line, short: item.short, body: item.body, count: item.count, cta: item.cta, kind: item.kind, actor: item.actorName, at: item.at, expiresAt: item.expiresAt })),
    more: draft.more, earlier: draft.earlier, now, timezone, lastSeenAt,
    days: daysOverride ?? Math.floor((now - lastSeenAt) / DAY), coins: careerPoints(world, memberId),
    meal: mealPromise(world, memberId, now, lastSeenAt),
  }
  const copy = composeMessage(draft.type, context)
  const path = (link: string): string => withParam(link, NUDGE_PARAM, nudgeId)
  const mainPath = draft.type === 'digest' ? path('/inbox') : draft.type === 'checkin' ? path('/') : path(draft.listed[0]!.link)
  const manageUrl = `${origin}/settings?tab=notifications`
  // The service's own page: it shows a button (GET) and unsubscribes on POST, with no sign-in.
  const stopUrl = (channel: ExternalChannel): string => `${origin}${UNSUBSCRIBE_PATH}?token=${unsubscribeToken(world, memberId, channel)}`
  const listed = draft.type === 'digest' ? draft.listed.map(item => ({ line: item.line, cta: item.cta, url: `${origin}${path(item.link)}` })) : []
  const more = draft.more > 0 ? `${FRAME.more(draft.more)}.` : null
  const why = FRAME.why(CHANNEL_WORD.email, prefs.caps.perDay, prefs.caps.perWeek)
  const greeting = FRAME.greeting(profile.displayName)

  const text = [
    greeting, '', ...copy.paragraphs.flatMap(paragraph => [paragraph, '']),
    ...listed.flatMap(item => [`• ${item.line}`, `  ${item.cta}: ${item.url}`]), ...(listed.length ? [''] : []),
    ...(more ? [more, ''] : []),
    `${copy.cta}: ${origin}${mainPath}`,
    ...(copy.finePrint ? ['', copy.finePrint] : []),
    '', '--', why, `${FRAME.manage}: ${manageUrl}`, `${FRAME.stop(CHANNEL_WORD.email)}: ${stopUrl('email')}`,
  ].join('\n')
  const html = emailHtml({
    subject: copy.subject, preheader: copy.paragraphs[0] ?? copy.subject, greeting, paragraphs: copy.paragraphs, items: listed, more,
    cta: copy.cta, url: `${origin}${mainPath}`, finePrint: copy.finePrint, why, manage: FRAME.manage, manageUrl, stop: FRAME.stop(CHANNEL_WORD.email), stopUrl: stopUrl('email'),
  })

  const template = WHATSAPP_TEMPLATES[draft.type]
  const variables = copy.variables.map(whatsappValue)
  return {
    email: {
      from: config.emailFrom, to: externalConsent(world, memberId, 'email').masked, subject: copy.subject, text, html,
      headers: {
        'List-Unsubscribe': `<${stopUrl('email')}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
    whatsapp: {
      to: externalConsent(world, memberId, 'whatsapp').masked, template: template.name, language: template.language, category: template.category,
      variables, footer: template.footer,
      buttons: [
        { text: template.buttons[0].text, url: `${origin}${mainPath}` },
        { text: template.buttons[1].text, url: stopUrl('whatsapp') },
      ],
      preview: fillTemplate(template.body, variables),
    },
    push: { title: copy.push.title, body: copy.push.body, link: `${origin}${mainPath}` },
  }
}

/** The workflow run a channel's adapter would ask for. Flat strings only (see docs/COMEBACK.md). */
export function triggerFor(world: World, nudge: { id: string; to: MemberId; channel: ExternalChannel; type: MessageType }, rendered: Rendered): WorkflowTrigger {
  const origin = originFor(world, nudge.to)
  if (nudge.channel === 'email') {
    return {
      flowId: 'comeback-email',
      triggerData: {
        email: externalConsent(world, nudge.to, 'email').destination, subject: rendered.email.subject, html: rendered.email.html, text: rendered.email.text,
        unsubscribeUrl: rendered.email.headers['List-Unsubscribe']!.slice(1, -1), nudgeId: nudge.id,
      },
    }
  }
  if (nudge.channel === 'whatsapp') {
    const data: Record<string, string> = { phoneNumber: externalConsent(world, nudge.to, 'whatsapp').destination, nudgeId: nudge.id }
    rendered.whatsapp.variables.forEach((value, index) => { data[`v${index + 1}`] = value })
    // Each URL button ends in one variable: everything after the App's address.
    data.openPath = rendered.whatsapp.buttons[0]!.url.slice(origin.length + 1)
    data.stopToken = unsubscribeToken(world, nudge.to, 'whatsapp')
    return { flowId: `comeback-whatsapp-${nudge.type}`, triggerData: data }
  }
  return { flowId: 'comeback-push', triggerData: { title: rendered.push.title, body: rendered.push.body, link: rendered.push.link, nudgeId: nudge.id } }
}

/**
 * The part of .goalmatic/app.json a hosted build would declare: one email workflow and one
 * WhatsApp workflow per approved template (a template's variable count is fixed, so each gets
 * its own). Generated from the declared templates so the two cannot drift apart.
 */
export function manifestFragment(): { capabilities: unknown[]; workflows: unknown[] } {
  const trigger = (key: string) => ({ id: `${key}-ready`, nodeId: 'TRIGGER_MANUAL', name: 'A come-back message is ready', props: {} })
  const capability = (logicalResourceId: string, displayName: string, description: string) => ({
    id: `${logicalResourceId}-workflow`, kind: 'workflows', displayName, description, operations: ['workflows.run'], required: false, logicalResourceId,
  })
  const capabilities: unknown[] = [
    capability('comeback-email', 'Come-back email', 'Sends one email to a member who asked for come-back messages by email.'),
    {
      id: 'whatsapp-business-account', kind: 'integrations', displayName: 'WhatsApp Business account', description: 'The business number that approved come-back templates are sent from.',
      operations: ['integrations.connections-list'], required: false, connectionProvider: 'WHATSAPP_BUSINESS', connectionScopes: ['messages.send'],
    },
  ]
  const workflows: unknown[] = [{
    id: 'comeback-email', name: 'Come-back email', description: 'Sends the prepared email for one come-back message.', enabledOnInstall: false,
    trigger: trigger('comeback-email'),
    steps: [{ id: 'send-email', nodeId: 'SEND_EMAIL', name: 'Send the come-back email', props: { emailType: 'html', recipientEmail: '{{trigger.email}}', subject: '{{trigger.subject}}', message: '{{trigger.html}}' } }],
  }]
  for (const template of Object.values(WHATSAPP_TEMPLATES)) {
    const logical = `comeback-whatsapp-${template.type}`
    capabilities.push(capability(logical, `Come-back WhatsApp: ${template.name}`, `Sends the approved template ${template.name}.`))
    workflows.push({
      id: logical, name: `Come-back WhatsApp: ${template.name}`, description: `Sends the approved WhatsApp template ${template.name} (${template.category.toLowerCase()}).`,
      enabledOnInstall: false, requiredConnectionIds: ['whatsapp-business-account'], trigger: trigger(logical),
      steps: [{
        id: 'send-template', nodeId: 'SEND_WHATSAPP_BUSINESS_TEMPLATE', name: `Send ${template.name}`,
        props: {
          connectionId: { $appConnection: 'whatsapp-business-account' }, templateName: template.name, templateLanguage: template.language,
          recipientType: 'custom', phoneNumber: '{{trigger.phoneNumber}}',
          bodyParameters: template.variables.map((_meaning, index) => ({ type: 'text', value: `@trigger-TRIGGER_MANUAL-v${index + 1}` })),
          buttonParameters: [
            { type: 'url', index: 0, value: '@trigger-TRIGGER_MANUAL-openPath' },
            { type: 'url', index: 1, value: '@trigger-TRIGGER_MANUAL-stopToken' },
          ],
        },
      }],
    })
  }
  return { capabilities, workflows }
}

export type ComebackInspectionSink = (line: string) => void
/** The default: a local file, off unless COMEBACK_OUTBOX names a path. Where there is no process (a Worker) there is none. */
const fileSink = (): ComebackInspectionSink | null => {
  const path = typeof process === 'undefined' ? undefined : process.env?.COMEBACK_OUTBOX
  if (!path) return null
  return line => {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line)
  }
}
let inspectionSink: () => ComebackInspectionSink | null = fileSink

/** Trusted server bootstrap only: where inspection lines go, or null for none. A hosted Worker passes null. */
export function setComebackInspectionSink(sink: (() => ComebackInspectionSink | null) | null): void {
  inspectionSink = sink ?? (() => null)
}

/** Local output for inspecting what would have been sent. Off unless a sink is set or COMEBACK_OUTBOX names a path. Destinations are masked. */
function outbox(world: World, nudge: NudgeRecord, rendered: Rendered, note: string): void {
  let sink: ComebackInspectionSink | null
  try { sink = inspectionSink() } catch { return }
  if (!sink) return
  const trigger = triggerFor(world, nudge, rendered)
  const masked = externalConsent(world, nudge.to, nudge.channel).masked
  if ('email' in trigger.triggerData) trigger.triggerData.email = masked
  if ('phoneNumber' in trigger.triggerData) trigger.triggerData.phoneNumber = masked
  try {
    sink(`${JSON.stringify({ at: iso(world.now()), nudgeId: nudge.id, channel: nudge.channel, type: nudge.type, state: nudge.state, sent: false, note, headers: nudge.channel === 'email' ? rendered.email.headers : undefined, trigger })}\n`)
  } catch { /* an unwritable inspection output must never affect the service */ }
}

// ── Planning ──────────────────────────────────────────────────────────────────────────────────

const usableChannels = (world: World, memberId: MemberId, prefs: ComebackPrefs): ExternalChannel[] =>
  EXTERNAL_CHANNELS.filter(channel => prefs.channels[channel] && externalConsent(world, memberId, channel).granted)

/** One channel per message. The member's preference wins; otherwise it follows what the message is. */
function pickChannel(draft: Draft, usable: ExternalChannel[], prefer: ExternalChannel | null): { channel: ExternalChannel; because: string } {
  if (prefer && usable.includes(prefer)) return { channel: prefer, because: 'your preferred channel' }
  const [order, because]: [ExternalChannel[], string] = draft.type === 'digest'
    ? [['email', 'push', 'whatsapp'], 'it can list every item with its own link']
    : draft.lead === 'person' || draft.lead === 'invite'
      ? [['push', 'whatsapp', 'email'], 'the quickest channel you switched on']
      // WhatsApp charges for every marketing template, so it goes last for anything that is not a person waiting.
      : [['push', 'email', 'whatsapp'], 'the lightest channel you switched on']
  // A channel the platform cannot deliver on at all is only used when it is the only one.
  const ranked = order.filter(channel => usable.includes(channel)).sort((a, b) => Number(!channelAdapter(a).hasPath) - Number(!channelAdapter(b).hasPath))
  return { channel: ranked[0]!, because: ranked.length === 1 ? 'the only channel you switched on' : because }
}

const readyTimes = (world: World, memberId: MemberId, since: number): number[] =>
  state(world).nudges.filter(nudge => nudge.to === memberId && nudge.readyAt && ms(nudge.readyAt) > since).map(nudge => ms(nudge.readyAt!))

function toItems(candidates: Candidate[]): ItemRecord[] {
  return candidates.map(item => ({ notificationId: item.notificationId, actor: item.actor, count: item.count, kind: item.kind, group: item.group, line: item.line, cta: item.cta, link: item.link }))
}

function cancel(world: World, nudge: NudgeRecord, reason: string, onReturn: boolean): void {
  nudge.state = 'cancelled'
  nudge.reason = reason
  const counts = countsFor(world, nudge)
  if (onReturn) counts.cancelledOnReturn++
  else counts.cancelledOther++
  world.touch()
}

/** Hand a complete message to its channel. In dry-run it stops here, marked ready and not sent. */
function finalise(world: World, nudge: NudgeRecord, presence: Presence, rendered: Rendered, now: number, because: string): void {
  const adapter = channelAdapter(nudge.channel)
  const consent = externalConsent(world, nudge.to, nudge.channel)
  nudge.readyAt = iso(now)
  nudge.preview = rendered
  presence.nudged++
  presence.lastNudgeAt = iso(now)
  for (const item of nudge.items) presence.told[item.notificationId] = item.count
  if (nudge.type === 'checkin') presence.checkedIn = true
  const counts = countsFor(world, nudge)
  counts.prepared++
  const what = nudge.type === 'checkin' ? 'the one check-in' : describe(nudge.items.length ? nudge.items : [{ group: nudge.lead }]) + (nudge.more ? ` plus ${nudge.more} more` : '')
  const chosen = `Prepared a message about ${what} for ${CHANNEL_WORD[nudge.channel]} (${because}) after ${duration(nudge.awayHours * HOUR)} away.`
  if (adapter.mode === 'dry-run' || !adapter.accepts(consent.destination)) {
    nudge.state = 'ready-not-sent'
    nudge.reason = adapter.mode === 'dry-run'
      ? `Ready, and not sent: ${CHANNEL_WORD[nudge.channel]} sending is off until it is authorised.`
      : 'Ready, and not sent: live sending is limited to the named test destination, and this is not it.'
    counts.readyNotSent++
    outbox(world, nudge, rendered, adapter.mode === 'dry-run' ? adapter.note : nudge.reason)
    decide(world, nudge.to, presence, 'prepared', 'prepared', `${chosen} Not sent: ${CHANNEL_WORD[nudge.channel]} sending is switched off.`, nudge.id)
    world.touch()
    return
  }
  nudge.state = 'sending'
  nudge.reason = 'Handed to the provider.'
  decide(world, nudge.to, presence, 'prepared', 'prepared', `${chosen} Handed to the ${CHANNEL_WORD[nudge.channel]} provider.`, nudge.id)
  world.touch()
  const request: SendRequest = { channel: nudge.channel, destination: consent.destination, idempotencyKey: nudge.id, trigger: triggerFor(world, nudge, rendered) }
  void adapter.send(request).then(result => {
    if (result.accepted) { nudge.state = 'sent'; nudge.sentAt = iso(world.now()); nudge.reason = 'Accepted by the provider.'; counts.sent++ }
    else { nudge.state = 'failed'; nudge.reason = result.error ?? 'The provider did not accept the message.'; counts.failed++ }
    world.touch()
  })
}

/**
 * Look at one away member and decide. Returns when they are next worth looking at.
 * Order of the rules is the order a member would expect: is there anything to say, may we say
 * it, is it time, are we within the limits, where does it go, is it a decent hour.
 */
function plan(world: World, memberId: MemberId, presence: Presence, now: number): number {
  const data = state(world)
  const lastSeen = ms(presence.lastSeenAt)
  const away = now - lastSeen
  const held = data.nudges.find(nudge => nudge.to === memberId && nudge.state === 'held-quiet-hours')
  if (held && ms(held.scheduledFor) > now) return ms(held.scheduledFor)
  if (presence.stopped) return now + DAY
  // Heard from within the last few minutes: here, whatever is waiting.
  if (away < IDLE_AFTER && !held) return lastSeen + AWAY_AFTER
  if (away >= LAPSED_AFTER) {
    presence.stopped = 'lapsed'
    if (held) cancel(world, held, `Away for more than ${RULES.lapsedAfterDays} days.`, false)
    decide(world, memberId, presence, 'stopped', 'lapsed', `Away for ${duration(away)}. After ${RULES.lapsedAfterDays} days nothing more is prepared until you come back.`)
    return now + DAY
  }

  const prefs = prefsOf(world, memberId)
  const quiet = quietFor(world, memberId)
  const all = waiting(world, memberId, prefs.groups, now)
  // What was mentioned stays mentioned for as long as it is unread, even across a short visit.
  if (Array.isArray(presence.told)) presence.told = {}
  const pending = new Set<string>(pendingFor(world, memberId).map(entry => entry.id))
  for (const told of Object.keys(presence.told)) if (!pending.has(told)) delete presence.told[told]
  const unsaid = all.items.filter(item => item.count > (presence.told[item.notificationId] ?? 0))
  const fresh = unsaid.filter(item => !remindedExternally(world, memberId, item.notificationId))
  const earlier = all.items.length - unsaid.length
  const checkinAt = lastSeen + RULES.leadAfterHours.checkin * HOUR
  const mayCheckIn = prefs.groups.checkin && !presence.checkedIn
  const checkin = !fresh.length && mayCheckIn && now >= checkinAt
  const later = Math.min(now + 6 * HOUR, mayCheckIn && checkinAt > now ? checkinAt : Infinity)
  const drop = (reason: string): number => { if (held) cancel(world, held, reason, false); return later }

  // 1. Is there anything to say?
  if (!fresh.length && !checkin) {
    if (unsaid.length) decide(world, memberId, presence, 'skipped', 'already-reminded', 'What is waiting already went out as an ordinary reminder, so it is not sent a second time.')
    else if (all.items.length) decide(world, memberId, presence, 'skipped', 'nothing-new', 'Everything waiting was already in an earlier message. The same thing is never sent twice.')
    else if (all.off) decide(world, memberId, presence, 'skipped', 'kinds-off', 'What is waiting is of a kind you switched off, so it stays in your inbox only.')
    else if (all.blocked) decide(world, memberId, presence, 'skipped', 'blocked', 'The only thing waiting came from someone you and they no longer see. Nothing is said about it.')
    else decide(world, memberId, presence, 'skipped', 'nothing-waiting', `Nothing is waiting for you, so there is nothing to send.${mayCheckIn ? ` A single check-in follows after ${RULES.leadAfterHours.checkin / 24} days away.` : ''}`)
    return drop('What it was about was settled before it was due.')
  }
  const draft = draftFor(fresh, earlier, checkin)
  const subject = draft.type === 'checkin' ? 'the one check-in' : describe(fresh)

  // 2. May we say it outside the App?
  if (!prefs.enabled) {
    decide(world, memberId, presence, 'skipped', 'switched-off', `Come-back messages are switched off, so ${subject} stayed in your in-App inbox only.`)
    return drop('Come-back messages were switched off.')
  }
  const usable = usableChannels(world, memberId, prefs)
  if (!usable.length) {
    decide(world, memberId, presence, 'skipped', 'in-app-only', `No outside channel is switched on for come-back messages, so ${subject} stayed in your in-App inbox only.`)
    return drop('No outside channel is switched on any more.')
  }
  if (presence.nudged >= RULES.maxPerAbsence) {
    presence.stopped = 'max'
    decide(world, memberId, presence, 'stopped', 'stopped', `${RULES.maxPerAbsence} messages brought no visit, so nothing more is sent until you come back.`)
    return now + DAY
  }

  // 3. Is it time? Each thing may start a message only after its own wait, and only once it has settled.
  const due = checkin ? checkinAt : Math.min(...fresh.map(item => Math.max(lastSeen + RULES.leadAfterHours[item.group] * HOUR, (item.notificationId in presence.told ? item.updatedAt : item.createdAt) + RULES.settleMinutes * MINUTE)))
  if (now < due) {
    const leadWait = checkin ? null : fresh.find(item => lastSeen + RULES.leadAfterHours[item.group] * HOUR === due)
    const why = checkin ? `the check-in goes after ${RULES.leadAfterHours.checkin / 24} days away`
      : leadWait ? `${leadWait.group === 'person' || leadWait.group === 'invite' ? 'a person or an invitation' : 'your character or good news'} waits until you have been away ${RULES.leadAfterHours[leadWait.group]} hours`
        : `something new waits ${RULES.settleMinutes} minutes so that a burst becomes one message`
    decide(world, memberId, presence, 'waiting', 'too-soon', `You had been away ${duration(away)}. A message about ${subject} can go from ${stamp(due, quiet.timezone)}: ${why}.`)
    return due
  }

  // 4. Are we within the limits?
  if (presence.nudged > 0 && presence.lastNudgeAt) {
    const gap = RULES.backoffDays[presence.nudged - 1] ?? RULES.backoffDays.at(-1)!
    const notBefore = ms(presence.lastNudgeAt) + gap * DAY
    if (now < notBefore) {
      decide(world, memberId, presence, 'waiting', `backoff-${presence.nudged}`, `The last message brought no visit, so the next one waits ${gap} ${gap === 1 ? 'day' : 'days'}, until ${stamp(notBefore, quiet.timezone)}.`)
      return notBefore
    }
  }
  const lastDay = readyTimes(world, memberId, now - DAY), lastWeek = readyTimes(world, memberId, now - 7 * DAY)
  if (lastDay.length >= prefs.caps.perDay) {
    const free = Math.min(...lastDay) + DAY
    decide(world, memberId, presence, 'waiting', 'cap-day', `The limit of ${prefs.caps.perDay} a day is reached. The next message can go from ${stamp(free, quiet.timezone)}.`)
    return free
  }
  if (lastWeek.length >= prefs.caps.perWeek) {
    const free = Math.min(...lastWeek) + 7 * DAY
    decide(world, memberId, presence, 'waiting', 'cap-week', `The limit of ${prefs.caps.perWeek} a week is reached. The next message can go from ${stamp(free, quiet.timezone)}.`)
    return free
  }

  // 5. Where does it go?
  const picked = held && usable.includes(held.channel) ? { channel: held.channel, because: held.because } : pickChannel(draft, usable, prefs.prefer)
  const nudge: NudgeRecord = held ?? {
    id: newId<NudgeId>('ng'), to: memberId, absence: presence.absence, channel: picked.channel, type: draft.type, lead: draft.lead, state: 'held-quiet-hours',
    createdAt: iso(now), scheduledFor: iso(now), readyAt: null, sentAt: null, openedAt: null, returnedAt: null, awayHours: 0, items: [], more: 0, reason: '', preview: null, because: picked.because,
  }
  nudge.channel = picked.channel
  nudge.because = picked.because
  nudge.type = draft.type
  nudge.lead = draft.lead
  nudge.items = toItems(draft.listed)
  nudge.more = draft.more
  nudge.awayHours = Math.floor(away / HOUR)
  if (!held) {
    data.nudges.unshift(nudge)
    const mine = data.nudges.filter(entry => entry.to === memberId)
    for (const old of mine.slice(KEPT_PER_MEMBER)) data.nudges.splice(data.nudges.indexOf(old), 1)
  }
  const rendered = render(world, memberId, draft, nudge.id, now, lastSeen)

  // 6. Is it a decent hour?
  const until = quietUntil(now, quiet)
  if (until) {
    nudge.state = 'held-quiet-hours'
    nudge.scheduledFor = iso(until)
    nudge.preview = rendered
    nudge.reason = `Held until quiet hours end (${quiet.end} ${quiet.timezone}). It is put together again then, from whatever is waiting.`
    decide(world, memberId, presence, 'held', 'quiet-hours', `It is quiet hours (${quiet.start} to ${quiet.end}, ${quiet.timezone}), so the message about ${subject} waits until ${stamp(until, quiet.timezone)}.`, nudge.id)
    world.touch()
    return until
  }
  nudge.scheduledFor = iso(now)
  finalise(world, nudge, presence, rendered, now, picked.because)
  return now + Math.min(6 * HOUR, (RULES.backoffDays[presence.nudged - 1] ?? 1) * DAY)
}

function pass(world: World, now: number): void {
  if (now - (lastPass.get(world) ?? -Infinity) < PASS_EVERY) return
  lastPass.set(world, now)
  const due = checks(world)
  for (const [memberId, presence] of Object.entries(state(world).presence)) {
    if ((due.get(memberId) ?? 0) > now) continue
    if (!exists(world, memberId as MemberId)) continue
    due.set(memberId, plan(world, memberId as MemberId, presence, now))
  }
}

// ── Presence: what counts as being here ───────────────────────────────────────────────────────
// A member is here while the service keeps hearing from them: an action (any operation that is
// not a plain read), a step in the street (the kernel reports walking twice a minute), or the
// App's own "this tab is visible" beat (`comeback.here`, every two minutes while the page is on
// screen). An open socket alone is not presence. After IDLE_AFTER with nothing heard, the member
// is treated exactly as if they had left when they were last heard from.

/** Reads the App makes on its own (after a push, on a timer). They say nothing about the person. */
const PASSIVE = /\.(list|get|state|status|prefs|me|public|face|preview|career|places|mine|live|games|standings|myStanding|privacy|catalog|product|byModel|mySeller|sellerQueue|forListing|visitable|deliveries|stats|peek|menu|chatHistory|watch|unwatch|focus|wayToSpot|wayToFriend|place|here|opened|quote)$/
/** Members whose App said its tab is hidden. Whatever it sends until it is visible again is automatic. */
const hiddenTabs = new WeakMap<World, Set<string>>()
const hidden = (world: World): Set<string> => {
  let set = hiddenTabs.get(world)
  if (!set) { set = new Set(); hiddenTabs.set(world, set) }
  return set
}

type ActivityListener = (world: World, memberId: MemberId, now: number, activeUntil: number) => void
const activityListeners: ActivityListener[] = []
const activityTimes = new WeakMap<World, Map<MemberId, number>>()

/** Exact activity times stay in memory; the existing minute-throttled presence remains durable. */
export function activityUntil(world: World, memberId: MemberId): number {
  const last = activityTimes.get(world)?.get(memberId)
  const saved = state(world).presence[memberId]?.lastSeenAt
  return (last ?? (saved ? ms(saved) : world.now())) + IDLE_AFTER
}

/** Other modules hear only activity accepted by the same rules as the come-back engine. */
export function onActivity(listener: ActivityListener): void { activityListeners.push(listener) }

/** The service heard from the member just now. Ends an absence if there was one. */
function heard(world: World, memberId: MemberId, now: number): void {
  if (!exists(world, memberId)) return
  let times = activityTimes.get(world)
  if (!times) { times = new Map(); activityTimes.set(world, times) }
  times.set(memberId, now)
  for (const listener of activityListeners) listener(world, memberId, now, now + IDLE_AFTER)
  const data = state(world)
  const presence = data.presence[memberId]
  if (!presence) { data.presence[memberId] = freshPresence(now); checks(world).set(memberId, now + AWAY_AFTER); world.touch(); return }
  const gap = now - ms(presence.lastSeenAt)
  if (gap >= IDLE_AFTER) { returned(world, memberId, presence, now, gap); return }
  // Written at most once a minute: presence must not turn every step into a save.
  if (gap >= MINUTE) { presence.lastSeenAt = iso(now); checks(world).set(memberId, now + AWAY_AFTER); world.touch() }
}

/** The member is back after `away` ms of silence: pending messages are dropped and the return is counted. */
function returned(world: World, memberId: MemberId, presence: Presence, now: number, away: number): void {
  const data = state(world)
  const mine = data.nudges.filter(nudge => nudge.to === memberId && nudge.absence === presence.absence)
  let dropped = 0
  for (const nudge of mine) if (nudge.state === 'held-quiet-hours') { cancel(world, nudge, 'You came back before it was due, so it was dropped.', true); dropped++ }
  const answered = mine.filter(nudge => nudge.readyAt && !nudge.returnedAt && now - ms(nudge.readyAt) <= RULES.returnWindowHours * HOUR).sort((a, b) => ms(b.readyAt!) - ms(a.readyAt!))[0]
  if (answered) { answered.returnedAt = iso(now); countsFor(world, answered).returned++ }
  if (away >= AWAY_AFTER) {
    data.absences.ended++
    if (mine.some(nudge => nudge.readyAt)) data.absences.endedAfterMessage++
    else data.absences.endedWithoutMessage++
    decide(world, memberId, presence, 'returned', `returned-${presence.absence}`, `You came back after ${duration(away)} away.${dropped ? ' The message that was waiting was dropped.' : ''} The wait after an unanswered message starts over; the daily and weekly limits still count.`)
    // In the App there is no consent question: greet with everything still waiting, strongest first.
    const everything = waiting(world, memberId, { person: true, invite: true, character: true, progress: true, checkin: true }, now).items
    const items: NudgeItem[] = everything.slice(0, 3).map(item => ({ kind: item.kind, group: item.group, line: item.line, cta: item.cta, link: item.link }))
    const gift = welcomeMeal(world, memberId, presence, now, away)
    if (gift) items.unshift(gift)
    if (items.length && world.isOnline(memberId)) {
      world.push(memberId, { type: 'comeback.welcome', awayHours: Math.floor(away / HOUR), total: everything.length + (gift ? 1 : 0), items })
      // What the Welcome back card showed has been said: it is not sent outside the App afterwards.
      if (Array.isArray(presence.told)) presence.told = {}
      for (const item of everything.slice(0, 3)) presence.told[item.notificationId] = item.count
    }
  }
  presence.lastSeenAt = iso(now)
  presence.absence++
  presence.nudged = 0
  presence.lastNudgeAt = null
  presence.stopped = null
  presence.checkedIn = false
  checks(world).set(memberId, now + AWAY_AFTER)
  world.touch()
  if (dropped || answered) world.push(memberId, { type: 'comeback.changed' })
}

/**
 * The one thing waiting in the game itself for someone who returns: if they were away most of a
 * day and their character is hungry, the first meal back is covered. Play coins, once in any 24
 * hours, and only when the character really is hungry (read from the daily-life module).
 */
function welcomeMeal(world: World, memberId: MemberId, presence: Presence, now: number, away: number): NudgeItem | null {
  const gift = RULES.welcomeMeal
  if (away < gift.afterHours * HOUR) return null
  if (presence.giftAt && now - ms(presence.giftAt) < gift.everyHours * HOUR) return null
  if (!needsSummary(world, memberId)?.hungry) return null
  presence.giftAt = iso(now)
  state(world).gifts = (state(world).gifts ?? 0) + 1
  addPoints(world, memberId, gift.coins, { kind: 'gift', text: 'Welcome back · your first meal is on us' })
  return { kind: 'comeback.meal', group: 'character', line: WELCOME_MEAL_LINE, cta: 'Find somewhere to eat', link: '/' }
}

/** Disconnecting says nothing new: the member was last here when they were last heard from. */
function left(world: World, memberId: MemberId): void {
  hidden(world).delete(memberId)
  const presence = state(world).presence[memberId]
  if (presence) checks(world).set(memberId, ms(presence.lastSeenAt) + AWAY_AFTER)
}

/** Record that a member did something just now, for a caller that knows of real activity. */
export function markSeen(world: World, memberId: MemberId): void { heard(world, memberId, world.now()) }

// ── Unsubscribe and consent ───────────────────────────────────────────────────────────────────

/**
 * Honour an unsubscribe token: consent for that channel is withdrawn, the destination forgotten,
 * and anything waiting cancelled. Safe to call from an HTTP route with no session (RFC 8058).
 */
export function unsubscribeByToken(world: World, token: string): { memberId: MemberId; channel: ExternalChannel } | null {
  const target = readToken(world, token)
  if (!target) return null
  const data = state(world)
  data.unsubscribes++
  const latest = data.nudges.find(nudge => nudge.to === target.memberId && nudge.channel === target.channel && nudge.readyAt)
  if (latest) countsFor(world, latest).unsubscribed++
  withdrawConsent(world, target.memberId, target.channel, 'Unsubscribed with the link in a message')
  return target
}

function consentWithdrawn(world: World, memberId: MemberId, channel: ExternalChannel): void {
  const data = state(world)
  const presence = data.presence[memberId]
  const stored = data.prefs[memberId]
  if (stored) { stored.channels = { ...defaultComebackPrefs().channels, ...stored.channels, [channel]: false }; if (stored.prefer === channel) stored.prefer = null }
  let dropped = 0
  for (const nudge of data.nudges) {
    if (nudge.to !== memberId || nudge.channel !== channel) continue
    if (nudge.state === 'held-quiet-hours') { cancel(world, nudge, `Consent for ${CHANNEL_WORD[channel]} was withdrawn.`, false); dropped++ }
    // Old previews keep only a masked destination; drop even that.
    if (nudge.preview) nudge.preview = { ...nudge.preview, email: { ...nudge.preview.email, to: '' }, whatsapp: { ...nudge.preview.whatsapp, to: '' } }
  }
  if (presence && (dropped || stored)) {
    decide(world, memberId, presence, 'cancelled', `consent-withdrawn-${channel}-${world.now()}`, `Consent for ${CHANNEL_WORD[channel]} was withdrawn. The destination is forgotten and nothing more goes there${dropped ? '; the message that was waiting was dropped' : ''}.`)
  }
  checks(world).delete(memberId)
  world.touch()
  world.push(memberId, { type: 'comeback.changed' })
}

/** After a block, nothing already prepared may still mention the other person. */
function scrub(world: World, memberId: MemberId, other: MemberId): void {
  for (const nudge of state(world).nudges) {
    if (nudge.to !== memberId || !nudge.items.some(item => item.actor === other)) continue
    nudge.items = nudge.items.filter(item => item.actor !== other)
    nudge.preview = null
    if (nudge.state === 'held-quiet-hours') { if (!nudge.items.length) cancel(world, nudge, 'It was about someone you and they no longer see.', false) }
    else nudge.reason = `${nudge.reason} Part of it was about someone you and they no longer see, so its text is no longer kept.`
    world.touch()
  }
  checks(world).delete(memberId)
}

// Module-level hooks, registered once however many worlds a process creates.
onBlock((world, blocker, blocked) => { scrub(world, blocker, blocked); scrub(world, blocked, blocker) })
onConsentWithdrawn((world, memberId, channel) => consentWithdrawn(world, memberId, channel))
// A new event for an away member is looked at on the next pass instead of at their next scheduled check.
onEmit((world, event) => { checks(world).delete(event.to) })

// ── Views ─────────────────────────────────────────────────────────────────────────────────────

const toClient = ({ to: _to, absence: _absence, lead: _lead, because: _because, items, ...nudge }: NudgeRecord): Nudge => ({
  ...nudge, items: items.map(({ notificationId: _id, actor: _actor, count: _count, ...item }) => item),
})

function statusOf(world: World, memberId: MemberId): ComebackStatus {
  const data = state(world)
  const now = world.now()
  const prefs = prefsOf(world, memberId)
  const channels: ComebackChannel[] = EXTERNAL_CHANNELS.map(channel => {
    const consent = externalConsent(world, memberId, channel)
    const adapter = channelAdapter(channel)
    return { channel, consented: consent.granted, destination: consent.masked, enabled: prefs.channels[channel] && consent.granted, mode: adapter.mode, note: adapter.note }
  })
  return {
    away: { state: awayState(world, memberId), online: world.isOnline(memberId), lastSeenAt: data.presence[memberId]?.lastSeenAt ?? null },
    prefs, channels,
    usage: { last24h: readyTimes(world, memberId, now - DAY).length, last7d: readyTimes(world, memberId, now - 7 * DAY).length },
    nudges: data.nudges.filter(nudge => nudge.to === memberId).slice(0, 20).map(toClient),
    decisions: (data.decisions[memberId] ?? []).slice(0, 20),
  }
}

function parsePrefs(value: unknown): ComebackPrefs {
  const raw = obj(value, 'prefs')
  const groups = obj(raw.groups, 'prefs.groups'), channels = obj(raw.channels, 'prefs.channels'), caps = obj(raw.caps, 'prefs.caps')
  const limits = RULES.capLimits
  return {
    enabled: bool(raw, 'enabled'),
    groups: { person: bool(groups, 'person'), invite: bool(groups, 'invite'), character: bool(groups, 'character'), progress: bool(groups, 'progress'), checkin: bool(groups, 'checkin') },
    channels: { email: bool(channels, 'email'), whatsapp: bool(channels, 'whatsapp'), push: bool(channels, 'push') },
    prefer: optOneOf(raw, 'prefer', EXTERNAL_CHANNELS),
    caps: {
      perDay: num(caps, 'perDay', { integer: true, min: limits.perDay.min, max: limits.perDay.max }),
      perWeek: num(caps, 'perWeek', { integer: true, min: limits.perWeek.min, max: limits.perWeek.max }),
    },
  }
}

function previewFor(world: World, memberId: MemberId): ComebackPreview {
  const now = world.now()
  const prefs = prefsOf(world, memberId)
  const all = waiting(world, memberId, prefs.groups, now)
  const basis = all.items.length ? 'waiting' : 'checkin'
  const draft = draftFor(all.items, 0, false)
  // The check-in is shown as it would read on the day it could first go out.
  const weekDays = RULES.leadAfterHours.checkin / 24
  const rendered = render(world, memberId, draft, 'preview', now, basis === 'checkin' ? now - weekDays * DAY : now, basis === 'checkin' ? weekDays : undefined)
  const usable = usableChannels(world, memberId, prefs)
  const picked = prefs.enabled && usable.length ? pickChannel(draft, usable, prefs.prefer) : null
  const wait = basis === 'checkin' ? `${weekDays} days` : `${Math.min(...all.items.map(item => RULES.leadAfterHours[item.group]))} hours`
  const about = basis === 'checkin'
    ? (prefs.groups.checkin ? `Nothing is waiting for you right now, so this is the single check-in that would go after ${wait} away.` : 'Nothing is waiting for you right now and the check-in is switched off, so nothing would be sent. This is what the check-in would say.')
    : `This is what is waiting for you right now. It would be put together after ${wait} away, outside your quiet hours.`
  const where = !prefs.enabled ? ' Come-back messages are switched off, so it would stay in your inbox only.'
    : !picked ? ' No outside channel is switched on, so it would stay in your inbox only.'
      : channelAdapter(picked.channel).mode === 'live' ? ` It would go by ${CHANNEL_WORD[picked.channel]} (${picked.because}).`
        : ` It would be prepared for ${CHANNEL_WORD[picked.channel]} (${picked.because}) and not sent: sending is off until it is authorised.`
  return {
    basis, type: draft.type, items: toItems(draft.listed).map(({ notificationId: _id, actor: _actor, count: _count, ...item }) => item), more: draft.more,
    channel: picked?.channel ?? null, explanation: `${about}${where}`, rendered,
  }
}

function statsOf(world: World): ComebackStats {
  const data = state(world)
  const sum = (filter: (channel: ExternalChannel, type: MessageType) => boolean): ComebackCounts => {
    const total = zeroCounts()
    for (const [key, counts] of Object.entries(data.counts)) {
      const [channel, type] = key.split('|') as [ExternalChannel, MessageType]
      if (!filter(channel, type)) continue
      for (const name of Object.keys(total) as (keyof ComebackCounts)[]) total[name] += counts[name]
    }
    return total
  }
  const types = [...new Set(Object.keys(data.counts).map(key => key.split('|')[1] as MessageType))]
  const members: Record<AwayState, number> = { active: 0, 'away-today': 0, 'away-3-days': 0, 'away-week': 0, lapsed: 0 }
  for (const memberId of Object.keys(data.presence)) members[awayState(world, memberId as MemberId)]++
  return {
    returnWindowHours: RULES.returnWindowHours,
    totals: { ...sum(() => true), unsubscribed: data.unsubscribes },
    byType: types.map(type => ({ type, counts: sum((_channel, entry) => entry === type) })),
    byChannel: EXTERNAL_CHANNELS.map(channel => ({ channel, counts: sum(entry => entry === channel) })),
    notPrepared: Object.entries(data.notPrepared).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    absences: { ...data.absences },
    welcomeMeals: data.gifts ?? 0,
    members,
  }
}

// ── Operations ────────────────────────────────────────────────────────────────────────────────

export function registerComeback(world: World): void {
  world.onConnect(memberId => { hidden(world).delete(memberId); heard(world, memberId, world.now()) })
  world.onDisconnect(memberId => left(world, memberId))
  world.onOperation((memberId, op, now) => { if (!PASSIVE.test(op) && !hidden(world).has(memberId)) heard(world, memberId, now) })

  // The App's beat: sent when its tab becomes visible or hidden, and every two minutes while visible.
  world.register('comeback.here', value => {
    const raw = obj(value)
    return { visible: bool(raw, 'visible'), origin: parseOrigin(raw.origin) }
  }, (ctx, input) => {
    if (input.origin) rememberOrigin(world, ctx.memberId, input.origin)
    if (input.visible) { hidden(world).delete(ctx.memberId); heard(world, ctx.memberId, ctx.now) }
    else hidden(world).add(ctx.memberId)
    return { here: input.visible }
  })
  world.onTick(now => pass(world, now))

  world.register('comeback.status', empty, ctx => ({ status: statusOf(world, ctx.memberId) }))

  world.register('comeback.setPrefs', value => ({ prefs: parsePrefs(obj(value).prefs) }), (ctx, input) => {
    const data = state(world)
    for (const channel of EXTERNAL_CHANNELS) {
      if (input.prefs.channels[channel] && !externalConsent(world, ctx.memberId, channel).granted) {
        throw new WorldError('conflict', `Allow ${CHANNEL_WORD[channel]} and add where it should go under “Where reminders may go” first.`)
      }
    }
    if (input.prefs.prefer && !input.prefs.channels[input.prefs.prefer]) input.prefs.prefer = null
    if (input.prefs.caps.perWeek < input.prefs.caps.perDay) throw new WorldError('invalid', 'The weekly limit cannot be lower than the daily one.')
    data.prefs[ctx.memberId] = input.prefs
    // Anything waiting on a channel or kind that was just switched off is dropped now, not at its due time.
    for (const nudge of data.nudges) {
      if (nudge.to !== ctx.memberId || nudge.state !== 'held-quiet-hours') continue
      if (!input.prefs.enabled || !input.prefs.channels[nudge.channel]) cancel(world, nudge, 'You switched this off.', false)
    }
    checks(world).delete(ctx.memberId)
    world.touch()
    return { status: statusOf(world, ctx.memberId) }
  })

  world.register('comeback.preview', value => ({ origin: parseOrigin(obj(value).origin) }), (ctx, input) => {
    if (input.origin) rememberOrigin(world, ctx.memberId, input.origin)
    return { preview: previewFor(world, ctx.memberId) }
  })

  world.register('comeback.opened', value => ({ nudgeId: id<NudgeId>(obj(value), 'nudgeId', 'ng') }), (ctx, input) => {
    const nudge = state(world).nudges.find(entry => entry.id === input.nudgeId && entry.to === ctx.memberId)
    // An old link whose record is gone is not an error for the person who followed it.
    if (!nudge) return { opened: false }
    if (!nudge.openedAt) { nudge.openedAt = iso(ctx.now); countsFor(world, nudge).opened++; world.touch() }
    return { opened: true }
  })

  world.register('comeback.unsubscribe', value => ({ token: str(obj(value), 'token', { min: 10, max: 300 }) }), (ctx, input) => {
    world.limit(`unsubscribe:${ctx.memberId}`, 10, 600_000)
    const target = unsubscribeByToken(world, input.token)
    if (!target) throw new WorldError('invalid', 'That unsubscribe link is not valid. You can switch messages off in Settings instead.')
    return { channel: target.channel, stopped: true as const }
  })

  world.register('comeback.stats', empty, ctx => {
    if (!record(world, ctx.memberId).reviewer) throw new WorldError('forbidden', 'Only reviewers can read these numbers.')
    return { stats: statsOf(world) }
  })
}
