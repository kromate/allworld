// Evidence probe for guest play and later claim: in-process worlds, a controllable clock, plain
// asserts, and a saved world held as text in memory the way it would sit on disk. No server, no
// network, no account: the one hosted sign-in below runs the real adapter against an answer made
// in this file. Checks 15–19 play real chess through the hall between guests and accounts.
// Run: node scripts/verify-guest.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { ARENA } from '../src/shared/arena.ts'
import type { ArenaDetail, ArenaMatch, ArenaMatchId } from '../src/shared/arena.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { GUEST, GUEST_MATCH_OPS, GUEST_OPS, GUEST_RECOVERY_NOTICE, GUEST_TOKEN_PATTERN, guestAccess, guestMayEnterMatch, isGuestToken } from '../src/shared/guest.ts'
import type { GuestGroup, GuestScope } from '../src/shared/guest.ts'
import { WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode } from '../src/shared/model.ts'
import type { OpName, Ops, ServerFrame } from '../src/shared/protocol.ts'
import { TRAVEL } from '../src/shared/travel.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { accountMemberId, principalFromHosted, registerGuests, scopeFromHosted } from '../service/guests.ts'
import type { GuestActor, GuestService, GuestServiceOptions, VerifiedPrincipal } from '../service/guests.ts'
import { createHostedIdentityAdapter } from '../service/hostedIdentity.ts'
import type { HostedActor, HostedBinding, HostedSubject } from '../service/hostedIdentity.ts'
import { LOCAL_ACTORS, actorForToken } from '../service/identity.ts'
import { createWorld } from '../service/index.ts'
import { registerCreator } from '../service/creator.ts'
import type { Persistence, World } from '../service/kernel.ts'
import { DEFAULT_LOOK, ensureMember, exists, reportCount } from '../service/members.ts'

const SECOND = 1000, HOUR = 3_600_000, DAY = 86_400_000
let now = Date.UTC(2026, 9, 2, 12)

// Fixture ids. `.invalid` never resolves, and nothing here is ever asked to.
const binding: HostedBinding = {
  siteId: 'site-probe', packageId: 'cli-probe', channel: 'test', buildId: 'build-1', artifactId: 'artifact-1',
  audience: 'https://world.probe.invalid', origin: 'https://app.probe.invalid',
}
const TEST = scopeFromHosted(binding)
const STORE: GuestScope = { ...TEST, channel: 'store' }

/** A saved world held as text. */
interface TextStore extends Persistence { text(): string }
function memoryStore(initial: string | null = null): TextStore {
  let saved = initial
  return {
    load: () => (saved === null ? null : JSON.parse(saved) as Record<string, unknown>),
    save: state => { saved = JSON.stringify(state) },
    text: () => saved ?? '',
  }
}
interface Service { world: World; guests: GuestService }
function open(from: TextStore, scope: GuestScope = TEST, options: Partial<GuestServiceOptions> = {}): Service {
  const world = createWorld({ now: () => now, persistence: from })
  const guests = registerGuests(world, scope, { entry: 'open', ...options })
  // No creator is configured in this probe: the feature is off (scripts/verify-creator.ts turns it on).
  registerCreator(world, null)
  return { world, guests }
}
let store = memoryStore()
let main = open(store)
/** Stop the service cleanly and start it again from what it saved. */
function restart(): void { main.world.flush(); main = open(store) }
const savedText = (): string => { main.world.flush(); return store.text() }
/** A guest record's state as saved, or undefined when the saved world has no such record. */
const savedState = (memberId: MemberId): string | undefined =>
  (JSON.parse(savedText()) as { guests: { guests: Record<string, { state: string } | undefined> } }).guests.guests[memberId]?.state

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
let sources = 0
/** A caller nobody has seen before, so one check's attempts do not count against the next. */
const src = (): string => `caller-${++sources}`

/** What the hosted bridge hands over after it has verified a sign-in. */
function subject(account: string, overrides: Partial<HostedSubject> = {}): HostedSubject {
  return { ...binding, subjectId: `subject-${account}`, accountId: `account-${account}`, installationId: 'installation-probe', expiresAt: now + 30_000, ...overrides }
}
const principal = (account: string, overrides: Partial<HostedSubject> = {}): VerifiedPrincipal => principalFromHosted(subject(account, overrides))

/** The real hosted adapter, end to end, with the App host's answer made here. Nothing leaves the process. */
async function hostedSignIn(account: string): Promise<HostedActor> {
  const adapter = createHostedIdentityAdapter(binding, {
    redeemUrl: `${binding.origin}/api/app-runtime/service-identity/redeem`, now: () => now,
    fetch: async () => new Response(JSON.stringify(subject(account, { expiresAt: now + 20_000 }))),
  })
  try {
    const { challengeId } = adapter.challenge(binding.origin)
    const { token } = await adapter.exchange({ origin: binding.origin, challengeId, code: `gmc_${'c'.repeat(43)}` })
    return adapter.consume(token, binding.origin)
  } finally { adapter.close() }
}

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

interface Guest { token: string; actor: GuestActor; id: MemberId }
function newGuest(guests: GuestService = main.guests): Guest {
  const { session, actor } = guests.issue({ source: src() })
  return { token: session.token, actor, id: actor.memberId }
}
type Caller = <K extends OpName>(op: K, input: Ops[K]['in']) => Ops[K]['out']
/** The guest's way in: capability, then policy, then the operation. */
const asGuest = (guest: Guest): Caller => (op, input) => main.guests.call(guest.actor, op, input)
/** An account member's way in, once the hosted sign-in has said who they are. */
const asMember = (memberId: MemberId): Caller => (op, input) => main.world.call(memberId, op, input)

const ibadan: CoarseArea = areaFromPlace({ label: 'Bodija, Ibadan', countryCode: 'NG', anchor: { lat: 7.4352, lon: 3.914 } })
const arrive = (call: Caller): void => { call('member.setCurrentArea', { area: ibadan, source: 'manual' }) }
/** One full work shift: five correct answers. Takes 40 seconds of world time. */
function workShift(call: Caller): void {
  now += 35 * SECOND
  let { shift } = call('work.start', { workplaceId: 'corner-cafe', venueName: null })
  while (shift.status === 'active') {
    now += SECOND
    shift = call('work.answer', { shiftId: shift.id, index: shift.current!.index, handed: [...shift.current!.wants] }).shift
  }
  assert.equal(shift.status, 'completed')
}
/** Everything a claim must leave exactly as it was. */
const progress = (call: Caller) => ({ profile: call('member.me', {}).profile, travel: call('travel.state', {}), career: call('work.career', {}).career })
const balance = (call: Caller): number => call('travel.state', {}).state.balance
const startingGrants = (call: Caller): number => call('travel.state', {}).ledger.filter(entry => entry.kind === 'starting').length

function connect(memberId: MemberId) {
  const frames: ServerFrame[] = []
  let closes = 0
  const connection = main.world.connect(memberId, frame => { frames.push(frame) }, () => { closes++ })
  return { connection, frames, closes: () => closes }
}
const answerTo = (frames: ServerFrame[], id: number) => frames.find(frame => frame.t === 'res' && frame.id === id)

let ada!: Guest
let adaAccount!: MemberId

// ── 1–3 The capability ──

check('1 play as guest: an opaque capability, a real member, no account, no test actor, only a hash at rest', () => {
  const { session, actor } = main.guests.issue({ source: src() })
  ada = { token: session.token, actor, id: actor.memberId }
  assert.match(session.token, GUEST_TOKEN_PATTERN)
  assert.ok(isGuestToken(session.token))
  assert.equal(Buffer.from(session.token.slice(4), 'base64url').length, 32, '256 random bits')
  assert.deepEqual([session.status.state, session.status.memberId, actor.guest, actor.reviewer], ['guest', actor.memberId, true, false])
  assert.match(actor.memberId, /^m_guest_[a-z0-9]{20}$/)
  assert.equal(Date.parse(session.status.expiresAt), now + GUEST.idleDays * DAY)
  assert.equal(Date.parse(session.status.endsAt), now + GUEST.maxDays * DAY)
  const me = asGuest(ada)('member.me', {})
  assert.deepEqual([me.profile.displayName, me.profile.onboardedAt, me.reviewer], ['Guest', null, false])
  assert.deepEqual(me.profile.look, DEFAULT_LOOK)
  assert.equal(balance(asGuest(ada)), 0, 'no coins before the first arrival')

  const other = newGuest()
  assert.notEqual(other.token, ada.token)
  assert.notEqual(other.id, ada.id)

  // Not a local test actor, and none was made on the way.
  assert.equal(actorForToken(ada.token), null)
  assert.ok(!LOCAL_ACTORS.some(local => local.memberId === ada.id || exists(main.world, local.memberId)))

  const text = savedText()
  assert.ok(!text.includes(ada.token) && !text.includes(ada.token.slice(4)), 'the capability is not in the saved world')
  assert.ok(text.includes(sha256(ada.token)), 'its SHA-256 is')
  assert.match(GUEST_RECOVERY_NOTICE, /cannot be recovered/)
})

check('2 a wrong, guessed, mangled or oversized capability proves nothing; attempts are limited per caller', () => {
  const guessed = `gst_${randomBytes(32).toString('base64url')}`
  const wrong: unknown[] = [
    guessed, ada.token.slice(0, -1), `${ada.token}A`, ada.token.toUpperCase(), ` ${ada.token}`, ada.token.slice(4),
    sha256(ada.token), ada.id, 'local.abcdefgh', '', null, undefined, 42, { token: ada.token }, [ada.token], `gst_${'A'.repeat(200_000)}`,
  ]
  for (const token of wrong) {
    rejects('unauthorized', () => main.guests.resume({ token, source: src() }), /^This guest session is not valid\./)
    rejects('unauthorized', () => main.guests.claim({ token, principal: principal('thief'), source: src() }))
    rejects('unauthorized', () => main.guests.revoke({ token, source: src() }))
  }
  assert.equal(main.guests.memberFor(principal('thief')), accountMemberId(principal('thief')), 'nothing was claimed')
  // Knowing who a guest is (the member id is public) is not holding their capability.
  rejects('unauthorized', () => main.guests.call({ ...ada.actor, memberId: 'm_guest_aaaaaaaaaaaaaaaaaaaa' as MemberId }, 'member.me', {}))
  assert.equal(main.guests.resume({ token: ada.token, source: src() }).actor.memberId, ada.id, 'the right one still works')

  for (let n = 0; n < GUEST.attempts.perSource; n++) rejects('unauthorized', () => main.guests.resume({ token: guessed, source: 'hammer' }))
  rejects('rate_limited', () => main.guests.resume({ token: ada.token, source: 'hammer' }))
  rejects('rate_limited', () => main.guests.claim({ token: ada.token, principal: principal('thief'), source: 'hammer' }))
  assert.equal(main.guests.resume({ token: ada.token, source: src() }).actor.memberId, ada.id, 'another caller is not held up')
  now += GUEST.attempts.windowMs
  assert.equal(main.guests.resume({ token: ada.token, source: 'hammer' }).actor.memberId, ada.id)
  assert.throws(() => main.guests.issue({ source: '' }), /rate key/, 'the transport must say who is asking')
})

check('3 wrong scope or channel: a test capability is nothing to a Store service, a sign-in for another App, site, package or channel cannot claim, and entry is closed unless a host opens it', () => {
  // A Store service pointed at the test world's saved state by mistake.
  const misplaced = open(memoryStore(savedText()), STORE)
  rejects('unauthorized', () => misplaced.guests.resume({ token: ada.token, source: src() }))
  rejects('unauthorized', () => misplaced.guests.claim({ token: ada.token, principal: principal('ada', { channel: 'store' }), source: src() }))
  rejects('unauthorized', () => misplaced.guests.revoke({ token: ada.token, source: src() }))
  rejects('unauthorized', () => misplaced.guests.assertActive(ada.actor))
  assert.equal(misplaced.guests.status(ada.id), null)
  assert.deepEqual([misplaced.guests.counts().foreign, misplaced.guests.counts().active], [2, 2], 'the operator can see the records are not this service’s')

  // A separate Store world, as it should be: each has never heard of the other's guests.
  const shop = open(memoryStore(), STORE)
  rejects('unauthorized', () => shop.guests.resume({ token: ada.token, source: src() }))
  const shopper = newGuest(shop.guests)
  rejects('unauthorized', () => main.guests.resume({ token: shopper.token, source: src() }))

  // On the test service, a verified sign-in that is for somewhere else.
  for (const elsewhere of [{ channel: 'store' }, { siteId: 'site-other' }, { packageId: 'cli-other' }, { audience: 'https://other.probe.invalid' }] as Partial<HostedSubject>[]) {
    rejects('forbidden', () => main.guests.claim({ token: ada.token, principal: principal('ada', elsewhere), source: src() }), /different App or channel/)
    rejects('forbidden', () => main.guests.memberFor(principal('ada', elsewhere)))
  }
  rejects('forbidden', () => shop.guests.claim({ token: shopper.token, principal: principal('ada'), source: src() }), /different App or channel/)
  assert.equal(main.guests.status(ada.id)?.state, 'guest', 'still a guest, still unclaimed')
  assert.equal(main.guests.memberFor(principal('ada')), accountMemberId(principal('ada')))
  assert.throws(() => registerGuests(main.world, TEST, { entry: 'open' }), /registered twice/)

  // Guest entry is a decision about a host. Where it is closed nobody new gets in; a guest who exists is still served.
  assert.throws(() => registerGuests(createWorld({ now: () => now }), TEST, {} as GuestServiceOptions), /open or closed/)
  const closed = open(memoryStore(savedText()), TEST, { entry: 'closed' })
  rejects('forbidden', () => closed.guests.issue({ source: src() }), /not open here/)
  assert.equal(closed.guests.resume({ token: ada.token, source: src() }).actor.memberId, ada.id)
  assert.equal(closed.guests.counts().active, 2)
  restart()
})

// ── 4–5 Playing as a guest ──

check('4 a guest explores, customises, works and practises, and the progress is theirs', () => {
  const play = asGuest(ada)
  const { profile } = play('member.me', {})
  const saved = play('member.saveProfile', {
    displayName: 'Ada of Bodija', bio: 'Trying the town.', expectedRevision: profile.revision,
    look: { body: 'm08', skin: '#8d5524', outfitHue: 40, height: 1.04, face: null },
  }).profile
  assert.deepEqual([saved.displayName, saved.look.body, saved.look.skin, saved.look.outfitHue, saved.look.height], ['Ada of Bodija', 'm08', '#8d5524', 40, 1.04])
  arrive(play)
  assert.equal(balance(play), TRAVEL.startingCoins)
  play('member.completeOnboarding', {})
  assert.equal(play('room.enter', { ref: { kind: 'district', districtId: ibadan.arrivalDistrict }, pos: { x: 0, z: 0 }, heading: 0 }).snapshot.ref.kind, 'district')
  assert.equal(play('room.move', { pos: { x: 1, z: 1 }, heading: 0, moving: true }).accepted, true)
  workShift(play)
  workShift(play)
  const career = play('work.career', {}).career
  assert.equal(career.shifts.completed, 2)
  assert.ok(career.points > TRAVEL.startingCoins)
  assert.equal(balance(play), career.points)
  // Practice: a game against the computer with nobody watching, and a run of one's own.
  const { match } = play('arena.create', { game: 'chess', opponent: { kind: 'computer', level: 1 }, timeControl: '5+0', rated: false, audience: 'players', communityId: null })
  assert.deepEqual([match.rated, match.audience, match.players.some(player => player.computer === 1)], [false, 'players', true])
  play('arena.resign', { matchId: match.id })
  assert.equal(typeof play('dash.begin', { matchId: null }).attempt.attemptToken, 'string')
  assert.equal(play('member.savePreferences', { preferences: { ...saved.preferences, units: 'imperial' } }).profile.preferences.units, 'imperial')
})

check('5 what a guest may not do is refused by the service before any handler runs, whatever the window sends', () => {
  const registered = main.world.registered()
  for (const group of Object.keys(GUEST_OPS) as GuestGroup[]) for (const op of GUEST_OPS[group]) assert.ok(registered.includes(op), `${op} is a real operation`)

  // Every operation the policy does not open, called with an input its parser would reject:
  // "forbidden" rather than "invalid" (or a result) shows the request never reached the operation.
  const garbage = { probe: true }
  let refused = 0
  for (const op of registered) {
    const access = guestAccess(op, garbage)
    if (access.allowed) continue
    rejects('forbidden', () => main.guests.call(ada.actor, op as OpName, garbage as never), /Save your character to an account/)
    refused++
  }
  assert.ok(refused > 100 && registered.length - refused <= Object.values(GUEST_OPS).flat().length)
  console.log(`     ${refused} of ${registered.length} operations are closed to a guest; ${registered.length - refused} are open`)

  const play = asGuest(ada)
  const gates: [OpName, unknown, string][] = [
    ['chat.send', { text: 'hello', clientId: 'c1' }, 'messaging'], ['direct.readAll', {}, 'messaging'], ['wave.send', { to: ada.id }, 'messaging'],
    ['intro.send', { to: ada.id, note: '' }, 'social'], ['nearby.list', {}, 'social'], ['community.list', {}, 'social'],
    ['market.sellerApply', { name: 'Stall', about: '', areaLabel: 'Ibadan' }, 'marketplace'], ['market.catalog', { category: null, query: '', savedOnly: false }, 'marketplace'],
    ['application.mine', {}, 'application'], ['listing.list', { kind: null, mine: false }, 'application'],
    ['direct.report', { conversationId: 'dc_abcdefghijkl', reason: 'spam', detail: '' }, 'moderation'], ['market.sellerQueue', {}, 'moderation'],
    ['match.list', {}, 'competition'], ['arena.standings', { game: 'chess', scope: 'global', view: 'rating', communityId: null }, 'competition'],
    ['arena.live', { game: null }, 'competition'], ['arena.setPrivacy', { publicStandings: true }, 'competition'], ['arena.chat', { matchId: 'am_abcdefghijkl', text: 'hello', clientId: 'c1' }, 'messaging'],
    ['notify.setConsent', { channel: 'email', granted: true, destination: 'guest@probe.invalid' }, 'account'], ['member.setFace', {}, 'account'],
  ]
  for (const [op, input, gate] of gates) {
    const access = guestAccess(op, input)
    assert.deepEqual([access.allowed, access.allowed ? null : access.gate], [false, gate], op)
    rejects('forbidden', () => play(op, input as never))
  }

  // Open operations with a condition: the input decides.
  const preferences = play('member.me', {}).profile.preferences
  rejects('forbidden', () => play('member.savePreferences', { preferences: { ...preferences, discoverable: true } }), /meet and find other people/)
  assert.equal(play('member.me', {}).profile.preferences.discoverable, false)
  const casual = { game: 'chess', timeControl: '5+0', rated: false, audience: 'players', communityId: null } as const
  assert.deepEqual(guestAccess('arena.create', { ...casual, opponent: { kind: 'queue' } }), { allowed: true, group: 'play' }, 'a casual game from the queue is open')
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'queue' }, rated: true }), /find a casual match.*rated games/)
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'queue' }, rated: 'false' as never }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'queue' }, audience: 'anyone' }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'queue' }, audience: 'community', communityId: 'c_abcdefghijkl' as never }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'queue' }, communityId: 'c_abcdefghijkl' as never }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'friend', memberId: ada.id } }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'community', communityId: 'c_abcdefghijkl' as never } }))
  rejects('forbidden', () => play('arena.create', { ...casual, opponent: { kind: 'computer', level: 1 }, audience: 'anyone' }))
  rejects('forbidden', () => play('dash.begin', { matchId: 'mt_abcdefghijkl' as never }))
  rejects('forbidden', () => play('room.enter', { ref: { kind: 'table', matchId: 'mt_abcdefghijkl' as never }, pos: { x: 0, z: 0 }, heading: 0 }))

  // Reporting and blocking need no account. The report is written, and held to the limit every member has.
  const resident = 'm_probe_resident' as MemberId
  main.world.scoped(() => ensureMember(main.world, resident, 'Resident'))

  // The creator thread is the one conversation a guest may have. This world has no creator, so there is none:
  // the request alone passes the shared policy, and the service refuses it from its own records.
  assert.deepEqual([play('creator.card', {}).creator.ready, play('direct.list', {}).conversations], [false, []])
  for (const [op, input] of [
    ['direct.open', { memberId: resident }], ['friends.remove', { memberId: resident }], ['direct.get', { conversationId: 'dm_abcdefghijkl', before: null }],
    ['direct.send', { conversationId: 'dm_abcdefghijkl', text: 'hello', clientId: 'c1' }], ['direct.read', { conversationId: 'dm_abcdefghijkl', upTo: 1 }],
  ] as [OpName, object][]) {
    assert.equal(guestAccess(op, input).allowed, true, op)
    rejects('forbidden', () => play(op, input as never), /Save your character to an account/)
  }
  const reports = reportCount(main.world)
  assert.deepEqual(play('member.report', { memberId: resident, reason: 'spam', detail: 'probe', room: null }), { received: true })
  assert.equal(reportCount(main.world), reports + 1)
  rejects('not_found', () => play('member.report', { memberId: 'm_probe_nobody' as MemberId, reason: 'spam', detail: '', room: null }))
  rejects('invalid', () => play('member.report', { memberId: resident, reason: 'because' as never, detail: '', room: null }))
  for (let n = 0; n < 3; n++) play('member.report', { memberId: resident, reason: 'harassment', detail: 'probe', room: null })
  rejects('rate_limited', () => play('member.report', { memberId: resident, reason: 'spam', detail: 'probe', room: null }))
  assert.equal(reportCount(main.world), reports + 4, 'five tries in ten minutes, as for any member')
  assert.equal(play('member.block', { memberId: resident }).blocked.length, 1)
  assert.equal(play('member.unblock', { memberId: resident }).blocked.length, 0)

  // Over a connection: the refused request is answered, nobody nearby hears anything, and the guest plays on.
  const neighbour = connect(resident)
  main.world.call(resident, 'room.enter', { ref: { kind: 'district', districtId: ibadan.arrivalDistrict }, pos: { x: 2, z: 2 }, heading: 0 })
  const link = connect(ada.id)
  main.guests.receive(link.connection, ada.actor, { t: 'req', id: 1, op: 'room.enter', input: { ref: { kind: 'district', districtId: ibadan.arrivalDistrict }, pos: { x: 0, z: 0 }, heading: 0 } })
  main.guests.receive(link.connection, ada.actor, { t: 'req', id: 2, op: 'chat.send', input: { text: 'hello', clientId: 'c1' } })
  main.guests.receive(link.connection, ada.actor, { t: 'req', id: 3, op: 'member.me', input: {} })
  main.guests.receive(link.connection, ada.actor, { t: 'ping' })
  main.world.tick()
  assert.deepEqual(answerTo(link.frames, 1), { ...answerTo(link.frames, 1), ok: true })
  assert.deepEqual(answerTo(link.frames, 2), { t: 'res', id: 2, ok: false, code: 'forbidden', message: 'As a guest you can message the creator. Save your character to an account to talk to other people.' })
  assert.deepEqual(answerTo(link.frames, 3), { ...answerTo(link.frames, 3), ok: true })
  assert.ok(link.frames.some(frame => frame.t === 'pong'))
  assert.equal(link.closes(), 0, 'a refused operation does not end the session')
  assert.ok(neighbour.frames.some(frame => frame.t === 'event' && frame.event.type === 'presence.join'), 'the neighbour sees the guest arrive')
  assert.ok(!neighbour.frames.some(frame => frame.t === 'event' && frame.event.type === 'chat.message'), 'and hears nothing from them')
  assert.throws(() => main.guests.receive(neighbour.connection, ada.actor, { t: 'ping' }), /does not belong/)

  // Someone who is not a guest is not touched by any of this.
  assert.equal(main.guests.isGuest(resident), false)
  main.guests.assertAllowed(resident, 'chat.send', {})
  assert.equal(main.world.call(resident, 'chat.send', { text: 'Good afternoon', clientId: 'c2' }).message.text, 'Good afternoon')
})

// ── 6–9 Claiming ──

check('6 a claim needs both the capability and a sign-in the service verified itself; a principal from a request is refused', () => {
  rejects('unauthorized', () => main.guests.claim({ token: null, principal: principal('ada'), source: src() }))
  const real = principal('ada')
  const copies: unknown[] = [
    { ...TEST, accountId: 'account-ada', subjectId: 'subject-ada', expiresAt: now + 30_000 }, JSON.parse(JSON.stringify(real)), structuredClone(real), { ...real }, null, 'account-ada',
  ]
  for (const copy of copies) {
    rejects('unauthorized', () => main.guests.claim({ token: ada.token, principal: copy as VerifiedPrincipal, source: src() }), /verified Goalmatic sign-in is required/)
    rejects('unauthorized', () => main.guests.memberFor(copy as VerifiedPrincipal))
  }
  rejects('expired', () => main.guests.claim({ token: ada.token, principal: principal('ada', { expiresAt: now }), source: src() }), /sign-in has expired/)
  assert.equal(main.guests.status(ada.id)?.state, 'guest')
  assert.equal(main.guests.memberFor(real), accountMemberId(real), 'the account has no character yet')
  assert.ok(!savedText().includes('"owners":{"'), 'no ownership was written')
})

check('7 claim: the same member, avatar and progress now belong to the account, and the old capability has no authority', () => {
  const link = connect(ada.id)
  const before = progress(asGuest(ada))
  const result = main.guests.claim({ token: ada.token, principal: principal('ada'), source: src() })
  assert.deepEqual(result, { outcome: 'claimed', memberId: ada.id, claimedAt: new Date(now).toISOString(), repeated: false })
  adaAccount = main.guests.memberFor(principal('ada'))
  assert.equal(adaAccount, ada.id, 'the account now signs in as the guest’s member')
  assert.deepEqual(progress(asMember(adaAccount)), before, 'profile, look, location, documents, coins, ledger and career are untouched')
  assert.deepEqual([before.profile.displayName, before.profile.look.body, before.career.shifts.completed], ['Ada of Bodija', 'm08', 2])

  // Arriving again as the account grants nothing: the starting coins went to this character once.
  arrive(asMember(adaAccount))
  assert.equal(balance(asMember(adaAccount)), before.travel.state.balance)
  assert.equal(startingGrants(asMember(adaAccount)), 1)

  // The old capability, in every place it could be presented.
  rejects('unauthorized', () => main.guests.resume({ token: ada.token, source: src() }), /saved to an account/)
  rejects('unauthorized', () => main.guests.assertActive(ada.actor))
  rejects('unauthorized', () => main.guests.call(ada.actor, 'member.me', {}))
  rejects('unauthorized', () => main.guests.revoke({ token: ada.token, source: src() }))
  main.guests.receive(link.connection, ada.actor, { t: 'req', id: 9, op: 'member.me', input: {} })
  assert.deepEqual(answerTo(link.frames, 9), { t: 'res', id: 9, ok: false, code: 'unauthorized', message: 'This character was saved to an account. Sign in to carry on with it.' })
  assert.ok(link.frames.some(frame => frame.t === 'denied') && link.closes() === 1, 'the guest connection is told and closed')
  assert.equal(main.guests.revokeMember(ada.id, 'probe'), false, 'a claimed character cannot be revoked as a guest')
  assert.equal(main.guests.memberFor(principal('ada')), ada.id)

  // No longer a guest: the account can do what guests cannot.
  assert.deepEqual([main.guests.isGuest(ada.id), main.guests.status(ada.id)], [false, null])
  main.guests.assertAllowed(ada.id, 'chat.send', {})
  assert.ok(Array.isArray(asMember(adaAccount)('nearby.list', {}).members))
  const text = savedText()
  assert.ok(!text.includes('account-ada') && !text.includes('subject-ada'), 'the saved world holds a digest of the account, not its ids')
  assert.ok(text.includes(accountMemberId(principal('ada'))))
})

check('8 the same claim again is the same answer and changes nothing; the old capability gives nobody else anything', () => {
  const before = progress(asMember(adaAccount))
  const first = savedText()
  for (let n = 0; n < 3; n++) {
    const again = main.guests.claim({ token: ada.token, principal: principal('ada'), source: src() })
    assert.deepEqual([again.outcome, again.outcome === 'claimed' && again.memberId, again.outcome === 'claimed' && again.repeated], ['claimed', ada.id, true])
  }
  assert.equal(savedText(), first, 'a repeated claim writes nothing')
  assert.deepEqual(progress(asMember(adaAccount)), before)
  assert.equal(startingGrants(asMember(adaAccount)), 1)
  // Someone else who got hold of the old capability and has their own verified account.
  rejects('unauthorized', () => main.guests.claim({ token: ada.token, principal: principal('bayo'), source: src() }), /^This guest session is not valid\./)
  assert.equal(main.guests.memberFor(principal('bayo')), accountMemberId(principal('bayo')))
  assert.equal(main.guests.memberFor(principal('ada')), ada.id)

  // After a day the old capability is not even remembered. The claim is.
  now += GUEST.claimRetryHours * HOUR
  main.world.tick()
  assert.ok(!savedText().includes(sha256(ada.token)))
  rejects('unauthorized', () => main.guests.claim({ token: ada.token, principal: principal('ada'), source: src() }))
  assert.equal(main.guests.memberFor(principal('ada')), ada.id)
  assert.equal(balance(asMember(adaAccount)), before.travel.state.balance)
})

let second!: Guest

check('9 an account that already has a character gets an explicit conflict: nothing merged, nothing granted, nothing overwritten', () => {
  second = newGuest()
  const play = asGuest(second)
  arrive(play)
  workShift(play)
  const guestBefore = progress(play), adaBefore = progress(asMember(adaAccount))
  const text = savedText()

  // (a) The account that claimed Ada tries to claim a second guest.
  const clash = main.guests.claim({ token: second.token, principal: principal('ada'), source: src() })
  assert.equal(clash.outcome, 'conflict')
  assert.ok(clash.outcome === 'conflict')
  assert.deepEqual(clash.choices, ['use-saved', 'keep-guest'])
  assert.deepEqual([clash.existing.memberId, clash.existing.displayName, clash.existing.look.body, clash.existing.look.face, clash.existing.onboarded], [ada.id, 'Ada of Bodija', 'm08', null, true])
  assert.equal(savedText(), text, 'a conflict writes nothing')
  assert.equal(main.guests.memberFor(principal('ada')), ada.id, 'the account keeps the character it had')
  assert.deepEqual(progress(asMember(adaAccount)), adaBefore)
  assert.equal(adaBefore.travel.state.balance + guestBefore.travel.state.balance > adaBefore.travel.state.balance, true)
  assert.deepEqual([startingGrants(asMember(adaAccount)), startingGrants(play)], [1, 1])

  // (b) An account that signed in directly before and so already has its own member.
  const chidi = accountMemberId(principal('chidi'))
  main.world.scoped(() => ensureMember(main.world, chidi, 'Goalmatic member'))
  arrive(asMember(chidi))
  const chidiBefore = progress(asMember(chidi))
  const taken = main.guests.claim({ token: second.token, principal: principal('chidi'), source: src() })
  assert.ok(taken.outcome === 'conflict')
  assert.deepEqual([taken.existing.memberId, taken.existing.displayName, taken.existing.onboarded], [chidi, 'Goalmatic member', false])
  assert.equal(main.guests.memberFor(principal('chidi')), chidi)
  assert.deepEqual(progress(asMember(chidi)), chidiBefore)
  assert.equal(chidiBefore.travel.state.balance, TRAVEL.startingCoins)

  // "Keep playing as a guest": the capability still works and the guest's progress is as it was.
  assert.equal(main.guests.resume({ token: second.token, source: src() }).actor.memberId, second.id)
  assert.deepEqual(progress(play), guestBefore)
  assert.equal(main.guests.isGuest(second.id), true)
  // And an account with no character can still claim it afterwards.
  const kept = main.guests.claim({ token: second.token, principal: principal('dayo'), source: src() })
  assert.deepEqual([kept.outcome, kept.outcome === 'claimed' && kept.memberId, kept.outcome === 'claimed' && kept.repeated], ['claimed', second.id, false])
  assert.deepEqual(progress(asMember(second.id)), guestBefore)
})

// ── 10–12 Expiry, revocation, bounds ──

check('10 capabilities expire: unused after 30 days, and 90 days after issue however often they are used', () => {
  const idle = newGuest()
  const issuedAt = now
  now = issuedAt + 29 * DAY
  assert.equal(Date.parse(main.guests.resume({ token: idle.token, source: src() }).status.expiresAt), now + GUEST.idleDays * DAY, 'coming back moves the expiry')
  now += GUEST.idleDays * DAY - SECOND
  assert.equal(main.guests.status(idle.id)?.state, 'guest')
  now += SECOND
  // No tick has run: the expiry is seen the moment the capability is presented.
  rejects('expired', () => main.guests.resume({ token: idle.token, source: src() }), /cannot be recovered/)
  rejects('expired', () => main.guests.resume({ token: idle.token, source: src() }))
  rejects('expired', () => main.guests.assertActive(idle.actor))
  rejects('expired', () => main.guests.call(idle.actor, 'member.me', {}))
  rejects('expired', () => main.guests.claim({ token: idle.token, principal: principal('efe'), source: src() }))
  assert.equal(main.guests.memberFor(principal('efe')), accountMemberId(principal('efe')), 'an expired guest cannot be claimed')
  assert.equal(main.guests.status(idle.id), null)

  const regular = newGuest()
  const born = now
  for (const day of [20, 40, 60, 80]) { now = born + day * DAY; main.guests.resume({ token: regular.token, source: src() }) }
  assert.equal(Date.parse(main.guests.status(regular.id)!.expiresAt), born + GUEST.maxDays * DAY, 'the expiry never moves past the end')
  now = born + GUEST.maxDays * DAY - SECOND
  main.guests.resume({ token: regular.token, source: src() })
  now += SECOND
  rejects('expired', () => main.guests.resume({ token: regular.token, source: src() }))

  // Nobody presents this one: the tick ends it, and a month later forgets the record. The member's data stays.
  const silent = newGuest()
  arrive(asGuest(silent))
  assert.equal(savedState(silent.id), 'active')
  now += GUEST.idleDays * DAY
  main.world.tick()
  assert.equal(savedState(silent.id), 'expired')
  assert.equal(savedState(regular.id), undefined, 'a record that ended a month ago has been dropped')
  now += GUEST.recordKeptDays * DAY
  main.world.tick()
  assert.equal(savedState(silent.id), undefined)
  assert.ok(!savedText().includes(sha256(silent.token)), 'and its capability hash with it')
  rejects('unauthorized', () => main.guests.resume({ token: silent.token, source: src() }))
  assert.ok(exists(main.world, silent.id), 'nothing of the member was deleted')
  assert.equal(main.guests.isGuest(silent.id), true, 'and it is still not an account member')
  rejects('forbidden', () => main.guests.assertAllowed(silent.id, 'chat.send', {}))
  assert.equal(main.guests.memberFor(principal('ada')), ada.id, 'claims are kept for good')
})

check('11 revocation: by the guest or by an operator, at once, and never against a claimed character', () => {
  const leaving = newGuest()
  const link = connect(leaving.id)
  assert.deepEqual(main.guests.revoke({ token: leaving.token, source: src() }), { revoked: true })
  rejects('unauthorized', () => main.guests.resume({ token: leaving.token, source: src() }))
  rejects('unauthorized', () => main.guests.assertActive(leaving.actor))
  rejects('unauthorized', () => main.guests.claim({ token: leaving.token, principal: principal('femi'), source: src() }))
  main.guests.receive(link.connection, leaving.actor, { t: 'req', id: 4, op: 'member.me', input: {} })
  assert.deepEqual([answerTo(link.frames, 4)?.t === 'res' && answerTo(link.frames, 4), link.closes()], [{ t: 'res', id: 4, ok: false, code: 'unauthorized', message: 'This guest session is not valid. Start again as a guest, or sign in.' }, 1])
  assert.deepEqual(main.guests.revoke({ token: leaving.token, source: src() }), { revoked: true }, 'asking again is harmless')
  assert.ok(!savedText().includes(leaving.token))

  const removed = newGuest()
  assert.equal(main.guests.revokeMember(removed.id, 'probe: operator decision'), true)
  assert.equal(main.guests.revokeMember(removed.id, 'probe: operator decision'), false)
  rejects('unauthorized', () => main.guests.resume({ token: removed.token, source: src() }))
  rejects('unauthorized', () => main.guests.call(removed.actor, 'member.me', {}))
  assert.equal(main.guests.revokeMember('m_probe_resident' as MemberId, 'probe'), false)
  assert.equal(main.guests.revokeMember(ada.id, 'probe'), false)
  assert.equal(main.guests.memberFor(principal('ada')), ada.id)
})

check('12 bounds: a full world and a busy caller are refused, and room comes back when a guest ends', () => {
  const small = open(memoryStore(), TEST, { maxActive: 3 })
  const held = [newGuest(small.guests), newGuest(small.guests), newGuest(small.guests)]
  rejects('unavailable', () => small.guests.issue({ source: src() }), /full right now/)
  small.guests.revoke({ token: held[0]!.token, source: src() })
  const next = newGuest(small.guests)
  rejects('unavailable', () => small.guests.issue({ source: src() }))
  now += GUEST.idleDays * DAY
  assert.equal(small.guests.issue({ source: src() }).session.status.state, 'guest', 'expired guests make room without a tick')
  rejects('expired', () => small.guests.resume({ token: next.token, source: src() }))
  // Three expired just now; the one revoked a month ago has been dropped.
  assert.deepEqual(small.guests.counts(), { active: 1, claimed: 0, ended: 3, foreign: 0, capacity: 3 })

  const busy = open(memoryStore())
  for (let n = 0; n < GUEST.issue.perSource; n++) busy.guests.issue({ source: 'one-caller' })
  rejects('rate_limited', () => busy.guests.issue({ source: 'one-caller' }))
  for (let n = GUEST.issue.perSource; n < GUEST.issue.overall; n++) busy.guests.issue({ source: src() })
  rejects('rate_limited', () => busy.guests.issue({ source: src() }))
  assert.equal(busy.guests.counts().active, GUEST.issue.overall)
  now += GUEST.issue.overallWindowMs
  assert.equal(busy.guests.issue({ source: src() }).session.status.state, 'guest')
  restart()
})

// ── 13–14 Restarts, and the real hosted sign-in ──

check('13 restart recovery: guests, claims, conflicts and revocations are as they were, and a claim lost in a crash is claimed once', () => {
  const tunde = newGuest()
  const play = asGuest(tunde)
  play('member.saveProfile', { displayName: 'Tunde', bio: '', expectedRevision: play('member.me', {}).profile.revision, look: { body: 'f06', skin: null, outfitHue: -30, height: 0.96, face: null } })
  arrive(play)
  workShift(play)
  const gone = newGuest()
  main.guests.revoke({ token: gone.token, source: src() })
  const before = progress(play), adaBefore = progress(asMember(adaAccount)), counts = main.guests.counts()

  restart()
  assert.deepEqual(main.guests.counts(), counts)
  assert.equal(main.guests.resume({ token: tunde.token, source: src() }).actor.memberId, tunde.id, 'the same capability reaches the same guest')
  assert.deepEqual(progress(asGuest(tunde)), before)
  assert.equal(main.guests.memberFor(principal('ada')), ada.id, 'the claim survived')
  assert.equal(main.guests.memberFor(principal('dayo')), second.id)
  assert.deepEqual(progress(asMember(adaAccount)), adaBefore)
  rejects('unauthorized', () => main.guests.resume({ token: ada.token, source: src() }))
  rejects('unauthorized', () => main.guests.resume({ token: gone.token, source: src() }))
  rejects('forbidden', () => asGuest(tunde)('chat.send', { text: 'hello', clientId: 'c3' }))
  assert.equal(main.guests.claim({ token: tunde.token, principal: principal('ada'), source: src() }).outcome, 'conflict')

  // The service stops between a claim and its save. What was on disk is the world before the claim.
  const onDisk = savedText()
  assert.equal(main.guests.claim({ token: tunde.token, principal: principal('tunde'), source: src() }).outcome, 'claimed')
  store = memoryStore(onDisk)
  main = open(store)
  assert.equal(main.guests.memberFor(principal('tunde')), accountMemberId(principal('tunde')), 'the unsaved claim is gone, whole')
  assert.equal(main.guests.resume({ token: tunde.token, source: src() }).actor.memberId, tunde.id, 'so the capability still works')
  const retried = main.guests.claim({ token: tunde.token, principal: principal('tunde'), source: src() })
  assert.deepEqual([retried.outcome, retried.outcome === 'claimed' && retried.memberId, retried.outcome === 'claimed' && retried.repeated], ['claimed', tunde.id, false])
  assert.deepEqual(progress(asMember(tunde.id)), before)
  assert.deepEqual([startingGrants(asMember(tunde.id)), balance(asMember(tunde.id))], [1, before.travel.state.balance])
  const again = main.guests.claim({ token: tunde.token, principal: principal('tunde'), source: src() })
  assert.ok(again.outcome === 'claimed' && again.repeated)
  restart()
  assert.equal(main.guests.memberFor(principal('tunde')), tunde.id)
  assert.equal(balance(asMember(tunde.id)), before.travel.state.balance)
})

const hosted = await hostedSignIn('hosted')

check('14 the real hosted adapter: its verified subject claims a guest, and sign-in must then ask memberFor', () => {
  const verified = principalFromHosted(hosted.subject)
  assert.deepEqual(main.guests.scope, scopeFromHosted(binding))
  assert.equal(accountMemberId(verified), hosted.memberId, 'the same member id the adapter derives')
  const guest = newGuest()
  arrive(asGuest(guest))
  const result = main.guests.claim({ token: guest.token, principal: verified, source: src() })
  assert.deepEqual([result.outcome, result.outcome === 'claimed' && result.memberId], ['claimed', guest.id])
  assert.equal(main.guests.memberFor(verified), guest.id)
  assert.notEqual(hosted.memberId, guest.id, 'the adapter’s own id would open an empty second member')
  assert.ok(!exists(main.world, hosted.memberId))
  assert.equal(balance(asMember(main.guests.memberFor(verified))), TRAVEL.startingCoins)
})

// ── 15–19 Playing together before claiming ──

/** "Find a match" as a guest may ask for it: unrated, only the players, no community. */
const CASUAL = { game: 'chess', opponent: { kind: 'queue' }, timeControl: '5+0', rated: false, audience: 'players', communityId: null } as const
/** Fool's mate: four legal moves, and the second player has won. */
const FOOLS_MATE: [seat: number, from: string, to: string][] = [[0, 'f2', 'f3'], [1, 'e7', 'e5'], [0, 'g2', 'g4'], [1, 'd8', 'h4']]
/** How each player reaches the service: a guest through the guest service, an account as a member. */
const players = new Map<MemberId, Caller>()
const links = new Map<MemberId, ReturnType<typeof connect>>()
function playToMate(match: ArenaMatch): ArenaDetail {
  const bySeat = match.players.map(player => players.get(player.member!.id)!)
  let last!: ArenaDetail
  FOOLS_MATE.forEach(([seat, from, to], n) => { last = bySeat[seat]!('arena.move', { matchId: match.id, moveNumber: n, move: { from, to } }) })
  return last
}
/** Members the saved world holds a rating for. */
const rated = (): string[] => Object.keys((JSON.parse(savedText()) as { arena: { ratings: Record<string, unknown> } }).arena.ratings).sort()
const terms = (match: ArenaMatch) => [match.status, match.rated, match.audience, match.communityId]
const [RESIDENT, WALE, YEMI, ZAINAB] = ['resident', 'wale', 'yemi', 'zainab'].map(name => `m_probe_${name}` as MemberId) as [MemberId, MemberId, MemberId, MemberId]

let tayo!: Guest, uche!: Guest
let firstGame!: ArenaMatch, nextDayGame!: ArenaMatch
let ratedGame = '' as ArenaMatchId, publicGame = '' as ArenaMatchId, communityGame = '' as ArenaMatchId

check('15 two guests, each with their own capability, find each other in the casual queue and play chess to checkmate', () => {
  tayo = newGuest()
  uche = newGuest()
  assert.notEqual(tayo.token, uche.token)
  for (const guest of [tayo, uche]) {
    arrive(asGuest(guest))
    links.set(guest.id, connect(guest.id))
    players.set(guest.id, asGuest(guest))
  }
  const waiting = asGuest(tayo)('arena.create', CASUAL).match
  assert.deepEqual([...terms(waiting), waiting.open], ['waiting', false, 'players', null, 'queue'])
  const started = asGuest(uche)('arena.create', CASUAL).match
  assert.equal(started.id, waiting.id, 'the second guest is seated in the first one’s game')
  assert.deepEqual([...terms(started), started.forFun], ['active', false, 'players', null, false])
  assert.deepEqual(started.players.map(player => player.member!.id).sort(), [tayo.id, uche.id].sort())
  assert.ok(guestMayEnterMatch(started))
  assert.equal(asGuest(tayo)('arena.watch', { matchId: started.id }).match.me.role, 'player')

  // The hall judges every move: out of turn, illegal and malformed moves change nothing.
  const white = players.get(started.players[0]!.member!.id)!, black = players.get(started.players[1]!.member!.id)!
  rejects('conflict', () => black('arena.move', { matchId: started.id, moveNumber: 0, move: { from: 'e7', to: 'e5' } }), /not your turn/)
  rejects('conflict', () => white('arena.move', { matchId: started.id, moveNumber: 0, move: { from: 'e2', to: 'e5' } }))
  rejects('invalid', () => white('arena.move', { matchId: started.id, moveNumber: 0, move: { square: 'e4' } }))
  const before = [balance(white), balance(black)]
  const done = playToMate(started)
  assert.deepEqual([done.match.status, done.match.outcome?.reason, done.match.outcome?.winners, done.match.moveCount], ['finished', 'checkmate', [1], 4])
  assert.deepEqual(done.match.players.map(player => player.ratingChange), [null, null], 'nobody is rated')
  assert.deepEqual(done.match.players.map(player => player.coins), [null, ARENA.pay.human])
  assert.deepEqual([balance(white), balance(black)], [before[0]!, before[1]! + ARENA.pay.human], 'the win pays its coins once')
  assert.equal(black('travel.state', {}).ledger.filter(entry => entry.kind === 'game').length, 1)
  assert.equal(white('arena.get', { matchId: started.id }).match.status, 'finished', 'both players see the result')
  assert.deepEqual(rated(), [], 'and the saved world holds no rating for anyone')
  firstGame = done.match
})

check('16 a rematch between guests is still unrated, answered or asked for by both, and a game that did not count cannot come back as a rated one', () => {
  let last = firstGame
  const replay = (via: 'respond' | 'rematch'): ArenaMatch => {
    now += SECOND
    const asked = asGuest(tayo)('arena.rematch', { matchId: last.id }).match
    assert.deepEqual([...terms(asked), asked.rematchOf], ['waiting', false, 'players', null, last.id])
    const begun = via === 'respond' ? asGuest(uche)('arena.respond', { matchId: asked.id, accept: true }).match : asGuest(uche)('arena.rematch', { matchId: last.id }).match
    assert.deepEqual([begun.id, ...terms(begun)], [asked.id, 'active', false, 'players', null])
    assert.equal(begun.players[0]!.member!.id, last.players[1]!.member!.id, 'the seats swap')
    last = playToMate(begun).match
    assert.deepEqual([last.status, last.players.map(player => player.ratingChange)], ['finished', [null, null]])
    return last
  }
  replay('respond')
  replay('rematch')
  replay('respond')
  assert.equal(replay('rematch').forFun, false)
  // The same two have now finished five games today. The sixth is for fun: no coins either.
  const sixth = replay('respond')
  assert.deepEqual([sixth.forFun, sixth.rated, sixth.players.map(player => player.coins)], [true, false, [null, null]])

  // The hall offers a for-fun game's rematch as rated between two accounts. Between guests it is casual
  // on the record, and stays casual when it is taken up the next day, when the pair's games count again.
  now += SECOND
  const seventh = asGuest(uche)('arena.rematch', { matchId: sixth.id }).match
  assert.deepEqual(terms(seventh), ['waiting', false, 'players', null])
  now = (Math.floor(now / DAY) + 1) * DAY + 60_000
  const begun = asGuest(tayo)('arena.respond', { matchId: seventh.id, accept: true }).match
  assert.deepEqual([...terms(begun), begun.forFun], ['active', false, 'players', null, false])
  nextDayGame = playToMate(begun).match
  assert.deepEqual(nextDayGame.players.map(player => [player.ratingChange, player.coins]), [[null, null], [null, ARENA.pay.human]])
  assert.deepEqual(rated(), [])
})

check('17 queues are not crossed: a guest is never seated in a watched, community or rated game, and still meets an account that asks for the same casual one', () => {
  now += 60_000
  for (const [memberId, name] of [[RESIDENT, 'Resident'], [WALE, 'Wale'], [YEMI, 'Yemi'], [ZAINAB, 'Zainab']] as const) {
    main.world.scoped(() => ensureMember(main.world, memberId, name))
    links.set(memberId, connect(memberId))
    players.set(memberId, asMember(memberId))
  }
  // An account waits for a casual game that anyone may watch. A guest asking for a private one is not put in it.
  const open = asMember(RESIDENT)('arena.create', { ...CASUAL, audience: 'anyone' }).match
  const mine = asGuest(tayo)('arena.create', CASUAL).match
  assert.notEqual(mine.id, open.id)
  assert.deepEqual([terms(mine), asMember(RESIDENT)('arena.get', { matchId: open.id }).match.status], [['waiting', false, 'players', null], 'waiting'])
  // An account asking for the same private casual game is seated with the guest.
  const together = asMember(WALE)('arena.create', CASUAL).match
  assert.deepEqual([together.id, ...terms(together)], [mine.id, 'active', false, 'players', null])
  assert.deepEqual(together.players.map(player => player.member!.id).sort(), [tayo.id, WALE].sort())
  assert.deepEqual(playToMate(together).match.players.map(player => player.ratingChange), [null, null])
  // And the watched queue still pairs the accounts in it.
  const watched = asMember(YEMI)('arena.create', { ...CASUAL, audience: 'anyone' }).match
  assert.deepEqual([watched.id, ...terms(watched)], [open.id, 'active', false, 'anyone', null])
  publicGame = watched.id

  // Rated: the wrapper refuses the request. A request that skipped the wrapper is recorded as casual
  // by the hall itself, so it does not meet the account waiting for a rated game.
  const waiting = asMember(ZAINAB)('arena.create', { ...CASUAL, rated: true }).match
  assert.deepEqual(terms(waiting), ['waiting', true, 'players', null])
  rejects('forbidden', () => asGuest(uche)('arena.create', { ...CASUAL, rated: true }), /rated games/)
  const forged = main.world.call(uche.id, 'arena.create', { ...CASUAL, rated: true }).match
  assert.notEqual(forged.id, waiting.id)
  assert.deepEqual(terms(forged), ['waiting', false, 'players', null])
  assert.equal(asGuest(uche)('arena.cancel', { matchId: forged.id }).match.status, 'cancelled')
  // Accounts still play for ratings.
  const begun = asMember(YEMI)('arena.create', { ...CASUAL, rated: true }).match
  assert.deepEqual([begun.id, ...terms(begun)], [waiting.id, 'active', true, 'players', null])
  const settled = playToMate(begun).match
  assert.ok(settled.players.every(player => typeof player.ratingChange === 'number' && player.ratingChange !== 0))
  ratedGame = settled.id
  assert.deepEqual(rated(), [YEMI, ZAINAB].sort())
  assert.deepEqual(asMember(RESIDENT)('arena.standings', { game: 'chess', scope: 'global', view: 'rating', communityId: null }).standings.rows.map(row => row.memberId).sort(), [YEMI, ZAINAB].sort())

  // Community queues: one circle's game is not handed to another's.
  const circle = (owner: MemberId, name: string) => asMember(owner)('community.create', { name, about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'public' }).community.id
  const one = circle(ZAINAB, 'Probe circle one'), two = circle(WALE, 'Probe circle two')
  const inOne = asMember(ZAINAB)('arena.create', { ...CASUAL, audience: 'community', communityId: one }).match
  const inTwo = asMember(WALE)('arena.create', { ...CASUAL, audience: 'community', communityId: two }).match
  assert.notEqual(inTwo.id, inOne.id)
  assert.deepEqual([terms(inOne), terms(inTwo)], [['waiting', false, 'community', one], ['waiting', false, 'community', two]])
  asMember(WALE)('arena.cancel', { matchId: inTwo.id })
  communityGame = inOne.id
})

check('18 a match id is not a way in: every operation on a rated, watched or community match is refused to a guest from the match’s own record', () => {
  const guest = asGuest(uche)
  for (const matchId of [ratedGame, publicGame, communityGame]) {
    const inputs: Record<string, object> = {
      'arena.respond': { matchId, accept: true }, 'arena.move': { matchId, moveNumber: 0, move: { from: 'e2', to: 'e4' } }, 'arena.draw': { matchId, action: 'offer' },
    }
    for (const op of GUEST_MATCH_OPS) {
      assert.equal(guestAccess(op, inputs[op] ?? { matchId }).allowed, true, 'the request alone looks fine')
      rejects('forbidden', () => guest(op, (inputs[op] ?? { matchId }) as never), /rated games/)
    }
  }
  const seen = asMember(RESIDENT)('arena.get', { matchId: publicGame }).match
  assert.deepEqual([seen.status, seen.moveCount, guestMayEnterMatch(seen)], ['active', 0, false], 'nothing was played or resigned')
  // The watched game is open to an account that is not playing; the guest's refusal came from the guest service.
  assert.equal(asMember(ZAINAB)('arena.watch', { matchId: publicGame }).match.me.role, 'watcher')
  const link = links.get(uche.id)!
  main.guests.receive(link.connection, uche.actor, { t: 'req', id: 31, op: 'arena.watch', input: { matchId: publicGame } })
  assert.deepEqual(answerTo(link.frames, 31), { t: 'res', id: 31, ok: false, code: 'forbidden', message: 'As a guest you can play the computer or find a casual match. Save your character to an account for rated games, challenges, watched games and standings.' })
  assert.deepEqual(asMember(RESIDENT)('arena.get', { matchId: publicGame }).match.watchers.first.map(member => member.id), [ZAINAB])
  // A match that does not exist is the hall's to answer, and a guest's own games stay open to them.
  rejects('not_found', () => guest('arena.get', { matchId: 'am_abcdefghijkl' as ArenaMatchId }))
  rejects('invalid', () => guest('arena.get', { matchId: '__proto__' as ArenaMatchId }))
  assert.equal(guest('arena.get', { matchId: firstGame.id }).match.status, 'finished')
  assert.ok(guest('arena.mine', {}).matches.every(guestMayEnterMatch))
  assert.deepEqual(rated(), [YEMI, ZAINAB].sort())
})

check('19 claiming after playing together: results and coins are kept once, and only an account plays for a rating', () => {
  const before = progress(asGuest(uche))
  const games = asGuest(uche)('arena.mine', {}).matches.map(match => [match.id, match.status, match.rated])
  const won = before.travel.ledger.filter(entry => entry.kind === 'game')
  assert.ok(won.length >= 1 && games.length >= 7, 'there are wins and games to keep')
  assert.equal(before.career.points, TRAVEL.startingCoins + won.length * ARENA.pay.human)
  const result = main.guests.claim({ token: uche.token, principal: principal('uche'), source: src() })
  assert.deepEqual([result.outcome, result.outcome === 'claimed' && result.memberId], ['claimed', uche.id])
  players.set(uche.id, asMember(uche.id))
  main.guests.claim({ token: uche.token, principal: principal('uche'), source: src() })
  assert.deepEqual(progress(asMember(uche.id)), before, 'coins, ledger and career are exactly what the guest had')
  assert.deepEqual(asMember(uche.id)('arena.mine', {}).matches.map(match => [match.id, match.status, match.rated]), games)
  assert.deepEqual(rated(), [YEMI, ZAINAB].sort(), 'a claim gives nobody a rating')
  rejects('unauthorized', () => asGuest(uche)('arena.create', CASUAL))

  // The member id has not changed. What changed is that an account now owns it: it may ask for a rated game.
  const waiting = asMember(uche.id)('arena.create', { ...CASUAL, rated: true }).match
  assert.deepEqual(terms(waiting), ['waiting', true, 'players', null])
  // The friend who is still a guest is not seated in it, and a rematch with them is casual whoever asks.
  const dodged = main.world.call(tayo.id, 'arena.create', { ...CASUAL, rated: true }).match
  assert.notEqual(dodged.id, waiting.id)
  assert.equal(dodged.rated, false)
  asGuest(tayo)('arena.cancel', { matchId: dodged.id })
  const again = asMember(uche.id)('arena.rematch', { matchId: nextDayGame.id }).match
  assert.deepEqual(terms(again), ['waiting', false, 'players', null])
  assert.equal(asGuest(tayo)('arena.respond', { matchId: again.id, accept: true }).match.rated, false)
  // Another account takes the rated game, and the claimed member is rated like anyone.
  const begun = asMember(WALE)('arena.create', { ...CASUAL, rated: true }).match
  assert.deepEqual([begun.id, ...terms(begun)], [waiting.id, 'active', true, 'players', null])
  assert.ok(playToMate(begun).match.players.every(player => typeof player.ratingChange === 'number'))
  assert.deepEqual(rated(), [uche.id, WALE, YEMI, ZAINAB].sort())
  assert.equal(main.guests.isGuest(tayo.id), true)
})

if (!failed) console.log('ALL PASS')
