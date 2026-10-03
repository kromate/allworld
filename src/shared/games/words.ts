// Word Yard — the hall's crossword tile game. Players draw letter tiles and build interlocking
// words on a 13 × 13 board. This file is the whole game: the board, the tiles, what a move is,
// when it is allowed, what it scores, when the game ends, what each seat may see, and the
// computer player. It is pure: no clock, no I/O, state and moves are plain JSON.
//
// The mechanics are the common ones of crossword tile games. The board size, the premium
// layout, the tile counts and the tile values are this game's own (docs/games/WORDS.md says how
// they were derived).
import { RulesError } from '../arena.ts'
import type { CreateRules, Outcome, Rules, RulesEnv } from '../arena.ts'

export const NAME = 'Word Yard'
export const SIZE = 13
export const CELLS = SIZE * SIZE
export const CENTRE = (CELLS - 1) / 2
export const RACK = 7
/** Extra points for playing all seven tiles of a rack in one turn. */
export const WHOLE_RACK_BONUS = 60
/** Swapping is allowed only while the bag holds at least this many tiles. */
export const EXCHANGE_MIN = RACK
/** The game ends when every player still in has had this many turns in a row with no score. */
export const SCORELESS_ROUNDS = 2
export const BLANKS = 2
export const BLANK = '?'
const EMPTY = '.'
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// Tiles per letter and points per letter, A to Z. Derived from how often each letter occurs in
// the 2- to 8-letter words of the word list (service/arena/words/tiles.ts holds the method and
// scripts/verify-game-words.ts re-derives these two rows from the list and compares).
export const COUNTS: readonly number[] = [7, 2, 3, 4, 11, 1, 3, 2, 7, 1, 1, 5, 2, 5, 5, 3, 1, 7, 4, 5, 3, 1, 1, 1, 2, 1]
export const VALUES: readonly number[] = [2, 5, 4, 3, 1, 5, 4, 4, 2, 9, 6, 3, 4, 3, 2, 4, 10, 2, 2, 3, 4, 6, 6, 9, 5, 8]
export const TILE_TOTAL = COUNTS.reduce((sum, count) => sum + count, 0) + BLANKS

/** Points printed on a tile: a rack letter 'A'–'Z', a blank '?', or a board square (lower case is a blank). */
export function tileValue(tile: string): number {
  const code = tile.charCodeAt(0)
  return code >= 65 && code <= 90 ? VALUES[code - 65]! : 0
}

// ── The board ─────────────────────────────────────────────────────────────────────────────────

export type Premium = '' | '2L' | '3L' | '2W' | '3W'
export const PREMIUM_NAMES: Record<Exclude<Premium, ''>, string> = { '2L': 'double letter', '3L': 'triple letter', '2W': 'double word', '3W': 'triple word' }

// One eighth of the board, folded onto its corner; the rest is its mirror images. Keys are
// "nearer edge distance, farther edge distance".
const FOLDED: Record<string, Premium> = {
  '0,2': '3W',
  '1,4': '2W', '3,3': '2W',
  '1,1': '3L', '4,4': '3L', '2,6': '3L',
  '2,3': '2L', '3,6': '2L', '5,5': '2L', '0,6': '2L',
}
export const PREMIUMS: readonly Premium[] = Array.from({ length: CELLS }, (_, at) => {
  const row = Math.floor(at / SIZE), col = at % SIZE
  const a = Math.min(row, SIZE - 1 - row), b = Math.min(col, SIZE - 1 - col)
  return FOLDED[`${Math.min(a, b)},${Math.max(a, b)}`] ?? ''
})
const LETTER_TIMES: Record<Premium, number> = { '': 1, '2L': 2, '3L': 3, '2W': 1, '3W': 1 }
const WORD_TIMES: Record<Premium, number> = { '': 1, '2L': 1, '3L': 1, '2W': 2, '3W': 3 }

/** "F7": columns A–M left to right, rows 1–13 top to bottom. */
export const cellName = (at: number): string => `${LETTERS[at % SIZE]}${Math.floor(at / SIZE) + 1}`
const EMPTY_BOARD = EMPTY.repeat(CELLS)
const isEmptyBoard = (board: string): boolean => board === EMPTY_BOARD

// ── Moves and state ───────────────────────────────────────────────────────────────────────────

/** One tile going onto the board. `letter` is what it reads as; `blank` when a blank tile is used for it. */
export interface Placement { at: number; letter: string; blank?: boolean }

export type WordsMove =
  | { kind: 'place'; tiles: Placement[] }
  /** Rack tiles to put back in the bag ('?' for a blank), for the same number of new ones. */
  | { kind: 'exchange'; tiles: string }
  | { kind: 'pass' }

export interface LastPlay {
  seat: number
  kind: 'place' | 'exchange' | 'pass'
  /** Squares covered by a placement (empty otherwise). */
  cells: number[]
  /** Words made, main word first. */
  words: string[]
  score: number
  /** True when all seven tiles were played. */
  wholeRack: boolean
  /** Tiles swapped (never which ones). */
  swapped: number
  /** True when there was no word list to check the words against. */
  unchecked: boolean
}

export interface WordsState {
  /** 169 characters, row by row: '.' empty, 'A'–'Z' a letter tile, 'a'–'z' a blank played as that letter. */
  board: string
  /** Tiles still to be drawn, in order; the next tile is the last character. Never shown to anyone. */
  bag: string
  racks: string[]
  scores: number[]
  turn: number
  /** Seats that resigned, ran out of time or left. */
  out: boolean[]
  /** Turns in a row that scored nothing. */
  scoreless: number
  turns: number
  last: LastPlay | null
  over: Outcome | null
}

export interface WordsView {
  board: string
  /** The viewer's own rack; null for someone watching. */
  rack: string | null
  rackCounts: number[]
  scores: number[]
  /** How many tiles are in the bag. */
  bag: number
  /** Tiles the viewer cannot see (the bag and the other racks together), counted per letter; '?' is a blank. */
  unseen: Record<string, number>
  turn: number | null
  out: boolean[]
  last: LastPlay | null
  canExchange: boolean
  /** Scoreless turns left before the game ends. */
  scorelessLeft: number
  /** Which word list checks the words: the full one (the hall), the short practice one, or none. */
  list: 'full' | 'practice' | 'unchecked'
  /** Reserved for UI compatibility. Rack letters stay private after the game, so this is always null. */
  finalRacks: string[] | null
  outcome: Outcome | null
}

// ── Reading a placement: the words it makes and what they score ───────────────────────────────

export interface FormedWord { word: string; cells: number[]; score: number }
export type Reading =
  | { ok: true; across: boolean; start: number; words: FormedWord[]; score: number; wholeRack: boolean }
  | { ok: false; problem: string }

const refuse = (problem: string): Reading => ({ ok: false, problem })

/**
 * Check where the tiles sit and work out the words and the score. Says nothing about whether
 * the words are real words: that is the word list's job, and only the service has it.
 */
export function readPlacement(board: string, tiles: readonly Placement[]): Reading {
  if (!tiles.length) return refuse('Put at least one tile on the board.')
  if (tiles.length > RACK) return refuse('That is more tiles than a rack holds.')
  const placed = new Map<number, Placement>()
  for (const tile of tiles) {
    if (board[tile.at] !== EMPTY) return refuse(`${cellName(tile.at)} already has a tile.`)
    if (placed.has(tile.at)) return refuse('Two tiles are on the same square.')
    placed.set(tile.at, tile)
  }
  const filled = (at: number): boolean => placed.has(at) || board[at] !== EMPTY
  const row = (at: number): number => Math.floor(at / SIZE)
  /** The unbroken run of tiles through `at`, along a row (step 1) or a column (step SIZE). */
  const run = (at: number, step: number): number[] => {
    const inLine = (from: number, to: number): boolean => to >= 0 && to < CELLS && (step === SIZE || row(from) === row(to))
    let first = at
    while (inLine(first, first - step) && filled(first - step)) first -= step
    const cells = [first]
    while (inLine(first, cells[cells.length - 1]! + step) && filled(cells[cells.length - 1]! + step)) cells.push(cells[cells.length - 1]! + step)
    return cells
  }

  const first = tiles[0]!.at
  const sameRow = tiles.every(tile => row(tile.at) === row(first))
  const sameColumn = tiles.every(tile => tile.at % SIZE === first % SIZE)
  if (!sameRow && !sameColumn) return refuse('Tiles go in one row or one column.')
  // One tile reads along whichever way it joins something.
  const across = tiles.length > 1 ? sameRow : run(first, 1).length > 1 || run(first, SIZE).length === 1
  const main = run(first, across ? 1 : SIZE)
  if (tiles.some(tile => !main.includes(tile.at))) return refuse('Tiles must make one unbroken word: no gaps.')

  if (isEmptyBoard(board)) {
    if (!placed.has(CENTRE)) return refuse('The first word must cover the centre square.')
    if (tiles.length < 2) return refuse('The first word needs at least two tiles.')
  }

  const words: FormedWord[] = []
  const add = (cells: number[]): void => {
    let word = '', sum = 0, times = 1
    for (const at of cells) {
      const tile = placed.get(at)
      if (tile) {
        const premium = PREMIUMS[at]!
        word += tile.letter
        sum += (tile.blank ? 0 : tileValue(tile.letter)) * LETTER_TIMES[premium]
        times *= WORD_TIMES[premium]
      } else {
        word += board[at]!.toUpperCase()
        sum += tileValue(board[at]!)
      }
    }
    words.push({ word, cells, score: sum * times })
  }
  if (main.length > 1) add(main)
  for (const tile of tiles) {
    const cross = run(tile.at, across ? SIZE : 1)
    if (cross.length > 1) add(cross)
  }
  const joins = main.length > tiles.length || words.length > 1
  if (!isEmptyBoard(board) && !joins) return refuse('New tiles must join a word already on the board.')
  if (!words.length) return refuse('A word needs at least two letters.')

  const wholeRack = tiles.length === RACK
  const score = words.reduce((sum, word) => sum + word.score, 0) + (wholeRack ? WHOLE_RACK_BONUS : 0)
  return { ok: true, across, start: main[0]!, words, score, wholeRack }
}

// ── The word list as a graph ──────────────────────────────────────────────────────────────────

/**
 * A word list packed as a minimal word graph (a DAWG): shared beginnings and shared endings are
 * stored once. A whole English list fits in about a megabyte, a lookup is a walk of one step per
 * letter, and the computer player can explore "what could follow these letters" without scanning.
 */
export interface Lexicon {
  readonly words: number
  readonly nodes: number
  readonly edges: number
  readonly root: number
  /** The node after `letter` (0 = A … 25 = Z) from `node`, or -1 when no word continues that way. */
  next(node: number, letter: number): number
  /** True when the letters walked so far are a word. */
  accepts(node: number): boolean
  isWord(word: string): boolean
}

/** Build the graph from a list of words (A–Z, any case). Anything else in the list is skipped. */
export function buildLexicon(list: readonly string[]): Lexicon {
  let sorted = true
  const upper = list.map(word => word.toUpperCase())
  for (let i = 1; i < upper.length && sorted; i++) if (upper[i - 1]! >= upper[i]!) sorted = false
  const input = sorted ? upper : [...new Set(upper)].sort()

  // A plain letter tree first. Words arrive in order, so a word's path either follows the newest
  // child of a node or starts a new one.
  const letter: number[] = [0], firstChild: number[] = [-1], nextSibling: number[] = [-1], lastChild: number[] = [-1], ends: number[] = [0]
  let words = 0
  for (const word of input) {
    if (!/^[A-Z]+$/.test(word)) continue
    let node = 0
    for (let i = 0; i < word.length; i++) {
      const code = word.charCodeAt(i) - 65
      const newest = lastChild[node]!
      if (newest !== -1 && letter[newest] === code) { node = newest; continue }
      const id = letter.length
      letter.push(code); firstChild.push(-1); nextSibling.push(-1); lastChild.push(-1); ends.push(0)
      if (newest === -1) firstChild[node] = id; else nextSibling[newest] = id
      lastChild[node] = id
      node = id
    }
    if (!ends[node]) { ends[node] = 1; words++ }
  }

  // Then merge every pair of nodes with the same continuations. Children are made after their
  // parents, so walking backwards meets every child before its parent.
  const total = letter.length
  const merged = new Int32Array(total)
  const keepers: number[] = []
  const seen = new Map<string, number>()
  let edgeCount = 0
  for (let node = total - 1; node >= 0; node--) {
    let key = ends[node] ? '!' : ''
    for (let child = firstChild[node]!; child !== -1; child = nextSibling[child]!) key += String.fromCharCode(97 + letter[child]!) + merged[child]
    let id = seen.get(key)
    if (id === undefined) {
      id = keepers.length
      keepers.push(node)
      seen.set(key, id)
      for (let child = firstChild[node]!; child !== -1; child = nextSibling[child]!) edgeCount++
    }
    merged[node] = id
  }

  const nodes = keepers.length
  const firstEdge = new Int32Array(nodes + 1)
  const edgeLetter = new Uint8Array(edgeCount)
  const edgeTo = new Int32Array(edgeCount)
  const accept = new Uint8Array(nodes)
  let edge = 0
  for (let id = 0; id < nodes; id++) {
    const node = keepers[id]!
    firstEdge[id] = edge
    accept[id] = ends[node]!
    for (let child = firstChild[node]!; child !== -1; child = nextSibling[child]!) { edgeLetter[edge] = letter[child]!; edgeTo[edge] = merged[child]!; edge++ }
  }
  firstEdge[nodes] = edge
  const root = merged[0]!

  const next = (node: number, code: number): number => {
    for (let i = firstEdge[node]!, end = firstEdge[node + 1]!; i < end; i++) {
      const at = edgeLetter[i]!
      if (at === code) return edgeTo[i]!
      if (at > code) return -1
    }
    return -1
  }
  return {
    words, nodes, edges: edgeCount, root, next,
    accepts: node => accept[node] === 1,
    isWord(word) {
      if (!word) return false
      let node = root
      for (let i = 0; i < word.length; i++) {
        const code = word.charCodeAt(i)
        if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) return false
        node = next(node, (code & 31) - 1)
        if (node === -1) return false
      }
      return accept[node] === 1
    },
  }
}

/**
 * What this game asks of its surroundings beyond `RulesEnv.isWord`. The service passes the full
 * list (service/arena/words); the practice board passes a short one; the App in the hall passes
 * nothing, and then the computer player has no words and only passes.
 */
export interface WordsEnv extends RulesEnv {
  /** The word list as a graph, for the computer player. */
  lexicon?: Lexicon
  /** Everyday words only, for the easy computer player. */
  common?: Lexicon
  /** True when `isWord` is the short practice list. */
  practice?: boolean
}

// ── The computer player ───────────────────────────────────────────────────────────────────────

interface Candidate { tiles: Placement[]; score: number; word: string; worth: number }
/** `keep`: how many of the best candidates to hold on to (0 = all of them). `steps` is filled in with the work done. */
interface SearchLimits { maxTiles: number; maxWord: number; budget: number; keep: number; steps?: number }

const better = (a: Candidate, b: Candidate): number => b.worth - a.worth || b.score - a.score
const ALL_LETTERS = (1 << 26) - 1
/** Most steps one search may take: about 40 ms on a laptop, so a phone five times slower stays near 200 ms. */
const SEARCH_BUDGET = 260_000
const VOWELS = new Set([0, 4, 8, 14, 20])
// What a tile is worth keeping for next turn, roughly, in points.
const KEEP: readonly number[] = [0.5, -2.5, -0.5, 0, 2, -2.5, -2.5, 0, -0.5, -3, -2.5, 0.5, -0.5, 1, -1.5, -1, -9, 1.5, 8, 0.5, -3.5, -5.5, -4, 3, -1, 4]
const KEEP_BLANK = 22

/** Rough worth of the tiles left on the rack after a move: good letters, no doubles, vowels and consonants in balance. */
function leaveWorth(have: Int8Array): number {
  let worth = have[26]! * KEEP_BLANK, vowels = 0, consonants = 0
  for (let code = 0; code < 26; code++) {
    const count = have[code]!
    if (!count) continue
    worth += KEEP[code]! + (count - 1) * (KEEP[code]! - 3.5)
    if (VOWELS.has(code)) vowels += count; else consonants += count
  }
  if (have[16]! && !have[20]! && !have[26]!) worth -= 4
  const tiles = vowels + consonants
  if (tiles >= 3) worth -= 1.5 * Math.max(0, Math.abs(vowels * 1.4 - consonants) - 1.5)
  return worth
}

/**
 * Every placement the rack allows, found the standard way: for each row and column, work out
 * which letters each empty square could take given the tiles above and below it, then grow
 * words leftwards and rightwards from the squares next to existing tiles, walking the word
 * graph so only real beginnings are ever tried. `score` is exact. Stops early when it has done
 * `budget` steps, so the time it takes is bounded on any machine.
 */
function findMoves(board: string, rack: string, full: Lexicon, main: Lexicon, limits: SearchLimits, worthOf: (score: number, have: Int8Array, used: number) => number): Candidate[] {
  const cell = new Int8Array(CELLS).fill(-1)
  const worthless = new Uint8Array(CELLS)
  for (let at = 0; at < CELLS; at++) {
    const code = board.charCodeAt(at)
    if (code >= 65 && code <= 90) cell[at] = code - 65
    else if (code >= 97 && code <= 122) { cell[at] = code - 97; worthless[at] = 1 }
  }
  const have = new Int8Array(27)
  for (const tile of rack) have[tile === BLANK ? 26 : tile.charCodeAt(0) - 65]!++
  const empty = isEmptyBoard(board)
  const found: Candidate[] = []
  let steps = 0, floor = -Infinity

  for (const across of empty ? [true] : [true, false]) {
    const index = (line: number, pos: number): number => (across ? line * SIZE + pos : pos * SIZE + line)
    // Per square: the letters it may take (a bit each) and the points of the tiles it would join crossways (-1: none).
    const allowed = new Int32Array(CELLS).fill(ALL_LETTERS)
    const crossSum = new Int16Array(CELLS).fill(-1)
    const anchor = new Uint8Array(CELLS)
    for (let line = 0; line < SIZE; line++) {
      for (let pos = 0; pos < SIZE; pos++) {
        const at = index(line, pos)
        if (cell[at]! >= 0) continue
        let top = line, bottom = line
        while (top > 0 && cell[index(top - 1, pos)]! >= 0) top--
        while (bottom < SIZE - 1 && cell[index(bottom + 1, pos)]! >= 0) bottom++
        const beside = (pos > 0 && cell[index(line, pos - 1)]! >= 0) || (pos < SIZE - 1 && cell[index(line, pos + 1)]! >= 0)
        if (top === line && bottom === line) { if (beside) anchor[at] = 1; continue }
        anchor[at] = 1
        let node = full.root, sum = 0
        for (let l = top; l < line && node !== -1; l++) node = full.next(node, cell[index(l, pos)]!)
        for (let l = top; l <= bottom; l++) if (l !== line && !worthless[index(l, pos)]) sum += VALUES[cell[index(l, pos)]!]!
        let mask = 0
        if (node !== -1) {
          for (let code = 0; code < 26; code++) {
            let walk = full.next(node, code)
            for (let l = line + 1; l <= bottom && walk !== -1; l++) walk = full.next(walk, cell[index(l, pos)]!)
            if (walk !== -1 && full.accepts(walk)) mask |= 1 << code
          }
        }
        allowed[at] = mask
        crossSum[at] = sum
      }
    }
    if (empty) anchor[CENTRE] = 1

    for (let line = 0; line < SIZE; line++) {
      // Tiles being tried on this line: letter code per position, -1 where there is none.
      const tried = new Int8Array(SIZE).fill(-1)
      const triedBlank = new Uint8Array(SIZE)
      const before: number[] = []
      let used = 0, from = 0

      const record = (start: number, end: number): void => {
        if (end - start + 1 > limits.maxWord) return
        // Tiles to the left of the anchor were chosen before their squares were known: seat them now.
        const shift = from - before.length
        for (let i = 0; i < before.length; i++) { tried[shift + i] = before[i]! & 31; triedBlank[shift + i] = before[i]! >> 5 }
        let sum = 0, times = 1, crosses = 0, count = 0
        for (let pos = start; pos <= end; pos++) {
          const at = index(line, pos)
          if (cell[at]! >= 0) { if (!worthless[at]) sum += VALUES[cell[at]!]!; continue }
          const premium = PREMIUMS[at]!
          const points = (triedBlank[pos] === 1 ? 0 : VALUES[tried[pos]!]!) * LETTER_TIMES[premium]
          sum += points
          times *= WORD_TIMES[premium]
          if (crossSum[at]! >= 0) crosses += (crossSum[at]! + points) * WORD_TIMES[premium]
          count++
        }
        const score = sum * times + crosses + (count === RACK ? WHOLE_RACK_BONUS : 0)
        const worth = worthOf(score, have, count)
        if (worth > floor) {
          let word = ''
          const tiles: Placement[] = []
          for (let pos = start; pos <= end; pos++) {
            const at = index(line, pos)
            if (cell[at]! >= 0) { word += LETTERS[cell[at]!]; continue }
            word += LETTERS[tried[pos]!]
            tiles.push(triedBlank[pos] === 1 ? { at, letter: LETTERS[tried[pos]!]!, blank: true } : { at, letter: LETTERS[tried[pos]!]! })
          }
          found.push({ tiles, score, word, worth })
          // Holding on to the best few only: once there are plenty, drop the rest and raise the bar.
          if (limits.keep && found.length >= limits.keep * 4) {
            found.sort(better)
            found.length = limits.keep
            floor = found[limits.keep - 1]!.worth
          }
        }
        for (let i = 0; i < before.length; i++) tried[shift + i] = -1
      }

      const right = (node: number, pos: number, start: number): void => {
        if (++steps > limits.budget) return
        if (pos === SIZE) { if (main.accepts(node) && pos > from) record(start, pos - 1); return }
        const at = index(line, pos)
        if (cell[at]! >= 0) {
          const onward = main.next(node, cell[at]!)
          if (onward !== -1) right(onward, pos + 1, start)
          return
        }
        if (pos > from && main.accepts(node)) record(start, pos - 1)
        if (used >= limits.maxTiles) return
        const mask = allowed[at]!
        for (let code = 0; code < 26; code++) {
          if (!(mask & (1 << code))) continue
          const onward = main.next(node, code)
          if (onward === -1) continue
          if (have[code]) {
            have[code]!--; used++; tried[pos] = code; triedBlank[pos] = 0
            right(onward, pos + 1, start)
            have[code]!++; used--; tried[pos] = -1
          }
          if (have[26]) {
            have[26]!--; used++; tried[pos] = code; triedBlank[pos] = 1
            right(onward, pos + 1, start)
            have[26]!++; used--; tried[pos] = -1
          }
        }
      }

      /** Grow the part of the word that sits left of the anchor, up to `room` tiles, from the rack alone. */
      const left = (node: number, room: number): void => {
        right(node, from, from - before.length)
        if (room === 0 || used >= limits.maxTiles - 1 || steps > limits.budget) return
        for (let code = 0; code < 26; code++) {
          const onward = main.next(node, code)
          if (onward === -1) continue
          if (have[code]) {
            have[code]!--; used++; before.push(code)
            left(onward, room - 1)
            have[code]!++; used--; before.pop()
          }
          if (have[26]) {
            have[26]!--; used++; before.push(code | 32)
            left(onward, room - 1)
            have[26]!++; used--; before.pop()
          }
        }
      }

      let room = 0
      for (let pos = 0; pos < SIZE; pos++) {
        const at = index(line, pos)
        if (cell[at]! >= 0) { room = 0; continue }
        if (!anchor[at]) { room++; continue }
        from = pos
        if (pos > 0 && cell[index(line, pos - 1)]! >= 0) {
          let start = pos - 1
          while (start > 0 && cell[index(line, start - 1)]! >= 0) start--
          let node = main.root
          for (let p = start; p < pos && node !== -1; p++) node = main.next(node, cell[index(line, p)]!)
          if (node !== -1) right(node, pos, start)
        } else {
          left(main.root, room)
        }
        room = 0
        if (steps > limits.budget) break
      }
      if (steps > limits.budget) break
    }
    if (steps > limits.budget) break
  }
  limits.steps = steps
  return found.sort(better)
}

/** Every placement `rack` allows on `board`, with exact scores. For checks and for hints; the computer player uses the same search. */
export function findPlacements(board: string, rack: string, lexicon: Lexicon, budget = 2_000_000): { tiles: Placement[]; score: number; word: string }[] {
  return findMoves(board, rack, lexicon, lexicon, { maxTiles: RACK, maxWord: SIZE, budget, keep: 0 }, score => score)
}

// ── The rules ─────────────────────────────────────────────────────────────────────────────────

/** A small seeded generator: the same seed always gives the same bag. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashOf(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

/** Put tiles back into the bag at places nobody can predict from what they are shown. */
function mixIn(bag: string, tiles: string, salt: number): string {
  const random = seeded(hashOf(bag) ^ salt)
  const list = [...bag]
  for (const tile of tiles) list.splice(Math.floor(random() * (list.length + 1)), 0, tile)
  return list.join('')
}

/** `rack` without `tiles`, or null when the rack does not hold them. */
function without(rack: string, tiles: string): string | null {
  const left = [...rack]
  for (const tile of tiles) {
    const at = left.indexOf(tile)
    if (at === -1) return null
    left.splice(at, 1)
  }
  return left.join('')
}

const rackValue = (rack: string): number => [...rack].reduce((sum, tile) => sum + tileValue(tile), 0)
const listed = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/** Who won, in a sentence. Seats are written "{0}", "{1}" for the hall to name. */
function result(scores: number[], out: boolean[]): { winners: number[]; draw: boolean; text: string } {
  const playing = scores.map((_, seat) => seat).filter(seat => !out[seat])
  const best = Math.max(...playing.map(seat => scores[seat]!))
  const top = playing.filter(seat => scores[seat] === best)
  if (top.length === playing.length && playing.length > 1) return { winners: [], draw: true, text: `It finished level at ${best} each.` }
  if (top.length > 1) return { winners: top, draw: false, text: `${listed(top.map(seat => `{${seat}}`))} shared the win with ${best}.` }
  const winner = top[0]!
  if (scores.length === 2) return { winners: top, draw: false, text: `{${winner}} won ${best} to ${scores[1 - winner]}.` }
  return { winners: top, draw: false, text: `{${winner}} won with ${best}.` }
}

function isPlacement(value: unknown): value is Placement {
  if (typeof value !== 'object' || value === null) return false
  const tile = value as Record<string, unknown>
  return Number.isInteger(tile.at) && (tile.at as number) >= 0 && (tile.at as number) < CELLS
    && typeof tile.letter === 'string' && /^[A-Za-z]$/.test(tile.letter)
    && (tile.blank === undefined || typeof tile.blank === 'boolean')
}

export const createRules: CreateRules<WordsState, WordsMove, WordsView> = (env: WordsEnv) => {
  const nextSeat = (state: WordsState, out: boolean[]): number => {
    let seat = state.turn
    do seat = (seat + 1) % state.racks.length; while (out[seat])
    return seat
  }
  const playing = (out: boolean[]): number => out.filter(gone => !gone).length

  /** Ends the game when the scoreless run is long enough: everyone loses the points left on their rack. */
  function afterScoreless(state: WordsState): WordsState {
    if (state.scoreless < SCORELESS_ROUNDS * playing(state.out)) return state
    const scores = state.scores.map((score, seat) => score - rackValue(state.racks[seat]!))
    const { winners, draw, text } = result(scores, state.out)
    return { ...state, scores, over: { winners, draw, reason: 'scoreless', text: `Nobody scored for ${state.scoreless} turns in a row. ${text}`, scores } }
  }

  function moveOf(state: WordsState, seat: number): void {
    if (state.over) throw new RulesError('This game is over.')
    if (seat !== state.turn) throw new RulesError('It is not your turn.')
  }

  function place(state: WordsState, seat: number, tiles: Placement[]): WordsState {
    const rack = without(state.racks[seat]!, tiles.map(tile => (tile.blank ? BLANK : tile.letter)).join(''))
    if (rack === null) throw new RulesError('Those tiles are not all on your rack.')
    const reading = readPlacement(state.board, tiles)
    if (!reading.ok) throw new RulesError(reading.problem)
    if (env.isWord) {
      const unknown = [...new Set(reading.words.map(word => word.word).filter(word => !env.isWord!(word)))]
      if (unknown.length) throw new RulesError(`${listed(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not in the word list.`)
    }
    const board = [...state.board]
    for (const tile of tiles) board[tile.at] = tile.blank ? tile.letter.toLowerCase() : tile.letter
    const draw = Math.min(tiles.length, state.bag.length)
    const bag = state.bag.slice(0, state.bag.length - draw)
    const racks = state.racks.map((own, index) => (index === seat ? rack + [...state.bag.slice(state.bag.length - draw)].reverse().join('') : own))
    let scores = state.scores.map((score, index) => (index === seat ? score + reading.score : score))
    const last: LastPlay = { seat, kind: 'place', cells: tiles.map(tile => tile.at), words: reading.words.map(word => word.word), score: reading.score, wholeRack: reading.wholeRack, swapped: 0, unchecked: !env.isWord }
    const next: WordsState = { board: board.join(''), bag, racks, scores, turn: nextSeat(state, state.out), out: state.out, scoreless: reading.score > 0 ? 0 : state.scoreless + 1, turns: state.turns + 1, last, over: null }
    if (!racks[seat] && !bag) {
      // Out of tiles: the others lose what is left on their racks and the player who finished gets it.
      const left = racks.map(rackValue)
      const gained = left.reduce((sum, value) => sum + value, 0)
      scores = scores.map((score, index) => (index === seat ? score + gained : score - left[index]!))
      const { winners, draw: level, text } = result(scores, state.out)
      const lead = winners.length === 1 && winners[0] === seat ? `{${seat}} played their last tile and ${text.slice(text.indexOf('}') + 2)}` : `{${seat}} played their last tile. ${text}`
      return { ...next, scores, over: { winners, draw: level, reason: 'out-of-tiles', text: lead, scores } }
    }
    return afterScoreless(next)
  }

  function exchange(state: WordsState, seat: number, tiles: string): WordsState {
    if (state.bag.length < EXCHANGE_MIN) throw new RulesError(`Tiles can be swapped only while the bag holds at least ${EXCHANGE_MIN}.`)
    const kept = without(state.racks[seat]!, tiles)
    if (kept === null) throw new RulesError('Those tiles are not all on your rack.')
    const drawn = [...state.bag.slice(state.bag.length - tiles.length)].reverse().join('')
    const bag = mixIn(state.bag.slice(0, state.bag.length - tiles.length), tiles, state.turns)
    const last: LastPlay = { seat, kind: 'exchange', cells: [], words: [], score: 0, wholeRack: false, swapped: tiles.length, unchecked: false }
    return afterScoreless({ ...state, bag, racks: state.racks.map((own, index) => (index === seat ? kept + drawn : own)), turn: nextSeat(state, state.out), scoreless: state.scoreless + 1, turns: state.turns + 1, last })
  }

  function pass(state: WordsState, seat: number): WordsState {
    const last: LastPlay = { seat, kind: 'pass', cells: [], words: [], score: 0, wholeRack: false, swapped: 0, unchecked: false }
    return afterScoreless({ ...state, turn: nextSeat(state, state.out), scoreless: state.scoreless + 1, turns: state.turns + 1, last })
  }

  function unseen(state: WordsState, seat: number | null): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const tile of LETTERS + BLANK) counts[tile] = 0
    for (const tile of state.bag) counts[tile]!++
    state.racks.forEach((rack, index) => { if (index !== seat) for (const tile of rack) counts[tile]!++ })
    return counts
  }

  function bot(state: WordsState, seat: number, level: 1 | 2 | 3, random: () => number): WordsMove {
    const rack = state.racks[seat] ?? ''
    const full = env.lexicon
    const swap = (tiles: string): WordsMove => (tiles && state.bag.length >= EXCHANGE_MIN ? { kind: 'exchange', tiles } : { kind: 'pass' })
    if (state.over || !rack || !full) return swap(rack)

    // Only what this seat is shown is used: its rack, the board, how many tiles are in the bag,
    // and (in the endgame) the letters it cannot see.
    const hidden = unseen(state, seat)
    const hiddenPoints = Object.entries(hidden).reduce((sum, [tile, count]) => sum + tileValue(tile) * count, 0)
    const bagEmpty = state.bag.length === 0
    const worthOf = (score: number, have: Int8Array, used: number): number => {
      if (level < 3) return score
      if (!bagEmpty) return score + (state.bag.length >= RACK ? leaveWorth(have) : leaveWorth(have) / 2)
      if (used === rack.length) return score + hiddenPoints
      let stuck = 0
      for (let code = 0; code < 26; code++) stuck += have[code]! * VALUES[code]!
      return score - 2 * stuck
    }
    const legal = (candidate: Candidate): boolean => {
      const reading = readPlacement(state.board, candidate.tiles)
      return reading.ok && reading.score === candidate.score && (!env.isWord || reading.words.every(word => env.isWord!(word.word)))
    }

    let found: Candidate[] = []
    if (level === 1) {
      found = findMoves(state.board, rack, full, env.common ?? full, { maxTiles: 4, maxWord: 5, budget: SEARCH_BUDGET / 4, keep: 0 }, worthOf)
      if (!found.length) found = findMoves(state.board, rack, full, full, { maxTiles: 3, maxWord: 4, budget: SEARCH_BUDGET / 4, keep: 0 }, worthOf)
    } else {
      // Two blanks multiply the search many times over, so the second is held back for a later turn
      // (a blank is the best tile to keep anyway). One blank is searched in full within the budget.
      const hand = rack.indexOf(BLANK) !== rack.lastIndexOf(BLANK) ? rack.replace(BLANK, '') : rack
      found = findMoves(state.board, hand, full, full, { maxTiles: RACK, maxWord: SIZE, budget: SEARCH_BUDGET, keep: 48 }, worthOf)
    }

    // Easy: something from the middle of what it found. Medium: one of the better scores. Hard: the best it found.
    let order: Candidate[]
    if (level === 1) {
      const start = Math.floor(found.length * (0.3 + 0.5 * random()))
      order = [...found.slice(start), ...found.slice(0, start).reverse()]
    } else if (level === 2) {
      const good = found.filter(candidate => candidate.score >= found[0]!.score * 0.72).slice(0, 12)
      const pick = Math.floor(random() * good.length)
      order = good.length ? [good[pick]!, ...found] : found
    } else {
      order = found
    }
    for (const candidate of order.slice(0, 40)) if (legal(candidate)) return { kind: 'place', tiles: candidate.tiles }

    // Nothing to play: swap the tiles least worth keeping, or pass when the bag is too low.
    if (level === 1) return swap(rack)
    const doubles = new Set<string>()
    const poor = [...rack].filter(tile => {
      if (tile === BLANK) return false
      const again = doubles.has(tile)
      doubles.add(tile)
      return again || KEEP[tile.charCodeAt(0) - 65]! < (level === 3 ? 0.5 : 5)
    })
    return swap(poor.length ? poor.join('') : rack)
  }

  const rules: Rules<WordsState, WordsMove, WordsView> = {
    game: 'words',
    seats: { min: 2, max: 4 },

    start(seats, seed) {
      if (!Number.isInteger(seats) || seats < 2 || seats > 4) throw new RulesError(`${NAME} is for two to four players.`)
      const tiles: string[] = []
      COUNTS.forEach((count, code) => { for (let i = 0; i < count; i++) tiles.push(LETTERS[code]!) })
      for (let i = 0; i < BLANKS; i++) tiles.push(BLANK)
      const random = seeded(seed)
      for (let i = tiles.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        const held = tiles[i]!
        tiles[i] = tiles[j]!
        tiles[j] = held
      }
      const racks: string[] = []
      for (let seat = 0; seat < seats; seat++) racks.push(tiles.splice(tiles.length - RACK).reverse().join(''))
      return { board: EMPTY_BOARD, bag: tiles.join(''), racks, scores: racks.map(() => 0), turn: 0, out: racks.map(() => false), scoreless: 0, turns: 0, last: null, over: null }
    },

    turn: state => (state.over ? null : state.turn),

    parseMove(input) {
      const bad = (): never => { throw new RulesError('That is not a move in this game.') }
      if (typeof input !== 'object' || input === null) return bad()
      const move = input as Record<string, unknown>
      if (move.kind === 'pass') return { kind: 'pass' }
      if (move.kind === 'exchange') {
        if (typeof move.tiles !== 'string' || !/^[A-Z?]{1,7}$/.test(move.tiles)) return bad()
        return { kind: 'exchange', tiles: move.tiles }
      }
      if (move.kind === 'place') {
        if (!Array.isArray(move.tiles) || move.tiles.length < 1 || move.tiles.length > RACK || !move.tiles.every(isPlacement)) return bad()
        return { kind: 'place', tiles: (move.tiles as Placement[]).map(tile => (tile.blank ? { at: tile.at, letter: tile.letter.toUpperCase(), blank: true } : { at: tile.at, letter: tile.letter.toUpperCase() })) }
      }
      return bad()
    },

    apply(state, seat, move) {
      moveOf(state, seat)
      if (move.kind === 'place') return place(state, seat, move.tiles)
      if (move.kind === 'exchange') return exchange(state, seat, move.tiles)
      return pass(state, seat)
    },

    outcome: state => state.over,

    view(state, seat) {
      const viewer = seat !== null && seat >= 0 && seat < state.racks.length ? seat : null
      return {
        board: state.board,
        rack: viewer === null ? null : state.racks[viewer]!,
        rackCounts: state.racks.map(rack => rack.length),
        scores: state.scores,
        bag: state.bag.length,
        unseen: unseen(state, viewer),
        turn: state.over ? null : state.turn,
        out: state.out,
        last: state.last,
        canExchange: !state.over && state.bag.length >= EXCHANGE_MIN,
        scorelessLeft: Math.max(0, SCORELESS_ROUNDS * playing(state.out) - state.scoreless),
        list: !env.isWord ? 'unchecked' : env.practice ? 'practice' : 'full',
        finalRacks: null,
        outcome: state.over,
      }
    },

    bot,

    describe(state, _seat, move) {
      if (move.kind === 'pass') return 'Passed'
      if (move.kind === 'exchange') return `Swapped ${move.tiles.length} ${move.tiles.length === 1 ? 'tile' : 'tiles'}`
      const reading = readPlacement(state.board, move.tiles)
      if (!reading.ok) return `Placed ${move.tiles.length} ${move.tiles.length === 1 ? 'tile' : 'tiles'}`
      const others = reading.words.length - 1
      return `${reading.words[0]!.word} at ${cellName(reading.start)} ${reading.across ? 'across' : 'down'} for ${reading.score}`
        + (others > 0 ? ` (with ${listed(reading.words.slice(1).map(word => word.word))})` : '')
        + (reading.wholeRack ? ' — all seven tiles' : '')
    },

    forfeit(state, seat, reason) {
      if (state.over || state.out[seat] !== false) return state
      const out = state.out.map((gone, index) => gone || index === seat)
      const why = reason === 'resigned' ? `{${seat}} resigned.` : reason === 'time' ? `{${seat}} ran out of time.` : `{${seat}} left the game.`
      const left = out.map((gone, index) => (gone ? -1 : index)).filter(index => index !== -1)
      if (left.length <= 1) {
        // One player left: they win, whatever the scores were. Nothing is taken off for racks.
        const text = left.length ? `${why} {${left[0]}} won.` : why
        return { ...state, out, over: { winners: left, draw: false, reason, text, scores: state.scores } }
      }
      // More than two were playing: the seat sits out, its tiles go back in the bag, the rest play on.
      const bag = mixIn(state.bag, state.racks[seat]!, state.turns + 7919)
      const next: WordsState = { ...state, out, bag, racks: state.racks.map((rack, index) => (index === seat ? '' : rack)) }
      return afterScoreless(state.turn === seat ? { ...next, turn: nextSeat(state, out) } : next)
    },
  }
  return rules
}

/** For the practice board: a short list of everyday words, so it can check words with no service. */
export async function labEnv(): Promise<RulesEnv> {
  const { EVERYDAY_WORDS, MORE_WORDS } = await import('./words-practice.ts')
  const everyday = EVERYDAY_WORDS.split(' ')
  const lexicon = buildLexicon([...everyday, ...MORE_WORDS.split(' ')])
  const env: WordsEnv = { isWord: word => lexicon.isWord(word), lexicon, common: buildLexicon(everyday), practice: true }
  return env
}
