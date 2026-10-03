// Games: friend challenges (Lane Dash), a hidden-hand table game (Eights), spectating and boards.
// The service is the only judge: it replays Lane Dash inputs itself and deals, holds and projects
// every Eights hand. Points are game points, never money.
import type { CommunityId, MatchId, MemberId, RoomKey } from '../src/shared/ids.ts'
import { iso, newId, randomToken } from '../src/shared/ids.ts'
import { WorldError, roomKey } from '../src/shared/model.ts'
import { PAY,
  DASH, MATCH_INVITE_HOURS, SUITS, TABLE_TURN_SECONDS, buildDashCourse, isoWeek, replayDash, seededRandom,
} from '../src/shared/play.ts'
import type {
  Audience, Board, BoardRow, BoardScope, Card, DashAttempt, DashInput, DashResult, GameKind, Match, MatchPlayer, MatchStatus, RejectReason,
  Suit, TableAction, TableView,
} from '../src/shared/play.ts'
import type { World } from './kernel.ts'
import { areFriends, exists, friendsOf, isBlockedEitherWay, record, tryPublicMember } from './members.ts'
import { emit, settle } from './notify.ts'
import { bool, empty, id, list, num, obj, oneOf, optId, optOneOf, str } from './parse.ts'
import type { Raw } from './parse.ts'
import { isCommunityMember, communityMemberIds } from './social.ts'
import { occupantsOfRoom, setRoomGuard } from './rooms.ts'
import { addPoints } from './work.ts'

interface PlayerRec { id: MemberId; state: MatchPlayer['state']; score: number | null; placed: number | null; playedAt: number | null }
interface MatchRec {
  id: MatchId; game: GameKind; status: MatchStatus; host: MemberId; players: PlayerRec[]; audience: Audience; communityId: CommunityId | null
  createdAt: number; expiresAt: number; finishedAt: number | null; winner: MemberId | null
  rematchOf: MatchId | null; rematch: MatchId | null
  /** Lane Dash: every player runs this same course. */
  seed: number
  /** Solo practice: a private one-player match so the same scoring, boards and result shape apply. */
  solo: boolean
}
interface AttemptRec { token: string; member: MemberId; matchId: MatchId; seed: number; startedAt: number; mustSubmitBy: number; consumed: boolean }
interface ScoreRec { member: MemberId; game: GameKind; score: number; at: number; matchId: MatchId }
interface TableRec {
  /** Server-only. Neither the seed nor the draw pile order ever leaves the service. */
  seed: number; shuffles: number; draw: Card[]; discard: Card[]; hands: Record<string, Card[]>
  order: MemberId[]; turn: MemberId | null; activeSuit: Suit | null
  drew: boolean; drawn: Card | null; turnEndsAt: number | null; penalties: Record<string, number> | null; log: string[]
}
interface GameState { matches: Record<string, MatchRec>; attempts: Record<string, AttemptRec>; scores: ScoreRec[]; tables: Record<string, TableRec> }

const state = (world: World): GameState => world.slice<GameState>('games', () => ({ matches: {}, attempts: {}, scores: [], tables: {} }))

const HOUR = 3_600_000, DAY = 86_400_000
const WIN_POINTS = PAY.eightsWin
/** A started Eights game that nobody finishes ends here, so an abandoned table does not run forever. */
const EIGHTS_GAME_HOURS = 2
const DASH_GRACE_MS = 60_000
const GAME_NAME: Record<GameKind, string> = { 'lane-dash': 'Lane Dash', eights: 'Eights' }

const randomSeed = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!
const nameOf = (world: World, memberId: MemberId): string => record(world, memberId).profile.displayName
const tableRoom = (matchId: MatchId): RoomKey => roomKey({ kind: 'table', matchId })
const linkOf = (matchId: MatchId): string => `/games/match/${matchId}`

// ── Who may see what ──

const entryOf = (m: MatchRec, memberId: MemberId): PlayerRec | undefined => m.players.find(p => p.id === memberId)
/** Playing or invited — someone with a seat or a pending invite is a participant, whatever the status. */
const isParticipant = (m: MatchRec, memberId: MemberId): boolean => entryOf(m, memberId) !== undefined

/** Spectating rule: audience, never a player, and never anyone blocked either way with a player. */
function mayWatch(world: World, viewer: MemberId, m: MatchRec): boolean {
  if (m.solo || isParticipant(m, viewer) || !exists(world, viewer)) return false
  if (m.players.some(p => isBlockedEitherWay(world, viewer, p.id))) return false
  const seated = m.players.filter(p => p.state === 'joined' || p.state === 'played' || p.id === m.host)
  if (m.audience === 'friends') return seated.some(p => areFriends(world, viewer, p.id))
  if (m.audience === 'community') return m.communityId !== null && isCommunityMember(world, m.communityId, viewer)
  return false
}

// ── Views ──

const open = (m: MatchRec, now: number): boolean => (m.status === 'active' || m.status === 'invited') && now < m.expiresAt

function matchView(world: World, viewer: MemberId, m: MatchRec): Match {
  const players = m.players.flatMap((p): MatchPlayer[] => {
    const member = tryPublicMember(world, viewer, p.id)
    return member ? [{ member, state: p.state, score: p.score, placed: p.placed }] : []
  })
  const me = entryOf(m, viewer)
  const spectators = m.game === 'eights' && !m.solo ? occupantsOfRoom(world, tableRoom(m.id)).filter(who => !isParticipant(m, who)).length : 0
  return {
    id: m.id, game: m.game, status: m.status, host: m.host, players, audience: m.audience, communityId: m.communityId,
    createdAt: iso(m.createdAt), expiresAt: iso(m.expiresAt), finishedAt: m.finishedAt ? iso(m.finishedAt) : null, winner: m.winner,
    rematchOf: m.rematchOf, rematch: m.rematch,
    canPlay: m.game === 'lane-dash' && me?.state === 'joined' && open(m, world.now()), spectators,
  }
}

const topOf = (t: TableRec): Card | null => t.discard[t.discard.length - 1] ?? null

/** One view per recipient. A player gets only their own hand; a spectator gets none. Seats carry counts. */
export function tableViewFor(world: World, m: MatchRec, viewer: MemberId): TableView | null {
  const t = state(world).tables[m.id]
  if (!t) return null
  const player = t.order.includes(viewer)
  const live = m.status === 'active'
  const seats = t.order.flatMap(memberId => {
    const member = tryPublicMember(world, viewer, memberId)
    return member ? [{ member, cardCount: t.hands[memberId]!.length, connected: world.isOnline(memberId), penalty: t.penalties?.[memberId] ?? null }] : []
  })
  return {
    role: player ? 'player' : 'spectator', seats, turn: live ? t.turn : null, topCard: topOf(t), activeSuit: t.activeSuit,
    drawPileCount: t.draw.length, hand: player ? t.hands[viewer]!.map(card => ({ ...card })) : null,
    drewThisTurn: player && live && t.turn === viewer && t.drew,
    turnEndsAt: live && t.turnEndsAt ? iso(t.turnEndsAt) : null, log: t.log.slice(-20),
  }
}

const changed = (world: World, m: MatchRec): void => {
  for (const p of m.players) world.push(p.id, { type: 'match.changed', matchId: m.id })
}

/** After any table change: each player gets their own view, each allowed spectator in the room gets theirs. */
function pushTable(world: World, m: MatchRec): void {
  const t = state(world).tables[m.id]
  if (!t) return
  for (const memberId of t.order) world.push(memberId, { type: 'table.state', matchId: m.id, table: tableViewFor(world, m, memberId)! })
  for (const memberId of occupantsOfRoom(world, tableRoom(m.id))) {
    if (t.order.includes(memberId) || !mayWatch(world, memberId, m)) continue
    world.push(memberId, { type: 'table.state', matchId: m.id, table: tableViewFor(world, m, memberId)! })
  }
}

function findMatch(world: World, matchId: MatchId): MatchRec {
  const found = state(world).matches[matchId]
  if (!found) throw new WorldError('not_found', 'That match was not found.')
  return found
}

// ── Creating and answering ──

function createMatch(world: World, host: MemberId, game: GameKind, invite: MemberId[], audience: Audience, communityId: CommunityId | null, rematchOf: MatchId | null): MatchRec {
  const now = world.now()
  const m: MatchRec = {
    id: newId<MatchId>('mt'), game, status: 'invited', host,
    players: [{ id: host, state: 'joined', score: null, placed: null, playedAt: null }, ...invite.map((who): PlayerRec => ({ id: who, state: 'invited', score: null, placed: null, playedAt: null }))],
    audience, communityId, createdAt: now, expiresAt: now + MATCH_INVITE_HOURS * HOUR, finishedAt: null, winner: null,
    rematchOf, rematch: null, seed: randomSeed(), solo: false,
  }
  state(world).matches[m.id] = m
  world.touch()
  for (const who of invite) {
    emit(world, {
      to: who, category: 'challenges', kind: 'match.invited', title: `${nameOf(world, host)} challenged you to ${GAME_NAME[game]}`,
      body: game === 'eights' ? 'A card game for 2 to 4. Answer within 48 hours.' : 'Same course for everyone. Answer within 48 hours.',
      link: linkOf(m.id), actor: host, dedupeKey: `match:${m.id}`, expiresAt: m.expiresAt,
    })
  }
  changed(world, m)
  return m
}

// Players whose invite is unanswered when a match ends: their notification stops asking for a reply.
function settleInvites(world: World, m: MatchRec, as: 'resolved' | 'expired'): void {
  for (const p of m.players) if (p.state === 'invited') settle(world, p.id, `match:${m.id}`, as)
}

/** Lane Dash: finished once nobody is still deciding or still to play; declined if nobody ever joined. */
function settleDash(world: World, m: MatchRec, now: number): void {
  if (m.status === 'finished' || m.status === 'declined' || m.status === 'expired') return
  if (m.players.some(p => p.state === 'invited' || p.state === 'joined')) return
  if (m.players.some(p => p.state === 'played')) finishDash(world, m, now)
  else { m.status = 'declined'; world.touch() }
}

function finishDash(world: World, m: MatchRec, now: number): void {
  const ranked = m.players.filter(p => p.score !== null)
    .sort((a, b) => b.score! - a.score! || a.playedAt! - b.playedAt!)
  ranked.forEach((p, index) => { p.placed = index + 1 })
  m.winner = ranked[0]?.id ?? null
  m.status = 'finished'
  m.finishedAt = now
  settleInvites(world, m, 'expired')
  world.touch()
}

// ── Eights ──

const RANK_NAME = (rank: number): string => ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[rank] ?? String(rank)
const SUIT_MARK: Record<Suit, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' }
const cardName = (card: Card): string => `${RANK_NAME(card.rank)}${SUIT_MARK[card.suit]}`
const same = (a: Card, b: Card): boolean => a.suit === b.suit && a.rank === b.rank
const penaltyOf = (card: Card): number => (card.rank === 8 ? 50 : card.rank >= 11 ? 10 : card.rank)

function shuffled(cards: Card[], random: () => number): Card[] {
  const out = [...cards]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const say = (t: TableRec, line: string): void => { t.log.push(line); if (t.log.length > 60) t.log.splice(0, t.log.length - 60) }

function startEights(world: World, m: MatchRec, now: number): void {
  const seated = m.players.filter(p => p.state === 'joined')
  const seed = randomSeed()
  const deck: Card[] = SUITS.flatMap(suit => Array.from({ length: 13 }, (_, n): Card => ({ suit, rank: n + 1 })))
  const t: TableRec = {
    seed, shuffles: 0, draw: shuffled(deck, seededRandom(seed)), discard: [], hands: {}, order: seated.map(p => p.id), turn: null,
    activeSuit: null, drew: false, drawn: null, turnEndsAt: null, penalties: null, log: [],
  }
  const each = seated.length === 2 ? 7 : 5
  for (const memberId of t.order) t.hands[memberId] = t.draw.splice(0, each)
  // The starter is never an eight: bury any eights on top at the bottom of the pile.
  while (t.draw[0]!.rank === 8) t.draw.push(t.draw.shift()!)
  t.discard.push(t.draw.shift()!)
  t.activeSuit = topOf(t)!.suit
  t.turn = t.order[0]!
  t.turnEndsAt = now + TABLE_TURN_SECONDS * 1000
  say(t, `Game on. ${nameOf(world, t.turn)} goes first. Starter ${cardName(topOf(t)!)}.`)
  state(world).tables[m.id] = t
  m.status = 'active'
  m.expiresAt = now + EIGHTS_GAME_HOURS * HOUR
  world.touch()
}

/** Draw one card, reshuffling the discard (minus the top) when the pile is empty. Null when nothing is left. */
function drawCard(t: TableRec): Card | null {
  if (t.draw.length === 0 && t.discard.length > 1) {
    const top = t.discard.pop()!
    t.shuffles++
    t.draw = shuffled(t.discard, seededRandom((t.seed + t.shuffles * 7919) >>> 0))
    t.discard = [top]
  }
  return t.draw.shift() ?? null
}

function nextTurn(t: TableRec, now: number): void {
  const at = t.order.indexOf(t.turn!)
  t.turn = t.order[(at + 1) % t.order.length]!
  t.drew = false
  t.drawn = null
  t.turnEndsAt = now + TABLE_TURN_SECONDS * 1000
}

const playable = (t: TableRec, card: Card): boolean => card.rank === 8 || card.suit === t.activeSuit || card.rank === topOf(t)!.rank

function finishEights(world: World, m: MatchRec, t: TableRec, winner: MemberId, now: number): void {
  t.penalties = Object.fromEntries(t.order.map(memberId => [memberId, t.hands[memberId]!.reduce((sum, card) => sum + penaltyOf(card), 0)]))
  const placing = [...t.order].sort((a, b) => t.penalties![a]! - t.penalties![b]! || Number(b === winner) - Number(a === winner))
  for (const p of m.players) {
    if (!t.order.includes(p.id)) continue
    p.state = 'played'
    p.score = p.id === winner ? 1 : 0
    p.placed = placing.indexOf(p.id) + 1
    p.playedAt = now
  }
  t.turn = null
  t.turnEndsAt = null
  m.status = 'finished'
  m.winner = winner
  m.finishedAt = now
  // Recorded here only, and this function only runs while the match is active: once.
  state(world).scores.push({ member: winner, game: 'eights', score: 1, at: now, matchId: m.id })
  addPoints(world, winner, WIN_POINTS, { kind: 'game', text: 'Won a game of Eights' })
  say(t, `${nameOf(world, winner)} played their last card and wins.`)
  for (const p of m.players) {
    emit(world, {
      to: p.id, category: 'challenges', kind: 'match.finished', title: `${nameOf(world, winner)} won Eights`,
      body: 'The game is over. See the final scores.', link: linkOf(m.id), actor: winner, dedupeKey: `match-played:${m.id}`,
    })
  }
  world.touch()
}

function act(world: World, m: MatchRec, t: TableRec, who: MemberId, action: TableAction, now: number): void {
  if (m.status !== 'active') throw new WorldError('conflict', 'This game is not being played right now.')
  if (t.turn !== who) throw new WorldError('conflict', 'It is not your turn.')
  const name = nameOf(world, who)
  const hand = t.hands[who]!
  if (action.kind === 'draw') {
    if (t.drew) throw new WorldError('conflict', 'You already drew this turn. Play that card or pass.')
    const card = drawCard(t)
    if (!card) { say(t, `${name} could not draw and passed.`); nextTurn(t, now); return }
    // Appended last so a client can tell which card is the new one.
    hand.push(card)
    t.drew = true
    t.drawn = card
    say(t, `${name} drew a card.`)
    return
  }
  if (action.kind === 'pass') {
    if (!t.drew) throw new WorldError('conflict', 'Draw a card first, or play one.')
    say(t, `${name} passed.`)
    nextTurn(t, now)
    return
  }
  const index = hand.findIndex(card => same(card, action.card))
  if (index < 0) throw new WorldError('invalid', 'You do not hold that card.')
  const card = hand[index]!
  if (t.drew && !same(card, t.drawn!)) throw new WorldError('conflict', 'After drawing you can only play the card you drew, or pass.')
  if (!playable(t, card)) throw new WorldError('conflict', `${cardName(card)} does not match the top card or the suit in play.`)
  if (card.rank === 8 && !action.chooseSuit) throw new WorldError('invalid', 'Choose a suit for your eight.')
  hand.splice(index, 1)
  t.discard.push(card)
  t.activeSuit = card.rank === 8 ? action.chooseSuit! : card.suit
  say(t, card.rank === 8 ? `${name} played ${cardName(card)} and chose ${t.activeSuit}.` : `${name} played ${cardName(card)}.`)
  if (hand.length === 0) { finishEights(world, m, t, who, now); return }
  nextTurn(t, now)
}

// ── Expiry ──

function expireMatch(world: World, m: MatchRec, now: number): void {
  if (m.game === 'lane-dash' && !m.solo && m.players.some(p => p.score !== null)) finishDash(world, m, now)
  else {
    m.status = 'expired'
    settleInvites(world, m, 'expired')
    const t = state(world).tables[m.id]
    if (t) { t.turn = null; t.turnEndsAt = null; say(t, 'The game ran out of time.') }
    world.touch()
  }
  changed(world, m)
  pushTable(world, m)
}

// ── Boards ──

interface Ranked { member: MemberId; score: number; at: number }

/** Best score per member in the window. For Eights the score is the number of wins, reached at the last win. */
function standings(world: World, game: GameKind, members: MemberId[], from: number, to: number): Ranked[] {
  const out: Ranked[] = []
  for (const member of members) {
    const mine = state(world).scores.filter(s => s.member === member && s.game === game && s.at >= from && s.at < to)
    if (mine.length === 0) continue
    if (game === 'eights') { out.push({ member, score: mine.length, at: Math.max(...mine.map(s => s.at)) }); continue }
    const best = mine.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.at < a.at) ? b : a))
    out.push({ member, score: best.score, at: best.at })
  }
  return out
}

const byRank = (a: Ranked, b: Ranked): number => b.score - a.score || a.at - b.at

function toRows(world: World, viewer: MemberId, ranked: Ranked[]): BoardRow[] {
  const rows: BoardRow[] = []
  for (const entry of ranked.sort(byRank)) {
    const member = tryPublicMember(world, viewer, entry.member)
    if (member) rows.push({ rank: rows.length + 1, member, score: entry.score, achievedAt: iso(entry.at), isMe: entry.member === viewer })
  }
  return rows
}

// ── Parsing ──

const parseMemberId = (value: unknown): MemberId => id<MemberId>({ memberId: value } as Raw, 'memberId', 'm')

function parseCard(value: unknown): Card {
  const raw = obj(value, 'card')
  return { suit: oneOf(raw, 'suit', SUITS), rank: num(raw, 'rank', { integer: true, min: 1, max: 13 }) }
}

function parseAction(value: unknown): TableAction {
  const raw = obj(value, 'action')
  const kind = oneOf(raw, 'kind', ['play', 'draw', 'pass'] as const)
  if (kind !== 'play') return { kind }
  const chooseSuit = optOneOf(raw, 'chooseSuit', SUITS)
  return chooseSuit ? { kind, card: parseCard(raw.card), chooseSuit } : { kind, card: parseCard(raw.card) }
}

export function registerGames(world: World): void {
  // ── Table room: players and allowed spectators only ──
  setRoomGuard('table', (guardWorld, memberId, ref) => {
    if (ref.kind !== 'table') return
    const m = state(guardWorld).matches[ref.matchId]
    if (!m || m.game !== 'eights' || m.solo) throw new WorldError('not_found', 'That table was not found.')
    const me = entryOf(m, memberId)
    if (me ? me.state !== 'declined' : mayWatch(guardWorld, memberId, m)) return
    throw new WorldError('forbidden', 'This table is not open to you.')
  })

  const refresh = (memberId: MemberId): void => {
    for (const m of Object.values(state(world).matches)) if (m.status === 'active' && state(world).tables[m.id]?.order.includes(memberId)) pushTable(world, m)
  }
  world.onConnect(refresh)
  world.onDisconnect(refresh)

  world.onTick(now => {
    const data = state(world)
    for (const m of Object.values(data.matches)) {
      if ((m.status === 'invited' || m.status === 'active') && now >= m.expiresAt) { expireMatch(world, m, now); continue }
      const t = data.tables[m.id]
      if (m.status !== 'active' || !t || !t.turn || !t.turnEndsAt || now < t.turnEndsAt) continue
      // Out of time: draw, then pass. The table keeps moving even if someone walks away.
      const who = t.turn
      say(t, `${nameOf(world, who)} ran out of time.`)
      if (!t.drew) act(world, m, t, who, { kind: 'draw' }, now)
      if (t.turn === who && t.drew) act(world, m, t, who, { kind: 'pass' }, now)
      world.touch()
      pushTable(world, m)
    }
    // Housekeeping: old tokens, private practice runs and long-finished matches.
    for (const [token, attempt] of Object.entries(data.attempts)) if (now - attempt.startedAt > DAY) delete data.attempts[token]
    for (const m of Object.values(data.matches)) {
      const ended = m.finishedAt ?? m.expiresAt
      if (m.status !== 'active' && m.status !== 'invited' && now - ended > (m.solo ? DAY : 30 * DAY)) { delete data.matches[m.id]; delete data.tables[m.id] }
    }
  })

  // ── Matches ──

  world.register('match.list', empty, ctx => ({
    matches: Object.values(state(world).matches).filter(m => !m.solo && isParticipant(m, ctx.memberId))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(m => matchView(world, ctx.memberId, m)),
  }))

  world.register('match.open', empty, ctx => ({
    matches: Object.values(state(world).matches).filter(m => m.game === 'eights' && m.status === 'active' && mayWatch(world, ctx.memberId, m))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(m => matchView(world, ctx.memberId, m)),
  }))

  world.register('match.get', value => ({ matchId: id<MatchId>(obj(value), 'matchId', 'mt') }), (ctx, input) => {
    const m = findMatch(world, input.matchId)
    // Participants always get their match back, even once it expired or was declined.
    const viewer = isParticipant(m, ctx.memberId) ? 'player' : mayWatch(world, ctx.memberId, m) ? 'spectator' : null
    if (!viewer) throw new WorldError('forbidden', 'This match is not open to you.')
    return { match: matchView(world, ctx.memberId, m), table: m.game === 'eights' ? tableViewFor(world, m, ctx.memberId) : null, viewer }
  })

  world.register('match.create', value => {
    const raw = obj(value)
    return {
      game: oneOf(raw, 'game', ['lane-dash', 'eights'] as const), invite: list(raw, 'invite', parseMemberId, { max: 3 }),
      audience: oneOf(raw, 'audience', ['players-only', 'friends', 'community'] as const), communityId: optId<CommunityId>(raw, 'communityId', 'c'),
    }
  }, (ctx, input) => {
    world.limit(`match-create:${ctx.memberId}`, 20, 60_000)
    const invite = [...new Set(input.invite)]
    if (invite.length < 1 || invite.length > 3) throw new WorldError('invalid', 'Invite between 1 and 3 friends.')
    for (const who of invite) {
      if (who === ctx.memberId) throw new WorldError('invalid', 'You are already in your own match.')
      if (!exists(world, who) || isBlockedEitherWay(world, ctx.memberId, who) || !areFriends(world, ctx.memberId, who)) throw new WorldError('forbidden', 'You can only challenge your friends.')
    }
    if (input.audience === 'community' && !(input.communityId && isCommunityMember(world, input.communityId, ctx.memberId))) {
      throw new WorldError('forbidden', 'Join the community before opening a match to it.')
    }
    const communityId = input.audience === 'community' ? input.communityId : null
    return { match: matchView(world, ctx.memberId, createMatch(world, ctx.memberId, input.game, invite, input.audience, communityId, null)) }
  })

  world.register('match.respond', value => {
    const raw = obj(value)
    return { matchId: id<MatchId>(raw, 'matchId', 'mt'), accept: bool(raw, 'accept') }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const me = entryOf(m, ctx.memberId)
    if (!me) throw new WorldError('forbidden', 'You were not invited to this match.')
    if (me.state !== 'invited') return { match: matchView(world, ctx.memberId, m) }
    const answerable = m.status === 'invited' || (m.game === 'lane-dash' && m.status === 'active')
    if (!answerable || ctx.now >= m.expiresAt) throw new WorldError('expired', 'This challenge is no longer open.')
    me.state = input.accept ? 'joined' : 'declined'
    settle(world, ctx.memberId, `match:${m.id}`)
    if (m.game === 'eights') {
      if (!m.players.some(p => p.state === 'invited')) {
        if (m.players.filter(p => p.state === 'joined').length >= 2) startEights(world, m, ctx.now)
        else m.status = 'declined'
      }
    } else {
      if (input.accept && m.status === 'invited') m.status = 'active'
      settleDash(world, m, ctx.now)
    }
    world.touch()
    changed(world, m)
    pushTable(world, m)
    return { match: matchView(world, ctx.memberId, m) }
  })

  world.register('match.rematch', value => ({ matchId: id<MatchId>(obj(value), 'matchId', 'mt') }), (ctx, input) => {
    const m = findMatch(world, input.matchId)
    if (!isParticipant(m, ctx.memberId) || entryOf(m, ctx.memberId)!.state === 'declined') throw new WorldError('forbidden', 'Only players can ask for a rematch.')
    if (m.rematch) {
      const existing = state(world).matches[m.rematch]
      if (existing) return { match: matchView(world, ctx.memberId, existing) }
    }
    if (m.status !== 'finished' || m.solo) throw new WorldError('conflict', 'A rematch is possible once a match has finished.')
    world.limit(`match-create:${ctx.memberId}`, 20, 60_000)
    const others = m.players.filter(p => (p.state === 'joined' || p.state === 'played') && p.id !== ctx.memberId).map(p => p.id)
    if (others.length < 1) throw new WorldError('conflict', 'There is nobody left to play.')
    for (const who of others) {
      if (!exists(world, who) || isBlockedEitherWay(world, ctx.memberId, who) || !areFriends(world, ctx.memberId, who)) throw new WorldError('forbidden', 'You can only challenge your friends.')
    }
    const next = createMatch(world, ctx.memberId, m.game, others, m.audience, m.communityId, m.id)
    m.rematch = next.id
    world.touch()
    changed(world, m)
    return { match: matchView(world, ctx.memberId, next) }
  })

  // ── Lane Dash ──

  world.register('dash.begin', value => ({ matchId: optId<MatchId>(obj(value), 'matchId', 'mt') }), (ctx, input) => {
    world.limit(`dash-begin:${ctx.memberId}`, 30, 60_000)
    const data = state(world)
    let m: MatchRec
    if (input.matchId === null) {
      // Practice: one private match per member, reused with a fresh course each time.
      const existing = Object.values(data.matches).find(x => x.solo && x.host === ctx.memberId && x.status === 'active')
      if (existing) { m = existing; m.seed = randomSeed() }
      else {
        m = {
          id: newId<MatchId>('mt'), game: 'lane-dash', status: 'active', host: ctx.memberId,
          players: [{ id: ctx.memberId, state: 'joined', score: null, placed: null, playedAt: null }], audience: 'players-only', communityId: null,
          createdAt: ctx.now, expiresAt: 0, finishedAt: null, winner: null, rematchOf: null, rematch: null, seed: randomSeed(), solo: true,
        }
        data.matches[m.id] = m
      }
      m.expiresAt = ctx.now + HOUR
    } else {
      m = findMatch(world, input.matchId)
      const me = entryOf(m, ctx.memberId)
      if (!me || m.game !== 'lane-dash') throw new WorldError('forbidden', 'You are not playing in this match.')
      if (me.state === 'invited') throw new WorldError('conflict', 'Accept the challenge before you play.')
      if (me.state === 'played') throw new WorldError('conflict', 'You have already played this one.')
      if (me.state === 'declined' || !open(m, ctx.now)) throw new WorldError('conflict', 'This match is not open for play.')
    }
    // One open attempt per member and match: a new one replaces the old.
    for (const old of Object.values(data.attempts)) if (old.member === ctx.memberId && old.matchId === m.id && !old.consumed) old.consumed = true
    const course = buildDashCourse(m.seed)
    const startedAt = ctx.now
    const attempt: AttemptRec = {
      token: randomToken(24), member: ctx.memberId, matchId: m.id, seed: m.seed, startedAt,
      mustSubmitBy: startedAt + course.rowTick[course.rowTick.length - 1]! * DASH.tickMs + DASH_GRACE_MS, consumed: false,
    }
    data.attempts[attempt.token] = attempt
    world.touch()
    const out: DashAttempt = { matchId: m.id, seed: attempt.seed, attemptToken: attempt.token, startedAt: iso(startedAt), mustSubmitBy: iso(attempt.mustSubmitBy) }
    return { attempt: out }
  })

  world.register('dash.submit', value => {
    const raw = obj(value)
    // Only a token and lane changes are read. Any other field, such as a claimed score, is ignored.
    return {
      attemptToken: str(raw, 'attemptToken', { min: 8, max: 64 }),
      inputs: list(raw, 'inputs', (entry): DashInput => {
        const input = obj(entry, 'input')
        return { tick: num(input, 'tick', { integer: true, min: 0, max: 100_000 }), lane: num(input, 'lane', { integer: true, min: -1000, max: 1000 }) }
      }, { max: 400 }),
    }
  }, (ctx, input): DashResult => {
    const data = state(world)
    const attempt = data.attempts[input.attemptToken]
    if (!attempt) throw new WorldError('not_found', 'That attempt was not found.')
    const m = findMatch(world, attempt.matchId)
    const result = (reason: RejectReason | null, outcome: DashResult['outcome']): DashResult =>
      ({ accepted: reason === null, reason, outcome, match: matchView(world, ctx.memberId, m) })
    // Someone else's token is refused without being spent.
    if (attempt.member !== ctx.memberId) return result('not-your-match', null)
    if (attempt.consumed) return result('already-submitted', null)
    // From here the token is spent, accepted or not.
    attempt.consumed = true
    world.touch()
    const me = entryOf(m, ctx.memberId)
    if (!me || me.state !== 'joined' || !open(m, ctx.now)) return result('match-closed', null)
    const outcome = replayDash(buildDashCourse(attempt.seed), input.inputs)
    if (!outcome) return result('illegal-inputs', null)
    if (ctx.now - attempt.startedAt < outcome.endTick * DASH.tickMs * 0.85) return result('too-fast', null)
    if (ctx.now > attempt.mustSubmitBy) return result('too-late', null)
    me.state = 'played'
    me.score = outcome.score
    me.playedAt = ctx.now
    data.scores.push({ member: ctx.memberId, game: 'lane-dash', score: outcome.score, at: ctx.now, matchId: m.id })
    addPoints(world, ctx.memberId, Math.floor(outcome.score / PAY.dashScorePerCoin), { kind: 'game', text: `Lane Dash score ${outcome.score}` })
    if (m.solo) finishDash(world, m, ctx.now)
    else {
      for (const other of m.players) {
        if (other.id === ctx.memberId || other.state === 'declined') continue
        emit(world, {
          to: other.id, category: 'challenges', kind: 'match.played', title: `${nameOf(world, ctx.memberId)} scored ${outcome.score} in ${GAME_NAME[m.game]}`,
          body: other.state === 'played' ? 'See how the match ended.' : 'Your turn to beat it.', link: linkOf(m.id), actor: ctx.memberId, dedupeKey: `match-played:${m.id}`,
        })
      }
      settleDash(world, m, ctx.now)
    }
    world.touch()
    changed(world, m)
    return result(null, outcome)
  })

  // ── Eights ──

  world.register('table.act', value => {
    const raw = obj(value)
    return { matchId: id<MatchId>(raw, 'matchId', 'mt'), action: parseAction(raw.action) }
  }, (ctx, input) => {
    const m = findMatch(world, input.matchId)
    const t = state(world).tables[m.id]
    if (m.game !== 'eights') throw new WorldError('invalid', 'That match has no table.')
    if (!t?.order.includes(ctx.memberId)) throw new WorldError('forbidden', 'Only players can act at this table.')
    act(world, m, t, ctx.memberId, input.action, ctx.now)
    world.touch()
    pushTable(world, m)
    if (m.status === 'finished') changed(world, m)
    return { table: tableViewFor(world, m, ctx.memberId)! }
  })

  world.register('table.watch', value => ({ matchId: id<MatchId>(obj(value), 'matchId', 'mt') }), (ctx, input) => {
    const m = findMatch(world, input.matchId)
    if (m.game !== 'eights' || m.solo) throw new WorldError('invalid', 'That match has no table to watch.')
    if (!isParticipant(m, ctx.memberId) && !mayWatch(world, ctx.memberId, m)) throw new WorldError('forbidden', 'This table is not open to you.')
    const table = tableViewFor(world, m, ctx.memberId)
    if (!table) throw new WorldError('conflict', 'This game has not started yet.')
    return { table, match: matchView(world, ctx.memberId, m) }
  })

  // ── Boards ──

  world.register('board.get', value => {
    const raw = obj(value)
    return {
      scope: oneOf(raw, 'scope', ['personal', 'friends', 'community'] as const), game: oneOf(raw, 'game', ['lane-dash', 'eights'] as const),
      communityId: optId<CommunityId>(raw, 'communityId', 'c'),
    }
  }, (ctx, input) => {
    const scope: BoardScope = input.scope
    const unit = input.game === 'eights' ? 'wins' : 'points'
    const ranking = `Higher ${input.game === 'eights' ? 'win count' : 'score'} ranks first; if two are level, whoever reached it first ranks higher.`
    if (scope === 'personal') {
      const mine = state(world).scores.filter(s => s.member === ctx.memberId && s.game === input.game)
      const ranked: Ranked[] = input.game === 'eights'
        ? (mine.length ? [{ member: ctx.memberId, score: mine.length, at: Math.max(...mine.map(s => s.at)) }] : [])
        : mine.map(s => ({ member: s.member, score: s.score, at: s.at })).sort(byRank).slice(0, 10)
      return { board: { scope, game: input.game, communityId: null, week: null, resetsAt: null, rows: toRows(world, ctx.memberId, ranked), rules: `Your best results of all time, in ${unit}. ${ranking}` } satisfies Board }
    }
    const week = isoWeek(ctx.now)
    let members: MemberId[]
    let communityId: CommunityId | null = null
    if (scope === 'friends') members = [ctx.memberId, ...friendsOf(world, ctx.memberId)]
    else {
      communityId = input.communityId
      if (!communityId || !isCommunityMember(world, communityId, ctx.memberId)) throw new WorldError('forbidden', 'Join the community to see its board.')
      members = communityMemberIds(world, communityId)
    }
    const rows = toRows(world, ctx.memberId, standings(world, input.game, members, week.startsAt, week.endsAt))
    return {
      board: {
        scope, game: input.game, communityId, week: week.label, resetsAt: iso(week.endsAt), rows,
        rules: `${ranking} The board resets every Monday at 00:00 UTC. Blocked members are left out.`,
      } satisfies Board,
    }
  })
}
