// Evidence probe for the come-back engine: away detection by activity, the planner (priority,
// digests, caps, back-off, quiet hours, blocks, consent), the templates, unsubscribe tokens,
// measurement and the welcome-back meal.
//
// Every event here comes from the module that really produces it, in one in-process world with a
// controllable clock: direct messages and waves (service/direct.ts), hunger and exhaustion
// (service/life.ts), promotions from finished shifts (service/work.ts), introductions and meetups
// (service/social.ts). The probe emits nothing itself.
//
// Nothing here sends anything. The one "live" check at the end swaps in a transport that is an
// array in this process, to show that 'sent' is only reachable through the live switch.
//
//   node scripts/verify-comeback.ts              run the probe
//   node scripts/verify-comeback.ts --manifest   print the manifest fragment for docs/COMEBACK.md
//   node scripts/verify-comeback.ts --catalogue  print one rendered example of every message type
import assert from 'node:assert/strict'
import { createWorld } from '../service/index.ts'
import type { Connection } from '../service/kernel.ts'
import { ensureMember } from '../service/members.ts'
import { configureDelivery, setTransport } from '../service/notify.ts'
import type { SendRequest } from '../service/notify.ts'
import { manifestFragment, unsubscribeByToken } from '../service/comeback.ts'
import { needsSummary } from '../service/life.ts'
import { unsubscribe } from '../service/server.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { STARTER_PLACES } from '../src/shared/places.ts'
import { COMEBACK_RULES, MESSAGE_TYPES, WELCOME_MEAL_LINE, WHATSAPP_TEMPLATES, defaultComebackPrefs, variableCount } from '../src/shared/comeback.ts'
import type { ComebackEvent, ComebackStatus, MessageType, Nudge } from '../src/shared/comeback.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { ServerEvent, ServerFrame } from '../src/shared/protocol.ts'

if (process.argv.includes('--manifest')) { console.log(JSON.stringify(manifestFragment(), null, 2)); process.exit(0) }

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
/** Lagos is UTC+1 all year, so a Lagos wall-clock time is that hour minus one in UTC. */
const lagos = (day: number, hour: number, minute = 0): number => Date.UTC(2026, 9, day, hour - 1, minute)
/** The address the members' Apps report. No address is configured, and none is built into the service. */
const ORIGIN = 'https://play.neighbourhood.example'

let now = lagos(1, 6)
const world = createWorld({ now: () => now })
const pass = (name: string): void => console.log(`PASS ${name}`)
const code = (run: () => unknown): string => { try { run(); return 'ok' } catch (error) { return error instanceof WorldError ? error.code : `threw ${String(error)}` } }
/** Let the per-member request allowance refill between groups of calls. */
const breathe = (): void => { now += 6000 }

// ── Members ──
const member = (key: string, name: string, reviewer = false): MemberId => {
  const id = `m_cb_${key}` as MemberId
  ensureMember(world, id, name, { reviewer })
  return id
}
const ada = member('ada', 'Ada'), bayo = member('bayo', 'Bayo'), chidi = member('chidi', 'Chidi'), dara = member('dara', 'Dara')
const efe = member('efe', 'Efe'), femi = member('femi', 'Femi'), gbenga = member('gbenga', 'Gbenga'), hauwa = member('hauwa', 'Hauwa')
const kemi = member('kemi', 'Kemi'), lola = member('lola', 'Lola'), musa = member('musa', 'Musa'), zed = member('zed', 'Zed')
const tayo = member('tayo', 'Tayo'), uche = member('uche', 'Uche & <Sons>'), nne = member('nne', 'Nne'), obi = member('obi', 'Obi')
const ireti = member('ireti', 'Ireti'), jide = member('jide', 'Jide'), sade = member('sade', 'Sade')
const reviewer = member('reviewer', 'Reviewer', true)
const everyone = [ada, bayo, chidi, dara, efe, femi, gbenga, hauwa, kemi, lola, musa, zed, tayo, uche, nne, obi, ireti, jide, sade]

const events = new Map<MemberId, ServerEvent[]>()
const connections = new Map<MemberId, Connection>()
const arrive = (id: MemberId): void => {
  events.set(id, events.get(id) ?? [])
  connections.set(id, world.connect(id, (frame: ServerFrame) => { if (frame.t === 'event') events.get(id)!.push(frame.event) }, () => undefined))
}
/** What the App sends while its tab is on screen. */
const beat = (id: MemberId, visible = true, origin: string | null = ORIGIN): void => { world.call(id, 'comeback.here', { visible, origin }) }
/** On screen until this moment, then gone. */
const leave = (id: MemberId, origin: string | null = ORIGIN): void => { beat(id, true, origin); world.disconnect(connections.get(id)!); connections.delete(id) }
const welcomes = (id: MemberId): Extract<ComebackEvent, { type: 'comeback.welcome' }>[] =>
  (events.get(id) ?? []).filter((event): event is Extract<ComebackEvent, { type: 'comeback.welcome' }> => event.type === 'comeback.welcome')

// ── Clock: five-minute ticks, with actions that fall due on the way ──
const queue: { at: number; run(): void }[] = []
const at = (time: number, run: () => void): void => { queue.push({ at: time, run }); queue.sort((a, b) => a.at - b.at) }
function until(target: number): void {
  while (now < target) {
    now = Math.min(target, now + 5 * MINUTE)
    while (queue.length && queue[0]!.at <= now) queue.shift()!.run()
    world.tick()
  }
}

const status = (id: MemberId): ComebackStatus => world.call(id, 'comeback.status', {}).status
const nudges = (id: MemberId): Nudge[] => status(id).nudges
const codes = (id: MemberId): string[] => status(id).decisions.map(decision => decision.code)
const coins = (id: MemberId): number => world.call(id, 'work.career', {}).career.points
const ibadan = areaFromPlace(STARTER_PLACES.find(entry => entry.label === 'Bodija, Ibadan')!)

/** Consent with a destination, then the separate opt-in to come-back messages on that channel. */
function allow(id: MemberId, destination: string): void {
  world.call(id, 'notify.setConsent', { channel: 'email', granted: true, destination })
  const prefs = status(id).prefs
  world.call(id, 'comeback.setPrefs', { prefs: { ...prefs, channels: { ...prefs.channels, email: true } } })
}
/** A real friendship: one asks, the other accepts. Both then clear what that left in their inboxes. */
function befriend(asks: MemberId, accepts: MemberId): void {
  world.call(accepts, 'intro.respond', { introId: world.call(asks, 'intro.send', { to: accepts, note: '' }).intro.id, accept: true })
  world.call(asks, 'notify.readAll', { category: null })
}
/** A real direct message between friends. */
let sent = 0
function message(from: MemberId, to: MemberId, text = 'Are you coming on Saturday?'): void {
  const { conversation } = world.call(from, 'direct.open', { memberId: to })
  world.call(from, 'direct.send', { conversationId: conversation.id, text, clientId: `probe-${++sent}` })
}
/** A real, complete café shift: five tickets answered correctly. The first one earns a promotion. */
function workShift(id: MemberId): string {
  let { shift } = world.call(id, 'work.start', { workplaceId: 'corner-cafe', venueName: null })
  while (shift.status === 'active' && shift.current) {
    now += 3000
    shift = world.call(id, 'work.answer', { shiftId: shift.id, index: shift.current.index, handed: [...shift.current.wants] }).shift
  }
  assert.equal(shift.status, 'completed')
  return shift.result!.titleAfter
}

// Everyone lives in Ibadan. Nobody sets a quiet-hours timezone: it is still the default "UTC".
for (const id of [...everyone, reviewer]) {
  arrive(id)
  world.call(id, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
  world.call(id, 'member.completeOnboarding', {})
  beat(id, true, id === musa ? null : ORIGIN)
}
for (const friend of [bayo, dara, efe, femi, gbenga, hauwa, kemi, lola, musa, tayo, nne, obi, ireti, jide]) { befriend(friend, ada); breathe() }
befriend(bayo, chidi); befriend(bayo, zed); befriend(tayo, chidi); breathe()
for (const id of [bayo, dara, gbenga, hauwa, kemi, lola, musa, ireti, jide, sade]) allow(id, `${id.slice(5)}@example.com`)
// Femi consents to email reminders but never switches come-back messages on. Efe consents to nothing.
world.call(femi, 'notify.setConsent', { channel: 'email', granted: true, destination: 'femi@example.com' })
world.call(hauwa, 'notify.setCategory', { category: 'replies', channel: 'email', enabled: true })
assert.equal(code(() => world.call(efe, 'comeback.setPrefs', { prefs: { ...defaultComebackPrefs(), channels: { email: true, whatsapp: false, push: false } } })), 'conflict', 'come-back by email cannot be switched on without consent and a destination')
assert.deepEqual(defaultComebackPrefs().channels, { email: false, whatsapp: false, push: false }, 'every channel starts off: come-back messages are an explicit opt-in')
world.call(ada, 'notify.readAll', { category: null }); world.call(chidi, 'notify.readAll', { category: null }); world.call(zed, 'notify.readAll', { category: null })

// ════ The catalogue: every message type, each from the module that really produces it ═════════
const catalogue: { type: MessageType; subject: string; email: string; whatsapp: string; push: string }[] = []
const seenTypes = new Set<MessageType>()
function expectType(type: MessageType, subject: string | null, from: string): void {
  const preview = world.call(tayo, 'comeback.preview', { origin: ORIGIN }).preview
  assert.equal(preview.type, type, `${from} → a "${type}" message`)
  const template = WHATSAPP_TEMPLATES[type]
  const { email, whatsapp, push } = preview.rendered
  if (subject !== null) assert.equal(email.subject, subject)
  assert.equal(whatsapp.template, template.name)
  assert.equal(whatsapp.variables.length, variableCount(template.body), `${template.name}: rendered variables match the declared template`)
  assert.ok(whatsapp.variables.every(value => value.length > 0 && !/[\n\t]| {2,}/.test(value)), 'variables are single-line and non-empty')
  assert.ok(!/\{\{\d+\}\}/.test(whatsapp.preview), 'no placeholder is left unfilled')
  if (preview.items[0]) assert.ok(email.text.includes(`${ORIGIN}${preview.items[0].link}${preview.items[0].link.includes('?') ? '&' : '?'}nudge=`), 'the link opens the exact record, at the address the member’s own App reported')
  assert.ok(email.text.includes(`${ORIGIN}/world/comeback/unsubscribe?token=u1.`) && whatsapp.buttons[1]!.url.startsWith(`${ORIGIN}/world/comeback/unsubscribe?token=u1.`), 'the stop link is the service’s own unsubscribe page')
  seenTypes.add(type)
  catalogue.push({ type, subject: email.subject, email: email.text, whatsapp: whatsapp.preview, push: `${push.title} — ${push.body}` })
  world.call(tayo, 'notify.readAll', { category: null })
  breathe()
}
// Tayo's character exists from the first look at its needs. A first finished shift is a promotion.
world.call(tayo, 'life.state', {})
const tayoTitle = workShift(tayo)
expectType('promotion', `You were promoted to ${tayoTitle}`, 'a finished shift that raised the level (work)')
leave(tayo)
message(ada, tayo)
expectType('message', 'Ada sent you a message', 'a direct message (social)')
world.call(chidi, 'wave.send', { to: tayo })
expectType('person', 'Chidi waved at you', 'a wave (social)')
world.call(chidi, 'meetup.propose', {
  venue: { placeId: 'p555' as never, districtId: ibadan.arrivalDistrict, name: 'Bodija Market', category: 'shop', branch: 'main gate' },
  startsAt: new Date(lagos(3, 18)).toISOString(), timezone: 'Africa/Lagos', note: '', invite: [tayo],
})
expectType('invite', 'Chidi is waiting for your answer: Bodija Market, Sat 3 Oct, 18:00', 'a meetup invitation (people)')
world.call(uche, 'intro.respond', { introId: world.call(tayo, 'intro.send', { to: uche, note: '' }).intro.id, accept: true })
expectType('news', 'Uche & <Sons> accepted your introduction', 'an accepted introduction (people)')
assert.ok(world.call(tayo, 'comeback.preview', { origin: 'javascript:alert(1)' }).preview.rendered.email.text.includes(`${ORIGIN}/`), 'an address that is not a web origin is ignored')
// Away, the character gets hungry on its own clock.
until(lagos(1, 8, 45))
assert.equal(needsSummary(world, tayo)!.hungry, true)
expectType('hungry', 'Your character is hungry', 'hunger while away (daily life)')
message(ada, tayo, 'Still on for Saturday?'); message(uche, tayo, 'Hello from the shop')
{
  const preview = world.call(tayo, 'comeback.preview', { origin: ORIGIN }).preview
  assert.ok(preview.rendered.email.html.includes('Uche &amp; &lt;Sons&gt; sent you a message') && !preview.rendered.email.html.includes('<Sons>'), 'member names are escaped in HTML')
}
expectType('digest', 'Uche & <Sons> sent you a message, and 1 more thing', 'two things at once')
{
  const preview = world.call(tayo, 'comeback.preview', { origin: ORIGIN }).preview
  assert.equal(preview.basis, 'checkin')
  assert.ok(preview.rendered.email.text.includes('It has been 7 days'))
  assert.equal(preview.channel, null, 'Tayo switched no channel on, so the preview says it would stay in the App')
}
expectType('checkin', null, 'nothing waiting at all')
// Back in the game for four hours without resting: worn out. Away, a character rests, so this is only ever said while it is true.
arrive(tayo)
for (let minute = 0; minute <= 260; minute += 5) at(now + minute * MINUTE, () => beat(tayo))
until(now + 255 * MINUTE)
assert.equal(needsSummary(world, tayo)!.exhausted, true)
expectType('tired', 'Your character is worn out', 'exhaustion after hours online (daily life)')
assert.deepEqual([...seenTypes].sort(), [...MESSAGE_TYPES].sort(), 'every message type was rendered')
if (process.argv.includes('--catalogue')) {
  for (const entry of catalogue) console.log(`\n=== ${entry.type} ===\nSubject: ${entry.subject}\n\n${entry.email}\n\n[WhatsApp] ${entry.whatsapp}\n[Push] ${entry.push}`)
  process.exit(0)
}

// The declared WhatsApp templates obey the format rules a reviewer applies.
for (const template of Object.values(WHATSAPP_TEMPLATES)) {
  const count = variableCount(template.body)
  assert.match(template.name, /^[a-z0-9_]+$/)
  assert.ok(template.body.length <= 1024 && !/[\n\t]/.test(template.body))
  assert.ok(!/^\s*\{\{/.test(template.body) && !/\}\}\s*$/.test(template.body), `${template.name}: does not start or end with a variable`)
  assert.ok(!/\}\}\s*\{\{/.test(template.body), `${template.name}: no adjacent variables`)
  for (let index = 1; index <= count; index++) assert.ok(template.body.includes(`{{${index}}}`), `${template.name}: variables are sequential`)
  assert.equal(template.variables.length, count); assert.equal(template.sample.length, count)
  assert.ok(template.footer.length <= 60 && template.buttons.every(button => button.text.length <= 25 && button.url.endsWith('{{1}}')))
  assert.ok(['UTILITY', 'MARKETING'].includes(template.category))
}
const fragment = manifestFragment() as { workflows: { id: string; steps: { nodeId: string; props: { templateName?: string; bodyParameters?: unknown[] } }[] }[] }
for (const template of Object.values(WHATSAPP_TEMPLATES)) {
  const workflow = fragment.workflows.find(entry => entry.id === `comeback-whatsapp-${template.type}`)!
  assert.equal(workflow.steps[0]!.props.templateName, template.name)
  assert.equal(workflow.steps[0]!.props.bodyParameters!.length, variableCount(template.body), `${template.name}: the workflow passes exactly the declared variables`)
}
pass(`templates: all ${MESSAGE_TYPES.length} message types render from real events (work, social, people, daily life); each WhatsApp payload has exactly its declared template's variables; templates obey the format rules; names are escaped; links use the address the member's App reported`)

// ════ Night one: the owner's list, end to end ══════════════════════════════════════════════════
// "…your player is hungry, someone is looking for them, they got a message, they got a promotion."
until(lagos(1, 20))
world.call(bayo, 'life.state', {})
const bayoTitle = workShift(bayo)
until(lagos(1, 20, 30))
for (const id of [bayo, dara, efe, femi]) leave(id)
assert.equal(status(bayo).away.state, 'active', 'just left: not away yet')
at(lagos(1, 21), () => { for (const to of [bayo, dara, efe, femi]) message(ada, to) })
at(lagos(1, 21, 10), () => { world.call(chidi, 'wave.send', { to: bayo }) })

until(lagos(1, 23, 20))
assert.equal(nudges(bayo).length, 0, 'two hours fifty away: nothing yet')
assert.ok(codes(bayo).includes('too-soon'), 'and the reason is recorded')
until(lagos(1, 23, 30))
assert.equal(status(bayo).away.state, 'away-today')
let held = nudges(bayo)
assert.equal(held.length, 1)
assert.equal(held[0]!.state, 'held-quiet-hours', 'three hours away falls at 23:30 in Lagos: quiet hours')
assert.equal(Date.parse(held[0]!.scheduledFor), lagos(2, 7), 'held until 07:00 in the member’s own timezone (the area’s, since the setting was still the default UTC)')
assert.equal(held[0]!.readyAt, null)

// Dara comes back at 02:00: her pending message is dropped and she is greeted in the App instead.
until(lagos(2, 2))
assert.equal(nudges(dara)[0]!.state, 'held-quiet-hours')
arrive(dara)
assert.equal(nudges(dara)[0]!.state, 'cancelled', 'returning cancels the pending message')
assert.match(nudges(dara)[0]!.reason, /came back/)
assert.equal(welcomes(dara).length, 1)
assert.equal(welcomes(dara)[0]!.items[0]!.line, 'Ada sent you a message')

until(lagos(2, 6, 55))
assert.equal(nudges(bayo)[0]!.state, 'held-quiet-hours', '06:55: still quiet hours')
until(lagos(2, 7))
const night = nudges(bayo)
assert.equal(night.length, 1, 'exactly one message for four waiting things')
const digest = night[0]!
assert.equal(digest.state, 'ready-not-sent')
assert.equal(digest.type, 'digest')
assert.equal(digest.channel, 'email')
assert.equal(Date.parse(digest.readyAt!), lagos(2, 7), 'released at the end of quiet hours, not before')
assert.equal(digest.sentAt, null)
assert.deepEqual(digest.items.map(item => item.kind), ['direct.message', 'social.wave', 'life.hungry', 'work.levelup'], 'the message, then who is looking for them, then the character, then the promotion')
assert.deepEqual(digest.items.map(item => item.line), ['Ada sent you a message', 'Chidi waved at you', 'Your character has been hungry since yesterday', `You were promoted to ${bayoTitle}`])
const email = digest.preview!.email
assert.equal(email.subject, 'Ada sent you a message, and 3 more things')
for (const item of digest.items) {
  const url = `${item.link}${item.link.includes('?') ? '&' : '?'}nudge=${digest.id}`
  assert.ok(email.text.includes(`${ORIGIN}${url}`) && email.html.includes(url.replace(/&/g, '&amp;')), `the email links straight to ${item.link}`)
}
assert.match(digest.items[0]!.link, /^\/messages\/dm_/)
assert.match(digest.items[1]!.link, /^\/people\?tab=nearby&wave=wv_/)
assert.equal(digest.items[3]!.link, '/work')
const stopLink = new RegExp(`${ORIGIN.replace(/\./g, '\\.')}/world/comeback/unsubscribe\\?token=(u1\\.[\\w-]+\\.[\\w-]+)`)
assert.ok(email.text.includes(`${ORIGIN}/settings?tab=notifications`) && stopLink.test(email.text), 'manage link and signed unsubscribe link are in the body')
assert.equal(email.headers['List-Unsubscribe'], `<${stopLink.exec(email.text)![0]}>`, 'the one-click header names the same address')
assert.equal(email.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
assert.ok(email.to.includes('•••') && !JSON.stringify(status(bayo)).includes('bayo@example.com'), 'the destination is masked on the way back to the App')
assert.ok(email.text.includes('not a real job or a qualification'), 'a promotion carries the honesty note')
until(lagos(2, 8, 50))
assert.equal(nudges(bayo).length, 1, 'and nothing else follows it')
pass('the owner’s list from real modules: a friend’s message, a wave, a hungry character and a promotion → exactly one digest, in that order, held through quiet hours in the member’s timezone, released at 07:00, each with its own link')
pass('returning cancels a pending message and greets the member in the App instead')

// No consent, or consent without the come-back opt-in: the inbox only.
for (const [id, name] of [[efe, 'no consent at all'], [femi, 'email consent but come-back not switched on']] as const) {
  assert.equal(nudges(id).length, 0, `${name}: nothing is prepared for outside the App`)
  assert.ok(codes(id).includes('in-app-only'))
  assert.equal(world.call(id, 'notify.list', { includeRead: false }).notifications.filter(item => item.kind === 'direct.message').length, 1, 'the entry is in the in-App inbox')
}
arrive(efe)
assert.equal(welcomes(efe)[0]!.total, 1, 'and the member is told when they return')
pass('a member with no consent (or no come-back opt-in) gets in-App entries only, and the reason is recorded')

// Open and return tracking. In dry-run nothing was sent; the link from the preview stands in for it.
until(lagos(2, 9))
arrive(bayo)
assert.equal(welcomes(bayo)[0]!.total, 4)
assert.equal(world.call(bayo, 'comeback.opened', { nudgeId: digest.id }).opened, true)
assert.equal(world.call(dara, 'comeback.opened', { nudgeId: digest.id }).opened, false, 'another member cannot mark it')
const tracked = nudges(bayo)[0]!
assert.ok(tracked.openedAt && tracked.returnedAt, 'opened and returned are recorded on the message')
assert.equal(code(() => world.call(bayo, 'comeback.stats', {})), 'forbidden', 'aggregate numbers are for reviewers')
let stats = world.call(reviewer, 'comeback.stats', {}).stats
assert.deepEqual([stats.totals.prepared, stats.totals.readyNotSent, stats.totals.sent, stats.totals.opened, stats.totals.returned, stats.totals.cancelledOnReturn], [1, 1, 0, 1, 1, 1])
assert.equal(stats.absences.endedAfterMessage, 1)
for (const secret of ['m_cb_', 'Bayo', 'Ada', '@example.com', '•••', 'dm_']) assert.ok(!JSON.stringify(stats).includes(secret), `stats carry no ${secret}`)
pass('measurement: prepared → would-be sent → opened → returned within 48 h, per message; reviewer-only aggregate numbers with counts and nothing personal')
world.call(bayo, 'notify.readAll', { category: null })
world.call(dara, 'notify.readAll', { category: null })
leave(bayo)

// ════ Away is "nothing heard", not "socket closed" ═════════════════════════════════════════════
// Ireti hides the tab at 09:00 and never closes it. Jide keeps his on screen and only reads.
// Sade leaves at 09:00 with a character that will be hungry tomorrow.
world.call(sade, 'life.state', {})
beat(ireti); beat(ireti, false); leave(sade)
for (let minute = 0; minute <= 240; minute += 2) at(lagos(2, 9, minute), () => beat(jide))
at(lagos(2, 9, 30), () => { message(ada, ireti); message(ada, jide) })
// A hidden tab still does things on its own (here: marking a conversation delivered). That is not the person.
at(lagos(2, 10), () => { world.call(ireti, 'direct.list', {}); world.call(ireti, 'around.settings', { settings: world.call(ireti, 'around.get', {}).around.settings }) })
until(lagos(2, 12))
assert.equal(status(ireti).away.online, true, 'her socket is open the whole time')
assert.equal(status(ireti).away.state, 'away-today')
assert.equal(nudges(ireti)[0]?.state, 'ready-not-sent', 'three hours after she was last on screen, the message is prepared although she is connected')
assert.equal(Date.parse(nudges(ireti)[0]!.readyAt!), lagos(2, 12))
until(lagos(2, 13))
assert.equal(nudges(jide).length, 0, 'someone reading with the tab on screen is here: nothing is prepared')
assert.ok(!codes(jide).includes('too-soon'), 'and the planner does not even start counting')
beat(ireti)
assert.ok(nudges(ireti)[0]!.returnedAt, 'the tab coming back on screen is the return')
assert.equal(welcomes(ireti)[0]!.items[0]!.line, 'Ada sent you a message')
pass(`away by activity: a connected member is away once nothing is heard for ${COMEBACK_RULES.idleAfterMinutes} minutes (a hidden tab's automatic requests do not count); a member reading with the tab on screen is not`)
world.call(ireti, 'notify.readAll', { category: null }); world.call(jide, 'notify.readAll', { category: null })

// ════ The welcome-back meal ════════════════════════════════════════════════════════════════════
until(lagos(3, 9))
const promised = nudges(sade)[0]!
assert.equal(promised.type, 'hungry', 'a day away with nothing else waiting: the character is the reason')
assert.equal(Date.parse(promised.readyAt!), lagos(3, 9), '24 hours after she was last here, at the hour she usually is')
assert.ok(promised.preview!.email.text.includes(`The first meal back is on us: ${COMEBACK_RULES.welcomeMeal.coins} game coins are added when you return.`), 'the message says what is waiting in the game')
until(lagos(3, 10))
const before = coins(sade)
arrive(sade)
assert.equal(coins(sade), before + COMEBACK_RULES.welcomeMeal.coins, 'and it is true: the coins are there on return')
assert.deepEqual(welcomes(sade)[0]!.items.map(item => item.line), [WELCOME_MEAL_LINE, 'Your character has been hungry since yesterday'])
assert.ok(world.call(sade, 'travel.state', {}).ledger.some(entry => entry.text.startsWith('Welcome back') && entry.amount === COMEBACK_RULES.welcomeMeal.coins), 'it is in the wallet history')
leave(sade)
until(lagos(4, 6, 30))
arrive(sade)
assert.equal(coins(sade), before + COMEBACK_RULES.welcomeMeal.coins, 'back again after 20 hours, within a day of the last one: no second meal')
assert.equal(world.call(reviewer, 'comeback.stats', {}).stats.welcomeMeals, 1, 'and Bayo, back after 12 hours on the first morning, got none')
pass(`welcome-back meal: away ${COMEBACK_RULES.welcomeMeal.afterHours} hours or more with a hungry character → ${COMEBACK_RULES.welcomeMeal.coins} play coins on return, promised in the message only when certain, once in any ${COMEBACK_RULES.welcomeMeal.everyHours} hours`)

// ════ Night two ═══════════════════════════════════════════════════════════════════════════════
until(lagos(4, 20, 25))
arrive(bayo); world.call(bayo, 'notify.readAll', { category: null })
until(lagos(4, 20, 30))
for (const id of [bayo, dara, gbenga, hauwa]) leave(id)
at(lagos(4, 21), () => { message(ada, bayo); message(zed, bayo); for (const to of [dara, gbenga, hauwa]) message(ada, to) })
until(lagos(4, 23, 30))
held = nudges(bayo)
assert.equal(held[0]!.state, 'held-quiet-hours')
assert.deepEqual(held[0]!.items.map(item => item.line).sort(), ['Ada sent you a message', 'Zed sent you a message'])

// Zed blocks Bayo while the message is waiting. Nothing about Zed may remain anywhere.
until(lagos(5, 1))
world.call(zed, 'member.block', { memberId: bayo })
assert.ok(!JSON.stringify(status(bayo)).includes('Zed'), 'the pending message no longer mentions the blocked person')

// Dara's unsubscribe link is followed with no session of hers: the same function the HTTP route calls.
const daraHeld = nudges(dara)[0]!
assert.equal(daraHeld.state, 'held-quiet-hours')
const token = stopLink.exec(daraHeld.preview!.email.text)![1]!
assert.equal(code(() => world.call(reviewer, 'comeback.unsubscribe', { token: `${token.slice(0, -4)}AAAA` })), 'invalid', 'a tampered token is refused')
assert.equal(unsubscribeByToken(world, `${token}x`), null)
assert.equal(unsubscribe(world, `${token}x`, '203.0.113.9')[0], 400, 'the HTTP route answers 400 to a bad token')
assert.deepEqual(unsubscribe(world, token, '203.0.113.9'), [200, { stopped: true, channel: 'email' }], 'and 200 to the real one')
assert.equal(nudges(dara)[0]!.state, 'cancelled', 'the waiting message is cancelled at once')
assert.deepEqual(world.call(dara, 'notify.prefs', {}).prefs.consent.email, { granted: false, destination: '', grantedAt: null }, 'consent is withdrawn and the destination forgotten')
assert.equal(status(dara).channels.find(entry => entry.channel === 'email')!.enabled, false)
assert.ok(!/da•••|dara@/.test(JSON.stringify(status(dara))), 'not even the masked destination is kept')

// Gbenga withdraws consent the ordinary way, in Settings.
world.call(gbenga, 'notify.setConsent', { channel: 'email', granted: false, destination: '' })
assert.equal(nudges(gbenga)[0]!.state, 'cancelled')
assert.match(nudges(gbenga)[0]!.reason, /withdrawn/)

until(lagos(5, 7))
const second = nudges(bayo)[0]!
assert.equal(second.state, 'ready-not-sent')
assert.equal(second.type, 'message', 'with Zed gone it is a single message, not a digest')
assert.deepEqual(second.items.map(item => item.line), ['Ada sent you a message'])
assert.ok(!JSON.stringify(status(bayo)).includes('Zed'), 'blocked senders never appear')
// Hauwa already gets an ordinary email reminder for replies, so the come-back engine stays out of it.
assert.equal(nudges(hauwa).length, 0)
assert.ok(codes(hauwa).includes('already-reminded'))
until(lagos(6, 7))
for (const id of [dara, gbenga]) {
  assert.equal(nudges(id).filter(nudge => nudge.readyAt).length, 0, 'nothing more is prepared after consent is gone')
  assert.ok(codes(id).includes('in-app-only'))
}
assert.equal(nudges(bayo).filter(nudge => nudge.readyAt).length, 2, 'Bayo: one per night, nothing repeated')
pass('blocked senders never appear: a block while a message is waiting removes that person from it and from the record')
pass('unsubscribe by signed token (no session needed) and withdrawing consent both cancel what is waiting, forget the destination and stop everything; a tampered token is refused')
pass('something already going out as an ordinary reminder is not sent a second time')

// ════ A month ═════════════════════════════════════════════════════════════════════════════════
// Kemi stays away while a friend writes every five hours. Lola pops in twice a day and leaves
// again without reading. Musa leaves with nothing waiting at all.
const start = lagos(7, 8)
until(start)
leave(kemi); leave(lola); leave(musa, null)
for (let hour = 1; hour < 36 * 24; hour += 5) at(start + hour * HOUR, () => message(ada, kemi))
for (let day = 0; day < 14; day++) {
  at(start + day * DAY + 1 * HOUR, () => message(ada, lola))
  at(start + day * DAY + 4 * HOUR, () => arrive(lola)); at(start + day * DAY + 4 * HOUR + 10 * MINUTE, () => leave(lola))
  at(start + day * DAY + 7 * HOUR, () => message(ada, lola))
  at(start + day * DAY + 10 * HOUR, () => arrive(lola)); at(start + day * DAY + 10 * HOUR + 10 * MINUTE, () => leave(lola))
}
const musaStates: string[] = []
for (const offset of [2 * HOUR, 4 * HOUR, 4 * DAY, 8 * DAY, 31 * DAY]) at(start + offset, () => musaStates.push(status(musa).away.state))
at(start + 31 * DAY + HOUR, () => message(ada, musa))
until(start + 36 * DAY)

const times = (id: MemberId): number[] => nudges(id).filter(nudge => nudge.readyAt).map(nudge => Date.parse(nudge.readyAt!)).sort((a, b) => a - b)
const most = (list: number[], window: number): number => Math.max(0, ...list.map(time => list.filter(other => other >= time && other < time + window).length))

const kemiTimes = times(kemi)
assert.equal(kemiTimes.length, COMEBACK_RULES.maxPerAbsence, `a friend wrote ${Math.floor(36 * 24 / 5)} times in 36 days; Kemi got ${COMEBACK_RULES.maxPerAbsence} messages`)
assert.equal(kemiTimes[0], start + 3 * HOUR, 'the first after three hours away')
const gaps = kemiTimes.slice(1).map((time, index) => (time - kemiTimes[index]!) / DAY)
assert.deepEqual(gaps, [1, 3, 7], 'then one day, three days and seven days apart')
assert.ok(codes(kemi).includes('stopped'), 'and then it stops, with the reason recorded')
assert.equal(most(kemiTimes, DAY), 1); assert.ok(most(kemiTimes, 7 * DAY) <= 3)
const kemiNudges = nudges(kemi).reverse()
assert.ok(kemiNudges.every(nudge => nudge.state === 'ready-not-sent' && nudge.sentAt === null))
const told = kemiNudges.map(nudge => Number(/sent you (\d+) messages/.exec(nudge.items[0]!.line)?.[1] ?? 1))
assert.ok(told.every((count, index) => index === 0 || count > told[index - 1]!), `each message says something new: ${told.join(', ')} messages waiting`)

const lolaTimes = times(lola)
assert.ok(lolaTimes.length >= 4, `Lola came back twice a day for 14 days and got ${lolaTimes.length} messages`)
assert.equal(most(lolaTimes, DAY), 1, 'never more than one in any 24 hours, although each short visit reset the back-off')
assert.equal(most(lolaTimes, 7 * DAY), 3, 'never more than three in any seven days')
stats = world.call(reviewer, 'comeback.stats', {}).stats
assert.ok(stats.notPrepared.some(entry => entry.code === 'cap-day') && stats.notPrepared.some(entry => entry.code === 'cap-week'), 'both limits were the recorded reason at some point')

assert.deepEqual(musaStates, ['active', 'away-today', 'away-3-days', 'away-week', 'lapsed'], 'away states by time since last heard from')
const musaNudges = nudges(musa)
assert.equal(musaNudges.length, 1, 'nothing waiting: one check-in in the whole month')
assert.equal(musaNudges[0]!.type, 'checkin')
assert.equal(Date.parse(musaNudges[0]!.readyAt!), start + 7 * DAY, 'exactly seven days after leaving, at the hour Musa was last here')
assert.ok(musaNudges[0]!.preview!.email.text.includes('It has been 7 days'))
assert.ok(musaNudges[0]!.preview!.email.text.includes('Step back in: /?nudge='), 'his App never reported an address and none is configured: the link stays relative rather than guess one')
assert.ok(codes(musa).includes('lapsed'), 'after 30 days: a hard stop, even though a friend wrote on day 31')
pass(`caps and back-off over a simulated month: 1 day → 3 → 7 → stop (${COMEBACK_RULES.maxPerAbsence} messages at most per absence), never more than 1 in 24 h or 3 in 7 days, nothing said twice, one check-in for an empty inbox, hard stop after ${COMEBACK_RULES.lapsedAfterDays} days`)

// ════ Nothing was sent, and no address was invented ═══════════════════════════════════════════
const all = everyone.flatMap(id => nudges(id))
assert.ok(all.length >= 10)
assert.ok(all.every(nudge => nudge.state !== 'sent' && nudge.state !== 'sending' && nudge.sentAt === null), 'no message is marked sent')
assert.ok(!/127\.0\.0\.1|localhost|:51\d\d/.test(JSON.stringify(all)), 'no message carries a built-in host or port')
stats = world.call(reviewer, 'comeback.stats', {}).stats
assert.equal(stats.totals.sent, 0)
assert.equal(stats.totals.readyNotSent, stats.totals.prepared, 'every prepared message stopped at "ready, not sent"')
assert.ok(status(bayo).channels.every(channel => channel.mode === 'dry-run'))
assert.ok(world.call(bayo, 'notify.deliveries', {}).adapters.every(adapter => adapter.mode === 'dry-run'))
pass(`dry-run: ${stats.totals.prepared} messages were prepared in full and none was marked sent; none carries a built-in address`)

// ════ The live switch, with a transport that is an array in this process ══════════════════════
const handed: SendRequest[] = []
setTransport('email', async request => { handed.push(request); return { accepted: true, providerRef: 'in-memory', error: null } })
configureDelivery({ live: ['email'], appOrigin: 'https://neighbourhood.example', audience: 'test-only', testDestinations: { email: 'named-test@example.com' } })
assert.equal(status(bayo).channels.find(entry => entry.channel === 'email')!.mode, 'live')
assert.equal(status(bayo).channels.find(entry => entry.channel === 'whatsapp')!.mode, 'dry-run', 'only the named channel changes')
allow(nne, 'named-test@example.com'); allow(obi, 'obi@example.com')
const liveStart = now
leave(nne); leave(obi)
at(liveStart + HOUR, () => { message(ada, nne); message(ada, obi) })
until(liveStart + 3 * HOUR)
await new Promise(resolve => setImmediate(resolve))
assert.equal(nudges(obi)[0]!.state, 'ready-not-sent', 'anyone but the named test destination stays unsent')
assert.match(nudges(obi)[0]!.reason, /named test destination/)
assert.equal(nudges(nne)[0]!.state, 'sent')
assert.ok(nudges(nne)[0]!.sentAt)
assert.equal(handed.length, 1)
assert.equal(handed[0]!.trigger.flowId, 'comeback-email')
assert.deepEqual(Object.keys(handed[0]!.trigger.triggerData).sort(), ['email', 'html', 'nudgeId', 'subject', 'text', 'unsubscribeUrl'])
assert.equal(handed[0]!.trigger.triggerData.email, 'named-test@example.com')
assert.ok(handed[0]!.trigger.triggerData.html!.includes('https://neighbourhood.example/messages/'), 'a configured address wins over the one an App reported')
configureDelivery({ live: [], appOrigin: '', testDestinations: {} }); setTransport('email', null)
assert.equal(status(bayo).channels.find(entry => entry.channel === 'email')!.mode, 'dry-run')
pass('"sent" is reachable only through the live switch: with it on (in-memory transport, no network) the named test destination is sent to and everyone else stays "ready, not sent"')
console.log('ALL PASS')
