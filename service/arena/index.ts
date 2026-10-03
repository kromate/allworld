// The game hall: live matches of any game that implements `Rules`, with clocks, the computer as
// an opponent, watching, chat, ratings and standings.
//
// The service is the only judge. It holds each game's full state, applies every move through the
// game's rules, plays the computer's moves itself, keeps the clocks on its own time, and sends
// each member only what `Rules.view` says their seat (or a spectator) may see.
import { performance } from 'node:perf_hooks'
import type { CommunityId, MemberId } from '../../src/shared/ids.ts'
import { iso, newId } from '../../src/shared/ids.ts'
import {
  ARENA, ARENA_AUDIENCES, ARENA_GAMES, ARENA_GAME_NAME, COMPUTER_LEVEL_NAME, STANDING_SCOPES, TIME_CONTROL_IDS, timeControl,
} from '../../src/shared/arena.ts'
import type {
  ArenaChatLine, ArenaDetail, ArenaGame, ArenaMatch, ArenaMatchId, ArenaMoveLine, ArenaOpponent, ArenaOutcome, ArenaPlayer,
  Outcome, Rules,
} from '../../src/shared/arena.ts'
import { WorldError } from '../../src/shared/model.ts'
import type { PublicMember } from '../../src/shared/model.ts'
import { seededRandom } from '../../src/shared/play.ts'
import type { World } from '../kernel.ts'
import { areFriends, exists, isBlockedEitherWay, lookFor, onBlock, record, tryPublicMember } from '../members.ts'
import { emit, settle } from '../notify.ts'
import { bool, empty, id, num, obj, oneOf, optId, optOneOf, str } from '../parse.ts'
import type { Raw } from '../parse.ts'
import { communitiesOf, communityName, isCommunityMember } from '../social.ts'
import { isAvailable, rulesFor } from './registry.ts'
import {
  countPairGame, homeView, isProvisional, isPublic, myStanding, pairGamesToday, payWin, ratingOf, setPublic, settleRatings, standings,
} from './standings.ts'
import { DAY, HOUR, MINUTE, arena, runtime } from './state.ts'
import type { ArenaSlice, ChatRec, MatchRec, OpponentRec, SeatRec } from './state.ts'

const SECOND = 1000
const linkOf = (matchId: ArenaMatchId): string => `/arena/match/${matchId}`
const randomSeed = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!
const nameOf = (world: World, memberId: MemberId): string => record(world, memberId).profile.displayName
const computerName = (level: 1 | 2 | 3): string => `Computer (${COMPUTER_LEVEL_NAME[level].toLowerCase()})`
const isRulesError = (error: unknown): error is Error => error instanceof Error && error.constructor.name === 'RulesError'

/** Same keys in any order are the same move. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Raw)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function need(game: ArenaGame): Rules {
  const rules = rulesFor(game)
  if (!rules) throw new WorldError('unavailable', `${ARENA_GAME_NAME[game]} is not open yet. It is coming soon.`)
  return rules
}

/** Run a call into a game's rules: a refused move becomes a plain refusal, anything else an honest failure. */
function ruled<T>(run: () => T, code: 'invalid' | 'conflict'): T {
  try { return run() } catch (error) {
    if (isRulesError(error)) throw new WorldError(code, error.message || 'That move is not allowed.')
    console.error('[arena] a game\'s rules failed', error)
    throw new WorldError('unavailable', 'That move could not be played. Try again.')
  }
}

function findMatch(world: World, matchId: ArenaMatchId): MatchRec {
  const found = arena(world).matches[matchId]
  if (!found) throw new WorldError('not_found', 'That game was not found.')
  return found
}

/**
 * Who may play for a rating. Everyone, unless another module narrows it (guests.ts: a guest has
 * no account for a rating to belong to). A match that would seat someone who may not is casual:
 * it is created unrated, and it cannot become rated by being joined, accepted or replayed.
 */
let ratedOpenTo: (world: World, memberId: MemberId) => boolean = () => true
export function setRatedRule(rule: typeof ratedOpenTo): void { ratedOpenTo = rule }

/** The terms a match is played on, from its record, for a module that decides who may enter it. Read-only. */
export function matchTerms(world: World, matchId: string): { rated: boolean; audience: MatchRec['audience']; communityId: CommunityId | null } | null {
  const matches = world.peek<ArenaSlice>('arena')?.matches
  const m = matches && Object.hasOwn(matches, matchId) ? matches[matchId] : undefined
  if (!m) return null
  return { rated: m.rated, audience: m.audience, communityId: m.communityId ?? (m.opponent.kind === 'community' ? m.opponent.communityId : null) }
}

// ── Who is who ──

const seatOf = (m: MatchRec, memberId: MemberId): number => m.seats.findIndex(seat => seat.member === memberId)
const humans = (m: MatchRec): MemberId[] => (m.seats.length ? m.seats.flatMap(seat => (seat.member ? [seat.member] : [])) : [m.host])
const isLive = (m: MatchRec): boolean => !timeControl(m.timeControl).daily
const invitedOf = (m: MatchRec): MemberId | null => (m.status === 'waiting' && m.opponent.kind === 'member' ? m.opponent.memberId : null)
const isParticipant = (m: MatchRec, memberId: MemberId): boolean => m.host === memberId || seatOf(m, memberId) >= 0 || invitedOf(m) === memberId
const hasBoard = (m: MatchRec): boolean => m.status === 'active' || m.status === 'finished' || m.status === 'aborted'

/**
 * A change to what this match shows anyone is a new revision. Every snapshot and event carries it,
 * so a page can tell which of two is newer: an answer waits for its change to be saved, and what is
 * pushed meanwhile is newer than it, at the same move and in the same millisecond.
 * Called where a change is published: `pushMatch` (everything on the board and around it), the end
 * of a match that never had a board, a chat line, a player's own watcher-chat switch. Never by a
 * request that only reads. It orders, and decides nothing.
 */
const advance = (m: MatchRec): number => ++m.rev

/**
 * The rematch asked for after this game, as it stands for one of its players. An offer that was
 * withdrawn or lapsed is gone: either player may ask again. One that was declined is gone for the
 * player who declined (they may ask after all) and stands for the one who asked: the answer was no.
 */
function rematchFor(world: World, m: MatchRec, viewer: MemberId): MatchRec | null {
  const next = m.rematch ? arena(world).matches[m.rematch] : undefined
  if (!next || next.status === 'cancelled' || next.status === 'expired') return null
  return next.status === 'declined' && next.host !== viewer ? null : next
}

/** Watching rule: the match has a board, the member is not blocked either way with a player, and the audience includes them. */
function mayWatch(world: World, viewer: MemberId, m: MatchRec): boolean {
  if (!hasBoard(m) || !m.seats.length || !exists(world, viewer)) return false
  const players = humans(m)
  if (players.some(player => isBlockedEitherWay(world, viewer, player))) return false
  if (m.audience === 'anyone') return true
  if (m.audience === 'friends') return players.some(player => areFriends(world, viewer, player))
  if (m.audience === 'community') return m.communityId !== null && isCommunityMember(world, m.communityId, viewer)
  return false
}

const mayTake = (world: World, viewer: MemberId, m: MatchRec): boolean =>
  m.status === 'waiting' && m.opponent.kind === 'community' && viewer !== m.host
  && isCommunityMember(world, m.opponent.communityId, viewer) && !isBlockedEitherWay(world, viewer, m.host)

function maySee(world: World, viewer: MemberId, m: MatchRec): boolean {
  return isParticipant(m, viewer) || mayTake(world, viewer, m) || mayWatch(world, viewer, m)
}

const presentIn = (world: World, m: MatchRec): Set<MemberId> => runtime(world).present.get(m.id) ?? new Set()
const isLooking = (world: World, m: MatchRec, memberId: MemberId): boolean => presentIn(world, m).has(memberId)
const watchersOf = (world: World, m: MatchRec): MemberId[] => [...presentIn(world, m)].filter(memberId => seatOf(m, memberId) < 0 && memberId !== m.host)

// ── Turn and clock ──

function turnOf(m: MatchRec): number | null {
  if (m.status !== 'active' || m.outcome) return null
  const rules = rulesFor(m.game)
  if (!rules) return null
  try { return rules.turn(m.state) } catch (error) { console.error('[arena] turn failed', error); return null }
}

/** Live games do not spend time until every player has made a first move. */
const counting = (m: MatchRec): boolean => m.moves.length >= m.seats.length

/** When the player to move runs out: `first` calls the game off, `flag` loses it on time. */
function deadlineOf(m: MatchRec): { at: number; kind: 'first' | 'flag'; seat: number } | null {
  const seat = turnOf(m)
  if (seat === null || m.turnStartedAt === null) return null
  if (!counting(m)) return { at: m.turnStartedAt + (isLive(m) ? ARENA.firstMoveSeconds * SECOND : timeControl(m.timeControl).baseMs), kind: 'first', seat }
  return { at: m.turnStartedAt + (m.clocks[seat] ?? 0), kind: 'flag', seat }
}

// ── Views ──

function seatName(world: World, viewer: MemberId | null, seat: SeatRec): string {
  if (seat.computer) return computerName(seat.computer)
  if (!seat.member || !exists(world, seat.member)) return 'A member'
  if (viewer && isBlockedEitherWay(world, viewer, seat.member)) return 'A member'
  return nameOf(world, seat.member)
}

const named = (text: string, names: string[]): string => text.replace(/\{(\d+)\}/g, (_, n: string) => names[Number(n)] ?? 'A player')

function playerView(world: World, viewer: MemberId, m: MatchRec, seat: SeatRec, index: number): ArenaPlayer {
  const member = seat.member ? tryPublicMember(world, viewer, seat.member) : null
  return {
    seat: index, member, computer: seat.computer, name: seatName(world, viewer, seat), rating: seat.before, provisional: seat.provisional,
    ratingChange: seat.change, coins: seat.coins, clockMs: Math.max(0, Math.round(m.clocks[index] ?? 0)),
    connected: seat.member ? world.isOnline(seat.member) : true,
  }
}

function outcomeView(world: World, viewer: MemberId, m: MatchRec): ArenaOutcome | null {
  if (!m.outcome) return null
  const names = m.seats.map(seat => seatName(world, viewer, seat))
  return { winners: [...m.outcome.winners], draw: m.outcome.draw, reason: m.outcome.reason, text: named(m.outcome.text, names), scores: [...m.outcome.scores] }
}

function matchView(world: World, viewer: MemberId, m: MatchRec): ArenaMatch {
  const mySeat = seatOf(m, viewer)
  const invited = invitedOf(m)
  const waitingHost = (): ArenaPlayer => {
    const rec = ratingOf(world, m.host, m.game)
    return {
      seat: 0, member: tryPublicMember(world, viewer, m.host), computer: null, name: exists(world, m.host) && !isBlockedEitherWay(world, viewer, m.host) ? nameOf(world, m.host) : 'A member',
      rating: rec.rating, provisional: isProvisional(rec), ratingChange: null, coins: null, clockMs: timeControl(m.timeControl).baseMs, connected: world.isOnline(m.host),
    }
  }
  const deadline = deadlineOf(m)
  const watchers = watchersOf(world, m)
  const first: PublicMember[] = []
  for (const memberId of watchers) {
    if (first.length >= 5) break
    const seen = tryPublicMember(world, viewer, memberId)
    if (seen) first.push(seen)
  }
  const role = mySeat >= 0 || m.host === viewer ? 'player' : invited === viewer ? 'invited' : presentIn(world, m).has(viewer) && mayWatch(world, viewer, m) ? 'watcher' : 'none'
  return {
    id: m.id, rev: m.rev, game: m.game, status: m.status, host: m.host,
    players: m.seats.length ? m.seats.map((seat, index) => playerView(world, viewer, m, seat, index)) : [waitingHost()],
    invited: invited ? tryPublicMember(world, viewer, invited) : null,
    open: m.status === 'waiting' && (m.opponent.kind === 'queue' || m.opponent.kind === 'community') ? m.opponent.kind : null,
    timeControl: m.timeControl, rated: m.rated, forFun: m.forFun, audience: m.audience, communityId: m.communityId,
    communityName: m.communityId ? communityName(world, m.communityId) : m.opponent.kind === 'community' ? communityName(world, m.opponent.communityId) : null,
    createdAt: iso(m.createdAt), expiresAt: m.status === 'waiting' && m.expiresAt ? iso(m.expiresAt) : null,
    startedAt: m.startedAt ? iso(m.startedAt) : null, finishedAt: m.finishedAt ? iso(m.finishedAt) : null, lastMoveAt: m.lastMoveAt ? iso(m.lastMoveAt) : null,
    turn: turnOf(m), moveCount: m.moves.length,
    clock: {
      seat: deadline ? deadline.seat : null, since: deadline && m.turnStartedAt ? iso(m.turnStartedAt) : null,
      counting: deadline ? deadline.kind === 'flag' : false, callsOffAt: deadline && deadline.kind === 'first' ? iso(deadline.at) : null,
    },
    outcome: outcomeView(world, viewer, m), endText: m.endText ? named(m.endText, m.seats.map(seat => seatName(world, viewer, seat))) : null,
    drawOffer: m.drawOffer, rematchOf: m.rematchOf, rematch: rematchFor(world, m, viewer)?.id ?? null,
    watchers: { count: watchers.length, first },
    me: {
      role, seat: mySeat >= 0 ? mySeat : null,
      canAccept: m.status === 'waiting' && (invited === viewer || mayTake(world, viewer, m)),
      mayChat: hasBoard(m) && (mySeat >= 0 || mayWatch(world, viewer, m)),
    },
  }
}

const lineOf = (m: MatchRec, index: number): ArenaMoveLine => {
  const move = m.moves[index]!
  return { n: index + 1, seat: move.seat, text: move.text, at: iso(move.at) }
}

/** Chat as one member may read it: nobody blocked either way, and no watcher lines for a player who asked for focus. */
function chatFor(world: World, viewer: MemberId, m: MatchRec, before: string | null): { lines: ArenaChatLine[]; more: boolean } {
  const seat = seatOf(m, viewer)
  const focus = seat >= 0 && m.seats[seat]!.focus
  const end = before ? m.chat.findIndex(line => line.id === before) : m.chat.length
  const visible = m.chat.slice(0, end < 0 ? m.chat.length : end).filter(line => line.from === viewer
    || (exists(world, line.from) && !isBlockedEitherWay(world, viewer, line.from) && !(focus && line.role === 'watching')))
  const page = visible.slice(-ARENA.chat.page)
  return { lines: page.map(line => chatLine(world, viewer, line)), more: visible.length > page.length }
}

const chatLine = (world: World, viewer: MemberId, line: ChatRec): ArenaChatLine => ({
  id: line.id, at: iso(line.at), memberId: line.from, displayName: nameOf(world, line.from), look: lookFor(world, viewer, line.from),
  role: line.role, text: line.text, mine: line.from === viewer,
})

function detail(world: World, viewer: MemberId, m: MatchRec): ArenaDetail {
  const seat = seatOf(m, viewer)
  const rules = rulesFor(m.game)
  let view: unknown = null
  if (rules && hasBoard(m) && m.state !== null) {
    try { view = rules.view(m.state, seat >= 0 ? seat : null) } catch (error) { console.error('[arena] view failed', error) }
  }
  const last = m.moves[m.moves.length - 1]
  const readable = hasBoard(m) && (seat >= 0 || mayWatch(world, viewer, m))
  const chat = readable ? chatFor(world, viewer, m, null) : { lines: [], more: false }
  return {
    match: matchView(world, viewer, m), view, moves: m.moves.map((_, index) => lineOf(m, index)),
    lastMove: last ? { seat: last.seat, move: last.move } : null, chat: chat.lines, chatMore: chat.more,
    focus: seat >= 0 && m.seats[seat]!.focus, now: iso(world.now()),
  }
}

/** After any change: each player gets their own view, each watcher with the page open gets the spectator view. */
function pushMatch(world: World, m: MatchRec, from: number): void {
  advance(m)
  const rules = rulesFor(m.game)
  const last = m.moves[m.moves.length - 1]
  const lastMove = last ? { seat: last.seat, move: last.move } : null
  const moves: ArenaMoveLine[] = []
  for (let index = from; index < m.moves.length; index++) moves.push(lineOf(m, index))
  const now = iso(world.now())
  const send = (memberId: MemberId, seat: number | null): void => {
    if (!world.isOnline(memberId)) return
    let view: unknown = null
    if (rules && hasBoard(m) && m.state !== null) {
      try { view = rules.view(m.state, seat) } catch (error) { console.error('[arena] view failed', error) }
    }
    world.push(memberId, { type: 'arena.match', matchId: m.id, match: matchView(world, memberId, m), view, lastMove, from, moves, now })
  }
  const sent = new Set<MemberId>()
  m.seats.forEach((seat, index) => { if (seat.member) { sent.add(seat.member); send(seat.member, index) } })
  for (const memberId of presentIn(world, m)) {
    if (sent.has(memberId)) continue
    if (maySee(world, memberId, m)) send(memberId, null)
  }
}

/** The members whose own lists show this match are told a list changed. */
function changed(world: World, m: MatchRec): void {
  const who = new Set<MemberId>([m.host, ...humans(m)])
  const invited = invitedOf(m)
  if (invited) who.add(invited)
  for (const memberId of who) world.push(memberId, { type: 'arena.changed', matchId: m.id })
}

// ── Starting, playing, ending ──

function openCount(world: World, memberId: MemberId): number {
  let count = 0
  for (const matchId of runtime(world).open) {
    const m = arena(world).matches[matchId]
    if (m && (m.host === memberId || seatOf(m, memberId) >= 0)) count++
  }
  return count
}

function newMatch(world: World, host: MemberId, game: ArenaGame, opponent: OpponentRec, options: {
  timeControl: MatchRec['timeControl']; rated: boolean; audience: MatchRec['audience']; communityId: CommunityId | null
  hostSeat: number | null; rematchOf: ArenaMatchId | null
}, now: number): MatchRec {
  const tc = timeControl(options.timeControl)
  const lapse = opponent.kind === 'queue' ? ARENA.queueMinutes[tc.daily ? 'daily' : 'live'] * MINUTE : ARENA.challengeHours[tc.daily ? 'daily' : 'live'] * HOUR
  const m: MatchRec = {
    id: newId<ArenaMatchId>('am'), rev: 0, game, status: 'waiting', host, opponent, seats: [], hostSeat: options.hostSeat,
    timeControl: options.timeControl, forFun: false,
    rated: options.rated && opponent.kind !== 'computer' && ratedOpenTo(world, host) && (opponent.kind !== 'member' || ratedOpenTo(world, opponent.memberId)),
    audience: options.audience, communityId: options.audience === 'community' ? options.communityId : null,
    createdAt: now, expiresAt: now + lapse, startedAt: null, finishedAt: null, lastMoveAt: null,
    seed: randomSeed(), state: null, moves: [], clocks: [], turnStartedAt: null, botAt: null, drawOffer: null,
    outcome: null, endText: null, rematchOf: options.rematchOf, rematch: null, chat: [],
  }
  arena(world).matches[m.id] = m
  runtime(world).open.add(m.id)
  world.touch()
  return m
}

function scheduleBot(m: MatchRec, now: number): void {
  const seat = turnOf(m)
  const level = seat === null ? null : m.seats[seat]?.computer ?? null
  if (level === null) { m.botAt = null; return }
  // A short, slightly uneven pause, so the computer does not answer like a machine.
  const pause = seededRandom((m.seed ^ Math.imul(m.moves.length + 7, 0x9e3779b1)) >>> 0)()
  m.botAt = now + 500 + level * 200 + Math.floor(pause * 700)
}

function start(world: World, m: MatchRec, other: MemberId | { computer: 1 | 2 | 3 }, now: number): void {
  const rules = need(m.game)
  const seatFor = (memberId: MemberId | null, computer: 1 | 2 | 3 | null): SeatRec => {
    const rec = memberId ? ratingOf(world, memberId, m.game) : null
    return {
      member: memberId, computer, before: rec ? rec.rating : null, provisional: rec ? isProvisional(rec) : false,
      change: null, coins: null, focus: false, awaySince: memberId && !world.isOnline(memberId) ? now : null, drawAskedAt: -1,
    }
  }
  const hostSeat = seatFor(m.host, null)
  const otherSeat = typeof other === 'string' ? seatFor(other, null) : seatFor(null, other.computer)
  // Against the computer the member moves first unless a rematch swapped the seats; between members the seed decides.
  const hostAt = m.hostSeat ?? (typeof other === 'string' ? m.seed & 1 : 0)
  m.seats = hostAt === 0 ? [hostSeat, otherSeat] : [otherSeat, hostSeat]
  if (typeof other === 'string') {
    m.forFun = pairGamesToday(world, m.host, other, now) >= ARENA.countedPairGamesPerDay
    // Every game between two members is seated here, so this holds whichever way the second one arrived.
    if (m.forFun || !ratedOpenTo(world, m.host) || !ratedOpenTo(world, other)) m.rated = false
    m.opponent = { kind: 'member', memberId: other }
  } else m.rated = false
  m.state = ruled(() => rules.start(2, m.seed), 'conflict')
  const base = timeControl(m.timeControl).baseMs
  m.clocks = [base, base]
  m.turnStartedAt = now
  m.status = 'active'
  m.startedAt = now
  m.expiresAt = null
  scheduleBot(m, now)
  world.touch()
}

function close(world: World, m: MatchRec, now: number): void {
  m.finishedAt = now
  m.turnStartedAt = null
  m.botAt = null
  m.drawOffer = null
  m.expiresAt = null
  runtime(world).open.delete(m.id)
  for (const memberId of humans(m)) settle(world, memberId, `arena-turn:${m.id}`)
  const invited = invitedOf(m)
  if (invited) settle(world, invited, `arena:${m.id}`, 'expired')
  // A match that never had a board is not pushed: its ending (declined, withdrawn, lapsed) is counted here.
  if (!m.seats.length) advance(m)
  world.touch()
  // A rematch offer that ended unplayed: the earlier game's players are shown where the offer now stands.
  const earlier = m.rematchOf && !m.seats.length ? arena(world).matches[m.rematchOf] : undefined
  if (earlier && earlier.rematch === m.id) pushMatch(world, earlier, earlier.moves.length)
}

/** Called off: no result, no rating, no coins. */
function abort(world: World, m: MatchRec, text: string, now: number): void {
  m.status = 'aborted'
  m.endText = text
  close(world, m, now)
  changed(world, m)
  pushMatch(world, m, m.moves.length)
}

function finish(world: World, m: MatchRec, outcome: Outcome, now: number): void {
  m.outcome = outcome
  m.status = 'finished'
  const players = m.seats
  const score = (seat: number): number => (outcome.draw ? 0.5 : outcome.winners.includes(seat) ? 1 : 0)
  const a = players[0]!, b = players[1]!
  const gameName = ARENA_GAME_NAME[m.game]
  if (a.member && b.member) {
    if (!m.forFun) {
      countPairGame(world, a.member, b.member, now)
      if (m.rated) [a.change, b.change] = settleRatings(world, m.game, a.member, b.member, score(0), now)
      players.forEach((seat, index) => {
        if (score(index) !== 1 || !seat.member) return
        const other = players[1 - index]!
        seat.coins = payWin(world, seat.member, 'human', ARENA.pay.human, `Won ${gameName} against ${other.member ? nameOf(world, other.member) : 'a member'}`, now)
      })
    }
  } else {
    players.forEach((seat, index) => {
      const other = players[1 - index]!
      if (score(index) !== 1 || !seat.member || !other.computer) return
      seat.coins = payWin(world, seat.member, 'computer', ARENA.pay.computer[other.computer - 1] ?? 0, `Won ${gameName} against the computer (${COMPUTER_LEVEL_NAME[other.computer].toLowerCase()})`, now)
    })
  }
  close(world, m, now)
  // Told in the inbox only when the member is not looking at the game as it ends.
  players.forEach((seat, index) => {
    if (!seat.member || isLooking(world, m, seat.member)) return
    const other = players[1 - index]!
    const names = players.map(entry => seatName(world, seat.member, entry))
    emit(world, {
      to: seat.member, category: 'challenges', kind: 'arena.finished',
      title: outcome.draw ? `${gameName}: a draw with ${names[1 - index]}` : `${gameName}: you ${score(index) === 1 ? 'won' : 'lost'} against ${names[1 - index]}`,
      body: named(outcome.text, names), link: linkOf(m.id), actor: other.member, dedupeKey: `arena-finished:${m.id}`,
    })
  })
  changed(world, m)
}

/** One seat gives the game up: resigning, running out of time, or staying disconnected. */
function forfeit(world: World, m: MatchRec, seat: number, reason: 'resigned' | 'time' | 'left', now: number): void {
  const who = `{${seat}}`
  const how = reason === 'resigned' ? 'resigned' : reason === 'time' ? 'ran out of time' : 'left the game'
  if (m.moves.length < ARENA.minMovesEach * m.seats.length) {
    abort(world, m, `${who} ${how} before the game had really begun, so it was called off. Nothing was counted.`, now)
    return
  }
  const rules = need(m.game)
  let outcome: Outcome | null = null
  try {
    m.state = rules.forfeit(m.state, seat, reason)
    outcome = rules.outcome(m.state)
  } catch (error) { console.error('[arena] forfeit failed', error) }
  // A game whose rules did not end it is ended by the hall: the other seat wins.
  outcome ??= { winners: m.seats.map((_, index) => index).filter(index => index !== seat), draw: false, reason, text: `${who} ${how}.`, scores: m.seats.map((_, index) => (index === seat ? 0 : 1)) }
  finish(world, m, outcome, now)
  pushMatch(world, m, m.moves.length)
}

/** Time that has run out is settled before anything else is decided, so the result never depends on tick order. */
function settleClock(world: World, m: MatchRec, now: number): void {
  const deadline = deadlineOf(m)
  if (!deadline || now < deadline.at) return
  if (deadline.kind === 'first') { abort(world, m, `{${deadline.seat}} did not make a first move in time, so the game was called off. Nothing was counted.`, now); return }
  m.clocks[deadline.seat] = 0
  forfeit(world, m, deadline.seat, 'time', now)
}

function play(world: World, m: MatchRec, seat: number, move: unknown, now: number): void {
  const rules = need(m.game)
  let text = 'Move'
  try { text = String(rules.describe(m.state, seat, move)).slice(0, 80) } catch (error) { if (!isRulesError(error)) console.error('[arena] describe failed', error) }
  const next = ruled(() => rules.apply(m.state, seat, move), 'conflict')
  const tc = timeControl(m.timeControl)
  if (tc.daily) m.clocks[seat] = tc.baseMs
  else if (counting(m) && m.turnStartedAt !== null) m.clocks[seat] = Math.max(0, (m.clocks[seat] ?? 0) - (now - m.turnStartedAt)) + tc.incrementMs
  m.state = next
  m.moves.push({ seat, move, text, at: now })
  m.lastMoveAt = now
  // Playing on answers a draw offer with "no".
  if (m.drawOffer !== null && m.drawOffer !== seat) m.drawOffer = null
  const mover = m.seats[seat]!
  if (mover.member) settle(world, mover.member, `arena-turn:${m.id}`)
  const outcome = ruled(() => rules.outcome(next), 'conflict')
  if (outcome) finish(world, m, outcome, now)
  else {
    m.turnStartedAt = now
    scheduleBot(m, now)
    const turn = turnOf(m)
    const waiting = turn === null ? null : m.seats[turn]!
    // Daily games: the player to move is told, unless they are looking at the board.
    if (waiting?.member && tc.daily && !isLooking(world, m, waiting.member)) {
      const names = m.seats.map(entry => seatName(world, waiting.member, entry))
      emit(world, {
        to: waiting.member, category: 'challenges', kind: 'arena.turn', title: `Your move in ${ARENA_GAME_NAME[m.game]} against ${names[seat]}`,
        body: `${names[seat]} played ${text}. You have a day to answer.`, link: linkOf(m.id), actor: mover.member, dedupeKey: `arena-turn:${m.id}`,
        expiresAt: now + tc.baseMs,
      })
    }
  }
  world.touch()
  pushMatch(world, m, m.moves.length - 1)
}

function botMove(world: World, m: MatchRec, now: number): void {
  const rules = rulesFor(m.game)
  const seat = turnOf(m)
  const level = seat === null ? null : m.seats[seat]?.computer ?? null
  if (!rules || seat === null || level === null) { m.botAt = null; return }
  const started = performance.now()
  try {
    const random = seededRandom((m.seed ^ Math.imul(m.moves.length + 1, 0x85ebca6b)) >>> 0)
    // Through JSON and parseMove, exactly as a member's move arrives: the computer gets no shortcut.
    const move = rules.parseMove(JSON.parse(JSON.stringify(rules.bot(m.state, seat, level, random))))
    play(world, m, seat, move, now)
  } catch (error) {
    console.error(`[arena] the computer could not move in ${m.game} ${m.id}`, error)
    m.botAt = null
    finish(world, m, { winners: [1 - seat], draw: false, reason: 'resigned', text: `{${seat}} could not find a move and resigned.`, scores: m.seats.map((_, index) => (index === seat ? 0 : 1)) }, now)
    pushMatch(world, m, m.moves.length)
  }
  const took = performance.now() - started
  if (took > 400) console.warn(`[arena] the computer took ${Math.round(took)} ms for a ${m.game} move at level ${level}`)
}

// ── Parsing ──

const matchIdIn = (raw: Raw): ArenaMatchId => id<ArenaMatchId>(raw, 'matchId', 'am')
const onlyMatch = (value: unknown): { matchId: ArenaMatchId } => ({ matchId: matchIdIn(obj(value)) })

function parseOpponent(value: unknown): ArenaOpponent {
  const raw = obj(value, 'opponent')
  const kind = oneOf(raw, 'kind', ['friend', 'community', 'queue', 'computer'] as const)
  if (kind === 'friend') return { kind, memberId: id<MemberId>(raw, 'memberId', 'm') }
  if (kind === 'community') return { kind, communityId: id<CommunityId>(raw, 'communityId', 'c') }
  if (kind === 'computer') return { kind, level: num(raw, 'level', { integer: true, min: 1, max: 3 }) as 1 | 2 | 3 }
  return { kind }
}

export function registerArena(world: World): void {
  const data = arena(world)
  const live = runtime(world)

  // ── Resuming after a restart: the time the service was away is charged to nobody ──
  {
    const now = world.now()
    const gap = data.aliveAt > 0 ? Math.max(0, now - data.aliveAt) : 0
    for (const m of Object.values(data.matches)) {
      // Saved before matches had a revision: it counts from here.
      if (typeof m.rev !== 'number') m.rev = 0
      if (m.status !== 'waiting' && m.status !== 'active') continue
      live.open.add(m.id)
      if (m.status !== 'active') { if (m.expiresAt) m.expiresAt += gap; continue }
      if (m.turnStartedAt !== null) m.turnStartedAt += gap
      if (m.botAt !== null) m.botAt = now + SECOND
      // Nobody is connected yet. The grace for coming back starts now.
      for (const seat of m.seats) if (seat.member) seat.awaySince = now
    }
    data.aliveAt = now
    live.lastHeartbeat = now
  }

  // ── Connections ──

  const livePlayerMatches = (memberId: MemberId): MatchRec[] => {
    const out: MatchRec[] = []
    for (const matchId of live.open) {
      const m = data.matches[matchId]
      if (m && m.status === 'active' && seatOf(m, memberId) >= 0) out.push(m)
    }
    return out
  }
  // Work outside an operation names the slice it changes, so the kernel saves it with the next write
  // (a slice nobody asked for in a scope is not written again until the periodic full save).
  world.onConnect(memberId => {
    arena(world)
    for (const m of livePlayerMatches(memberId)) {
      m.seats[seatOf(m, memberId)]!.awaySince = null
      pushMatch(world, m, m.moves.length)
    }
  })
  world.onDisconnect(memberId => {
    arena(world)
    const now = world.now()
    for (const matchId of live.looking.get(memberId) ?? []) {
      live.present.get(matchId)?.delete(memberId)
      const m = data.matches[matchId]
      if (m && seatOf(m, memberId) < 0) pushMatch(world, m, m.moves.length)
    }
    live.looking.delete(memberId)
    for (const m of livePlayerMatches(memberId)) {
      m.seats[seatOf(m, memberId)]!.awaySince = now
      pushMatch(world, m, m.moves.length)
    }
    // A place in the queue for a live game needs its owner to be here.
    for (const matchId of [...live.open]) {
      const m = data.matches[matchId]
      if (m && m.status === 'waiting' && m.host === memberId && m.opponent.kind === 'queue' && isLive(m)) {
        m.status = 'cancelled'
        m.endText = 'Your connection dropped before anyone was found, so the search stopped.'
        close(world, m, now)
      }
    }
  })

  // A block ends what the two share here: a game between them is called off, and a blocked watcher is shown out.
  onBlock((blockWorld, blocker, blocked) => {
    if (blockWorld !== world) return
    arena(world)
    const now = world.now()
    for (const m of Object.values(data.matches)) {
      const a = isParticipant(m, blocker), b = isParticipant(m, blocked)
      if (a && b) {
        if (m.status === 'active') abort(world, m, 'The game was called off.', now)
        else if (m.status === 'waiting') { m.status = 'cancelled'; m.endText = 'The challenge was withdrawn.'; close(world, m, now); changed(world, m) }
        continue
      }
      if (!a && !b) continue
      const outsider = a ? blocked : blocker
      if (live.present.get(m.id)?.delete(outsider)) {
        live.looking.get(outsider)?.delete(m.id)
        world.push(outsider, { type: 'arena.closed', matchId: m.id, reason: 'This game is no longer open to you.' })
        pushMatch(world, m, m.moves.length)
      }
    }
  })

  // ── Time ──

  world.onTick(now => {
    // Nothing to do, nothing to save: the slice is only named when a match is waiting or going.
    if (live.open.size === 0 && now - live.lastPrune < 10 * MINUTE) { data.aliveAt = now; return }
    arena(world)
    let liveGoing = false, dailyGoing = false
    let botDue: MatchRec | null = null
    for (const matchId of [...live.open]) {
      const m = data.matches[matchId]
      if (!m) { live.open.delete(matchId); continue }
      if (m.status === 'waiting') {
        if (m.expiresAt !== null && now >= m.expiresAt) {
          m.status = 'expired'
          m.endText = m.opponent.kind === 'queue' ? 'Nobody else was looking for this game. Try again, or play the computer.' : 'The challenge was not answered in time.'
          close(world, m, now)
          changed(world, m)
        }
        continue
      }
      if (m.status !== 'active') { live.open.delete(matchId); continue }
      if (!rulesFor(m.game)) continue
      settleClock(world, m, now)
      if (m.status !== 'active') continue
      if (isLive(m)) {
        liveGoing = true
        // Two members, live: staying disconnected past the grace loses the game.
        if (m.seats.every(seat => seat.member)) {
          const turn = turnOf(m)
          const gone = m.seats.map((seat, index) => ({ seat, index })).filter(entry => entry.seat.awaySince !== null && now - entry.seat.awaySince >= ARENA.disconnectGraceSeconds * SECOND)
          const leaver = gone.find(entry => entry.index === turn) ?? gone[0]
          if (leaver) { forfeit(world, m, leaver.index, 'left', now); continue }
        }
      } else dailyGoing = true
      if (m.botAt !== null && now >= m.botAt && (!botDue || m.botAt < botDue.botAt!)) botDue = m
    }
    // One computer move a tick, however many are due: thinking never holds the service for more than one move.
    if (botDue) botMove(world, botDue, now)

    // The heartbeat a restart measures its gap from. Saved every few seconds while a live game runs.
    data.aliveAt = now
    const every = liveGoing ? 5 * SECOND : dailyGoing ? MINUTE : 0
    if (every && now - live.lastHeartbeat >= every) { live.lastHeartbeat = now; world.touch() }

    if (now - live.lastPrune >= 10 * MINUTE) {
      live.lastPrune = now
      for (const m of Object.values(data.matches)) {
        if (m.status === 'waiting' || m.status === 'active') continue
        const keep = (m.seats.some(seat => seat.computer) || m.status !== 'finished' ? ARENA.keepDays.computer : ARENA.keepDays.human) * DAY
        if (now - (m.finishedAt ?? m.createdAt) > keep) { delete data.matches[m.id]; live.present.delete(m.id); world.touch() }
      }
      const today = Math.floor(now / DAY)
      for (const [key, rec] of Object.entries(data.pairs)) if (rec.day !== today) delete data.pairs[key]
      for (const [key, rec] of Object.entries(data.pay)) if (rec.day !== today) delete data.pay[key]
    }
  })

  // ── The games ──

  world.register('arena.games', empty, () => {
    const counts: Record<string, number> = {}
    for (const matchId of live.open) {
      const m = data.matches[matchId]
      if (m && m.status === 'active' && m.audience === 'anyone') counts[m.game] = (counts[m.game] ?? 0) + 1
    }
    return { games: ARENA_GAMES.map(game => ({ game, available: isAvailable(game), live: counts[game] ?? 0 })) }
  })

  // ── Lists ──

  world.register('arena.mine', empty, ctx => {
    const me = ctx.memberId
    const mine = Object.values(data.matches).filter(m => isParticipant(m, me))
    const weight = (m: MatchRec): number => {
      if (m.status === 'active') return turnOf(m) === seatOf(m, me) ? 0 : 1
      if (m.status === 'waiting') return invitedOf(m) === me ? 0 : 2
      return 3
    }
    const going = mine.filter(m => m.status === 'active' || m.status === 'waiting')
      .sort((a, b) => weight(a) - weight(b) || (b.lastMoveAt ?? b.createdAt) - (a.lastMoveAt ?? a.createdAt))
    const done = mine.filter(m => m.status !== 'active' && m.status !== 'waiting')
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)).slice(0, 20)
    const circles = new Set(communitiesOf(world, me))
    const open: MatchRec[] = []
    for (const matchId of live.open) {
      const m = data.matches[matchId]
      if (m && m.opponent.kind === 'community' && circles.has(m.opponent.communityId) && mayTake(world, me, m)) open.push(m)
    }
    return {
      matches: [...going, ...done].map(m => matchView(world, me, m)),
      open: open.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map(m => matchView(world, me, m)),
    }
  })

  world.register('arena.live', value => ({ game: optOneOf(obj(value), 'game', ARENA_GAMES) }), (ctx, input) => {
    const found: MatchRec[] = []
    for (const matchId of live.open) {
      const m = data.matches[matchId]
      if (!m || m.status !== 'active' || (input.game && m.game !== input.game)) continue
      if (seatOf(m, ctx.memberId) < 0 && mayWatch(world, ctx.memberId, m)) found.push(m)
    }
    found.sort((a, b) => watchersOf(world, b).length - watchersOf(world, a).length || (b.lastMoveAt ?? b.createdAt) - (a.lastMoveAt ?? a.createdAt))
    return { matches: found.slice(0, 30).map(m => matchView(world, ctx.memberId, m)) }
  })

  // ── Creating and answering ──

  world.register('arena.create', value => {
    const raw = obj(value)
    return {
      game: oneOf(raw, 'game', ARENA_GAMES), opponent: parseOpponent(raw.opponent), timeControl: oneOf(raw, 'timeControl', TIME_CONTROL_IDS),
      rated: bool(raw, 'rated'), audience: oneOf(raw, 'audience', ARENA_AUDIENCES), communityId: optId<CommunityId>(raw, 'communityId', 'c'),
    }
  }, (ctx, input) => {
    const me = ctx.memberId
    world.limit(`arena-create:${me}`, 12, MINUTE)
    need(input.game)
    if (openCount(world, me) >= ARENA.maxOpenMatches) throw new WorldError('conflict', `You already have ${ARENA.maxOpenMatches} games going or waiting. Finish or cancel one first.`)
    if (input.audience === 'community' && !(input.communityId && isCommunityMember(world, input.communityId, me))) {
      throw new WorldError('forbidden', 'Join the community before opening a game to it.')
    }
    const options = { timeControl: input.timeControl, rated: input.rated, audience: input.audience, communityId: input.communityId, hostSeat: null, rematchOf: null }
    const opponent = input.opponent
    let m: MatchRec
    if (opponent.kind === 'computer') {
      m = newMatch(world, me, input.game, opponent, options, ctx.now)
      start(world, m, { computer: opponent.level }, ctx.now)
    } else if (opponent.kind === 'friend') {
      if (opponent.memberId === me) throw new WorldError('invalid', 'You cannot challenge yourself.')
      if (!exists(world, opponent.memberId) || isBlockedEitherWay(world, me, opponent.memberId) || !areFriends(world, me, opponent.memberId)) {
        throw new WorldError('forbidden', 'You can only challenge your friends. Use “Find a match” to play someone new.')
      }
      m = newMatch(world, me, input.game, { kind: 'member', memberId: opponent.memberId }, options, ctx.now)
      const tc = timeControl(m.timeControl)
      emit(world, {
        to: opponent.memberId, category: 'challenges', kind: 'arena.challenge', title: `${nameOf(world, me)} challenged you to ${ARENA_GAME_NAME[m.game]}`,
        body: `${tc.label}. ${m.rated ? 'Rated' : 'Casual'}. ${tc.daily ? 'Answer within 3 days.' : 'Answer while you are both here.'}`,
        link: linkOf(m.id), actor: me, dedupeKey: `arena:${m.id}`, expiresAt: m.expiresAt,
      })
    } else if (opponent.kind === 'community') {
      if (!isCommunityMember(world, opponent.communityId, me)) throw new WorldError('forbidden', 'Join the community before challenging its members.')
      m = newMatch(world, me, input.game, opponent, options, ctx.now)
    } else {
      // Find me someone: the longest-waiting member who asked for the same game, time and kind,
      // open to the same audience. Whoever joins plays on the terms they asked for, not the host's.
      const rated = input.rated && ratedOpenTo(world, me)
      const circle = input.audience === 'community' ? input.communityId : null
      let found: MatchRec | null = null
      for (const matchId of live.open) {
        const other = data.matches[matchId]
        if (!other || other.status !== 'waiting' || other.opponent.kind !== 'queue' || other.host === me) continue
        if (other.game !== input.game || other.timeControl !== input.timeControl || other.rated !== rated) continue
        if (other.audience !== input.audience || other.communityId !== circle) continue
        if (!exists(world, other.host) || isBlockedEitherWay(world, me, other.host)) continue
        if (isLive(other) && !world.isOnline(other.host)) continue
        if (!found || other.createdAt < found.createdAt) found = other
      }
      if (found) {
        m = found
        start(world, m, me, ctx.now)
        if (!isLooking(world, m, m.host)) {
          emit(world, {
            to: m.host, category: 'challenges', kind: 'arena.started', title: `Your ${ARENA_GAME_NAME[m.game]} game has started`,
            body: `${nameOf(world, me)} was found for you. ${isLive(m) ? 'The clock is running.' : 'One day for each move.'}`,
            link: linkOf(m.id), actor: me, dedupeKey: `arena-started:${m.id}`,
          })
        }
      } else m = newMatch(world, me, input.game, { kind: 'queue' }, options, ctx.now)
    }
    changed(world, m)
    if (m.status === 'active') pushMatch(world, m, 0)
    return { match: matchView(world, me, m) }
  })

  /** Take the open seat of a waiting match. */
  function accept(m: MatchRec, me: MemberId, now: number): void {
    if (m.expiresAt !== null && now >= m.expiresAt) throw new WorldError('expired', 'This challenge is no longer open.')
    if (isBlockedEitherWay(world, me, m.host) || !exists(world, m.host)) throw new WorldError('forbidden', 'This challenge is not open to you.')
    if (openCount(world, me) >= ARENA.maxOpenMatches) throw new WorldError('conflict', `You already have ${ARENA.maxOpenMatches} games going or waiting. Finish or cancel one first.`)
    // A live game needs both players here when it starts; a daily one does not.
    if (isLive(m) && !world.isOnline(m.host)) throw new WorldError('conflict', `${nameOf(world, m.host)} is not here right now. The challenge stays open — accept it when they are back.`)
    const invited = invitedOf(m)
    start(world, m, me, now)
    if (invited) settle(world, invited, `arena:${m.id}`)
    if (!isLooking(world, m, m.host)) {
      emit(world, {
        to: m.host, category: 'challenges', kind: 'arena.started', title: `${nameOf(world, me)} accepted: ${ARENA_GAME_NAME[m.game]} has started`,
        body: isLive(m) ? 'The clock is running. Open the game to play.' : 'One day for each move.', link: linkOf(m.id), actor: me, dedupeKey: `arena-started:${m.id}`,
      })
    }
    changed(world, m)
    pushMatch(world, m, 0)
  }

  world.register('arena.respond', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), accept: bool(raw, 'accept') }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = ctx.memberId
    const invited = invitedOf(m) === me
    if (m.status !== 'waiting') {
      // Answering twice changes nothing: the member gets the match as it now stands.
      if (isParticipant(m, me)) return { match: matchView(world, me, m) }
      throw new WorldError('expired', 'This challenge is no longer open.')
    }
    if (!invited && !mayTake(world, me, m)) throw new WorldError('forbidden', 'This challenge is not yours to answer.')
    if (input.accept) accept(m, me, ctx.now)
    else if (invited) {
      m.status = 'declined'
      m.endText = '{invited} declined the challenge.'.replace('{invited}', nameOf(world, me))
      settle(world, me, `arena:${m.id}`)
      close(world, m, ctx.now)
      world.push(me, { type: 'arena.changed', matchId: m.id })
      changed(world, m)
    }
    return { match: matchView(world, me, m) }
  })

  world.register('arena.cancel', onlyMatch, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    if (m.host !== ctx.memberId) throw new WorldError('forbidden', 'Only the member who made the challenge can withdraw it.')
    if (m.status === 'waiting') {
      const invited = invitedOf(m)
      m.status = 'cancelled'
      m.endText = m.opponent.kind === 'queue' ? 'You stopped looking for a game.' : 'The challenge was withdrawn.'
      close(world, m, ctx.now)
      changed(world, m)
      if (invited) world.push(invited, { type: 'arena.changed', matchId: m.id })
    }
    return { match: matchView(world, ctx.memberId, m) }
  })

  // ── A match ──

  world.register('arena.get', onlyMatch, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    if (!maySee(world, ctx.memberId, m)) throw new WorldError('forbidden', 'This game is not open to you.')
    return detail(world, ctx.memberId, m)
  })

  world.register('arena.watch', onlyMatch, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = ctx.memberId
    if (!maySee(world, me, m)) throw new WorldError('forbidden', 'This game is not open to you.')
    let present = live.present.get(m.id)
    if (!present) { present = new Set(); live.present.set(m.id, present) }
    if (!present.has(me)) {
      present.add(me)
      let looking = live.looking.get(me)
      if (!looking) { looking = new Set(); live.looking.set(me, looking) }
      looking.add(m.id)
      // Someone new is watching: the others see the count change.
      if (seatOf(m, me) < 0 && m.host !== me && hasBoard(m)) pushMatch(world, m, m.moves.length)
    }
    return detail(world, me, m)
  })

  world.register('arena.unwatch', onlyMatch, (ctx, input) => {
    const m = data.matches[input.matchId]
    live.looking.get(ctx.memberId)?.delete(input.matchId)
    if (live.present.get(input.matchId)?.delete(ctx.memberId) && m && seatOf(m, ctx.memberId) < 0 && hasBoard(m)) pushMatch(world, m, m.moves.length)
    return { left: true as const }
  })

  world.register('arena.invite', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), memberId: id<MemberId>(raw, 'memberId', 'm') }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = ctx.memberId
    if (!hasBoard(m) || (seatOf(m, me) < 0 && !mayWatch(world, me, m))) throw new WorldError('forbidden', 'This game is not open to you.')
    if (m.status !== 'active') throw new WorldError('conflict', 'This game is over.')
    if (!exists(world, input.memberId) || !areFriends(world, me, input.memberId) || isBlockedEitherWay(world, me, input.memberId)) throw new WorldError('forbidden', 'You can only invite your friends to watch.')
    if (seatOf(m, input.memberId) >= 0) throw new WorldError('conflict', 'They are playing in this game.')
    if (!mayWatch(world, input.memberId, m)) {
      const why = m.audience === 'players' ? 'only the players can open it' : m.audience === 'community' ? 'it is open to one community they are not in' : 'it is open to friends of the players'
      throw new WorldError('conflict', `${nameOf(world, input.memberId)} cannot watch this game: ${why}.`)
    }
    world.limit(`arena-invite:${me}`, 10, MINUTE)
    const names = m.seats.map(seat => seatName(world, input.memberId, seat))
    emit(world, {
      to: input.memberId, category: 'social', kind: 'arena.watch', title: `${nameOf(world, me)} invites you to watch ${ARENA_GAME_NAME[m.game]}`,
      body: `${names[0]} against ${names[1]}, being played now.`, link: linkOf(m.id), actor: me, dedupeKey: `arena-watch:${m.id}:${me}`,
      expiresAt: ctx.now + 2 * HOUR,
    })
    return { invited: true as const }
  })

  const playerSeat = (m: MatchRec, memberId: MemberId): number => {
    const seat = seatOf(m, memberId)
    if (seat < 0) throw new WorldError('forbidden', 'Only the players can do that.')
    return seat
  }

  world.register('arena.move', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), moveNumber: num(raw, 'moveNumber', { integer: true, min: 0, max: 100_000 }), move: raw.move }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const seat = playerSeat(m, ctx.memberId)
    const rules = need(m.game)
    const move = ruled(() => rules.parseMove(input.move), 'invalid')
    if (input.moveNumber < m.moves.length) {
      // The same move sent again (a retry after a lost answer) changes nothing.
      const earlier = m.moves[input.moveNumber]!
      if (earlier.seat === seat && stable(earlier.move) === stable(move)) return { ...detail(world, ctx.memberId, m), repeat: true }
      throw new WorldError('conflict', 'The game has moved on since you chose that move. Your board is up to date now.')
    }
    if (input.moveNumber > m.moves.length) throw new WorldError('conflict', 'That move is ahead of the game. Your board is up to date now.')
    if (m.status !== 'active') throw new WorldError('conflict', 'This game is over.')
    settleClock(world, m, ctx.now)
    if (m.status !== 'active') throw new WorldError('conflict', m.status === 'aborted' ? 'The game was called off.' : 'Your time ran out.')
    if (turnOf(m) !== seat) throw new WorldError('conflict', 'It is not your turn.')
    play(world, m, seat, move, ctx.now)
    return { ...detail(world, ctx.memberId, m), repeat: false }
  })

  world.register('arena.resign', onlyMatch, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const seat = playerSeat(m, ctx.memberId)
    if (m.status === 'active') {
      settleClock(world, m, ctx.now)
      if (m.status === 'active') forfeit(world, m, seat, 'resigned', ctx.now)
    }
    return detail(world, ctx.memberId, m)
  })

  world.register('arena.draw', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), action: oneOf(raw, 'action', ['offer', 'accept', 'decline'] as const) }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const seat = playerSeat(m, ctx.memberId)
    if (m.status !== 'active') throw new WorldError('conflict', 'This game is over.')
    settleClock(world, m, ctx.now)
    if (m.status !== 'active') return detail(world, ctx.memberId, m)
    const other = 1 - seat
    const agree = (): void => {
      if (m.moves.length < ARENA.minMovesEach * m.seats.length) abort(world, m, 'A draw was agreed before the game had really begun, so it was called off. Nothing was counted.', ctx.now)
      else { finish(world, m, { winners: [], draw: true, reason: 'agreed', text: 'Draw agreed.', scores: m.seats.map(() => 0.5) }, ctx.now); pushMatch(world, m, m.moves.length) }
    }
    if (input.action === 'offer') {
      if (m.seats[other]!.computer) throw new WorldError('conflict', 'The computer plays every game to the end.')
      if (m.drawOffer === other) agree()
      else if (m.drawOffer !== seat) {
        const mine = m.seats[seat]!
        if (mine.drawAskedAt === m.moves.length) throw new WorldError('conflict', 'You have already offered a draw on this move.')
        mine.drawAskedAt = m.moves.length
        m.drawOffer = seat
        world.touch()
        pushMatch(world, m, m.moves.length)
      }
    } else if (m.drawOffer !== other) throw new WorldError('conflict', 'There is no draw offer to answer.')
    else if (input.action === 'accept') agree()
    else { m.drawOffer = null; world.touch(); pushMatch(world, m, m.moves.length) }
    return detail(world, ctx.memberId, m)
  })

  world.register('arena.rematch', onlyMatch, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = ctx.memberId
    const seat = playerSeat(m, me)
    const again = rematchFor(world, m, me)
    if (again) {
      // The other player already asked: asking too is the acceptance.
      if (again.status === 'waiting' && again.host !== me && invitedOf(again) === me) accept(again, me, ctx.now)
      return { match: matchView(world, me, again) }
    }
    if (m.status !== 'finished' && m.status !== 'aborted') throw new WorldError('conflict', 'A rematch is possible once the game is over.')
    world.limit(`arena-create:${me}`, 12, MINUTE)
    need(m.game)
    if (openCount(world, me) >= ARENA.maxOpenMatches) throw new WorldError('conflict', `You already have ${ARENA.maxOpenMatches} games going or waiting. Finish or cancel one first.`)
    const other = m.seats[1 - seat]!
    // Seats swap: whoever moved second moves first this time. The terms are the ones the game was played on:
    // a casual game stays casual, and so does one played for fun, whichever day the rematch is accepted.
    const options = { timeControl: m.timeControl, rated: m.rated, audience: m.audience, communityId: m.communityId, hostSeat: 1 - seat, rematchOf: m.id }
    let next: MatchRec
    if (other.computer) {
      next = newMatch(world, me, m.game, { kind: 'computer', level: other.computer }, options, ctx.now)
      start(world, next, { computer: other.computer }, ctx.now)
    } else {
      const them = other.member!
      if (!exists(world, them) || isBlockedEitherWay(world, me, them)) throw new WorldError('forbidden', 'That player cannot be challenged.')
      next = newMatch(world, me, m.game, { kind: 'member', memberId: them }, options, ctx.now)
      emit(world, {
        to: them, category: 'challenges', kind: 'arena.challenge', title: `${nameOf(world, me)} wants a rematch at ${ARENA_GAME_NAME[m.game]}`,
        body: `${timeControl(next.timeControl).label}. ${next.rated ? 'Rated' : 'Casual'}.`, link: linkOf(next.id), actor: me, dedupeKey: `arena:${next.id}`, expiresAt: next.expiresAt,
      })
    }
    m.rematch = next.id
    world.touch()
    changed(world, next)
    pushMatch(world, m, m.moves.length)
    if (next.status === 'active') pushMatch(world, next, 0)
    return { match: matchView(world, me, next) }
  })

  // ── Chat ──

  world.register('arena.chat', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), text: str(raw, 'text', { min: 1, max: ARENA.chat.maxLength }), clientId: str(raw, 'clientId', { min: 1, max: 40 }) }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = ctx.memberId
    const seat = seatOf(m, me)
    if (!hasBoard(m) || (seat < 0 && !mayWatch(world, me, m))) throw new WorldError('forbidden', 'This chat is not open to you.')
    // The same message sent again (a retry) is the same line.
    const already = m.chat.find(line => line.from === me && line.clientId === input.clientId)
    if (already) return { line: chatLine(world, me, already), rev: m.rev }
    world.limit(`arena-chat:${me}`, ARENA.chat.perWindow, ARENA.chat.windowSeconds * SECOND)
    const line: ChatRec = { id: newId<ArenaMatchId>('al'), at: ctx.now, from: me, role: seat >= 0 ? 'player' : 'watching', text: input.text, clientId: input.clientId }
    m.chat.push(line)
    if (m.chat.length > ARENA.chat.kept) m.chat.splice(0, m.chat.length - ARENA.chat.kept)
    const rev = advance(m)
    world.touch()
    const to = new Set<MemberId>([...humans(m), ...presentIn(world, m)])
    for (const memberId of to) {
      if (memberId === me || isBlockedEitherWay(world, memberId, me)) continue
      const theirSeat = seatOf(m, memberId)
      if (theirSeat < 0 && !mayWatch(world, memberId, m)) continue
      if (theirSeat >= 0 && m.seats[theirSeat]!.focus && line.role === 'watching') continue
      world.push(memberId, { type: 'arena.chat', matchId: m.id, line: chatLine(world, memberId, line), rev })
    }
    return { line: chatLine(world, me, line), rev }
  })

  world.register('arena.chatHistory', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), before: raw.before === null || raw.before === undefined ? null : str(raw, 'before', { min: 3, max: 48 }) }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    if (!hasBoard(m) || (seatOf(m, ctx.memberId) < 0 && !mayWatch(world, ctx.memberId, m))) throw new WorldError('forbidden', 'This chat is not open to you.')
    return chatFor(world, ctx.memberId, m, input.before)
  })

  world.register('arena.focus', value => {
    const raw = obj(value)
    return { matchId: matchIdIn(raw), on: bool(raw, 'on') }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const seat = playerSeat(m, ctx.memberId)
    const mine = m.seats[seat]!
    // What this player's own snapshots show has changed (their chat list): an older one must not put it back.
    if (mine.focus !== input.on) { mine.focus = input.on; advance(m) }
    world.touch()
    const chat = chatFor(world, ctx.memberId, m, null)
    return { focus: input.on, chat: chat.lines, chatMore: chat.more, rev: m.rev }
  })

  // ── Standings ──

  world.register('arena.standings', value => {
    const raw = obj(value)
    return {
      game: oneOf(raw, 'game', ARENA_GAMES), scope: oneOf(raw, 'scope', STANDING_SCOPES), view: oneOf(raw, 'view', ['rating', 'week'] as const),
      communityId: optId<CommunityId>(raw, 'communityId', 'c'),
    }
  }, (ctx, input) => ({ standings: standings(world, ctx.memberId, input.game, input.scope, input.view, input.communityId) }), { cost: 2 })

  world.register('arena.myStanding', value => {
    const raw = obj(value)
    return { game: oneOf(raw, 'game', ARENA_GAMES), communityId: optId<CommunityId>(raw, 'communityId', 'c') }
  }, (ctx, input) => ({
    standing: myStanding(world, ctx.memberId, input.game, input.communityId), home: homeView(world, ctx.memberId), publicStandings: isPublic(world, ctx.memberId),
  }), { cost: 3 })

  world.register('arena.privacy', empty, ctx => ({ publicStandings: isPublic(world, ctx.memberId), home: homeView(world, ctx.memberId) }))

  world.register('arena.setPrivacy', value => ({ publicStandings: bool(obj(value), 'publicStandings') }), (ctx, input) => {
    setPublic(world, ctx.memberId, input.publicStandings)
    return { publicStandings: input.publicStandings, home: homeView(world, ctx.memberId) }
  })
}
