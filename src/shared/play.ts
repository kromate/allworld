// Simulated work, games, results and boards. Everything here is play: points are game points,
// not Goalmatic credits and not money, and a career level is not a real qualification.
import type { CommunityId, DistrictId, Iso, MatchId, MemberId, PlaceId, ShiftId } from './ids.ts'
import type { PublicMember } from './model.ts'

// ── Go to work (simulation) ───────────────────────────────────────────────────────────────────

export const SKILLS = ['service', 'logistics', 'craft'] as const
export type Skill = (typeof SKILLS)[number]

/**
 * The spots inside a venue room where a job is done. The same words the rooms publish for their
 * stations, kept here as plain strings so the service never has to load the 3D world.
 */
export type WorkStationKind = 'counter' | 'till' | 'stall' | 'shelf' | 'ticket-desk'

export interface Workplace {
  id: string
  name: string
  role: string
  skill: Skill
  about: string
  /** Map categories or subclasses whose venues can host this workplace. */
  venueCategories: string[]
  /** Those venues in words, for saying what to look for: "café, restaurant, bakery, bar or hotel". */
  venueWords: string
  /** Where in the room the job is done, best first. Empty when it is done anywhere on the floor. */
  stations: WorkStationKind[]
  /** Things a ticket can ask for. */
  stock: { id: string; label: string; emoji: string }[]
  tasksPerShift: number
  parSeconds: number
}

/** Whether a mapped place can host this workplace, from its map category and subclass. */
export const hostsWork = (workplace: Workplace, category: string, subclass = ''): boolean =>
  workplace.venueCategories.includes(category) || (subclass !== '' && workplace.venueCategories.includes(subclass))

/**
 * The mapped place a shift is worked at. The service fills it from the venue room the member was
 * standing in when the shift began; the App never supplies the place itself.
 */
export interface ShiftSite {
  districtId: DistrictId
  placeId: PlaceId
  venueName: string
}

export interface WorkTask {
  index: number
  customer: string
  /** Stock ids, in the order they must be handed over. */
  wants: string[]
  parSeconds: number
}

export type ShiftStatus = 'active' | 'completed' | 'left-early' | 'timed-out'

export interface TaskOutcome { index: number; correct: boolean; seconds: number; points: number }

export interface Shift {
  id: ShiftId
  workplaceId: string
  /** Null for a practice shift: one started away from any workplace. */
  site: ShiftSite | null
  status: ShiftStatus
  startedAt: Iso
  /** An unfinished shift closes itself at this time and pays for the tasks already done. */
  expiresAt: Iso
  endedAt: Iso | null
  /** The task to do now. Null once every task is answered or the shift is closed. */
  current: WorkTask | null
  done: TaskOutcome[]
  total: number
  /** Filled when the shift closes. */
  result: ShiftResult | null
}

export interface ShiftResult {
  points: number
  xp: number
  skill: Skill
  accuracy: number
  levelBefore: number
  levelAfter: number
  titleAfter: string
}

export interface Career {
  /** Game points earned from play. Not credits, not money, not transferable. */
  points: number
  skills: Record<Skill, { xp: number; level: number; title: string; nextLevelXp: number }>
  shifts: { completed: number; leftEarly: number }
  recent: Shift[]
}

/** What play pays, in coins. One source for the service (which pays) and the App (which says so). */
export const PAY = { ticket: 20, speedBonus: 10, eightsWin: 30, dashScorePerCoin: 10 } as const

export const SHIFT_TIMEOUT_MINUTES = 12

export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 40)) + 1
}
export const xpForLevel = (level: number): number => (level - 1) ** 2 * 40

// ── Friend score challenge: Lane Dash ─────────────────────────────────────────────────────────
// The course comes from a seed the service issues. The client sends back only its lane changes;
// the service replays them over the same course to compute the score itself.

export const DASH = { lanes: 3, rows: 90, tickMs: 110, ticksPerRowStart: 6, ticksPerRowEnd: 3, coinValue: 5, rowValue: 10 } as const

export interface DashInput { tick: number; lane: number }

export interface DashCourse { blocked: boolean[][]; coins: (number | null)[]; rowTick: number[] }

/** Small deterministic generator (mulberry32). Shared so client and service build the same course. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function buildDashCourse(seed: number): DashCourse {
  const random = seededRandom(seed)
  const blocked: boolean[][] = []
  const coins: (number | null)[] = []
  const rowTick: number[] = []
  let tick = 12
  let open = 1
  for (let row = 0; row < DASH.rows; row++) {
    // The open lane drifts by at most one, so every course can be cleared.
    const drift = Math.floor(random() * 3) - 1
    open = Math.max(0, Math.min(DASH.lanes - 1, open + drift))
    const lanes = [true, true, true]
    lanes[open] = false
    if (random() < 0.45) lanes[Math.floor(random() * DASH.lanes)] = false
    blocked.push(lanes)
    const free = lanes.map((isBlocked, lane) => (isBlocked ? -1 : lane)).filter(lane => lane >= 0)
    coins.push(random() < 0.5 ? free[Math.floor(random() * free.length)] ?? null : null)
    rowTick.push(tick)
    const progress = row / DASH.rows
    tick += Math.round(DASH.ticksPerRowStart + (DASH.ticksPerRowEnd - DASH.ticksPerRowStart) * progress)
  }
  return { blocked, coins, rowTick }
}

export interface DashOutcome { score: number; rows: number; coins: number; crashed: boolean; endTick: number }

/** Replay lane changes over a course. Returns null when the input log is not a legal game. */
export function replayDash(course: DashCourse, inputs: DashInput[]): DashOutcome | null {
  let lane = 1
  let next = 0
  let previousTick = -1
  let score = 0, rows = 0, coins = 0
  for (const input of inputs) {
    if (!Number.isInteger(input.tick) || !Number.isInteger(input.lane)) return null
    if (input.tick <= previousTick || input.lane < 0 || input.lane >= DASH.lanes) return null
    previousTick = input.tick
  }
  for (let row = 0; row < course.rowTick.length; row++) {
    const at = course.rowTick[row]!
    while (next < inputs.length && inputs[next]!.tick <= at) {
      const target = inputs[next]!.lane
      if (Math.abs(target - lane) !== 1) return null
      lane = target
      next++
    }
    if (course.blocked[row]![lane]) return { score, rows, coins, crashed: true, endTick: at }
    rows++
    score += DASH.rowValue
    if (course.coins[row] === lane) { coins++; score += DASH.coinValue }
  }
  // Inputs after the last row are not part of a legal game.
  if (next < inputs.length) return null
  return { score, rows, coins, crashed: false, endTick: course.rowTick[course.rowTick.length - 1]! }
}

// ── Table game: Eights ────────────────────────────────────────────────────────────────────────

export const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const
export type Suit = (typeof SUITS)[number]
/** 1 is the ace, 11–13 are jack, queen, king. */
export interface Card { suit: Suit; rank: number }

export type TableAction =
  | { kind: 'play'; card: Card; chooseSuit?: Suit }
  | { kind: 'draw' }
  | { kind: 'pass' }

export interface TableSeat {
  member: PublicMember
  cardCount: number
  connected: boolean
  /** Round score once the game is over. */
  penalty: number | null
}

export interface TableView {
  /** 'player' views include `hand`; 'spectator' views never do. */
  role: 'player' | 'spectator'
  seats: TableSeat[]
  turn: MemberId | null
  topCard: Card | null
  /** Suit to follow. Differs from topCard.suit after an eight. */
  activeSuit: Suit | null
  drawPileCount: number
  hand: Card[] | null
  /** True when the viewer has drawn this turn and may play that card or pass. */
  drewThisTurn: boolean
  turnEndsAt: Iso | null
  log: string[]
}

// ── Matches ───────────────────────────────────────────────────────────────────────────────────

export type GameKind = 'lane-dash' | 'eights'
export type MatchStatus = 'invited' | 'active' | 'finished' | 'expired' | 'declined' | 'cancelled'
export type Audience = 'players-only' | 'friends' | 'community'

export interface MatchPlayer {
  member: PublicMember
  state: 'invited' | 'joined' | 'declined' | 'played'
  /** Accepted score. Null until the service has validated a result. */
  score: number | null
  placed: number | null
}

export interface Match {
  id: MatchId
  game: GameKind
  status: MatchStatus
  host: MemberId
  players: MatchPlayer[]
  audience: Audience
  communityId: CommunityId | null
  createdAt: Iso
  expiresAt: Iso
  finishedAt: Iso | null
  winner: MemberId | null
  /** Set when this match is a rematch of an earlier one. */
  rematchOf: MatchId | null
  /** Filled once a rematch has been created from this match. */
  rematch: MatchId | null
  /** Lane Dash only: whether the viewer still has an attempt to play. */
  canPlay: boolean
  spectators: number
}

export const MATCH_INVITE_HOURS = 48
export const TABLE_TURN_SECONDS = 45

/** Why a submitted result was not accepted. Shown to the player who sent it. */
export type RejectReason = 'already-submitted' | 'illegal-inputs' | 'too-fast' | 'too-late' | 'not-your-match' | 'match-closed'

export interface DashAttempt { matchId: MatchId; seed: number; attemptToken: string; startedAt: Iso; mustSubmitBy: Iso }
export interface DashResult { accepted: boolean; reason: RejectReason | null; outcome: DashOutcome | null; match: Match }

// ── Boards ────────────────────────────────────────────────────────────────────────────────────

export type BoardScope = 'personal' | 'friends' | 'community'

export interface BoardRow { rank: number; member: PublicMember; score: number; achievedAt: Iso; isMe: boolean }

export interface Board {
  scope: BoardScope
  game: GameKind
  communityId: CommunityId | null
  /** ISO week label such as "2026-W40". Weekly boards reset Monday 00:00 UTC. */
  week: string | null
  resetsAt: Iso | null
  rows: BoardRow[]
  rules: string
}

export function isoWeek(at: number): { label: string; startsAt: number; endsAt: number } {
  const date = new Date(at)
  const day = (date.getUTCDay() + 6) % 7
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)
  const thursday = new Date(monday + 3 * 86_400_000)
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1)
  const week = Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000)) + 1
  return { label: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, startsAt: monday, endsAt: monday + 7 * 86_400_000 }
}
