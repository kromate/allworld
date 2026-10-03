// Evidence probe for Ten Walls (the hall's 'walls' game): every rule edge, the helpers the board
// uses, and the computer player. Plain asserts, one PASS line per check, non-zero exit on the
// first failure. Run: node scripts/verify-game-walls.ts   (WALLS_GAMES=0.25 for a quick pass)
//
// The rules module is checked against a second, deliberately plain implementation written here
// (lists of walls and a flood fill) so a mistake in the module's bit tricks cannot hide itself.
import assert from 'node:assert/strict'
import { RulesError } from '../src/shared/arena.ts'
import {
  BOT_LEVELS, SIZE, SLOTS, WALLS_EACH, botStats, cellName, createRules, goalRow, legalSteps, legalWalls, moveCode, shortestPath, stepProblem,
  stepsToGoal, wallProblem, withWall,
} from '../src/shared/games/walls.ts'
import type { Cell, Wall, WallDir, WallsMove, WallsState } from '../src/shared/games/walls.ts'

const rules = createRules({})
const scale = Number(process.env.WALLS_GAMES ?? '1')
const games = (count: number): number => Math.max(4, Math.round(count * scale))

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
function refused(pattern: RegExp, run: () => unknown): void {
  try { run() } catch (error) {
    assert.ok(error instanceof RulesError, `expected a RulesError, got ${String(error)}`)
    assert.match(error.message, pattern)
    return
  }
  assert.fail(`expected a refusal matching ${pattern}, but the move was accepted`)
}

// ── Writing positions and moves in the game's own notation ──

const at = (name: string): Cell => ({ col: name.charCodeAt(0) - 97, row: Number(name.slice(1)) - 1 })
/** "e2" is a step; "e3h" a wall across at e3; "e3v" a wall along at e3. */
function move(code: string): WallsMove {
  const cell = at(code.slice(0, 2))
  if (code.length === 2) return { kind: 'step', ...cell }
  return { kind: 'wall', ...cell, dir: code[2] === 'h' ? 'across' : 'along' }
}
const wall = (code: string): Wall => { const parsed = move(code); assert.equal(parsed.kind, 'wall'); return parsed as Wall }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const inner of Object.values(value)) freeze(inner) }
  return value
}
/** A position set up by hand. Walls are given as "e3h/0" (placed by seat 0). */
function position(a: string, b: string, walls: string[] = [], turn = 0, left: [number, number] = [WALLS_EACH, WALLS_EACH]): WallsState {
  return freeze({
    pawns: [at(a), at(b)], wallsLeft: [...left], turn, ply: 0, result: null,
    walls: walls.map(code => ({ ...wall(code.split('/')[0]!), seat: Number(code.split('/')[1] ?? 0) })),
  })
}
const play = (state: WallsState, ...codes: string[]): WallsState => codes.reduce((now, code) => rules.apply(freeze(now), now.turn, rules.parseMove(move(code))), state)
const names = (cells: Cell[]): string[] => cells.map(cellName).sort()

// ── The plain second implementation ──

function barred(walls: Wall[], from: Cell, to: Cell): boolean {
  if (to.col < 0 || to.col >= SIZE || to.row < 0 || to.row >= SIZE) return true
  if (from.col === to.col) {
    const low = Math.min(from.row, to.row)
    return walls.some(w => w.dir === 'across' && w.row === low && (w.col === from.col || w.col === from.col - 1))
  }
  const low = Math.min(from.col, to.col)
  return walls.some(w => w.dir === 'along' && w.col === low && (w.row === from.row || w.row === from.row - 1))
}
const AROUND = [[0, 1], [1, 0], [0, -1], [-1, 0]] as const
function plainDistance(walls: Wall[], from: Cell, seat: number): number {
  const seen = new Set<string>([`${from.col},${from.row}`])
  let frontier = [from], distance = 0
  while (frontier.length) {
    if (frontier.some(cell => cell.row === goalRow(seat))) return distance
    const next: Cell[] = []
    for (const cell of frontier) for (const [dc, dr] of AROUND) {
      const to = { col: cell.col + dc, row: cell.row + dr }
      if (barred(walls, cell, to) || seen.has(`${to.col},${to.row}`)) continue
      seen.add(`${to.col},${to.row}`); next.push(to)
    }
    frontier = next; distance++
  }
  return -1
}
function plainSteps(state: WallsState, seat: number): Cell[] {
  const me = state.pawns[seat]!, other = state.pawns[1 - seat]!
  const out: Cell[] = []
  for (const [dc, dr] of AROUND) {
    const next = { col: me.col + dc, row: me.row + dr }
    if (barred(state.walls, me, next)) continue
    if (next.col !== other.col || next.row !== other.row) { out.push(next); continue }
    const over = { col: next.col + dc, row: next.row + dr }
    if (!barred(state.walls, next, over)) { out.push(over); continue }
    for (const [sc, sr] of dc === 0 ? [[1, 0], [-1, 0]] as const : [[0, 1], [0, -1]] as const) {
      const side = { col: next.col + sc, row: next.row + sr }
      if (!barred(state.walls, next, side)) out.push(side)
    }
  }
  return out
}
function plainWallFine(state: WallsState, seat: number, candidate: Wall): boolean {
  if (state.wallsLeft[seat]! <= 0) return false
  if (candidate.col < 0 || candidate.col >= SLOTS || candidate.row < 0 || candidate.row >= SLOTS) return false
  for (const w of state.walls) {
    if (w.col === candidate.col && w.row === candidate.row) return false
    if (w.dir === candidate.dir && w.dir === 'across' && w.row === candidate.row && Math.abs(w.col - candidate.col) === 1) return false
    if (w.dir === candidate.dir && w.dir === 'along' && w.col === candidate.col && Math.abs(w.row - candidate.row) === 1) return false
  }
  const walls = [...state.walls, candidate]
  return plainDistance(walls, state.pawns[0]!, 0) >= 0 && plainDistance(walls, state.pawns[1]!, 1) >= 0
}
const ALL_WALLS: Wall[] = []
for (let row = 0; row < SLOTS; row++) for (let col = 0; col < SLOTS; col++) for (const dir of ['across', 'along'] as WallDir[]) ALL_WALLS.push({ col, row, dir })

function makeRandom(seed: number): () => number {
  let value = seed % 2_147_483_647 || 1
  return () => { value = (value * 48271) % 2_147_483_647; return value / 2_147_483_647 }
}

// ── Start, steps, turns ──

check('a new game: pawns on e1 and e9, ten walls each, the first seat to move, three squares to choose from', () => {
  const state = rules.start(2, 1)
  assert.deepEqual(state.pawns.map(cellName), ['e1', 'e9'])
  assert.deepEqual(state.wallsLeft, [10, 10])
  assert.equal(rules.turn(state), 0)
  assert.equal(rules.outcome(state), null)
  assert.deepEqual(names(legalSteps(state, 0)), ['d1', 'e2', 'f1'])
  assert.deepEqual(names(legalSteps(state, 1)), ['d9', 'e8', 'f9'])
  assert.equal(stepsToGoal(state, 0), 8); assert.equal(stepsToGoal(state, 1), 8)
  assert.equal(legalWalls(state, 0).length, 128, 'every one of the 8 × 8 × 2 wall places is open on an empty board')
  assert.deepEqual(rules.seats, { min: 2, max: 2 })
  refused(/two players/, () => rules.start(3, 1))
  assert.deepEqual(rules.view(state, 0), state); assert.deepEqual(rules.view(state, null), state)
})

check('a pawn moves one square up, down, left or right, and turns alternate', () => {
  let state = play(rules.start(2, 1), 'e2', 'e8', 'd2', 'f8', 'd1')
  assert.deepEqual(state.pawns.map(cellName), ['d1', 'f8'])
  assert.equal(state.turn, 1); assert.equal(state.ply, 5)
  state = play(state, 'f9')
  assert.equal(cellName(state.pawns[1]!), 'f9', 'a pawn may step back')
})

check('refused: moving out of turn, two squares, diagonally, onto the other pawn, off the board, or after the game', () => {
  const state = rules.start(2, 1)
  refused(/not your turn/, () => rules.apply(state, 1, move('e8')))
  refused(/one square at a time/, () => rules.apply(state, 0, move('e3')))
  refused(/not diagonally/, () => rules.apply(state, 0, move('d2')))
  refused(/already there/, () => rules.apply(state, 0, move('e1')))
  refused(/off the board/, () => rules.parseMove({ kind: 'step', col: 4, row: -1 }))
  refused(/off the board/, () => rules.parseMove({ kind: 'step', col: 9, row: 0 }))
  const close = position('e4', 'e5')
  refused(/taken/, () => rules.apply(close, 0, move('e5')))
})

check('an untrusted value is only accepted when it has the shape of a move', () => {
  for (const junk of [null, 7, 'e2', {}, { kind: 'step' }, { kind: 'step', col: 1.5, row: 2 }, { kind: 'step', col: '1', row: 2 }, { kind: 'hop', col: 1, row: 1 },
    { kind: 'wall', col: 1, row: 1 }, { kind: 'wall', col: 1, row: 1, dir: 'sideways' }, { kind: 'wall', col: 8, row: 0, dir: 'across' }, { kind: 'wall', col: 0, row: 8, dir: 'along' }, { kind: 'wall', col: -1, row: 0, dir: 'along' }]) {
    assert.throws(() => rules.parseMove(junk), RulesError, `accepted ${JSON.stringify(junk)}`)
  }
  assert.deepEqual(rules.parseMove({ kind: 'wall', col: 7, row: 7, dir: 'along', extra: 'ignored' }), { kind: 'wall', col: 7, row: 7, dir: 'along' })
  assert.deepEqual(rules.parseMove({ kind: 'step', col: 0, row: 8 }), { kind: 'step', col: 0, row: 8 })
})

// ── Walls ──

check('a wall across stops both pawns crossing it in both directions, over exactly two squares', () => {
  const state = position('e4', 'f5', ['e4h/1'])
  assert.deepEqual(names(legalSteps(state, 0)), ['d4', 'e3', 'f4'], 'e4 cannot go up through the wall')
  assert.deepEqual(names(legalSteps(state, 1)), ['f6', 'e5', 'g5'].sort(), 'f5 cannot go down through the same wall')
  refused(/wall is in the way/, () => rules.apply(state, 0, move('e5')))
  const beside = position('d4', 'g5', ['e4h/1'])
  assert.ok(names(legalSteps(beside, 0)).includes('d5'), 'd4 is left of the wall and may go up')
  assert.ok(names(legalSteps(beside, 1)).includes('g4'), 'g5 is right of the wall and may go down')
})

check('a wall along stops movement between its two columns, over exactly two rows', () => {
  const state = position('e4', 'f5', ['e4v/0'])
  assert.deepEqual(names(legalSteps(state, 0)), ['d4', 'e3', 'e5'])
  assert.deepEqual(names(legalSteps(state, 1)), ['f4', 'f6', 'g5'])
  const outside = position('e3', 'f6', ['e4v/0'])
  assert.ok(names(legalSteps(outside, 0)).includes('f3')); assert.ok(names(legalSteps(outside, 1)).includes('e6'))
})

check('placing a wall takes one from the stock, keeps the pawn where it is and passes the turn', () => {
  const state = play(rules.start(2, 1), 'e8h')
  assert.deepEqual(state.wallsLeft, [9, 10]); assert.equal(state.turn, 1)
  assert.deepEqual(state.walls, [{ col: 4, row: 7, dir: 'across', seat: 0 }])
  assert.deepEqual(names(legalSteps(state, 1)), ['d9', 'f9'], 'the wall is right in front of e9')
})

check('refused: a wall on top of another, or overlapping half of one', () => {
  const state = position('e1', 'e9', ['c3h/0', 'f6v/1'])
  refused(/overlaps/, () => rules.apply(state, 0, move('c3h')))
  refused(/overlaps/, () => rules.apply(state, 0, move('b3h')))
  refused(/overlaps/, () => rules.apply(state, 0, move('d3h')))
  refused(/overlaps/, () => rules.apply(state, 0, move('f6v')))
  refused(/overlaps/, () => rules.apply(state, 0, move('f5v')))
  refused(/overlaps/, () => rules.apply(state, 0, move('f7v')))
})

check('refused: a wall crossing another through its middle', () => {
  const state = position('e1', 'e9', ['c3h/0', 'f6v/1'])
  refused(/cross/, () => rules.apply(state, 0, move('c3v')))
  refused(/cross/, () => rules.apply(state, 0, move('f6h')))
})

check('allowed: walls end to end in a line, and walls meeting in a T or a corner', () => {
  let state = position('e1', 'e9', ['c3h/0'])
  state = play(state, 'e3h')            // end to end with c3h (c–d, then e–f)
  state = play(state, 'a3h')            // and on the other side (a–b)
  state = play(state, 'b3v')            // an upright passing through the gap where a3h ends and c3h begins
  state = play(state, 'd2v')            // an upright whose middle is one row below the line: its top meets it in a T
  assert.equal(state.walls.length, 5)
  assert.deepEqual(state.wallsLeft, [8, 8])
})

check('refused: a wall that leaves the other pawn no way through (the board is cut in two)', () => {
  // Across walls close columns b–i between rows 4 and 5. Column a is the only way; an upright
  // makes it a two-square pocket and a last across wall would put the lid on.
  const state = position('e1', 'e9', ['b4h/0', 'd4h/0', 'f4h/0', 'h4h/0', 'a5v/1'])
  assert.equal(stepsToGoal(state, 0), 4 + 3 + 5 + 0, 'the detour is long (a1…a7 and across) but it exists')
  refused(/no way through/, () => rules.apply(state, 0, move('a6h')))
  refused(/no way through/, () => rules.apply({ ...state, turn: 1 }, 1, move('a6h')))
  assert.equal(wallProblem(state, 0, wall('a7h')), null, 'one row higher leaves the way open')
})

check('refused: a wall that boxes in only one pawn — whichever pawn it is, and whoever places it', () => {
  const boxSecond = position('a1', 'e9', ['d8v/0', 'e8v/0'])
  assert.match(wallProblem(boxSecond, 0, wall('e7h'))!, /no way through/)
  assert.match(wallProblem(boxSecond, 0, wall('d7h'))!, /no way through/)
  assert.match(wallProblem(boxSecond, 1, wall('e7h'))!, /no way through/, 'a player may not shut their own pawn in either')
  refused(/no way through/, () => rules.apply(boxSecond, 0, move('e7h')))
  const boxFirst = position('e1', 'a9', ['d1v/1', 'e1v/1'])
  assert.match(wallProblem(boxFirst, 1, wall('e2h'))!, /no way through/)
  assert.match(wallProblem(boxFirst, 0, wall('d2h'))!, /no way through/)
  refused(/no way through/, () => rules.apply({ ...boxFirst, turn: 1 }, 1, move('e2h')))
  assert.equal(wallProblem(boxFirst, 1, wall('e3h')), null, 'a box with the lid one row higher still has a gap beside it')
})

check('the way-through check ignores pawns: a route through the square the other pawn stands on counts', () => {
  // The first pawn's only way out of its corridor is the square the second pawn is standing on.
  const state = position('e1', 'e2', ['d1v/1', 'e1v/1'])
  assert.equal(stepsToGoal(state, 0), 8)
  assert.equal(wallProblem(state, 1, wall('a5h')), null)
})

check('wall stock: ten each, the eleventh is refused, and the other side still has theirs', () => {
  let state = rules.start(2, 1)
  const ten = ['a1h', 'c1h', 'e1v', 'g1h', 'a3h', 'c3h', 'e3h', 'g3h', 'a5h', 'c5h']
  for (const code of ten) { state = play(state, code); state = play(state, state.pawns[1]!.col === 4 ? 'd9' : 'e9') }
  assert.deepEqual(state.wallsLeft, [0, 10]); assert.equal(state.walls.length, 10)
  refused(/no walls left/, () => rules.apply(state, 0, move('e5h')))
  assert.equal(legalWalls(state, 0).length, 0)
  assert.ok(legalWalls(state, 1).length > 0)
})

// ── Meeting the other pawn ──

check('straight jump: a pawn next to the other pawn may jump to the square behind it', () => {
  const state = position('e4', 'e5')
  assert.deepEqual(names(legalSteps(state, 0)), ['d4', 'e3', 'e6', 'f4'])
  assert.deepEqual(names(legalSteps(state, 1)), ['d5', 'e3', 'e6', 'f5'])
  const after = play(state, 'e6')
  assert.equal(cellName(after.pawns[0]!), 'e6')
  assert.equal(rules.describe(state, 0, move('e6')), 'e6, jumping over')
  const sideways = position('d5', 'e5')
  assert.ok(names(legalSteps(sideways, 0)).includes('f5'), 'a jump works sideways too')
})

check('with a clear jump, stepping to the side of the other pawn is refused', () => {
  const state = position('e4', 'e5')
  refused(/only step to the side/, () => rules.apply(state, 0, move('d5')))
  refused(/only step to the side/, () => rules.apply(state, 0, move('f5')))
})

check('a wall behind the other pawn blocks the jump; the pawn may step to either side of it instead', () => {
  const state = position('e4', 'e5', ['e5h/1'])
  assert.deepEqual(names(legalSteps(state, 0)), ['d4', 'd5', 'e3', 'f4', 'f5'])
  refused(/wall is in the way of that jump/, () => rules.apply(state, 0, move('e6')))
  assert.equal(cellName(play(state, 'd5').pawns[0]!), 'd5')
  assert.equal(rules.describe(state, 0, move('f5')), 'f5, around the other pawn')
})

check('the board edge behind the other pawn works like a wall: step to either side', () => {
  const state = position('e8', 'e9')
  assert.deepEqual(names(legalSteps(state, 0)), ['d8', 'd9', 'e7', 'f8', 'f9'])
  const won = play(state, 'd9')
  assert.equal(rules.outcome(won)?.reason, 'reached-goal', 'and a side step onto the far row wins')
  const edge = position('a5', 'b5', [], 1)
  assert.deepEqual(names(legalSteps(edge, 1)), ['a4', 'a6', 'b4', 'b6', 'c5'], 'the same at the left edge')
})

check('a side step is itself stopped by a wall beside the other pawn', () => {
  const state = position('e4', 'e5', ['e5h/1', 'd4v/1'])        // wall behind, and an upright between d5 and e5
  assert.deepEqual(names(legalSteps(state, 0)), ['e3', 'f4', 'f5'], 'd5 is walled off (and so is d4)')
  refused(/only step to the side/, () => rules.apply(state, 0, move('d5')))
  const both = position('e4', 'e5', ['d5h/1', 'd4v/1', 'e4v/1'])
  assert.deepEqual(names(legalSteps(both, 0)), ['e3'], 'walls behind and on both sides: no way past, only the step back')
})

check('a wall between the two pawns: no jump and no side step', () => {
  const state = position('e4', 'e5', ['e4h/0'])
  assert.deepEqual(names(legalSteps(state, 0)), ['d4', 'e3', 'f4'])
  refused(/one square at a time|jump/, () => rules.apply(state, 0, move('e6')))
  refused(/not diagonally|side/, () => rules.apply(state, 0, move('d5')))
})

check('no long jumps: a pawn two squares away is not jumped, and a jump covers one pawn and one square only', () => {
  const apart = position('e4', 'e6')
  assert.deepEqual(names(legalSteps(apart, 0)), ['d4', 'e3', 'e5', 'f4'])
  refused(/one square at a time/, () => rules.apply(apart, 0, move('e6')))
  refused(/one square at a time/, () => rules.apply(apart, 0, move('e7')))
  const close = position('e4', 'e5')
  refused(/one square at a time/, () => rules.apply(close, 0, move('e7')))
})

// ── Winning and forfeits ──

check('reaching any square of the far row wins at once; nothing can be played afterwards', () => {
  const state = play(position('b8', 'h3'), 'b9')
  const outcome = rules.outcome(state)!
  assert.deepEqual(outcome.winners, [0]); assert.equal(outcome.draw, false); assert.equal(outcome.reason, 'reached-goal')
  assert.deepEqual(outcome.scores, [1, 0]); assert.equal(outcome.text, '{0} reached the far side.')
  assert.equal(rules.turn(state), null)
  refused(/game is over/, () => rules.apply(state, 1, move('h2')))
  assert.equal(wallProblem(state, 1, wall('a1h')), 'The game is over.')
  assert.deepEqual(legalSteps(state, 1), [])
  const second = play(position('b2', 'h2', [], 1), 'h1')
  assert.deepEqual(rules.outcome(second)?.winners, [1]); assert.deepEqual(rules.outcome(second)?.scores, [0, 1])
})

check('a jump onto the far row wins too', () => {
  const state = play(position('e7', 'e8'), 'e9')
  assert.equal(rules.outcome(state)?.reason, 'reached-goal')
})

check('forfeit: the seat that resigns, runs out of time or leaves loses, with a sentence for each', () => {
  const state = play(rules.start(2, 1), 'e2')
  const resigned = rules.outcome(rules.forfeit(state, 1, 'resigned'))!
  assert.deepEqual(resigned.winners, [0]); assert.equal(resigned.reason, 'resigned'); assert.equal(resigned.text, '{1} resigned. {0} wins.')
  const time = rules.outcome(rules.forfeit(state, 0, 'time'))!
  assert.deepEqual(time.winners, [1]); assert.equal(time.reason, 'time'); assert.equal(time.text, '{0} ran out of time. {1} wins.'); assert.deepEqual(time.scores, [0, 1])
  const left = rules.outcome(rules.forfeit(state, 0, 'left'))!
  assert.equal(left.reason, 'left'); assert.equal(left.text, '{0} left the game. {1} wins.')
  const over = rules.forfeit(state, 1, 'resigned')
  assert.equal(rules.turn(over), null)
  assert.equal(rules.forfeit(over, 0, 'time'), over, 'a finished game is not changed by a later forfeit')
})

// ── Notation and helpers ──

check('move list lines: a square for a step, "Wall e3 across" for a wall; short codes e2 / e3h / e3v', () => {
  const state = rules.start(2, 1)
  assert.equal(rules.describe(state, 0, move('e2')), 'e2')
  assert.equal(rules.describe(state, 0, move('e3h')), 'Wall e3 across')
  assert.equal(rules.describe(state, 0, move('a8v')), 'Wall a8 along')
  assert.deepEqual(['e2', 'e3h', 'h1v'].map(code => moveCode(move(code))), ['e2', 'e3h', 'h1v'])
})

check('apply never changes the state it was given (every position above was frozen), and states are plain JSON', () => {
  const state = play(rules.start(2, 1), 'e2', 'e8h', 'd2', 'c3v')
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  const again = play(JSON.parse(JSON.stringify(state)) as WallsState, 'd3')
  assert.equal(cellName(again.pawns[0]!), 'd3', 'a state that went through JSON plays on')
})

check('shortest route: a real route square by square, its length, and what a wall would do to it', () => {
  const state = position('e1', 'e9', ['d1h/1', 'f1h/1'])      // a wall across over d1–e1 and another over f1–g1
  const path = shortestPath(state, 0)
  assert.equal(path.length - 1, stepsToGoal(state, 0)); assert.equal(stepsToGoal(state, 0), 10, 'two steps sideways to c1, then eight up')
  assert.equal(cellName(path[0]!), 'e1'); assert.equal(path[path.length - 1]!.row, goalRow(0))
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!
    assert.equal(Math.abs(a.col - b.col) + Math.abs(a.row - b.row), 1, 'the route goes square to square')
    assert.equal(barred(state.walls, a, b), false, 'and never through a wall')
  }
  const tried = withWall(state, 1, wall('b1h'))
  assert.equal(stepsToGoal(tried, 0), 11, 'a third wall over b1–c1 sends the pawn the other way, round by h1')
  assert.equal(state.walls.length, 2, 'trying a wall does not change the position')
})

check(`the rules agree with the plain second implementation on ${games(400)} random positions: steps, all 128 wall places, route lengths`, () => {
  const random = makeRandom(20261001)
  let positions = 0, wallsChecked = 0, refusedWalls = 0, sealed = 0
  while (positions < games(400)) {
    let state = rules.start(2, 1)
    const length = 4 + Math.floor(random() * 50)
    for (let ply = 0; ply < length && !state.result; ply++) {
      const seat = state.turn
      const steps = plainSteps(state, seat)
      const walls = ALL_WALLS.filter(candidate => plainWallFine(state, seat, candidate))
      // Mostly walls, so positions get crowded and the awkward cases turn up.
      const pick: WallsMove = walls.length && random() < 0.6 ? { kind: 'wall', ...walls[Math.floor(random() * walls.length)]! } : { kind: 'step', ...steps[Math.floor(random() * steps.length)]! }
      state = rules.apply(freeze(state), seat, rules.parseMove(pick))
    }
    if (state.result) continue
    positions++
    for (const seat of [0, 1]) {
      assert.deepEqual(names(legalSteps(state, seat)), names(plainSteps(state, seat)), `steps differ for seat ${seat} in ${JSON.stringify(state)}`)
      assert.ok(plainSteps(state, seat).length > 0, 'a pawn always has somewhere to go')
      assert.equal(stepsToGoal(state, seat), plainDistance(state.walls, state.pawns[seat]!, seat))
      const mine = new Set(legalWalls(state, seat).map(candidate => `${candidate.col},${candidate.row},${candidate.dir}`))
      for (const candidate of ALL_WALLS) {
        const fine = plainWallFine(state, seat, candidate)
        const problem = wallProblem(state, seat, candidate)
        assert.equal(problem === null, fine, `wall ${JSON.stringify(candidate)} for seat ${seat}: module says ${problem ?? 'fine'}, plain check says ${fine} in ${JSON.stringify(state)}`)
        assert.equal(mine.has(`${candidate.col},${candidate.row},${candidate.dir}`), fine)
        wallsChecked++
        if (!fine) { refusedWalls++; if (problem && /no way through/.test(problem)) sealed++ }
      }
    }
  }
  console.log(`     ${positions} positions, ${wallsChecked} wall places compared, ${refusedWalls} refused of which ${sealed} for leaving no way through`)
})

// ── The computer player ──

interface Tally { wins: [number, number]; plies: number; longest: number; moves: number; walls: number }
const timings: Record<number, number[]> = { 1: [], 2: [], 3: [] }
const work = { most: 0, depth: 0, moves: 0 }

/** One game between two levels. Every computer move is checked by the plain implementation before it is played. */
function game(levels: [1 | 2 | 3, 1 | 2 | 3], seed: number, tally: Tally): string {
  const random = makeRandom(seed)
  let state = rules.start(2, seed)
  const line: string[] = []
  while (rules.turn(state) !== null) {
    assert.ok(state.ply < 400, `a game ran past 400 moves: ${line.join(' ')}`)
    const seat = state.turn, level = levels[seat]!
    const began = performance.now()
    const chosen = rules.bot(freeze(state), seat, level, random)
    timings[level]!.push(performance.now() - began)
    if (level === 3) { work.most = Math.max(work.most, botStats.searches); work.depth += botStats.depth; work.moves++ }
    const parsed = rules.parseMove(chosen)
    const fine = parsed.kind === 'step' ? plainSteps(state, seat).some(cell => cell.col === parsed.col && cell.row === parsed.row) : plainWallFine(state, seat, parsed)
    assert.ok(fine, `level ${level} played ${moveCode(parsed)}, which is not allowed, after ${line.join(' ')}`)
    if (parsed.kind === 'wall') tally.walls++
    state = rules.apply(state, seat, parsed)
    line.push(moveCode(parsed))
  }
  const winner = rules.outcome(state)!.winners[0]!
  assert.ok(winner === 0 || winner === 1, 'a finished wall race has a winner in one of the two seats')
  tally.wins[winner]++; tally.plies += state.ply; tally.moves += state.ply; tally.longest = Math.max(tally.longest, state.ply)
  return line.join(' ')
}
const newTally = (): Tally => ({ wins: [0, 0], plies: 0, longest: 0, moves: 0, walls: 0 })

for (const level of [1, 2, 3] as const) {
  const count = games(level === 3 ? 200 : 300)
  check(`level ${level} against itself, ${count} games: never an illegal move, every game finishes`, () => {
    const tally = newTally()
    for (let index = 0; index < count; index++) game([level, level], 1000 * level + index, tally)
    console.log(`     first seat won ${tally.wins[0]}, second ${tally.wins[1]}; ${(tally.plies / count).toFixed(0)} moves a game on average, longest ${tally.longest}; ${(tally.walls / count).toFixed(1)} walls a game`)
  })
}

/** `strong` against `weak`, seats swapped every game. Returns how many `strong` won. */
function match(strong: 1 | 2 | 3, weak: 1 | 2 | 3, count: number): number {
  let won = 0
  for (let index = 0; index < count; index++) {
    const tally = newTally()
    const strongSeat = index % 2
    game(strongSeat === 0 ? [strong, weak] : [weak, strong], 50_000 + 100 * strong + index, tally)
    if (tally.wins[strongSeat]) won++
  }
  return won
}

check(`level 3 beats level 1 clearly (${games(200)} games, seats swapped each game)`, () => {
  const count = games(200), won = match(3, 1, count)
  console.log(`     level 3 won ${won} of ${count} (${((100 * won) / count).toFixed(0)}%)`)
  assert.ok(won >= count * 0.95, `level 3 won only ${won} of ${count}`)
})
check(`level 3 beats level 2, and level 2 beats level 1 (${games(120)} games each)`, () => {
  const count = games(120), hard = match(3, 2, count), medium = match(2, 1, count)
  console.log(`     level 3 won ${hard} of ${count} against level 2 (${((100 * hard) / count).toFixed(0)}%); level 2 won ${medium} of ${count} against level 1 (${((100 * medium) / count).toFixed(0)}%)`)
  assert.ok(hard >= count * 0.65, `level 3 won only ${hard} of ${count} against level 2`)
  assert.ok(medium >= count * 0.8, `level 2 won only ${medium} of ${count} against level 1`)
})

check('the computer is deterministic: the same seed gives the same game, move for move', () => {
  const first = game([3, 2], 777, newTally()), second = game([3, 2], 777, newTally())
  assert.equal(first, second)
  assert.notEqual(first, game([3, 2], 778, newTally()), 'and another seed gives another game')
})

check('the computer answers from awkward positions: no walls left, pawns face to face, one step from the goal', () => {
  const faceToFace = position('e4', 'e5', ['e5h/1', 'd4h/0'], 0, [0, 0])
  for (const level of [1, 2, 3] as const) {
    const chosen = rules.bot(faceToFace, 0, level, makeRandom(5))
    assert.equal(chosen.kind, 'step'); rules.apply(faceToFace, 0, chosen)
    const winning = position('c8', 'g5')
    const last = rules.bot(winning, 0, level, makeRandom(6))
    assert.deepEqual(last, { kind: 'step', col: 2, row: 8 }, `level ${level} takes the winning step`)
  }
  // The other side is one step from winning and a single wall stops it: levels 2 and 3 find it.
  const mustBlock = position('a3', 'e2', [], 0)
  for (const level of [2, 3] as const) {
    const chosen = rules.bot(mustBlock, 0, level, makeRandom(7))
    assert.equal(chosen.kind, 'wall', `level ${level} blocks instead of walking`)
    assert.ok(stepsToGoal(rules.apply(mustBlock, 0, chosen), 1) > 1)
  }
  refused(/game is over/, () => rules.bot(rules.forfeit(mustBlock, 0, 'resigned'), 1, 2, makeRandom(8)))
})

check('timing: every level answers well inside 400 ms, with room for a machine four times slower', () => {
  for (const level of [1, 2, 3] as const) {
    const sorted = [...timings[level]!].sort((a, b) => a - b)
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!, max = sorted[sorted.length - 1]!
    console.log(`     level ${level}: ${sorted.length} moves, mean ${mean.toFixed(2)} ms, 99th percentile ${p99.toFixed(1)} ms, slowest ${max.toFixed(1)} ms`)
    assert.ok(p99 < 100, `level ${level} 99th percentile ${p99.toFixed(1)} ms`)
    assert.ok(max < 400, `level ${level} slowest move ${max.toFixed(1)} ms`)
  }
  console.log(`     level 3 work: at most ${work.most} route searches a move (budget ${BOT_LEVELS[3].budget}), average depth reached ${(work.depth / work.moves).toFixed(1)} moves ahead`)
  assert.ok(work.most < BOT_LEVELS[3].budget * 1.2, 'the search stops when its budget is spent')
})

console.log(failed ? 'FAILED' : 'All Ten Walls checks passed.')
