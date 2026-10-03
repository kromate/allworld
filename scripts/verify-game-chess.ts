// Evidence probe for chess: the move generator against the standard perft counts, every special
// rule and every way a game ends from a named position, notation round trips, and the computer
// opponent (always legal, always answers, level 3 clearly stronger than level 1, timings).
// Run: node scripts/verify-game-chess.ts            (about a minute)
//      node scripts/verify-game-chess.ts --quick    (skips the matches between levels)
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { RulesError } from '../src/shared/arena.ts'
import type { Outcome } from '../src/shared/arena.ts'
import { START_FEN, canMate, capturedMaterial, createRules, fromFen, inCheck, isPromotion, kingSquare, lastThought, legalMoves, legalMovesFrom, moveFromSan, openingLines, perft, positionAfter, sanOf, squares, toFen } from '../src/shared/games/chess.ts'
import type { ChessMove, ChessState } from '../src/shared/games/chess.ts'

const quick = process.argv.includes('--quick')
const rules = createRules({})
const WHITE = 0, BLACK = 1

let failed = false
function check(name: string, run: () => string | void): void {
  if (failed) return
  try { const note = run(); console.log(`PASS ${name}${note ? ` — ${note}` : ''}`) } catch (error) {
    failed = true
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

function refuses(run: () => unknown, pattern: RegExp): void {
  try { run() } catch (error) {
    assert.ok(error instanceof RulesError, `expected a RulesError, got ${String(error)}`)
    assert.match(error.message, pattern)
    return
  }
  assert.fail('expected the move to be refused, but it was played')
}

const seatOf = (state: ChessState): number => (state.turn === 'w' ? WHITE : BLACK)
/** Play moves written in standard notation, each by the side whose turn it is. */
function playSan(state: ChessState, line: string): ChessState {
  for (const san of line.split(/\s+/).filter(Boolean)) {
    const move = moveFromSan(state, san)
    assert.ok(move, `"${san}" is not a legal move in ${toFen(state)}`)
    state = rules.apply(state, seatOf(state), move)
  }
  return state
}
const sans = (state: ChessState): string[] => legalMoves(state).map(move => sanOf(state, move)).sort()
const can = (state: ChessState, san: string): boolean => moveFromSan(state, san) !== null
const move = (from: string, to: string, promotion?: ChessMove['promotion']): ChessMove => (promotion ? { from, to, promotion } : { from, to })
function randomSource(seed: number): () => number {
  let value = seed % 2_147_483_647 || 1
  return () => { value = (value * 48271) % 2_147_483_647; return value / 2_147_483_647 }
}
const reasonOf = (outcome: Outcome | null): string => outcome?.reason ?? 'still going'

// ── The move generator ───────────────────────────────────────────────────────────────────────

const PERFT: { name: string; fen: string; depth: number; nodes: number }[] = [
  { name: 'the starting position', fen: START_FEN, depth: 4, nodes: 197_281 },
  { name: '"Kiwipete"', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', depth: 3, nodes: 97_862 },
  { name: 'position 3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', depth: 4, nodes: 43_238 },
  { name: 'position 4', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', depth: 3, nodes: 9_467 },
  { name: 'position 5', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', depth: 3, nodes: 62_379 },
  // Deeper runs of the same positions, beyond what was asked, because they exercise rarer cases.
  { name: 'the starting position, one move deeper', fen: START_FEN, depth: 5, nodes: 4_865_609 },
  { name: '"Kiwipete", one move deeper', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', depth: 4, nodes: 4_085_603 },
  { name: 'position 3, one move deeper', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', depth: 5, nodes: 674_624 },
  { name: 'position 4, one move deeper', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', depth: 4, nodes: 422_333 },
  { name: 'position 5, one move deeper', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', depth: 4, nodes: 2_103_487 },
]
for (const { name, fen, depth, nodes } of PERFT) {
  check(`perft: ${name}, depth ${depth}, has ${nodes.toLocaleString('en')} positions`, () => {
    const started = performance.now(), counted = perft(fromFen(fen), depth)
    assert.equal(counted, nodes)
    return `counted ${counted.toLocaleString('en')} in ${Math.round(performance.now() - started)} ms`
  })
}

check('a position written out and read back is the same line', () => {
  for (const { fen } of PERFT) assert.equal(toFen(fromFen(fen)), fen)
  assert.equal(toFen(rules.start(2, 1)), START_FEN)
  assert.equal(squares(rules.start(2, 1)).join('').length, 32)
})

check('positions that cannot be played are refused when set up', () => {
  refuses(() => fromFen('8/8/8/8/8/8/8/8 w - - 0 1'), /exactly one king/)
  refuses(() => fromFen('k7/8/8/8/8/8/8/K6P w - - 0 1'), /pawn cannot stand/)
  refuses(() => fromFen('k7/8/8/8/8/8/8/K7 x - - 0 1'), /side to move/)
  refuses(() => fromFen('k7/8/8/8/8/8/8/KR w - - 0 1'), /eight squares/)
  refuses(() => fromFen('k6R/8/8/8/8/8/8/K7 w - - 0 1'), /left its king in check/)
})

// ── Special moves ────────────────────────────────────────────────────────────────────────────

const CASTLE_BOTH = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'

check('castling: both sides may castle either way when nothing is in the way, and the rook jumps over', () => {
  const start = fromFen(CASTLE_BOTH)
  assert.ok(can(start, 'O-O') && can(start, 'O-O-O'))
  const short = playSan(start, 'O-O')
  assert.equal(short.board, 'r3k2r/8/8/8/8/8/8/R4RK1')
  assert.equal(short.castling, 'kq')
  const long = playSan(short, 'O-O-O')
  assert.equal(long.board, '2kr3r/8/8/8/8/8/8/R4RK1')
  assert.equal(long.castling, '-')
  assert.deepEqual(moveFromSan(start, 'O-O-O'), move('e1', 'c1'))
})

check('castling: not while a piece stands between king and rook', () => {
  const start = fromFen('r3k2r/8/8/8/8/8/8/RN2KB1R w KQkq - 0 1')
  assert.ok(!can(start, 'O-O') && !can(start, 'O-O-O'))
  refuses(() => rules.apply(start, WHITE, move('e1', 'g1')), /piece stands between/)
})

check('castling: not out of check', () => {
  const start = fromFen('r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1')
  assert.ok(inCheck(start))
  assert.ok(!can(start, 'O-O') && !can(start, 'O-O-O'))
  refuses(() => rules.apply(start, WHITE, move('e1', 'g1')), /out of check/)
})

check('castling: not through an attacked square, and not onto one', () => {
  // A black rook on f3 attacks f1 (crossed going short) but not d1 or c1.
  const through = fromFen('4k3/8/8/8/8/5r2/8/R3K2R w KQ - 0 1')
  assert.ok(!can(through, 'O-O') && can(through, 'O-O-O'))
  refuses(() => rules.apply(through, WHITE, move('e1', 'g1')), /through or onto/)
  const onto = fromFen('4k3/8/8/8/8/6r1/8/R3K2R w KQ - 0 1')
  assert.ok(!can(onto, 'O-O') && can(onto, 'O-O-O'))
})

check('castling: allowed when only the rook is attacked or crosses an attacked square', () => {
  // The black rook on b3 attacks b1, which the rook crosses but the king does not.
  const start = fromFen('4k3/8/8/8/8/1r6/8/R3K2R w KQ - 0 1')
  assert.ok(can(start, 'O-O-O'))
  const attacked = fromFen('r3k3/8/8/8/8/8/8/R3K3 w Q - 0 1')
  assert.ok(can(attacked, 'O-O-O'), 'a rook that is attacked may still castle')
})

check('castling: the right is gone for good once the king or that rook has moved, or the rook is taken', () => {
  const kingMoved = playSan(fromFen(CASTLE_BOTH), 'Ke2 Ke7 Ke1 Ke8')
  assert.equal(kingMoved.board, fromFen(CASTLE_BOTH).board)
  assert.equal(kingMoved.castling, '-')
  assert.ok(!can(kingMoved, 'O-O') && !can(kingMoved, 'O-O-O'))
  refuses(() => rules.apply(kingMoved, WHITE, move('e1', 'g1')), /already moved/)
  const rookMoved = playSan(fromFen(CASTLE_BOTH), 'Rh2 Ra7 Rh1 Ra8')
  assert.equal(rookMoved.castling, 'Qk')
  assert.ok(!can(rookMoved, 'O-O') && can(rookMoved, 'O-O-O'))
  const rookTaken = playSan(fromFen(CASTLE_BOTH), 'Rxh8+')
  assert.equal(rookTaken.castling, 'Qq')
})

check('en passant: allowed on the very next move only, and the passed pawn is the one removed', () => {
  const start = playSan(rules.start(2, 1), 'e4 a6 e5 d5')
  assert.equal(start.ep, 'd6')
  assert.ok(can(start, 'exd6'))
  const taken = playSan(start, 'exd6')
  assert.equal(taken.board, 'rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR')
  assert.equal(taken.taken.w, 'p')
  const waited = playSan(start, 'Nf3 Nf6')
  assert.equal(waited.ep, '-')
  assert.ok(!can(waited, 'exd6'))
})

check('en passant: the square is recorded only when an enemy pawn stands beside the pawn that advanced', () => {
  assert.equal(playSan(rules.start(2, 1), 'e4').ep, '-')
  assert.equal(playSan(rules.start(2, 1), 'e4 a6 e5 f5').ep, 'f6')
  assert.equal(fromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1').ep, '-')
})

check('en passant: refused when taking would uncover a check along the rank', () => {
  // White king a5, white pawn b5, black pawn has just played c7-c5, black rook h5.
  const start = fromFen('8/8/8/KPp4r/8/8/8/7k w - c6 0 1')
  assert.equal(start.ep, 'c6')
  assert.ok(!can(start, 'bxc6'))
  refuses(() => rules.apply(start, WHITE, move('b5', 'c6')), /leave your king in check/)
})

check('promotion: a pawn reaching the last rank becomes a queen, rook, bishop or knight, by choice', () => {
  const start = fromFen('3n4/4P3/8/8/8/8/k7/4K3 w - - 0 1')
  assert.deepEqual(sans(start).filter(san => san.includes('=')), ['e8=B', 'e8=N', 'e8=Q', 'e8=R', 'exd8=B', 'exd8=N', 'exd8=Q', 'exd8=R'].sort())
  assert.ok(isPromotion(start, 'e7', 'e8') && !isPromotion(start, 'e1', 'e2'))
  refuses(() => rules.apply(start, WHITE, move('e7', 'e8')), /Choose the piece/)
  refuses(() => rules.apply(start, WHITE, move('e1', 'e2', 'q')), /Only a pawn reaching the last rank/)
  refuses(() => rules.parseMove({ from: 'e7', to: 'e8', promotion: 'k' }), /queen, rook, bishop or knight/)
  assert.equal(rules.apply(start, WHITE, move('e7', 'e8', 'n')).board, '3nN3/8/8/8/8/8/k7/4K3')
  const captured = rules.apply(start, WHITE, move('e7', 'd8', 'r'))
  assert.equal(captured.board, '3R4/8/8/8/8/8/k7/4K3')
  assert.equal(captured.taken.w, 'n')
  // Promoting to a knight with check: the reason to pick something other than a queen.
  const fork = fromFen('8/5P1k/8/8/8/8/8/K7 w - - 0 1')
  assert.equal(sanOf(fork, move('f7', 'f8', 'n')), 'f8=N+')
})

// ── Check, and how a game ends ───────────────────────────────────────────────────────────────

check('check: the king must be made safe, a pinned piece stays put, and a double check must be run from', () => {
  const pinned = fromFen('4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1')
  assert.deepEqual(legalMovesFrom(pinned, 'e2'), [], 'the knight is pinned to its king')
  refuses(() => rules.apply(pinned, WHITE, move('e2', 'c3')), /leave your king in check/)
  const checked = fromFen('4k3/8/8/8/8/8/3PPP2/r3K3 w - - 0 1')
  assert.ok(inCheck(checked) && rules.view(checked, null).check)
  assert.deepEqual(sans(checked), [], 'boxed in by its own pawns on the back rank, this is mate')
  // A bishop checks from h4; nothing can block or capture, and only e2 is free and safe.
  const answer = fromFen('4k3/8/8/8/7b/8/3P4/3QKB2 w - - 0 1')
  assert.ok(inCheck(answer))
  assert.deepEqual(sans(answer), ['Ke2'])
  refuses(() => rules.apply(answer, WHITE, move('d2', 'd3')), /does not get your king out of it/)
  // Knight and rook both give check: capturing or blocking one is not enough.
  const double = fromFen('4r3/k7/8/8/8/3n4/8/4K2R w - - 0 1')
  assert.ok(inCheck(double))
  assert.ok(sans(double).every(san => san.startsWith('K')), `only king moves: ${sans(double).join(' ')}`)
  assert.equal(kingSquare(double, 'w'), 'e1')
})

check('checkmate: the fastest mate, a back-rank mate and a smothered mate all end the game for the right side', () => {
  const fool = playSan(rules.start(2, 1), 'f3 e5 g4 Qh4#')
  assert.deepEqual(fool.outcome, { winners: [BLACK], draw: false, reason: 'checkmate', text: 'Checkmate. The win goes to {1}.', scores: [0, 1] })
  assert.equal(rules.turn(fool), null)
  refuses(() => rules.apply(fool, WHITE, move('a2', 'a3')), /game is over/)
  const backRank = playSan(fromFen('6k1/5ppp/8/8/8/8/8/R6K w - - 0 1'), 'Ra8#')
  assert.deepEqual(backRank.outcome?.winners, [WHITE])
  const smothered = playSan(fromFen('6rk/6pp/8/6N1/8/8/8/7K w - - 0 1'), 'Nf7#')
  assert.equal(reasonOf(smothered.outcome), 'checkmate')
})

check('stalemate: no legal move and not in check is a draw', () => {
  const state = playSan(fromFen('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1'), 'Qf7')
  assert.equal(reasonOf(state.outcome), 'stalemate')
  assert.deepEqual(state.outcome?.scores, [0.5, 0.5])
  assert.ok(!inCheck(state) && legalMoves(state).length === 0)
  assert.match(state.outcome!.text, /no legal move for \{1\}, and no check/)
})

check('threefold repetition: the third time the same position comes up, the game is drawn by itself', () => {
  let state = playSan(rules.start(2, 1), 'Nf3 Nf6 Ng1 Ng8')
  assert.equal(state.outcome, null, 'twice is not enough')
  state = playSan(state, 'Nf3 Nf6 Ng1')
  assert.equal(state.outcome, null)
  state = playSan(state, 'Ng8')
  assert.equal(reasonOf(state.outcome), 'repetition')
  assert.equal(state.seen.filter(key => key === state.seen.at(-1)).length, 3)
})

check('threefold repetition: the same pieces with different castling or en passant rights is a different position', () => {
  // The kings step out and back: the squares match the start of the line but the castling rights do not.
  const lostRights = playSan(fromFen(CASTLE_BOTH), 'Ke2 Ke7 Ke1 Ke8')
  assert.notEqual(lostRights.seen.at(-1), fromFen(CASTLE_BOTH).seen[0])
  assert.equal(playSan(lostRights, 'Kd1 Kd8 Ke1 Ke8').outcome, null, 'the second time without the rights, which is not yet the third')
  assert.equal(reasonOf(playSan(lostRights, 'Kd1 Kd8 Ke1 Ke8 Kf1 Kf8 Ke1 Ke8').outcome), 'repetition')
  // Right after ...d5 White may capture in passing; when the same squares come round again, White may not.
  const withRight = playSan(fromFen('4k1n1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1'), 'd5')
  const without = playSan(withRight, 'Nf3 Nf6 Ng1 Ng8')
  assert.equal(without.board, withRight.board)
  assert.notEqual(without.seen.at(-1), withRight.seen.at(-1))
  // And when a capture in passing would be illegal anyway (pinned pawn), the right does not make the position different.
  const pinnedRight = playSan(fromFen('4r1k1/3p4/8/4P3/8/8/8/4K1N1 b - - 0 1'), 'd5')
  assert.equal(pinnedRight.ep, 'd6')
  assert.ok(!can(pinnedRight, 'exd6'))
  assert.equal(playSan(pinnedRight, 'Nf3 Kg7 Ng1 Kg8').seen.at(-1), pinnedRight.seen.at(-1))
})

check('fifty-move rule: fifty moves each without a capture or pawn move is a draw by itself; a pawn move starts the count again', () => {
  const nearly = fromFen('4k3/8/8/8/8/8/4P3/R3K3 w - - 99 80')
  assert.equal(reasonOf(playSan(nearly, 'Ra2').outcome), 'fifty-moves')
  const pawn = playSan(nearly, 'e3')
  assert.equal(pawn.outcome, null)
  assert.equal(pawn.halfmove, 0)
  assert.equal(pawn.seen.length, 1, 'earlier positions can never come back after a pawn move')
  // Played out in full: rooks and kings wander at random, never capturing, never moving a pawn, and never repeating a position three times.
  const random = randomSource(50)
  let state = fromFen('r3k3/4p3/8/8/8/8/4P3/R3K3 w - - 0 1'), plies = 0
  while (!state.outcome && plies < 200) {
    const quiet = legalMoves(state).filter(candidate => {
      const san = sanOf(state, candidate)
      if (san.includes('x') || /^[a-h]/.test(san)) return false
      const reason = rules.apply(state, seatOf(state), candidate).outcome?.reason
      return reason === undefined || reason === 'fifty-moves'
    })
    assert.ok(quiet.length, `no quiet move in ${toFen(state)}`)
    state = rules.apply(state, seatOf(state), quiet[Math.floor(random() * quiet.length)]!)
    plies++
  }
  assert.equal(reasonOf(state.outcome), 'fifty-moves')
  assert.equal(plies, 100)
  assert.equal(state.halfmove, 100)
  return `a game of ${plies} quiet half-moves ended as "${reasonOf(state.outcome)}"`
})

check('fifty-move rule: a move that gives checkmate on the hundredth half-move still wins', () => {
  const state = playSan(fromFen('6k1/5ppp/8/8/8/8/8/R6K w - - 99 80'), 'Ra8#')
  assert.equal(reasonOf(state.outcome), 'checkmate')
})

check('not enough pieces: king against king, a lone bishop or knight, and bishops on one colour are drawn by themselves', () => {
  assert.equal(reasonOf(playSan(fromFen('8/8/4k3/8/8/3q4/4K3/8 w - - 0 1'), 'Kxd3').outcome), 'insufficient-material')
  assert.equal(reasonOf(fromFen('8/8/4k3/8/8/3B4/4K3/8 w - - 0 1').outcome), 'insufficient-material')
  assert.equal(reasonOf(fromFen('8/8/4k3/8/8/3N4/4K3/8 w - - 0 1').outcome), 'insufficient-material')
  assert.equal(reasonOf(fromFen('8/8/4k3/5b2/8/3B4/4K3/8 w - - 0 1').outcome), 'insufficient-material', 'bishops on the same colour')
  assert.equal(reasonOf(fromFen('8/4k3/8/8/8/1B1B4/4K3/8 w - - 0 1').outcome), 'insufficient-material', 'two bishops on the same colour')
})

check('not enough pieces: positions where a mate is still possible are played on', () => {
  assert.equal(fromFen('8/8/4k3/4b3/8/3B4/4K3/8 w - - 0 1').outcome, null, 'bishops on opposite colours')
  assert.equal(fromFen('8/8/4k3/4n3/8/3N4/4K3/8 w - - 0 1').outcome, null, 'knight against knight')
  assert.equal(fromFen('8/8/4k3/8/8/2NN4/4K3/8 w - - 0 1').outcome, null, 'two knights')
  assert.equal(fromFen('8/8/4k3/8/8/3P4/4K3/8 w - - 0 1').outcome, null, 'a pawn can still promote')
  // The proof that knight against knight is not dead: a mate that can actually stand on the board.
  const mate = fromFen('kn6/2N5/1K6/8/8/8/8/8 b - - 0 1')
  assert.ok(inCheck(mate) && legalMoves(mate).length === 0, 'the knight on c7 mates a king hemmed in by its own knight')
  assert.equal(reasonOf(mate.outcome), 'checkmate')
})

check('resigning and running out of time lose unless the other side could never mate; leaving forfeits', () => {
  const start = rules.start(2, 1)
  assert.deepEqual(rules.forfeit(start, WHITE, 'resigned').outcome, { winners: [BLACK], draw: false, reason: 'resigned', text: '{0} resigned. The win goes to {1}.', scores: [0, 1] })
  assert.deepEqual(rules.forfeit(start, BLACK, 'left').outcome?.winners, [WHITE])
  assert.deepEqual(rules.forfeit(start, BLACK, 'time').outcome, { winners: [WHITE], draw: false, reason: 'time', text: '{1} ran out of time. The win goes to {0}.', scores: [1, 0] })
  // Black, with a queen, runs out of time against a lone king: a draw.
  const loneKing = fromFen('8/8/4k3/3q4/8/8/4K3/8 b - - 0 1')
  assert.ok(!canMate(loneKing, 'w') && canMate(loneKing, 'b'))
  assert.equal(reasonOf(rules.forfeit(loneKing, BLACK, 'resigned').outcome), 'resigned-insufficient-material', 'the queen side resigning to a bare king is a draw')
  assert.deepEqual(rules.forfeit(loneKing, WHITE, 'resigned').outcome?.winners, [BLACK], 'the bare king resigning to a queen loses')
  assert.equal(reasonOf(rules.forfeit(loneKing, BLACK, 'time').outcome), 'time-insufficient-material')
  assert.deepEqual(rules.forfeit(loneKing, BLACK, 'time').outcome?.scores, [0.5, 0.5])
  assert.deepEqual(rules.forfeit(loneKing, WHITE, 'time').outcome?.winners, [BLACK])
  // King and knight against king and queen: the knight can never mate, so the queen's side
  // flagging or resigning is a draw …
  const knightQueen = fromFen('8/8/4k3/3q4/8/3N4/4K3/8 b - - 0 1')
  assert.equal(reasonOf(rules.forfeit(knightQueen, BLACK, 'time').outcome), 'time-insufficient-material')
  assert.equal(reasonOf(rules.forfeit(knightQueen, BLACK, 'resigned').outcome), 'resigned-insufficient-material')
  assert.deepEqual(rules.forfeit(knightQueen, WHITE, 'resigned').outcome?.winners, [BLACK])
  // … but against king and pawn it can (the pawn can block its own king in), so there the flag falls.
  assert.equal(reasonOf(rules.forfeit(fromFen('8/8/4k3/3p4/8/3N4/4K3/8 b - - 0 1'), BLACK, 'time').outcome), 'time')
  const over = rules.forfeit(start, WHITE, 'resigned')
  assert.equal(rules.forfeit(over, BLACK, 'time'), over, 'a finished game stays as it ended')
})

check('turns and shapes: only the seat to move may move, and anything that is not a move is refused in plain words', () => {
  const start = rules.start(2, 1)
  assert.equal(rules.turn(start), WHITE)
  refuses(() => rules.apply(start, BLACK, move('e7', 'e5')), /not your turn/)
  refuses(() => rules.apply(start, WHITE, move('e7', 'e5')), /not yours to move/)
  refuses(() => rules.apply(start, WHITE, move('e4', 'e5')), /no piece on e4/)
  refuses(() => rules.apply(start, WHITE, move('g1', 'g3')), /A knight cannot move from g1 to g3/)
  refuses(() => rules.apply(start, WHITE, move('a1', 'a2')), /own pieces/)
  for (const junk of [null, 'e2e4', 7, {}, { from: 'e2' }, { from: 'e9', to: 'e4' }, { from: 'e2', to: 'e4', promotion: 5 }]) refuses(() => rules.parseMove(junk), /./)
  assert.deepEqual(rules.parseMove({ from: 'e2', to: 'e4', extra: 'ignored' }), move('e2', 'e4'))
  const before = JSON.stringify(start)
  rules.apply(start, WHITE, move('e2', 'e4'))
  assert.equal(JSON.stringify(start), before, 'apply never changes the state it was given')
  assert.deepEqual(JSON.parse(JSON.stringify(start)), start, 'the state is plain JSON')
})

check('the view hides nothing and carries what the board draws: position, check, moves so far, captures, result', () => {
  const state = playSan(rules.start(2, 1), 'e4 d5 exd5 Qxd5 Nc3 Qe5+')
  const view = rules.view(state, null)
  assert.deepEqual(view, rules.view(state, WHITE))
  assert.equal(view.fen, 'rnb1kbnr/ppp1pppp/8/4q3/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 4')
  assert.ok(view.check)
  assert.deepEqual(view.san, ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qe5+'])
  assert.deepEqual(capturedMaterial(view), { w: ['p'], b: ['p'], lead: 0 })
  assert.equal(capturedMaterial(playSan(state, 'Be2 Qxe2+')).lead, -3)
  assert.equal(positionAfter(view, move('g1', 'e2')).board, 'rnb1kbnr/ppp1pppp/8/4q3/8/2N5/PPPPNPPP/R1BQKB1R')
})

// ── Notation ─────────────────────────────────────────────────────────────────────────────────

check('notation: which knight, which rook, which of three queens; captures, castling, promotion, check and mate marks', () => {
  const knights = fromFen('rnbqkb1r/ppp2ppp/3p1n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq - 0 1')
  assert.equal(sanOf(knights, move('b8', 'd7')), 'Nbd7')
  assert.equal(sanOf(knights, move('f6', 'd7')), 'Nfd7')
  const rooks = fromFen('4k3/8/8/8/R7/8/8/R3K3 w - - 0 1')
  assert.equal(sanOf(rooks, move('a1', 'a3')), 'R1a3')
  assert.equal(sanOf(rooks, move('a4', 'a3')), 'R4a3')
  const queens = fromFen('6k1/8/8/8/4Q2Q/K7/8/4q2Q w - - 0 1')
  assert.equal(sanOf(queens, move('h4', 'e1')), 'Qh4xe1')
  assert.equal(sanOf(queens, move('e4', 'e1')), 'Qexe1')
  assert.equal(sanOf(queens, move('h1', 'e1')), 'Q1xe1')
  assert.equal(sanOf(playSan(rules.start(2, 1), 'e4 a6 e5 d5'), move('e5', 'd6')), 'exd6')
  assert.equal(sanOf(fromFen(CASTLE_BOTH), move('e1', 'g1')), 'O-O')
  assert.equal(sanOf(fromFen('3k4/8/8/8/8/8/8/R3K3 w Q - 0 1'), move('e1', 'c1')), 'O-O-O+')
  assert.equal(sanOf(fromFen('6k1/4P3/6K1/8/8/8/8/8 w - - 0 1'), move('e7', 'e8', 'q')), 'e8=Q#')
  assert.equal(rules.describe(rules.start(2, 1), WHITE, move('g1', 'f3')), 'Nf3')
  assert.deepEqual(moveFromSan(rules.start(2, 1), 'Nf3!?'), move('g1', 'f3'))
  assert.deepEqual(moveFromSan(fromFen(CASTLE_BOTH), '0-0'), move('e1', 'g1'))
  assert.equal(moveFromSan(rules.start(2, 1), 'Nf4'), null)
})

check('notation: a famous game replays move for move to its known final position', () => {
  // Morphy against the Duke of Brunswick and Count Isouard, Paris 1858 (public domain).
  const opera = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'
  const state = playSan(rules.start(2, 1), opera)
  assert.equal(state.san.join(' '), opera, 'the notation produced is the notation played, marks included')
  assert.equal(toFen(state), '1n1Rkb1r/p4ppp/4q3/4p1B1/4P3/8/PPP2PPP/2K5 b k - 1 17')
  assert.deepEqual(state.outcome?.winners, [WHITE])
  assert.deepEqual(capturedMaterial(state), { w: ['r', 'b', 'n', 'p', 'p', 'p'], b: ['q', 'r', 'b', 'n', 'n', 'p'], lead: -10 }, 'Morphy mated ten points down')
})

let roundTrips = 0, positionsWalked = 0
check('notation and keys: over random games every legal move round-trips through its notation, and every position key matches one worked out from scratch', () => {
  const random = randomSource(20261001)
  for (let game = 0; game < 60; game++) {
    let state = rules.start(2, game)
    for (let ply = 0; ply < 160 && !state.outcome; ply++) {
      const moves = legalMoves(state), seenSan = new Set<string>()
      for (const candidate of moves) {
        const san = sanOf(state, candidate)
        assert.ok(!seenSan.has(san), `two moves share the notation ${san} in ${toFen(state)}`)
        seenSan.add(san)
        assert.deepEqual(moveFromSan(state, san), candidate, `${san} in ${toFen(state)}`)
        roundTrips++
      }
      const fresh = fromFen(toFen(state))
      assert.equal(fresh.seen[0], state.seen.at(-1), `key differs in ${toFen(state)}`)
      assert.equal(toFen(fresh), toFen(state))
      positionsWalked++
      state = rules.apply(state, seatOf(state), moves[Math.floor(random() * moves.length)]!)
    }
  }
  return `${roundTrips.toLocaleString('en')} moves in ${positionsWalked.toLocaleString('en')} positions`
})

// ── The computer opponent ────────────────────────────────────────────────────────────────────

check('opening lines: every move of every line the computer knows is legal', () => {
  let moves = 0
  for (const line of openingLines()) { playSan(rules.start(2, 1), line); moves += line.split(' ').length }
  return `${openingLines().length} lines, ${moves} moves`
})

check('the computer gives the same move for the same position and the same run of random numbers, at every level', () => {
  const state = fromFen('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8')
  for (const level of [1, 2, 3] as const) {
    const first = rules.bot(state, WHITE, level, randomSource(99)), again = rules.bot(state, WHITE, level, randomSource(99))
    assert.deepEqual(first, again)
  }
  refuses(() => rules.bot(state, BLACK, 2, randomSource(1)), /turn/)
})

check('an interrupted deepening pass keeps the move from the last fully searched depth', () => {
  const state = fromFen('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8')
  const realNow = Date.now
  const movesAtDepth = new Map<number, Set<string>>()
  try {
    // Advance the guard clock only at a chosen 1,024-node check. Several runs therefore stop at
    // different points in the same root iteration while everything else stays identical.
    for (let stopAfter = 1; stopAfter <= 12; stopAfter++) {
      let clockChecks = 0
      Date.now = () => ++clockChecks > stopAfter ? 1_000 : 0
      const chosen = rules.bot(state, WHITE, 3, randomSource(99))
      const san = sanOf(state, chosen)
      const atDepth = movesAtDepth.get(lastThought.depth)
      if (atDepth) atDepth.add(san); else movesAtDepth.set(lastThought.depth, new Set([san]))
    }
  } finally {
    Date.now = realNow
  }
  for (const [depth, moves] of movesAtDepth) assert.equal(moves.size, 1, `reported depth ${depth} returned ${[...moves].join(', ')}`)
  assert.ok([...movesAtDepth.values()].some(moves => moves.has('O-O')))
  return [...movesAtDepth].map(([depth, moves]) => `depth ${depth}: ${[...moves][0]}`).join(', ')
})

check('quiescence searches quiet replies to check instead of counting an illegal stand-pat', () => {
  // With captures-only replies after check, the shallow search preferred Qxc4 in this position.
  // Searching every legal check evasion agrees with the deeper player on Qb4.
  const state = fromFen('1n2kb2/rN2pp2/3p3B/1pqb2pp/P1PP2P1/2N2PP1/1P2P3/2KR1B1R b - - 1 22')
  assert.equal(sanOf(state, rules.bot(state, BLACK, 2, randomSource(100_043))), 'Qb4')
})

const SCHOLAR = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3'
const allowsMateInOne = (state: ChessState): boolean => legalMoves(state).some(reply => rules.apply(state, seatOf(state), reply).outcome?.reason === 'checkmate')

check('level 1 (beginner) always stops a mate in one, always plays one, and always takes a piece left for nothing', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const random = randomSource(seed * 7919)
    // Black to move; White threatens Qxf7 mate.
    const defended = rules.apply(fromFen(SCHOLAR), BLACK, rules.bot(fromFen(SCHOLAR), BLACK, 1, random))
    assert.ok(!allowsMateInOne(defended), `seed ${seed}: allowed mate after ${defended.san[0]}`)
    // White to move can mate at once.
    const mating = fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4')
    assert.equal(rules.apply(mating, WHITE, rules.bot(mating, WHITE, 1, random)).outcome?.reason, 'checkmate')
    // A queen, a rook and a knight, each left undefended with nothing else going on.
    for (const [fen, prize] of [['4k3/pp6/8/3q4/8/2N5/PP6/4K3 w - - 0 1', 'Nxd5'], ['4k3/pp6/8/8/1r6/2P5/P7/4K3 w - - 0 1', 'cxb4'], ['4k3/pp6/8/8/3n4/8/PP6/3RK3 w - - 0 1', 'Rxd4']] as const) {
      const state = fromFen(fen)
      assert.equal(sanOf(state, rules.bot(state, WHITE, 1, random)), prize, `seed ${seed} in ${fen}`)
    }
  }
  return '150 different runs of luck'
})

interface GameResult { outcome: Outcome | null; plies: number; legal: boolean }
const timings: Record<number, number[]> = { 1: [], 2: [], 3: [] }
const depths: number[] = []
let botMoves = 0, mateInOneAllowed = 0, mateInOneChances = 0

/** One game between two levels. Every move the computer offers is checked against the legal list before it is played. */
function playGame(whiteLevel: 1 | 2 | 3, blackLevel: 1 | 2 | 3, seed: number, from: ChessState = rules.start(2, seed), maxPlies = 400): GameResult {
  const random = randomSource(seed)
  let state = from, plies = 0
  while (!state.outcome && plies < maxPlies) {
    const seat = seatOf(state), level = seat === WHITE ? whiteLevel : blackLevel
    const started = performance.now()
    const chosen = rules.bot(state, seat, level, random)
    timings[level]!.push(performance.now() - started)
    if (level === 3 && !lastThought.book && lastThought.depth > 0) depths.push(lastThought.depth)
    botMoves++
    const parsed = rules.parseMove(JSON.parse(JSON.stringify(chosen)))
    assert.ok(legalMoves(state).some(candidate => candidate.from === parsed.from && candidate.to === parsed.to && candidate.promotion === parsed.promotion), `level ${level} offered an illegal move ${JSON.stringify(chosen)} in ${toFen(state)}`)
    const next = rules.apply(state, seat, parsed)
    if (level === 1 && !next.outcome && allowsMateInOne(next)) {
      // Only a fault if some other move would have avoided it.
      const avoidable = legalMoves(state).some(candidate => { const other = rules.apply(state, seat, candidate); return other.outcome?.reason !== 'checkmate' && !(other.outcome === null && allowsMateInOne(other)) })
      if (avoidable) mateInOneAllowed++
    }
    if (level === 1) mateInOneChances++
    state = next
    plies++
  }
  return { outcome: state.outcome, plies, legal: true }
}

function match(a: 1 | 2 | 3, b: 1 | 2 | 3, games: number, seedBase: number): { aWins: number; bWins: number; draws: number; unfinished: number; reasons: Record<string, number>; plies: number } {
  const tally = { aWins: 0, bWins: 0, draws: 0, unfinished: 0, reasons: {} as Record<string, number>, plies: 0 }
  for (let game = 0; game < games; game++) {
    const aIsWhite = game % 2 === 0
    const result = aIsWhite ? playGame(a, b, seedBase + game) : playGame(b, a, seedBase + game)
    tally.plies += result.plies
    const reason = reasonOf(result.outcome)
    tally.reasons[reason] = (tally.reasons[reason] ?? 0) + 1
    if (!result.outcome) tally.unfinished++
    else if (result.outcome.draw) tally.draws++
    else if ((result.outcome.winners[0] === WHITE) === aIsWhite) tally.aWins++
    else tally.bWins++
  }
  return tally
}
const tallyText = (tally: ReturnType<typeof match>, a: number, b: number): string => `level ${a} won ${tally.aWins}, level ${b} won ${tally.bWins}, ${tally.draws} drawn${tally.unfinished ? `, ${tally.unfinished} stopped at 400 half-moves` : ''} (${Object.entries(tally.reasons).map(([reason, count]) => `${count} ${reason}`).join(', ')}; ${tally.plies} half-moves)`

check('level 3 finds a mate in two and plays it out', () => {
  // Two rooks against a bare king: one rook takes the seventh rank, the other mates on the eighth.
  const result = playGame(3, 1, 5, fromFen('7k/8/8/8/8/8/R7/1R4K1 w - - 0 1'), 3)
  assert.equal(reasonOf(result.outcome), 'checkmate')
  assert.equal(result.plies, 3)
})

check('level 3 wins the basic endings: queen against bare king, and rook against bare king', () => {
  const queen = playGame(3, 1, 11, fromFen('8/8/8/4k3/8/8/8/K6Q w - - 0 1'), 100)
  assert.equal(reasonOf(queen.outcome), 'checkmate')
  const rook = playGame(3, 1, 12, fromFen('8/8/8/4k3/8/8/8/K6R w - - 0 1'), 100)
  assert.equal(reasonOf(rook.outcome), 'checkmate')
  return `queen mate in ${Math.ceil(queen.plies / 2)} moves, rook mate in ${Math.ceil(rook.plies / 2)} moves`
})

check('level 2 moves an attacked queen to safety and takes a piece left for nothing', () => {
  // Black's queen on h4 is attacked by the knight on f3.
  const attacked = fromFen('r1b1kbnr/pppp1ppp/2n5/4p3/3PP2q/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 4')
  const hanging = fromFen('4k3/pp6/8/8/3n4/8/PP6/3RK3 w - - 0 1')
  for (let seed = 1; seed <= 30; seed++) {
    const after = rules.apply(attacked, BLACK, rules.bot(attacked, BLACK, 2, randomSource(seed)))
    const queenAt = squares(after).indexOf('q')
    assert.ok(queenAt >= 0)
    const queenSquare = 'abcdefgh'[queenAt % 8]! + String(8 - Math.floor(queenAt / 8))
    assert.ok(!legalMoves(after).some(reply => reply.to === queenSquare), `seed ${seed}: after ${after.san[0]} the queen on ${queenSquare} can be taken`)
    assert.equal(sanOf(hanging, rules.bot(hanging, WHITE, 2, randomSource(seed))), 'Rxd4')
  }
})

if (!quick) {
  check('matches: the computer never offers an illegal move and every game ends by the rules', () => {
    const lines: string[] = []
    const threeOne = match(3, 1, 12, 1000)
    lines.push(tallyText(threeOne, 3, 1))
    assert.equal(threeOne.unfinished, 0)
    assert.ok(threeOne.aWins >= 11 && threeOne.bWins === 0, `level 3 should beat level 1 clearly: ${tallyText(threeOne, 3, 1)}`)
    const twoOne = match(2, 1, 12, 2000)
    lines.push(tallyText(twoOne, 2, 1))
    assert.ok(twoOne.aWins >= 9, `level 2 should beat level 1: ${tallyText(twoOne, 2, 1)}`)
    const threeTwo = match(3, 2, 12, 3000)
    lines.push(tallyText(threeTwo, 3, 2))
    assert.ok(threeTwo.aWins > threeTwo.bWins, `level 3 should beat level 2: ${tallyText(threeTwo, 3, 2)}`)
    const oneOne = match(1, 1, 8, 4000)
    lines.push(tallyText(oneOne, 1, 1))
    const threeThree = match(3, 3, 4, 5000)
    lines.push(tallyText(threeThree, 3, 3))
    return `${botMoves.toLocaleString('en')} computer moves, all legal\n     ${lines.join('\n     ')}`
  })

  check('level 1 never walked into a mate in one that it could have avoided, across all those games', () => {
    assert.equal(mateInOneAllowed, 0)
    return `${mateInOneChances.toLocaleString('en')} level 1 moves checked`
  })

  check('opening variety: level 3 does not start every game the same way', () => {
    const firstFour = new Set<string>()
    for (let seed = 1; seed <= 12; seed++) {
      const random = randomSource(seed * 104729)
      let state = rules.start(2, seed)
      for (let ply = 0; ply < 4; ply++) state = rules.apply(state, seatOf(state), rules.bot(state, seatOf(state), 3, random))
      firstFour.add(state.san.join(' '))
    }
    assert.ok(firstFour.size >= 6, `only ${firstFour.size} different openings in 12 games`)
    return `${firstFour.size} different first two moves in 12 games`
  })

  check('timing: every level answers well inside 400 ms on this machine', () => {
    const lines: string[] = []
    for (const level of [1, 2, 3] as const) {
      const times = [...timings[level]!].sort((a, b) => a - b)
      const mean = times.reduce((sum, time) => sum + time, 0) / times.length, worst = times.at(-1)!, p95 = times[Math.floor(times.length * 0.95)]!
      assert.ok(worst < 400, `level ${level} took ${worst.toFixed(0)} ms on one move`)
      lines.push(`level ${level}: ${times.length} moves, mean ${mean.toFixed(1)} ms, 95th percentile ${p95.toFixed(1)} ms, slowest ${worst.toFixed(1)} ms`)
    }
    const meanDepth = depths.reduce((sum, depth) => sum + depth, 0) / depths.length
    lines.push(`level 3 looked ${meanDepth.toFixed(1)} half-moves ahead on average (least ${Math.min(...depths)}, most ${Math.max(...depths)}) before captures are followed out`)
    return `\n     ${lines.join('\n     ')}`
  })
}

console.log(failed ? 'FAILED' : `\nAll chess checks passed${quick ? ' (quick run: matches between levels skipped)' : ''}.`)
