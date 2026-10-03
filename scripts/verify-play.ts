// Evidence probe for work shifts, Lane Dash, Eights, spectating and boards: in-process world,
// controllable clock, plain asserts. Run: node scripts/verify-play.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import type { CommunityId, MatchId, MemberId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { ErrorCode } from '../src/shared/model.ts'
import { DASH, TABLE_TURN_SECONDS, buildDashCourse, levelForXp, replayDash } from '../src/shared/play.ts'
import type { Card, DashInput, Suit, TableView } from '../src/shared/play.ts'
import type { ServerEvent } from '../src/shared/protocol.ts'
import type { World } from '../service/kernel.ts'
import { createWorld } from '../service/index.ts'
import { addFriendship, ensureMember } from '../service/members.ts'

const SECOND = 1000, MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
let now = Date.UTC(2026, 9, 1, 12)

const A = 'm_local_a' as MemberId, B = 'm_local_b' as MemberId, C = 'm_local_c' as MemberId, D = 'm_local_d' as MemberId

function makeWorld(): { world: World; events: Record<string, ServerEvent[]> } {
  const world = createWorld({ now: () => now })
  const events: Record<string, ServerEvent[]> = {}
  for (const [member, name] of [[A, 'Ada'], [B, 'Ben'], [C, 'Cleo'], [D, 'Dev']] as const) {
    ensureMember(world, member, name)
    events[member] = []
    world.connect(member, frame => { if (frame.t === 'event') events[member]!.push(frame.event) }, () => {})
  }
  addFriendship(world, A, B)
  addFriendship(world, A, C)
  addFriendship(world, B, C)
  return { world, events }
}

function rejects(code: ErrorCode, run: () => unknown): void {
  try { run() } catch (error) {
    assert.ok(error instanceof WorldError, `expected WorldError(${code}), got ${String(error)}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return
  }
  assert.fail(`expected ${code}, but the call succeeded`)
}

let failed = false
function check(name: string, run: () => void): void {
  if (failed) return
  try { run(); console.log(`PASS ${name}`) } catch (error) {
    failed = true
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

const { world, events } = makeWorld()
const career = (member: MemberId) => world.call(member, 'work.career', {}).career
const points = (member: MemberId): number => career(member).points

// ── Lane Dash solver: best legal input log over a course ──

function solve(seed: number): DashInput[] {
  const course = buildDashCourse(seed)
  const rows = course.rowTick.length
  const value = Array.from({ length: rows + 1 }, () => [0, 0, 0])
  for (let row = rows - 1; row >= 0; row--) {
    for (let lane = 0; lane < DASH.lanes; lane++) {
      if (course.blocked[row]![lane]) { value[row]![lane] = -Infinity; continue }
      const next = [lane - 1, lane, lane + 1].filter(l => l >= 0 && l < DASH.lanes).map(l => value[row + 1]![l]!)
      value[row]![lane] = DASH.rowValue + (course.coins[row] === lane ? DASH.coinValue : 0) + Math.max(...next)
    }
  }
  const inputs: DashInput[] = []
  let lane = 1
  for (let row = 0; row < rows; row++) {
    // Rows are reached one at a time, so a lane change is at most one step and ticks only grow.
    const options = [lane - 1, lane, lane + 1].filter(l => l >= 0 && l < DASH.lanes)
    const best = options.reduce((x, y) => (value[row]![y]! > value[row]![x]! ? y : x), options.includes(lane) ? lane : options[0]!)
    if (best !== lane) { inputs.push({ tick: course.rowTick[row]! - 1, lane: best }); lane = best }
  }
  const outcome = replayDash(course, inputs)
  assert.ok(outcome && !outcome.crashed, 'solver must clear the course')
  return inputs
}

const advanceFor = (endTick: number): void => { now += endTick * DASH.tickMs + 500 }

/** Begin, wait out the run, submit. Returns the result. */
function playDash(world: World, who: MemberId, matchId: MatchId | null, inputs?: (seed: number) => DashInput[]) {
  const { attempt } = world.call(who, 'dash.begin', { matchId })
  const log = inputs ? inputs(attempt.seed) : []
  const outcome = replayDash(buildDashCourse(attempt.seed), log)!
  advanceFor(outcome.endTick)
  return { attempt, result: world.call(who, 'dash.submit', { attemptToken: attempt.attemptToken, inputs: log }) }
}

const invite = (member: MemberId, kind: string) => world.call(member, 'notify.list', { includeRead: true }).notifications.filter(n => n.kind === kind)

// ── 1–3 Work ──

let shiftId = '' as ReturnType<typeof world.call<'work.start'>>['shift']['id']

check('1 complete café shift: 5 correct answers, points and xp, repeat pays nothing', () => {
  const places = world.call(A, 'work.places', {})
  assert.equal(places.workplaces.length, 3)
  assert.deepEqual(places.workplaces.map(p => p.skill), ['service', 'logistics', 'craft'])
  const before = career(A)
  let { shift } = world.call(A, 'work.start', { workplaceId: 'corner-cafe', venueName: 'Kiln Café' })
  assert.equal(world.call(A, 'work.start', { workplaceId: 'corner-cafe', venueName: null }).shift.id, shift.id, 'start is idempotent')
  let lastAnswer = { shiftId: shift.id, index: 0, handed: [] as string[] }
  for (let index = 0; index < 5; index++) {
    assert.equal(shift.current?.index, index)
    assert.ok(shift.current!.wants.length >= 2 && shift.current!.wants.length <= 4)
    now += 3 * SECOND
    lastAnswer = { shiftId: shift.id, index, handed: [...shift.current!.wants] }
    shift = world.call(A, 'work.answer', lastAnswer).shift
  }
  assert.equal(shift.status, 'completed')
  assert.ok(shift.result && shift.result.points > 0)
  assert.equal(shift.result.xp, 5 * 12 + 10)
  assert.equal(shift.result.skill, 'service')
  assert.equal(shift.current, null)
  const after = career(A)
  assert.equal(after.points, before.points + shift.result.points)
  assert.ok(after.skills.service.xp > before.skills.service.xp)
  assert.equal(after.skills.service.level, levelForXp(after.skills.service.xp))
  assert.equal(after.shifts.completed, before.shifts.completed + 1)
  const again = world.call(A, 'work.answer', lastAnswer).shift
  assert.deepEqual(again, shift)
  assert.equal(career(A).points, after.points, 'repeating the last answer adds nothing')
  assert.equal(world.call(A, 'work.places', {}).active, null)
})

check('2 wrong answer scores 0 and future tasks are never sent', () => {
  const { shift } = world.call(A, 'work.start', { workplaceId: 'corner-shop', venueName: null })
  shiftId = shift.id
  const answered = world.call(A, 'work.answer', { shiftId, index: 0, handed: ['nothing-like-it'] }).shift
  assert.equal(answered.done[0]!.correct, false)
  assert.equal(answered.done[0]!.points, 0)
  assert.equal(answered.current?.index, 1)
  const wire = JSON.stringify(answered)
  assert.ok(!('tasks' in answered) && !('seed' in answered) && !wire.includes('"seed"'))
  assert.equal(answered.done.length, 1)
  rejects('conflict', () => world.call(A, 'work.answer', { shiftId, index: 3, handed: [] }))
  rejects('not_found', () => world.call(B, 'work.answer', { shiftId, index: 1, handed: [] }))
})

check('3 leave pays only finished tasks; an abandoned shift times out on tick with a notification', () => {
  const current = world.call(A, 'work.places', {}).active!.current!
  const before = career(A)
  now += 2 * SECOND
  const mid = world.call(A, 'work.answer', { shiftId, index: 1, handed: current.wants }).shift
  const earned = mid.done.reduce((sum, t) => sum + t.points, 0)
  const left = world.call(A, 'work.leave', { shiftId })
  assert.equal(left.shift.status, 'left-early')
  assert.equal(left.shift.result!.points, earned)
  assert.equal(left.shift.result!.xp, 12, 'one correct task, no completion bonus')
  assert.equal(left.career.points, before.points + earned)
  assert.equal(left.career.shifts.leftEarly, before.shifts.leftEarly + 1)
  assert.deepEqual(world.call(A, 'work.leave', { shiftId }).shift, left.shift, 'leaving again changes nothing')
  assert.equal(career(A).points, left.career.points)

  const started = world.call(A, 'work.start', { workplaceId: 'maker-studio', venueName: 'Loft Studio' }).shift
  const one = world.call(A, 'work.answer', { shiftId: started.id, index: 0, handed: started.current!.wants }).shift
  const paid = one.done[0]!.points
  const pointsBefore = points(A)
  now += 13 * MINUTE
  world.tick()
  const closed = career(A).recent[0]!
  assert.equal(closed.id, started.id)
  assert.equal(closed.status, 'timed-out')
  assert.equal(closed.result!.points, paid)
  assert.equal(points(A), pointsBefore + paid)
  assert.equal(world.call(A, 'work.places', {}).active, null)
  const note = invite(A, 'work.closed')[0]!
  assert.equal(note.category, 'work')
  assert.equal(note.link, '/work')
  assert.ok(note.title.includes('Loft Studio'))
  world.tick()
  assert.equal(invite(A, 'work.closed').length, 1, 'ticking again does not repeat it')
})

// ── 4–5 Lane Dash ──

let dashMatch = '' as MatchId

check('4 dash challenge a to b: same seed, server score equals replay, winner, finished, invite settled', () => {
  const created = world.call(A, 'match.create', { game: 'lane-dash', invite: [B], audience: 'friends', communityId: null }).match
  dashMatch = created.id
  assert.equal(created.status, 'invited')
  assert.equal(ms(created.expiresAt) - ms(created.createdAt), 48 * HOUR)
  const pending = invite(B, 'match.invited')[0]!
  assert.equal(pending.state, 'active')
  assert.equal(pending.link, `/games/match/${dashMatch}`)
  assert.ok(events[B]!.some(e => e.type === 'match.changed' && e.matchId === dashMatch))
  rejects('conflict', () => world.call(B, 'dash.begin', { matchId: dashMatch }))
  assert.equal(world.call(A, 'match.get', { matchId: dashMatch }).match.canPlay, true, 'host can play straight away')
  const accepted = world.call(B, 'match.respond', { matchId: dashMatch, accept: true }).match
  assert.equal(accepted.status, 'active')
  assert.equal(invite(B, 'match.invited')[0]!.state, 'resolved')

  const a = world.call(A, 'dash.begin', { matchId: dashMatch }).attempt
  const b = world.call(B, 'dash.begin', { matchId: dashMatch }).attempt
  assert.equal(a.seed, b.seed)
  const inputsA = solve(a.seed)
  const replayA = replayDash(buildDashCourse(a.seed), inputsA)!
  advanceFor(replayA.endTick)
  const pointsBefore = points(A)
  const first = world.call(A, 'dash.submit', { attemptToken: a.attemptToken, inputs: inputsA })
  assert.equal(first.accepted, true)
  assert.equal(first.outcome!.score, replayA.score)
  assert.equal(points(A), pointsBefore + Math.floor(replayA.score / 10))
  assert.equal(first.match.status, 'active')
  assert.equal(first.match.canPlay, false)
  assert.ok(invite(B, 'match.played').length === 1)
  const second = world.call(B, 'dash.submit', { attemptToken: b.attemptToken, inputs: [] })
  assert.equal(second.accepted, true)
  assert.ok(second.outcome!.score < replayA.score)
  assert.equal(second.match.status, 'finished')
  assert.equal(second.match.winner, A)
  assert.deepEqual(second.match.players.map(p => p.placed).sort(), [1, 2])
  assert.equal(world.call(A, 'match.get', { matchId: dashMatch }).match.status, 'finished')
})

check('5 dash anti-cheat: replay, illegal, too fast, claimed score ignored', () => {
  const m = world.call(A, 'match.create', { game: 'lane-dash', invite: [C], audience: 'players-only', communityId: null }).match
  world.call(C, 'match.respond', { matchId: m.id, accept: true })
  const a = world.call(A, 'dash.begin', { matchId: m.id }).attempt
  const inputs = solve(a.seed)
  advanceFor(replayDash(buildDashCourse(a.seed), inputs)!.endTick)
  const before = points(A)
  const ok = world.call(A, 'dash.submit', { attemptToken: a.attemptToken, inputs })
  assert.equal(ok.accepted, true)
  const gained = points(A) - before
  assert.equal(gained, Math.floor(ok.outcome!.score / 10))
  const replay = world.call(A, 'dash.submit', { attemptToken: a.attemptToken, inputs })
  assert.equal(replay.accepted, false)
  assert.equal(replay.reason, 'already-submitted')
  assert.equal(points(A), before + gained, 'a resubmitted token pays nothing')
  const stolen = world.call(B, 'dash.submit', { attemptToken: a.attemptToken, inputs })
  assert.equal(stolen.reason, 'not-your-match')

  // A lane jump of two is not a legal game; the attempt is spent.
  const solo = world.call(A, 'dash.begin', { matchId: null }).attempt
  const illegal = world.call(A, 'dash.submit', { attemptToken: solo.attemptToken, inputs: [{ tick: 3, lane: 0 }, { tick: 4, lane: 2 }] })
  assert.equal(illegal.reason, 'illegal-inputs')
  assert.equal(world.call(A, 'dash.submit', { attemptToken: solo.attemptToken, inputs: [] }).reason, 'already-submitted')

  // A perfect run handed in instantly cannot have been played in real time.
  const quick = world.call(A, 'dash.begin', { matchId: null }).attempt
  const tooFast = world.call(A, 'dash.submit', { attemptToken: quick.attemptToken, inputs: solve(quick.seed) })
  assert.equal(tooFast.reason, 'too-fast')
  assert.equal(tooFast.outcome, null)

  // Beginning again replaces the open attempt.
  const first = world.call(A, 'dash.begin', { matchId: null }).attempt
  const second = world.call(A, 'dash.begin', { matchId: null }).attempt
  assert.equal(world.call(A, 'dash.submit', { attemptToken: first.attemptToken, inputs: [] }).reason, 'already-submitted')

  // The API has no score field: an extra one is ignored and the replay decides.
  const mine = solve(second.seed)
  const honest = replayDash(buildDashCourse(second.seed), mine)!
  advanceFor(honest.endTick)
  const sneaky = { attemptToken: second.attemptToken, inputs: mine, score: 99999 }
  const claimed = world.call(A, 'dash.submit', sneaky)
  assert.equal(claimed.accepted, true)
  assert.equal(claimed.outcome!.score, honest.score)
  assert.ok(!world.call(A, 'board.get', { scope: 'personal', game: 'lane-dash', communityId: null }).board.rows.some(r => r.score === 99999))
  const late = world.call(A, 'dash.begin', { matchId: null }).attempt
  now += 10 * MINUTE
  assert.equal(world.call(A, 'dash.submit', { attemptToken: late.attemptToken, inputs: [] }).reason, 'too-late')
})

// ── 6–7 Expiry and rematch ──

check('6 expiry: an unanswered invite expires after 48h and match.get still returns it', () => {
  const m = world.call(A, 'match.create', { game: 'lane-dash', invite: [C], audience: 'players-only', communityId: null }).match
  world.tick()
  now += 47 * HOUR
  world.tick()
  assert.equal(world.call(C, 'match.get', { matchId: m.id }).match.status, 'invited')
  now += 2 * HOUR
  world.tick()
  const got = world.call(C, 'match.get', { matchId: m.id })
  assert.equal(got.match.status, 'expired')
  assert.equal(got.viewer, 'player')
  assert.equal(world.call(A, 'match.get', { matchId: m.id }).match.status, 'expired')
  assert.equal(invite(C, 'match.invited').find(n => n.link.endsWith(m.id))!.state, 'expired')
  rejects('expired', () => world.call(C, 'match.respond', { matchId: m.id, accept: true }))
  assert.ok(world.call(C, 'match.list', {}).matches.some(x => x.id === m.id))
  assert.equal(world.call(C, 'match.get', { matchId: m.id }).table, null)
  rejects('forbidden', () => world.call(D, 'match.get', { matchId: m.id }))
})

check('7 rematch is idempotent and links both matches', () => {
  const first = world.call(B, 'match.rematch', { matchId: dashMatch }).match
  const again = world.call(B, 'match.rematch', { matchId: dashMatch }).match
  const other = world.call(A, 'match.rematch', { matchId: dashMatch }).match
  assert.equal(first.id, again.id)
  assert.equal(first.id, other.id)
  assert.equal(first.rematchOf, dashMatch)
  assert.equal(first.status, 'invited')
  assert.equal(first.host, B)
  assert.equal(world.call(A, 'match.get', { matchId: dashMatch }).match.rematch, first.id)
  assert.equal(invite(A, 'match.invited').filter(n => n.link.endsWith(first.id)).length, 1)
  rejects('forbidden', () => world.call(D, 'match.rematch', { matchId: dashMatch }))
  rejects('conflict', () => world.call(B, 'match.rematch', { matchId: first.id }), )
})

// ── 8–11 Eights ──

const same = (a: Card, b: Card): boolean => a.suit === b.suit && a.rank === b.rank
const legal = (card: Card, view: TableView): boolean => card.rank === 8 || card.suit === view.activeSuit || card.rank === view.topCard!.rank
function suitFor(hand: Card[]): Suit {
  const counts = new Map<Suit, number>()
  for (const card of hand) if (card.rank !== 8) counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1)
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'hearts'
}
const cardsIn = (...views: TableView[]): Card[] => views.flatMap(v => v.hand ?? [])
const seatOf = (view: TableView, member: MemberId) => view.seats.find(s => s.member.id === member)!
const watch = (member: MemberId, matchId: MatchId): TableView => world.call(member, 'table.watch', { matchId }).table

function startEights(host: MemberId, guest: MemberId, audience: 'friends' | 'players-only' | 'community', communityId: CommunityId | null = null): MatchId {
  const created = world.call(host, 'match.create', { game: 'eights', invite: [guest], audience, communityId }).match
  assert.equal(created.status, 'invited')
  rejects('conflict', () => world.call(host, 'table.watch', { matchId: created.id }))
  const started = world.call(guest, 'match.respond', { matchId: created.id, accept: true }).match
  assert.equal(started.status, 'active')
  return created.id
}

let eightsMatch = '' as MatchId
let hidden: { va: TableView; vb: TableView; vc: TableView }
const cEvents = (): ServerEvent[] => events[C]!

check('8 eights full game a vs b from each player\'s own view; one result, one 30 point award', () => {
  eightsMatch = startEights(A, B, 'friends')
  // Spectator c is inside the room from the deal, so every push to c is a spectator view.
  world.call(C, 'room.enter', { ref: { kind: 'table', matchId: eightsMatch }, pos: { x: 0, z: 0 }, heading: 0 })
  const start = watch(A, eightsMatch)
  assert.equal(start.hand!.length, 7)
  assert.equal(watch(B, eightsMatch).hand!.length, 7)
  assert.notEqual(start.topCard!.rank, 8)
  assert.equal(start.turn, A)

  // Hidden information, checked while the hands are still untouched (check 9 reads these).
  const va = start, vb = watch(B, eightsMatch), vc = watch(C, eightsMatch)
  hidden = { va, vb, vc }

  const pointsBefore: Record<string, number> = { [A]: points(A), [B]: points(B) }
  let moves = 0
  for (;;) {
    const lead = watch(A, eightsMatch)
    if (lead.turn === null) break
    assert.ok(++moves < 3000, 'game did not finish')
    const mover = lead.turn
    const other = mover === A ? B : A
    const view = watch(mover, eightsMatch)
    const otherBefore = seatOf(watch(other, eightsMatch), other).cardCount
    const hand = view.hand!
    assert.equal(hand.length, seatOf(view, mover).cardCount, 'own hand matches own card count')
    let action: Parameters<typeof world.call<'table.act'>>[2]['action']
    if (view.drewThisTurn) {
      const drawn = hand[hand.length - 1]!
      action = legal(drawn, view) ? { kind: 'play', card: drawn, ...(drawn.rank === 8 ? { chooseSuit: suitFor(hand) } : {}) } : { kind: 'pass' }
    } else {
      const pick = hand.find(c => c.rank !== 8 && legal(c, view)) ?? hand.find(c => c.rank === 8)
      action = pick ? { kind: 'play', card: pick, ...(pick.rank === 8 ? { chooseSuit: suitFor(hand) } : {}) } : { kind: 'draw' }
    }
    now += 500
    const out = world.call(mover, 'table.act', { matchId: eightsMatch, action }).table
    assert.equal(out.hand!.length, seatOf(out, mover).cardCount)
    if (action.kind === 'play') {
      assert.equal(out.hand!.length, hand.length - 1)
      assert.ok(same(out.topCard!, action.card))
    } else if (action.kind === 'draw') {
      assert.ok(out.hand!.length === hand.length + 1 || view.drawPileCount === 0, 'a draw adds exactly one card')
      assert.equal(out.drewThisTurn || out.turn !== mover, true)
    } else assert.equal(out.hand!.length, hand.length)
    assert.equal(seatOf(watch(other, eightsMatch), other).cardCount, otherBefore, 'the other hand did not change')
  }
  const done = world.call(A, 'match.get', { matchId: eightsMatch })
  assert.equal(done.match.status, 'finished')
  const winner = done.match.winner!
  assert.ok(winner === A || winner === B)
  const loser = winner === A ? B : A
  assert.equal(seatOf(watch(winner, eightsMatch), winner).cardCount, 0)
  assert.equal(watch(winner, eightsMatch).hand!.length, 0)
  assert.equal(seatOf(watch(winner, eightsMatch), winner).penalty, 0)
  assert.ok(seatOf(watch(winner, eightsMatch), loser).penalty! > 0)
  assert.equal(points(winner) - pointsBefore[winner]!, 30)
  assert.equal(points(loser) - pointsBefore[loser]!, 0)
  assert.ok(events[winner]!.some(e => e.type === 'match.changed'))
  // Recorded once: another action, another tick and a later look change nothing.
  rejects('conflict', () => world.call(winner, 'table.act', { matchId: eightsMatch, action: { kind: 'draw' } }))
  world.tick()
  assert.equal(points(winner) - pointsBefore[winner]!, 30)
  const board = world.call(A, 'board.get', { scope: 'friends', game: 'eights', communityId: null }).board
  assert.equal(board.rows.length, 1)
  assert.equal(board.rows[0]!.member.id, winner)
  assert.equal(board.rows[0]!.score, 1)
  assert.equal(board.week, '2026-W40')
})

check('9 hidden information: players see only their own hand, spectators none', () => {
  const { va, vb, vc } = hidden
  for (const view of [va, vb]) {
    assert.equal(view.role, 'player')
    assert.equal(view.hand!.length, seatOf(view, view === va ? A : B).cardCount)
  }
  const wire = (view: TableView): string => JSON.stringify(view)
  for (const card of va.hand!) assert.ok(!wire(vb).includes(JSON.stringify(card)), 'b never sees a card from a hand')
  for (const card of vb.hand!) assert.ok(!wire(va).includes(JSON.stringify(card)), 'a never sees a card from b hand')
  assert.equal(vc.role, 'spectator')
  assert.equal(vc.hand, null)
  const spectatorWire = wire(vc)
  assert.ok(!spectatorWire.includes('"hand":['), 'a spectator view carries no hand array')
  for (const card of cardsIn(va, vb)) assert.ok(!spectatorWire.includes(JSON.stringify(card)), 'a spectator sees no dealt card')
  for (const key of ['draw"', 'seed', 'discard"', 'hands']) assert.ok(!spectatorWire.includes(`"${key}`) && !wire(va).includes(`"${key}`), `no ${key} in any view`)
  assert.equal(vc.seats.every(s => typeof s.cardCount === 'number' && !('hand' in s)), true)
  // Everything pushed to c during the whole game was a spectator view without cards.
  const pushed = cEvents().filter((e): e is Extract<ServerEvent, { type: 'table.state' }> => e.type === 'table.state')
  assert.ok(pushed.length > 10, 'c received live table updates')
  assert.ok(pushed.every(e => e.table.role === 'spectator' && e.table.hand === null && !JSON.stringify(e.table).includes('"hand":[')))
  assert.ok(events[D]!.every(e => e.type !== 'table.state'), 'a non-friend receives no table state')
  // Players are pushed their own view after each move.
  const toB = events[B]!.filter((e): e is Extract<ServerEvent, { type: 'table.state' }> => e.type === 'table.state')
  assert.ok(toB.length > 10 && toB.every(e => e.table.role === 'player' && e.table.hand!.length === seatOf(e.table, B).cardCount))
})

check('10 spectators cannot act; non-friends and players-only tables are closed', () => {
  const m = startEights(A, B, 'friends')
  rejects('forbidden', () => world.call(C, 'table.act', { matchId: m, action: { kind: 'draw' } }))
  rejects('forbidden', () => world.call(D, 'table.watch', { matchId: m }))
  rejects('forbidden', () => world.call(D, 'room.enter', { ref: { kind: 'table', matchId: m }, pos: { x: 0, z: 0 }, heading: 0 }))
  rejects('forbidden', () => world.call(D, 'match.get', { matchId: m }))
  assert.equal(world.call(C, 'table.watch', { matchId: m }).table.role, 'spectator')
  assert.equal(world.call(C, 'match.get', { matchId: m }).viewer, 'spectator')
  assert.ok(world.call(C, 'match.open', {}).matches.some(x => x.id === m))
  assert.equal(world.call(D, 'match.open', {}).matches.length, 0)
  assert.equal(world.call(A, 'match.open', {}).matches.length, 0, 'players do not list their own table')
  const closed = startEights(A, B, 'players-only')
  rejects('forbidden', () => world.call(C, 'table.watch', { matchId: closed }))
  rejects('forbidden', () => world.call(C, 'room.enter', { ref: { kind: 'table', matchId: closed }, pos: { x: 0, z: 0 }, heading: 0 }))
  rejects('forbidden', () => world.call(C, 'match.get', { matchId: closed }))
  assert.ok(!world.call(C, 'match.open', {}).matches.some(x => x.id === closed))
  // Blocking a player closes the table to that viewer too.
  world.call(C, 'member.block', { memberId: B })
  rejects('forbidden', () => world.call(C, 'table.watch', { matchId: m }))
  world.call(C, 'member.unblock', { memberId: B })
  assert.equal(world.call(C, 'table.watch', { matchId: m }).table.role, 'spectator')
})

check('11 turn timeout: past the turn clock the table moves on', () => {
  const m = startEights(A, B, 'players-only')
  const before = watch(A, m)
  assert.equal(before.turn, A)
  assert.equal(before.hand!.length, 7)
  now += (TABLE_TURN_SECONDS - 5) * SECOND
  world.tick()
  assert.equal(watch(A, m).turn, A, 'still within the clock')
  now += 6 * SECOND
  world.tick()
  const after = watch(B, m)
  assert.equal(after.turn, B)
  assert.equal(seatOf(after, A).cardCount, 8, 'a timed-out player is dealt a card, then passed')
  assert.ok(after.log.some(line => line.includes('ran out of time')))
  const toA = events[A]!.filter((e): e is Extract<ServerEvent, { type: 'table.state' }> => e.type === 'table.state' && e.matchId === m)
  assert.equal(toA[toA.length - 1]!.table.turn, B)
  assert.ok(Date.parse(after.turnEndsAt!) > now)
})

// ── 12 Boards (fresh world so only this check's scores are on the board) ──

check('12 boards: tie-break by earlier score, weekly reset, community membership', () => {
  now = Date.UTC(2026, 9, 1, 12)
  const fresh = makeWorld().world
  const board = (who: MemberId, scope: 'personal' | 'friends' | 'community', communityId: CommunityId | null = null) =>
    fresh.call(who, 'board.get', { scope, game: 'lane-dash', communityId }).board
  const m = fresh.call(A, 'match.create', { game: 'lane-dash', invite: [B], audience: 'friends', communityId: null }).match
  fresh.call(B, 'match.respond', { matchId: m.id, accept: true })
  const a = fresh.call(A, 'dash.begin', { matchId: m.id }).attempt
  const b = fresh.call(B, 'dash.begin', { matchId: m.id }).attempt
  const inputs = solve(a.seed)
  const run = replayDash(buildDashCourse(a.seed), inputs)!
  now += run.endTick * DASH.tickMs + 500
  // b hands in first, a twenty seconds later with the identical score.
  const rb = fresh.call(B, 'dash.submit', { attemptToken: b.attemptToken, inputs })
  now += 20 * SECOND
  const ra = fresh.call(A, 'dash.submit', { attemptToken: a.attemptToken, inputs })
  assert.ok(rb.accepted && ra.accepted && rb.outcome!.score === ra.outcome!.score)
  assert.equal(ra.match.winner, B, 'the earlier of two equal scores wins the match')
  // c plays a solo run that crashes early, so is lower.
  const solo = fresh.call(C, 'dash.begin', { matchId: null }).attempt
  now += 30 * SECOND
  const rc = fresh.call(C, 'dash.submit', { attemptToken: solo.attemptToken, inputs: [] })
  assert.ok(rc.accepted && rc.outcome!.score < run.score)

  const friends = board(A, 'friends')
  assert.deepEqual(friends.rows.map(r => r.member.id), [B, A, C])
  assert.deepEqual(friends.rows.map(r => r.rank), [1, 2, 3])
  assert.equal(friends.rows[0]!.score, friends.rows[1]!.score)
  assert.ok(Date.parse(friends.rows[0]!.achievedAt) < Date.parse(friends.rows[1]!.achievedAt))
  assert.equal(friends.rows.find(r => r.member.id === A)!.isMe, true)
  assert.ok(friends.week && friends.resetsAt && friends.rules.includes('Monday'))
  assert.equal(Date.parse(friends.resetsAt!), Date.UTC(2026, 9, 5), 'ISO week 40 ends Monday 5 Oct 00:00 UTC')
  assert.ok(!board(D, 'friends').rows.some(r => r.member.id === A), 'a stranger sees only their own board')

  // Community boards need membership.
  const community = fresh.call(A, 'community.create', { name: 'Lane runners', about: 'Racing', topic: 'games', areaLabel: '', visibility: 'public' }).community
  rejects('forbidden', () => board(C, 'community', community.id))
  fresh.call(C, 'community.join', { communityId: community.id })
  const comm = board(C, 'community', community.id)
  assert.deepEqual(comm.rows.map(r => r.member.id), [A, C], 'members only, b is not in the community')
  assert.equal(comm.communityId, community.id)
  rejects('forbidden', () => board(D, 'community', community.id))
  rejects('forbidden', () => fresh.call(D, 'match.create', { game: 'eights', invite: [A], audience: 'community', communityId: community.id }))
  const open = fresh.call(A, 'match.create', { game: 'eights', invite: [B], audience: 'community', communityId: community.id }).match
  fresh.call(B, 'match.respond', { matchId: open.id, accept: true })
  assert.equal(fresh.call(C, 'table.watch', { matchId: open.id }).table.role, 'spectator', 'a community member may watch a community table')
  rejects('forbidden', () => fresh.call(D, 'table.watch', { matchId: open.id }))

  const personal = board(A, 'personal')
  assert.equal(personal.week, null)
  assert.equal(personal.rows[0]!.score, run.score)

  // The next ISO week starts empty; personal history stays.
  now += 8 * DAY
  fresh.tick()
  const later = board(A, 'friends')
  assert.deepEqual(later.rows, [])
  assert.notEqual(later.week, friends.week)
  assert.equal(board(A, 'personal').rows[0]!.score, run.score)
  assert.deepEqual(board(C, 'community', community.id).rows, [])
})

function ms(value: string): number { return Date.parse(value) }

if (!failed) console.log('ALL PASS')
