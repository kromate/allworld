// Ten Walls — the hall's wall-race game ('walls').
//
// Two pawns start in the middle of opposite edges of a 9×9 board and race to the far row. A turn
// is one pawn step or one wall. A wall is two squares long, sits in the groove between squares,
// may not overlap or cross another, and may never leave either pawn without a way to its goal.
// A pawn next to the other pawn may jump straight over it, or step to either side of it when a
// wall or the board edge is right behind it. Each side has ten walls.
//
// Squares are named like a chessboard from seat 0's side: columns a–i left to right, rows 1–9 from
// seat 0's home row. Seat 0 starts on e1 and runs to row 9; seat 1 starts on e9 and runs to row 1.
// A wall is named by the square at its lower-left corner plus its direction:
//   "across" — lies along the top edge of that square and of the square to its right (it stops
//              movement between that row and the next);
//   "along"  — lies along the right edge of that square and of the square above it (it stops
//              movement between that column and the next).
// So `{ kind: 'wall', col: 4, row: 2, dir: 'across' }` is "Wall e3 across" (short form e3h), and
// lies between rows 3 and 4 under e4 and f4. Wall corners run a–h and 1–8.
//
// Pure and deterministic. The computer player draws every random choice from the `random` it is
// given and limits its search by counting work, never by reading a clock.
import { RulesError } from '../arena.ts'
import type { CreateRules, Outcome, Rules } from '../arena.ts'

export const WALLS_TITLE = 'Ten Walls'
export const WALLS_TAGLINE = 'Race to the far side. Spend your ten walls to make the other route longer.'

/** Squares per side. */
export const SIZE = 9
/** Walls each side starts with. */
export const WALLS_EACH = 10
/** Wall corners per side: a wall covers two squares, so there are SIZE - 1 places along each line. */
export const SLOTS = SIZE - 1

export type WallDir = 'across' | 'along'
export interface Cell { col: number; row: number }
export interface Wall { col: number; row: number; dir: WallDir }
export interface PlacedWall extends Wall { seat: number }
export type WallsMove = { kind: 'step'; col: number; row: number } | { kind: 'wall'; col: number; row: number; dir: WallDir }
export type WallsEnd = 'reached-goal' | 'resigned' | 'time' | 'left'

export interface WallsState {
  /** Where each seat's pawn stands. */
  pawns: Cell[]
  /** Walls each seat still holds. */
  wallsLeft: number[]
  /** Every wall on the board, in the order they were placed. */
  walls: PlacedWall[]
  /** The seat to move. */
  turn: number
  /** Moves played so far. */
  ply: number
  result: { winner: number; reason: WallsEnd } | null
}
/** Nothing is hidden in this game: everyone sees the whole state. */
export type WallsView = WallsState

/** The row a seat is racing to. */
export const goalRow = (seat: number): number => (seat === 0 ? SIZE - 1 : 0)
const FILES = 'abcdefghi'
export const cellName = (cell: Cell): string => `${FILES[cell.col] ?? '?'}${cell.row + 1}`
export const wallName = (wall: Wall): string => `${cellName(wall)} ${wall.dir}`
/** Short form used in the notes: e2 for a step, e3h / e3v for a wall across / along. */
export const moveCode = (move: WallsMove): string => (move.kind === 'step' ? cellName(move) : `${cellName(move)}${move.dir === 'across' ? 'h' : 'v'}`)

// ── The board as numbers (shared by the rules and the computer player) ─────────────────────────
// Square index = row * 9 + col. Directions: 0 north (row + 1), 1 east (col + 1), 2 south, 3 west.

const CELLS = SIZE * SIZE
const STEP = [SIZE, 1, -SIZE, -1] as const
const BIT = [1, 2, 4, 8] as const
/** Order to try directions in, per seat: towards the goal first, back last. */
const ORDER = [[0, 1, 3, 2], [2, 3, 1, 0]] as const
const EDGE_OPEN = new Uint8Array(CELLS)
for (let cell = 0; cell < CELLS; cell++) {
  const col = cell % SIZE, row = (cell / SIZE) | 0
  EDGE_OPEN[cell] = (row < SIZE - 1 ? 1 : 0) | (col < SIZE - 1 ? 2 : 0) | (row > 0 ? 4 : 0) | (col > 0 ? 8 : 0)
}

class Grid {
  /** Per square: which of the four ways out are open (board edge and walls taken into account). */
  open = Uint8Array.from(EDGE_OPEN)
  across = new Uint8Array(SLOTS * SLOTS)
  along = new Uint8Array(SLOTS * SLOTS)
  pawn = [0, 0]
  left = [0, 0]

  /** Whether the place is free of other walls (overlap and crossing only; routes are checked apart). */
  free(slot: number, along: boolean): boolean {
    if (this.across[slot] || this.along[slot]) return false
    if (along) {
      const row = (slot / SLOTS) | 0
      return !(row > 0 && this.along[slot - SLOTS]) && !(row < SLOTS - 1 && this.along[slot + SLOTS])
    }
    const col = slot % SLOTS
    return !(col > 0 && this.across[slot - 1]) && !(col < SLOTS - 1 && this.across[slot + 1])
  }

  /** Put a wall down or take it up again. Walls never share an edge, so flipping the bits is exact. */
  toggle(slot: number, along: boolean): void {
    const cell = ((slot / SLOTS) | 0) * SIZE + (slot % SLOTS)
    const open = this.open
    if (along) {
      this.along[slot]! ^= 1
      open[cell]! ^= 2; open[cell + SIZE]! ^= 2; open[cell + 1]! ^= 8; open[cell + SIZE + 1]! ^= 8
    } else {
      this.across[slot]! ^= 1
      open[cell]! ^= 1; open[cell + 1]! ^= 1; open[cell + SIZE]! ^= 4; open[cell + SIZE + 1]! ^= 4
    }
  }
}

// Scratch space for the route search. One search runs at a time, start to finish.
const queue = new Uint8Array(CELLS)
const seenAt = new Int32Array(CELLS)
const cameBy = new Uint8Array(CELLS)
const depthOf = new Uint8Array(CELLS)
let stamp = 0
/** Work counter: one per route search. The computer player's budget is counted in these. */
let searches = 0

/**
 * Breadth-first search from `start` to `seat`'s goal row, ignoring pawns. Returns the goal square
 * reached first (so the route is a shortest one) or -1 when the goal is walled off.
 */
function route(open: Uint8Array, start: number, seat: number): number {
  searches++
  const goal = goalRow(seat)
  if (((start / SIZE) | 0) === goal) { depthOf[start] = 0; cameBy[start] = 4; return start }
  const order = ORDER[seat]!
  stamp++
  let head = 0, tail = 0
  queue[tail++] = start; seenAt[start] = stamp; depthOf[start] = 0; cameBy[start] = 4
  while (head < tail) {
    const cell = queue[head++]!
    const ways = open[cell]!
    for (let i = 0; i < 4; i++) {
      const dir = order[i]!
      if (!(ways & BIT[dir]!)) continue
      const next = cell + STEP[dir]!
      if (seenAt[next] === stamp) continue
      seenAt[next] = stamp; cameBy[next] = dir; depthOf[next] = depthOf[cell]! + 1
      if (((next / SIZE) | 0) === goal) return next
      queue[tail++] = next
    }
  }
  return -1
}

/** Squares a pawn may move to: one step, a straight jump, or a step to the side of a blocked jump. Returns how many were written to `out`. */
function stepsInto(grid: Grid, seat: number, out: number[] | Uint8Array): number {
  const me = grid.pawn[seat]!, other = grid.pawn[1 - seat]!
  const open = grid.open
  let count = 0
  for (let dir = 0; dir < 4; dir++) {
    if (!(open[me]! & BIT[dir]!)) continue
    const next = me + STEP[dir]!
    if (next !== other) { out[count++] = next; continue }
    if (open[next]! & BIT[dir]!) { out[count++] = next + STEP[dir]!; continue }
    const left = (dir + 3) & 3, right = (dir + 1) & 3
    if (open[next]! & BIT[left]!) out[count++] = next + STEP[left]!
    if (open[next]! & BIT[right]!) out[count++] = next + STEP[right]!
  }
  return count
}

const indexOf = (cell: Cell): number => cell.row * SIZE + cell.col
const cellAt = (index: number): Cell => ({ col: index % SIZE, row: (index / SIZE) | 0 })
const slotOf = (wall: Wall): number => wall.row * SLOTS + wall.col
const onBoard = (cell: Cell): boolean => Number.isInteger(cell.col) && Number.isInteger(cell.row) && cell.col >= 0 && cell.col < SIZE && cell.row >= 0 && cell.row < SIZE
const onSlots = (wall: Wall): boolean => Number.isInteger(wall.col) && Number.isInteger(wall.row) && wall.col >= 0 && wall.col < SLOTS && wall.row >= 0 && wall.row < SLOTS

function gridOf(state: WallsState): Grid {
  const grid = new Grid()
  for (const wall of state.walls) grid.toggle(slotOf(wall), wall.dir === 'along')
  grid.pawn = [indexOf(state.pawns[0]!), indexOf(state.pawns[1]!)]
  grid.left = [state.wallsLeft[0]!, state.wallsLeft[1]!]
  return grid
}

// ── Helpers for the board (pure; they take the same state the rules do) ────────────────────────

/** Every square `seat`'s pawn may move to now. */
export function legalSteps(state: WallsState, seat: number): Cell[] {
  if (state.result || (seat !== 0 && seat !== 1)) return []
  const out: number[] = []
  const count = stepsInto(gridOf(state), seat, out)
  return out.slice(0, count).map(cellAt)
}

/** Whether a wall stands between two squares that are side by side. */
function wallBetween(state: WallsState, a: Cell, b: Cell): boolean {
  const dir = b.row > a.row ? 0 : b.col > a.col ? 1 : b.row < a.row ? 2 : 3
  return !(gridOf(state).open[indexOf(a)]! & BIT[dir]!)
}

/** Why `seat` may not move its pawn to `to`, in a sentence — or null when the step is allowed. */
export function stepProblem(state: WallsState, seat: number, to: Cell): string | null {
  if (!onBoard(to)) return 'That is off the board.'
  const allowed = legalSteps(state, seat)
  if (allowed.some(cell => cell.col === to.col && cell.row === to.row)) return null
  const me = state.pawns[seat]!, other = state.pawns[1 - seat]!
  const dc = to.col - me.col, dr = to.row - me.row
  const reach = Math.abs(dc) + Math.abs(dr)
  if (reach === 0) return 'Your pawn is already there.'
  const besideOther = Math.abs(other.col - me.col) + Math.abs(other.row - me.row) === 1
  // The advice has to be something the pawn can do: a wall between the two pawns stops the jump
  // and the side steps alike, and the only allowed moves two squares long are ways past the other pawn.
  const parted = besideOther && wallBetween(state, me, other)
  const past = allowed.some(cell => Math.abs(cell.col - me.col) + Math.abs(cell.row - me.row) === 2)
  if (reach === 1) {
    if (to.col !== other.col || to.row !== other.row || parted) return 'A wall is in the way.'
    return past ? 'That square is taken. Jump over it, or step to its side when the jump is blocked.' : 'That square is taken, and there is no way over or round it from here.'
  }
  if (reach === 2 && (dc === 0 || dr === 0)) {
    const between = other.col === me.col + dc / 2 && other.row === me.row + dr / 2
    if (!between) return 'Move one square at a time. You can only jump over the other pawn.'
    if (parted) return 'A wall stands between the two pawns, so there is no jump.'
    return past ? 'A wall is in the way of that jump. Step to the side of the other pawn instead.' : 'A wall is in the way of that jump, and there is no way round the other pawn either.'
  }
  if (reach === 2 && besideOther) return 'You can only step to the side of the other pawn when a wall or the edge blocks the jump straight over, and no wall is in the way.'
  if (reach === 2) return 'Pawns move up, down, left or right — not diagonally.'
  return 'Move one square at a time.'
}

/**
 * Why `seat` may not place `wall`, in a sentence — or null when it is allowed. Checks stock,
 * the board edge, overlap, crossing, and that both pawns keep a way to their goals.
 */
export function wallProblem(state: WallsState, seat: number, wall: Wall): string | null {
  if (state.result) return 'The game is over.'
  if ((state.wallsLeft[seat] ?? 0) <= 0) return 'You have no walls left. Move your pawn.'
  if (!onSlots(wall) || (wall.dir !== 'across' && wall.dir !== 'along')) return 'A wall must lie fully on the board.'
  const grid = gridOf(state)
  const slot = slotOf(wall), along = wall.dir === 'along'
  if (!grid.free(slot, along)) {
    return (along ? grid.across[slot] : grid.along[slot]) ? 'That would cross a wall already there.' : 'That overlaps a wall already there.'
  }
  grid.toggle(slot, along)
  for (const who of [1 - seat, seat]) {
    if (route(grid.open, grid.pawn[who]!, who) < 0) return 'That would leave no way through. Every pawn must keep a route to its goal.'
  }
  return null
}

/** Every wall `seat` may place now. */
export function legalWalls(state: WallsState, seat: number): Wall[] {
  const out: Wall[] = []
  if (state.result || (state.wallsLeft[seat] ?? 0) <= 0) return out
  const grid = gridOf(state)
  for (let slot = 0; slot < SLOTS * SLOTS; slot++) {
    for (const along of [false, true]) {
      if (!grid.free(slot, along)) continue
      grid.toggle(slot, along)
      const fine = route(grid.open, grid.pawn[0]!, 0) >= 0 && route(grid.open, grid.pawn[1]!, 1) >= 0
      grid.toggle(slot, along)
      if (fine) out.push({ col: slot % SLOTS, row: (slot / SLOTS) | 0, dir: along ? 'along' : 'across' })
    }
  }
  return out
}

/** One shortest route for `seat` from its pawn to its goal row (both ends included), ignoring the other pawn. */
export function shortestPath(state: WallsState, seat: number): Cell[] {
  const grid = gridOf(state)
  let cell = route(grid.open, grid.pawn[seat]!, seat)
  if (cell < 0) return []
  const cells: number[] = [cell]
  while (cameBy[cell] !== 4) { cell -= STEP[cameBy[cell]!]!; cells.push(cell) }
  return cells.reverse().map(cellAt)
}

/** Steps `seat` still needs on its shortest route (0 on the goal row), ignoring the other pawn. */
export function stepsToGoal(state: WallsState, seat: number): number {
  const grid = gridOf(state)
  const cell = route(grid.open, grid.pawn[seat]!, seat)
  return cell < 0 ? -1 : depthOf[cell]!
}

/** The position with one more wall on it and nothing else changed — for showing what a wall would do before it is played. */
export function withWall(state: WallsState, seat: number, wall: Wall): WallsState {
  return { ...state, walls: [...state.walls, { col: wall.col, row: wall.row, dir: wall.dir, seat }] }
}

// ── The computer player ────────────────────────────────────────────────────────────────────────
//
// Level 1 walks its shortest route most of the time, wanders now and then, and drops a wall on
// the other side's route without checking how much it helps.
// Level 2 looks two moves ahead (its move and the reply) and scores a position by the difference
// between the two shortest routes.
// Level 3 searches deeper, one more move at a time, for as long as its work budget lasts. At every
// position it considers every pawn move and the walls that cut the other side's current shortest
// route, best first, keeping only the most promising few below the first move.

const WIN = 100_000
const MAX_DEPTH = 8

interface Frame {
  /** Per seat, per square: 1 + the direction the shortest route leaves that square by, or 0 off the route. */
  trail: [Uint8Array, Uint8Array]
  dist: [number, number]
  steps: Uint8Array
  wallSlot: Int16Array
  wallGain: Int16Array
}
interface Search {
  grid: Grid
  frames: Frame[]
  budget: number
  /** Set when the budget ran out part-way; results from then on are not trusted. */
  cut: boolean
  /** Walls kept per position below the first move. */
  keep: number
  /** How much a wall in hand is worth, in tenths of a step. */
  wallWorth: number
  /** Whether to use what is known about pure races once a side has no walls. */
  raceSense: boolean
}

const newFrame = (): Frame => ({
  trail: [new Uint8Array(CELLS), new Uint8Array(CELLS)], dist: [0, 0],
  steps: new Uint8Array(8), wallSlot: new Int16Array(2 * SLOTS * SLOTS), wallGain: new Int16Array(2 * SLOTS * SLOTS),
})

/** Work out `seat`'s shortest route on the grid and record it in the frame. False when there is none. */
function trace(grid: Grid, seat: number, frame: Frame): boolean {
  let cell = route(grid.open, grid.pawn[seat]!, seat)
  if (cell < 0) return false
  const trail = frame.trail[seat]!
  trail.fill(0)
  frame.dist[seat] = depthOf[cell]!
  while (cameBy[cell] !== 4) { const dir = cameBy[cell]!; cell -= STEP[dir]!; trail[cell] = dir + 1 }
  return true
}

/** Does a wall at this place cut the recorded route? */
function cuts(trail: Uint8Array, slot: number, along: boolean): boolean {
  const cell = ((slot / SLOTS) | 0) * SIZE + (slot % SLOTS)
  return along
    ? trail[cell] === 2 || trail[cell + SIZE] === 2 || trail[cell + 1] === 4 || trail[cell + SIZE + 1] === 4
    : trail[cell] === 1 || trail[cell + 1] === 1 || trail[cell + SIZE] === 3 || trail[cell + SIZE + 1] === 3
}

/**
 * With the wall already on the grid, fill `next` from `frame`: routes that the wall does not cut
 * stay as they are (a wall only removes ways, so a shortest route that survives is still shortest).
 * False when the wall leaves a pawn with no way through.
 */
function afterWall(grid: Grid, frame: Frame, next: Frame, slot: number, along: boolean): boolean {
  for (let who = 0; who < 2; who++) {
    if (cuts(frame.trail[who]!, slot, along)) { if (!trace(grid, who, next)) return false } else { next.trail[who]!.set(frame.trail[who]!); next.dist[who] = frame.dist[who]! }
  }
  return true
}

/** A position's worth to `seat`, who is about to move, in tenths of a step. */
function worth(search: Search, frame: Frame, seat: number): number {
  const other = 1 - seat
  const mine = frame.dist[seat]!, theirs = frame.dist[other]!
  const left = search.grid.left
  let score = 10 * (theirs - mine) + 4 + search.wallWorth * (left[seat]! - left[other]!)
  if (search.raceSense) {
    // With no walls against you the race is settled by counting: the side to move needs `mine`
    // turns and gets them first when mine <= theirs.
    if (left[other] === 0 && mine <= theirs) score += 400 - 4 * mine
    else if (left[seat] === 0 && theirs < mine) score -= 400 - 4 * theirs
  }
  return score
}

/** Walls that cut the other side's route, with how many steps each gains, best first. Returns the count. */
function candidates(search: Search, frame: Frame, scratch: Frame, seat: number): number {
  const grid = search.grid, other = 1 - seat
  const trail = frame.trail[other]!
  let count = 0
  let cell = grid.pawn[other]!
  // Walk the other side's route; each step crosses one edge, which two wall places can close.
  while (trail[cell]) {
    const dir = trail[cell]! - 1
    const col = cell % SIZE, row = (cell / SIZE) | 0
    const along = dir === 1 || dir === 3
    // The corner the edge touches, then its neighbour along the wall's own line.
    const baseCol = dir === 3 ? col - 1 : col, baseRow = dir === 2 ? row - 1 : row
    for (let shift = 0; shift < 2; shift++) {
      const slotCol = along ? baseCol : baseCol - shift, slotRow = along ? baseRow - shift : baseRow
      if (slotCol < 0 || slotCol >= SLOTS || slotRow < 0 || slotRow >= SLOTS) continue
      const slot = slotRow * SLOTS + slotCol
      if (!grid.free(slot, along)) continue
      const code = slot * 2 + (along ? 1 : 0)
      let seen = false
      for (let i = 0; i < count; i++) if (frame.wallSlot[i] === code) { seen = true; break }
      if (seen) continue
      grid.toggle(slot, along)
      const fine = afterWall(grid, frame, scratch, slot, along)
      grid.toggle(slot, along)
      if (!fine) continue
      const gain = (scratch.dist[other]! - frame.dist[other]!) - (scratch.dist[seat]! - frame.dist[seat]!)
      // Insert in order of gain, best first.
      let at = count++
      while (at > 0 && frame.wallGain[at - 1]! < gain) { frame.wallSlot[at] = frame.wallSlot[at - 1]!; frame.wallGain[at] = frame.wallGain[at - 1]!; at-- }
      frame.wallSlot[at] = code; frame.wallGain[at] = gain
    }
    cell += STEP[dir]!
  }
  return count
}

function negamax(search: Search, seat: number, depth: number, alpha: number, beta: number, ply: number): number {
  const grid = search.grid, other = 1 - seat
  const frame = search.frames[ply]!
  if (((grid.pawn[other]! / SIZE) | 0) === goalRow(other)) return -(WIN - ply)
  if (depth <= 0) return worth(search, frame, seat)
  if (searches >= search.budget) { search.cut = true; return worth(search, frame, seat) }
  const next = search.frames[ply + 1]!
  let best = -Infinity

  // Pawn moves, the one along the shortest route first.
  const from = grid.pawn[seat]!
  const count = stepsInto(grid, seat, frame.steps)
  const lead = frame.trail[seat]![from] ? from + STEP[frame.trail[seat]![from]! - 1]! : -1
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      const to = frame.steps[i]!
      if ((to === lead) !== (pass === 0)) continue
      grid.pawn[seat] = to
      next.trail[other]!.set(frame.trail[other]!); next.dist[other] = frame.dist[other]!
      if (to === lead) { next.trail[seat]!.set(frame.trail[seat]!); next.dist[seat] = frame.dist[seat]! - 1 } else trace(grid, seat, next)
      const score = -negamax(search, other, depth - 1, -beta, -alpha, ply + 1)
      grid.pawn[seat] = from
      if (score > best) best = score
      if (best > alpha) alpha = best
      if (alpha >= beta || search.cut) return best
    }
  }

  if (grid.left[seat]! > 0) {
    const found = candidates(search, frame, next, seat)
    const limit = Math.min(found, search.keep)
    for (let i = 0; i < limit; i++) {
      const code = frame.wallSlot[i]!, slot = code >> 1, along = (code & 1) === 1
      grid.toggle(slot, along); grid.left[seat]!--
      afterWall(grid, frame, next, slot, along)
      const score = -negamax(search, other, depth - 1, -beta, -alpha, ply + 1)
      grid.toggle(slot, along); grid.left[seat]!++
      if (score > best) best = score
      if (best > alpha) alpha = best
      if (alpha >= beta || search.cut) return best
    }
  }
  return best
}

interface RootMove { move: WallsMove; score: number; gain: number }

/**
 * Every useful pawn move plus the walls that cut the other side's route, in a sensible first order.
 * A step that only lengthens the mover's own route is left out, and with no walls in hand only the
 * steps that shorten it are kept: a look-ahead that fears a wall it cannot stop would otherwise
 * shuffle on the spot to keep the bad news past its horizon, and a pawn that waits never arrives.
 */
function rootMoves(search: Search, seat: number): RootMove[] {
  const grid = search.grid, frame = search.frames[0]!, scratch = search.frames[1]!
  const from = grid.pawn[seat]!
  const count = stepsInto(grid, seat, frame.steps)
  const before = frame.dist[seat]!
  const steps: RootMove[] = []
  for (let i = 0; i < count; i++) {
    const to = frame.steps[i]!
    grid.pawn[seat] = to
    const goal = route(grid.open, to, seat)
    // gain: steps saved, so a jump (2) sorts before a plain step forward (1) and a sidestep (0).
    steps.push({ move: { kind: 'step', col: to % SIZE, row: (to / SIZE) | 0 }, score: 0, gain: before - depthOf[goal]! })
  }
  grid.pawn[seat] = from
  const forward = steps.filter(entry => entry.gain > 0)
  const level = steps.filter(entry => entry.gain >= 0)
  const walls: RootMove[] = []
  if (grid.left[seat]! > 0) {
    const found = candidates(search, frame, scratch, seat)
    for (let i = 0; i < found; i++) {
      const code = frame.wallSlot[i]!, slot = code >> 1
      walls.push({ move: { kind: 'wall', col: slot % SLOTS, row: (slot / SLOTS) | 0, dir: code & 1 ? 'along' : 'across' }, score: 0, gain: frame.wallGain[i]! })
    }
  }
  const kept = grid.left[seat] === 0 && forward.length ? forward : level.length ? level : steps
  // Forward steps first, then walls by what they gain, then sidesteps.
  return [...kept.filter(entry => entry.gain > 0), ...walls, ...kept.filter(entry => entry.gain <= 0)]
}

/** Search one root move to `depth` and return its score for `seat`. */
function scoreRoot(search: Search, seat: number, entry: RootMove, depth: number, alpha: number): number {
  const grid = search.grid, other = 1 - seat
  const frame = search.frames[0]!, next = search.frames[1]!
  const move = entry.move
  if (move.kind === 'step') {
    const from = grid.pawn[seat]!
    grid.pawn[seat] = move.row * SIZE + move.col
    next.trail[other]!.set(frame.trail[other]!); next.dist[other] = frame.dist[other]!
    trace(grid, seat, next)
    const score = -negamax(search, other, depth - 1, -Infinity, -alpha, 1)
    grid.pawn[seat] = from
    return score
  }
  const slot = move.row * SLOTS + move.col, along = move.dir === 'along'
  grid.toggle(slot, along); grid.left[seat]!--
  afterWall(grid, frame, next, slot, along)
  const score = -negamax(search, other, depth - 1, -Infinity, -alpha, 1)
  grid.toggle(slot, along); grid.left[seat]!++
  return score
}

export interface BotOptions {
  /** Deepest look-ahead, in moves. */
  depth: number
  /** Route searches allowed before the search stops going deeper. */
  budget: number
  /** Walls kept per position below the first move. */
  keep: number
  /** Worth of a wall in hand, in tenths of a step. */
  wallWorth: number
  /** Root moves this close to the best (tenths of a step) may be picked instead of it. */
  slack: number
  raceSense: boolean
}
export const BOT_LEVELS: Record<2 | 3, BotOptions> = {
  2: { depth: 2, budget: 4000, keep: 6, wallWorth: 6, slack: 4, raceSense: false },
  3: { depth: 8, budget: 30000, keep: 4, wallWorth: 12, slack: 0, raceSense: true },
}

/** What the last computer move cost: route searches run and how deep it finished. For the probe and the notes. */
export const botStats: { searches: number; depth: number; scores: { move: WallsMove; score: number }[] } = { searches: 0, depth: 0, scores: [] }

/** The searching computer player (levels 2 and 3). Exported so the probe can try other settings. */
export function searchMove(state: WallsState, seat: number, options: BotOptions, random: () => number): WallsMove {
  const grid = gridOf(state)
  const search: Search = {
    grid, frames: Array.from({ length: MAX_DEPTH + 2 }, newFrame), budget: 0, cut: false,
    keep: options.keep, wallWorth: options.wallWorth, raceSense: options.raceSense,
  }
  const started = searches
  search.budget = started + options.budget
  trace(grid, 0, search.frames[0]!); trace(grid, 1, search.frames[0]!)
  let moves = rootMoves(search, seat)
  let chosen = moves[0]!
  let reached = 0
  for (let depth = 1; depth <= Math.min(options.depth, MAX_DEPTH); depth++) {
    search.cut = false
    let best = -Infinity
    const scored: RootMove[] = []
    for (const entry of moves) {
      // A little room under the best so near-equal moves get true scores, which the slack choice needs.
      const score = scoreRoot(search, seat, entry, depth, best - options.slack - 1)
      if (search.cut) break
      scored.push({ ...entry, score })
      if (score > best) best = score
    }
    // A depth that was cut short still counts when its first move (the best so far) was searched.
    if (!scored.length) break
    const top = scored.filter(entry => entry.score >= best - options.slack)
    // When every line loses, keep running: a step forward asks the other side to find the win.
    const running = best < -300 ? top.find(entry => entry.move.kind === 'step' && entry.gain > 0) : undefined
    chosen = running ?? top[Math.min(top.length - 1, Math.floor(random() * top.length))]!
    if (search.cut) break
    reached = depth
    botStats.scores = scored.map(entry => ({ move: entry.move, score: entry.score }))
    if (best >= WIN - MAX_DEPTH - 2) break
    moves = scored.sort((a, b) => b.score - a.score)
  }
  botStats.searches = searches - started
  botStats.depth = reached
  return chosen.move
}

/** Level 1: plausible, loose. */
function looseMove(state: WallsState, seat: number, random: () => number): WallsMove {
  const grid = gridOf(state)
  const frame = newFrame(), scratch = newFrame()
  trace(grid, 0, frame); trace(grid, 1, frame)
  const search: Search = { grid, frames: [frame, scratch], budget: Infinity, cut: false, keep: 0, wallWorth: 0, raceSense: false }
  const from = grid.pawn[seat]!
  const count = stepsInto(grid, seat, frame.steps)
  const step = (to: number): WallsMove => ({ kind: 'step', col: to % SIZE, row: (to / SIZE) | 0 })
  for (let i = 0; i < count; i++) if (((frame.steps[i]! / SIZE) | 0) === goalRow(seat)) return step(frame.steps[i]!)
  const roll = random()
  if (roll < 0.22 && grid.left[seat]! > 0) {
    const found = candidates(search, frame, scratch, seat)
    if (found > 0) {
      const code = frame.wallSlot[Math.floor(random() * found)]!, slot = code >> 1
      return { kind: 'wall', col: slot % SLOTS, row: (slot / SLOTS) | 0, dir: code & 1 ? 'along' : 'across' }
    }
  }
  if (roll > 0.86) return step(frame.steps[Math.floor(random() * count)]!)
  // The step that leaves the shortest way to go; a jump can beat the plain next square.
  let best = frame.steps[0]!, bestDist = Infinity
  for (let i = 0; i < count; i++) {
    grid.pawn[seat] = frame.steps[i]!
    const goal = route(grid.open, grid.pawn[seat]!, seat)
    if (goal >= 0 && depthOf[goal]! < bestDist) { bestDist = depthOf[goal]!; best = frame.steps[i]! }
  }
  grid.pawn[seat] = from
  return step(best)
}

// ── The rules ──────────────────────────────────────────────────────────────────────────────────

function parseMove(input: unknown): WallsMove {
  if (typeof input !== 'object' || input === null) throw new RulesError('That is not a move.')
  const { kind, col, row, dir } = input as Record<string, unknown>
  if (typeof col !== 'number' || typeof row !== 'number' || !Number.isInteger(col) || !Number.isInteger(row)) throw new RulesError('That is not a move.')
  if (kind === 'step') {
    if (!onBoard({ col, row })) throw new RulesError('That is off the board.')
    return { kind, col, row }
  }
  if (kind === 'wall') {
    if (dir !== 'across' && dir !== 'along') throw new RulesError('A wall lies across or along.')
    if (!onSlots({ col, row, dir })) throw new RulesError('A wall must lie fully on the board.')
    return { kind, col, row, dir }
  }
  throw new RulesError('That is not a move.')
}

function apply(state: WallsState, seat: number, move: WallsMove): WallsState {
  if (state.result) throw new RulesError('The game is over.')
  if (seat !== state.turn) throw new RulesError('It is not your turn.')
  const other = 1 - seat
  if (move.kind === 'step') {
    const problem = stepProblem(state, seat, move)
    if (problem) throw new RulesError(problem)
    const pawns = state.pawns.map((pawn, index) => (index === seat ? { col: move.col, row: move.row } : { ...pawn }))
    const won = move.row === goalRow(seat)
    return { ...state, pawns, turn: other, ply: state.ply + 1, result: won ? { winner: seat, reason: 'reached-goal' } : null }
  }
  const problem = wallProblem(state, seat, move)
  if (problem) throw new RulesError(problem)
  const wallsLeft = state.wallsLeft.map((left, index) => (index === seat ? left - 1 : left))
  return { ...state, wallsLeft, walls: [...state.walls, { col: move.col, row: move.row, dir: move.dir, seat }], turn: other, ply: state.ply + 1 }
}

function outcome(state: WallsState): Outcome | null {
  if (!state.result) return null
  const { winner, reason } = state.result
  const loser = 1 - winner
  const text = reason === 'reached-goal' ? `{${winner}} reached the far side.`
    : reason === 'resigned' ? `{${loser}} resigned. {${winner}} wins.`
      : reason === 'time' ? `{${loser}} ran out of time. {${winner}} wins.`
        : `{${loser}} left the game. {${winner}} wins.`
  return { winners: [winner], draw: false, reason, text, scores: winner === 0 ? [1, 0] : [0, 1] }
}

function describe(state: WallsState, seat: number, move: WallsMove): string {
  if (move.kind === 'wall') return `Wall ${wallName(move)}`
  const me = state.pawns[seat]
  if (!me) return cellName(move)
  const dc = Math.abs(move.col - me.col), dr = Math.abs(move.row - me.row)
  if (dc + dr === 2) return dc === 1 ? `${cellName(move)}, around the other pawn` : `${cellName(move)}, jumping over`
  return cellName(move)
}

export const createRules: CreateRules<WallsState, WallsMove, WallsView> = (): Rules<WallsState, WallsMove, WallsView> => ({
  game: 'walls',
  seats: { min: 2, max: 2 },
  start(seats) {
    if (seats !== 2) throw new RulesError('Ten Walls is for two players.')
    const middle = (SIZE - 1) / 2
    return { pawns: [{ col: middle, row: 0 }, { col: middle, row: SIZE - 1 }], wallsLeft: [WALLS_EACH, WALLS_EACH], walls: [], turn: 0, ply: 0, result: null }
  },
  turn: state => (state.result ? null : state.turn),
  parseMove,
  apply,
  outcome,
  view: state => state,
  bot(state, seat, level, random) {
    if (state.result) throw new RulesError('The game is over.')
    let move = level === 1 ? looseMove(state, seat, random) : searchMove(state, seat, BOT_LEVELS[level], random)
    // Belt and braces: whatever the search says, only a move the rules accept leaves this function.
    const refused = move.kind === 'step' ? stepProblem(state, seat, move) : wallProblem(state, seat, move)
    if (refused) { const fallback = legalSteps(state, seat)[0]!; move = { kind: 'step', col: fallback.col, row: fallback.row } }
    return move
  },
  describe,
  forfeit(state, seat, reason) {
    if (state.result) return state
    return { ...state, result: { winner: 1 - seat, reason } }
  },
})
