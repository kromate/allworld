// Return notifications.
//
// Every event lands in the member's durable in-App inbox. External reminders (email, WhatsApp,
// push) are prepared as deliveries with an exact preview, then held, suppressed or released by
// the rules below. The adapters run in dry-run mode: nothing leaves this service until a real
// destination test is authorized, and a dry-run is never reported as sent.
import type { DeliveryId, Iso, MemberId, NotificationId } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import {
  DEFAULT_REMINDER_DELAY_MINUTES, EXTERNAL_CHANNELS, NOTIFY_CATEGORIES,
} from '../src/shared/notify.ts'
import type {
  AdapterStatus, Channel, Delivery, DeliveryState, ExternalChannel, Notification, NotificationState, NotifyCategory, NotifyPrefs, QuietHours,
} from '../src/shared/notify.ts'
import { brand } from '../src/brand.ts'
import type { World } from './kernel.ts'
import { exists, isBlockedEitherWay, tryPublicMember } from './members.ts'
import { bool, empty, id, num, obj, oneOf, optOneOf, str } from './parse.ts'

interface NotificationRecord {
  id: NotificationId
  to: MemberId
  category: NotifyCategory
  kind: string
  title: string
  body: string
  link: string
  actor: MemberId | null
  dedupeKey: string
  createdAt: Iso
  updatedAt: Iso
  expiresAt: Iso | null
  readAt: Iso | null
  state: NotificationState
  count: number
}
interface PrefsRecord extends Omit<NotifyPrefs, 'consent'> {
  /** Full destinations stay here. Clients only ever receive the masked form. */
  consent: Record<ExternalChannel, { granted: boolean; destination: string; grantedAt: Iso | null }>
}
interface DeliveryRecord {
  id: DeliveryId
  to: MemberId
  notificationId: NotificationId
  channel: ExternalChannel
  state: DeliveryState
  scheduledFor: Iso
  updatedAt: Iso
  preview: { to: string; subject: string; text: string }
  reason: string
}
interface NotifyState {
  notifications: Record<string, NotificationRecord[]>
  prefs: Record<string, PrefsRecord>
  deliveries: DeliveryRecord[]
}

const state = (world: World): NotifyState => world.slice<NotifyState>('notify', () => ({ notifications: {}, prefs: {}, deliveries: [] }))

/** External adapters. `send` is only reached in 'live' mode, which nothing enables yet. */
interface Adapter { channel: ExternalChannel; mode: 'dry-run' | 'live'; note: string; send(delivery: DeliveryRecord): void }
const ADAPTERS: Record<ExternalChannel, Adapter> = {
  email: {
    channel: 'email', mode: 'dry-run',
    note: 'Would use a Goalmatic workflow with the SEND_EMAIL node. No sender or recipient test has been authorized.',
    send: () => { throw new Error('email adapter is not authorized to send') },
  },
  whatsapp: {
    channel: 'whatsapp', mode: 'dry-run',
    note: 'Would use a Goalmatic workflow with an approved WhatsApp Business template. No template or number is provisioned.',
    send: () => { throw new Error('whatsapp adapter is not authorized to send') },
  },
  push: {
    channel: 'push', mode: 'dry-run',
    note: 'Goalmatic has no web-push capability for Apps today. Needs a push service and a service worker.',
    send: () => { throw new Error('push adapter is not authorized to send') },
  },
}
const adapterStatus = (): AdapterStatus[] => EXTERNAL_CHANNELS.map(channel => ({ channel, mode: ADAPTERS[channel].mode, note: ADAPTERS[channel].note }))

function defaultPrefs(): PrefsRecord {
  const categories = {} as NotifyPrefs['categories']
  for (const category of NOTIFY_CATEGORIES) categories[category] = { 'in-app': true, email: false, whatsapp: false, push: false }
  const consent = {} as PrefsRecord['consent']
  for (const channel of EXTERNAL_CHANNELS) consent[channel] = { granted: false, destination: '', grantedAt: null }
  return { categories, consent, quietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' }, reminderDelayMinutes: DEFAULT_REMINDER_DELAY_MINUTES }
}

function prefsOf(world: World, memberId: MemberId): PrefsRecord {
  const all = state(world).prefs
  all[memberId] ??= defaultPrefs()
  return all[memberId]
}

function mask(channel: ExternalChannel, destination: string): string {
  if (!destination) return ''
  if (channel === 'email') {
    const [name = '', domain = ''] = destination.split('@')
    return `${name.slice(0, 2)}•••@${domain}`
  }
  if (channel === 'whatsapp') return `${destination.slice(0, 4)}••••${destination.slice(-2)}`
  return 'This browser'
}

function clientPrefs(record: PrefsRecord): NotifyPrefs {
  const consent = {} as NotifyPrefs['consent']
  for (const channel of EXTERNAL_CHANNELS) consent[channel] = { ...record.consent[channel], destination: mask(channel, record.consent[channel].destination) }
  return { categories: record.categories, quietHours: record.quietHours, consent, reminderDelayMinutes: record.reminderDelayMinutes }
}

const inbox = (world: World, memberId: MemberId): NotificationRecord[] => (state(world).notifications[memberId] ??= [])
const unreadCount = (world: World, memberId: MemberId): number => inbox(world, memberId).filter(item => !item.readAt && item.state === 'active').length

function toClient(world: World, record: NotificationRecord): Notification {
  return {
    id: record.id, category: record.category, kind: record.kind, title: record.title, body: record.body, link: record.link,
    actor: record.actor ? tryPublicMember(world, record.to, record.actor) : null,
    createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, readAt: record.readAt, state: record.state, count: record.count,
  }
}

/** Minutes since local midnight in a timezone. */
function localMinutes(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: string): number => Number(parts.find(entry => entry.type === type)?.value ?? 0)
  return part('hour') * 60 + part('minute')
}
const clockMinutes = (text: string): number => { const [h = '0', m = '0'] = text.split(':'); return Number(h) * 60 + Number(m) }

/** If `at` falls in quiet hours, the first instant after they end; otherwise null. */
export function quietUntil(at: number, quiet: NotifyPrefs['quietHours']): number | null {
  if (!quiet.enabled) return null
  const start = clockMinutes(quiet.start), end = clockMinutes(quiet.end)
  if (start === end) return null
  const nowMinutes = localMinutes(at, quiet.timezone)
  const inside = start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end
  if (!inside) return null
  const wait = (end - nowMinutes + 1440) % 1440
  return at + wait * 60_000
}

export interface EmitInput {
  to: MemberId
  category: NotifyCategory
  kind: string
  title: string
  body: string
  /** App route that opens the record. */
  link: string
  actor?: MemberId | null
  /** Events sharing a key collapse into one entry while it is unread. */
  dedupeKey: string
  expiresAt?: number | null
}

/** Record an event for a member. Called by every module that has something worth returning for. */
export function emit(world: World, input: EmitInput): void {
  if (!exists(world, input.to)) return
  if (input.actor && (input.actor === input.to || isBlockedEitherWay(world, input.to, input.actor))) return
  const prefs = prefsOf(world, input.to)
  if (!prefs.categories[input.category]['in-app']) return
  const now = world.now()
  const items = inbox(world, input.to)
  const duplicate = items.find(item => item.dedupeKey === input.dedupeKey && !item.readAt && item.state === 'active')
  if (duplicate) {
    duplicate.count++
    duplicate.title = input.title
    duplicate.body = input.body
    duplicate.updatedAt = iso(now)
    world.touch()
    // The reminder already prepared for this entry stands; a second one is not created.
    for (const channel of EXTERNAL_CHANNELS) {
      if (!wantsExternal(prefs, input.category, channel)) continue
      const existing = state(world).deliveries.find(delivery => delivery.notificationId === duplicate.id && delivery.channel === channel)
      if (existing) existing.reason = `${existing.reason.split(' · folded')[0]} · folded ${duplicate.count} events into one reminder`
    }
    world.push(input.to, { type: 'notify.new', notification: toClient(world, duplicate), unread: unreadCount(world, input.to) })
    for (const hook of emitHooks) hook(world, { to: input.to, actor: input.actor ?? null, kind: input.kind })
    return
  }
  const created: NotificationRecord = {
    id: newId<NotificationId>('n'), to: input.to, category: input.category, kind: input.kind, title: input.title, body: input.body,
    link: input.link, actor: input.actor ?? null, dedupeKey: input.dedupeKey, createdAt: iso(now), updatedAt: iso(now),
    expiresAt: input.expiresAt ? iso(input.expiresAt) : null, readAt: null, state: 'active', count: 1,
  }
  items.unshift(created)
  if (items.length > 200) items.length = 200
  for (const channel of EXTERNAL_CHANNELS) if (wantsExternal(prefs, input.category, channel)) schedule(world, created, channel, prefs)
  world.touch()
  world.push(input.to, { type: 'notify.new', notification: toClient(world, created), unread: unreadCount(world, input.to) })
  for (const hook of emitHooks) hook(world, { to: input.to, actor: input.actor ?? null, kind: input.kind })
}

const wantsExternal = (prefs: PrefsRecord, category: NotifyCategory, channel: ExternalChannel): boolean =>
  prefs.categories[category][channel] && prefs.consent[channel].granted && Boolean(prefs.consent[channel].destination)

function schedule(world: World, notification: NotificationRecord, channel: ExternalChannel, prefs: PrefsRecord): void {
  const now = world.now()
  const text = `${notification.title}\n${notification.body}\n\nOpen: ${notification.link}`
  state(world).deliveries.unshift({
    id: newId<DeliveryId>('dl'), to: notification.to, notificationId: notification.id, channel, state: 'scheduled',
    scheduledFor: iso(now + prefs.reminderDelayMinutes * 60_000), updatedAt: iso(now),
    preview: { to: mask(channel, prefs.consent[channel].destination), subject: `${brand.name}: ${notification.title}`, text },
    reason: `Waits ${prefs.reminderDelayMinutes} min in case you read it in the App first`,
  })
  if (state(world).deliveries.length > 500) state(world).deliveries.length = 500
}

/** Mark the entries for a dedupe key as settled, for example once an invite is answered. */
export function settle(world: World, to: MemberId, dedupeKey: string, as: 'resolved' | 'expired' = 'resolved'): void {
  let changed = false
  for (const item of inbox(world, to)) {
    if (item.dedupeKey !== dedupeKey || item.state !== 'active') continue
    item.state = as
    item.updatedAt = iso(world.now())
    changed = true
  }
  if (!changed) return
  world.touch()
  world.push(to, { type: 'notify.changed', unread: unreadCount(world, to) })
}

function setDelivery(world: World, delivery: DeliveryRecord, next: DeliveryState, reason: string): void {
  delivery.state = next
  delivery.reason = reason
  delivery.updatedAt = iso(world.now())
  world.touch()
}

/** Time-driven work: expire entries, then move each prepared reminder to its next state. */
function tick(world: World, now: number): void {
  const data = state(world)
  for (const [memberId, items] of Object.entries(data.notifications)) {
    let changed = false
    for (const item of items) {
      if (item.state === 'active' && item.expiresAt && ms(item.expiresAt) <= now) { item.state = 'expired'; item.updatedAt = iso(now); changed = true }
    }
    if (changed) { world.touch(); world.push(memberId as MemberId, { type: 'notify.changed', unread: unreadCount(world, memberId as MemberId) }) }
  }
  for (const delivery of data.deliveries) {
    if (delivery.state !== 'scheduled' && delivery.state !== 'held-quiet-hours') continue
    const notification = data.notifications[delivery.to]?.find(item => item.id === delivery.notificationId)
    if (!notification) { setDelivery(world, delivery, 'suppressed-expired', 'The event no longer exists'); continue }
    if (notification.readAt) { setDelivery(world, delivery, 'suppressed-read', 'Read in the App before the reminder was due'); continue }
    if (notification.state !== 'active') { setDelivery(world, delivery, 'suppressed-expired', notification.state === 'expired' ? 'The event expired before the reminder was due' : 'The event was already settled'); continue }
    if (ms(delivery.scheduledFor) > now) continue
    const prefs = prefsOf(world, delivery.to)
    if (!wantsExternal(prefs, notification.category, delivery.channel)) { setDelivery(world, delivery, 'suppressed-expired', 'Consent or the category setting was turned off'); continue }
    const until = quietUntil(now, prefs.quietHours)
    if (until) {
      delivery.scheduledFor = iso(until)
      setDelivery(world, delivery, 'held-quiet-hours', `Held until quiet hours end (${prefs.quietHours.end} ${prefs.quietHours.timezone})`)
      continue
    }
    const adapter = ADAPTERS[delivery.channel]
    if (adapter.mode === 'dry-run') { setDelivery(world, delivery, 'ready-not-sent', `Ready. Not sent: the ${delivery.channel} adapter is in dry-run. ${adapter.note}`); continue }
    try { adapter.send(delivery); setDelivery(world, delivery, 'sent', 'Accepted by the provider') }
    catch (error) { setDelivery(world, delivery, 'failed', error instanceof Error ? error.message : 'The provider rejected the message') }
  }
}

export function registerNotify(world: World): void {
  world.onTick(now => tick(world, now))

  world.register('notify.list', value => ({ includeRead: bool(obj(value), 'includeRead') }), (ctx, input) => ({
    notifications: inbox(world, ctx.memberId).filter(item => input.includeRead || (!item.readAt && item.state === 'active')).slice(0, 100).map(item => toClient(world, item)),
    unread: unreadCount(world, ctx.memberId),
  }))

  // Opening marks it read and returns it even when expired, so the App can show useful context.
  world.register('notify.open', value => ({ notificationId: id<NotificationId>(obj(value), 'notificationId', 'n') }), (ctx, input) => {
    const item = inbox(world, ctx.memberId).find(entry => entry.id === input.notificationId)
    if (!item) throw new WorldError('not_found', 'That notification is no longer in your inbox.')
    if (!item.readAt) { item.readAt = iso(ctx.now); world.touch(); world.push(ctx.memberId, { type: 'notify.changed', unread: unreadCount(world, ctx.memberId) }) }
    return { notification: toClient(world, item) }
  })

  world.register('notify.readAll', value => ({ category: optOneOf(obj(value), 'category', NOTIFY_CATEGORIES) }), (ctx, input) => {
    for (const item of inbox(world, ctx.memberId)) if (!item.readAt && (!input.category || item.category === input.category)) item.readAt = iso(ctx.now)
    world.touch()
    return { unread: unreadCount(world, ctx.memberId) }
  })

  world.register('notify.prefs', empty, ctx => ({ prefs: clientPrefs(prefsOf(world, ctx.memberId)), adapters: adapterStatus() }))

  world.register('notify.setCategory', value => {
    const raw = obj(value)
    return { category: oneOf(raw, 'category', NOTIFY_CATEGORIES), channel: oneOf(raw, 'channel', ['in-app', ...EXTERNAL_CHANNELS] as const) as Channel, enabled: bool(raw, 'enabled') }
  }, (ctx, input) => {
    const prefs = prefsOf(world, ctx.memberId)
    if (input.enabled && input.channel !== 'in-app' && !prefs.consent[input.channel].granted) {
      throw new WorldError('conflict', `Give consent for ${input.channel} and add a destination before turning it on.`)
    }
    prefs.categories[input.category][input.channel] = input.enabled
    world.touch()
    return { prefs: clientPrefs(prefs) }
  })

  world.register('notify.setQuietHours', value => {
    const raw = obj(obj(value).quietHours, 'quietHours')
    const time = (key: string): string => {
      const text = str(raw, key, { max: 5 })
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new WorldError('invalid', `${key} must be a time like 22:00`)
      return text
    }
    const timezone = str(raw, 'timezone', { min: 1, max: 64 })
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw new WorldError('invalid', 'That timezone is not known.') }
    return { quietHours: { enabled: bool(raw, 'enabled'), start: time('start'), end: time('end'), timezone } }
  }, (ctx, input) => {
    const prefs = prefsOf(world, ctx.memberId)
    prefs.quietHours = input.quietHours
    world.touch()
    return { prefs: clientPrefs(prefs) }
  })

  world.register('notify.setConsent', value => {
    const raw = obj(value)
    return { channel: oneOf(raw, 'channel', EXTERNAL_CHANNELS), granted: bool(raw, 'granted'), destination: str(raw, 'destination', { max: 120 }) }
  }, (ctx, input) => {
    const prefs = prefsOf(world, ctx.memberId)
    if (input.granted) {
      if (input.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.destination)) throw new WorldError('invalid', 'Enter a valid email address.')
      if (input.channel === 'whatsapp' && !/^\+[1-9]\d{7,14}$/.test(input.destination)) throw new WorldError('invalid', 'Enter the WhatsApp number in international format, for example +2348012345678.')
      prefs.consent[input.channel] = { granted: true, destination: input.channel === 'push' ? 'this-browser' : input.destination, grantedAt: iso(ctx.now) }
    } else {
      withdrawConsent(world, ctx.memberId, input.channel, 'Consent was withdrawn')
    }
    world.touch()
    return { prefs: clientPrefs(prefs) }
  })

  world.register('notify.setReminderDelay', value => ({ minutes: num(obj(value), 'minutes', { integer: true, min: 1, max: 720 }) }), (ctx, input) => {
    const prefs = prefsOf(world, ctx.memberId)
    prefs.reminderDelayMinutes = input.minutes
    world.touch()
    return { prefs: clientPrefs(prefs) }
  })

  world.register('notify.deliveries', empty, ctx => ({
    deliveries: state(world).deliveries.filter(delivery => delivery.to === ctx.memberId).slice(0, 60)
      .map(({ to: _to, ...delivery }): Delivery => delivery),
    adapters: adapterStatus(),
  }))
}

// ── Additions for the come-back engine (service/comeback.ts) ──────────────────────────────────
// Read-only views of what is waiting, consent and quiet hours; hooks; and the adapter interface a
// real send goes through. Nothing above changed behaviour: reminders stay in dry-run.

/** An unread, still-active inbox entry: something that is waiting for the member. */
export interface PendingEntry {
  id: NotificationId
  category: NotifyCategory
  kind: string
  title: string
  body: string
  link: string
  actor: MemberId | null
  createdAt: Iso
  updatedAt: Iso
  expiresAt: Iso | null
  count: number
}
export function pendingFor(world: World, memberId: MemberId): PendingEntry[] {
  return (state(world).notifications[memberId] ?? []).filter(item => !item.readAt && item.state === 'active').map(item => ({
    id: item.id, category: item.category, kind: item.kind, title: item.title, body: item.body, link: item.link, actor: item.actor,
    createdAt: item.createdAt, updatedAt: item.updatedAt, expiresAt: item.expiresAt, count: item.count,
  }))
}

/** Consent for one external channel. The full destination never leaves the service. */
export function externalConsent(world: World, memberId: MemberId, channel: ExternalChannel): { granted: boolean; destination: string; masked: string } {
  const consent = state(world).prefs[memberId]?.consent[channel]
  if (!consent?.granted || !consent.destination) return { granted: false, destination: '', masked: '' }
  return { granted: true, destination: consent.destination, masked: mask(channel, consent.destination) }
}

export const quietHoursFor = (world: World, memberId: MemberId): QuietHours => ({ ...(state(world).prefs[memberId]?.quietHours ?? defaultPrefs().quietHours) })

/** The channel a per-event reminder for this entry is going out on (or already did), if any. */
export function remindedExternally(world: World, memberId: MemberId, notificationId: NotificationId): ExternalChannel | null {
  const covered: DeliveryState[] = ['scheduled', 'held-quiet-hours', 'ready-not-sent', 'sent']
  return state(world).deliveries.find(delivery => delivery.to === memberId && delivery.notificationId === notificationId && covered.includes(delivery.state))?.channel ?? null
}

/**
 * Withdraw consent for a channel: forget the destination, switch the channel off for every kind,
 * and cancel what was waiting. Used by `notify.setConsent` and by an unsubscribe link.
 */
export function withdrawConsent(world: World, memberId: MemberId, channel: ExternalChannel, reason: string): void {
  const prefs = prefsOf(world, memberId)
  prefs.consent[channel] = { granted: false, destination: '', grantedAt: null }
  for (const category of NOTIFY_CATEGORIES) prefs.categories[category][channel] = false
  for (const delivery of state(world).deliveries) {
    if (delivery.to === memberId && delivery.channel === channel && (delivery.state === 'scheduled' || delivery.state === 'held-quiet-hours')) {
      setDelivery(world, delivery, 'suppressed-expired', reason)
    }
  }
  world.touch()
  for (const hook of consentHooks) hook(world, memberId, channel)
}

const consentHooks: ((world: World, memberId: MemberId, channel: ExternalChannel) => void)[] = []
/** Runs after consent for a channel is withdrawn, however that happened. */
export function onConsentWithdrawn(hook: (world: World, memberId: MemberId, channel: ExternalChannel) => void): void { consentHooks.push(hook) }

const emitHooks: ((world: World, event: { to: MemberId; actor: MemberId | null; kind: string }) => void)[] = []
/** Runs after an event is recorded in a member's inbox (new or folded into an unread one). */
export function onEmit(hook: (world: World, event: { to: MemberId; actor: MemberId | null; kind: string }) => void): void { emitHooks.push(hook) }

// ── Delivery adapters ──
// One interface for every external channel. A channel is 'live' only when it is named in the
// configuration AND nothing it needs is missing; otherwise it is 'dry-run' and `send` refuses.
// On a hosted Goalmatic build the transport is a declared workflow run through the workflow REST
// API of the operator's account (docs/COMEBACK.md has the manifest fragment and payloads).

export interface WorkflowTrigger {
  /** Logical id of the declared workflow, for example "comeback-email". */
  flowId: string
  /** Flat string values: the platform resolves `{{trigger.<key>}}` one level deep. */
  triggerData: Record<string, string>
}
export interface SendRequest {
  channel: ExternalChannel
  /** Full destination. Only ever passed to a transport. */
  destination: string
  /** Stable per message, so a retry cannot send twice. */
  idempotencyKey: string
  trigger: WorkflowTrigger
}
export interface SendResult { accepted: boolean; providerRef: string | null; error: string | null }
export type Transport = (request: SendRequest) => Promise<SendResult>

export interface DeliveryConfig {
  /** Configured public address of the App (NW_APP_ORIGIN). Empty when not set: links then use the address each member's own App reported. Must be https before anything can be live. */
  appOrigin: string
  /** THE switch: channels allowed to send. Empty means everything is dry-run. */
  live: ExternalChannel[]
  /** 'test-only' sends to the named test destination and nobody else. */
  audience: 'test-only' | 'all'
  testDestinations: Partial<Record<ExternalChannel, string>>
  /** What a recipient sees as the sender. The platform's SEND_EMAIL node fixes this today. */
  emailFrom: string
  /** Workflow REST API of the operator's Goalmatic account. The key is a credential: environment only. */
  workflowApi: { url: string; key: string } | null
  /** Logical workflow id → installed (physical) flow id. */
  flowIds: Record<string, string>
}

const envList = (value: string | undefined): string[] => (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
function configFromEnv(): DeliveryConfig {
  const env = process.env
  let flowIds: Record<string, string> = {}
  try { flowIds = env.NW_FLOW_IDS ? JSON.parse(env.NW_FLOW_IDS) as Record<string, string> : {} } catch { flowIds = {} }
  const testDestinations: DeliveryConfig['testDestinations'] = {}
  if (env.NW_TEST_EMAIL) testDestinations.email = env.NW_TEST_EMAIL
  if (env.NW_TEST_WHATSAPP) testDestinations.whatsapp = env.NW_TEST_WHATSAPP
  return {
    appOrigin: (env.NW_APP_ORIGIN ?? '').replace(/\/$/, ''),
    live: envList(env.NW_LIVE_CHANNELS).filter((entry): entry is ExternalChannel => (EXTERNAL_CHANNELS as readonly string[]).includes(entry)),
    audience: env.NW_LIVE_AUDIENCE === 'all' ? 'all' : 'test-only',
    testDestinations,
    emailFrom: env.NW_EMAIL_FROM ?? 'Goalmatic <noreply@goalmatic.io>',
    workflowApi: env.NW_WORKFLOW_API_URL && env.NW_WORKFLOW_API_KEY ? { url: env.NW_WORKFLOW_API_URL, key: env.NW_WORKFLOW_API_KEY } : null,
    flowIds,
  }
}
let delivery: DeliveryConfig = configFromEnv()
export const deliveryConfig = (): DeliveryConfig => delivery
/** Change the delivery configuration in-process: deployment bootstrap and probes. */
export function configureDelivery(patch: Partial<DeliveryConfig>): void { delivery = { ...delivery, ...patch } }

const transports: Partial<Record<ExternalChannel, Transport>> = {}
/** Replace how a channel hands a message to its provider. Passing null restores the default. */
export function setTransport(channel: ExternalChannel, transport: Transport | null): void {
  if (transport) transports[channel] = transport
  else delete transports[channel]
}

/** Default transport: run the declared workflow through the operator account's workflow REST API. */
const workflowTransport: Transport = async request => {
  const api = delivery.workflowApi
  const flowId = delivery.flowIds[request.trigger.flowId]
  if (!api || !flowId) return { accepted: false, providerRef: null, error: 'The workflow API or the installed flow id is not configured.' }
  try {
    const response = await fetch(api.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${api.key}`, 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey },
      body: JSON.stringify({ flowId, triggerData: request.trigger.triggerData }),
    })
    const body = await response.json().catch(() => ({})) as { executionId?: string; message?: string }
    if (!response.ok) return { accepted: false, providerRef: null, error: body.message ?? `The workflow API answered ${response.status}.` }
    return { accepted: true, providerRef: body.executionId ?? null, error: null }
  } catch (error) {
    return { accepted: false, providerRef: null, error: error instanceof Error ? error.message : 'The workflow API could not be reached.' }
  }
}

export interface ChannelAdapter {
  channel: ExternalChannel
  mode: 'dry-run' | 'live'
  /** What this channel uses, or what it lacks. Shown to members. */
  note: string
  /** Everything that must exist before this channel can be live. Empty when it is ready. */
  missing: string[]
  /** False when the platform has no way to deliver on this channel at all. */
  hasPath: boolean
  /** In 'test-only' audience, only the named test destination is accepted. */
  accepts(destination: string): boolean
  /** Hands the message to the provider. Refuses unless the channel is live and accepts the destination. */
  send(request: SendRequest): Promise<SendResult>
}

const PATH_NOTE: Record<ExternalChannel, string> = {
  email: 'Would run a Goalmatic workflow with the SEND_EMAIL node.',
  whatsapp: 'Would run a Goalmatic workflow with the SEND_WHATSAPP_BUSINESS_TEMPLATE node and an approved template.',
  push: 'Goalmatic has no web-push capability for Apps today. Needs a push service and a service worker.',
}

/** The adapter for a channel as configured right now. */
export function channelAdapter(channel: ExternalChannel): ChannelAdapter {
  const config = delivery
  const missing: string[] = []
  const custom = transports[channel]
  if (channel === 'push' && !custom) missing.push('a push service for Apps (Goalmatic has none)')
  if (!/^https:\/\//.test(config.appOrigin)) missing.push('the public https address of the App (NW_APP_ORIGIN)')
  if (channel !== 'push' && !custom) {
    if (!config.workflowApi) missing.push('the workflow API address and key of the operator account (NW_WORKFLOW_API_URL, NW_WORKFLOW_API_KEY)')
    if (!Object.keys(config.flowIds).some(id => id.startsWith(`comeback-${channel}`))) missing.push(`the installed flow ids for the comeback-${channel} workflows (NW_FLOW_IDS)`)
  }
  if (config.audience === 'test-only' && !config.testDestinations[channel]) missing.push(`a named test destination (${channel === 'email' ? 'NW_TEST_EMAIL' : channel === 'whatsapp' ? 'NW_TEST_WHATSAPP' : 'a test device'})`)
  const wanted = config.live.includes(channel)
  const mode = wanted && !missing.length ? 'live' : 'dry-run'
  const accepts = (destination: string): boolean => config.audience === 'all' || config.testDestinations[channel] === destination
  const note = mode === 'live'
    ? (config.audience === 'all' ? 'Live.' : 'Live for the named test destination only.')
    : wanted ? `Asked to go live but still missing: ${missing.join('; ')}. Nothing is sent.` : `${PATH_NOTE[channel]} Not switched on: nothing is sent.`
  return {
    channel, mode, note, missing, accepts, hasPath: channel !== 'push' || Boolean(custom),
    async send(request) {
      if (mode !== 'live') return { accepted: false, providerRef: null, error: `The ${channel} channel is in dry-run.` }
      if (!accepts(request.destination)) return { accepted: false, providerRef: null, error: 'Not the named test destination.' }
      return (custom ?? workflowTransport)(request)
    },
  }
}
