// The hall's saved state (one slice) and what it keeps only in memory.
import type { CommunityId, MemberId } from '../../src/shared/ids.ts'
import type { ArenaAudience, ArenaGame, ArenaMatchId, ArenaStatus, Outcome, TimeControlId } from '../../src/shared/arena.ts'
import type { World } from '../kernel.ts'

export interface SeatRec {
  /** Null for the computer. */
  member: MemberId | null
  computer: 1 | 2 | 3 | null
  /** Rating in this game when the match began, and whether it was still provisional. */
  before: number | null
  provisional: boolean
  change: number | null
  coins: number | null
  /** Watcher chat switched off for this player. */
  focus: boolean
  /** Live games: when this player's connection went away; null while connected. */
  awaySince: number | null
  /** The move count at which this seat last offered a draw, so an offer is not repeated on the same move. */
  drawAskedAt: number
}

export interface MoveRec { seat: number; move: unknown; text: string; at: number }
export interface ChatRec { id: string; at: number; from: MemberId; role: 'player' | 'watching'; text: string; clientId: string }

export type OpponentRec =
  /** A named member: a friend's challenge, or a rematch with whoever was just played. */
  | { kind: 'member'; memberId: MemberId }
  | { kind: 'community'; communityId: CommunityId }
  | { kind: 'queue' }
  | { kind: 'computer'; level: 1 | 2 | 3 }

export interface MatchRec {
  id: ArenaMatchId; game: ArenaGame; status: ArenaStatus; host: MemberId
  /** Counts each change to what the match shows (`ArenaMatch.rev`). A record saved before it existed is given 0 when the hall starts. */
  rev: number
  opponent: OpponentRec
  /** Empty until the game starts. Seat order from then on. */
  seats: SeatRec[]
  /** The seat the host takes when the game starts; null leaves it to the seed. */
  hostSeat: number | null
  timeControl: TimeControlId; rated: boolean; forFun: boolean
  audience: ArenaAudience; communityId: CommunityId | null
  createdAt: number; expiresAt: number | null; startedAt: number | null; finishedAt: number | null; lastMoveAt: number | null
  /** Server-only. The full state never leaves the service: members get `Rules.view` of it. */
  seed: number; state: unknown
  moves: MoveRec[]
  /** Time left per seat as of `turnStartedAt`. */
  clocks: number[]
  turnStartedAt: number | null
  /** When the computer plays its next move. */
  botAt: number | null
  drawOffer: number | null
  outcome: Outcome | null
  endText: string | null
  rematchOf: ArenaMatchId | null; rematch: ArenaMatchId | null
  chat: ChatRec[]
}

export interface RatingRec {
  rating: number; played: number; won: number; drawn: number; lost: number
  /** When the rating last changed. */
  since: number
  /** ISO week of `weekWins`, and when the last of them was won. */
  week: string; weekWins: number; weekAt: number
}

/** Where a member's standings belong: the country and first-level area of their first arrival. */
export interface HomeRec { countryCode: string; region: string | null }

export interface ArenaSlice {
  matches: Record<string, MatchRec>
  ratings: Record<string, Partial<Record<ArenaGame, RatingRec>>>
  /** Members who switched "Show me in public standings" off. */
  hidden: Record<string, true>
  homes: Record<string, HomeRec>
  /** Coins paid today, by kind, so a day's wins cannot be farmed. */
  pay: Record<string, { day: number; computer: number; human: number }>
  /** Counted games between two members today. Key: the two ids, sorted, joined by "|". */
  pairs: Record<string, { day: number; count: number }>
  /** The last moment this service was running. After a restart the gap is not charged to anyone's clock. */
  aliveAt: number
}

export const arena = (world: World): ArenaSlice => world.slice<ArenaSlice>('arena', () => ({ matches: {}, ratings: {}, hidden: {}, homes: {}, pay: {}, pairs: {}, aliveAt: 0 }))

/** Kept in memory only: who has which match open, and which matches still need the clock. */
export interface Runtime {
  /** Members with the match page open (players and watchers). */
  present: Map<string, Set<MemberId>>
  /** The reverse, so a disconnect is cheap. */
  looking: Map<MemberId, Set<string>>
  /** Waiting and active matches: the only ones a tick looks at. */
  open: Set<string>
  lastHeartbeat: number
  lastPrune: number
}
const runtimes = new WeakMap<World, Runtime>()
export function runtime(world: World): Runtime {
  let found = runtimes.get(world)
  if (!found) { found = { present: new Map(), looking: new Map(), open: new Set(), lastHeartbeat: 0, lastPrune: 0 }; runtimes.set(world, found) }
  return found
}

export const DAY = 86_400_000, HOUR = 3_600_000, MINUTE = 60_000
export const dayOf = (at: number): number => Math.floor(at / DAY)
