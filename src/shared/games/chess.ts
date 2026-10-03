// Chess: the complete rules, a move generator, and a computer opponent at three levels.
//
// Pure and deterministic. The saved state is plain JSON made of the six FEN fields, the keys of
// the positions seen since the last capture or pawn move (for repetition), the moves so far in
// standard notation, and what each side has captured. Seat 0 plays White, seat 1 plays Black.
//
// Inside, a position is a 0x88 board (rank * 16 + file) that moves are made on and taken back
// from; that is what makes the search fast enough to play a decent game in a few tens of
// milliseconds. Nothing here imports the service or Vue: the service is the authority and the App
// uses the same code to show legal moves at once.
import { RulesError } from '../arena.ts'
import type { CreateRules, Outcome, Rules } from '../arena.ts'

// ── Public types ─────────────────────────────────────────────────────────────────────────────

export type Colour = 'w' | 'b'
/** Lower case is the kind of piece; in a board string upper case is White and lower case Black. */
export type PieceKind = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'
export type PromotionKind = 'q' | 'r' | 'b' | 'n'

/** The six fields of a FEN line. Everything a move generator needs. */
export interface ChessPosition {
  /** Piece placement, rank 8 first: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR". */
  board: string
  turn: Colour
  /** Castling rights still held: a subset of "KQkq", or "-". */
  castling: string
  /** The square a pawn may be captured on in passing, or "-". Set only when an enemy pawn stands beside the pawn that just advanced two squares. */
  ep: string
  /** Half-moves since the last capture or pawn move. */
  halfmove: number
  fullmove: number
}

export interface ChessState extends ChessPosition {
  /** Keys of the positions since the last capture or pawn move, the current one last. */
  seen: string[]
  /** Every move so far in standard algebraic notation. */
  san: string[]
  /** What each colour has captured, in the order taken: `taken.w` holds black pieces ("pnq"). */
  taken: { w: string; b: string }
  outcome: Outcome | null
}

export interface ChessMove { from: string; to: string; promotion?: PromotionKind }

/** Chess hides nothing, so every viewer gets the same thing. */
export interface ChessView extends ChessPosition {
  fen: string
  /** The side to move is in check. */
  check: boolean
  san: string[]
  taken: { w: string; b: string }
  outcome: Outcome | null
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

// ── The board inside ─────────────────────────────────────────────────────────────────────────

const WHITE = 0, BLACK = 1
const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6
const KINDS = '.pnbrqk'
const FILES = 'abcdefgh'
const KIND_NAMES = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king']

const KNIGHT_STEPS = [33, 31, 18, 14, -14, -18, -31, -33]
const KING_STEPS = [1, 17, 16, 15, -1, -17, -16, -15]
const BISHOP_STEPS = [17, 15, -15, -17]
const ROOK_STEPS = [1, 16, -1, -16]

// A move is one integer: from (7 bits), to (7 bits), promotion kind (3 bits), then what is special about it.
const NORMAL = 0, EN_PASSANT = 1, CASTLE_SHORT = 2, CASTLE_LONG = 3, DOUBLE_PUSH = 4
const moveOf = (from: number, to: number, promotion: number, special: number): number => from | (to << 7) | (promotion << 14) | (special << 17)

const A1 = 0x00, E1 = 0x04, H1 = 0x07, A8 = 0x70, E8 = 0x74, H8 = 0x77
/** Castling rights lost when a move starts from or lands on a square. Bits: 1 K, 2 Q, 4 k, 8 q. */
const RIGHTS_LOST = new Int8Array(128)
RIGHTS_LOST[H1] = 1; RIGHTS_LOST[A1] = 2; RIGHTS_LOST[E1] = 3; RIGHTS_LOST[H8] = 4; RIGHTS_LOST[A8] = 8; RIGHTS_LOST[E8] = 12

// Zobrist numbers, as two 32-bit halves, from a fixed generator so keys are the same everywhere.
const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128)
const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16)
const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8)
let Z_SIDE_LO = 0, Z_SIDE_HI = 0
{
  let seed = 0x2545f491
  const next = (): number => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0 }
  for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = next(); Z_PIECE_HI[i] = next() }
  for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = next(); Z_CASTLE_HI[i] = next() }
  for (let i = 0; i < 8; i++) { Z_EP_LO[i] = next(); Z_EP_HI[i] = next() }
  Z_SIDE_LO = next(); Z_SIDE_HI = next()
}

const squareName = (square: number): string => FILES[square & 7]! + String((square >> 4) + 1)
const squareOf = (name: string): number => (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97)
const isSquareName = (value: unknown): value is string => typeof value === 'string' && /^[a-h][1-8]$/.test(value)

class Position {
  /** 0 is empty; 1–6 are White's pawn, knight, bishop, rook, queen, king; add 8 for Black. */
  readonly board = new Int8Array(128)
  side = WHITE
  castling = 0
  ep = -1
  half = 0
  full = 1
  readonly king = new Int32Array(2)
  lo = 0
  hi = 0
  private readonly undo = new Int32Array(6 * 512)
  private top = 0

  rehash(): void {
    let lo = 0, hi = 0
    for (let square = 0; square < 120; square++) {
      if (square & 0x88) { square += 7; continue }
      const piece = this.board[square]!
      if (piece) { lo ^= Z_PIECE_LO[(piece << 7) | square]!; hi ^= Z_PIECE_HI[(piece << 7) | square]! }
    }
    lo ^= Z_CASTLE_LO[this.castling]!; hi ^= Z_CASTLE_HI[this.castling]!
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]!; hi ^= Z_EP_HI[this.ep & 7]! }
    if (this.side === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI }
    this.lo = lo; this.hi = hi
  }

  /** Is `square` attacked by a piece of colour `by`? */
  attacked(square: number, by: number): boolean {
    const board = this.board, tint = by << 3
    const pawnFrom = by === WHITE ? -16 : 16
    let from = square + pawnFrom - 1
    if (!(from & 0x88) && board[from] === (tint | PAWN)) return true
    from = square + pawnFrom + 1
    if (!(from & 0x88) && board[from] === (tint | PAWN)) return true
    for (let i = 0; i < 8; i++) {
      from = square + KNIGHT_STEPS[i]!
      if (!(from & 0x88) && board[from] === (tint | KNIGHT)) return true
      from = square + KING_STEPS[i]!
      if (!(from & 0x88) && board[from] === (tint | KING)) return true
    }
    for (let i = 0; i < 4; i++) {
      let step = BISHOP_STEPS[i]!
      for (from = square + step; !(from & 0x88); from += step) {
        const piece = board[from]!
        if (piece) { if (piece === (tint | BISHOP) || piece === (tint | QUEEN)) return true; break }
      }
      step = ROOK_STEPS[i]!
      for (from = square + step; !(from & 0x88); from += step) {
        const piece = board[from]!
        if (piece) { if (piece === (tint | ROOK) || piece === (tint | QUEEN)) return true; break }
      }
    }
    return false
  }

  inCheck(): boolean { return this.attacked(this.king[this.side]!, this.side ^ 1) }

  make(move: number): void {
    const board = this.board, us = this.side, them = us ^ 1
    const from = move & 127, to = (move >> 7) & 127, promotion = (move >> 14) & 7, special = move >> 17
    const piece = board[from]!, captured = board[to]!
    const undo = this.undo
    let top = this.top
    undo[top++] = captured; undo[top++] = this.castling; undo[top++] = this.ep; undo[top++] = this.half; undo[top++] = this.lo; undo[top++] = this.hi
    this.top = top
    let lo = this.lo ^ Z_CASTLE_LO[this.castling]!, hi = this.hi ^ Z_CASTLE_HI[this.castling]!
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]!; hi ^= Z_EP_HI[this.ep & 7]! }

    board[from] = 0
    lo ^= Z_PIECE_LO[(piece << 7) | from]!; hi ^= Z_PIECE_HI[(piece << 7) | from]!
    if (captured) { lo ^= Z_PIECE_LO[(captured << 7) | to]!; hi ^= Z_PIECE_HI[(captured << 7) | to]! }
    const placed = promotion ? (us << 3) | promotion : piece
    board[to] = placed
    lo ^= Z_PIECE_LO[(placed << 7) | to]!; hi ^= Z_PIECE_HI[(placed << 7) | to]!

    if (special === EN_PASSANT) {
      const behind = us === WHITE ? to - 16 : to + 16, pawn = board[behind]!
      board[behind] = 0
      lo ^= Z_PIECE_LO[(pawn << 7) | behind]!; hi ^= Z_PIECE_HI[(pawn << 7) | behind]!
    } else if (special === CASTLE_SHORT || special === CASTLE_LONG) {
      const rookFrom = special === CASTLE_SHORT ? to + 1 : to - 2, rookTo = special === CASTLE_SHORT ? to - 1 : to + 1
      const rook = board[rookFrom]!
      board[rookFrom] = 0; board[rookTo] = rook
      lo ^= Z_PIECE_LO[(rook << 7) | rookFrom]! ^ Z_PIECE_LO[(rook << 7) | rookTo]!
      hi ^= Z_PIECE_HI[(rook << 7) | rookFrom]! ^ Z_PIECE_HI[(rook << 7) | rookTo]!
    }
    if ((piece & 7) === KING) this.king[us] = to
    this.castling &= ~(RIGHTS_LOST[from]! | RIGHTS_LOST[to]!)
    this.ep = -1
    if (special === DOUBLE_PUSH) {
      const enemyPawn = (them << 3) | PAWN
      if ((!((to - 1) & 0x88) && board[to - 1] === enemyPawn) || (!((to + 1) & 0x88) && board[to + 1] === enemyPawn)) this.ep = (from + to) >> 1
    }
    this.half = (piece & 7) === PAWN || captured ? 0 : this.half + 1
    if (us === BLACK) this.full++
    this.side = them
    lo ^= Z_CASTLE_LO[this.castling]! ^ Z_SIDE_LO; hi ^= Z_CASTLE_HI[this.castling]! ^ Z_SIDE_HI
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]!; hi ^= Z_EP_HI[this.ep & 7]! }
    this.lo = lo; this.hi = hi
  }

  unmake(move: number): void {
    const board = this.board, them = this.side, us = them ^ 1
    const from = move & 127, to = (move >> 7) & 127, promotion = (move >> 14) & 7, special = move >> 17
    const undo = this.undo
    let top = this.top
    this.hi = undo[--top]!; this.lo = undo[--top]!; this.half = undo[--top]!; this.ep = undo[--top]!; this.castling = undo[--top]!
    const captured = undo[--top]!
    this.top = top
    const piece = promotion ? (us << 3) | PAWN : board[to]!
    board[from] = piece
    board[to] = captured
    if (special === EN_PASSANT) board[us === WHITE ? to - 16 : to + 16] = (them << 3) | PAWN
    else if (special === CASTLE_SHORT) { board[to + 1] = board[to - 1]!; board[to - 1] = 0 }
    else if (special === CASTLE_LONG) { board[to - 2] = board[to + 1]!; board[to + 1] = 0 }
    if ((piece & 7) === KING) this.king[us] = from
    if (us === BLACK) this.full--
    this.side = us
  }

  /** Pass the turn (used only by the search to ask "what if I did nothing?"). */
  makeNull(): void {
    const undo = this.undo
    undo[this.top++] = this.ep; undo[this.top++] = this.lo; undo[this.top++] = this.hi
    if (this.ep >= 0) { this.lo ^= Z_EP_LO[this.ep & 7]!; this.hi ^= Z_EP_HI[this.ep & 7]! }
    this.ep = -1
    this.side ^= 1
    this.lo ^= Z_SIDE_LO; this.hi ^= Z_SIDE_HI
  }

  unmakeNull(): void {
    const undo = this.undo
    this.hi = undo[--this.top]!; this.lo = undo[--this.top]!; this.ep = undo[--this.top]!
    this.side ^= 1
  }
}

/**
 * Every move that obeys how the pieces move, written into `out`; the count is returned. Moves
 * that leave the mover's own king attacked are still in the list (the caller makes the move and
 * looks). With `forcingOnly`, just captures and promotions to a queen.
 */
function generate(position: Position, out: Int32Array, forcingOnly: boolean): number {
  const board = position.board, us = position.side, them = us ^ 1
  let count = 0
  for (let from = 0; from < 120; from++) {
    if (from & 0x88) { from += 7; continue }
    const piece = board[from]!
    if (!piece || piece >> 3 !== us) continue
    const kind = piece & 7
    if (kind === PAWN) {
      const forward = us === WHITE ? 16 : -16, rank = from >> 4
      const promotes = rank === (us === WHITE ? 6 : 1)
      let to = from + forward
      if (!board[to]) {
        if (promotes) {
          out[count++] = moveOf(from, to, QUEEN, NORMAL)
          if (!forcingOnly) { out[count++] = moveOf(from, to, KNIGHT, NORMAL); out[count++] = moveOf(from, to, ROOK, NORMAL); out[count++] = moveOf(from, to, BISHOP, NORMAL) }
        } else if (!forcingOnly) {
          out[count++] = moveOf(from, to, 0, NORMAL)
          if (rank === (us === WHITE ? 1 : 6) && !board[to + forward]) out[count++] = moveOf(from, to + forward, 0, DOUBLE_PUSH)
        }
      }
      for (let side = -1; side <= 1; side += 2) {
        to = from + forward + side
        if (to & 0x88) continue
        const target = board[to]!
        if (target && target >> 3 === them) {
          if (promotes) {
            out[count++] = moveOf(from, to, QUEEN, NORMAL)
            if (!forcingOnly) { out[count++] = moveOf(from, to, KNIGHT, NORMAL); out[count++] = moveOf(from, to, ROOK, NORMAL); out[count++] = moveOf(from, to, BISHOP, NORMAL) }
          } else out[count++] = moveOf(from, to, 0, NORMAL)
        } else if (to === position.ep) out[count++] = moveOf(from, to, 0, EN_PASSANT)
      }
    } else if (kind === KNIGHT || kind === KING) {
      const steps = kind === KNIGHT ? KNIGHT_STEPS : KING_STEPS
      for (let i = 0; i < 8; i++) {
        const to = from + steps[i]!
        if (to & 0x88) continue
        const target = board[to]!
        if (!target) { if (!forcingOnly) out[count++] = moveOf(from, to, 0, NORMAL) }
        else if (target >> 3 === them) out[count++] = moveOf(from, to, 0, NORMAL)
      }
    } else {
      for (let i = 0; i < 4; i++) {
        for (let pass = 0; pass < 2; pass++) {
          if (pass === 0 ? kind === ROOK : kind === BISHOP) continue
          const step = pass === 0 ? BISHOP_STEPS[i]! : ROOK_STEPS[i]!
          for (let to = from + step; !(to & 0x88); to += step) {
            const target = board[to]!
            if (!target) { if (!forcingOnly) out[count++] = moveOf(from, to, 0, NORMAL) }
            else { if (target >> 3 === them) out[count++] = moveOf(from, to, 0, NORMAL); break }
          }
        }
      }
    }
  }
  if (!forcingOnly) {
    // Castling: the right is still held, the squares between are empty, and the king is not in
    // check, does not cross an attacked square and does not land on one.
    const home = us === WHITE ? E1 : E8, short = us === WHITE ? 1 : 4, long = us === WHITE ? 2 : 8
    if (position.castling & (short | long) && !position.attacked(home, them)) {
      if (position.castling & short && !board[home + 1] && !board[home + 2] && !position.attacked(home + 1, them) && !position.attacked(home + 2, them)) out[count++] = moveOf(home, home + 2, 0, CASTLE_SHORT)
      if (position.castling & long && !board[home - 1] && !board[home - 2] && !board[home - 3] && !position.attacked(home - 1, them) && !position.attacked(home - 2, them)) out[count++] = moveOf(home, home - 2, 0, CASTLE_LONG)
    }
  }
  return count
}

const SCRATCH = new Int32Array(256)

function legalList(position: Position): number[] {
  const us = position.side, moves: number[] = []
  const count = generate(position, SCRATCH, false)
  const all = Array.from(SCRATCH.subarray(0, count))
  for (const move of all) {
    position.make(move)
    if (!position.attacked(position.king[us]!, us ^ 1)) moves.push(move)
    position.unmake(move)
  }
  return moves
}

function hasLegalMove(position: Position): boolean {
  const us = position.side, buffer = new Int32Array(256)
  const count = generate(position, buffer, false)
  for (let i = 0; i < count; i++) {
    position.make(buffer[i]!)
    const safe = !position.attacked(position.king[us]!, us ^ 1)
    position.unmake(buffer[i]!)
    if (safe) return true
  }
  return false
}

const PERFT_BUFFERS: Int32Array[] = []
function perftAt(position: Position, depth: number): number {
  const buffer = (PERFT_BUFFERS[depth] ??= new Int32Array(256)), us = position.side
  const count = generate(position, buffer, false)
  let nodes = 0
  for (let i = 0; i < count; i++) {
    const move = buffer[i]!
    position.make(move)
    if (!position.attacked(position.king[us]!, us ^ 1)) nodes += depth === 1 ? 1 : perftAt(position, depth - 1)
    position.unmake(move)
  }
  return nodes
}

// ── Between JSON and the board inside ────────────────────────────────────────────────────────

function load(from: ChessPosition): Position {
  const position = new Position()
  let rank = 7, file = 0
  for (const char of from.board) {
    if (char === '/') { rank--; file = 0 }
    else if (char >= '1' && char <= '8') file += Number(char)
    else {
      const lower = char.toLowerCase(), kind = KINDS.indexOf(lower), square = rank * 16 + file
      const piece = char === lower ? kind | 8 : kind
      position.board[square] = piece
      if (kind === KING) position.king[piece >> 3] = square
      file++
    }
  }
  position.side = from.turn === 'w' ? WHITE : BLACK
  position.castling = (from.castling.includes('K') ? 1 : 0) | (from.castling.includes('Q') ? 2 : 0) | (from.castling.includes('k') ? 4 : 0) | (from.castling.includes('q') ? 8 : 0)
  position.ep = from.ep === '-' ? -1 : squareOf(from.ep)
  position.half = from.halfmove
  position.full = from.fullmove
  position.rehash()
  return position
}

function fields(position: Position): ChessPosition {
  let board = ''
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0
    for (let file = 0; file < 8; file++) {
      const piece = position.board[rank * 16 + file]!
      if (!piece) { empty++; continue }
      if (empty) { board += String(empty); empty = 0 }
      const letter = KINDS[piece & 7]!
      board += piece >> 3 === WHITE ? letter.toUpperCase() : letter
    }
    if (empty) board += String(empty)
    if (rank) board += '/'
  }
  const rights = (position.castling & 1 ? 'K' : '') + (position.castling & 2 ? 'Q' : '') + (position.castling & 4 ? 'k' : '') + (position.castling & 8 ? 'q' : '')
  return { board, turn: position.side === WHITE ? 'w' : 'b', castling: rights || '-', ep: position.ep >= 0 ? squareName(position.ep) : '-', halfmove: position.half, fullmove: position.full }
}

const hex = (value: number): string => (value >>> 0).toString(16).padStart(8, '0')

/**
 * The key two positions share exactly when the rules call them the same position: same pieces on
 * the same squares, same side to move, same castling rights, and the same right to capture in
 * passing (which only counts when such a capture is actually legal).
 */
function keyOf(position: Position, legal: number[]): string {
  let lo = position.lo, hi = position.hi
  if (position.ep >= 0 && !legal.some(move => move >> 17 === EN_PASSANT)) { lo ^= Z_EP_LO[position.ep & 7]!; hi ^= Z_EP_HI[position.ep & 7]! }
  return hex(lo) + hex(hi)
}

const toMove = (move: number): ChessMove => {
  const promotion = (move >> 14) & 7
  const plain: ChessMove = { from: squareName(move & 127), to: squareName((move >> 7) & 127) }
  if (promotion) plain.promotion = KINDS[promotion] as PromotionKind
  return plain
}

function sanOfMove(position: Position, move: number, legal: number[]): string {
  const from = move & 127, to = (move >> 7) & 127, promotion = (move >> 14) & 7, special = move >> 17
  const kind = position.board[from]! & 7
  let text: string
  if (special === CASTLE_SHORT) text = 'O-O'
  else if (special === CASTLE_LONG) text = 'O-O-O'
  else {
    const capture = special === EN_PASSANT || position.board[to] !== 0
    if (kind === PAWN) text = (capture ? `${FILES[from & 7]!}x` : '') + squareName(to) + (promotion ? `=${KINDS[promotion]!.toUpperCase()}` : '')
    else {
      // Another piece of the same kind that could also go there: say which one this is.
      let others = false, sameFile = false, sameRank = false
      for (const other of legal) {
        const otherFrom = other & 127
        if (other === move || ((other >> 7) & 127) !== to || (position.board[otherFrom]! & 7) !== kind) continue
        others = true
        if ((otherFrom & 7) === (from & 7)) sameFile = true
        if (otherFrom >> 4 === from >> 4) sameRank = true
      }
      const which = !others ? '' : !sameFile ? FILES[from & 7]! : !sameRank ? String((from >> 4) + 1) : squareName(from)
      text = KINDS[kind]!.toUpperCase() + which + (capture ? 'x' : '') + squareName(to)
    }
  }
  position.make(move)
  if (position.inCheck()) text += hasLegalMove(position) ? '+' : '#'
  position.unmake(move)
  return text
}

/** Can `colour` ever give checkmate with what it has, by any sequence of legal moves? */
function couldMate(position: Position, colour: number): boolean {
  let knights = 0, light = 0, dark = 0, theirBlockers = 0, theirKnightsOrPawns = 0, theirLight = 0, theirDark = 0
  for (let square = 0; square < 120; square++) {
    if (square & 0x88) { square += 7; continue }
    const piece = position.board[square]!
    if (!piece) continue
    const kind = piece & 7, onLight = ((square >> 4) + (square & 7)) & 1
    if (piece >> 3 === colour) {
      if (kind === PAWN || kind === ROOK || kind === QUEEN) return true
      if (kind === KNIGHT) knights++
      else if (kind === BISHOP) { if (onLight) light++; else dark++ }
    } else {
      if (kind === PAWN || kind === KNIGHT) theirKnightsOrPawns++
      if (kind === BISHOP) { if (onLight) theirLight++; else theirDark++ }
      if (kind !== KING && kind !== QUEEN) theirBlockers++
    }
  }
  if (knights + light + dark === 0) return false
  if (knights >= 2 || (knights && light + dark) || (light && dark)) return true
  // One knight mates only when an enemy piece can take a flight square from its own king (a queen never has to).
  if (knights === 1) return theirBlockers > 0
  // Bishops on one colour need an enemy knight, pawn or opposite-coloured bishop to box the king in.
  return theirKnightsOrPawns > 0 || (light ? theirDark : theirLight) > 0
}

// ── Helpers for the board and the probe ──────────────────────────────────────────────────────

/** All legal moves in a position. A pawn reaching the last rank appears four times, once per piece. */
export function legalMoves(position: ChessPosition): ChessMove[] { return legalList(load(position)).map(toMove) }

/** The legal moves of the piece on `square` ("e2"). */
export function legalMovesFrom(position: ChessPosition, square: string): ChessMove[] {
  if (!isSquareName(square)) return []
  const from = squareOf(square)
  return legalList(load(position)).filter(move => (move & 127) === from).map(toMove)
}

/** Is `colour`'s king attacked? Defaults to the side to move. */
export function inCheck(position: ChessPosition, colour: Colour = position.turn): boolean {
  const inside = load(position), side = colour === 'w' ? WHITE : BLACK
  return inside.attacked(inside.king[side]!, side ^ 1)
}

/** Where `colour`'s king stands. */
export function kingSquare(position: ChessPosition, colour: Colour): string { return squareName(load(position).king[colour === 'w' ? WHITE : BLACK]!) }

/** The 64 squares from a8 across to h1: a piece letter (upper case White) or '' when empty. */
export function squares(position: ChessPosition): string[] {
  const out: string[] = []
  for (const char of position.board) {
    if (char === '/') continue
    if (char >= '1' && char <= '8') for (let i = 0; i < Number(char); i++) out.push('')
    else out.push(char)
  }
  return out
}

function findMove(position: Position, move: ChessMove, legal: number[]): number | undefined {
  const from = squareOf(move.from), to = squareOf(move.to), promotion = move.promotion ? KINDS.indexOf(move.promotion) : 0
  return legal.find(candidate => (candidate & 127) === from && ((candidate >> 7) & 127) === to && ((candidate >> 14) & 7) === promotion)
}

/** Standard algebraic notation for a legal move: "Nbd7", "exd6", "O-O", "e8=Q+", "Qh7#". Throws RulesError when it is not legal. */
export function sanOf(position: ChessPosition, move: ChessMove): string {
  const inside = load(position), legal = legalList(inside)
  const found = findMove(inside, move, legal)
  if (found === undefined) throw new RulesError(refusal(inside, move, legal))
  return sanOfMove(inside, found, legal)
}

/** The legal move a line of notation names, or null. Check marks and annotations are ignored. */
export function moveFromSan(position: ChessPosition, san: string): ChessMove | null {
  const inside = load(position), legal = legalList(inside)
  const wanted = san.replace(/[+#!?]+$/g, '').replace(/0/g, 'O')
  for (const move of legal) if (sanOfMove(inside, move, legal).replace(/[+#]$/, '') === wanted) return toMove(move)
  return null
}

/** Does this move take a pawn to the last rank (so a piece must be chosen)? */
export function isPromotion(position: ChessPosition, from: string, to: string): boolean {
  return legalMovesFrom(position, from).some(move => move.to === to && move.promotion !== undefined)
}

/** The position after a legal move. Throws RulesError when it is not legal. */
export function positionAfter(position: ChessPosition, move: ChessMove): ChessPosition {
  const inside = load(position), legal = legalList(inside)
  const found = findMove(inside, move, legal)
  if (found === undefined) throw new RulesError(refusal(inside, move, legal))
  inside.make(found)
  return fields(inside)
}

export function toFen(position: ChessPosition): string {
  return `${position.board} ${position.turn} ${position.castling} ${position.ep} ${position.halfmove} ${position.fullmove}`
}

/** A game starting from a FEN line. Throws RulesError when the line is not a position that can be played. */
export function fromFen(fen: string): ChessState {
  const parts = fen.trim().split(/\s+/)
  const [board = '', turn = 'w', castling = '-', ep = '-', halfmove = '0', fullmove = '1'] = parts
  const ranks = board.split('/')
  const bad = (why: string): never => { throw new RulesError(`That position cannot be set up: ${why}.`) }
  if (ranks.length !== 8) bad('it needs eight ranks')
  let whiteKings = 0, blackKings = 0
  ranks.forEach((rank, index) => {
    let width = 0
    for (const char of rank) {
      if (char >= '1' && char <= '8') width += Number(char)
      else if ('pnbrqkPNBRQK'.includes(char)) {
        width++
        if (char === 'K') whiteKings++
        if (char === 'k') blackKings++
        if ((char === 'p' || char === 'P') && (index === 0 || index === 7)) bad('a pawn cannot stand on the first or last rank')
      } else bad(`"${char}" is not a piece`)
    }
    if (width !== 8) bad('every rank needs eight squares')
  })
  if (whiteKings !== 1 || blackKings !== 1) bad('each side needs exactly one king')
  if (turn !== 'w' && turn !== 'b') bad('the side to move must be w or b')
  if (!/^(-|K?Q?k?q?)$/.test(castling) || castling === '') bad('the castling field is not understood')
  if (ep !== '-' && !/^[a-h][36]$/.test(ep)) bad('the en passant square is not understood')
  const half = Number(halfmove), full = Number(fullmove)
  if (!Number.isInteger(half) || half < 0 || !Number.isInteger(full) || full < 1) bad('the move counters must be whole numbers')

  const position = load({ board, turn: turn as Colour, castling, ep: '-', halfmove: half, fullmove: full })
  // Keep only the castling rights the pieces still support, and the en passant square only when a capture there is possible.
  const at = (square: number, piece: number): boolean => position.board[square] === piece
  let rights = position.castling
  if (!at(E1, KING)) rights &= ~3
  if (!at(H1, ROOK)) rights &= ~1
  if (!at(A1, ROOK)) rights &= ~2
  if (!at(E8, KING | 8)) rights &= ~12
  if (!at(H8, ROOK | 8)) rights &= ~4
  if (!at(A8, ROOK | 8)) rights &= ~8
  position.castling = rights
  if (ep !== '-') {
    const target = squareOf(ep), them = position.side ^ 1
    const pawnSquare = position.side === WHITE ? target - 16 : target + 16
    const ours = (position.side << 3) | PAWN
    const besides = [pawnSquare - 1, pawnSquare + 1].some(square => !(square & 0x88) && position.board[square] === ours)
    if (target >> 4 === (position.side === WHITE ? 5 : 2) && position.board[pawnSquare] === ((them << 3) | PAWN) && !position.board[target] && besides) position.ep = target
  }
  position.rehash()
  if (position.attacked(position.king[position.side ^ 1]!, position.side)) bad('the side that just moved has left its king in check')
  const legal = legalList(position), key = keyOf(position, legal)
  const state: ChessState = { ...fields(position), seen: [key], san: [], taken: { w: '', b: '' }, outcome: null }
  state.outcome = judge(position, legal, state.seen)
  return state
}

const WORTH = [0, 1, 3, 3, 5, 9, 0]

/**
 * What each side has captured, most valuable first, and who is ahead on the usual count
 * (pawn 1, knight 3, bishop 3, rook 5, queen 9): `lead` is positive when White is ahead.
 */
export function capturedMaterial(view: Pick<ChessState, 'board' | 'taken'>): { w: PieceKind[]; b: PieceKind[]; lead: number } {
  const order = 'qrbnp'
  const sort = (taken: string): PieceKind[] => ([...taken] as PieceKind[]).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  let lead = 0
  for (const char of view.board) {
    const kind = KINDS.indexOf(char.toLowerCase())
    if (kind > 0) lead += char === char.toLowerCase() ? -WORTH[kind]! : WORTH[kind]!
  }
  return { w: sort(view.taken.w), b: sort(view.taken.b), lead }
}

/**
 * Does `colour` have material that can ever form a checkmate? This recognizes the standard bare
 * king and minor-piece cases. It is deliberately conservative: it does not solve every unusual
 * dead position made by permanently locked pieces.
 */
export function canMate(position: ChessPosition, colour: Colour): boolean { return couldMate(load(position), colour === 'w' ? WHITE : BLACK) }

/** How many positions are reachable in exactly `depth` moves: the standard test of a move generator. */
export function perft(position: ChessPosition, depth: number): number { return depth <= 0 ? 1 : perftAt(load(position), depth) }

// ── Refusals and results ─────────────────────────────────────────────────────────────────────

/** A plain reason a move is not allowed. */
function refusal(position: Position, move: ChessMove, legal: number[]): string {
  const from = squareOf(move.from), to = squareOf(move.to), us = position.side, them = us ^ 1
  const piece = position.board[from]!
  if (!piece) return `There is no piece on ${move.from}.`
  if (piece >> 3 !== us) return 'That piece is not yours to move.'
  const kind = piece & 7, target = position.board[to]!
  if (from === to) return 'A move has to go to a different square.'
  if (target && target >> 3 === us) return 'One of your own pieces is on that square.'
  const sameSquares = legal.filter(candidate => (candidate & 127) === from && ((candidate >> 7) & 127) === to)
  if (sameSquares.length) return move.promotion ? 'Only a pawn reaching the last rank is promoted.' : 'Choose the piece your pawn becomes: queen, rook, bishop or knight.'

  const home = us === WHITE ? E1 : E8
  if (kind === KING && from === home && (to === home + 2 || to === home - 2)) {
    const short = to > from, right = us === WHITE ? (short ? 1 : 2) : short ? 4 : 8
    if (!(position.castling & right)) return 'You cannot castle on that side: the king or that rook has already moved.'
    const between = short ? [home + 1, home + 2] : [home - 1, home - 2, home - 3]
    if (between.some(square => position.board[square])) return 'You cannot castle while a piece stands between the king and the rook.'
    if (position.attacked(home, them)) return 'You cannot castle out of check.'
    return 'You cannot castle through or onto a square the other side attacks.'
  }
  const count = generate(position, SCRATCH, false)
  const obeys = Array.from(SCRATCH.subarray(0, count)).some(candidate => (candidate & 127) === from && ((candidate >> 7) & 127) === to)
  if (obeys) return position.inCheck() ? 'You are in check, and that move does not get your king out of it.' : 'That would leave your king in check.'
  return `A ${KIND_NAMES[kind]!} cannot move from ${move.from} to ${move.to}.`
}

const draw = (reason: string, text: string): Outcome => ({ winners: [], draw: true, reason, text, scores: [0.5, 0.5] })
const win = (seat: number, reason: string, text: string): Outcome => ({ winners: [seat], draw: false, reason, text, scores: seat === 0 ? [1, 0] : [0, 1] })

/**
 * Has the game ended in this position? Checkmate and stalemate first; then the draws this game
 * applies by itself — no way left to mate, the same position a third time, fifty moves each
 * without a capture or a pawn move.
 */
function judge(position: Position, legal: number[], seen: string[]): Outcome | null {
  const mover = position.side, other = mover ^ 1
  if (!legal.length) {
    if (position.inCheck()) return win(other, 'checkmate', `Checkmate. The win goes to {${other}}.`)
    return draw('stalemate', `Stalemate: there is no legal move for {${mover}}, and no check. The game is a draw.`)
  }
  if (!couldMate(position, WHITE) && !couldMate(position, BLACK)) return draw('insufficient-material', 'Neither side has enough pieces left to give checkmate. The game is a draw.')
  const current = seen[seen.length - 1]
  let times = 0
  for (const key of seen) if (key === current) times++
  if (times >= 3) return draw('repetition', 'The same position has come up three times. The game is a draw.')
  if (position.half >= 100) return draw('fifty-moves', 'Fifty moves each have passed without a capture or a pawn move. The game is a draw.')
  return null
}

// ── The computer opponent ────────────────────────────────────────────────────────────────────

const VALUE = [0, 100, 320, 330, 500, 900, 0]
const PHASE = [0, 0, 1, 1, 2, 4, 0]
const INFINITE = 32000, MATE = 30000, MATE_BOUND = MATE - 500, MAX_PLY = 64

// Piece-square tables, written from simple ideas rather than copied: pawns want to advance and
// hold the centre, knights and bishops want the middle, rooks want the seventh rank and central
// files, the king wants a castled corner while queens are on and the centre once they are gone.
// Indexed by kind then square from White's side; Black reads them mirrored. MG is the
// middlegame value, EG the endgame value; the evaluation blends them by how much is left.
const MG = Array.from({ length: 7 }, () => new Int16Array(128)), EG = Array.from({ length: 7 }, () => new Int16Array(128))
{
  const middle = [0, 1, 2, 3, 3, 2, 1, 0]
  for (let rank = 0; rank < 8; rank++) for (let file = 0; file < 8; file++) {
    const square = rank * 16 + file, centre = middle[file]! + middle[rank]!, advance = rank - 1
    if (rank > 0 && rank < 7) {
      let pawn = advance * advance * 1.5 + middle[file]! * advance * 2.5
      if (rank === 1) pawn += file === 3 || file === 4 ? -18 : file === 2 ? -4 : 6
      if (rank === 2 && (file === 0 || file === 7)) pawn += 2
      MG[PAWN]![square] = Math.round(pawn)
      EG[PAWN]![square] = Math.round(advance * advance * 3 + advance * 5)
    }
    MG[KNIGHT]![square] = centre * 10 - 30 - (rank === 0 ? 10 : 0)
    EG[KNIGHT]![square] = centre * 7 - 21
    MG[BISHOP]![square] = centre * 5 - 12 - (rank === 0 ? 10 : 0) + (file === rank || file + rank === 7 ? 5 : 0)
    EG[BISHOP]![square] = centre * 4 - 10
    MG[ROOK]![square] = middle[file]! * 4 - 4 + (rank === 6 ? 22 : 0)
    EG[ROOK]![square] = rank === 6 ? 12 : 0
    MG[QUEEN]![square] = centre * 2 - 6 - (rank === 0 ? 4 : 0)
    EG[QUEEN]![square] = centre * 5 - 15
    MG[KING]![square] = rank === 0 ? [18, 34, 8, -12, -2, -12, 34, 18][file]! : rank === 1 ? [-6, -6, -22, -34, -34, -22, -6, -6][file]! : -44 - (rank - 2) * 8
    EG[KING]![square] = centre * 11 - 34
  }
}
const PASSED = [0, 6, 10, 18, 34, 60, 96, 0]

const pawnFiles = [new Int8Array(10), new Int8Array(10)]
/** Per file (offset by one so the neighbours of files a and h exist): the rank of White's rearmost pawn, and of Black's. */
const whiteRear = new Int8Array(10), blackRear = new Int8Array(10)
const pawnList = new Int32Array(16), rookList = new Int32Array(20)

/** How good the position is for the side to move, in hundredths of a pawn. */
function evaluate(position: Position): number {
  const board = position.board
  let mg = 0, eg = 0, phase = 0, pawns = 0, rooks = 0
  let whiteBishops = 0, blackBishops = 0, whiteStuff = 0, blackStuff = 0
  pawnFiles[0]!.fill(0); pawnFiles[1]!.fill(0); whiteRear.fill(8); blackRear.fill(-1)
  for (let square = 0; square < 120; square++) {
    if (square & 0x88) { square += 7; continue }
    const piece = board[square]!
    if (!piece) continue
    const kind = piece & 7
    if (piece >> 3 === WHITE) {
      mg += VALUE[kind]! + MG[kind]![square]!; eg += VALUE[kind]! + EG[kind]![square]!
      if (kind === PAWN) { const file = (square & 7) + 1; pawnFiles[0]![file]!++; if (square >> 4 < whiteRear[file]!) whiteRear[file] = square >> 4; pawnList[pawns++] = square }
      else if (kind !== KING) { whiteStuff += VALUE[kind]!; if (kind === BISHOP) whiteBishops++; else if (kind === ROOK) rookList[rooks++] = square }
    } else {
      const mirrored = square ^ 0x70
      mg -= VALUE[kind]! + MG[kind]![mirrored]!; eg -= VALUE[kind]! + EG[kind]![mirrored]!
      if (kind === PAWN) { const file = (square & 7) + 1; pawnFiles[1]![file]!++; if (square >> 4 > blackRear[file]!) blackRear[file] = square >> 4; pawnList[pawns++] = square }
      else if (kind !== KING) { blackStuff += VALUE[kind]!; if (kind === BISHOP) blackBishops++; else if (kind === ROOK) rookList[rooks++] = square }
    }
    phase += PHASE[kind]!
  }
  if (whiteBishops >= 2) { mg += 28; eg += 40 }
  if (blackBishops >= 2) { mg -= 28; eg -= 40 }

  let whitePawns = 0, blackPawns = 0
  for (let i = 0; i < pawns; i++) {
    const square = pawnList[i]!, file = (square & 7) + 1, rank = square >> 4
    if (board[square] === PAWN) {
      whitePawns++
      const mine = pawnFiles[0]!
      let score = 0
      if (mine[file]! > 1) score -= 9
      if (!mine[file - 1] && !mine[file + 1]) score -= 11
      // Passed: no black pawn ahead on this file or the two beside it.
      if (blackRear[file - 1]! <= rank && blackRear[file]! <= rank && blackRear[file + 1]! <= rank) { mg += PASSED[rank]! >> 1; eg += PASSED[rank]! }
      mg += score; eg += score
    } else {
      blackPawns++
      const mine = pawnFiles[1]!
      let score = 0
      if (mine[file]! > 1) score -= 9
      if (!mine[file - 1] && !mine[file + 1]) score -= 11
      if (whiteRear[file - 1]! >= rank && whiteRear[file]! >= rank && whiteRear[file + 1]! >= rank) { mg -= PASSED[7 - rank]! >> 1; eg -= PASSED[7 - rank]! }
      mg -= score; eg -= score
    }
  }
  for (let i = 0; i < rooks; i++) {
    const square = rookList[i]!, file = (square & 7) + 1, white = board[square] === ROOK
    const own = pawnFiles[white ? 0 : 1]![file]!, theirs = pawnFiles[white ? 1 : 0]![file]!
    const bonus = own ? 0 : theirs ? 9 : 18
    if (white) mg += bonus; else mg -= bonus
  }
  // Pawns in front of a king that has stayed home: worth something while there are pieces to attack it.
  const whiteKing = position.king[WHITE]!, blackKing = position.king[BLACK]!
  if (whiteKing >> 4 === 0) for (let file = (whiteKing & 7) - 1; file <= (whiteKing & 7) + 1; file++) {
    if (file < 0 || file > 7) continue
    if (board[16 + file] === PAWN) mg += 10; else if (board[32 + file] === PAWN) mg += 5
  }
  if (blackKing >> 4 === 7) for (let file = (blackKing & 7) - 1; file <= (blackKing & 7) + 1; file++) {
    if (file < 0 || file > 7) continue
    if (board[96 + file] === (PAWN | 8)) mg -= 10; else if (board[80 + file] === (PAWN | 8)) mg -= 5
  }

  if (phase > 24) phase = 24
  let score = (mg * phase + eg * (24 - phase)) / 24
  // Winning with pieces alone: drive the other king to the edge and bring your own king up.
  const ahead = whiteStuff - blackStuff
  if (phase <= 10 && (ahead >= 400 || ahead <= -400)) {
    const loser = ahead > 0 ? blackKing : whiteKing, winner = ahead > 0 ? whiteKing : blackKing
    const loserFile = loser & 7, loserRank = loser >> 4
    const fromCentre = Math.max(3 - loserFile, loserFile - 4) + Math.max(3 - loserRank, loserRank - 4)
    const apart = Math.abs((winner & 7) - loserFile) + Math.abs((winner >> 4) - loserRank)
    const push = fromCentre * 12 + (14 - apart) * 5
    score += ahead > 0 ? push : -push
  }
  // No pawns and not enough extra to force anything: nearly a draw however the count looks.
  if (score > 0 ? !whitePawns && ahead < 400 : !blackPawns && ahead > -400) score /= 8
  score = Math.round(score)
  return (position.side === WHITE ? score : -score) + 8
}

const TT_BITS = 17, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1
const EXACT = 1, LOWER = 2, UPPER = 3
const ttLo = new Int32Array(TT_SIZE), ttHi = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE)
const ttScore = new Int16Array(TT_SIZE), ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE)
const killers = new Int32Array(2 * MAX_PLY), history = new Int32Array(2 << 14)
const MOVES = Array.from({ length: MAX_PLY + 1 }, () => new Int32Array(256)), ORDER = Array.from({ length: MAX_PLY + 1 }, () => new Int32Array(256))
const pathLo = new Int32Array(512), pathHi = new Int32Array(512)

let thinking: Position = new Position()
let pathBase = 0, nodes = 0, nodeLimit = 0, deadline = 0, stopped = false

/** Counts a node; every 1,024th it looks at the node budget and, as a guard only, the clock. */
function spent(): boolean {
  if ((++nodes & 1023) === 0 && (nodes >= nodeLimit || Date.now() > deadline)) stopped = true
  return stopped
}

/**
 * Follow forcing moves until the position is quiet enough to count. A checked side has no legal
 * stand-pat: it must search every evasion, including a quiet king move or block.
 */
function quiesce(alpha: number, beta: number, ply: number): number {
  if (spent()) return 0
  const position = thinking, checked = position.inCheck()
  const stand = checked ? -INFINITE : evaluate(position)
  if (ply >= MAX_PLY) return evaluate(position)
  if (!checked) {
    if (stand >= beta) return stand
    if (stand > alpha) alpha = stand
  }
  const moves = MOVES[ply]!, order = ORDER[ply]!, board = position.board, us = position.side
  const count = generate(position, moves, !checked)
  for (let i = 0; i < count; i++) {
    const move = moves[i]!
    order[i] = (VALUE[board[(move >> 7) & 127]! & 7]! << 4) - (board[move & 127]! & 7) + ((move >> 14) & 7 ? 8000 : 0)
  }
  let played = 0
  for (let i = 0; i < count; i++) {
    let best = i
    for (let j = i + 1; j < count; j++) if (order[j]! > order[best]!) best = j
    const move = moves[best]!
    moves[best] = moves[i]!; order[best] = order[i]!
    const promotion = (move >> 14) & 7, victim = move >> 17 === EN_PASSANT ? PAWN : board[(move >> 7) & 127]! & 7
    // Even winning this piece for nothing would not reach alpha: skip it.
    if (!checked && !promotion && stand + VALUE[victim]! + 180 < alpha) continue
    position.make(move)
    if (position.attacked(position.king[us]!, us ^ 1)) { position.unmake(move); continue }
    played++
    const score = -quiesce(-beta, -alpha, ply + 1)
    position.unmake(move)
    if (stopped) return 0
    if (score > alpha) { alpha = score; if (alpha >= beta) break }
  }
  if (checked && !played) return -MATE + ply
  return alpha
}

function hasPieces(position: Position, colour: number): boolean {
  for (let square = 0; square < 120; square++) {
    if (square & 0x88) { square += 7; continue }
    const piece = position.board[square]!
    if (piece && piece >> 3 === colour && (piece & 7) !== PAWN && (piece & 7) !== KING) return true
  }
  return false
}

/** Alpha-beta with a memory of positions, check extension, null move, and late quiet moves searched less deeply first. */
function search(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
  if (spent()) return 0
  const position = thinking, us = position.side, them = us ^ 1, board = position.board
  const at = pathBase + ply
  pathLo[at] = position.lo; pathHi[at] = position.hi
  if (ply > 0) {
    // Fifty moves each is a draw, unless the hundredth half-move gave checkmate: the rules look for mate first.
    if (position.half >= 100) return position.inCheck() && !hasLegalMove(position) ? -MATE + ply : 0
    const oldest = Math.max(0, at - position.half)
    for (let i = at - 2; i >= oldest; i -= 2) if (pathLo[i] === position.lo && pathHi[i] === position.hi) return 0
  }
  const checked = position.attacked(position.king[us]!, them)
  if (checked) depth++
  if (depth <= 0) return quiesce(alpha, beta, ply)
  if (ply >= MAX_PLY - 1) return evaluate(position)

  const slot = position.lo & TT_MASK
  let first = 0
  if (ttFlag[slot] && ttLo[slot] === position.lo && ttHi[slot] === position.hi) {
    first = ttMove[slot]!
    if (ply > 0 && ttDepth[slot]! >= depth) {
      let score = ttScore[slot]!
      if (score > MATE_BOUND) score -= ply; else if (score < -MATE_BOUND) score += ply
      const flag = ttFlag[slot]
      if (flag === EXACT || (flag === LOWER && score >= beta) || (flag === UPPER && score <= alpha)) return score
    }
  }

  if (allowNull && !checked && depth >= 3 && beta < MATE_BOUND && hasPieces(position, us) && evaluate(position) >= beta) {
    position.makeNull()
    const score = -search(depth - 3, -beta, -beta + 1, ply + 1, false)
    position.unmakeNull()
    if (stopped) return 0
    if (score >= beta) return beta
  }

  const moves = MOVES[ply]!, order = ORDER[ply]!
  const count = generate(position, moves, false)
  const killerA = killers[ply * 2]!, killerB = killers[ply * 2 + 1]!
  for (let i = 0; i < count; i++) {
    const move = moves[i]!, to = (move >> 7) & 127, victim = board[to]! & 7
    if (move === first) order[i] = 1 << 30
    else if (victim || move >> 17 === EN_PASSANT) order[i] = 2_000_000 + ((victim || PAWN) << 8) - (board[move & 127]! & 7)
    else if ((move >> 14) & 7) order[i] = 1_900_000 + ((move >> 14) & 7)
    else if (move === killerA) order[i] = 1_800_000
    else if (move === killerB) order[i] = 1_700_000
    else order[i] = Math.min(history[(us << 14) | (move & 16383)]!, 1_600_000)
  }

  const startAlpha = alpha
  let best = -INFINITE, bestMove = 0, played = 0
  for (let i = 0; i < count; i++) {
    let pick = i
    for (let j = i + 1; j < count; j++) if (order[j]! > order[pick]!) pick = j
    const move = moves[pick]!
    moves[pick] = moves[i]!; order[pick] = order[i]!; moves[i] = move
    const quiet = !board[(move >> 7) & 127] && move >> 17 !== EN_PASSANT && !((move >> 14) & 7)
    position.make(move)
    if (position.attacked(position.king[us]!, them)) { position.unmake(move); continue }
    played++
    let score: number
    if (played === 1) score = -search(depth - 1, -beta, -alpha, ply + 1, true)
    else {
      let less = 0
      if (depth >= 3 && played > 3 && quiet && !checked && !position.attacked(position.king[them]!, us)) less = played > 8 ? 2 : 1
      score = -search(depth - 1 - less, -alpha - 1, -alpha, ply + 1, true)
      if (score > alpha && (less > 0 || score < beta)) score = -search(depth - 1, -beta, -alpha, ply + 1, true)
    }
    position.unmake(move)
    if (stopped) return 0
    if (score > best) {
      best = score; bestMove = move
      if (score > alpha) {
        alpha = score
        if (alpha >= beta) {
          if (quiet) {
            if (killers[ply * 2] !== move) { killers[ply * 2 + 1] = killers[ply * 2]!; killers[ply * 2] = move }
            history[(us << 14) | (move & 16383)]! += depth * depth
          }
          break
        }
      }
    }
  }
  if (!played) return checked ? -MATE + ply : 0

  let stored = best
  if (stored > MATE_BOUND) stored += ply; else if (stored < -MATE_BOUND) stored -= ply
  ttLo[slot] = position.lo; ttHi[slot] = position.hi; ttMove[slot] = bestMove; ttScore[slot] = stored; ttDepth[slot] = Math.min(depth, 127)
  ttFlag[slot] = best >= beta ? LOWER : best > startAlpha ? EXACT : UPPER
  return best
}

function prepare(position: Position, seen: string[], limit: number, until: number): void {
  thinking = position
  ttFlag.fill(0); killers.fill(0); history.fill(0)
  const earlier = seen.slice(-400, -1)
  pathBase = earlier.length
  earlier.forEach((key, index) => { pathLo[index] = parseInt(key.slice(0, 8), 16) | 0; pathHi[index] = parseInt(key.slice(8, 16), 16) | 0 })
  nodes = 0; nodeLimit = limit; stopped = false
  deadline = until
}

function shuffle(moves: number[], random: () => number): void {
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)))
    const swap = moves[i]!; moves[i] = moves[j]!; moves[j] = swap
  }
}

/** Does `move` give the other side a checkmate on its next turn? */
function permitsMateInOne(position: Position, move: number): boolean {
  position.make(move)
  const replies = legalList(position)
  let mate = false
  for (const reply of replies) {
    position.make(reply)
    mate = position.inCheck() && !hasLegalMove(position)
    position.unmake(reply)
    if (mate) break
  }
  position.unmake(move)
  return mate
}

/**
 * Look a fixed number of moves ahead and pick the best after adding up to `noise` hundredths of
 * a pawn of luck to each candidate. A move that loses more than `noise` against the best is
 * never picked, so mate in one is always seen and always avoided when it can be.
 */
function pickWithNoise(position: Position, root: number[], depth: number, noise: number, random: () => number): number {
  let bestRaw = -INFINITE
  const candidates: { move: number; raw: number; noisy: number }[] = []
  for (const move of root) {
    const floor = bestRaw === -INFINITE ? -INFINITE : bestRaw - noise
    position.make(move)
    const raw = -search(depth - 1, -INFINITE, -floor, 1, true)
    position.unmake(move)
    if (stopped) break
    const luck = random() * noise
    if (raw <= floor) continue
    if (raw > bestRaw) bestRaw = raw
    candidates.push({ move, raw, noisy: raw + luck })
  }
  let chosen = root[0]!, chosenScore = -INFINITE
  for (const candidate of candidates) if (candidate.raw > bestRaw - noise && candidate.noisy > chosenScore) { chosen = candidate.move; chosenScore = candidate.noisy }
  return chosen
}

/** Look deeper and deeper until the node budget is spent, keeping the best move of the last finished look. */
function pickDeepest(position: Position, root: number[], maxDepth: number): number {
  let chosen = root[0]!
  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -INFINITE, best = 0, bestScore = -INFINITE
    for (let i = 0; i < root.length; i++) {
      const move = root[i]!
      position.make(move)
      let score: number
      if (i === 0) score = -search(depth - 1, -INFINITE, INFINITE, 1, true)
      else {
        score = -search(depth - 1, -alpha - 1, -alpha, 1, true)
        if (!stopped && score > alpha) score = -search(depth - 1, -INFINITE, -alpha, 1, true)
      }
      position.unmake(move)
      if (stopped) break
      if (score > bestScore) { bestScore = score; best = move; if (score > alpha) alpha = score }
    }
    // An interrupted iteration has not compared every root move. Keep the last fully searched
    // answer rather than letting whichever move happened to be searched first replace it.
    if (!stopped && best) {
      chosen = best
      root.splice(root.indexOf(best), 1)
      root.unshift(best)
    }
    lastThought.depth = stopped ? depth - 1 : depth
    if (!stopped && bestScore > -INFINITE) lastThought.score = bestScore
    if (stopped || root.length === 1 || bestScore > MATE_BOUND || bestScore < -MATE_BOUND) break
  }
  return chosen
}

/** Figures from the most recent computer move, for the probe and for tuning. Not part of any game. */
export const lastThought = { depth: 0, nodes: 0, score: 0, book: false }

// A small set of sound opening lines so games do not all start the same way. Common knowledge,
// written out by hand. Keyed by position, so a line reached by another order still counts.
const OPENINGS = [
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6',
  'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 O-O d6',
  'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4',
  'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5',
  'e4 e5 Nc3 Nf6 Bc4 Nc6 d3 Bc5',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6',
  'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7',
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7',
  'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6',
  'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7',
  'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6',
  'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6',
  'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5',
  'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6',
  'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O',
  'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O',
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5',
  'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5',
  'd4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6',
  'd4 d5 Nf3 Nf6 c4 e6 Nc3 c6 e3 Nbd7',
  'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5',
  'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7',
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O',
  'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3',
  'd4 Nf6 Nf3 d5 c4 e6 Nc3 Be7 Bf4 O-O',
  'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5',
  'c4 Nf6 Nc3 e6 Nf3 d5 d4 Be7 Bg5 O-O',
  'c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7',
  'Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O',
  'Nf3 Nf6 c4 g6 Nc3 Bg7 e4 d6 d4 O-O',
  'Nf3 d5 d4 Nf6 c4 e6 Nc3 Be7 Bg5 h6',
]
let book: Map<string, ChessMove[]> | null = null
function openingBook(): Map<string, ChessMove[]> {
  if (book) return book
  book = new Map()
  for (const line of OPENINGS) {
    let state = fromFen(START_FEN)
    for (const san of line.split(' ')) {
      const move = moveFromSan(state, san)
      if (!move) break
      const key = state.seen[state.seen.length - 1]!, known = book.get(key)
      if (known) known.push(move); else book.set(key, [move])
      state = play(state, move)
    }
  }
  return book
}
/** Every opening line as written, for the probe to check each move is legal. */
export const openingLines = (): readonly string[] => OPENINGS

/** Rough node budgets. Level 3's is what fits well inside 400 ms on a phone four times slower than a laptop. */
const LEVEL_NODES = { 1: 20_000, 2: 60_000, 3: 150_000 } as const
const GUARD_MS = 330

function computerMove(state: ChessState, level: 1 | 2 | 3, random: () => number): ChessMove {
  // The clock is only a guard for a very slow device; it starts when the move is asked for, so the one-off work of a first call counts too.
  const until = Date.now() + GUARD_MS
  const position = load(state), root = legalList(position)
  if (!root.length) throw new RulesError('This game is over.')
  lastThought.depth = 0; lastThought.nodes = 0; lastThought.score = 0; lastThought.book = false
  if (root.length === 1) return toMove(root[0]!)

  // Opening variety: level 3 follows the book as far as it goes, level 2 for its first two moves.
  if (level >= 2 && state.san.length < (level === 3 ? 20 : 4)) {
    const lines = openingBook().get(state.seen[state.seen.length - 1]!)
    if (lines?.length) {
      const pick = lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))]!
      if (findMove(position, pick, root) !== undefined) { lastThought.book = true; return pick }
    }
  }

  if (level === 1) {
    // The beginner may misjudge material, but it never ignores a mate in one when any move stops
    // it. Keep this promise independent of a node-budget interruption in the shallow search.
    const safe = root.filter(move => !permitsMateInOne(position, move))
    if (safe.length) { root.length = 0; root.push(...safe) }
  }
  shuffle(root, random)
  prepare(position, state.seen, LEVEL_NODES[level], until)
  let chosen: number
  if (level === 1) {
    // A beginner: sees one move and the reply, misjudges by up to a pawn and a half, and about one
    // move in seven has a lapse worth up to three pawns. Both stay under the worth of a piece, so
    // a piece left for nothing is always taken and a mate in one is always seen.
    const lapse = random() < 0.14
    chosen = pickWithNoise(position, root, 2, lapse ? 300 : 150, random)
    lastThought.depth = 2
  } else if (level === 2) {
    // A club novice: three moves ahead (four once most pieces are gone), with a little luck so games differ.
    let pieces = 0
    for (const char of state.board) if ('nbrqNBRQ'.includes(char)) pieces++
    const depth = pieces <= 6 ? 4 : 3
    chosen = pickWithNoise(position, root, depth, 24, random)
    lastThought.depth = depth
  } else chosen = pickDeepest(position, root, 32)
  lastThought.nodes = nodes
  return toMove(chosen)
}

// ── The rules the hall plays by ──────────────────────────────────────────────────────────────

const PROMOTIONS = 'qrbn'

function play(state: ChessState, move: ChessMove): ChessState {
  const position = load(state), legal = legalList(position)
  const found = findMove(position, move, legal)
  if (found === undefined) throw new RulesError(refusal(position, move, legal))
  const san = sanOfMove(position, found, legal)
  const mover: Colour = state.turn
  const victim = found >> 17 === EN_PASSANT ? PAWN : position.board[(found >> 7) & 127]! & 7
  position.make(found)
  const replies = legalList(position), key = keyOf(position, replies)
  const next: ChessState = {
    ...fields(position),
    seen: position.half === 0 ? [key] : [...state.seen, key],
    san: [...state.san, san],
    taken: victim ? { ...state.taken, [mover]: state.taken[mover] + KINDS[victim]! } : state.taken,
    outcome: null,
  }
  next.outcome = judge(position, replies, next.seen)
  return next
}

export const createRules: CreateRules<ChessState, ChessMove, ChessView> = (): Rules<ChessState, ChessMove, ChessView> => ({
  game: 'chess',
  seats: { min: 2, max: 2 },

  start(): ChessState { return fromFen(START_FEN) },

  turn(state): number | null { return state.outcome ? null : state.turn === 'w' ? 0 : 1 },

  parseMove(input): ChessMove {
    const value = input as { from?: unknown; to?: unknown; promotion?: unknown } | null
    if (!value || typeof value !== 'object' || !isSquareName(value.from) || !isSquareName(value.to)) throw new RulesError('That is not a chess move: it needs a square to move from and a square to move to.')
    const move: ChessMove = { from: value.from, to: value.to }
    if (value.promotion !== undefined && value.promotion !== null) {
      if (typeof value.promotion !== 'string' || value.promotion.length !== 1 || !PROMOTIONS.includes(value.promotion)) throw new RulesError('A pawn can become a queen, rook, bishop or knight.')
      move.promotion = value.promotion as PromotionKind
    }
    return move
  },

  apply(state, seat, move): ChessState {
    if (state.outcome) throw new RulesError('This game is over.')
    if (seat !== (state.turn === 'w' ? 0 : 1)) throw new RulesError('It is not your turn.')
    return play(state, move)
  },

  outcome(state): Outcome | null { return state.outcome },

  view(state): ChessView {
    const { board, turn, castling, ep, halfmove, fullmove, san, taken, outcome } = state
    return { board, turn, castling, ep, halfmove, fullmove, fen: toFen(state), check: inCheck(state), san, taken, outcome }
  },

  bot(state, seat, level, random): ChessMove {
    if (state.outcome) throw new RulesError('This game is over.')
    if (seat !== (state.turn === 'w' ? 0 : 1)) throw new RulesError('It is not that seat\'s turn.')
    return computerMove(state, level, random)
  },

  describe(state, _seat, move): string { return sanOf(state, move) },

  forfeit(state, seat, reason): ChessState {
    if (state.outcome || (seat !== 0 && seat !== 1)) return state
    const other = seat ^ 1
    const otherCanMate = canMate(state, other === 0 ? 'w' : 'b')
    let outcome: Outcome
    if (reason === 'resigned' && otherCanMate) outcome = win(other, 'resigned', `{${seat}} resigned. The win goes to {${other}}.`)
    else if (reason === 'resigned') outcome = draw('resigned-insufficient-material', `{${seat}} resigned, but {${other}} could never give checkmate. The game is a draw.`)
    else if (reason === 'left') outcome = win(other, 'left', `{${seat}} left the game. The win goes to {${other}}.`)
    // Out of time loses — unless the other side could never give checkmate with what it has, which is a draw.
    else if (otherCanMate) outcome = win(other, 'time', `{${seat}} ran out of time. The win goes to {${other}}.`)
    else outcome = draw('time-insufficient-material', `{${seat}} ran out of time, but there are not enough pieces left for {${other}} to give checkmate. The game is a draw.`)
    return { ...state, outcome }
  },
})
