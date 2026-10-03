// Evidence probe for the creator connection and welcome: in-process fixture worlds, a controllable
// clock, plain asserts, a saved world held as text in memory. No server, no network, no account,
// no real member, message or photo: every id, name and byte below is made up here.
// Run: node scripts/verify-creator.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { CREATOR_AUTOMATIC_LABEL, CREATOR_DISCLOSURE, FRIENDS_AUTOMATIC_LISTED, creatorWelcomeText } from '../src/shared/creator.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { guestAccess } from '../src/shared/guest.ts'
import { FACE_LANDMARKS, WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode } from '../src/shared/model.ts'
import type { OpName, Ops, ServerEvent, ServerFrame } from '../src/shared/protocol.ts'
import { TRAVEL } from '../src/shared/travel.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { registerCreator } from '../service/creator.ts'
import type { CreatorConfig, CreatorService } from '../service/creator.ts'
import { accountMemberId, principalFromHosted, registerGuests, scopeFromHosted } from '../service/guests.ts'
import type { GuestActor, GuestService, VerifiedPrincipal } from '../service/guests.ts'
import type { HostedBinding, HostedSubject } from '../service/hostedIdentity.ts'
import { createWorld } from '../service/index.ts'
import type { Persistence, World } from '../service/kernel.ts'
import { addFriendship, areFriends, creatorOf, ensureMember, exists, friendTag } from '../service/members.ts'

const SECOND = 1000, DAY = 86_400_000
let now = Date.UTC(2026, 9, 2, 12)

// Fixture ids. `.invalid` never resolves, and nothing here is ever asked to.
const binding: HostedBinding = {
  siteId: 'site-probe', packageId: 'cli-probe', channel: 'test', buildId: 'build-1', artifactId: 'artifact-1',
  audience: 'https://world.probe.invalid', origin: 'https://app.probe.invalid',
}
/** The creator of this fixture world. Not the real account: that id is only ever in the server's configuration. */
const CREATOR: CreatorConfig = { account: { accountId: 'account-creator', subjectId: 'subject-creator' } }
const subject = (account: string, overrides: Partial<HostedSubject> = {}): HostedSubject =>
  ({ ...binding, subjectId: `subject-${account}`, accountId: `account-${account}`, installationId: 'installation-probe', expiresAt: now + 30_000, ...overrides })
const principal = (account: string, overrides: Partial<HostedSubject> = {}): VerifiedPrincipal => principalFromHosted(subject(account, overrides))

interface TextStore extends Persistence { text(): string }
function memoryStore(initial: string | null = null): TextStore {
  let saved = initial
  return {
    load: () => (saved === null ? null : JSON.parse(saved) as Record<string, unknown>),
    save: state => { saved = JSON.stringify(state) },
    text: () => saved ?? '',
  }
}
interface Service { world: World; guests: GuestService; creator: CreatorService }
function open(from: TextStore, config: CreatorConfig | null): Service {
  const world = createWorld({ now: () => now, persistence: from })
  const guests = registerGuests(world, scopeFromHosted(binding), { entry: 'open' })
  return { world, guests, creator: registerCreator(world, config ? { guests, config } : null) }
}
let store = memoryStore()
let main = open(store, CREATOR)
function restart(config: CreatorConfig | null = CREATOR): void { main.world.flush(); main = open(store, config) }
const saved = (): Record<string, unknown> => { main.world.flush(); return JSON.parse(store.text()) as Record<string, unknown> }
/** The slices of the saved world that hold `needle` anywhere. */
const slicesHolding = (needle: string): string[] => Object.entries(saved()).filter(([, slice]) => JSON.stringify(slice).includes(needle)).map(([name]) => name)

function rejects(code: ErrorCode, run: () => unknown, message?: RegExp): void {
  try { run() } catch (error) {
    assert.ok(error instanceof WorldError, `expected WorldError(${code}), got ${String(error)}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (message) assert.match(error.message, message)
    return
  }
  assert.fail(`expected ${code}, but the call succeeded`)
}

let failed = false
function check(name: string, run: () => void): void {
  if (failed) return
  // Each check starts with a full request allowance.
  now += 5 * SECOND
  try { run(); console.log(`PASS ${name}`) } catch (error) {
    failed = true
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

type Caller = <K extends OpName>(op: K, input: Ops[K]['in']) => Ops[K]['out']
const as = (memberId: MemberId): Caller => (op, input) => main.world.call(memberId, op, input)
interface Guest { token: string; actor: GuestActor; id: MemberId }
let sources = 0
const src = (): string => `caller-${++sources}`
function newGuest(): Guest {
  const { session, actor } = main.guests.issue({ source: src() })
  return { token: session.token, actor, id: actor.memberId }
}
const asGuest = (guest: Guest): Caller => (op, input) => main.guests.call(guest.actor, op, input)

/** A fixture member who is not a guest: what an account member is to every rule below. */
function member(name: string, displayName = name): MemberId {
  const memberId = `m_probe_${name.toLowerCase()}` as MemberId
  main.world.scoped(() => ensureMember(main.world, memberId, displayName))
  return memberId
}
const onboard = (call: Caller): void => { call('member.completeOnboarding', {}) }
const threads = (call: Caller) => call('direct.list', {}).conversations
const messagesIn = (call: Caller, conversationId: Ops['direct.get']['in']['conversationId']) => call('direct.get', { conversationId, before: null }).messages
/** The real Friends directory, as the Friends window reads it. */
function directory(memberId: MemberId, call: Caller = as(memberId)) {
  const { friends, total } = call('friends.list', {})
  return { friends, total, ids: friends.map(friend => friend.id) }
}
const welcomesFor = (call: Caller): number => threads(call).reduce((sum, thread) => sum + messagesIn(call, thread.id).filter(message => message.automatic === 'welcome').length, 0)
const balance = (call: Caller): number => call('travel.state', {}).state.balance
const ibadan: CoarseArea = areaFromPlace({ label: 'Bodija, Ibadan', countryCode: 'NG', anchor: { lat: 7.4352, lon: 3.914 } })
const arrive = (call: Caller): void => { call('member.setCurrentArea', { area: ibadan, source: 'manual' }) }
function listen(memberId: MemberId) {
  const events: ServerEvent[] = [], frames: ServerFrame[] = []
  const connection = main.world.connect(memberId, frame => { frames.push(frame); if (frame.t === 'event') events.push(frame.event) }, () => {})
  return { connection, events, frames }
}

const WELCOME = creatorWelcomeText(null)

// ── 1 Off ──

check('1 with no configuration nothing happens: no creator, no connection, no message, nothing saved', () => {
  const off = open(memoryStore(), null)
  const first = 'm_probe_first' as MemberId
  off.world.scoped(() => ensureMember(off.world, first, 'First'))
  off.world.call(first, 'member.completeOnboarding', {})
  off.world.tick()
  assert.deepEqual(off.creator.status(), { enabled: false, ready: false, memberId: null, welcomed: 0, removed: 0, scanning: false })
  assert.deepEqual(off.world.call(first, 'creator.card', {}).creator, { ready: false, member: null, link: 'none', conversationId: null, welcomedAt: null, hangout: null })
  assert.equal(off.creator.signedIn(principalFromHosted(subject('creator'))), false)
  assert.deepEqual(off.world.call(first, 'direct.list', {}).conversations, [])
  off.world.flush()
  const text = JSON.stringify(off.world.peek('creator') ?? null) + JSON.stringify(off.world.peek('members')) + JSON.stringify(off.world.peek('direct'))
  assert.ok(!text.includes('"tagged":') && !text.includes('"auto":') && !text.includes('"creator":') && off.world.peek('creator') === undefined)
  // The parent decides where the feature exists at all: a world it was never registered on does not know the operation.
  const bare = createWorld({ now: () => now })
  bare.scoped(() => ensureMember(bare, first, 'First'))
  rejects('invalid', () => bare.call(first, 'creator.card', {}), /Unknown operation/)
  assert.match(CREATOR_DISCLOSURE, /one automatic welcome message/)
  assert.equal(CREATOR_AUTOMATIC_LABEL, 'Automatic welcome message')
  restart()
})

// ── 2–3 Who the creator is, and the first welcomes ──

let ada!: MemberId, bayo!: MemberId, mallory!: MemberId, fola!: MemberId, nobody!: MemberId
let early!: Guest, ended!: Guest, kromitGuest!: Guest
let K!: MemberId
const crowd: MemberId[] = []

check('2 configured, creator not here yet: members wait, nobody is invented, and only the verified account can be the creator', () => {
  ada = member('ada', 'Ada')
  onboard(as(ada))
  early = newGuest()
  onboard(asGuest(early))
  main.world.tick()
  assert.deepEqual(main.creator.status(), { enabled: true, ready: false, memberId: null, welcomed: 0, removed: 0, scanning: true })
  assert.equal(as(ada)('creator.card', {}).creator.ready, false)
  assert.deepEqual([threads(as(ada)), threads(asGuest(early))], [[], []])

  // The creator's account signs in nowhere yet: no member is made for it, so it can still claim a guest later.
  assert.equal(main.creator.signedIn(principal('creator')), false)
  assert.equal(exists(main.world, accountMemberId(principal('creator'))), false, 'no placeholder character')
  assert.equal(creatorOf(main.world), null)

  // A name is not identity. Mallory calls herself Kromit and signs in with her own verified account.
  mallory = member('mallory', 'Kromit')
  as(mallory)('member.saveProfile', { displayName: 'Kromit', bio: 'Anthony, creator of Allworld', expectedRevision: as(mallory)('member.me', {}).profile.revision, look: { body: 'm08', skin: null, outfitHue: 0, height: 1, face: null } })
  onboard(as(mallory))
  const hers = accountMemberId(principal('mallory'))
  main.world.scoped(() => ensureMember(main.world, hers, 'Kromit'))
  assert.equal(main.creator.signedIn(principal('mallory')), false)
  // Nor is a principal that was not made by the hosted bridge, one for another channel, or one that has lapsed.
  const copied = { ...principal('creator') }
  rejects('unauthorized', () => main.creator.signedIn(copied as VerifiedPrincipal), /verified Goalmatic sign-in/)
  rejects('unauthorized', () => main.creator.signedIn(JSON.parse(JSON.stringify(principal('creator'))) as VerifiedPrincipal))
  rejects('forbidden', () => main.creator.signedIn(principal('creator', { channel: 'store' })))
  assert.equal(main.creator.signedIn(principal('creator', { expiresAt: now })), false)
  assert.equal(creatorOf(main.world), null)
  assert.equal(as(ada)('member.public', { memberId: mallory }).member.verified, undefined)
  assert.deepEqual(slicesHolding('"tagged":').concat(slicesHolding('"auto":')), [])
})

check('3 the creator plays as a guest, claims, and is bound to that same member; waiting members are welcomed in bounded steps; self, blocked and ended are left out', () => {
  // The creator's own character, made the way anyone's is.
  kromitGuest = newGuest()
  const made = asGuest(kromitGuest)
  made('member.saveProfile', { displayName: 'Kromit', bio: 'Anthony, creator of Allworld', expectedRevision: made('member.me', {}).profile.revision, look: { body: 'm04', skin: null, outfitHue: 20, height: 1, face: null } })
  arrive(made)
  onboard(made)
  K = kromitGuest.id

  // Others who are in the world before the creator is known.
  bayo = member('bayo', 'Bayo')
  onboard(as(bayo))
  as(bayo)('member.block', { memberId: K })
  ended = newGuest()
  onboard(asGuest(ended))
  main.guests.revoke({ token: ended.token, source: src() })
  nobody = member('nobody', 'Not onboarded')
  fola = member('fola', 'Fola')
  main.world.scoped(() => addFriendship(main.world, fola, K))
  onboard(as(fola))
  for (let n = 0; n < 60; n++) { const one = member(`crowd${n}`, `Crowd ${n}`); onboard(as(one)); crowd.push(one) }

  // The claim: no character stood in its way, and the account now plays as the guest's member.
  const claim = main.guests.claim({ token: kromitGuest.token, principal: principal('creator'), source: src() })
  assert.deepEqual([claim.outcome, claim.outcome === 'claimed' && claim.memberId], ['claimed', K])
  assert.equal(main.creator.signedIn(principal('creator')), true)
  assert.equal(main.creator.signedIn(principal('creator')), true, 'signing in again changes nothing')
  assert.deepEqual([main.creator.status().ready, main.creator.status().memberId, creatorOf(main.world)], [true, K, K])
  assert.equal(main.creator.signedIn(principal('mallory')), false)
  assert.equal(main.creator.status().welcomed, 0, 'binding delivers nothing by itself')

  // The Friends directory before anything is delivered: the creator has the one friend he accepted, Ada has none.
  assert.deepEqual([directory(K).ids, directory(K).total, directory(ada).ids, directory(ada).total], [[fola], 1, [], 0])

  // Catching up is bounded: 25 welcomes a tick. The creator's real friends list and count grow with it,
  // one entry per member (Fola, already his friend, is welcomed and still counted once).
  const eligible = [ada, early.id, mallory, accountMemberId(principal('mallory')), fola, ...crowd].length - 1
  main.world.tick()
  assert.deepEqual([main.creator.status().welcomed, directory(K).total, directory(K).ids.length], [25, 25, 25])
  main.world.tick()
  assert.deepEqual([main.creator.status().welcomed, directory(K).total], [50, 50])
  for (let guard = 0; main.creator.status().scanning; guard++) { assert.ok(guard < 10); main.world.tick() }
  // Mallory's account member exists but never onboarded, so it is not among them.
  assert.equal(main.creator.status().welcomed, eligible)
  assert.equal(main.creator.catchUp(), 0)

  // Both sides see it in `friends.list`: real members, each once, marked as made automatically.
  const his = directory(K), hers = directory(ada)
  assert.deepEqual([his.total, his.ids.length, new Set(his.ids).size], [eligible, eligible, eligible])
  assert.deepEqual([...his.ids].sort(), [ada, early.id, mallory, fola, ...crowd].sort())
  assert.deepEqual(his.friends.filter(friend => friend.automatic !== 'creator').map(friend => friend.id), [fola], 'only the friend he accepted is unmarked')
  assert.ok(his.friends.every(friend => friend.relation === 'friend' && friend.verified === undefined))
  assert.deepEqual([hers.total, hers.friends.map(friend => [friend.id, friend.relation, friend.automatic, friend.verified, friend.online])], [1, [[K, 'friend', 'creator', 'creator', false]]])
  assert.deepEqual([directory(early.id, asGuest(early)).ids, directory(early.id, asGuest(early)).total], [[K], 1], 'a guest’s friends list shows him too')
  assert.deepEqual(as(ada)('around.get', {}).around.friends.map(friend => [friend.member.id, friend.member.automatic, friend.where.hidden]), [[K, 'creator', true]])

  // What a waiting member finds: one thread, from the verified creator, marked automatic, unread.
  const [thread] = threads(as(ada))
  assert.equal(threads(as(ada)).length, 1)
  assert.deepEqual([thread!.peer.id, thread!.peer.verified, thread!.peer.displayName, thread!.unread, thread!.canSend], [K, 'creator', 'Kromit', 1, true])
  assert.deepEqual([thread!.last?.from, thread!.last?.automatic, thread!.last?.text], [K, 'welcome', WELCOME])
  assert.deepEqual(messagesIn(as(ada), thread!.id).map(message => [message.seq, message.from, message.automatic]), [[1, K, 'welcome']])
  const card = as(ada)('creator.card', {}).creator
  assert.deepEqual([card.ready, card.member?.id, card.member?.verified, card.link, card.conversationId, card.hangout], [true, K, 'creator', 'automatic', thread!.id, null])
  assert.deepEqual([friendTag(main.world, ada, K), areFriends(main.world, ada, K)], ['creator', false])
  assert.equal(welcomesFor(asGuest(early)), 1, 'a guest who was waiting is welcomed too')

  // Nothing says the creator is here: he is not connected, and the thread shows that.
  assert.deepEqual([thread!.peer.online, thread!.peerWhere.state, thread!.peerWhere.hidden], [false, 'offline', true])

  // Left out: the creator himself, the member who blocked him, the guest whose session ended, the one not onboarded.
  assert.equal(friendTag(main.world, K, K), null)
  assert.deepEqual([as(K)('creator.card', {}).creator.link, as(K)('creator.card', {}).creator.welcomedAt], ['self', null])
  assert.deepEqual(threads(as(K)), [], 'the creator’s list is not filled with his own automatic messages')
  for (const out of [K, bayo, ended.id, nobody, accountMemberId(principal('mallory'))]) assert.ok(!his.ids.includes(out), 'nobody left out is in his friends list')
  assert.deepEqual([threads(as(bayo)), as(bayo)('creator.card', {}).creator.link, as(bayo)('creator.card', {}).creator.member, directory(bayo).total], [[], 'removed', null, 0])
  assert.equal(friendTag(main.world, ended.id, K), null)
  assert.deepEqual([threads(as(nobody)), as(nobody)('creator.card', {}).creator.link, directory(nobody).total], [[], 'none', 0])
  // Fola was already his friend: still exactly that, with the welcome in their conversation and no tag.
  assert.deepEqual([areFriends(main.world, fola, K), friendTag(main.world, fola, K), welcomesFor(as(fola)), as(fola)('creator.card', {}).creator.link], [true, null, 1, 'friend'])

  // The impostor was welcomed like anyone, and is still nobody's creator.
  assert.equal(as(ada)('member.public', { memberId: mallory }).member.verified, undefined)
  assert.equal(as(mallory)('creator.card', {}).creator.member?.id, K)
})

check('4 in the game and nowhere else: no inbox entry, nothing queued for email, WhatsApp or push, and the welcome is stored in one place', () => {
  assert.deepEqual(slicesHolding('welcome to Allworld'), ['direct'])
  const notify = saved().notify as { deliveries: unknown[] }
  assert.deepEqual(notify.deliveries, [])
  for (const memberId of [ada, fola, crowd[0]!, crowd[59]!]) {
    assert.deepEqual(as(memberId)('notify.list', { includeRead: true }).notifications.filter(note => note.kind === 'direct.message'), [])
    assert.deepEqual(as(memberId)('notify.deliveries', {}).deliveries, [])
  }
  // A connected member's App is told there is a message, as for any message; nobody is told the creator came online.
  const watching = listen(crowd[1]!)
  const late = member('late', 'Late')
  const lateLink = listen(late)
  onboard(as(late))
  const told = lateLink.events.filter(event => event.type === 'direct.message')
  assert.equal(told.length, 1)
  assert.ok(told[0]!.type === 'direct.message' && told[0]!.message.automatic === 'welcome' && told[0]!.unread === 1)
  listen(K)
  assert.deepEqual([...watching.events, ...lateLink.events].filter(event => event.type === 'friend.online'), [])
  main.world.disconnect(main.world.connect(K, () => {}, () => {}))
})

// ── 5 Once ──

check('5 once per member: onboarding again, signing in again, ticks, a restart, a changed message and a lost save all leave one welcome', () => {
  const lateId = 'm_probe_late' as MemberId
  assert.equal(welcomesFor(as(lateId)), 1, 'a member who onboards after the binding is welcomed in that same operation')
  const count = main.creator.status().welcomed
  for (let n = 0; n < 3; n++) onboard(as(ada))
  main.creator.signedIn(principal('creator'))
  for (let n = 0; n < 5; n++) { now += SECOND; main.world.tick() }
  assert.deepEqual([welcomesFor(as(ada)), main.creator.status().welcomed], [1, count])

  restart()
  assert.deepEqual([main.creator.status().ready, main.creator.status().memberId, main.creator.status().scanning], [true, K, true])
  for (let guard = 0; main.creator.status().scanning; guard++) { assert.ok(guard < 10); main.world.tick() }
  assert.deepEqual([welcomesFor(as(ada)), welcomesFor(as(fola)), main.creator.status().welcomed], [1, 1, count])

  // The wording changes (a hangout is configured). Nobody is sent it again; the next new member gets the new one.
  restart({ ...CREATOR, hangout: { name: 'Bodija Market', areaLabel: 'Bodija, Ibadan' } })
  for (let guard = 0; main.creator.status().scanning; guard++) { assert.ok(guard < 10); main.world.tick() }
  assert.deepEqual([welcomesFor(as(ada)), main.creator.status().welcomed], [1, count])
  const newer = member('newer', 'Newer')
  onboard(as(newer))
  assert.equal(threads(as(newer))[0]!.last?.text, `${WELCOME} There is a public hangout in the game at Bodija Market in Bodija, Ibadan.`)
  assert.deepEqual(as(newer)('creator.card', {}).creator.hangout, { name: 'Bodija Market', areaLabel: 'Bodija, Ibadan' })
  // The place in the message is the configured one only: the creator's own character is in Ibadan and the default says nothing of it.
  assert.ok(!WELCOME.includes('Ibadan') && !WELCOME.includes('hangout'))
  assert.throws(() => registerCreator(createWorld({ now: () => now }), { guests: main.guests, config: { ...CREATOR, hangout: { name: '', areaLabel: null } } }), /short place name/)
  restart()

  // The service stops before a welcome is saved. On disk the member had not onboarded; doing it again welcomes them once.
  const lost = member('lost', 'Lost')
  const onDisk = JSON.stringify(saved())
  onboard(as(lost))
  assert.equal(welcomesFor(as(lost)), 1)
  store = memoryStore(onDisk)
  main = open(store, CREATOR)
  assert.deepEqual([threads(as(lost)), main.creator.status().welcomed], [[], count + 1])
  onboard(as(lost))
  for (let n = 0; n < 3; n++) main.world.tick()
  assert.deepEqual([welcomesFor(as(lost)), main.creator.status().welcomed], [1, count + 2])
})

// ── 6 Privacy ──

/** Fixture bytes in the shape of a face scan. Not a photograph of anyone. */
const scan = { texture: `data:image/jpeg;base64,${Buffer.alloc(48, 7).toString('base64')}`, mesh: Buffer.alloc(FACE_LANDMARKS * 6).toString('base64') }

check('6 listed as a friend, and that is all it shares: photo face, home, area, whereabouts, the way to someone, invitations, moods and friend challenges stay closed both ways', () => {
  arrive(as(ada))
  as(ada)('room.enter', { ref: { kind: 'district', districtId: ibadan.arrivalDistrict }, pos: { x: 0, z: 0 }, heading: 0 })
  listen(ada)
  for (const who of [ada, K]) {
    const { profile } = as(who)('member.me', {})
    as(who)('member.setFace', { scan, audience: 'friends', look: profile.look, expectedRevision: profile.revision })
  }
  const adaHome = as(ada)('home.get', { homeId: null }).home, kromitHome = as(K)('home.get', { homeId: null }).home
  assert.deepEqual([adaHome.policy, kromitHome.policy], ['friends', 'friends'])

  for (const [viewer, target, home] of [[K, ada, adaHome], [ada, K, kromitHome]] as const) {
    const seen = as(viewer)('member.public', { memberId: target }).member
    // Both have a fresh area on record and neither is discoverable: an accepted friend would be shown it.
    assert.ok(as(target)('member.me', {}).profile.currentArea)
    assert.deepEqual([seen.relation, seen.automatic, seen.look.face, seen.areaLabel], ['friend', 'creator', null, null], 'a friend by the directory, marked automatic, with no photo face and no area')
    rejects('not_found', () => as(viewer)('member.face', { memberId: target, version: as(target)('member.me', {}).profile.look.face!.version }))
    rejects('forbidden', () => as(viewer)('home.get', { homeId: home.id }), /private/)
    rejects('forbidden', () => as(viewer)('room.enter', { ref: { kind: 'home', homeId: home.id }, pos: { x: 0, z: 0 }, heading: 0 }), /private/)
    assert.ok(!as(viewer)('home.visitable', {}).homes.some(entry => entry.homeId === home.id))
    const where = threads(as(viewer)).find(thread => thread.peer.id === target)?.peerWhere ?? as(viewer)('direct.open', { memberId: target }).conversation.peerWhere
    assert.deepEqual([where.hidden, where.areaLabel, where.venueName, where.canJoin, where.lastSeenAt, where.sameCity], [true, null, null, false, null, null], 'online or offline, and nothing more')
    rejects('forbidden', () => as(viewer)('around.wayToFriend', { memberId: target }), /only go to friends/)
    rejects('forbidden', () => as(viewer)('join.send', { to: target, place: 'here', note: '' }), /only invite friends/)
    rejects('forbidden', () => as(viewer)('wave.send', { to: target }))
    rejects('forbidden', () => as(viewer)('life.peek', { memberId: target }), /Only friends/)
    rejects('forbidden', () => as(viewer)('arena.create', { game: 'chess', opponent: { kind: 'friend', memberId: target }, timeControl: '5+0', rated: false, audience: 'players', communityId: null }))
    // Listed, in the directory and among the friends around, with only online or offline to say.
    const listed = directory(viewer).friends.find(friend => friend.id === target)
    assert.deepEqual([listed?.automatic, listed?.look.face, listed?.areaLabel], ['creator', null, null])
    // The creator's "friends around" holds his newest fifty such friends, so Ada (the first) is not among them; he is in hers.
    const around = as(viewer)('around.get', {}).around.friends
    assert.ok(around.length <= 51 && around.filter(friend => friend.member.automatic).every(friend => friend.where.hidden && friend.where.areaLabel === null && !friend.where.canJoin))
    assert.equal(around.some(friend => friend.member.id === target), viewer === ada)
  }

  // A friendship both accepted is what it always was: Fola sees the creator's photo face, area, home and whereabouts.
  const friend = as(fola)('member.public', { memberId: K }).member
  assert.deepEqual([friend.relation, friend.automatic, friend.look.face?.audience, friend.verified, friend.areaLabel], ['friend', undefined, 'friends', 'creator', ibadan.label])
  assert.equal(as(fola)('member.face', { memberId: K, version: friend.look.face!.version }).scan.mesh, scan.mesh)
  assert.equal(as(fola)('home.get', { homeId: kromitHome.id }).home.id, kromitHome.id)
  assert.equal(threads(as(fola))[0]!.peerWhere.hidden, false)
  assert.equal(as(fola)('friends.list', {}).friends[0]!.id, K)
})

// ── 7 The thread ──

let adaThread!: Ops['direct.get']['in']['conversationId']

check('7 the thread works like any conversation, and the automatic mark and the badge cannot be asked for', () => {
  adaThread = threads(as(ada))[0]!.id
  assert.equal(as(ada)('direct.read', { conversationId: adaThread, upTo: 1 }).unread, 0)
  const forged = { conversationId: adaThread, text: 'Thanks! One idea: more games.', clientId: 'a1', automatic: 'welcome', auto: 'welcome', from: K, verified: 'creator' }
  const reply = as(ada)('direct.send', forged as never).message
  assert.deepEqual([reply.from, reply.automatic, reply.seq], [ada, undefined, 2])
  // The creator now sees this thread, among the many he never wrote in himself, and answers as himself.
  assert.deepEqual(threads(as(K)).map(thread => [thread.peer.id, thread.unread]), [[ada, 1]])
  const answer = as(K)('direct.send', { conversationId: adaThread, text: 'Noted, thank you.', clientId: 'k1' }).message
  assert.deepEqual([answer.from, answer.automatic], [K, undefined])
  assert.deepEqual(messagesIn(as(ada), adaThread).map(message => [message.from, message.automatic ?? null]), [[K, 'welcome'], [ada, null], [K, null]])

  // Mallory, who took the name, has no badge, no way to Ada, and cannot mark her own messages.
  rejects('forbidden', () => as(mallory)('direct.open', { memberId: ada }), /between friends/)
  const yemi = member('yemi', 'Yemi')
  main.world.scoped(() => addFriendship(main.world, mallory, yemi))
  const theirs = as(mallory)('direct.open', { memberId: yemi }).conversation.id
  as(mallory)('direct.send', { conversationId: theirs, text: WELCOME, clientId: 'm1', automatic: 'welcome' } as never)
  const seen = messagesIn(as(yemi), theirs)[0]!
  assert.deepEqual([seen.text, seen.automatic, threads(as(yemi))[0]!.peer.verified, threads(as(yemi))[0]!.peer.displayName], [WELCOME, undefined, undefined, 'Kromit'])
  assert.deepEqual(saved().creator && Object.keys(saved().creator as object).sort(), ['account', 'boundAt', 'removed', 'welcomed'])
  assert.ok(!JSON.stringify(saved().creator).includes('account-creator') && !JSON.stringify(saved().creator).includes('subject-creator'), 'the saved world holds a digest of the creator account, not its ids')
})

// ── 8 Removing and blocking ──

check('8 removing or blocking the creator is remembered and never undone by the service; becoming friends the usual way is still open', () => {
  const [remover, blocker, dropped] = [crowd[2]!, crowd[3]!, crowd[4]!]
  const thread = threads(as(remover))[0]!.id
  const count = main.creator.status().welcomed

  const before = directory(K)
  assert.ok([remover, blocker, dropped].every(who => before.ids.includes(who)))
  assert.deepEqual(as(remover)('friends.remove', { memberId: K }), { friends: [], total: 0 })
  assert.deepEqual([directory(K).total, directory(K).ids.includes(remover)], [before.total - 1, false], 'gone from the creator’s list and count as well')
  // (Bayo blocked the creator before anyone was bound; the block itself keeps him out, so this is the first recorded.)
  assert.deepEqual([friendTag(main.world, remover, K), as(remover)('creator.card', {}).creator.link, main.creator.status().removed], [null, 'removed', 1])
  // The history stays readable; nothing new is sent either way.
  assert.deepEqual([messagesIn(as(remover), thread).length, threads(as(remover))[0]!.canSend], [1, false])
  rejects('forbidden', () => as(remover)('direct.send', { conversationId: thread, text: 'hello', clientId: 'r1' }), /no longer friends/)
  rejects('forbidden', () => as(K)('direct.send', { conversationId: thread, text: 'hello', clientId: 'k2' }))

  as(blocker)('member.block', { memberId: K })
  assert.deepEqual([threads(as(blocker)), as(blocker)('creator.card', {}).creator.link, as(blocker)('creator.card', {}).creator.member], [[], 'removed', null])
  as(blocker)('member.unblock', { memberId: K })
  // The creator may remove someone too. That is also final.
  as(K)('friends.remove', { memberId: dropped })

  for (const who of [remover, blocker, dropped]) onboard(as(who))
  main.creator.signedIn(principal('creator'))
  restart()
  for (let guard = 0; main.creator.status().scanning; guard++) { assert.ok(guard < 10); main.world.tick() }
  for (const who of [remover, blocker, dropped]) assert.deepEqual([friendTag(main.world, who, K), as(who)('creator.card', {}).creator.link, directory(who).total, directory(who).ids], [null, 'removed', 0, []])
  assert.deepEqual([welcomesFor(as(remover)), welcomesFor(as(dropped)), threads(as(blocker)), main.creator.status().welcomed, main.creator.status().removed], [1, 1, [], count, 3])
  const after = directory(K)
  assert.deepEqual([after.total, after.ids.length, [remover, blocker, dropped].some(who => after.ids.includes(who))], [before.total - 3, before.total - 3, false], 'still absent from his list after the restart')

  // An introduction the creator accepts makes them friends like any two members. No second welcome.
  const { intro } = as(remover)('intro.send', { to: K, note: 'I changed my mind.' })
  as(K)('intro.respond', { introId: intro.id, accept: true })
  assert.deepEqual([areFriends(main.world, remover, K), friendTag(main.world, remover, K), as(remover)('creator.card', {}).creator.link], [true, null, 'friend'])
  assert.equal(as(remover)('direct.send', { conversationId: thread, text: 'Hello again.', clientId: 'r2' }).message.seq, 2)
  assert.equal(welcomesFor(as(remover)), 1)
  assert.deepEqual(directory(remover).friends.map(friend => [friend.id, friend.automatic]), [[K, undefined]], 'listed again, as a friend he accepted')
  assert.deepEqual([directory(K).total, directory(K).friends.find(friend => friend.id === remover)?.automatic], [before.total - 2, undefined])

  // A member still connected automatically may ask for the same. Accepted, the pair is one friendship, counted once,
  // and now shares what friends share.
  const upgraded = crowd[5]!
  arrive(as(upgraded))
  assert.deepEqual([as(K)('member.public', { memberId: upgraded }).member.automatic, as(K)('member.public', { memberId: upgraded }).member.areaLabel], ['creator', null])
  as(K)('intro.respond', { introId: as(upgraded)('intro.send', { to: K, note: '' }).intro.id, accept: true })
  const seen = as(K)('member.public', { memberId: upgraded }).member
  assert.deepEqual([seen.relation, seen.automatic, seen.areaLabel, friendTag(main.world, upgraded, K)], ['friend', undefined, ibadan.label, null])
  assert.deepEqual([directory(K).total, directory(K).ids.filter(id => id === upgraded).length, directory(upgraded).total], [before.total - 2, 1, 1])
})

// ── 9 Guests ──

check('9 a guest reads and answers the creator thread and can remove or block him, and reaches no other member or conversation whatever the request says', () => {
  const gina = newGuest()
  arrive(asGuest(gina))
  onboard(asGuest(gina))
  const play = asGuest(gina)
  const [thread] = threads(play)
  assert.deepEqual([threads(play).length, thread!.peer.id, thread!.peer.verified, thread!.unread, thread!.canSend], [1, K, 'creator', 1, true])
  assert.deepEqual(messagesIn(play, thread!.id).map(message => message.automatic), ['welcome'])
  assert.equal(play('direct.read', { conversationId: thread!.id, upTo: 1 }).unread, 0)
  assert.equal(play('direct.open', { memberId: K }).conversation.id, thread!.id)
  assert.equal(play('direct.send', { conversationId: thread!.id, text: 'Hi Kromit, I am just looking around.', clientId: 'g1' }).message.seq, 2)
  assert.ok(threads(as(K)).some(entry => entry.peer.id === gina.id && entry.unread === 1), 'the creator gets the guest’s reply')
  assert.deepEqual([play('creator.card', {}).creator.link, play('creator.card', {}).creator.conversationId], ['automatic', thread!.id])
  // The guest's Friends directory is real too: the creator, once, marked automatic. And the guest is in his.
  assert.deepEqual([directory(gina.id, play).total, directory(gina.id, play).friends.map(friend => [friend.id, friend.automatic, friend.verified])], [1, [[K, 'creator', 'creator']]])
  assert.equal(directory(K).friends.find(friend => friend.id === gina.id)?.automatic, 'creator')

  // Everything else that names a member or a conversation. Each request passes the shared policy as text;
  // the service refuses it because its own records say the target is not this guest's creator thread.
  const yemi = 'm_probe_yemi' as MemberId
  const others = as(mallory)('direct.open', { memberId: yemi }).conversation.id
  const attempts: [OpName, object][] = [
    ['direct.get', { conversationId: adaThread, before: null }], ['direct.read', { conversationId: adaThread, upTo: 3 }],
    ['direct.send', { conversationId: adaThread, text: 'hello', clientId: 'g2' }],
    ['direct.get', { conversationId: others, before: null, creator: true, verified: 'creator', peer: K }],
    ['direct.send', { conversationId: others, text: 'hello', clientId: 'g3', creator: true, to: K }],
    ['direct.get', { conversationId: '__proto__', before: null }], ['direct.get', { conversationId: 'dm_abcdefghijkl', before: null }],
    ['direct.open', { memberId: ada }], ['direct.open', { memberId: mallory }], ['direct.open', { memberId: gina.id }],
    ['friends.remove', { memberId: ada }], ['friends.remove', { memberId: mallory }],
  ]
  for (const [op, input] of attempts) {
    assert.equal(guestAccess(op, input).allowed, true, op)
    rejects('forbidden', () => play(op, input as never), /Save your character to an account/)
  }
  assert.equal(messagesIn(as(ada), adaThread).length, 3, 'nothing was added to anyone else’s thread')
  // The rest of messaging and discovery is as closed as it was, the creator as a target included.
  for (const [op, input] of [
    ['chat.send', { text: 'hello', clientId: 'c1' }], ['wave.send', { to: K }], ['intro.send', { to: K, note: '' }], ['join.send', { to: K, place: 'here', note: '' }],
    ['direct.readAll', {}], ['direct.report', { conversationId: thread!.id, reason: 'spam', detail: '' }], ['around.get', {}], ['nearby.list', {}], ['intro.list', {}],
  ] as [OpName, object][]) {
    assert.equal(guestAccess(op, input).allowed, false, op)
    rejects('forbidden', () => play(op, input as never))
  }
  // Over a connection.
  const link = listen(gina.id)
  main.guests.receive(link.connection, gina.actor, { t: 'req', id: 1, op: 'direct.send', input: { conversationId: adaThread, text: 'hello', clientId: 'g4' } })
  main.guests.receive(link.connection, gina.actor, { t: 'req', id: 2, op: 'direct.get', input: { conversationId: thread!.id, before: null } })
  const answers = link.frames.filter(frame => frame.t === 'res')
  assert.deepEqual(answers.map(frame => frame.t === 'res' && [frame.id, frame.ok]), [[1, false], [2, true]])

  // Claiming keeps the member, the thread and the coins, and brings no second welcome.
  const coins = balance(play)
  assert.equal(main.guests.claim({ token: gina.token, principal: principal('gina'), source: src() }).outcome, 'claimed')
  for (let n = 0; n < 3; n++) main.world.tick()
  onboard(as(gina.id))
  assert.deepEqual(messagesIn(as(gina.id), thread!.id).map(message => [message.from, message.automatic ?? null]), [[K, 'welcome'], [gina.id, null]])
  assert.deepEqual([welcomesFor(as(gina.id)), balance(as(gina.id)), coins, friendTag(main.world, gina.id, K)], [1, TRAVEL.startingCoins, TRAVEL.startingCoins, 'creator'])
  assert.deepEqual([directory(gina.id).ids, directory(gina.id).total, directory(K).ids.filter(id => id === gina.id).length], [[K], 1, 1], 'one friendship before and after the claim')
  assert.equal(as(gina.id)('travel.state', {}).ledger.filter(entry => entry.kind === 'starting').length, 1)

  // A guest who wants no part of it: one removes, one blocks. Neither is connected again.
  const leaver = newGuest(), blocker = newGuest()
  for (const guest of [leaver, blocker]) onboard(asGuest(guest))
  const left = threads(asGuest(leaver))[0]!.id
  assert.deepEqual(asGuest(leaver)('friends.remove', { memberId: K }).friends, [])
  assert.deepEqual([asGuest(leaver)('creator.card', {}).creator.link, messagesIn(asGuest(leaver), left).length], ['removed', 1])
  rejects('forbidden', () => asGuest(leaver)('direct.send', { conversationId: left, text: 'hello', clientId: 'l1' }), /no longer friends/)
  assert.equal(asGuest(blocker)('member.block', { memberId: K }).blocked.length, 1)
  assert.deepEqual(threads(asGuest(blocker)), [])
  for (const guest of [leaver, blocker]) onboard(asGuest(guest))
  main.world.tick()
  assert.deepEqual([friendTag(main.world, leaver.id, K), friendTag(main.world, blocker.id, K), welcomesFor(asGuest(leaver))], [null, null, 1])
  assert.deepEqual([directory(leaver.id, asGuest(leaver)).total, directory(blocker.id, asGuest(blocker)).total, directory(K).ids.some(id => id === leaver.id || id === blocker.id)], [0, 0, false])
})

// ── 10 The binding ──

check('10 the binding is to one verified account: configured for another, the feature waits; turned off, it does nothing; the wrong account cannot take it over', () => {
  const count = main.creator.status().welcomed
  restart({ account: { accountId: 'account-other', subjectId: 'subject-other' } })
  assert.deepEqual([main.creator.status().ready, as(ada)('creator.card', {}).creator.ready], [false, false])
  const meanwhile = member('meanwhile', 'Meanwhile')
  onboard(as(meanwhile))
  main.world.tick()
  assert.deepEqual(threads(as(meanwhile)), [])
  const other = accountMemberId(principal('other'))
  main.world.scoped(() => ensureMember(main.world, other, 'Goalmatic member'))
  rejects('conflict', () => main.creator.signedIn(principal('other')), /different account/)
  assert.equal(creatorOf(main.world), K)

  restart(null)
  const quiet = member('quiet', 'Quiet')
  onboard(as(quiet))
  main.world.tick()
  assert.deepEqual([threads(as(quiet)), as(quiet)('creator.card', {}).creator.ready, main.creator.status().enabled], [[], false, false])
  assert.equal(messagesIn(as(ada), adaThread).length, 3, 'what was already said stays readable')

  // Configured for the creator again: the two who onboarded in between are found and welcomed once.
  restart()
  for (let guard = 0; main.creator.status().scanning; guard++) { assert.ok(guard < 10); main.world.tick() }
  assert.deepEqual([welcomesFor(as(meanwhile)), welcomesFor(as(quiet)), main.creator.status().welcomed, main.creator.status().memberId], [1, 1, count + 2, K])
  now += 40 * DAY
  main.world.tick()
  assert.equal(main.creator.status().welcomed, count + 2)
})

check('11 a creator who signs in without ever being a guest: bound and welcoming, and removable only if the hosted member id fits the service’s id format', () => {
  const direct = open(memoryStore(), CREATOR)
  const creatorId = accountMemberId(principal('creator'))
  // What the hosted hello does: the account's own member, made at sign-in.
  direct.world.scoped(() => ensureMember(direct.world, creatorId, 'Kromit'))
  assert.equal(direct.creator.signedIn(principal('creator')), true)
  const player = 'm_probe_player' as MemberId
  direct.world.scoped(() => ensureMember(direct.world, player, 'Player'))
  direct.world.call(player, 'member.completeOnboarding', {})
  direct.world.tick()
  assert.equal(direct.creator.status().ready, false, 'a verified account still finishes its character before welcoming players')
  assert.deepEqual(direct.world.call(player, 'direct.list', {}).conversations, [])
  direct.world.call(creatorId, 'member.completeOnboarding', {})
  direct.world.tick()
  const [thread] = direct.world.call(player, 'direct.list', {}).conversations
  assert.deepEqual([thread!.peer.id, thread!.peer.verified, thread!.last?.automatic], [creatorId, 'creator', 'welcome'])
  assert.equal(direct.world.call(player, 'direct.send', { conversationId: thread!.id, text: 'Hello.', clientId: 'p1' }).message.seq, 2)
  // Removing and blocking name the creator by member id, and every operation checks an id's shape first.
  const fits = /^m_[a-z0-9_-]{3,40}$/.test(creatorId)
  if (fits) {
    direct.world.call(player, 'friends.remove', { memberId: creatorId })
    assert.equal(direct.world.call(player, 'creator.card', {}).creator.link, 'removed')
  } else {
    rejects('invalid', () => direct.world.call(player, 'friends.remove', { memberId: creatorId }), /not a valid id/)
    rejects('invalid', () => direct.world.call(player, 'member.block', { memberId: creatorId }), /not a valid id/)
    assert.equal(direct.world.call(player, 'creator.card', {}).creator.link, 'automatic')
  }
  console.log(`     the hosted account member id is ${creatorId.length} characters: ${fits ? 'it fits, and a player can remove or block this creator' : 'too long for the id parser, so a player CANNOT remove or block a creator who signed in this way'}`)
})

check('12 a creator with more friends than a list should carry: the count is exact, the list holds every accepted friend and the newest 500 others, and nothing reads every member to build it', () => {
  const big = open(memoryStore(), CREATOR)
  const creatorId = accountMemberId(principal('creator'))
  big.world.scoped(() => ensureMember(big.world, creatorId, 'Kromit'))
  assert.equal(big.creator.signedIn(principal('creator')), true)
  big.world.call(creatorId, 'member.completeOnboarding', {})
  const old = 'm_probe_oldfriend' as MemberId
  big.world.scoped(() => { ensureMember(big.world, old, 'Old friend'); addFriendship(big.world, old, creatorId) })
  const made: MemberId[] = []
  for (let n = 0; n < 520; n++) {
    const one = `m_probe_n${n}` as MemberId
    big.world.scoped(() => ensureMember(big.world, one, `Member ${n}`))
    big.world.call(one, 'member.completeOnboarding', {})
    made.push(one)
  }
  const { friends, total } = big.world.call(creatorId, 'friends.list', {})
  assert.deepEqual([total, friends.length, new Set(friends.map(friend => friend.id)).size], [521, FRIENDS_AUTOMATIC_LISTED + 1, FRIENDS_AUTOMATIC_LISTED + 1])
  const listed = new Set(friends.map(friend => friend.id))
  assert.ok(listed.has(old) && made.slice(20).every(one => listed.has(one)) && made.slice(0, 20).every(one => !listed.has(one)), 'his accepted friend and the newest 500')
  assert.equal(big.world.call(creatorId, 'around.get', {}).around.friends.length, 51)
  assert.deepEqual(big.world.call(made[0]!, 'friends.list', {}).friends.map(friend => friend.id), [creatorId], 'a member not in his list still has him in theirs')
  // The lists come from the two members' own records: both records hold the friendship.
  const saved = big.world.peek<{ members: Record<string, { tagged?: Record<string, string> }> }>('members')!.members
  assert.deepEqual([Object.keys(saved[creatorId]!.tagged ?? {}).length, saved[made[0]!]!.tagged], [520, { [creatorId]: 'creator' }])
  assert.equal(big.world.call(made[0]!, 'friends.remove', { memberId: creatorId }).total, 0)
  assert.deepEqual([big.world.call(creatorId, 'friends.list', {}).total, Object.keys(saved[creatorId]!.tagged ?? {}).length], [520, 519])
})

if (!failed) console.log('ALL PASS')
