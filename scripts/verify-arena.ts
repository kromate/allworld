// Evidence probe for the game hall: matches, clocks, the computer opponent, watching, chat,
// ratings, coins, standings and resuming after a restart. In-process world, controlled clock,
// plain asserts. Run: node scripts/verify-arena.ts
// Prints one PASS line per check and exits non-zero on the first failure.
//
// The hall runs any game that implements `Rules`. So that this probe does not depend on which of
// the three real games have landed, it plays the hall with a tiny built-in game (three in a row on
// a 3×3 board, with one hidden value per seat so that hiding can be checked). The last check then
// plays one whole game of every real game that is installed, through the hall, computer against
// computer.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { CommunityId, MemberId } from '../src/shared/ids.ts'
import { ARENA, ARENA_GAMES, ARENA_GAME_NAME, RulesError } from '../src/shared/arena.ts'
import type { ArenaDetail, ArenaGame, ArenaMatch, ArenaMatchId, ArenaOpponent, Outcome, Rules, StandingScope, TimeControlId } from '../src/shared/arena.ts'
import { WorldError } from '../src/shared/model.ts'
import type { CoarseArea, ErrorCode } from '../src/shared/model.ts'
import type { OpName, Ops, ServerEvent } from '../src/shared/protocol.ts'
import { seededRandom } from '../src/shared/play.ts'
import { STARTER_PLACES } from '../src/shared/places.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import type { Connection, Persistence, World } from '../service/kernel.ts'
import { createWorld } from '../service/index.ts'
import { addFriendship, ensureMember } from '../service/members.ts'
import { installRules, isAvailable, problemWith, rulesFor } from '../service/arena/registry.ts'

const SECOND = 1000, MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000
// Thursday 1 October 2026, 12:00 UTC. The standings week resets on Monday 5 October.
let now = Date.UTC(2026, 9, 1, 12)
/** Every call moves the clock on a little, so the kernel's request budget refills as it would in life. */
let pace = 100

const A = 'm_local_a' as MemberId, B = 'm_local_b' as MemberId, C = 'm_local_c' as MemberId, D = 'm_local_d' as MemberId
const E = 'm_local_e' as MemberId, F = 'm_local_f' as MemberId, G = 'm_local_g' as MemberId
const NAMES: [MemberId, string][] = [[A, 'Ada'], [B, 'Ben'], [C, 'Cleo'], [D, 'Dev'], [E, 'Efe'], [F, 'Funmi'], [G, 'Gbenga']]

// ── The built-in game ──

interface LineState { cells: (number | null)[]; turn: number; secrets: string[]; gaveUp: { seat: number; reason: string } | null }
interface LineMove { cell: number }
interface LineView { cells: (number | null)[]; turn: number | null; mine: string | null }
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
const lineWinner = (cells: (number | null)[]): number | null => {
  for (const [a, b, c] of LINES) if (cells[a!] !== null && cells[a!] === cells[b!] && cells[a!] === cells[c!]) return cells[a!]!
  return null
}
const fixture = { breakBot: false }
const lineRules: Rules<LineState, LineMove, LineView> = {
  game: 'walls',
  seats: { min: 2, max: 2 },
  start: (_seats, seed) => ({ cells: Array<number | null>(9).fill(null), turn: 0, secrets: [`hidden-zero-${seed}`, `hidden-one-${seed}`], gaveUp: null }),
  turn(state) { return this.outcome(state) ? null : state.turn },
  parseMove(input) {
    const cell = (input as { cell?: unknown } | null)?.cell
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 8) throw new RulesError('Choose one of the nine squares.')
    return { cell }
  },
  apply(state, seat, move) {
    if (state.turn !== seat) throw new RulesError('It is not your turn.')
    if (state.cells[move.cell] !== null) throw new RulesError('That square is taken.')
    const cells = [...state.cells]
    cells[move.cell] = seat
    return { ...state, cells, turn: 1 - seat }
  },
  outcome(state): Outcome | null {
    if (state.gaveUp) return { winners: [1 - state.gaveUp.seat], draw: false, reason: state.gaveUp.reason, text: `{${state.gaveUp.seat}} ${state.gaveUp.reason === 'time' ? 'ran out of time' : state.gaveUp.reason === 'left' ? 'left' : 'resigned'}.`, scores: state.gaveUp.seat === 0 ? [0, 1] : [1, 0] }
    const winner = lineWinner(state.cells)
    if (winner !== null) return { winners: [winner], draw: false, reason: 'three-in-a-row', text: `{${winner}} made three in a row.`, scores: winner === 0 ? [1, 0] : [0, 1] }
    if (state.cells.every(cell => cell !== null)) return { winners: [], draw: true, reason: 'full-board', text: 'The board is full. A draw.', scores: [0.5, 0.5] }
    return null
  },
  view: (state, seat) => ({ cells: [...state.cells], turn: state.gaveUp || lineWinner(state.cells) !== null ? null : state.turn, mine: seat === null ? null : state.secrets[seat]! }),
  bot(state, seat, level) {
    if (fixture.breakBot) throw new Error('the probe broke the computer on purpose')
    const free = state.cells.flatMap((cell, index) => (cell === null ? [index] : []))
    // Level 1 always takes the last free square, so a member who plays 0, 1, 2 beats it.
    if (level === 1) return { cell: free[free.length - 1]! }
    const completes = (who: number): number | undefined => free.find(index => { const cells = [...state.cells]; cells[index] = who; return lineWinner(cells) === who })
    return { cell: completes(seat) ?? completes(1 - seat) ?? (free.includes(4) ? 4 : free[0]!) }
  },
  describe: (_state, _seat, move) => `Square ${move.cell + 1}`,
  forfeit: (state, seat, reason) => ({ ...state, gaveUp: { seat, reason } }),
}

// ── Harness ──

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

function rejects(code: ErrorCode, run: () => unknown, what = ''): string {
  try { run() } catch (error) {
    assert.ok(error instanceof WorldError, `expected WorldError(${code}), got ${String(error)} ${what}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message} ${what}`)
    return error.message
  }
  return assert.fail(`expected ${code}, but the call succeeded ${what}`)
}

interface Bench { world: World; events: Record<string, ServerEvent[]>; links: Record<string, Connection> }

function connect(bench: Bench, member: MemberId): void {
  bench.events[member] ??= []
  bench.links[member] = bench.world.connect(member, frame => { if (frame.t === 'event') bench.events[member]!.push(frame.event) }, () => {})
}

function makeWorld(persistence?: Persistence): Bench {
  const world = createWorld({ now: () => now, persistence })
  const bench: Bench = { world, events: {}, links: {} }
  for (const [member, name] of NAMES) {
    world.scoped(() => ensureMember(world, member, name))
    connect(bench, member)
  }
  return bench
}

const befriend = (world: World, pairs: [MemberId, MemberId][]): void => world.scoped(() => { for (const [a, b] of pairs) addFriendship(world, a, b) })

function op<K extends OpName>(world: World, who: MemberId, name: K, input: Ops[K]['in']): Ops[K]['out'] {
  now += pace
  return world.call(who, name, input)
}

const wait = (world: World, ms: number): void => { now += ms; world.tick() }
const get = (world: World, who: MemberId, matchId: ArenaMatchId): ArenaDetail => op(world, who, 'arena.get', { matchId })
const seatIn = (world: World, who: MemberId, matchId: ArenaMatchId): number => get(world, who, matchId).match.me.seat!
const inbox = (world: World, who: MemberId, kind: string, matchId?: ArenaMatchId) =>
  world.call(who, 'notify.list', { includeRead: true }).notifications.filter(n => n.kind === kind && (!matchId || n.link.endsWith(matchId)))
const arenaEvents = (bench: Bench, who: MemberId, matchId: ArenaMatchId) =>
  bench.events[who]!.flatMap(event => (event.type === 'arena.match' && event.matchId === matchId ? [event] : []))
const cells = (detail: ArenaDetail): (number | null)[] => (detail.view as LineView).cells

interface Setup { timeControl?: TimeControlId; rated?: boolean; audience?: ArenaMatch['audience']; communityId?: CommunityId | null }
function create(world: World, host: MemberId, opponent: ArenaOpponent, setup: Setup = {}): ArenaMatch {
  return op(world, host, 'arena.create', {
    game: 'walls', opponent, timeControl: setup.timeControl ?? '5+0', rated: setup.rated ?? false,
    audience: setup.audience ?? 'anyone', communityId: setup.communityId ?? null,
  }).match
}

/** A friend's challenge, accepted. */
function begin(world: World, host: MemberId, guest: MemberId, setup: Setup = {}): ArenaMatchId {
  const made = create(world, host, { kind: 'friend', memberId: guest }, setup)
  assert.equal(made.status, 'waiting')
  const started = op(world, guest, 'arena.respond', { matchId: made.id, accept: true }).match
  assert.equal(started.status, 'active')
  return made.id
}

/** One move for whoever is to move, taking the next square from that seat's own list. */
function step(world: World, matchId: ArenaMatchId, players: [MemberId, MemberId], lists: [number[], number[]]): ArenaDetail {
  const seat0 = seatIn(world, players[0], matchId)
  const order: [MemberId, MemberId] = seat0 === 0 ? [players[0], players[1]] : [players[1], players[0]]
  const squares: [number[], number[]] = seat0 === 0 ? [lists[0], lists[1]] : [lists[1], lists[0]]
  const before = get(world, order[0], matchId)
  const turn = before.match.turn!
  const taken = before.moves.filter(line => line.seat === turn).length
  return op(world, order[turn]!, 'arena.move', { matchId, moveNumber: before.match.moveCount, move: { cell: squares[turn]![taken]! } })
}

/** Play the built-in game until `winner` has three in a row (0, 1, 2), whoever moves first. */
function playOut(world: World, matchId: ArenaMatchId, winner: MemberId, loser: MemberId): ArenaDetail {
  let last = get(world, winner, matchId)
  while (last.match.status === 'active') last = step(world, matchId, [winner, loser], [[0, 1, 2], [3, 4, 8]])
  return get(world, winner, matchId)
}

/** Two moves each, nobody winning: enough for a result to count. */
function fourPlies(world: World, matchId: ArenaMatchId, a: MemberId, b: MemberId): ArenaDetail {
  let last = get(world, a, matchId)
  for (let ply = 0; ply < 4; ply++) last = step(world, matchId, [a, b], [[0, 1], [3, 8]])
  assert.equal(last.match.status, 'active')
  return last
}

const rating = (world: World, who: MemberId): number => op(world, who, 'arena.myStanding', { game: 'walls', communityId: null }).standing.rating
const coins = (world: World, who: MemberId): number => world.call(who, 'work.career', {}).career.points
const expected = (mine: number, theirs: number): number => 1 / (1 + 10 ** ((theirs - mine) / 400))

// ── 0 The registry ──

const real = ARENA_GAMES.filter(isAvailable)
console.log(`INFO real games installed on this service: ${real.length ? real.map(game => ARENA_GAME_NAME[game]).join(', ') : 'none yet'}`)
for (const game of ARENA_GAMES) if (!isAvailable(game)) console.log(`INFO ${game} is listed as coming soon (${problemWith(game) ?? 'not built yet'})`)
const realWalls = rulesFor('walls')
installRules('walls', lineRules as unknown as Rules)

const ALL_FRIENDS: [MemberId, MemberId][] = [[A, B], [A, C], [B, C]]
const bench = makeWorld()
const { world } = bench
befriend(world, ALL_FRIENDS)

check('1 the hall starts with any subset of games: a missing game is listed as coming soon and cannot be started', () => {
  const restore = installRules('chess', null)
  const games = op(world, A, 'arena.games', {}).games
  assert.deepEqual(games.map(entry => entry.game), ['walls', 'chess', 'words'])
  assert.equal(games.find(entry => entry.game === 'walls')!.available, true)
  assert.equal(games.find(entry => entry.game === 'chess')!.available, false)
  const message = rejects('unavailable', () => op(world, A, 'arena.create', { game: 'chess', opponent: { kind: 'computer', level: 1 }, timeControl: '5+0', rated: false, audience: 'players', communityId: null }))
  assert.match(message, /coming soon/)
  restore()
})

// ── 2–4 A match between two members ──

let firstMatch = '' as ArenaMatchId

check('2 challenge a friend, accept, play, finish: the service names the winner, rates the game and pays the win', () => {
  rejects('forbidden', () => create(world, D, { kind: 'friend', memberId: A }), 'a stranger cannot be challenged directly')
  rejects('invalid', () => create(world, A, { kind: 'friend', memberId: A }))
  const made = create(world, A, { kind: 'friend', memberId: B }, { rated: true })
  firstMatch = made.id
  assert.equal(made.status, 'waiting')
  assert.equal(made.me.role, 'player')
  assert.equal(made.invited?.id, B)
  assert.equal(inbox(world, B, 'arena.challenge', made.id).length, 1, 'the invited member is told')
  const theirs = op(world, B, 'arena.mine', {}).matches.find(match => match.id === made.id)!
  assert.equal(theirs.me.role, 'invited')
  assert.equal(theirs.me.canAccept, true)
  rejects('forbidden', () => op(world, C, 'arena.respond', { matchId: made.id, accept: true }), 'only the invited member answers')
  rejects('forbidden', () => get(world, D, made.id), 'a waiting challenge is private')

  const started = op(world, B, 'arena.respond', { matchId: made.id, accept: true }).match
  assert.equal(started.status, 'active')
  assert.equal(started.players.length, 2)
  assert.deepEqual(started.players.map(player => player.member!.id).sort(), [A, B])
  assert.equal(started.players[0]!.rating, ARENA.rating.start)
  assert.equal(started.players[0]!.provisional, true)
  assert.equal(inbox(world, B, 'arena.challenge', made.id)[0]!.state, 'resolved', 'the answered invitation stops asking')
  assert.ok(arenaEvents(bench, A, made.id).length >= 1, 'the host is pushed the started match')
  assert.equal(op(world, B, 'arena.respond', { matchId: made.id, accept: true }).match.status, 'active', 'answering twice changes nothing')

  const coinsBefore = coins(world, A)
  const done = playOut(world, made.id, A, B)
  assert.equal(done.match.status, 'finished')
  const seatA = done.match.me.seat!
  assert.deepEqual(done.match.outcome!.winners, [seatA])
  assert.equal(done.match.outcome!.text, 'Ada made three in a row.', 'seat names are written into the outcome')
  assert.equal(done.match.turn, null)
  assert.deepEqual(done.moves.map(line => line.n), done.moves.map((_, index) => index + 1))
  assert.match(done.moves[0]!.text, /^Square \d$/)
  assert.equal(done.match.players[seatA]!.ratingChange, 20)
  assert.equal(done.match.players[1 - seatA]!.ratingChange, -20)
  assert.equal(done.match.players[seatA]!.coins, ARENA.pay.human)
  assert.equal(coins(world, A) - coinsBefore, ARENA.pay.human)
  assert.equal(done.match.players[1 - seatA]!.coins, null, 'a loss pays nothing')
  rejects('conflict', () => op(world, A, 'arena.move', { matchId: made.id, moveNumber: done.match.moveCount, move: { cell: 7 } }), 'a finished game takes no more moves')
})

check('3 illegal, malformed, out-of-turn and outsider moves are refused and change nothing', () => {
  const matchId = begin(world, A, B)
  const start = get(world, A, matchId)
  const order: [MemberId, MemberId] = start.match.me.seat === 0 ? [A, B] : [B, A]
  rejects('conflict', () => op(world, order[1], 'arena.move', { matchId, moveNumber: 0, move: { cell: 0 } }), 'not their turn')
  rejects('invalid', () => op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 99 } }))
  rejects('invalid', () => op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: 'top left' }))
  rejects('forbidden', () => op(world, C, 'arena.move', { matchId, moveNumber: 0, move: { cell: 0 } }), 'not a player')
  op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 0 } })
  const taken = rejects('conflict', () => op(world, order[1], 'arena.move', { matchId, moveNumber: 1, move: { cell: 0 } }))
  assert.equal(taken, 'That square is taken.', 'the game\'s own reason reaches the player')
  const after = get(world, A, matchId)
  assert.equal(after.match.moveCount, 1)
  assert.deepEqual(cells(after).filter(cell => cell !== null), [0])
  op(world, A, 'arena.resign', { matchId })
})

check('4 a move sent again with the same number is a no-op; a different move with a used number is refused', () => {
  const matchId = begin(world, A, B)
  const order: [MemberId, MemberId] = seatIn(world, A, matchId) === 0 ? [A, B] : [B, A]
  const first = op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 4 } })
  assert.equal(first.repeat, false)
  const again = op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 4 } })
  assert.equal(again.repeat, true)
  assert.equal(again.match.moveCount, 1)
  rejects('conflict', () => op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 5 } }), 'stale')
  rejects('conflict', () => op(world, order[1], 'arena.move', { matchId, moveNumber: 5, move: { cell: 5 } }), 'ahead of the game')
  op(world, order[1], 'arena.move', { matchId, moveNumber: 1, move: { cell: 0 } })
  const late = op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 4 } })
  assert.equal(late.repeat, true, 'still a repeat after the reply has been played')
  assert.equal(late.match.moveCount, 2)
  assert.equal(arenaEvents(bench, order[1], matchId).filter(event => event.moves.length > 0).length, 2, 'watchers of the wire saw two moves, not three')
  op(world, A, 'arena.resign', { matchId })
})

// ── 5–6 Clocks ──

check('5 clocks run on the service\'s time: free first moves, increment, flag fall loses on time', () => {
  pace = 0
  const matchId = begin(world, A, B, { timeControl: '3+2' })
  const order: [MemberId, MemberId] = seatIn(world, A, matchId) === 0 ? [A, B] : [B, A]
  let seen = get(world, A, matchId)
  assert.equal(seen.match.clock.counting, false, 'no time is spent before the first moves')
  assert.ok(seen.match.clock.callsOffAt)
  now += 30 * SECOND
  op(world, order[0], 'arena.move', { matchId, moveNumber: 0, move: { cell: 0 } })
  now += 30 * SECOND
  seen = op(world, order[1], 'arena.move', { matchId, moveNumber: 1, move: { cell: 3 } })
  assert.deepEqual(seen.match.players.map(player => player.clockMs), [180_000, 180_000])
  assert.equal(seen.match.clock.counting, true)
  assert.equal(seen.match.clock.seat, 0)
  now += 10 * SECOND
  seen = op(world, order[0], 'arena.move', { matchId, moveNumber: 2, move: { cell: 1 } })
  assert.equal(seen.match.players[0]!.clockMs, 180_000 - 10_000 + 2_000, 'time spent, then the increment')
  now += 5 * SECOND
  seen = op(world, order[1], 'arena.move', { matchId, moveNumber: 3, move: { cell: 8 } })
  assert.equal(seen.match.players[1]!.clockMs, 177_000)
  assert.equal(Date.parse(seen.match.clock.since!), now)
  wait(world, 171 * SECOND)
  assert.equal(get(world, A, matchId).match.status, 'active', 'one second left')
  wait(world, 2 * SECOND)
  const flagged = get(world, A, matchId)
  assert.equal(flagged.match.status, 'finished')
  assert.equal(flagged.match.outcome!.reason, 'time')
  assert.deepEqual(flagged.match.outcome!.winners, [1])
  assert.equal(flagged.match.players[0]!.clockMs, 0)
  assert.equal(flagged.match.outcome!.text, `${order[0] === A ? 'Ada' : 'Ben'} ran out of time.`)
  assert.equal(arenaEvents(bench, order[1], matchId).at(-1)!.match.status, 'finished', 'the result is pushed, not polled')

  // A move that arrives after the flag has fallen is too late, even before any tick has noticed.
  const lateId = begin(world, A, B, { timeControl: '5+0' })
  fourPlies(world, lateId, A, B)
  const mover = get(world, A, lateId).match.turn === seatIn(world, A, lateId) ? A : B
  now += 301 * SECOND
  rejects('conflict', () => op(world, mover, 'arena.move', { matchId: lateId, moveNumber: 4, move: { cell: 6 } }))
  assert.equal(get(world, A, lateId).match.outcome!.reason, 'time')

  // Daily: a full day for every move.
  const dailyId = begin(world, A, B, { timeControl: 'daily' })
  fourPlies(world, dailyId, A, B)
  wait(world, 23 * HOUR)
  assert.equal(get(world, A, dailyId).match.status, 'active')
  wait(world, 2 * HOUR)
  assert.equal(get(world, A, dailyId).match.outcome!.reason, 'time')
  pace = 100
})

check('6 abandoned before it began: no first move in two minutes calls the game off, and nothing is counted', () => {
  const before = rating(world, A)
  const matchId = begin(world, A, B, { rated: true })
  wait(world, (ARENA.firstMoveSeconds - 5) * SECOND)
  assert.equal(get(world, A, matchId).match.status, 'active')
  wait(world, 10 * SECOND)
  const off = get(world, A, matchId)
  assert.equal(off.match.status, 'aborted')
  assert.equal(off.match.outcome, null)
  assert.match(off.match.endText!, /did not make a first move in time/)
  assert.equal(rating(world, A), before)
})

// ── 7–9 Resign, draw, rematch ──

check('7 resign: the other player wins; resigning before two moves each calls the game off instead', () => {
  const matchId = begin(world, B, C)
  fourPlies(world, matchId, B, C)
  const resigned = op(world, B, 'arena.resign', { matchId })
  assert.equal(resigned.match.status, 'finished')
  assert.equal(resigned.match.outcome!.reason, 'resigned')
  assert.deepEqual(resigned.match.outcome!.winners, [1 - resigned.match.me.seat!])
  assert.equal(resigned.match.outcome!.text, 'Ben resigned.')
  rejects('forbidden', () => op(world, A, 'arena.resign', { matchId }), 'only a player resigns')

  const earlyId = begin(world, B, C, { rated: true })
  step(world, earlyId, [B, C], [[0], [3]])
  const early = op(world, C, 'arena.resign', { matchId: earlyId })
  assert.equal(early.match.status, 'aborted')
  assert.equal(early.match.players.every(player => player.ratingChange === null && player.coins === null), true)
})

check('8 draw: offer, decline, accept; playing on declines; no second offer on the same move; the computer never agrees', () => {
  const matchId = begin(world, A, B)
  fourPlies(world, matchId, A, B)
  const seatA = seatIn(world, A, matchId)
  rejects('conflict', () => op(world, B, 'arena.draw', { matchId, action: 'accept' }), 'nothing to accept yet')
  assert.equal(op(world, A, 'arena.draw', { matchId, action: 'offer' }).match.drawOffer, seatA)
  assert.equal(arenaEvents(bench, B, matchId).at(-1)!.match.drawOffer, seatA, 'the other player is pushed the offer')
  rejects('conflict', () => op(world, A, 'arena.draw', { matchId, action: 'accept' }), 'you cannot accept your own offer')
  assert.equal(op(world, B, 'arena.draw', { matchId, action: 'decline' }).match.drawOffer, null)
  rejects('conflict', () => op(world, A, 'arena.draw', { matchId, action: 'offer' }), 'not twice on one move')
  // Next move: B offers, A plays on, which answers "no".
  step(world, matchId, [A, B], [[0, 1, 6], [3, 8, 2]])
  const offerer = get(world, A, matchId).match.turn === seatA ? B : A
  const other = offerer === A ? B : A
  assert.notEqual(op(world, offerer, 'arena.draw', { matchId, action: 'offer' }).match.drawOffer, null)
  const played = step(world, matchId, [A, B], [[0, 1, 6], [3, 8, 2]])
  assert.equal(played.match.drawOffer, null, 'a move by the other player declines')
  op(world, other, 'arena.draw', { matchId, action: 'offer' })
  const agreed = op(world, offerer, 'arena.draw', { matchId, action: 'accept' })
  assert.equal(agreed.match.status, 'finished')
  assert.equal(agreed.match.outcome!.draw, true)
  assert.equal(agreed.match.outcome!.reason, 'agreed')
  assert.deepEqual(agreed.match.players.map(player => player.coins), [null, null], 'a draw pays nothing')

  const machine = create(world, A, { kind: 'computer', level: 2 })
  rejects('conflict', () => op(world, A, 'arena.draw', { matchId: machine.id, action: 'offer' }))
  op(world, A, 'arena.resign', { matchId: machine.id })
})

check('9 rematch: same settings, seats swapped; the other player asking too is the acceptance', () => {
  const matchId = begin(world, A, C, { timeControl: '10+5', audience: 'friends' })
  rejects('conflict', () => op(world, A, 'arena.rematch', { matchId }), 'not while it is being played')
  const done = playOut(world, matchId, C, A)
  const seatC = seatIn(world, C, matchId)
  const asked = op(world, C, 'arena.rematch', { matchId }).match
  assert.equal(asked.status, 'waiting')
  assert.equal(asked.invited?.id, A)
  assert.equal(asked.timeControl, '10+5')
  assert.equal(asked.audience, 'friends')
  assert.equal(asked.rematchOf, matchId)
  assert.equal(inbox(world, A, 'arena.challenge', asked.id).length, 1)
  assert.equal(get(world, A, matchId).match.rematch, asked.id, 'the finished game points at its rematch')
  assert.equal(op(world, C, 'arena.rematch', { matchId }).match.id, asked.id, 'asking twice makes one rematch')
  const accepted = op(world, A, 'arena.rematch', { matchId }).match
  assert.equal(accepted.id, asked.id)
  assert.equal(accepted.status, 'active')
  assert.equal(seatIn(world, C, asked.id), 1 - seatC, 'seats swap')
  rejects('forbidden', () => op(world, B, 'arena.rematch', { matchId }), 'only the players')
  assert.equal(done.match.status, 'finished')
  op(world, A, 'arena.resign', { matchId: asked.id })
})

// ── 10 The computer ──

check('10 the computer plays on the service\'s own tick after a short pause, finishes a game, is never rated, and its coin reward is capped per day', () => {
  // The morning of the next UTC day, so the day's coin cap is counted inside one day.
  now = (Math.floor(now / DAY) + 1) * DAY + 9 * HOUR
  const ratingBefore = rating(world, A)
  const first = create(world, A, { kind: 'computer', level: 2 }, { rated: true })
  assert.equal(first.status, 'active', 'no waiting: one person can play right now')
  assert.equal(first.rated, false, 'a game against the computer is never rated, whatever was asked')
  assert.equal(first.me.seat, 0)
  assert.equal(first.players[1]!.computer, 2)
  assert.equal(first.players[1]!.name, 'Computer (medium)')
  assert.equal(first.players[1]!.member, null)
  let seen: ArenaDetail = op(world, A, 'arena.move', { matchId: first.id, moveNumber: 0, move: { cell: 0 } })
  assert.equal(seen.match.moveCount, 1, 'the computer does not answer inside the member\'s own request')
  world.tick()
  assert.equal(get(world, A, first.id).match.moveCount, 1, 'nor in the same instant')
  wait(world, 2 * SECOND)
  seen = get(world, A, first.id)
  assert.equal(seen.match.moveCount, 2, 'it answers on a later tick')
  assert.equal(seen.moves[1]!.seat, 1)
  assert.equal(arenaEvents(bench, A, first.id).at(-1)!.moves[0]!.n, 2, 'and its move is pushed to the player')
  // Play it out: the member takes the first free square each time; the computer wins or the board fills.
  for (let guard = 0; guard < 12 && seen.match.status === 'active'; guard++) {
    if (seen.match.turn === 0) seen = op(world, A, 'arena.move', { matchId: first.id, moveNumber: seen.match.moveCount, move: { cell: cells(seen).indexOf(null) } })
    else { wait(world, 2 * SECOND); seen = get(world, A, first.id) }
  }
  assert.equal(seen.match.status, 'finished', 'the computer finishes a game')
  assert.ok(seen.match.outcome!.draw || seen.match.outcome!.winners[0] === 1)
  assert.equal(seen.match.players[0]!.ratingChange, null)
  assert.equal(rating(world, A), ratingBefore)

  // Beating the easy computer pays a little, up to the day's cap.
  const beatEasy = (): ArenaDetail => {
    wait(world, 6 * SECOND)
    const made = create(world, A, { kind: 'computer', level: 1 })
    let at = get(world, A, made.id)
    for (const cell of [0, 1, 2]) {
      at = op(world, A, 'arena.move', { matchId: made.id, moveNumber: at.match.moveCount, move: { cell } })
      if (at.match.status === 'active') { wait(world, 2 * SECOND); at = get(world, A, made.id) }
    }
    assert.equal(at.match.status, 'finished')
    assert.deepEqual(at.match.outcome!.winners, [0])
    return at
  }
  const coinsBefore = coins(world, A)
  const wins = ARENA.pay.dailyCap.computer / ARENA.pay.computer[0]!
  for (let game = 0; game < wins; game++) assert.equal(beatEasy().match.players[0]!.coins, ARENA.pay.computer[0])
  assert.equal(coins(world, A) - coinsBefore, ARENA.pay.dailyCap.computer)
  assert.equal(beatEasy().match.players[0]!.coins, 0, 'the cap is reached: the win is recorded, nothing more is paid')
  assert.equal(coins(world, A) - coinsBefore, ARENA.pay.dailyCap.computer)
  now += DAY
  assert.equal(beatEasy().match.players[0]!.coins, ARENA.pay.computer[0], 'a new day pays again')
  assert.equal(rating(world, A), ratingBefore)
  assert.equal(op(world, A, 'arena.standings', { game: 'walls', scope: 'friends', view: 'week', communityId: null }).standings.me?.weekWins ?? 0, 1, 'computer wins never reach the standings (the one win is the rated game of check 2)')

  // After a rematch the seats swap: the computer moves first, on its own.
  const again = op(world, A, 'arena.rematch', { matchId: seen.match.id }).match
  assert.equal(again.status, 'active')
  assert.equal(again.me.seat, 1)
  wait(world, 2 * SECOND)
  assert.equal(get(world, A, again.id).match.moveCount, 1)
  op(world, A, 'arena.resign', { matchId: again.id })

  // A computer that fails to produce a move gives the game up; the match is never left stuck.
  const broken = create(world, A, { kind: 'computer', level: 3 })
  op(world, A, 'arena.move', { matchId: broken.id, moveNumber: 0, move: { cell: 0 } })
  fixture.breakBot = true
  const keep = console.error
  console.error = () => undefined
  try { wait(world, 2 * SECOND) } finally { console.error = keep; fixture.breakBot = false }
  const gaveUp = get(world, A, broken.id)
  assert.equal(gaveUp.match.status, 'finished')
  assert.equal(gaveUp.match.outcome!.text, 'Computer (hard) could not find a move and resigned.')
})

// ── 11–12 Watching ──

const secretsOf = (matchId: ArenaMatchId): string[] => (world.peek<{ matches: Record<string, { state: LineState }> }>('arena')!.matches[matchId]!.state).secrets

check('11 a watcher gets the spectator view and never a player\'s hidden data; each player gets only their own', () => {
  const matchId = begin(world, A, B)
  const secrets = secretsOf(matchId)
  const seatA = seatIn(world, A, matchId)
  bench.events[C] = []; bench.events[A] = []; bench.events[B] = []
  const watching = op(world, C, 'arena.watch', { matchId })
  assert.equal(watching.match.me.role, 'watcher')
  assert.equal(watching.match.me.seat, null)
  assert.equal((watching.view as LineView).mine, null)
  assert.equal((get(world, A, matchId).view as LineView).mine, secrets[seatA])
  const seenByA = get(world, A, matchId).match.watchers
  assert.equal(seenByA.count, 1)
  assert.equal(seenByA.first[0]!.id, C, 'the players see who is watching, not a bare count')
  fourPlies(world, matchId, A, B)
  const toWatcher = JSON.stringify([watching, bench.events[C], get(world, C, matchId)])
  assert.ok(arenaEvents(bench, C, matchId).length >= 4, 'every move is pushed to the watcher')
  assert.ok(!toWatcher.includes(secrets[0]!) && !toWatcher.includes(secrets[1]!), 'no hidden value reaches a watcher')
  assert.ok(!toWatcher.includes('"secrets"'), 'the raw state is never sent')
  const toA = JSON.stringify([bench.events[A], get(world, A, matchId)])
  assert.ok(toA.includes(secrets[seatA]!) && !toA.includes(secrets[1 - seatA]!), 'a player sees their own hidden value and not the other\'s')
  rejects('forbidden', () => op(world, C, 'arena.move', { matchId, moveNumber: 4, move: { cell: 6 } }))
  op(world, C, 'arena.unwatch', { matchId })
  assert.equal(get(world, A, matchId).match.watchers.count, 0)
  op(world, A, 'arena.resign', { matchId })
  assert.equal((op(world, C, 'arena.get', { matchId }).view as LineView).mine, null, 'still hidden once the game is over')
})

let circle = '' as CommunityId

check('12 who may watch is enforced: anyone, friends of a player, one community, players only; a blocked member never', () => {
  circle = op(world, A, 'community.create', { name: 'Board evenings', about: 'probe', topic: 'games', areaLabel: '', visibility: 'public' }).community.id
  op(world, B, 'community.join', { communityId: circle })
  op(world, E, 'community.join', { communityId: circle })

  const closed = begin(world, A, B, { audience: 'players' })
  rejects('forbidden', () => op(world, C, 'arena.watch', { matchId: closed }))
  rejects('forbidden', () => op(world, C, 'arena.get', { matchId: closed }))

  const friendly = begin(world, A, B, { audience: 'friends' })
  assert.equal(op(world, C, 'arena.watch', { matchId: friendly }).match.me.role, 'watcher', 'a friend of a player')
  rejects('forbidden', () => op(world, D, 'arena.watch', { matchId: friendly }), 'a stranger')

  rejects('forbidden', () => create(world, D, { kind: 'computer', level: 1 }, { audience: 'community', communityId: circle }), 'you cannot open a game to a community you are not in')
  const club = begin(world, A, B, { audience: 'community', communityId: circle })
  assert.equal(op(world, E, 'arena.watch', { matchId: club }).match.communityName, 'Board evenings')
  rejects('forbidden', () => op(world, C, 'arena.watch', { matchId: club }), 'a friend who is not in the community')

  const open = begin(world, A, B, { audience: 'anyone' })
  assert.equal(op(world, D, 'arena.watch', { matchId: open }).match.me.role, 'watcher')
  op(world, F, 'arena.watch', { matchId: open })

  // Inviting a friend to watch: told in their inbox, and only when the game is open to them.
  op(world, A, 'arena.invite', { matchId: open, memberId: C })
  const invite = inbox(world, C, 'arena.watch', open)
  assert.equal(invite.length, 1)
  assert.equal(invite[0]!.title, 'Ada invites you to watch Ten Walls')
  assert.match(rejects('conflict', () => op(world, A, 'arena.invite', { matchId: closed, memberId: C })), /only the players can open it/)
  assert.match(rejects('conflict', () => op(world, A, 'arena.invite', { matchId: club, memberId: C })), /one community they are not in/)
  rejects('forbidden', () => op(world, A, 'arena.invite', { matchId: open, memberId: D }), 'friends only')

  const listC = op(world, C, 'arena.live', { game: null }).matches.map(match => match.id)
  assert.ok(listC.includes(friendly) && listC.includes(open) && !listC.includes(closed) && !listC.includes(club))
  assert.equal(listC[0], open, 'most watched first')
  assert.deepEqual(op(world, D, 'arena.live', { game: 'chess' }).matches, [])
  assert.ok(!op(world, A, 'arena.live', { game: null }).matches.some(match => match.id === open), 'your own games are under "mine", not "watch"')

  bench.events[D] = []
  op(world, A, 'member.block', { memberId: D })
  assert.ok(bench.events[D]!.some(event => event.type === 'arena.closed' && event.matchId === open), 'a watcher who is blocked is shown out')
  rejects('forbidden', () => op(world, D, 'arena.watch', { matchId: open }))
  assert.ok(!op(world, D, 'arena.live', { game: null }).matches.some(match => match.id === open))
  assert.equal(get(world, A, open).match.watchers.count, 1)
  op(world, A, 'member.unblock', { memberId: D })
  for (const matchId of [closed, friendly, club, open]) op(world, A, 'arena.resign', { matchId })
})

// ── 13 Chat ──

check('13 chat: players and watchers in one stream with a mark, blocks both ways, rate limit, length cap, focus, audience', () => {
  const matchId = begin(world, A, B, { audience: 'anyone' })
  for (const who of [C, D, E]) op(world, who, 'arena.watch', { matchId })
  for (const who of [A, B, C, D, E]) bench.events[who] = []
  const said = (who: MemberId): string[] => bench.events[who]!.flatMap(event => (event.type === 'arena.chat' && event.matchId === matchId ? [`${event.line.role}:${event.line.text}`] : []))
  const history = (who: MemberId): string[] => get(world, who, matchId).chat.map(line => `${line.role}:${line.text}`)

  const hello = op(world, A, 'arena.chat', { matchId, text: 'Good luck', clientId: 'a1' }).line
  assert.equal(hello.role, 'player')
  assert.equal(hello.mine, true)
  assert.equal(op(world, A, 'arena.chat', { matchId, text: 'Good luck', clientId: 'a1' }).line.id, hello.id, 'a retry is the same line')
  assert.equal(op(world, C, 'arena.chat', { matchId, text: 'Nice opening', clientId: 'c1' }).line.role, 'watching')
  assert.deepEqual(said(B), ['player:Good luck', 'watching:Nice opening'])
  assert.deepEqual(said(D), ['player:Good luck', 'watching:Nice opening'])
  assert.deepEqual(history(E), ['player:Good luck', 'watching:Nice opening'])

  // C blocks D: neither sees the other's lines, live or in the history. Everyone else sees both.
  op(world, C, 'member.block', { memberId: D })
  op(world, D, 'arena.chat', { matchId, text: 'from Dev', clientId: 'd1' })
  op(world, C, 'arena.chat', { matchId, text: 'from Cleo', clientId: 'c2' })
  assert.ok(!said(C).includes('watching:from Dev') && !said(D).includes('watching:from Cleo'))
  assert.ok(said(E).includes('watching:from Dev') && said(E).includes('watching:from Cleo'))
  assert.ok(!history(C).includes('watching:from Dev') && !history(D).includes('watching:from Cleo') && !history(D).includes('watching:Nice opening'))
  op(world, C, 'member.unblock', { memberId: D })

  // Focus: B switches watcher chat off for themselves. Players' lines still arrive.
  const focused = op(world, B, 'arena.focus', { matchId, on: true })
  assert.equal(focused.focus, true)
  assert.deepEqual(focused.chat.map(line => line.role), ['player'])
  bench.events[B] = []
  op(world, E, 'arena.chat', { matchId, text: 'watcher line', clientId: 'e1' })
  op(world, A, 'arena.chat', { matchId, text: 'player line', clientId: 'a2' })
  assert.deepEqual(said(B), ['player:player line'])
  assert.ok(said(A).includes('watching:watcher line'), 'the other player still hears the watchers')
  rejects('forbidden', () => op(world, C, 'arena.focus', { matchId, on: true }), 'focus is for players')
  assert.ok(op(world, B, 'arena.focus', { matchId, on: false }).chat.some(line => line.role === 'watching'))

  rejects('invalid', () => op(world, A, 'arena.chat', { matchId, text: 'x'.repeat(ARENA.chat.maxLength + 1), clientId: 'long' }))
  rejects('invalid', () => op(world, A, 'arena.chat', { matchId, text: '   ', clientId: 'blank' }))
  pace = 0
  for (let n = 0; n < ARENA.chat.perWindow; n++) op(world, F, 'arena.chat', { matchId, text: `burst ${n}`, clientId: `f${n}` })
  rejects('rate_limited', () => op(world, F, 'arena.chat', { matchId, text: 'one too many', clientId: 'f-over' }))
  pace = 100

  const closed = begin(world, B, C, { audience: 'players' })
  rejects('forbidden', () => op(world, A, 'arena.chat', { matchId: closed, text: 'let me in', clientId: 'x1' }), 'outside the audience')
  rejects('forbidden', () => op(world, A, 'arena.chatHistory', { matchId: closed, before: null }))
  op(world, B, 'arena.chat', { matchId: closed, text: 'just us', clientId: 'b1' })
  assert.deepEqual(op(world, C, 'arena.chatHistory', { matchId: closed, before: null }).lines.map(line => line.text), ['just us'])
  op(world, B, 'arena.resign', { matchId: closed })

  // History is kept with the match and pages backwards.
  op(world, A, 'arena.resign', { matchId })
  now += MINUTE
  for (let n = 0; n < ARENA.chat.page + 5; n++) { now += 5 * SECOND; op(world, A, 'arena.chat', { matchId, text: `after ${n}`, clientId: `late${n}` }) }
  const latest = get(world, D, matchId)
  assert.equal(latest.chat.length, ARENA.chat.page)
  assert.equal(latest.chatMore, true)
  const older = op(world, D, 'arena.chatHistory', { matchId, before: latest.chat[0]!.id })
  assert.ok(older.lines.length > 0 && older.lines.at(-1)!.at <= latest.chat[0]!.at)
})

// ── 14–15 Ratings and coins ──

check('14 ratings: Elo, start 1200, K 40 while new; only rated games between two members move them; provisional until 5 games', () => {
  const fresh = makeWorld().world
  befriend(fresh, [[A, B], [A, C], [B, C]])
  const standing = (who: MemberId) => op(fresh, who, 'arena.myStanding', { game: 'walls', communityId: null }).standing
  assert.equal(standing(A).rating, 1200)
  assert.equal(standing(A).provisional, true)

  let a = 1200, b = 1200
  const rated = (winner: MemberId | null): ArenaDetail => {
    wait(fresh, 10 * SECOND)
    const matchId = begin(fresh, A, B, { rated: true })
    if (winner) return playOut(fresh, matchId, winner, winner === A ? B : A)
    fourPlies(fresh, matchId, A, B)
    op(fresh, A, 'arena.draw', { matchId, action: 'offer' })
    return op(fresh, B, 'arena.draw', { matchId, action: 'accept' })
  }
  const settle = (scoreA: number): void => {
    const changeA = Math.round(40 * (scoreA - expected(a, b))), changeB = Math.round(40 * ((1 - scoreA) - expected(b, a)))
    a += changeA; b += changeB
  }
  rated(A); settle(1)
  assert.deepEqual([standing(A).rating, standing(B).rating], [1220, 1180])
  rated(A); settle(1)
  assert.deepEqual([standing(A).rating, standing(B).rating], [a, b])
  assert.deepEqual([a, b], [1238, 1162], 'the favourite gains less for the same win')
  const drawn = rated(null); settle(0.5)
  assert.deepEqual([standing(A).rating, standing(B).rating], [a, b])
  assert.equal(drawn.match.players[drawn.match.me.seat!]!.ratingChange, 4, 'a draw moves points to the lower-rated player')

  // Casual and computer games leave ratings alone.
  wait(fresh, 10 * SECOND)
  const casual = playOut(fresh, begin(fresh, A, C, { rated: false }), C, A)
  assert.deepEqual(casual.match.players.map(player => player.ratingChange), [null, null])
  assert.equal(standing(A).rating, a)
  assert.equal(standing(C).played, 0)

  assert.equal(standing(A).played, 3)
  assert.equal(standing(A).provisional, true)
  rated(B); settle(0)
  assert.equal(standing(A).provisional, true)
  const fifth = rated(B); settle(0)
  assert.equal(fifth.match.forFun, false)
  assert.equal(standing(A).played, 5)
  assert.equal(standing(A).provisional, false, 'settled after five rated games')
  assert.deepEqual([standing(A).won, standing(A).drawn, standing(A).lost], [2, 1, 2])
  assert.deepEqual([standing(A).rating, standing(B).rating], [a, b])

  // The same two members: five counted games a day. The sixth is for fun — no rating, no coins.
  wait(fresh, 10 * SECOND)
  const coinsB = coins(fresh, B)
  const sixthId = begin(fresh, A, B, { rated: true })
  const sixth = playOut(fresh, sixthId, B, A)
  assert.equal(sixth.match.forFun, true)
  assert.equal(sixth.match.rated, false)
  assert.deepEqual(sixth.match.players.map(player => player.ratingChange), [null, null])
  assert.equal(coins(fresh, B), coinsB)
  assert.deepEqual([standing(A).rating, standing(B).rating], [a, b])
  now += DAY
  const nextDay = begin(fresh, A, B, { rated: true })
  assert.equal(get(fresh, A, nextDay).match.forFun, false, 'a new day counts again')
  op(fresh, A, 'arena.resign', { matchId: nextDay })
})

check('15 coins: a win against a member pays 20, a loss or a draw nothing, and a day\'s wins are capped at 100', () => {
  const fresh = makeWorld().world
  befriend(fresh, [[A, B], [A, C]])
  const start = coins(fresh, A), startB = coins(fresh, B)
  for (let game = 0; game < ARENA.countedPairGamesPerDay; game++) {
    wait(fresh, 10 * SECOND)
    assert.equal(playOut(fresh, begin(fresh, A, B), A, B).match.players.find(player => player.member?.id === A)!.coins, ARENA.pay.human)
  }
  assert.equal(coins(fresh, A) - start, ARENA.pay.dailyCap.human)
  assert.equal(coins(fresh, B), startB)
  wait(fresh, 10 * SECOND)
  const capped = playOut(fresh, begin(fresh, A, C), A, C)
  assert.equal(capped.match.forFun, false)
  assert.equal(capped.match.players.find(player => player.member?.id === A)!.coins, 0, 'the daily cap: recorded as a win, nothing more paid')
  assert.equal(coins(fresh, A) - start, ARENA.pay.dailyCap.human)
  const ledger = fresh.call(A, 'travel.state', {}).ledger
  assert.ok(ledger.some(entry => entry.kind === 'game' && entry.text === 'Won Ten Walls against Ben' && entry.amount === ARENA.pay.human), 'each payment is written in the wallet history as earned in a game')
})

// ── 16–17 Standings ──

let weekly: () => void = () => assert.fail('check 16 did not run')
const place = (label: string): CoarseArea => areaFromPlace(STARTER_PLACES.find(entry => entry.label === label)!)

check('16 standings by friends, community, state, country and the world, with the privacy switch and blocks', () => {
  now = Date.UTC(2026, 9, 1, 12)
  const fresh = makeWorld().world
  befriend(fresh, [[A, B], [A, C], [A, D], [A, E], [A, F], [C, D], [E, F], [B, G]])
  // A, B, F, G: Lagos. C: Oyo. D: England. E: Lagos too, but an area saved before regions existed.
  for (const who of [A, B, F, G]) op(fresh, who, 'member.setCurrentArea', { area: place('Yaba, Lagos'), source: 'manual' })
  op(fresh, C, 'member.setCurrentArea', { area: place('Bodija, Ibadan'), source: 'manual' })
  op(fresh, D, 'member.setCurrentArea', { area: place('Camden Town, London'), source: 'manual' })
  const old = areaFromPlace({ label: 'Yaba, Lagos', countryCode: 'NG', anchor: { lat: 6.5095, lon: 3.3711 } })
  assert.equal('region' in old, false)
  op(fresh, E, 'member.setCurrentArea', { area: old, source: 'manual' })
  assert.equal(fresh.call(A, 'member.me', {}).profile.currentArea!.region, 'Lagos', 'the area carries its state')
  assert.equal(fresh.call(E, 'member.me', {}).profile.currentArea!.region, undefined, 'an old area still loads')
  const club = op(fresh, A, 'community.create', { name: 'Yaba board club', about: 'probe', topic: 'games', areaLabel: '', visibility: 'public' }).community.id
  op(fresh, B, 'community.join', { communityId: club })
  op(fresh, G, 'community.join', { communityId: club })

  const win = (winner: MemberId, loser: MemberId): void => { wait(fresh, 20 * SECOND); playOut(fresh, begin(fresh, winner, loser, { rated: true }), winner, loser) }
  win(A, B); win(C, D); win(A, C); win(G, B); win(E, F)
  // A 1240 · E 1220 · G 1219 · C 1200 (2 games) · D 1180 (earlier) · F 1180 (later) · B 1161

  const table = (who: MemberId, scope: StandingScope, communityId: CommunityId | null = null) => op(fresh, who, 'arena.standings', { game: 'walls', scope, view: 'rating', communityId }).standings
  const ids = (who: MemberId, scope: StandingScope, communityId: CommunityId | null = null): MemberId[] => table(who, scope, communityId).rows.map(row => row.memberId)

  const world_ = table(A, 'global')
  assert.deepEqual(world_.rows.map(row => row.memberId), [A, E, G, C, D, F, B], 'everybody, by rating; ties by games played, then who got there first')
  assert.deepEqual(world_.rows.map(row => row.rating), [1240, 1220, 1219, 1200, 1180, 1180, 1161])
  assert.deepEqual(world_.rows.map(row => row.rank), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(world_.scopeName, null)
  assert.equal(world_.total, 7)
  assert.equal(world_.me!.rank, 1)
  assert.deepEqual([table(B, 'global').me!.rank, table(B, 'global').total], [7, 7], 'you are #7 of 7, wherever you are')
  assert.equal(table(B, 'global').me!.isMe, true)

  const country = table(A, 'country')
  assert.equal(country.scopeName, 'Nigeria')
  assert.deepEqual(country.rows.map(row => row.memberId), [A, E, G, C, F, B])
  assert.equal(table(D, 'country').scopeName, 'United Kingdom')
  assert.deepEqual(ids(D, 'country'), [D])

  const state = table(A, 'state')
  assert.equal(state.scopeName, 'Lagos')
  assert.deepEqual(state.rows.map(row => row.memberId), [A, E, G, F, B], 'Lagos includes an exact legacy starter match, but not Oyo')
  assert.equal(table(C, 'state').scopeName, 'Oyo')
  assert.deepEqual(ids(C, 'state'), [C])
  assert.equal(table(D, 'state').scopeName, 'England')

  assert.equal(table(E, 'state').scopeName, 'Lagos', 'known starter metadata restores the old member without reconfirming location')
  assert.equal(fresh.call(E, 'member.me', {}).profile.currentArea!.region, undefined, 'standings recovery does not rewrite the member profile')
  const unknown = 'm_unknown_region' as MemberId
  fresh.scoped(() => ensureMember(fresh, unknown, 'Unknown region probe'))
  op(fresh, unknown, 'member.setCurrentArea', { area: { ...old, label: 'Unlisted neighbourhood' }, source: 'manual' })
  const stateless = table(unknown, 'state')
  assert.deepEqual(stateless.rows, [])
  assert.equal(stateless.note, 'Set your area again to join your state’s standings.')
  assert.equal(table(E, 'country').me!.rank, 2, 'country and global still include them')

  assert.deepEqual(ids(A, 'friends'), [A, E, C, D, F, B], 'you and your friends')
  assert.deepEqual(ids(G, 'friends'), [G, B])
  const community = table(A, 'community', club)
  assert.equal(community.scopeName, 'Yaba board club')
  assert.deepEqual(community.rows.map(row => row.memberId), [A, G, B])
  rejects('forbidden', () => table(D, 'community', club))
  rejects('forbidden', () => table(A, 'community', null))

  // A row is a name, a portrait and a rating. The scope names the place; no row does.
  const wire = JSON.stringify(world_.rows) + JSON.stringify(state.rows)
  for (const leak of ['Lagos', 'Yaba', 'NG', 'lat', 'lon', 'area', 'region', 'country']) assert.ok(!wire.includes(leak), `a row must not carry "${leak}"`)
  assert.deepEqual(Object.keys(world_.rows[0]!).sort(), ['displayName', 'isMe', 'look', 'memberId', 'played', 'provisional', 'rank', 'rating', 'since', 'weekWins', 'won'])

  const mine = op(fresh, B, 'arena.myStanding', { game: 'walls', communityId: club })
  assert.deepEqual(mine.standing.places.map(entry => [entry.scope, entry.name, entry.rank, entry.of]), [
    ['friends', null, 3, 3], ['community', 'Yaba board club', 3, 3], ['state', 'Lagos', 5, 5], ['country', 'Nigeria', 6, 6], ['global', null, 7, 7],
  ])
  assert.deepEqual(mine.home, { countryCode: 'NG', countryName: 'Nigeria', region: 'Lagos' })
  assert.equal(mine.publicStandings, true, 'shown by default')

  // The switch: G leaves the public tables, stays in friends and community, and still sees their own rating.
  assert.equal(op(fresh, G, 'arena.setPrivacy', { publicStandings: false }).publicStandings, false)
  assert.deepEqual(ids(A, 'global'), [A, E, C, D, F, B])
  assert.deepEqual(ids(A, 'country'), [A, E, C, F, B])
  assert.deepEqual(ids(A, 'state'), [A, E, F, B])
  assert.deepEqual(ids(A, 'community', club), [A, G, B])
  assert.deepEqual(ids(B, 'friends'), [A, G, B])
  const hidden = table(G, 'global')
  assert.equal(hidden.me, null)
  assert.deepEqual(hidden.rows.map(row => row.memberId), [A, E, C, D, F, B])
  assert.equal(hidden.note, 'You are hidden from public standings, so you are not ranked here. Your rating is 1219.')
  assert.equal(op(fresh, G, 'arena.myStanding', { game: 'walls', communityId: null }).standing.rating, 1219)
  assert.equal(op(fresh, G, 'arena.privacy', {}).publicStandings, false)
  op(fresh, G, 'arena.setPrivacy', { publicStandings: true })
  assert.deepEqual(ids(A, 'state'), [A, E, G, F, B])

  // Blocked members do not see each other's rows, in any table.
  op(fresh, A, 'member.block', { memberId: F })
  assert.deepEqual(ids(A, 'global'), [A, E, G, C, D, B])
  assert.deepEqual(ids(F, 'global'), [E, G, C, D, F, B])
  assert.deepEqual(ids(F, 'state'), [E, G, F, B])
  assert.equal(table(F, 'global').me!.rank, 5)
  assert.deepEqual(ids(E, 'global'), [A, E, G, C, D, F, B], 'everyone else sees both')
  op(fresh, A, 'member.unblock', { memberId: F })

  // Reconfirming the same area preserves the recovered standings state.
  op(fresh, E, 'member.setCurrentArea', { area: place('Yaba, Lagos'), source: 'manual' })
  assert.equal(table(E, 'state').scopeName, 'Lagos')
  assert.deepEqual(ids(E, 'state'), [A, E, G, F, B])

  // Someone with no rated game is told how to get on the table, and is not ranked.
  const none = op(fresh, D, 'arena.standings', { game: 'chess', scope: 'global', view: 'rating', communityId: null }).standings
  assert.deepEqual([none.rows.length, none.me, none.note], [0, null, 'Finish a rated game against another member to get on the table.'])

  weekly = () => {
  const week = (who: MemberId, scope: StandingScope) => op(fresh, who, 'arena.standings', { game: 'walls', scope, view: 'week', communityId: null }).standings
  const thisWeek = week(A, 'global')
  assert.equal(thisWeek.week, '2026-W40')
  assert.equal(thisWeek.resetsAt, '2026-10-05T00:00:00.000Z')
  assert.deepEqual(thisWeek.rows.map(row => [row.memberId, row.weekWins]), [[A, 2], [C, 1], [G, 1], [E, 1]], 'most wins first; on a tie, whoever got there first')
  assert.deepEqual(week(A, 'state').rows.map(row => row.memberId), [A, G, E])
  assert.equal(week(B, 'global').note, 'Win a rated game this week to get on the table.')
  now = Date.UTC(2026, 9, 5, 0, 0, 1)
  fresh.tick()
  const nextWeek = week(A, 'global')
  assert.equal(nextWeek.week, '2026-W41')
  assert.deepEqual(nextWeek.rows, [], 'Monday 00:00 UTC: the week starts empty')
  assert.deepEqual(ids(A, 'global'), [A, E, G, C, D, F, B], 'ratings do not reset')
  win(B, A)
  assert.deepEqual(week(A, 'global').rows.map(row => [row.memberId, row.weekWins]), [[B, 1]])
  }
})

check('17 weekly "most wins" is a second view of every table and resets on Monday 00:00 UTC; ratings carry on', () => weekly())

// ── 18 Notifications ──

check('18 notifications: a challenge, your turn in a daily game, a finished game — and none while you are looking at the board', () => {
  now = Date.UTC(2026, 9, 6, 12)
  const fresh = makeWorld().world
  befriend(fresh, [[A, B]])
  const daily = begin(fresh, A, B, { timeControl: 'daily' })
  const order: [MemberId, MemberId] = seatIn(fresh, A, daily) === 0 ? [A, B] : [B, A]
  const turns = (who: MemberId) => inbox(fresh, who, 'arena.turn', daily)
  assert.equal(inbox(fresh, order[0], 'arena.started', daily).length + inbox(fresh, order[1], 'arena.started', daily).length, 1, 'the challenger is told the game began')
  op(fresh, order[0], 'arena.move', { matchId: daily, moveNumber: 0, move: { cell: 0 } })
  assert.equal(turns(order[1]).length, 1)
  assert.match(turns(order[1])[0]!.title, /^Your move in Ten Walls against /)
  assert.equal(turns(order[1])[0]!.link, `/arena/match/${daily}`)
  op(fresh, order[1], 'arena.move', { matchId: daily, moveNumber: 1, move: { cell: 3 } })
  assert.equal(turns(order[1])[0]!.state, 'resolved', 'moving settles your own reminder')
  assert.equal(turns(order[0]).length, 1)
  // order[1] opens the board and stays: no reminder for a move they watch arrive.
  op(fresh, order[1], 'arena.watch', { matchId: daily })
  op(fresh, order[0], 'arena.move', { matchId: daily, moveNumber: 2, move: { cell: 1 } })
  assert.equal(turns(order[1]).filter(entry => entry.state === 'active').length, 0)
  op(fresh, order[1], 'arena.move', { matchId: daily, moveNumber: 3, move: { cell: 8 } })
  op(fresh, order[0], 'arena.move', { matchId: daily, moveNumber: 4, move: { cell: 2 } })
  assert.equal(get(fresh, A, daily).match.status, 'finished')
  assert.equal(inbox(fresh, order[1], 'arena.finished', daily).length, 0, 'looking at the board: no inbox entry')
  assert.equal(inbox(fresh, order[0], 'arena.finished', daily).length, 1, 'not looking: told once')
  assert.match(inbox(fresh, order[0], 'arena.finished', daily)[0]!.title, /^Ten Walls: you won against /)

  // A live game sends no "your turn" reminders at all.
  wait(fresh, 10 * SECOND)
  const live = begin(fresh, A, B)
  fourPlies(fresh, live, A, B)
  assert.equal(inbox(fresh, A, 'arena.turn', live).length + inbox(fresh, B, 'arena.turn', live).length, 0)
  op(fresh, A, 'arena.resign', { matchId: live })
})

// ── 19–21 Finding an opponent, leaving ──

check('19 "find me someone": paired with the next member who wants the same game, time and kind; places lapse and can be given up', () => {
  const fresh = makeWorld()
  const w = fresh.world
  const queue = (who: MemberId, timeControl: TimeControlId, rated = true): ArenaMatch => create(w, who, { kind: 'queue' }, { timeControl, rated })
  const first = queue(A, '5+0')
  assert.equal(first.status, 'waiting')
  assert.equal(first.open, 'queue')
  assert.equal(queue(B, '3+2').status, 'waiting', 'a different time control is a different queue')
  assert.equal(queue(D, '5+0', false).status, 'waiting', 'casual does not meet rated')
  const matched = queue(C, '5+0')
  assert.equal(matched.id, first.id, 'two strangers, no friendship needed')
  assert.equal(matched.status, 'active')
  assert.deepEqual(matched.players.map(player => player.member!.id).sort(), [A, C])
  assert.equal(inbox(w, A, 'arena.started', first.id).length, 1)
  assert.ok(fresh.events[A]!.some(event => event.type === 'arena.match' && event.matchId === first.id), 'the waiting member is pushed the started game')

  const mineB = op(w, B, 'arena.mine', {}).matches[0]!
  assert.equal(op(w, B, 'arena.cancel', { matchId: mineB.id }).match.status, 'cancelled')
  rejects('forbidden', () => op(w, A, 'arena.cancel', { matchId: mineB.id }))

  // Leaving while waiting for a live game gives the place up; nobody is paired with someone who is gone.
  const mineD = op(w, D, 'arena.mine', {}).matches[0]!
  w.disconnect(fresh.links[D]!)
  connect(fresh, D)
  assert.equal(get(w, D, mineD.id).match.status, 'cancelled')
  assert.equal(queue(E, '5+0', false).status, 'waiting')

  const lapsing = queue(F, '10+5')
  wait(w, (ARENA.queueMinutes.live + 1) * MINUTE)
  const lapsed = get(w, F, lapsing.id).match
  assert.equal(lapsed.status, 'expired')
  assert.match(lapsed.endText!, /play the computer/)

  // Blocked members are never paired.
  op(w, G, 'member.block', { memberId: F })
  const waitingG = queue(G, '15+10')
  assert.equal(queue(F, '15+10').id !== waitingG.id, true)
})

check('20 an open challenge to a community: any member of it may take the seat, nobody else', () => {
  const made = create(world, A, { kind: 'community', communityId: circle }, { timeControl: 'daily' })
  assert.equal(made.open, 'community')
  assert.equal(made.communityName, 'Board evenings')
  rejects('forbidden', () => create(world, C, { kind: 'community', communityId: circle }))
  assert.ok(op(world, B, 'arena.mine', {}).open.some(match => match.id === made.id && match.me.canAccept), 'members see it among open challenges')
  assert.ok(!op(world, C, 'arena.mine', {}).open.some(match => match.id === made.id))
  rejects('forbidden', () => op(world, C, 'arena.respond', { matchId: made.id, accept: true }))
  const taken = op(world, E, 'arena.respond', { matchId: made.id, accept: true }).match
  assert.equal(taken.status, 'active')
  assert.deepEqual(taken.players.map(player => player.member!.id).sort(), [A, E])
  rejects('expired', () => op(world, B, 'arena.respond', { matchId: made.id, accept: true }), 'the seat is taken')
  op(world, A, 'arena.resign', { matchId: made.id })
})

check('21 leaving a live game: a short drop is forgiven, staying away past the grace loses; a live challenge waits for both to be here', () => {
  const matchId = begin(world, A, B)
  fourPlies(world, matchId, A, B)
  const seatB = seatIn(world, B, matchId)
  world.disconnect(bench.links[B]!)
  assert.equal(get(world, A, matchId).match.players[seatB]!.connected, false, 'the other player sees the drop')
  wait(world, (ARENA.disconnectGraceSeconds - 10) * SECOND)
  connect(bench, B)
  wait(world, 30 * SECOND)
  assert.equal(get(world, A, matchId).match.status, 'active', 'back within the grace')
  world.disconnect(bench.links[B]!)
  wait(world, (ARENA.disconnectGraceSeconds + 1) * SECOND)
  const left = get(world, A, matchId)
  assert.equal(left.match.status, 'finished')
  assert.equal(left.match.outcome!.reason, 'left')
  assert.deepEqual(left.match.outcome!.winners, [1 - seatB])

  const offered = create(world, B, { kind: 'friend', memberId: A }, { timeControl: '5+0' })
  const message = rejects('conflict', () => op(world, A, 'arena.respond', { matchId: offered.id, accept: true }))
  assert.match(message, /^Ben is not here right now/)
  assert.equal(get(world, A, offered.id).match.status, 'waiting')
  connect(bench, B)
  assert.equal(op(world, A, 'arena.respond', { matchId: offered.id, accept: true }).match.status, 'active')
  op(world, A, 'arena.resign', { matchId: offered.id })
  assert.equal(op(world, A, 'arena.respond', { matchId: begin(world, A, C), accept: true }).match.status, 'active')
})

// ── 22 Restart ──

check('22 a restart resumes a live match with its clocks where they were: the time the service was down is charged to nobody', () => {
  now = Date.UTC(2026, 9, 8, 12)
  pace = 0
  let saved: string | null = null
  const store: Persistence = { load: () => (saved ? JSON.parse(saved) as Record<string, unknown> : null), save: state => { saved = JSON.stringify(state) } }
  const one = makeWorld(store).world
  befriend(one, [[A, B]])
  now += SECOND
  playOut(one, begin(one, A, B, { rated: true }), A, B)
  now += 10 * SECOND
  const matchId = begin(one, A, B, { timeControl: '5+0' })
  now += SECOND
  fourPlies(one, matchId, A, B)
  op(one, A, 'arena.chat', { matchId, text: 'see you after the restart', clientId: 'r1' })
  const pending = create(one, A, { kind: 'friend', memberId: B }, { timeControl: 'daily' })
  const before = get(one, A, matchId)
  const mover = before.match.turn!
  const left = before.match.players[mover]!.clockMs
  wait(one, 20 * SECOND)
  one.flush()
  assert.ok(saved, 'the hall\'s state is in the saved world')

  now += 10 * MINUTE
  const two = makeWorld(store).world
  two.tick()
  const after = get(two, A, matchId)
  assert.equal(after.match.status, 'active', 'ten minutes down did not flag anyone')
  assert.equal(after.match.moveCount, 4)
  assert.deepEqual(cells(after), cells(before))
  assert.equal(after.match.players[mover]!.clockMs, left)
  assert.equal(left - (now - Date.parse(after.match.clock.since!)), left - 20 * SECOND, 'only the 20 seconds played before the stop are charged')
  const moverId = after.match.players[mover]!.member!.id
  const moved = op(two, moverId, 'arena.move', { matchId, moveNumber: 4, move: { cell: 6 } })
  assert.equal(moved.match.players[mover]!.clockMs, left - 20 * SECOND)
  assert.deepEqual(after.chat.map(line => line.text), ['see you after the restart'], 'chat is kept with the match')
  assert.equal(get(two, B, pending.id).match.status, 'waiting', 'an unanswered challenge is still there')
  const table = op(two, A, 'arena.standings', { game: 'walls', scope: 'friends', view: 'rating', communityId: null }).standings
  assert.deepEqual(table.rows.map(row => [row.memberId, row.rating]), [[A, 1220], [B, 1180]], 'ratings and standings survive')
  wait(two, 299 * SECOND)
  assert.equal(get(two, A, matchId).match.status, 'active')
  wait(two, 2 * SECOND)
  assert.equal(get(two, A, matchId).match.outcome?.reason, 'time', 'and the clock still runs out when it should')
  pace = 100
})

// ── 23 The real games, through the hall ──

installRules('walls', realWalls)
for (const game of real) {
  check(`23 ${ARENA_GAME_NAME[game]} (${game}): a whole game through the hall, computer against computer, a watcher following every move`, () => {
    now = Date.UTC(2026, 9, 9, 12)
    const fresh = makeWorld()
    const w = fresh.world
    const rules = rulesFor(game)!
    const made = op(w, A, 'arena.create', { game, opponent: { kind: 'computer', level: 1 }, timeControl: 'daily', rated: false, audience: 'anyone', communityId: null }).match
    op(w, C, 'arena.watch', { matchId: made.id })
    const stateOf = (): unknown => w.peek<{ matches: Record<string, { state: unknown }> }>('arena')!.matches[made.id]!.state
    const random = seededRandom(20261009)
    let slowest = 0
    let seen = get(w, A, made.id)
    for (let ply = 0; ply < 1200 && seen.match.status === 'active'; ply++) {
      if (seen.match.turn === seen.match.me.seat) {
        const started = performance.now()
        const move = rules.bot(stateOf(), seen.match.me.seat!, 2, random)
        slowest = Math.max(slowest, performance.now() - started)
        seen = op(w, A, 'arena.move', { matchId: made.id, moveNumber: seen.match.moveCount, move: JSON.parse(JSON.stringify(move)) })
      } else {
        const started = performance.now()
        wait(w, 2 * SECOND)
        slowest = Math.max(slowest, performance.now() - started)
        const next = get(w, A, made.id)
        assert.ok(next.match.moveCount > seen.match.moveCount || next.match.status !== 'active', 'the computer moved')
        seen = next
      }
    }
    const pushed = fresh.events[C]!.flatMap(event => (event.type === 'arena.match' && event.matchId === made.id ? event.moves : []))
    assert.equal(pushed.length, seen.match.moveCount, 'the watcher was pushed every move, once')
    assert.ok(seen.moves.every(line => line.text.length > 0), 'every move has a line for the move list')
    assert.ok(get(w, C, made.id).view !== null, 'the spectator view is there')
    if (seen.match.status === 'active') {
      console.log(`INFO ${game}: still going after ${seen.match.moveCount} moves; resigned to end the check`)
      seen = op(w, A, 'arena.resign', { matchId: made.id })
    }
    assert.equal(seen.match.status, 'finished')
    assert.ok(seen.match.outcome && !/\{\d\}/.test(seen.match.outcome.text), 'the outcome reads as a sentence with names')
    console.log(`INFO ${game}: ${seen.match.moveCount} moves — ${seen.match.outcome!.text} Slowest single computer move: ${Math.round(slowest)} ms.`)
  })
}

// ── 24 What happens on the tick reaches the disk ──
// The kernel writes again only the slices a scope asked for. A computer move and a flag fall
// happen on the tick, outside any operation, so the hall has to name its slice there — otherwise
// they would wait for the periodic full save and a crash could lose them.
{
  installRules('walls', lineRules as unknown as Rules)
  now = Date.UTC(2026, 9, 10, 12)
  let written = ''
  const store: Persistence = { load: () => null, save: () => undefined, write: async text => { written = text } }
  const w = makeWorld(store).world
  const made = create(w, A, { kind: 'computer', level: 2 })
  op(w, A, 'arena.move', { matchId: made.id, moveNumber: 0, move: { cell: 0 } })
  await new Promise(resolve => setTimeout(resolve, 400))
  const movesOnDisk = (): number => (JSON.parse(written) as { arena: { matches: Record<string, { moves: unknown[] }> } }).arena.matches[made.id]!.moves.length
  const first = movesOnDisk()
  wait(w, 2 * SECOND)
  await new Promise(resolve => setTimeout(resolve, 400))
  check('24 a move the computer makes on the tick is written to disk with the next save, not left for the periodic full one', () => {
    assert.equal(first, 1)
    assert.equal(get(w, A, made.id).match.moveCount, 2)
    assert.equal(movesOnDisk(), 2)
  })
  installRules('walls', realWalls)
}

if (!failed) console.log('ALL PASS')
