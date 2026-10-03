// Evidence probe for the social track: who is around, direct messages, waves, join-me
// invitations, emotes. In-process world, controllable clock, plain asserts.
// Run: node scripts/verify-direct.ts — prints one PASS line per rule, exits non-zero on failure.
import assert from 'node:assert/strict'
import { createWorld } from '../service/index.ts'
import { ensureMember } from '../service/members.ts'
import { roomOf } from '../service/rooms.ts'
import { setPresenceCacheMs } from '../service/direct.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { neighbouringDistricts } from '../src/shared/geo.ts'
import type { Vec2 } from '../src/shared/geo.ts'
import type { HomeId, MemberId } from '../src/shared/ids.ts'
import { INTEREST_RADIUS, WorldError } from '../src/shared/model.ts'
import type { CoarseArea, RoomRef } from '../src/shared/model.ts'
import type { ServerEvent, ServerFrame } from '../src/shared/protocol.ts'
import { DIRECT_MAX_LENGTH, HANGOUT, INVITE_LINK, JOIN, WAVE } from '../src/shared/direct.ts'
import type { Around } from '../src/shared/direct.ts'
import type { HomeApproach } from '../src/shared/homes.ts'
import type { Connection } from '../service/kernel.ts'

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
let now = Date.UTC(2026, 9, 1, 12)
const world = createWorld({ now: () => now })
// Counts are checked the instant something changes, so the short presence cache is off here. It is checked on its own at the end.
setPresenceCacheMs(0)

const id = (name: string): MemberId => `m_probe_${name}` as MemberId
const a = id('ada'), b = id('bayo'), c = id('chidi'), d = id('dara'), e = id('efe'), f = id('femi'), g = id('gbenga')
const NAMES: [MemberId, string][] = [[a, 'Ada'], [b, 'Bayo'], [c, 'Chidi'], [d, 'Dara'], [e, 'Efe'], [f, 'Femi'], [g, 'Gbenga']]
const events = new Map<MemberId, ServerEvent[]>()
const connections = new Map<MemberId, Connection>()
function connect(memberId: MemberId): void {
  if (!events.has(memberId)) events.set(memberId, [])
  connections.set(memberId, world.connect(memberId, (frame: ServerFrame) => { if (frame.t === 'event') events.get(memberId)!.push(frame.event) }, () => undefined))
}
function disconnect(memberId: MemberId): void { world.disconnect(connections.get(memberId)!); connections.delete(memberId) }
const got = <T extends ServerEvent['type']>(memberId: MemberId, type: T): Extract<ServerEvent, { type: T }>[] =>
  events.get(memberId)!.filter((event): event is Extract<ServerEvent, { type: T }> => event.type === type)
const clear = (): void => { for (const list of events.values()) list.length = 0 }
const code = (run: () => unknown): string => { try { run(); return 'ok' } catch (error) { return error instanceof WorldError ? error.code : `threw ${String(error)}` } }
const pass = (name: string): void => console.log(`PASS ${name}`)
const advance = (ms: number): void => { now += ms; world.tick() }
/** Let the per-member request allowance refill between groups of calls. */
const breathe = (): void => advance(6000)
/** Walk a member to a point the way the App does: short steps from the accepted pose, each one a second apart, each answer checked. Nothing here moves anyone another way. */
function walkTo(memberId: MemberId, target: Vec2): void {
  for (;;) {
    const from = roomOf(world, memberId)!.pos
    const left = Math.hypot(target.x - from.x, target.z - from.z)
    if (left < 1e-6) return
    const reach = Math.min(1, 6 / left)
    const pos = left <= 6 ? target : { x: from.x + (target.x - from.x) * reach, z: from.z + (target.z - from.z) * reach }
    advance(1000)
    const step = world.call(memberId, 'room.move', { pos, heading: 0, moving: true })
    assert.equal(step.accepted, true, 'every step of the walk is accepted')
    assert.deepEqual(step.pos, pos, 'and lands where it was asked')
  }
}

const place = (label: string, countryCode: string, lat: number, lon: number): CoarseArea => areaFromPlace({ label, countryCode, anchor: { lat, lon } })
const ibadan = place('Bodija, Ibadan', 'NG', 7.4352, 3.914)
const lagos = place('Yaba, Lagos', 'NG', 6.5095, 3.3711)
const street: RoomRef = { kind: 'district', districtId: ibadan.arrivalDistrict }
const nextStreet: RoomRef = { kind: 'district', districtId: neighbouringDistricts(ibadan.arrivalDistrict)!.east }
const market: RoomRef = { kind: 'venue', districtId: ibadan.arrivalDistrict, placeId: 'p555' as never }
const lagosStreet: RoomRef = { kind: 'district', districtId: lagos.arrivalDistrict }

for (const [memberId, name] of NAMES) { ensureMember(world, memberId, name); connect(memberId) }
for (const memberId of [a, b, c, e, f, g]) world.call(memberId, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
world.call(d, 'member.setCurrentArea', { area: lagos, source: 'manual' })
for (const [memberId] of NAMES) world.call(memberId, 'member.completeOnboarding', {})
const discover = (memberId: MemberId, on: boolean): void => {
  const { preferences } = world.call(memberId, 'member.me', {}).profile
  world.call(memberId, 'member.savePreferences', { preferences: { ...preferences, discoverable: on } })
}
for (const memberId of [a, b, d, e]) discover(memberId, true)
const befriend = (x: MemberId, y: MemberId): void => { world.call(y, 'intro.respond', { introId: world.call(x, 'intro.send', { to: y, note: '' }).intro.id, accept: true }) }
const around = (memberId: MemberId): Around => world.call(memberId, 'around.get', {}).around
const inbox = (memberId: MemberId) => world.call(memberId, 'notify.list', { includeRead: true }).notifications
const note = (memberId: MemberId, kind: string) => inbox(memberId).filter(item => item.kind === kind)
/** Keys and values that would give a position away: coordinates, cells, room positions. */
function assertWordsOnly(value: unknown, what: string): void {
  const text = JSON.stringify(value)
  for (const key of ['lat', 'lon', 'anchor', 'pos', 'areaId', 'districtId', 'arrivalDistrict', 'placeId', 'centre', 'heading']) assert.ok(!text.includes(`"${key}"`), `${what} leaks "${key}"`)
  for (const cell of ['a:12/', 'd:14/', 'district|', 'venue|']) assert.ok(!text.includes(cell), `${what} leaks a cell or room id (${cell})`)
}

// Where everyone stands. a is inside a venue; b and c are in the street outside; g is in the same
// street but far off; e and f are one district over; d is in Lagos.
world.call(a, 'room.enter', { ref: market, pos: { x: 1, z: 1 }, heading: 0 })
world.call(a, 'around.place', { name: 'Bodija Market', category: 'marketplace' })
world.call(b, 'room.enter', { ref: street, pos: { x: 5, z: 5 }, heading: 0 })
world.call(c, 'room.enter', { ref: street, pos: { x: 10, z: 5 }, heading: 0 })
world.call(g, 'room.enter', { ref: street, pos: { x: INTEREST_RADIUS + 200, z: 5 }, heading: 0 })
world.call(e, 'room.enter', { ref: nextStreet, pos: { x: 0, z: 0 }, heading: 0 })
world.call(f, 'room.enter', { ref: nextStreet, pos: { x: 3, z: 0 }, heading: 0 })
world.call(d, 'room.enter', { ref: lagosStreet, pos: { x: 0, z: 0 }, heading: 0 })
for (const memberId of [b, c, g, e, f, d]) world.call(memberId, 'around.place', { name: '', category: '' })
breathe()

// 1 ── Direct messages only between friends; length and membership are enforced.
assert.equal(code(() => world.call(a, 'direct.open', { memberId: b })), 'forbidden', 'no conversation before friendship')
befriend(a, b)
const conversationId = world.call(a, 'direct.open', { memberId: b }).conversation.id
assert.equal(world.call(b, 'direct.open', { memberId: a }).conversation.id, conversationId, 'one conversation per pair, the same from both sides')
assert.equal(world.call(a, 'direct.list', {}).conversations.length, 0, 'an empty conversation is not listed')
assert.equal(code(() => world.call(a, 'direct.open', { memberId: a })), 'invalid')
assert.equal(code(() => world.call(a, 'direct.send', { conversationId, text: 'x'.repeat(DIRECT_MAX_LENGTH + 1), clientId: 'long' })), 'invalid', `over ${DIRECT_MAX_LENGTH} characters is refused`)
assert.equal(code(() => world.call(a, 'direct.send', { conversationId, text: '   ', clientId: 'blank' })), 'invalid', 'an empty message is refused')
assert.equal(code(() => world.call(c, 'direct.get', { conversationId, before: null })), 'not_found', 'an outsider cannot read it')
assert.equal(code(() => world.call(c, 'direct.send', { conversationId, text: 'let me in', clientId: 'c1' })), 'not_found', 'or write to it')
assert.equal(code(() => world.call(c, 'direct.read', { conversationId, upTo: 5 })), 'not_found')
pass('direct messages: friends only, one conversation per pair, 500-character limit, outsiders get nothing')

// 2 ── A connected friend gets it at once; an inbox entry follows only if it stays unread.
clear()
const first = world.call(a, 'direct.send', { conversationId, text: 'Are you near the market?', clientId: 'a1' })
assert.equal(first.conversation.peerDeliveredSeq, 1, 'delivered straight away to a connected friend')
assert.equal(first.conversation.peerReadSeq, 0, 'and not read yet')
const pushed = got(b, 'direct.message')
assert.equal(pushed.length, 1)
assert.equal(pushed[0]!.unread, 1)
assert.equal(pushed[0]!.message.text, 'Are you near the market?')
assert.equal(world.call(a, 'direct.send', { conversationId, text: 'Are you near the market?', clientId: 'a1' }).message.id, first.message.id, 'a retried send is not stored twice')
assert.equal(world.call(b, 'direct.get', { conversationId, before: null }).messages.length, 1)
assert.equal(note(b, 'direct.message').length, 0, 'no inbox entry while there is still a chance they are looking')
advance(91_000)
const entry = note(b, 'direct.message')
assert.equal(entry.length, 1, 'still unread after a minute and a half: now it is in the inbox')
assert.deepEqual([entry[0]!.category, entry[0]!.link, entry[0]!.state], ['replies', `/messages/${conversationId}`, 'active'])
clear()
assert.equal(world.call(b, 'direct.read', { conversationId, upTo: 1 }).unread, 0)
assert.deepEqual(got(a, 'direct.state').at(-1), { type: 'direct.state', conversationId, peerDeliveredSeq: 1, peerReadSeq: 1 }, 'the sender is told it was read')
assert.equal(note(b, 'direct.message')[0]!.state, 'resolved', 'reading settles the inbox entry')
// Read before the delay: no inbox entry at all.
world.call(a, 'direct.send', { conversationId, text: 'I am inside, by the yam stalls.', clientId: 'a2' })
world.call(b, 'direct.read', { conversationId, upTo: 2 })
advance(91_000)
assert.equal(note(b, 'direct.message').filter(item => item.state === 'active').length, 0, 'read in time: nothing is raised')
pass('direct messages while both are connected: delivered at once, read mark reaches the sender, inbox entry only if left unread, settled on reading, retried send stored once')

// 3 ── Offline: the messages wait, unread counts are right, delivered and read are told apart.
disconnect(b)
clear()
const offline = world.call(a, 'direct.send', { conversationId, text: 'Gone to get suya.', clientId: 'a3' })
advance(2000)
world.call(a, 'direct.send', { conversationId, text: 'Back in ten minutes.', clientId: 'a4' })
assert.equal(offline.conversation.peerDeliveredSeq, 2, 'not delivered: the friend is offline')
const waiting = note(b, 'direct.message').filter(item => item.state === 'active')
assert.equal(waiting.length, 1, 'one inbox entry for the conversation, not one per message')
assert.equal(waiting[0]!.count, 2)
assert.equal(waiting[0]!.body, 'Back in ten minutes.', 'it carries the latest message')
assert.equal(waiting[0]!.actor?.id, a)
connect(b)
world.call(b, 'room.enter', { ref: street, pos: { x: 5, z: 5 }, heading: 0 })
assert.equal(around(b).unreadDirect, 2, 'the unread count is there on return')
clear()
const listed = world.call(b, 'direct.list', {})
assert.deepEqual([listed.unread, listed.conversations[0]!.unread, listed.conversations[0]!.last?.text], [2, 2, 'Back in ten minutes.'])
assert.deepEqual(got(a, 'direct.state').at(-1), { type: 'direct.state', conversationId, peerDeliveredSeq: 4, peerReadSeq: 2 }, 'opening the list marks them delivered, not read')
world.call(b, 'direct.read', { conversationId, upTo: 4 })
assert.equal(got(a, 'direct.state').at(-1)!.peerReadSeq, 4)
assert.equal(around(b).unreadDirect, 0)
assert.equal(note(b, 'direct.message').filter(item => item.state === 'active').length, 0)
world.call(b, 'direct.send', { conversationId, text: 'Coming.', clientId: 'b1' })
advance(3000)
world.call(a, 'direct.send', { conversationId, text: 'One', clientId: 'a5' })
world.call(a, 'direct.send', { conversationId, text: 'Two', clientId: 'a6' })
assert.equal(world.call(b, 'direct.readAll', {}).unread, 0, 'mark all read clears every conversation')
pass('offline delivery: messages wait, one folded inbox entry (kind direct.message, category replies, link /messages/<id>), unread count on return, delivered then read, read-all')

// 4 ── Rate limits.
breathe()
let refused = 0
for (let index = 0; index < 9; index++) if (code(() => world.call(a, 'direct.send', { conversationId, text: `burst ${index}`, clientId: `burst-${index}` })) === 'rate_limited') refused++
assert.equal(refused, 3, 'six in a burst, the rest refused')
advance(MINUTE)
// One a second for a minute uses up the allowance; the minute after shows the steady rate.
for (let index = 0; index < 60; index++) { advance(1000); code(() => world.call(a, 'direct.send', { conversationId, text: `drain ${index}`, clientId: `drain-${index}` })) }
let sent = 0
for (let index = 0; index < 60; index++) { advance(1000); if (code(() => world.call(a, 'direct.send', { conversationId, text: `steady ${index}`, clientId: `steady-${index}` })) === 'ok') sent++ }
assert.ok(sent >= 29 && sent <= 31, `thirty a minute once the allowance is used (${sent})`)
world.call(b, 'direct.readAll', {})
pass('direct messages are rate limited: six in a burst, about thirty a minute')

// 5 ── Whereabouts are words, obey the switch, and never carry coordinates or cells.
breathe()
let seen = around(b)
const ada = seen.friends.find(friend => friend.member.id === a)!
assert.deepEqual([ada.where.state, ada.where.words, ada.where.areaLabel, ada.where.venueName], ['venue', 'at Bodija Market in Bodija, Ibadan', 'Bodija, Ibadan', 'Bodija Market'])
assert.equal(ada.where.sameCity, true)
assert.equal(ada.where.canJoin, true)
assert.equal(ada.conversationId, conversationId)
assertWordsOnly(seen, 'around.get')
assertWordsOnly(world.call(b, 'direct.list', {}), 'direct.list')
assertWordsOnly(world.call(b, 'direct.get', { conversationId, before: null }), 'direct.get')
const more = world.call(b, 'direct.get', { conversationId, before: null })
assert.equal(more.more, true, 'older messages are paged')
assert.ok(world.call(b, 'direct.get', { conversationId, before: more.messages[0]!.seq }).messages.every(message => message.seq < more.messages[0]!.seq))
let way = world.call(b, 'around.wayToFriend', { memberId: a }).way
assert.deepEqual([way.reach, way.destination?.kind], ['walk', 'venue'], 'a friend who allows it can be walked to')
assert.equal(code(() => world.call(c, 'around.wayToFriend', { memberId: a })), 'forbidden', 'a stranger cannot ask the way to someone')
world.call(a, 'around.settings', { settings: { shareWhereabouts: true, allowJoin: false } })
assert.equal(around(b).friends.find(friend => friend.member.id === a)!.where.canJoin, false)
way = world.call(b, 'around.wayToFriend', { memberId: a }).way
assert.deepEqual([way.reach, way.destination], ['unavailable', null], 'asked-first: no way is given')
assert.equal(world.call(a, 'around.settings', { settings: { shareWhereabouts: false, allowJoin: true } }).settings.allowJoin, false, 'hiding where you are also closes "come to me"')
const hidden = around(b).friends.find(friend => friend.member.id === a)!.where
assert.deepEqual([hidden.hidden, hidden.words, hidden.areaLabel, hidden.venueName, hidden.sameCity, hidden.canJoin, hidden.lastSeenAt], [true, 'online', null, null, null, false, null], 'switched off: online or offline, nothing else')
assert.equal(world.call(b, 'around.wayToFriend', { memberId: a }).way.reach, 'unavailable')
assert.ok(!JSON.stringify(around(b).spots).includes('"Ada"'), 'and not named at any spot')
assert.ok(!JSON.stringify(world.call(b, 'direct.list', {})).includes('Bodija Market'), 'nor in the conversation header')
assert.equal(around(c).friends.length, 0, 'a non-friend has no whereabouts of anyone')
world.call(a, 'around.settings', { settings: { shareWhereabouts: true, allowJoin: true } })
disconnect(a)
advance(5 * MINUTE)
const gone = around(b).friends.find(friend => friend.member.id === a)!.where
assert.deepEqual([gone.state, gone.words], ['offline', 'offline · last in Bodija, Ibadan'])
assert.ok(gone.lastSeenAt && Date.parse(gone.lastSeenAt) === now - 5 * MINUTE, 'last seen is when they disconnected')
clear()
connect(a)
const cameOnline = got(b, 'friend.online')
assert.equal(cameOnline.length, 1, 'a connected friend is told when a friend comes online')
assert.equal(cameOnline[0]!.member.id, a)
assertWordsOnly(cameOnline, 'friend.online')
assert.equal(got(c, 'friend.online').length, 0, 'nobody else is')
disconnect(a); connect(a)
assert.equal(got(b, 'friend.online').length, 1, 'and not again a moment later')
world.call(a, 'room.enter', { ref: market, pos: { x: 1, z: 1 }, heading: 0 })
world.call(a, 'around.place', { name: 'Bodija Market', category: 'marketplace' })
pass('whereabouts: area and venue names only, no coordinates or cells in any response, the privacy switch hides everything but online, friends only, last seen, friend-online notice')

// 6 ── City counts are real; the list is opt-in on both sides; spots show where people are.
breathe()
seen = around(a)
// In Ibadan and connected besides a: b, c, g, e, f. d is in Lagos.
assert.equal(seen.city.online, 5, 'everyone connected in the city, the viewer not counted')
assert.equal(seen.city.label, 'Bodija, Ibadan')
assert.equal(seen.worldOnline, 6)
assert.deepEqual(seen.elsewhere, [{ areaLabel: 'Yaba, Lagos', online: 1 }], 'other cities by name and count')
assert.deepEqual(seen.city.people.map(person => person.member.id), [e], 'the list holds only those who opted in (b is a friend and listed with friends; c, f and g did not opt in)')
assert.equal(seen.city.people[0]!.areaLabel, 'Bodija, Ibadan')
discover(a, false)
seen = around(a)
assert.deepEqual([seen.city.listWithheld, seen.city.people.length, seen.city.online], [true, 0, 5], 'not discoverable yourself: the count stays, the list is withheld')
discover(a, true)
disconnect(g)
assert.equal(around(a).city.online, 4, 'someone leaving is one fewer at once')
connect(g)
world.call(g, 'room.enter', { ref: street, pos: { x: INTEREST_RADIUS + 200, z: 5 }, heading: 0 })
assert.equal(around(d).city.online, 0, 'the count is of the viewer’s own city')
assert.deepEqual(around(d).elsewhere, [{ areaLabel: 'Bodija, Ibadan', online: 6 }])
// Spots, as b sees them: the market (a) and the two streets.
seen = around(b)
const marketSpot = seen.spots.find(spot => spot.kind === 'venue')!
assert.deepEqual([marketSpot.name, marketSpot.category, marketSpot.areaLabel, marketSpot.now, marketSpot.here], ['Bodija Market', 'marketplace', 'Bodija, Ibadan', 1, false])
assert.deepEqual(marketSpot.friends.map(friend => friend.id), [a], 'a friend who shares where they are is named at the spot')
const streets = seen.spots.find(spot => spot.kind === 'street')!
assert.deepEqual([streets.name, streets.now, streets.here], ['Streets of Bodija, Ibadan', 4, true], 'c and g beside b, e and f a district over; b is not counted')
way = world.call(b, 'around.wayToSpot', { spotId: marketSpot.id }).way
assert.deepEqual([way.reach, way.destination?.kind === 'venue' && way.destination.name], ['walk', 'Bodija Market'])
assert.equal(around(d).spots.some(spot => spot.name === 'Bodija Market'), false, 'another city’s spots are not offered')
assert.equal(code(() => world.call(d, 'around.wayToSpot', { spotId: marketSpot.id })), 'not_found')
// The venue's name is what most people's maps say, so one person cannot rename it.
world.call(c, 'room.enter', { ref: market, pos: { x: 2, z: 2 }, heading: 0 })
world.call(c, 'around.place', { name: 'Not The Market', category: 'x' })
world.call(g, 'room.enter', { ref: market, pos: { x: 3, z: 3 }, heading: 0 })
world.call(g, 'around.place', { name: 'Bodija Market', category: 'marketplace' })
assert.deepEqual([around(b).spots.find(spot => spot.kind === 'venue')!.name, around(b).spots.find(spot => spot.kind === 'venue')!.now], ['Bodija Market', 3])
assert.equal(world.call(d, 'room.leave', {}).left, true)
assert.equal(world.call(d, 'around.place', { name: 'Nowhere', category: '' }).recorded, false, 'a place is only recorded for someone standing in it')
world.call(d, 'room.enter', { ref: lagosStreet, pos: { x: 0, z: 0 }, heading: 0 })
// People who came by today still count as "today" after they leave.
world.call(c, 'room.enter', { ref: street, pos: { x: 10, z: 5 }, heading: 0 })
world.call(g, 'room.enter', { ref: street, pos: { x: INTEREST_RADIUS + 200, z: 5 }, heading: 0 })
const later = around(b).spots.find(spot => spot.kind === 'venue')!
assert.deepEqual([later.now, later.today], [1, 3], 'one there now, three came by today')
pass('who is around: real city count, opt-in list on both sides, other cities by name, gathering spots with now and today counts, venue name by majority, way to a spot only inside the city')

// 7 ── Waves.
breathe()
clear()
assert.equal(code(() => world.call(a, 'wave.send', { to: d })), 'forbidden', 'nobody to wave at across cities without a reason to see each other')
assert.equal(code(() => world.call(a, 'wave.send', { to: f })), 'forbidden', 'nor at someone in the city who did not opt into discovery')
assert.equal(code(() => world.call(a, 'wave.send', { to: a })), 'invalid')
const hello = world.call(b, 'wave.send', { to: c })
assert.deepEqual([hello.returned, hello.wave.context, hello.wave.contextText, hello.wave.status], [false, 'same-room', 'You were both on the streets of Bodija, Ibadan.', 'pending'])
assert.equal(got(c, 'wave.received').length, 1)
assertWordsOnly(got(c, 'wave.received'), 'wave.received')
let waveNote = note(c, 'social.wave')
assert.deepEqual([waveNote.length, waveNote[0]!.category, waveNote[0]!.title, waveNote[0]!.link, waveNote[0]!.state], [1, 'social', 'Bayo waved at you', `/people?tab=nearby&wave=${hello.wave.id}`, 'active'])
assert.equal(code(() => world.call(b, 'wave.send', { to: c })), 'conflict', 'one waiting wave per pair')
assert.equal(code(() => world.call(e, 'wave.back', { waveId: hello.wave.id })), 'not_found', 'only the person waved at can wave back')
assert.equal(around(c).waves.length, 1)
const back = world.call(c, 'wave.send', { to: b })
assert.deepEqual([back.returned, back.wave.status, back.wave.id], [true, 'returned', hello.wave.id], 'waving at someone who waved first is the wave back')
assert.equal(got(b, 'wave.returned').length, 1)
assert.equal(note(c, 'social.wave')[0]!.state, 'resolved', 'the wave notification is settled when answered')
assert.deepEqual([note(b, 'social.wave-back').length, note(b, 'social.wave-back')[0]!.body], [1, 'You both waved. You can introduce yourself now.'])
assert.deepEqual([around(b).waves.map(wave => wave.status), around(c).waves.map(wave => wave.status)], [['returned'], ['returned']], 'both keep the answered wave, so either can introduce themselves')
assert.equal(code(() => world.call(b, 'wave.send', { to: c })), 'rate_limited', 'cool-down after waving at the same person')
advance(WAVE.pairCooldownHours * HOUR + MINUTE)
assert.equal(code(() => world.call(b, 'wave.send', { to: c })), 'ok', 'allowed again after the cool-down')
// Same city, both discoverable.
const far = world.call(a, 'wave.send', { to: e })
assert.deepEqual([far.wave.context, far.wave.contextText], ['same-city', 'You are both around Bodija, Ibadan.'])
world.call(e, 'wave.dismiss', { waveId: far.wave.id })
assert.equal(note(e, 'social.wave').find(item => item.link.endsWith(far.wave.id))!.state, 'resolved')
assert.equal(around(e).waves.length, 0, 'a dismissed wave is gone for the person who dismissed it')
assert.equal(code(() => world.call(a, 'wave.send', { to: e })), 'conflict', 'and the sender cannot simply send another')
assert.equal(code(() => world.call(e, 'wave.back', { waveId: far.wave.id })), 'ok', 'the person waved at may still change their mind')
// Ignored waves lengthen the wait.
const cold = world.call(a, 'wave.send', { to: b })
assert.equal(cold.wave.context, 'friend')
world.call(b, 'member.block', { memberId: g })
world.call(b, 'member.unblock', { memberId: g })
const ignored1 = world.call(g, 'wave.send', { to: c })
assert.equal(ignored1.wave.context, 'same-room')
advance(WAVE.ttlHours * HOUR + MINUTE)
assert.equal(note(c, 'social.wave').find(item => item.link.endsWith(ignored1.wave.id))!.state, 'expired', 'an unanswered wave lapses after a day')
assert.equal(code(() => world.call(c, 'wave.back', { waveId: ignored1.wave.id })), 'expired')
assert.equal(code(() => world.call(g, 'wave.send', { to: c })), 'ok', 'a second try is allowed the next day')
advance(WAVE.ttlHours * HOUR + MINUTE)
assert.equal(code(() => world.call(g, 'wave.send', { to: c })), 'rate_limited', 'two ignored in a row: the wait is now a week')
advance((WAVE.ignoredCooldownDays - 2) * DAY)
assert.equal(code(() => world.call(g, 'wave.send', { to: c })), 'rate_limited')
advance(2 * DAY)
assert.equal(code(() => world.call(g, 'wave.send', { to: c })), 'ok')
// A burst of waves at many people is refused.
const crowd: MemberId[] = []
for (let index = 0; index < 7; index++) {
  const memberId = id(`crowd${index}`)
  crowd.push(memberId)
  ensureMember(world, memberId, `Crowd ${index}`)
  connect(memberId)
  world.call(memberId, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
  world.call(memberId, 'member.completeOnboarding', {})
  world.call(memberId, 'room.enter', { ref: nextStreet, pos: { x: index, z: 9 }, heading: 0 })
}
const burst = crowd.map(memberId => code(() => world.call(f, 'wave.send', { to: memberId })))
assert.deepEqual(burst, ['ok', 'ok', 'ok', 'ok', 'ok', 'rate_limited', 'rate_limited'], 'five waves a minute at most')
for (const memberId of crowd) disconnect(memberId)
pass(`waves: need a reason to see each other, one per pair, wave-back settles and notifies (social.wave / social.wave-back), ${WAVE.pairCooldownHours} h cool-down, a week after two ignored, dismissal is silent, bursts refused`)

// 8 ── Join me.
breathe()
world.call(a, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
world.call(b, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
clear()
assert.equal(code(() => world.call(a, 'join.send', { to: c, place: 'here', note: '' })), 'forbidden', 'friends only')
const standing = (memberId: MemberId): string => JSON.stringify([roomOf(world, memberId), world.call(memberId, 'travel.state', {}).state.location, world.call(memberId, 'travel.state', {}).state.trip])
const bBefore = standing(b)
const invite = world.call(a, 'join.send', { to: b, place: 'here', note: 'The suya is ready' }).invite
assert.deepEqual([invite.place, invite.status, invite.mine, invite.reach], [{ kind: 'venue', name: 'Bodija Market', areaLabel: 'Bodija, Ibadan' }, 'pending', true, null])
assertWordsOnly(invite, 'an invitation')
const invited = got(b, 'join.changed').at(-1)!.invite
assert.deepEqual([invited.mine, invited.reach, invited.note], [false, 'walk', 'The suya is ready'], 'the invited friend is told it is within walking range')
assertWordsOnly(invited, 'the invited view')
let joinNote = note(b, 'social.join-me')
assert.deepEqual([joinNote.length, joinNote[0]!.category, joinNote[0]!.title, joinNote[0]!.body, joinNote[0]!.link], [1, 'events', 'Ada invites you to join them', 'They are at Bodija Market in Bodija, Ibadan. “The suya is ready”', `/people?tab=nearby&invite=${invite.id}`])
assert.equal(code(() => world.call(c, 'join.get', { inviteId: invite.id })), 'not_found', 'nobody else can see it')
assert.equal(code(() => world.call(a, 'join.respond', { inviteId: invite.id, accept: true })), 'forbidden', 'the sender cannot answer their own')
const accepted = world.call(b, 'join.respond', { inviteId: invite.id, accept: true })
assert.deepEqual([accepted.invite.status, accepted.way?.reach, accepted.way?.destination?.kind], ['accepted', 'walk', 'venue'])
assert.equal(accepted.way?.destination?.kind === 'venue' && accepted.way.destination.placeId, 'p555', 'the way names the venue to walk to')
assert.equal(standing(b), bBefore, 'accepting moves nobody: the avatar is where it was')
assert.equal(note(b, 'social.join-me')[0]!.state, 'resolved', 'settled when answered')
assert.deepEqual([note(a, 'social.join-accepted').length, note(a, 'social.join-accepted')[0]!.title], [1, 'Bayo is coming to join you'])
assert.equal(got(a, 'join.changed').at(-1)!.invite.status, 'accepted')
assert.equal(world.call(b, 'join.respond', { inviteId: invite.id, accept: true }).way?.reach, 'walk', 'the way can be asked for again while it lasts')
assert.equal(code(() => world.call(b, 'join.respond', { inviteId: invite.id, accept: false })), 'conflict', 'but the answer cannot be changed')
// Decline.
advance(MINUTE)
const second = world.call(a, 'join.send', { to: b, place: 'here', note: '' }).invite
const declined = world.call(b, 'join.respond', { inviteId: second.id, accept: false })
assert.deepEqual([declined.invite.status, declined.way], ['declined', null])
assert.equal(note(a, 'social.join-accepted').length, 1, 'a decline raises nothing in the inbox')
// Replace and cancel.
const third = world.call(a, 'join.send', { to: b, place: 'here', note: 'first' }).invite
const fourth = world.call(a, 'join.send', { to: b, place: 'here', note: 'second' }).invite
assert.equal(world.call(a, 'join.get', { inviteId: third.id }).invite.status, 'cancelled', 'a new invitation replaces the one still waiting')
assert.equal(around(b).invites.filter(item => !item.mine).length, 1)
assert.equal(code(() => world.call(b, 'join.cancel', { inviteId: fourth.id })), 'forbidden')
assert.equal(world.call(a, 'join.cancel', { inviteId: fourth.id }).invite.status, 'cancelled')
assert.equal(code(() => world.call(b, 'join.respond', { inviteId: fourth.id, accept: true })), 'conflict')
assert.equal(code(() => world.call(a, 'join.send', { to: b, place: 'here', note: '' })), 'rate_limited', `no more than ${JOIN.perPairPerHour} invitations to one friend in an hour`)
// Expiry.
advance(HOUR)
const stale = world.call(a, 'join.send', { to: b, place: 'here', note: '' }).invite
advance(JOIN.hereMinutes * MINUTE + 30_000)
assert.equal(note(b, 'social.join-me').find(item => item.link.endsWith(stale.id))!.state, 'expired')
assert.equal(code(() => world.call(b, 'join.respond', { inviteId: stale.id, accept: true })), 'conflict', 'an expired invitation cannot be accepted')
assert.equal(world.call(b, 'join.get', { inviteId: stale.id }).invite.status, 'expired')
assert.equal(around(b).invites.length, 0)
// From the street the invitation carries a meeting point in the scene, for the invited friend only.
world.call(a, 'room.enter', { ref: nextStreet, pos: { x: 40, z: -12 }, heading: 0 })
const streetInvite = world.call(a, 'join.send', { to: b, place: 'here', note: '' }).invite
assert.deepEqual(streetInvite.place, { kind: 'street', name: 'the streets of Bodija, Ibadan', areaLabel: 'Bodija, Ibadan' })
assertWordsOnly(streetInvite, 'a street invitation')
assertWordsOnly(around(b).invites, 'invitations in who-is-around')
const meetAt = world.call(b, 'join.respond', { inviteId: streetInvite.id, accept: true }).way!.destination
assert.deepEqual(meetAt?.kind === 'street' && meetAt.meet, { x: 40, z: -12 }, 'the walking target is where the friend stood when they asked')
world.call(a, 'room.enter', { ref: market, pos: { x: 1, z: 1 }, heading: 0 })
// Another city: a trip is needed, and the way is not handed over.
befriend(a, d)
breathe()
const dBefore = standing(d)
const distant = world.call(a, 'join.send', { to: d, place: 'here', note: '' }).invite
assert.equal(world.call(d, 'join.get', { inviteId: distant.id }).invite.reach, 'travel', 'the invited friend sees that a trip is needed')
const tripNeeded = world.call(d, 'join.respond', { inviteId: distant.id, accept: true })
assert.deepEqual([tripNeeded.way?.reach, tripNeeded.way?.destination, tripNeeded.way?.areaLabel], ['travel', null, 'Bodija, Ibadan'])
assert.match(tripNeeded.way!.text, /Book a trip there from Travel/)
assertWordsOnly(tripNeeded, 'a cross-city answer')
assert.equal(standing(d), dBefore, 'and nobody was moved')
assert.equal(note(a, 'social.join-accepted').at(0)!.title, 'Dara wants to join you, and needs a trip first')
assert.equal(code(() => world.call(d, 'room.enter', { ref: market, pos: { x: 0, z: 0 }, heading: 0 })), 'forbidden', 'the travel rules still decide who may step in')
// Home: a home is a building in a street. Private is refused, a home that stands in no street has no front door to be sent to,
// and a placed one is gone to the way the service says: walk to its door, then go in, or book a trip first. An answer moves nobody.
// Only Yaba has street parcels, and only a trip moves a character between cities, so Dara (already in Yaba) is the host and one more
// synthetic member, Hauwa, is the friend who walks there. Ada, in Bodija, is the friend who would need a trip.
const approachOf = (viewer: MemberId, homeId: HomeId): HomeApproach => world.call(viewer, 'home.approach', { homeId }).approach
function walkApproach(viewer: MemberId, homeId: HomeId): Extract<HomeApproach, { kind: 'walk' }> {
  const approach = approachOf(viewer, homeId)
  assert.ok(approach.kind === 'walk', `${viewer} is told to walk, not ${approach.kind}`)
  return approach
}
const hauwa = id('hauwa')
ensureMember(world, hauwa, 'Hauwa')
connect(hauwa)
world.call(hauwa, 'member.setCurrentArea', { area: lagos, source: 'manual' })
world.call(hauwa, 'member.completeOnboarding', {})
world.call(hauwa, 'room.enter', { ref: lagosStreet, pos: { x: 0, z: 0 }, heading: 0 })
befriend(d, hauwa)
breathe()
const aBefore = standing(a), hBefore = standing(hauwa)
const dHome = world.call(d, 'home.get', { homeId: null }).home.id
world.call(d, 'home.setPolicy', { policy: 'private' })
assert.equal(code(() => world.call(d, 'join.send', { to: a, place: 'home', note: '' })), 'conflict', 'a private home cannot be offered')
world.call(d, 'home.setPolicy', { policy: 'friends' })
assert.equal(code(() => world.call(d, 'join.send', { to: a, place: 'home', note: '' })), 'conflict', 'a home that stands in no street cannot be offered: there is no front door to send anyone to')
const unplaced = approachOf(hauwa, dHome)
assert.deepEqual([unplaced.kind, unplaced.kind === 'unavailable' && unplaced.reason], ['unavailable', 'unplaced'], 'the service says the same to a friend who may visit')
assert.equal(code(() => world.call(hauwa, 'home.enter', { homeId: dHome })), 'unavailable', 'and going in is refused')
assert.equal(standing(hauwa), hBefore, 'without moving anyone')
// Placing is the owner's own act, from the street the house will stand in.
assert.equal(world.call(d, 'home.sites', {}).here?.districtId, lagos.arrivalDistrict, 'the service offers parcels in the street she stands in')
const placed = world.call(d, 'home.setSite', { place: { parcelId: null } }).home.building.site
assert.deepEqual([placed?.districtId, placed?.status], [lagos.arrivalDistrict, 'valid'], 'the home stands on a parcel of that street')
advance(MINUTE)
// A friend in another city: a trip first, no door to go to, and nobody is moved.
const homeInvite = world.call(d, 'join.send', { to: a, place: 'home', note: '' }).invite
assert.equal(homeInvite.place.kind, 'home')
assert.equal(world.call(a, 'join.get', { inviteId: homeInvite.id }).invite.reach, 'travel', 'the invited friend sees that a trip is needed')
const needsTrip = world.call(a, 'join.respond', { inviteId: homeInvite.id, accept: true })
assert.deepEqual([needsTrip.way?.reach, needsTrip.way?.destination, needsTrip.way?.areaLabel], ['travel', null, 'Yaba, Lagos'], 'a home in another city is not a door from here')
assert.match(needsTrip.way!.text, /Book a trip from Travel/)
assert.equal(note(d, 'social.join-accepted').at(0)!.title, 'Ada wants to join you, and needs a trip first')
assert.equal(code(() => world.call(a, 'home.enter', { homeId: dHome })), 'conflict', 'the travel rules still decide who may step in')
assert.equal(standing(a), aBefore, 'nobody was moved')
// A friend in the street: a walk to the door. The door is not where she stands, going in from here is refused, and the walk is her own accepted steps.
advance(MINUTE)
const walkInvite = world.call(d, 'join.send', { to: hauwa, place: 'home', note: '' }).invite
assert.equal(world.call(hauwa, 'join.get', { inviteId: walkInvite.id }).invite.reach, 'walk', 'a friend in the street it stands in is asked to walk')
const door = world.call(hauwa, 'join.respond', { inviteId: walkInvite.id, accept: true })
assert.deepEqual([door.way?.reach, door.way?.destination?.kind], ['walk', 'home'], 'the way is the front door of a placed home')
assert.match(door.way!.text, /Walk to its front door/)
assert.equal(standing(hauwa), hBefore, 'accepting moves nobody: the avatar is where it was')
const toDoor = walkApproach(hauwa, dHome)
assert.equal(toDoor.enter.allowed, false, 'the approach says she is not at the door yet')
assert.equal(code(() => world.call(hauwa, 'home.enter', { homeId: dHome })), 'conflict', 'going in from the street corner is refused')
assert.equal(code(() => world.call(hauwa, 'room.enter', { ref: { kind: 'home', homeId: dHome }, pos: { x: 2, z: 2 }, heading: 0 })), 'conflict', 'a raw room entry into a home is refused: it is the front door or nothing')
assert.equal(standing(hauwa), hBefore, 'and nobody moved')
walkTo(hauwa, toDoor.site.parcel.standing)
assert.equal(walkApproach(hauwa, dHome).enter.allowed, true, 'at the door the approach lets her in')
const visiting = world.call(hauwa, 'home.enter', { homeId: dHome })
assert.deepEqual([roomOf(world, hauwa)?.ref, visiting.stay.state], [{ kind: 'home', homeId: dHome }, 'inside'], 'in through the front door she is inside the home')
assert.equal(code(() => world.call(d, 'home.setSite', { place: null })), 'conflict', 'a home does not leave the map with a visitor inside')
// The host goes in the same way, and a friend who asks the way to them at home is answered by the home's own rule.
walkTo(d, walkApproach(d, dHome).site.parcel.standing)
world.call(d, 'home.enter', { homeId: dHome })
assert.equal(around(a).friends.find(friend => friend.member.id === d)!.where.words, 'at home')
world.call(hauwa, 'home.leave', {})
assert.equal(roomOf(world, hauwa)?.ref.kind, 'district', 'out by the door she came in by')
const fromStreet = world.call(hauwa, 'around.wayToFriend', { memberId: d }).way
assert.deepEqual([fromStreet.reach, fromStreet.destination?.kind], ['walk', 'home'], 'from the street outside: walk to the door')
const fromAfar = world.call(a, 'around.wayToFriend', { memberId: d }).way
assert.deepEqual([fromAfar.reach, fromAfar.destination], ['travel', null], 'from another city: a trip, and no door to go to')
world.call(d, 'home.setPolicy', { policy: 'private' })
assert.equal(world.call(hauwa, 'around.wayToFriend', { memberId: d }).way.reach, 'unavailable', 'a private home gives no way in')
world.call(d, 'home.setPolicy', { policy: 'friends' })
assert.equal(world.call(hauwa, 'around.wayToFriend', { memberId: d }).way.reach, 'walk')
world.call(d, 'home.leave', {})
// An answered invitation is judged again when it is asked for again, as the home is now.
world.call(d, 'home.setPolicy', { policy: 'private' })
const closedAgain = world.call(hauwa, 'join.respond', { inviteId: walkInvite.id, accept: true }).way
assert.deepEqual([closedAgain?.reach, closedAgain?.destination], ['unavailable', null], 'an accepted invitation does not promise a home that has since been closed')
world.call(d, 'home.setPolicy', { policy: 'friends' })
assert.equal(world.call(hauwa, 'join.respond', { inviteId: walkInvite.id, accept: true }).way?.reach, 'walk', 'and gives the way again when it is open')
// A waiting invitation cannot be accepted into a home that is closed, unplaced or from someone blocked; it stays to try again.
advance(MINUTE)
const homeWaiting = world.call(d, 'join.send', { to: hauwa, place: 'home', note: '' }).invite
assert.equal(world.call(hauwa, 'join.get', { inviteId: walkInvite.id }).invite.status, 'cancelled', 'a new invitation replaces the last')
world.call(d, 'home.setPolicy', { policy: 'private' })
assert.equal(code(() => world.call(hauwa, 'join.respond', { inviteId: homeWaiting.id, accept: true })), 'conflict', 'a private home cannot be accepted')
world.call(d, 'home.setPolicy', { policy: 'friends' })
world.call(d, 'home.setSite', { place: null })
assert.equal(code(() => world.call(hauwa, 'join.respond', { inviteId: homeWaiting.id, accept: true })), 'conflict', 'nor one taken off the map since')
const taken = approachOf(hauwa, dHome)
assert.deepEqual([taken.kind, taken.kind === 'unavailable' && taken.reason], ['unavailable', 'unplaced'])
assert.equal(code(() => world.call(hauwa, 'home.enter', { homeId: dHome })), 'unavailable')
assert.equal(world.call(hauwa, 'join.get', { inviteId: homeWaiting.id }).invite.status, 'pending', 'the invitation is still there to try again, or to decline')
world.call(d, 'home.setSite', { place: { parcelId: null } })
assert.equal(world.call(hauwa, 'join.respond', { inviteId: homeWaiting.id, accept: true }).way?.reach, 'walk', 'placed again: the same invitation can be accepted')
world.call(hauwa, 'member.block', { memberId: d })
assert.equal(code(() => world.call(hauwa, 'join.get', { inviteId: homeWaiting.id })), 'not_found', 'a blocked member’s invitation is gone')
assert.equal(code(() => world.call(hauwa, 'home.approach', { homeId: dHome })), 'forbidden', 'and so is the way to their home')
assert.equal(code(() => world.call(hauwa, 'home.enter', { homeId: dHome })), 'forbidden')
assert.equal(roomOf(world, hauwa)?.ref.kind, 'district')
disconnect(hauwa)
// Nowhere to invite to.
world.call(a, 'room.leave', {})
assert.equal(code(() => world.call(a, 'join.send', { to: b, place: 'here', note: '' })), 'conflict', 'standing nowhere: nothing to invite to')
world.call(a, 'room.enter', { ref: market, pos: { x: 1, z: 1 }, heading: 0 })
pass(`join me: friends only, accept / decline / cancel / replace / expiry after ${JOIN.hereMinutes} min, same city gives a walking target, another city says a trip is needed, a placed home is a front door to walk to (never from anywhere, never unplaced, private or blocked), nobody is ever moved, notifications social.join-me and social.join-accepted settle`)

// 9 ── Emotes reach the people who can see you, and only them.
breathe()
world.call(e, 'room.enter', { ref: street, pos: { x: 8, z: 8 }, heading: 0 })
clear()
assert.equal(world.call(b, 'emote.send', { kind: 'dance' }).reached, 2, 'c and e are in view; g is too far along the same street')
assert.deepEqual(got(c, 'social.emote').map(event => [event.memberId, event.kind]), [[b, 'dance']])
assert.equal(got(g, 'social.emote').length, 0)
assert.equal(got(a, 'social.emote').length, 0, 'not into the venue next door')
assert.equal(code(() => world.call(b, 'emote.send', { kind: 'backflip' as never })), 'invalid')
world.call(e, 'member.block', { memberId: b })
clear()
assert.equal(world.call(b, 'emote.send', { kind: 'wave' }).reached, 1)
assert.equal(got(e, 'social.emote').length, 0, 'a blocked pair do not see each other’s gestures')
world.call(e, 'member.unblock', { memberId: b })
let emotes = 0
for (let index = 0; index < 12; index++) if (code(() => world.call(b, 'emote.send', { kind: 'clap' })) === 'ok') emotes++
assert.equal(emotes, 6, 'eight gestures in ten seconds at most (two were used above)')
world.call(e, 'room.enter', { ref: nextStreet, pos: { x: 0, z: 0 }, heading: 0 })
pass('emotes: sent to members in the same room within view, never to a blocked member or another room, rate limited')

// 10 ── Unfriend: the history stays, nothing new is sent, open invitations end.
breathe()
befriend(b, c)
const withC = world.call(b, 'direct.open', { memberId: c }).conversation.id
world.call(b, 'direct.send', { conversationId: withC, text: 'Good to meet you at the market.', clientId: 'bc1' })
const openInvite = world.call(b, 'join.send', { to: c, place: 'here', note: '' }).invite
clear()
world.call(c, 'friends.remove', { memberId: b })
assert.equal(code(() => world.call(b, 'direct.send', { conversationId: withC, text: 'Hello?', clientId: 'bc2' })), 'forbidden')
const kept = world.call(c, 'direct.get', { conversationId: withC, before: null })
assert.deepEqual([kept.conversation.canSend, kept.messages.length, kept.conversation.peerWhere.hidden], [false, 1, true], 'the history is still readable; where the other is, is not')
assert.equal(world.call(b, 'join.get', { inviteId: openInvite.id }).invite.status, 'cancelled')
assert.equal(code(() => world.call(c, 'join.respond', { inviteId: openInvite.id, accept: true })), 'forbidden', 'the way (and the meeting point in it) is only ever given to a friend')
assert.ok(got(b, 'direct.changed').length >= 1, 'both Apps are told the conversation changed')
pass('unfriending: history readable, sending refused, whereabouts withheld, open invitations cancelled')

// 11 ── Block: the conversation leaves both sides' reach, delivery stops, counts and lists forget each other.
breathe()
disconnect(b)
world.call(a, 'direct.send', { conversationId, text: 'Unread when the block lands.', clientId: 'block-1' })
connect(b)
world.call(b, 'room.enter', { ref: street, pos: { x: 5, z: 5 }, heading: 0 })
assert.equal(around(b).unreadDirect, 1)
const beforeBlock = around(a).city.online
const streetsBefore = around(a).spots.find(spot => spot.kind === 'street')!.now
const pendingWave = world.call(a, 'wave.send', { to: b })
const pendingInvite = world.call(a, 'join.send', { to: b, place: 'here', note: '' }).invite
clear()
world.call(b, 'member.block', { memberId: a })
for (const memberId of [a, b]) {
  assert.equal(world.call(memberId, 'direct.list', {}).conversations.length, memberId === b ? 1 : 0, 'the conversation is listed for neither (b still has the one with c)')
  assert.ok(!world.call(memberId, 'direct.list', {}).conversations.some(item => item.id === conversationId))
  assert.equal(code(() => world.call(memberId, 'direct.get', { conversationId, before: null })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'direct.send', { conversationId, text: 'through the block', clientId: `blocked-${memberId}` })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'direct.read', { conversationId, upTo: 99 })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'direct.report', { conversationId, reason: 'spam', detail: '' })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'direct.open', { memberId: memberId === a ? b : a })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'wave.send', { to: memberId === a ? b : a })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'join.send', { to: memberId === a ? b : a, place: 'here', note: '' })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'around.wayToFriend', { memberId: memberId === a ? b : a })), 'not_found')
  assert.equal(code(() => world.call(memberId, 'join.get', { inviteId: pendingInvite.id })), 'not_found')
  assert.ok(got(memberId, 'direct.changed').length >= 1)
}
assert.equal(around(b).unreadDirect, 0, 'its unread count is gone with it')
assert.equal(got(b, 'direct.changed').at(-1)!.unread, 0)
assert.equal(note(b, 'direct.message').filter(item => item.state === 'active').length, 0, 'and so is the inbox entry')
assert.equal(note(b, 'social.wave').some(item => item.link.endsWith(pendingWave.wave.id) && item.state === 'active'), false)
assert.equal(note(b, 'social.join-me').some(item => item.link.endsWith(pendingInvite.id) && item.state === 'active'), false)
assert.equal(code(() => world.call(b, 'wave.back', { waveId: pendingWave.wave.id })), 'not_found')
assert.equal(around(a).city.online, beforeBlock - 1, 'a blocked member is not counted for the other')
assert.ok(!JSON.stringify(around(a)).includes('Bayo') && !JSON.stringify(around(b)).includes('Ada'), 'and appears nowhere in who is around')
assert.equal(around(a).spots.find(spot => spot.kind === 'street')!.now, streetsBefore - 1, 'nor in the count at a spot')
clear()
world.call(b, 'emote.send', { kind: 'wave' })
assert.equal(got(a, 'social.emote').length, 0)
// Unblocking does not bring the conversation back.
world.call(b, 'member.unblock', { memberId: a })
assert.equal(code(() => world.call(a, 'direct.get', { conversationId, before: null })), 'not_found', 'the old conversation stays closed after an unblock')
assert.equal(code(() => world.call(a, 'direct.open', { memberId: b })), 'forbidden', 'and a new one needs a new friendship')
pass('block: the conversation is closed to both for good, nothing is delivered, unread and inbox entries go, waves and invitations between the two end, counts and lists leave each other out')

// 12 ── Report keeps the recent messages for a reviewer.
breathe()
befriend(e, f)
const withF = world.call(e, 'direct.open', { memberId: f }).conversation.id
world.call(f, 'direct.send', { conversationId: withF, text: 'Buy my thing', clientId: 'spam-1' })
assert.equal(world.call(e, 'direct.report', { conversationId: withF, reason: 'spam', detail: 'Keeps selling' }).received, true)
assert.equal(code(() => world.call(c, 'direct.report', { conversationId: withF, reason: 'spam', detail: '' })), 'not_found')
pass('report from a conversation is accepted, from an outsider is not')

// 13 ── Invite links: signed, expiring, revocable, nothing personal in the address.
breathe()
clear()
const made = world.call(e, 'link.create', {}).link
assert.match(made.token, /^[a-z0-9]{16}\.[A-Za-z0-9_-]{22}$/, 'the address part is a random id and a signature')
for (const personal of [e, 'efe', 'Efe', 'Bodija', 'Ibadan', 'probe']) assert.ok(!made.token.includes(personal), `the link must not carry ${personal}`)
assert.equal(made.areaLabel, 'Bodija, Ibadan')
const newcomer = id('nneka')
ensureMember(world, newcomer, 'Nneka')
connect(newcomer)
const landing = world.call(newcomer, 'link.open', { token: made.token }).landing
assert.deepEqual([landing.inviter.id, landing.inviter.displayName, landing.areaLabel, landing.own, landing.area?.arrivalDistrict], [e, 'Efe', 'Bodija, Ibadan', false, ibadan.arrivalDistrict], 'the newcomer learns who invited them and the public place to start in')
assert.equal(note(e, 'social.invite-joined').length, 0, 'the inviter hears nothing until the newcomer exists in the world')
assert.equal(code(() => world.call(newcomer, 'link.hello', { token: made.token })), 'conflict', 'no introduction before the character is made')
world.call(newcomer, 'member.setCurrentArea', { area: landing.area!, source: 'manual' })
world.call(newcomer, 'member.completeOnboarding', {})
const joinedNote = note(e, 'social.invite-joined')
assert.deepEqual([joinedNote.length, joinedNote[0]!.title, joinedNote[0]!.category, joinedNote[0]!.actor?.id], [1, 'Nneka came through your invite link', 'social', newcomer])
world.call(newcomer, 'member.me', {})
assert.equal(note(e, 'social.invite-joined').length, 1, 'told once')
assert.deepEqual(world.call(e, 'link.mine', {}).links[0]!.joined.map(member => member.id), [newcomer], 'the maker sees who came through it')
assert.equal(world.call(newcomer, 'link.hello', { token: made.token }).state, 'sent', 'one tap sends the introduction')
const linkIntro = world.call(e, 'intro.list', {}).incoming.find(intro => intro.from.id === newcomer)!
assert.equal(linkIntro.note, 'I came through your invite link.')
assert.equal(world.call(newcomer, 'link.hello', { token: made.token }).state, 'waiting', 'a second tap does not send a second one')
world.call(e, 'intro.respond', { introId: linkIntro.id, accept: true })
assert.equal(world.call(newcomer, 'link.hello', { token: made.token }).state, 'friends')
assert.equal(world.call(e, 'link.open', { token: made.token }).landing.own, true, 'opening your own link changes nothing')
// Forged, revoked, expired, blocked.
const [linkId, signature] = made.token.split('.') as [string, string]
assert.equal(code(() => world.call(c, 'link.open', { token: `${linkId}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}` })), 'not_found', 'a changed signature is refused')
assert.equal(code(() => world.call(c, 'link.open', { token: `${'a'.repeat(16)}.${signature}` })), 'not_found', 'a made-up id is refused')
assert.equal(code(() => world.call(c, 'link.open', { token: 'not a token at all' })), 'not_found')
world.call(g, 'member.block', { memberId: e })
assert.equal(code(() => world.call(g, 'link.open', { token: made.token })), 'not_found', 'a blocked pair cannot use each other’s links')
world.call(g, 'member.unblock', { memberId: e })
const spare = world.call(e, 'link.create', {}).link
assert.equal(code(() => world.call(c, 'link.revoke', { id: spare.id })), 'not_found', 'only its maker can take a link back')
assert.equal(world.call(e, 'link.revoke', { id: spare.id }).links.length, 1)
assert.equal(code(() => world.call(c, 'link.open', { token: spare.token })), 'not_found', 'a link taken back stops working')
for (let index = 0; index < INVITE_LINK.open - 1; index++) world.call(e, 'link.create', {})
assert.equal(code(() => world.call(e, 'link.create', {})), 'conflict', `no more than ${INVITE_LINK.open} links open at once`)
assert.equal(code(() => world.call(f, 'link.create', {})), 'ok')
assert.equal(world.call(c, 'link.open', { token: made.token }).landing.inviter.id, e, 'an existing member can open one too')
assert.equal(note(e, 'social.invite-joined').length, 2)
advance(INVITE_LINK.days * DAY + MINUTE)
assert.equal(code(() => world.call(c, 'link.open', { token: made.token })), 'expired', `a link runs out after ${INVITE_LINK.days} days`)
assert.equal(world.call(e, 'link.mine', {}).links.length, 0)
pass('invite links: random signed address with nothing personal in it, newcomer starts in the inviter’s city, inviter told once (social.invite-joined), one-tap introduction, forged / revoked / expired / blocked refused, limited')

// 14 ── Open hangouts: a time and a public place in the game, for anyone in the city.
breathe()
clear()
world.call(e, 'room.enter', { ref: market, pos: { x: 4, z: 4 }, heading: 0 })
const inTwoHours = new Date(now + 2 * HOUR).toISOString()
assert.equal(code(() => world.call(e, 'hangout.create', { startsAt: new Date(now + 5 * MINUTE).toISOString(), note: '' })), 'invalid', 'not sooner than ten minutes')
assert.equal(code(() => world.call(e, 'hangout.create', { startsAt: new Date(now + 20 * DAY).toISOString(), note: '' })), 'invalid', 'not further than two weeks')
const hangout = world.call(e, 'hangout.create', { startsAt: inTwoHours, note: 'Bring a friend' }).hangout
assert.deepEqual([hangout.place, hangout.timezone, hangout.going, hangout.mine, hangout.iAmGoing, hangout.status], [{ kind: 'venue', name: 'Bodija Market', areaLabel: 'Bodija, Ibadan' }, 'Africa/Lagos', 1, true, true, 'upcoming'])
assert.deepEqual(around(c).hangouts.map(item => item.id), [hangout.id], 'anyone in the city sees it')
assert.equal(around(d).hangouts.length, 0, 'another city does not')
assertWordsOnly(around(c).hangouts, 'hangouts in who-is-around')
assert.equal(code(() => world.call(e, 'hangout.rsvp', { hangoutId: hangout.id, going: false })), 'invalid', 'the host cancels instead')
assert.equal(world.call(c, 'hangout.rsvp', { hangoutId: hangout.id, going: true }).hangout.going, 2)
assert.equal(world.call(newcomer, 'hangout.rsvp', { hangoutId: hangout.id, going: true }).hangout.going, 3)
assert.deepEqual(around(e).hangouts[0]!.friendsGoing.map(member => member.id), [newcomer], 'friends who are coming are named, the rest are a count')
const goingNote = note(e, 'hangout.going').filter(item => item.state === 'active')
assert.deepEqual([goingNote.length, goingNote[0]!.count, goingNote[0]!.category], [1, 2, 'events'], 'the host hears who is coming, folded into one entry')
let hangoutWay = world.call(c, 'hangout.way', { hangoutId: hangout.id }).way
assert.deepEqual([hangoutWay.reach, hangoutWay.destination?.kind === 'venue' && hangoutWay.destination.placeId], ['walk', 'p555'])
hangoutWay = world.call(d, 'hangout.way', { hangoutId: hangout.id }).way
assert.deepEqual([hangoutWay.reach, hangoutWay.destination], ['travel', null], 'from another city it says a trip is needed')
const hostPose = roomOf(world, f)!.pos
world.call(f, 'room.enter', { ref: nextStreet, pos: hostPose, heading: 0 })
assert.deepEqual(roomOf(world, f)!.pos, hostPose, 'refreshing a place in the same room never moves the host: a step is the accepted ones')
const streetHangout = world.call(f, 'hangout.create', { startsAt: new Date(now + 3 * HOUR).toISOString(), note: '' }).hangout
const streetWay = world.call(c, 'hangout.way', { hangoutId: streetHangout.id }).way.destination
assert.deepEqual([streetHangout.place.name, streetWay?.kind === 'street' && streetWay.meet], ['Streets of Bodija, Ibadan', null], 'a street hangout leads to the street, never to where the host stood')
world.call(c, 'hangout.rsvp', { hangoutId: streetHangout.id, going: true })
assert.equal(code(() => world.call(c, 'hangout.cancel', { hangoutId: streetHangout.id })), 'forbidden')
assert.equal(world.call(f, 'hangout.cancel', { hangoutId: streetHangout.id }).hangout.status, 'cancelled')
assert.equal(note(c, 'hangout.cancelled').length, 1, 'people who were coming are told when it is cancelled')
assert.deepEqual(around(c).hangouts.map(item => item.id), [hangout.id])
world.call(e, 'room.leave', {})
assert.equal(code(() => world.call(e, 'hangout.create', { startsAt: inTwoHours, note: '' })), 'conflict', 'a hangout needs a public place to be held in')
world.call(e, 'room.enter', { ref: market, pos: { x: 4, z: 4 }, heading: 0 })
world.call(e, 'hangout.create', { startsAt: new Date(now + 5 * HOUR).toISOString(), note: '' })
assert.equal(code(() => world.call(e, 'hangout.create', { startsAt: new Date(now + 6 * HOUR).toISOString(), note: '' })), 'conflict', `no more than ${HANGOUT.perHost} at once from one host`)
world.call(c, 'member.block', { memberId: e })
assert.equal(around(c).hangouts.length, 0, 'a blocked host’s hangouts are not shown')
assert.equal(code(() => world.call(c, 'hangout.get', { hangoutId: hangout.id })), 'not_found')
world.call(c, 'member.unblock', { memberId: e })
advance(2 * HOUR - (HANGOUT.remindMinutes - 1) * MINUTE)
const soon = note(c, 'hangout.soon')
assert.deepEqual([soon.length, soon[0]!.category, soon[0]!.link, soon[0]!.state], [1, 'events', `/people?tab=nearby&hangout=${hangout.id}`, 'active'], `a reminder ${HANGOUT.remindMinutes} minutes before, to those who said they are coming`)
assert.equal(note(e, 'hangout.soon').length, 1, 'and to the host')
assert.equal(note(g, 'hangout.soon').length, 0, 'nobody else')
advance(HANGOUT.remindMinutes * MINUTE)
assert.equal(around(c).hangouts[0]!.status, 'now')
assert.equal(note(c, 'hangout.soon').length, 1, 'reminded once')
advance(HANGOUT.lastsMinutes * MINUTE)
assert.ok(!around(c).hangouts.some(item => item.id === hangout.id), 'over two hours after it starts')
assert.equal(code(() => world.call(c, 'hangout.way', { hangoutId: hangout.id })), 'expired')
pass(`open hangouts: held at the public place the host stands in, ten minutes to two weeks ahead, seen by the city only, RSVP, host told (hangout.going), reminder ${HANGOUT.remindMinutes} min before (hangout.soon), cancel tells those coming, way follows the travel rules, blocked hosts hidden`)

// 15 ── The short presence cache: counts may lag by at most its length, never longer.
setPresenceCacheMs(1500)
breathe()
const cached = around(e).city.online
disconnect(g)
world.call(f, 'room.leave', {})
advance(1600)
assert.equal(around(e).city.online, cached - 1, 'a disconnect is seen at once; the rest within the cache time')
pass('presence cache: counts refresh on connect and disconnect, and within a second and a half otherwise')

console.log('ALL PASS')
