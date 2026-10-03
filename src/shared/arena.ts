// The game hall: turn-based games two or more members play against each other or the computer,
// that anyone allowed can watch and talk over, with standings by community, state, country and
// the whole world.
//
// This file is the contract between four pieces of work:
//   - the hall (service/arena/**, src/features/arena/* except games/) — matches, clocks, ratings,
//     watching, chat, standings; it owns ArenaOps and ArenaEvent below;
//   - one rules module per game (src/shared/games/<game>.ts) implementing `Rules`;
//   - one board component per game (src/features/arena/games/<game>/Board.vue) following
//     `BoardProps` / `BoardEmits`.
// The first section is FIXED: the hall and the games are written against it at the same time.
// Change it only by agreement with the coordinator.
import type { Iso, MemberId } from './ids.ts'

// ── Fixed: games and the rules interface ──────────────────────────────────────────────────────

/** 'walls' — race across the board and block with walls. 'chess'. 'words' — crossword tile game. */
export const ARENA_GAMES = ['walls', 'chess', 'words'] as const
export type ArenaGame = (typeof ARENA_GAMES)[number]

/** Thrown by a rules module for a move that is not allowed. `message` is shown to the player. */
export class RulesError extends Error {}

export interface Outcome {
  /** Seats that won. Empty with `draw: true` for a draw. */
  winners: number[]
  draw: boolean
  /** Short machine reason: 'checkmate', 'stalemate', 'reached-goal', 'out-of-tiles', 'resigned', 'time', 'agreed', … */
  reason: string
  /** One sentence for people: "Ada reached the far side." Seats are named by the hall, so write "{0}" / "{1}" for seat names. */
  text: string
  /** Final score per seat where the game has one (words); otherwise 1 / 0.5 / 0. */
  scores: number[]
}

/** What a rules module may ask of its surroundings. The service supplies it; the App passes `{}`. */
export interface RulesEnv {
  /** Word games: is this an accepted word? Upper-case A–Z. Only the service has the list. */
  isWord?(word: string): boolean
}

/**
 * One game's rules. Pure and deterministic: no clock, no randomness except through the arguments,
 * no I/O. State and moves are plain JSON (they are saved and sent as they are).
 */
export interface Rules<State = unknown, Move = unknown, View = unknown> {
  readonly game: ArenaGame
  readonly seats: { min: number; max: number }
  /** A new game. Anything random (a tile bag) is drawn from `seed`. */
  start(seats: number, seed: number): State
  /** The seat to move, or null when the game is over. */
  turn(state: State): number | null
  /** Check an untrusted value has the shape of a move. Throws RulesError when it does not. */
  parseMove(input: unknown): Move
  /** The state after `seat` plays `move`. Never changes `state`. Throws RulesError with a plain reason when the move is not allowed. */
  apply(state: State, seat: number, move: Move): State
  /** Null while the game is going. */
  outcome(state: State): Outcome | null
  /** What `seat` may see; `null` is a spectator. Hidden things (a rack, the bag order) are left out. */
  view(state: State, seat: number | null): View
  /** A move for the computer at level 1 (easy) to 3 (hard). Must return well inside 400 ms on a slow machine. */
  bot(state: State, seat: number, level: 1 | 2 | 3, random: () => number): Move
  /** The move in a line for the move list: "e4", "Wall at c3, across", "QUIZ for 34". Called with the state BEFORE the move. */
  describe(state: State, seat: number, move: Move): string
  /** The seat that resigns or runs out of time loses; with more than two seats, how the rest are placed. */
  forfeit(state: State, seat: number, reason: 'resigned' | 'time' | 'left'): State
}

/** Every rules module exports this under the name `createRules`. */
export type CreateRules<State = unknown, Move = unknown, View = unknown> = (env: RulesEnv) => Rules<State, Move, View>

/** Props every board component takes. `view` is what Rules.view returned for this viewer. */
export interface BoardProps<View = unknown, Move = unknown> {
  view: View
  /** The viewer's seat, or null when watching. */
  seat: number | null
  /** True when it is the viewer's turn and a move may be sent. */
  canMove: boolean
  /** The last move played, for highlighting; null at the start. */
  lastMove: { seat: number; move: Move } | null
  /** Names for seats, in seat order. */
  seatNames: string[]
  /** The hall's refusal of the last move sent, shown near the board; '' when there is none. */
  problem: string
  /** The hall or practice host's final result, including timeouts and called-off games. Null while playing. */
  endText: string | null
}
/** Board components emit `move` with a value Rules.parseMove accepts. Nothing else is sent to the service. */
export type BoardEmits<Move = unknown> = { move: [move: Move] }

// ── Owned by the hall: operations and events (merged into the protocol) ───────────────────────
import type { CommunityId, Id } from './ids.ts'
import type { AvatarLook, PublicMember } from './model.ts'

export type ArenaMatchId = Id<'arena-match'>

/** What the hall calls each game. A game's own track may name it; the hall's lists use these. */
export const ARENA_GAME_NAME: Record<ArenaGame, string> = { walls: 'Ten Walls', chess: 'Chess', words: 'Word Yard' }
export const COMPUTER_LEVEL_NAME: Record<1 | 2 | 3, string> = { 1: 'Easy', 2: 'Medium', 3: 'Hard' }

/** The hall's numbers. One source for the service (which applies them) and the App (which explains them). */
export const ARENA = {
  rating: {
    start: 1200,
    /** A rating is marked provisional until this many rated games are finished. */
    provisionalGames: 5,
    /** K by rated games already played: 40 for the first 10, 24 up to 30, then 16. */
    k: [{ under: 10, k: 40 }, { under: 30, k: 24 }] as readonly { under: number; k: number }[],
    kSettled: 16,
    floor: 100,
  },
  /** Coins for a win. Play money. A draw or a loss pays nothing. */
  pay: { computer: [3, 5, 8] as readonly number[], human: 20, dailyCap: { computer: 24, human: 100 } },
  /** A game that ends by resigning, leaving or the clock before every player has moved this many times is called off. */
  minMovesEach: 2,
  /** The same two members' games count (rating, coins, weekly wins) this many times a UTC day; further games are for fun. */
  countedPairGamesPerDay: 5,
  /** Live games: the first move of each player must come within this, or the game is called off. */
  firstMoveSeconds: 120,
  /** Live games between two members: a player who is disconnected this long loses. */
  disconnectGraceSeconds: 60,
  challengeHours: { live: 24, daily: 72 },
  queueMinutes: { live: 10, daily: 1440 },
  /** A member may have this many games going or waiting at once. */
  maxOpenMatches: 12,
  chat: { maxLength: 240, perWindow: 8, windowSeconds: 20, kept: 300, page: 40 },
  standingsTop: 100,
  /** Finished games are kept this long (the computer's for less) so they can be opened again. */
  keepDays: { human: 30, computer: 3 },
} as const

export const TIME_CONTROLS = [
  { id: '3+2', name: 'Blitz', label: '3 minutes each, plus 2 seconds a move', short: '3 + 2', baseMs: 180_000, incrementMs: 2_000, daily: false },
  { id: '5+0', name: 'Quick', label: '5 minutes each', short: '5 min', baseMs: 300_000, incrementMs: 0, daily: false },
  { id: '10+5', name: 'Steady', label: '10 minutes each, plus 5 seconds a move', short: '10 + 5', baseMs: 600_000, incrementMs: 5_000, daily: false },
  { id: '15+10', name: 'Long', label: '15 minutes each, plus 10 seconds a move', short: '15 + 10', baseMs: 900_000, incrementMs: 10_000, daily: false },
  { id: 'daily', name: 'A day a move', label: 'One day for each move', short: 'Daily', baseMs: 86_400_000, incrementMs: 0, daily: true },
] as const
export type TimeControlId = (typeof TIME_CONTROLS)[number]['id']
export const TIME_CONTROL_IDS = TIME_CONTROLS.map(entry => entry.id) as readonly TimeControlId[]
export const timeControl = (id: TimeControlId): (typeof TIME_CONTROLS)[number] => TIME_CONTROLS.find(entry => entry.id === id) ?? TIME_CONTROLS[1]

/** Who may watch and join the chat: anyone, friends of a player, one community, or nobody but the players. */
export const ARENA_AUDIENCES = ['anyone', 'friends', 'community', 'players'] as const
export type ArenaAudience = (typeof ARENA_AUDIENCES)[number]

/**
 * waiting — a challenge nobody has answered yet, or a place in the queue.
 * aborted — called off before it counted (no first move, a very early resignation, a block); no result.
 */
export type ArenaStatus = 'waiting' | 'active' | 'finished' | 'declined' | 'cancelled' | 'expired' | 'aborted'

export type ArenaOpponent =
  | { kind: 'friend'; memberId: MemberId }
  /** An open challenge the first member of this community to accept takes. */
  | { kind: 'community'; communityId: CommunityId }
  /** "Find me someone": paired with the next member who asks for the same game, time and rated/casual. */
  | { kind: 'queue' }
  | { kind: 'computer'; level: 1 | 2 | 3 }

export interface ArenaGameInfo {
  game: ArenaGame
  /** False while the game's rules are not installed on this service: it is listed as coming soon. */
  available: boolean
  /** Matches being played right now that anyone at all could be watching (a real count, never padded). */
  live: number
}

export interface ArenaPlayer {
  seat: number
  /** Null for the computer, and for a member the viewer may not see. */
  member: PublicMember | null
  computer: 1 | 2 | 3 | null
  name: string
  /** Rating in this game when the match began. Null for the computer. */
  rating: number | null
  provisional: boolean
  /** Set once a rated game is finished. */
  ratingChange: number | null
  /** Coins this player was paid for the result; null while the game is going or when nothing was due. */
  coins: number | null
  /** Time left as of `clock.since`. The App counts the moving player's down from there. */
  clockMs: number
  connected: boolean
}

export interface ArenaClock {
  /** The seat whose time is being spent, or null when no clock is running. */
  seat: number | null
  since: Iso | null
  /** False during the first moves of a live game: time is not spent yet, but `callsOffAt` applies. */
  counting: boolean
  /** When the game is called off for want of a first move; null once every player has moved. */
  callsOffAt: Iso | null
}

/** An `Outcome` with the seat names written in. */
export interface ArenaOutcome { winners: number[]; draw: boolean; reason: string; text: string; scores: number[] }

export type ArenaRole = 'player' | 'invited' | 'watcher' | 'none'

export interface ArenaMatch {
  id: ArenaMatchId
  /**
   * How many times what this match shows has changed: a move, an ending, a draw offer, a chat line,
   * who is here. It only ever rises while the service runs, so of two snapshots or events of one
   * match the higher is the newer, even at the same move and in the same millisecond. For ordering
   * only: it is not a clock, and after a restart it may start again from an older saved value.
   */
  rev: number
  game: ArenaGame
  status: ArenaStatus
  host: MemberId
  /** In seat order once the game has started; before that, the host alone. */
  players: ArenaPlayer[]
  /** A friend challenge that is still waiting for this member's answer. */
  invited: PublicMember | null
  /** Waiting and open to more than one member: the queue, or a community. */
  open: 'queue' | 'community' | null
  timeControl: TimeControlId
  rated: boolean
  /** True when this pair has used up today's counted games: no rating, no coins, no weekly win. */
  forFun: boolean
  audience: ArenaAudience
  communityId: CommunityId | null
  communityName: string | null
  createdAt: Iso
  /** Waiting matches only: when the challenge or queue place lapses. */
  expiresAt: Iso | null
  startedAt: Iso | null
  finishedAt: Iso | null
  lastMoveAt: Iso | null
  /** The seat to move; null before the start and after the end. */
  turn: number | null
  moveCount: number
  clock: ArenaClock
  outcome: ArenaOutcome | null
  /** Declined, cancelled, expired or called off: what happened, in one sentence. */
  endText: string | null
  /** The seat that has offered a draw, while the offer stands. */
  drawOffer: number | null
  rematchOf: ArenaMatchId | null
  rematch: ArenaMatchId | null
  watchers: { count: number; first: PublicMember[] }
  me: {
    role: ArenaRole
    seat: number | null
    /** A waiting challenge this member may accept. */
    canAccept: boolean
    mayChat: boolean
  }
}

export interface ArenaMoveLine { n: number; seat: number; text: string; at: Iso }

export interface ArenaChatLine {
  id: string
  at: Iso
  memberId: MemberId
  displayName: string
  look: AvatarLook
  /** Shown beside the name: a player at the board, or someone watching. */
  role: 'player' | 'watching'
  text: string
  mine: boolean
}

export interface ArenaDetail {
  match: ArenaMatch
  /** What `Rules.view` returned for this member: their own seat's view, or the spectator view. Null before the start. */
  view: unknown
  moves: ArenaMoveLine[]
  lastMove: { seat: number; move: unknown } | null
  chat: ArenaChatLine[]
  /** True when older chat lines exist: ask `arena.chatHistory` with the oldest id shown. */
  chatMore: boolean
  /** Players only: watcher chat is switched off for this member. */
  focus: boolean
  /** The service's clock when this was built, so the App can count down without trusting the device clock. */
  now: Iso
}

/** Standings are kept for these circles. 'state' and 'country' come from the member's home area. */
export const STANDING_SCOPES = ['friends', 'community', 'state', 'country', 'global'] as const
export type StandingScope = (typeof STANDING_SCOPES)[number]
/** 'rating' — all time, by rating. 'week' — most counted wins since Monday 00:00 UTC. */
export type StandingView = 'rating' | 'week'

/** A row never carries a location: the table's scope is the only place a state or country is named. */
export interface StandingRow {
  rank: number; memberId: MemberId; displayName: string; look: AvatarLook
  rating: number; provisional: boolean; played: number; won: number; weekWins: number; isMe: boolean
  /** When the member reached this rating (or their last win of the week). Earlier ranks higher on a tie. */
  since: Iso
}

export interface Standings {
  game: ArenaGame
  scope: StandingScope
  view: StandingView
  /** "Lagos", "Nigeria", or the community's name. Null for friends and global, and when the viewer has no home area. */
  scopeName: string | null
  /** The top of the table, at most ARENA.standingsTop rows. */
  rows: StandingRow[]
  /** The viewer's own row wherever they are; null when they are not in this table. */
  me: StandingRow | null
  /** How many members are ranked in this table. */
  total: number
  /** Why the viewer is not in the table, or what would put them in it. A plain sentence, or null. */
  note: string | null
  week: string | null
  resetsAt: Iso | null
  rules: string
}

export interface ArenaHome { countryCode: string | null; countryName: string | null; region: string | null }

export interface MyStanding {
  game: ArenaGame
  rating: number
  provisional: boolean
  played: number; won: number; drawn: number; lost: number
  weekWins: number
  /** The viewer's place in each circle. `rank` is null when they are not ranked there (see `note`). */
  places: { scope: StandingScope; name: string | null; rank: number | null; of: number; note: string | null }[]
}

type ArenaOp<In, Out> = { in: In; out: Out }
type ArenaNothing = Record<string, never>

export interface ArenaOps {
  /** The three games and whether each can be played on this service. */
  'arena.games': ArenaOp<ArenaNothing, { games: ArenaGameInfo[] }>
  /** My games: going and waiting first (my turn at the top), then recent results. `open` are community challenges I may take. */
  'arena.mine': ArenaOp<ArenaNothing, { matches: ArenaMatch[]; open: ArenaMatch[] }>
  /** Games being played now that I may watch, most watched first. */
  'arena.live': ArenaOp<{ game: ArenaGame | null }, { matches: ArenaMatch[] }>
  'arena.create': ArenaOp<{
    game: ArenaGame; opponent: ArenaOpponent; timeControl: TimeControlId; rated: boolean
    audience: ArenaAudience; communityId: CommunityId | null
  }, { match: ArenaMatch }>
  /** Answer a friend's challenge, or take an open community challenge. */
  'arena.respond': ArenaOp<{ matchId: ArenaMatchId; accept: boolean }, { match: ArenaMatch }>
  /** Withdraw my own challenge or leave the queue. */
  'arena.cancel': ArenaOp<{ matchId: ArenaMatchId }, { match: ArenaMatch }>
  'arena.get': ArenaOp<{ matchId: ArenaMatchId }, ArenaDetail>
  /**
   * Play a move. `moveNumber` is how many moves had been played when the member chose theirs.
   * Sending the same move with the same number again changes nothing (`repeat: true`);
   * a number the game has moved past is refused with code "conflict".
   */
  'arena.move': ArenaOp<{ matchId: ArenaMatchId; moveNumber: number; move: unknown }, ArenaDetail & { repeat: boolean }>
  'arena.resign': ArenaOp<{ matchId: ArenaMatchId }, ArenaDetail>
  'arena.draw': ArenaOp<{ matchId: ArenaMatchId; action: 'offer' | 'accept' | 'decline' }, ArenaDetail>
  /** Ask for another game with the same settings and the seats swapped; the other player's same call accepts. */
  'arena.rematch': ArenaOp<{ matchId: ArenaMatchId }, { match: ArenaMatch }>
  /** Open the match page: the member is counted as present (and, when not a player, as watching). */
  'arena.watch': ArenaOp<{ matchId: ArenaMatchId }, ArenaDetail>
  'arena.unwatch': ArenaOp<{ matchId: ArenaMatchId }, { left: true }>
  /** Ask a friend to come and watch. They are told in their inbox; refused when the game is not open to them. */
  'arena.invite': ArenaOp<{ matchId: ArenaMatchId; memberId: MemberId }, { invited: true }>
  /** `rev` is the match's revision with this line in it (see `ArenaMatch.rev`). */
  'arena.chat': ArenaOp<{ matchId: ArenaMatchId; text: string; clientId: string }, { line: ArenaChatLine; rev: number }>
  /** Chat lines older than `before` (a line id), newest last. */
  'arena.chatHistory': ArenaOp<{ matchId: ArenaMatchId; before: string | null }, { lines: ArenaChatLine[]; more: boolean }>
  /** Players only: switch watcher chat off (or back on) for myself in this match. `rev` is the revision the chat list was read at. */
  'arena.focus': ArenaOp<{ matchId: ArenaMatchId; on: boolean }, { focus: boolean; chat: ArenaChatLine[]; chatMore: boolean; rev: number }>
  'arena.standings': ArenaOp<{ game: ArenaGame; scope: StandingScope; view: StandingView; communityId: CommunityId | null }, { standings: Standings }>
  'arena.myStanding': ArenaOp<{ game: ArenaGame; communityId: CommunityId | null }, { standing: MyStanding; home: ArenaHome; publicStandings: boolean }>
  'arena.privacy': ArenaOp<ArenaNothing, { publicStandings: boolean; home: ArenaHome }>
  /** "Show me in public standings": off removes the member from state, country and global tables. */
  'arena.setPrivacy': ArenaOp<{ publicStandings: boolean }, { publicStandings: boolean; home: ArenaHome }>
}

export type ArenaEvent =
  /** The match as this member may see it, after any change. `moves` are the lines from number `from` on. */
  | { type: 'arena.match'; matchId: ArenaMatchId; match: ArenaMatch; view: unknown; lastMove: { seat: number; move: unknown } | null; from: number; moves: ArenaMoveLine[]; now: Iso }
  /** `rev` is the match's revision with this line in it: a snapshot with a lower one does not have the line. */
  | { type: 'arena.chat'; matchId: ArenaMatchId; line: ArenaChatLine; rev: number }
  /** One of the member's own lists changed (a challenge arrived, a game started or ended). */
  | { type: 'arena.changed'; matchId: ArenaMatchId | null }
  /** The match stopped being open to this member while they had it open. */
  | { type: 'arena.closed'; matchId: ArenaMatchId; reason: string }
