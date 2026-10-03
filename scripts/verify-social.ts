// Evidence probe for the core of the world service: areas and privacy, rooms, proximity text,
// voice gating, introductions, communities, meetups, homes and notifications.
// Runs the service in-process with a controllable clock. Not a test suite: prints PASS lines.
import assert from 'node:assert/strict'
import { createWorld } from '../service/index.ts'
import { ensureMember } from '../service/members.ts'
import { quietUntil } from '../service/notify.ts'
import { placeOf } from '../service/rooms.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { STARTER_PLACES } from '../src/shared/places.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { CURRENT_AREA_TTL_DAYS, PROXIMITY_RADIUS, WorldError } from '../src/shared/model.ts'
import type { RoomRef } from '../src/shared/model.ts'
import type { ServerEvent, ServerFrame } from '../src/shared/protocol.ts'

let now = Date.UTC(2026, 9, 1, 12)
const world = createWorld({ now: () => now })
const DAY = 86_400_000
const a = 'm_local_a' as MemberId, b = 'm_local_b' as MemberId, c = 'm_local_c' as MemberId, d = 'm_local_d' as MemberId
const events = new Map<MemberId, ServerEvent[]>()
for (const [id, name] of [[a, 'Ada'], [b, 'Bayo'], [c, 'Chidi'], [d, 'Dara']] as const) {
  ensureMember(world, id, name)
  events.set(id, [])
  world.connect(id, (frame: ServerFrame) => { if (frame.t === 'event') events.get(id)!.push(frame.event) }, () => undefined)
}
const got = (id: MemberId, type: ServerEvent['type']): ServerEvent[] => events.get(id)!.filter(event => event.type === type)
const clear = (): void => { for (const list of events.values()) list.length = 0 }
const code = (run: () => unknown): string => { try { run(); return 'ok' } catch (error) { return error instanceof WorldError ? error.code : `threw ${String(error)}` } }
const pass = (name: string): void => console.log(`PASS ${name}`)
const advance = (ms: number): void => { now += ms; world.tick() }

const place = (label: string) => areaFromPlace(STARTER_PLACES.find(entry => entry.label === label)!)
const ibadan = place('Bodija, Ibadan'), manchester = place('Northern Quarter, Manchester')
const street: RoomRef = { kind: 'district', districtId: ibadan.arrivalDistrict }

// 1 ── Current area: coarse, self-reported, expiring, and never exposed as a position.
world.call(a, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
world.call(b, 'member.setCurrentArea', { area: ibadan, source: 'device-suggested' })
world.call(c, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
world.call(d, 'member.setCurrentArea', { area: manchester, source: 'manual' })
for (const id of [a, b, c, d]) world.call(id, 'member.completeOnboarding', {})
assert.equal(code(() => world.call(a, 'member.setCurrentArea', { area: { ...ibadan, areaId: manchester.areaId }, source: 'manual' })), 'invalid', 'a cell that does not contain the anchor is refused')
let nearby = world.call(a, 'nearby.list', {})
assert.equal(nearby.members.length, 0, 'nobody is listed until both opt in')
const prefs = (id: MemberId) => world.call(id, 'member.me', {}).profile.preferences
world.call(a, 'member.savePreferences', { preferences: { ...prefs(a), discoverable: true } })
assert.equal(world.call(a, 'nearby.list', {}).members.length, 0, 'the other side has not opted in')
world.call(b, 'member.savePreferences', { preferences: { ...prefs(b), discoverable: true } })
world.call(d, 'member.savePreferences', { preferences: { ...prefs(d), discoverable: true } })
nearby = world.call(a, 'nearby.list', {})
assert.deepEqual(nearby.members.map(member => member.id), [b], 'same area only: c has not opted in, d is in another country')
assert.equal(nearby.members[0]!.reason, 'same-area')
const exposed = JSON.stringify(nearby)
for (const key of ['anchor', 'lat', 'lon', 'areaId', 'arrivalDistrict', 'expiresAt', 'pos']) assert.ok(!exposed.includes(`"${key}"`), `nearby list leaks ${key}`)
for (const value of ['"a:12', '"d:14']) assert.ok(!exposed.includes(value), `nearby list leaks a cell id`)
assert.equal(nearby.members[0]!.areaLabel, 'Bodija, Ibadan', 'only the area name is shown')
pass('current area: opt-in on both sides, same coarse area only, response carries the area name and nothing finer')

advance((CURRENT_AREA_TTL_DAYS + 1) * DAY)
nearby = world.call(a, 'nearby.list', {})
assert.equal(nearby.stale, true)
assert.equal(nearby.members.length, 0, 'a stale area drops out of discovery')
assert.equal(world.call(b, 'member.public', { memberId: a }).member.areaLabel, null, 'a stale area label is withheld')
world.call(a, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
world.call(b, 'member.setCurrentArea', { area: ibadan, source: 'manual' })
assert.equal(world.call(a, 'nearby.list', {}).members.length, 1)
pass(`current area expires after ${CURRENT_AREA_TTL_DAYS} days and reconfirming restores it`)

// 2 ── Rooms and proximity text: only avatars in range, in the same room, receive a message.
const radius = PROXIMITY_RADIUS.district
world.call(a, 'room.enter', { ref: street, pos: { x: 0, z: 0 }, heading: 0 })
world.call(b, 'room.enter', { ref: street, pos: { x: radius - 2, z: 0 }, heading: 0 })
world.call(c, 'room.enter', { ref: street, pos: { x: radius + 30, z: 0 }, heading: 0 })
const elsewhere: RoomRef = { kind: 'venue', districtId: manchester.arrivalDistrict, placeId: 'p123' as never }
world.call(d, 'room.enter', { ref: elsewhere, pos: { x: 1, z: 1 }, heading: 0 })
assert.equal(code(() => world.call(d, 'room.enter', { ref: street, pos: { x: 0, z: 0 }, heading: 0 })), 'forbidden', 'an avatar in Manchester cannot step into an Ibadan street without travelling')
clear()
let sent = world.call(a, 'chat.send', { text: 'hello nearby', clientId: '1' }).message
assert.equal(sent.audience, 1)
assert.equal(got(b, 'chat.message').length, 1, 'in range receives')
assert.equal(got(c, 'chat.message').length, 0, 'out of range in the same room does not')
assert.equal(got(d, 'chat.message').length, 0, 'another room does not')
// c walks into range step by step (a jump would be rejected), then receives.
for (let x = radius + 30; x > radius - 3; x -= 6) { advance(1000); assert.equal(world.call(c, 'room.move', { pos: { x, z: 0 }, heading: 0, moving: true }).accepted, true) }
clear()
sent = world.call(a, 'chat.send', { text: 'now two of you', clientId: '2' }).message
assert.equal(sent.audience, 2)
assert.equal(got(c, 'chat.message').length, 1, 'receives after walking into range')
// b walks away and stops receiving. Each accepted step is at most 6 m in 1 s, so the service must
// accept it; the poses it reports back are checked, not assumed, and so is the same-instance range.
assert.deepEqual(placeOf(world, b)!.pos, { x: radius - 2, z: 0 }, 'b starts where its arrival put it')
for (let z = 0; z <= radius + 16; z += 6) {
  advance(1000)
  const step = world.call(b, 'room.move', { pos: { x: radius - 2, z: -z }, heading: 0, moving: true })
  assert.equal(step.accepted, true, `b's step to z=${-z} is accepted`)
  assert.deepEqual(step.pos, { x: radius - 2, z: -z })
  assert.deepEqual(placeOf(world, b)!.pos, { x: radius - 2, z: -z }, 'the service holds b where it reported')
}
const poseA = placeOf(world, a)!, poseB = placeOf(world, b)!, poseC = placeOf(world, c)!
assert.ok(poseA.key === poseB.key && poseA.key === poseC.key && poseA.instance === poseB.instance && poseA.instance === poseC.instance, 'a, b and c share one room instance')
assert.ok(Math.hypot(poseB.pos.x - poseA.pos.x, poseB.pos.z - poseA.pos.z) > radius, 'b is now beyond the proximity radius of a')
assert.ok(Math.hypot(poseC.pos.x - poseA.pos.x, poseC.pos.z - poseA.pos.z) <= radius, 'c is still within it')
clear()
assert.equal(world.call(a, 'chat.send', { text: 'b has left range', clientId: '3' }).message.audience, 1)
assert.equal(got(b, 'chat.message').length, 0, 'stops receiving after leaving range')
assert.equal(got(c, 'chat.message').length, 1, 'c, still in range, does receive')
assert.equal(world.call(c, 'room.move', { pos: { x: 900, z: 900 }, heading: 0, moving: true }).accepted, false, 'an impossible jump is rejected')
// History on entering never contains what was said before the member was in range.
const back = world.call(b, 'room.enter', { ref: street, pos: placeOf(world, b)!.pos, heading: 0 })
assert.ok(back.history.every(message => message.text !== 'b has left range'), 'history on re-entering holds only what the member actually received')
pass('proximity text: enter and leave range, room boundary, no leaked history, impossible moves rejected')

// 3 ── Voice: signalling is relayed only between members the service counts as in range.
assert.equal(world.call(b, 'room.move', { pos: placeOf(world, b)!.pos, heading: 0, moving: false }).accepted, true, 'b stops where it is, out of a’s range')
world.call(a, 'voice.set', { state: 'live' })
world.call(c, 'voice.set', { state: 'live' })
world.call(b, 'voice.set', { state: 'live' })
assert.equal(world.call(a, 'voice.signal', { to: c, data: { offer: 1 } }).relayed, true, 'in range relays')
assert.equal(world.call(a, 'voice.signal', { to: b, data: { offer: 1 } }).relayed, false, 'out of range does not relay')
world.call(d, 'voice.set', { state: 'live' })
assert.equal(world.call(a, 'voice.signal', { to: d, data: { offer: 1 } }).relayed, false, 'never across rooms')
clear()
world.call(c, 'voice.set', { state: 'off' })
assert.deepEqual((got(a, 'voice.peers').at(-1) as { peers: MemberId[] }).peers, [], 'turning voice off removes the peer for others')
world.call(c, 'voice.set', { state: 'muted' })
assert.equal(world.call(a, 'voice.set', { state: 'live' }).peers.includes(c), true, 'a muted member is still an audience member, shown as muted')
pass('proximity voice gating: in range only, never across rooms, off and mute are honoured (audio itself is not exercised here)')

// 4 ── Block: both directions, everywhere, immediately.
world.call(a, 'member.block', { memberId: c })
assert.equal(world.call(a, 'voice.signal', { to: c, data: {} }).relayed, false, 'voice path is withdrawn')
clear()
assert.equal(world.call(a, 'chat.send', { text: 'c should not see this', clientId: '4' }).message.audience, 0)
assert.equal(got(c, 'chat.message').length, 0)
assert.equal(code(() => world.call(c, 'member.public', { memberId: a })), 'not_found', 'the blocked member cannot look the blocker up')
assert.equal(code(() => world.call(c, 'intro.send', { to: a, note: '' })), 'not_found')
assert.ok(!world.call(c, 'room.enter', { ref: street, pos: { x: 0, z: 0 }, heading: 0 }).snapshot.members.some(member => member.id === a), 'not in each other’s room snapshot')
world.call(a, 'member.unblock', { memberId: c })
world.call(a, 'member.report', { memberId: c, reason: 'spam', detail: 'probe', room: null })
pass('block: no chat, no voice, no lookup, no introduction, not visible in the room; report is accepted')

// 5 ── Introductions and friends: nothing without mutual acceptance.
const intro = world.call(a, 'intro.send', { to: b, note: 'Hello from the probe' }).intro
assert.equal(world.call(a, 'friends.list', {}).friends.length, 0, 'sending does not make a friendship')
assert.equal(code(() => world.call(a, 'intro.respond', { introId: intro.id, accept: true })), 'forbidden', 'the sender cannot accept their own introduction')
assert.equal(code(() => world.call(a, 'intro.send', { to: b, note: '' })), 'conflict', 'no duplicate pending introduction')
world.call(b, 'intro.respond', { introId: intro.id, accept: true })
assert.deepEqual(world.call(a, 'friends.list', {}).friends.map(friend => friend.id), [b])
assert.deepEqual(world.call(b, 'friends.list', {}).friends.map(friend => friend.id), [a])
const expiring = world.call(c, 'intro.send', { to: d, note: '' }).intro
advance(15 * DAY)
assert.equal(code(() => world.call(d, 'intro.respond', { introId: expiring.id, accept: true })), 'conflict', 'an expired introduction cannot be accepted')
pass('introductions: mutual acceptance only, no duplicates, expiry')

// 6 ── Communities: roles and permissions.
const community = world.call(a, 'community.create', { name: 'Bodija Neighbours', about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'invite-only' }).community
assert.equal(code(() => world.call(c, 'community.join', { communityId: community.id })), 'forbidden', 'invite-only needs an invitation')
assert.equal(code(() => world.call(c, 'community.get', { communityId: community.id })), 'not_found', 'and is not visible to outsiders')
world.call(a, 'community.invite', { communityId: community.id, memberId: b })
world.call(b, 'community.join', { communityId: community.id })
world.call(b, 'community.post', { communityId: community.id, text: 'First post' })
assert.equal(code(() => world.call(c, 'community.post', { communityId: community.id, text: 'outsider' })), 'forbidden')
assert.equal(code(() => world.call(b, 'community.setRole', { communityId: community.id, memberId: a, role: 'member' })), 'forbidden', 'a member cannot change roles')
world.call(a, 'community.setRole', { communityId: community.id, memberId: b, role: 'moderator' })
const post = world.call(a, 'community.post', { communityId: community.id, text: 'To be removed' }).community.posts.at(-1)!
assert.equal(world.call(b, 'community.removePost', { communityId: community.id, postId: post.id }).community.posts.at(-1)!.removed, true, 'a moderator can remove a post')
world.call(b, 'community.leave', { communityId: community.id })
assert.equal(world.call(b, 'community.list', {}).mine.length, 0)
pass('communities: invite-only visibility, join, post, roles, moderation, leave')

// 7 ── Public meetup: both see the same plan; a revised plan needs a fresh answer; no origin is stored.
const venue = { placeId: 'p555' as never, districtId: ibadan.arrivalDistrict, name: 'Bodija Market', category: 'shop', branch: 'main gate' }
const startsAt = new Date(now + 2 * DAY).toISOString()
const meetup = world.call(a, 'meetup.propose', { venue, startsAt, timezone: 'Africa/Lagos', note: 'probe', invite: [b] }).meetup
assert.equal(code(() => world.call(a, 'meetup.propose', { venue, startsAt, timezone: 'Africa/Lagos', note: '', invite: [c] })), 'forbidden', 'only friends can be invited')
assert.equal(code(() => world.call(c, 'meetup.get', { meetupId: meetup.id })), 'not_found', 'not visible to non-participants')
const seenByB = world.call(b, 'meetup.get', { meetupId: meetup.id }).meetup
assert.deepEqual([seenByB.venue.name, seenByB.venue.branch, seenByB.startsAt, seenByB.timezone], [meetup.venue.name, 'main gate', meetup.startsAt, 'Africa/Lagos'], 'both see the same agreed plan')
for (const secret of ['anchor', 'lat', 'lon', 'areaId', 'currentArea', 'pos']) assert.ok(!JSON.stringify(seenByB).includes(`"${secret}"`), `a meetup must not carry ${secret}`)
const revised = world.call(a, 'meetup.revise', { meetupId: meetup.id, venue: { ...venue, branch: 'side entrance' }, startsAt, timezone: 'Africa/Lagos', note: '' }).meetup
assert.equal(code(() => world.call(b, 'meetup.respond', { meetupId: meetup.id, accept: true, revision: meetup.revision })), 'conflict', 'an answer to the old plan is refused')
assert.equal(world.call(b, 'meetup.respond', { meetupId: meetup.id, accept: true, revision: revised.revision }).meetup.status, 'agreed')
assert.equal(code(() => world.call(b, 'meetup.cancel', { meetupId: meetup.id })), 'forbidden', 'only the organiser cancels')
assert.equal(world.call(a, 'meetup.cancel', { meetupId: meetup.id }).meetup.status, 'cancelled')
assert.equal(world.call(b, 'meetup.get', { meetupId: meetup.id }).meetup.status, 'cancelled')
pass('meetup: public venue and branch, same plan for both, revise resets answers, cancel, no starting point anywhere')

// 8 ── Homes: saved layout survives another session; private homes refuse visitors and eject them.
// A home stands in a street and is entered on foot by its front door. Homes can be placed only where
// parcel data ships (Yaba), and reaching another district takes a trip, so the owner, a friend and a
// stranger are three further synthetic members who start there. The home is placed, and the friend
// walks from the arrival to the door.
const yaba = place('Yaba, Lagos')
const yabaStreet: RoomRef = { kind: 'district', districtId: yaba.arrivalDistrict }
const owner = 'm_local_e' as MemberId, guest = 'm_local_f' as MemberId, stranger = 'm_local_g' as MemberId
for (const [id, name] of [[owner, 'Efe'], [guest, 'Femi'], [stranger, 'Gold']] as const) {
  ensureMember(world, id, name)
  world.connect(id, () => undefined, () => undefined)
  world.call(id, 'member.setCurrentArea', { area: yaba, source: 'manual' })
  world.call(id, 'member.completeOnboarding', {})
}
for (const id of [owner, guest]) {
  world.call(id, 'room.enter', { ref: yabaStreet, pos: { x: 0, z: 0 }, heading: 0 })
  assert.equal(placeOf(world, id)!.ref.kind, 'district', 'the arrival put the member in the street')
}
const friendship = world.call(owner, 'intro.send', { to: guest, note: 'neighbours' }).intro
world.call(guest, 'intro.respond', { introId: friendship.id, accept: true })
const sites = world.call(owner, 'home.sites', {})
assert.equal(sites.unavailable, null, 'Yaba has parcel data')
const parcel = sites.parcels.find(entry => !entry.taken && entry.fits)!
world.call(owner, 'home.setSite', { place: { parcelId: parcel.parcelId } })
const mine = world.call(owner, 'home.get', { homeId: null })
const layout = { ...mine.home.layout, items: [...mine.home.layout.items, { key: 'probe-chair', model: 'chairCushion', x: 6, z: 6, turns: 1 as const, productId: null, variantId: null, tints: {} }] }
const saved = world.call(owner, 'home.save', { layout, name: 'Efe’s place', expectedRevision: mine.home.revision }).home
assert.equal(code(() => world.call(owner, 'home.save', { layout, name: 'stale', expectedRevision: mine.home.revision })), 'conflict', 'a stale save is refused, not merged')
assert.ok(world.call(guest, 'home.get', { homeId: saved.id }).home.layout.items.some(item => item.key === 'probe-chair'), 'a friend in another session sees the saved layout')
assert.equal(world.call(guest, 'home.get', { homeId: saved.id }).canEdit, false)
assert.equal(code(() => world.call(guest, 'home.save', { layout, name: 'x', expectedRevision: saved.revision })), 'conflict', 'a visitor’s save only ever targets their own home')
assert.equal(code(() => world.call(stranger, 'home.get', { homeId: saved.id })), 'forbidden', 'friends-only home refuses a non-friend')
assert.equal(code(() => world.call(stranger, 'room.enter', { ref: { kind: 'home', homeId: saved.id }, pos: { x: 1, z: 1 }, heading: 0 })), 'forbidden')
assert.equal(code(() => world.call(guest, 'room.enter', { ref: { kind: 'home', homeId: saved.id }, pos: { x: 2, z: 2 }, heading: 0 })), 'conflict', 'a friend cannot step in from the street: only the front door')
// The friend is at the arrival, away from the door: the approach says walk, and the door stays shut until they are there.
const approachOf = () => {
  const { approach } = world.call(guest, 'home.approach', { homeId: saved.id })
  assert.equal(approach.kind, 'walk', 'the placed home is reachable on foot from its own street')
  return approach.kind === 'walk' ? approach : assert.fail('not a walk')
}
let approach = approachOf()
assert.equal(approach.enter.allowed, false, 'the friend is not at the door yet')
assert.equal(code(() => world.call(guest, 'home.enter', { homeId: saved.id })), 'conflict', 'the door does not open from the arrival point')
// Bounded 6 m steps, one second apiece, toward the standing point; each answer is checked.
for (let steps = 0; !approach.enter.allowed; steps++) {
  assert.ok(steps < 8, 'the door is reached within a few steps')
  const from = placeOf(world, guest)!.pos, to = approach.site.parcel.standing
  const left = Math.hypot(to.x - from.x, to.z - from.z), k = Math.min(6, left) / left
  const target = { x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k }
  advance(1000)
  const step = world.call(guest, 'room.move', { pos: target, heading: 0, moving: true })
  assert.equal(step.accepted, true, `step ${steps + 1} toward the door is accepted`)
  assert.deepEqual(step.pos, target)
  approach = approachOf()
}
const visit = world.call(guest, 'home.enter', { homeId: saved.id })
assert.equal(visit.stay.state, 'inside', 'the friend went in by the door')
assert.equal(placeOf(world, guest)!.ref.kind, 'home', 'the friend is now in the home')
world.call(owner, 'home.setPolicy', { policy: 'private' })
assert.equal(code(() => world.call(guest, 'chat.send', { text: 'still inside?', clientId: '9' })), 'conflict', 'the visitor was shown out when the home became private')
assert.equal(code(() => world.call(guest, 'home.get', { homeId: saved.id })), 'forbidden')
world.call(owner, 'home.move', { districtLabel: 'Camden Town' })
assert.equal(world.call(owner, 'member.me', {}).profile.currentArea!.label, 'Yaba, Lagos', 'moving the virtual home does not change the current area')
pass('homes: persisted layout, revision conflict, friends-only and private access, eviction, home district independent of current area')

// 9 ── Notifications: durable, de-duplicated, expiring, read-suppressed, quiet hours, nothing sent.
const inbox = (id: MemberId, includeRead = true) => world.call(id, 'notify.list', { includeRead })
assert.ok(inbox(b).notifications.some(item => item.kind === 'meetup.invited' || item.kind === 'meetup.revised'), 'events were recorded durably')
world.call(b, 'notify.readAll', { category: null })
world.call(b, 'notify.setConsent', { channel: 'email', granted: true, destination: 'bayo@example.com' })
world.call(b, 'notify.setCategory', { category: 'replies', channel: 'email', enabled: true })
world.call(b, 'notify.setQuietHours', { quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'Africa/Lagos' } })
assert.equal(code(() => world.call(b, 'notify.setCategory', { category: 'replies', channel: 'whatsapp', enabled: true })), 'conflict', 'a channel cannot be switched on without consent')
world.call(a, 'community.invite', { communityId: community.id, memberId: b })
world.call(b, 'community.join', { communityId: community.id })
world.call(b, 'notify.readAll', { category: null })
for (const text of ['one', 'two', 'three']) world.call(a, 'community.post', { communityId: community.id, text })
const folded = inbox(b, false).notifications.filter(item => item.kind === 'community.post')
assert.equal(folded.length, 1, 'three posts fold into one unread entry')
assert.equal(folded[0]!.count, 3)
let deliveries = world.call(b, 'notify.deliveries', {}).deliveries.filter(item => item.notificationId === folded[0]!.id)
assert.equal(deliveries.length, 1, 'and into one prepared reminder')
assert.equal(deliveries[0]!.state, 'scheduled')
assert.ok(deliveries[0]!.preview.to.includes('•••') && !JSON.stringify(deliveries).includes('bayo@example.com'), 'the destination is masked on the way back to the client')
advance(11 * 60_000)
deliveries = world.call(b, 'notify.deliveries', {}).deliveries.filter(item => item.notificationId === folded[0]!.id)
assert.equal(deliveries[0]!.state, 'ready-not-sent', 'the adapter is in dry-run: prepared, never reported as sent')
assert.ok(world.call(b, 'notify.deliveries', {}).adapters.every(adapter => adapter.mode === 'dry-run'))
// Read in the App before the reminder is due → cancelled.
world.call(b, 'notify.readAll', { category: null })
world.call(a, 'community.post', { communityId: community.id, text: 'read me in the app' })
const fresh = inbox(b, false).notifications.find(item => item.kind === 'community.post')!
world.call(b, 'notify.open', { notificationId: fresh.id })
advance(11 * 60_000)
assert.equal(world.call(b, 'notify.deliveries', {}).deliveries.find(item => item.notificationId === fresh.id)!.state, 'suppressed-read')
// Quiet hours hold a reminder until morning.
world.call(b, 'notify.setQuietHours', { quietHours: { enabled: true, start: '00:00', end: '23:59', timezone: 'Africa/Lagos' } })
world.call(a, 'community.post', { communityId: community.id, text: 'during quiet hours' })
advance(11 * 60_000)
const held = inbox(b, false).notifications.find(item => item.kind === 'community.post')!
assert.equal(world.call(b, 'notify.deliveries', {}).deliveries.find(item => item.notificationId === held.id)!.state, 'held-quiet-hours')
assert.equal(quietUntil(Date.UTC(2026, 9, 1, 22, 30), { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' }), Date.UTC(2026, 9, 2, 7, 0), 'held until the end of quiet hours')
assert.equal(quietUntil(Date.UTC(2026, 9, 1, 12, 0), { enabled: true, start: '22:00', end: '07:00', timezone: 'UTC' }), null)
// Withdrawing consent forgets the destination and cancels what was waiting.
world.call(b, 'notify.setConsent', { channel: 'email', granted: false, destination: '' })
assert.equal(world.call(b, 'notify.prefs', {}).prefs.consent.email.destination, '')
assert.equal(world.call(b, 'notify.deliveries', {}).deliveries.find(item => item.notificationId === held.id)!.state, 'suppressed-expired')
// An expired invite stays readable, marked expired, with its link.
const stale = world.call(d, 'intro.send', { to: c, note: 'will expire' }).intro
advance(15 * DAY)
const expired = inbox(c).notifications.find(item => item.kind === 'intro.received' && item.state === 'expired')
assert.ok(expired && expired.link, `expired introduction ${stale.id} is still in the inbox with a link`)
assert.equal(world.call(c, 'notify.open', { notificationId: expired.id }).notification.state, 'expired')
pass('notifications: durable inbox, folding, masked previews, dry-run adapters, read suppression, quiet hours, consent withdrawal, expired invite keeps its context')

// 10 ── Account isolation: one member cannot read another's private records.
const meOfB = world.call(b, 'member.me', {})
assert.equal(meOfB.profile.id, b)
assert.equal(inbox(b).notifications.some(item => inbox(c).notifications.some(other => other.id === item.id)), false, 'inboxes do not overlap')
assert.equal(code(() => world.call(c, 'notify.open', { notificationId: inbox(b).notifications[0]!.id })), 'not_found', 'another member’s notification cannot be opened')
assert.equal(code(() => world.call(c, 'member.face', { memberId: a, version: 1 })), 'not_found', 'no photo face is served where none is visible')
pass('account scope: private records are only served to their owner')
console.log('ALL PASS')
