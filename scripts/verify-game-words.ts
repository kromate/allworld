// Evidence probe for Word Yard, the hall's crossword tile game: the rules, what each seat is
// shown, the computer player, and the word list. Plain asserts, no service, no network.
// Run: node scripts/verify-game-words.ts
// Prints one PASS line per check and exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RulesError } from '../src/shared/arena.ts'
import {
  BLANK, BLANKS, CELLS, CENTRE, COUNTS, EXCHANGE_MIN, PREMIUMS, RACK, SIZE, TILE_TOTAL, VALUES, WHOLE_RACK_BONUS,
  buildLexicon, cellName, createRules, findPlacements, labEnv, readPlacement, tileValue,
} from '../src/shared/games/words.ts'
import type { Placement, WordsEnv, WordsMove, WordsState } from '../src/shared/games/words.ts'
import { BLOCKED } from '../service/arena/words/blocklist.ts'
import { WORD_LIST_CREDIT, isWord, lexicon, rulesEnv, wordCount } from '../service/arena/words/index.ts'
import * as wordList from '../service/arena/words/index.ts'
import { deriveTiles } from '../service/arena/words/tiles.ts'

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
const note = (text: string): void => console.log(`     ${text}`)

function refused(run: () => unknown, says: RegExp): void {
  try { run() } catch (error) {
    assert.ok(error instanceof RulesError, `expected a RulesError, got ${String(error)}`)
    assert.match(error.message, says)
    return
  }
  assert.fail(`expected a refusal matching ${says}, but the move was allowed`)
}

// ── The word list ─────────────────────────────────────────────────────────────────────────────

const heapBefore = process.memoryUsage()
const startedLoad = performance.now()
const words = wordCount()
const loadMs = performance.now() - startedLoad
const heapAfter = process.memoryUsage()
const env = rulesEnv()
const rules = createRules(env)
const sources = readFileSync(join(import.meta.dirname, '../service/arena/words/SOURCES.txt'), 'utf8')

check('word list: 160,085 words of 2 to 13 letters load once, on first use', () => {
  assert.equal(words, 160_085)
  assert.equal(wordCount(), words)
  assert.ok(wordList.loadedInMs > 0)
  for (const word of ['AA', 'QUIZ', 'quiz', 'ZYZZYVAS', 'HOUSE', 'NEIGHBORHOODS']) assert.ok(isWord(word), `${word} should be a word`)
  for (const word of ['', 'A', 'QZX', 'HOUSEE', 'NEIGHBOURHOODS', 'CAN T', 'ÉTÉ', 'COUNTERREVOLUTIONARY']) assert.ok(!isWord(word), `${word} should not be a word`)
  note(`${words.toLocaleString('en')} words; unpacked and built in ${loadMs.toFixed(0)} ms`)
})

check('word list: it is held as a word graph of about a megabyte, not as 160,000 strings', () => {
  const graph = lexicon()
  const bytes = graph.edges * 5 + graph.nodes * 5
  assert.ok(graph.nodes < 60_000 && graph.edges < 130_000)
  assert.ok(bytes < 1_200_000)
  note(`${graph.nodes.toLocaleString('en')} nodes, ${graph.edges.toLocaleString('en')} edges = ${(bytes / 1024).toFixed(0)} KB of long-lived typed arrays (process measurement immediately after build: array buffers +${((heapAfter.arrayBuffers - heapBefore.arrayBuffers) / 1024).toFixed(0)} KB, resident memory +${((heapAfter.rss - heapBefore.rss) / 1_048_576).toFixed(0)} MB)`)
  const startedLookups = performance.now()
  let hits = 0
  for (let i = 0; i < 1_000_000; i++) if (graph.isWord(i % 2 ? 'QUIZZES' : 'QUIZZEZ')) hits++
  assert.equal(hits, 500_000)
  note(`one million lookups took ${(performance.now() - startedLookups).toFixed(0)} ms`)
})

check('word list: the ENABLE and SCOWL sources, licence statements and credits are on file', () => {
  const line = sources.split('\n').find(text => text.includes('formally released into the Public Domain'))
  assert.ok(line, 'SOURCES.txt quotes the ENABLE statement')
  assert.match(sources, /web\.archive\.org\/web\/20160118193139\/http:\/\/www\.puzzlers\.org\/pub\/wordlists\/enable1\.txt/)
  assert.match(sources, /sha256 3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89/)
  assert.match(sources, /sourceforge\.net\/projects\/wordlist\/files\/SCOWL\/2020\.12\.07/)
  assert.match(sources, /Copyright 2000-2018 by Kevin Atkinson/)
  assert.match(sources, /Permission to use, copy, modify, distribute and sell these word lists, the associated\n\s+scripts, the output created from the scripts, and its documentation for any purpose is\n\s+hereby granted without fee/)
  assert.match(WORD_LIST_CREDIT, /ENABLE.*public domain.*Alan Beale/)
  note(`ENABLE licence: "${line.trim()}"`)
  note('SCOWL 2020.12.07: Copyright 2000-2018 by Kevin Atkinson; permission to use, copy, modify, distribute and sell, with the copyright and permission notices retained.')
  note(WORD_LIST_CREDIT)
})

check('word list: the 147 blocked slurs are refused, and ordinary words near them are not', () => {
  assert.equal(BLOCKED.size, 147)
  for (const word of BLOCKED) assert.ok(!isWord(word), 'a blocked word was accepted')
  for (const word of ['CHINK', 'RETARD', 'QUEER', 'SPIKE', 'JEWEL', 'SQUAWK', 'NIGGLE', 'HOMONYM']) assert.ok(isWord(word), `${word} should still be a word`)
})

check('tiles: the counts and points in the rules are exactly what the documented method derives from the list', () => {
  const all: string[] = []
  const walk = (node: number, prefix: string): void => {
    if (lexicon().accepts(node)) all.push(prefix)
    for (let code = 0; code < 26; code++) { const next = lexicon().next(node, code); if (next !== -1) walk(next, prefix + String.fromCharCode(65 + code)) }
  }
  walk(lexicon().root, '')
  assert.equal(all.length, words, 'walking the graph gives back every word exactly once')
  const derived = deriveTiles(all)
  assert.deepEqual(derived.counts, [...COUNTS])
  assert.deepEqual(derived.values, [...VALUES])
  assert.equal(TILE_TOTAL, 90)
  assert.equal(COUNTS.reduce((sum, count) => sum + count, 0), 88)
  note([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, code) => `${letter}×${COUNTS[code]}=${VALUES[code]}`).join(' ') + ` and ${BLANKS} blanks`)
})

check('board: 13 × 13, 52 premium squares in a pattern of its own, the same from all four sides', () => {
  assert.equal(CELLS, 169)
  assert.equal(PREMIUMS[CENTRE], '')
  const tally: Record<string, number> = {}
  for (const premium of PREMIUMS) tally[premium] = (tally[premium] ?? 0) + 1
  assert.deepEqual(tally, { '': 117, '3W': 8, '2W': 12, '3L': 12, '2L': 20 })
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
    const here = PREMIUMS[row * SIZE + col]
    assert.equal(here, PREMIUMS[col * SIZE + row])
    assert.equal(here, PREMIUMS[row * SIZE + (SIZE - 1 - col)])
    assert.equal(here, PREMIUMS[(SIZE - 1 - row) * SIZE + col])
  }
})

// ── Building positions by hand ────────────────────────────────────────────────────────────────

const at = (name: string): number => (Number(name.slice(1)) - 1) * SIZE + (name.charCodeAt(0) - 65)
/** Tiles for `word` from square `from`; a lower-case letter is a blank played as that letter. */
function tiles(word: string, from: string, way: 'across' | 'down', board = '.'.repeat(CELLS)): Placement[] {
  const placed: Placement[] = []
  let square = at(from)
  for (const letter of word) {
    if (board[square] === '.') placed.push(letter === letter.toLowerCase() ? { at: square, letter: letter.toUpperCase(), blank: true } : { at: square, letter })
    else assert.equal(board[square]!.toUpperCase(), letter.toUpperCase(), `${cellName(square)} holds another letter`)
    square += way === 'across' ? 1 : SIZE
  }
  return placed
}
const place = (word: string, from: string, way: 'across' | 'down', board?: string): WordsMove => ({ kind: 'place', tiles: tiles(word, from, way, board) })
function boardOf(...plays: [word: string, from: string, way: 'across' | 'down'][]): string {
  const board = [...'.'.repeat(CELLS)]
  for (const [word, from, way] of plays) for (const tile of tiles(word, from, way)) board[tile.at] = tile.blank ? tile.letter.toLowerCase() : tile.letter
  return board.join('')
}
function position(board: string, racks: string[], bag: string, turn = 0): WordsState {
  return { board, bag, racks, scores: racks.map(() => 0), turn, out: racks.map(() => false), scoreless: 0, turns: board === '.'.repeat(CELLS) ? 0 : 2, last: null, over: null }
}
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { Object.freeze(value); for (const inner of Object.values(value)) frozen(inner) }
  return value
}
const play = (state: WordsState, seat: number, move: WordsMove): WordsState => rules.apply(frozen(state), seat, rules.parseMove(JSON.parse(JSON.stringify(move))))
const BAG = 'EEEEAAAIIOONNRRTTLLSSDDGG'

// ── Where tiles may go ────────────────────────────────────────────────────────────────────────

check('start: the same seed deals the same bag and racks; another seed deals another; all 90 tiles are there', () => {
  const a = rules.start(2, 20261001), b = rules.start(2, 20261001), c = rules.start(2, 20261002)
  assert.deepEqual(a, b)
  assert.notEqual(a.bag, c.bag)
  for (const seats of [2, 3, 4]) {
    const state = rules.start(seats, 7)
    assert.equal(state.racks.length, seats)
    assert.ok(state.racks.every(rack => rack.length === RACK))
    const census = [...state.bag, ...state.racks.join('')].sort().join('')
    const expected = [...COUNTS.flatMap((count, code) => Array.from({ length: count }, () => String.fromCharCode(65 + code))), ...BLANK.repeat(BLANKS)].sort().join('')
    assert.equal(census, expected)
    assert.equal(state.bag.length, TILE_TOTAL - seats * RACK)
  }
  refused(() => rules.start(1, 1), /two to four/)
  refused(() => rules.start(5, 1), /two to four/)
})

check('first move: must cover the centre square and use at least two tiles', () => {
  const state = position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG)
  refused(() => play(state, 0, place('HOUSE', 'A1', 'across')), /centre square/)
  refused(() => play(state, 0, place('HOUSE', 'H7', 'across')), /centre square/)
  refused(() => play(state, 0, place('A', 'G7', 'across')), /at least two tiles/)
  const next = play(state, 0, place('HOUSE', 'E7', 'across'))
  // No premium square under E7–I7: H4 + O2 + U4 + S2 + E1.
  assert.equal(next.scores[0], 13)
  assert.equal(next.board.slice(at('E7'), at('I7') + 1), 'HOUSE')
  assert.equal(next.turn, 1)
  assert.equal(next.racks[0]!.length, RACK)
  assert.equal(next.bag.length, BAG.length - 5)
  assert.equal(play(state, 0, place('HOUSE', 'G3', 'down')).scores[0], 13 + 4 * 2 + 2, 'down the middle: H on a triple letter at G3, O on a double letter at G4')
})

check('single line: tiles in a bend or on two lines are refused', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'])
  const state = position(board, ['ATANDRE', 'PLANTER'], BAG)
  refused(() => play(state, 0, { kind: 'place', tiles: [{ at: at('E8'), letter: 'A' }, { at: at('F9'), letter: 'T' }] }), /one row or one column/)
  refused(() => play(state, 0, { kind: 'place', tiles: [{ at: at('E8'), letter: 'A' }, { at: at('E9'), letter: 'T' }, { at: at('F9'), letter: 'E' }] }), /one row or one column/)
})

check('gaps: tiles in one line with an empty square between them are refused; a gap filled by a board tile is fine', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'])
  const state = position(board, ['ATANDRE', 'PLANTER'], BAG)
  refused(() => play(state, 0, { kind: 'place', tiles: [{ at: at('E8'), letter: 'A' }, { at: at('G8'), letter: 'T' }] }), /no gaps/)
  // R-U-N down column G: R above the U of HOUSE, N below it.
  const next = play(state, 0, { kind: 'place', tiles: [{ at: at('G6'), letter: 'R' }, { at: at('G8'), letter: 'N' }] })
  assert.deepEqual(next.last!.words, ['RUN'])
  assert.equal(next.scores[0], 2 + 4 + 3)
})

check('adjacency: after the first move new tiles must touch a word on the board', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'])
  const state = position(board, ['ATANDRE', 'PLANTER'], BAG)
  refused(() => play(state, 0, place('TAN', 'A1', 'across')), /join a word/)
  refused(() => play(state, 0, place('TAN', 'E9', 'across')), /join a word/)
  refused(() => play(state, 0, place('A', 'A13', 'across')), /join a word/)
  refused(() => play(state, 0, { kind: 'place', tiles: [{ at: at('E7'), letter: 'A' }] }), /already has a tile/)
  refused(() => play(state, 0, { kind: 'place', tiles: [{ at: at('E8'), letter: 'A' }, { at: at('E8'), letter: 'T' }] }), /same square/)
})

check('cross words: every word made is checked, across and down, and the refusal names the word', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'])
  const state = position(board, ['ATANDRE', 'PLANTER'], BAG)
  // AT under HO would make HA (a word) and OT (not one).
  refused(() => play(state, 0, place('AT', 'E8', 'across')), /^OT is not in the word list\.$/)
  refused(() => play(state, 0, place('TA', 'E8', 'across')), /^HT and OA are not in the word list\.$/)
  refused(() => play(state, 0, place('RDA', 'J7', 'across')), /^HOUSERDA is not in the word list\.$/)
  // AD under HO makes AD, HA and OD: all words. D sits on a double letter (F8).
  const next = play(state, 0, place('AD', 'E8', 'across'))
  assert.deepEqual(next.last!.words, ['AD', 'HA', 'OD'])
  assert.equal(next.scores[0], (2 + 3 * 2) + (4 + 2) + (2 + 3 * 2))
  assert.equal(rules.describe(state, 0, place('AD', 'E8', 'across')), 'AD at E8 across for 22 (with HA and OD)')
})

check('one tile reads along whichever way it joins, and scores both ways when it joins both', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'], ['HAT', 'E7', 'down'])
  const state = position(board, ['ATANDRS', 'PLANTER'], BAG)
  assert.equal(rules.describe(state, 0, place('HOUSES', 'E7', 'across', board)), 'HOUSES at E7 across for 17', 'the new S lands on a double letter at J7')
  assert.equal(rules.describe(state, 0, place('HATS', 'E7', 'down', board)), 'HATS at E7 down for 11')
  // D at F8: OD down and AD across.
  const next = play(state, 0, { kind: 'place', tiles: [{ at: at('F8'), letter: 'D' }] })
  assert.deepEqual([...next.last!.words].sort(), ['AD', 'OD'])
  assert.equal(next.scores[0], (2 + 6) + (2 + 6))
})

// ── What a move scores ────────────────────────────────────────────────────────────────────────

check('premium squares count only for the turn that first covers them', () => {
  const empty = position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG)
  // D7 is a double letter: H counts twice.
  const first = play(empty, 0, place('HOUSE', 'D7', 'across'))
  assert.equal(first.scores[0], 4 * 2 + 2 + 4 + 2 + 1)
  // HAT down from that H: the double letter under H is not counted again.
  const board = first.board
  const second = play(position(board, ['PLANTER', 'ATANDRE'], BAG, 1), 1, place('HAT', 'D7', 'down', board))
  assert.equal(second.scores[1], 4 + 2 + 3)
  // A word multiplier multiplies old tiles too, once: TEAR down column B from B5 covers a double word.
  const wide = boardOf(['HEAR', 'A6', 'across'])
  assert.equal(PREMIUMS[at('B5')], '2W')
  const third = play(position(wide, ['TXRAAAA', 'PLANTER'], BAG), 0, place('TEAR', 'B5', 'down', wide))
  assert.equal(third.scores[0], (3 + 1 + 2 + 2) * 2)
  // Two word multipliers on one word multiply together: B5 and B9 are both double word.
  const tall = boardOf(['HEAR', 'A6', 'across'])
  assert.equal(PREMIUMS[at('B9')], '2W')
  const reading = readPlacement(tall, tiles('TEARS', 'B5', 'down', tall))
  assert.ok(reading.ok && reading.score === (3 + 1 + 2 + 2 + 2) * 4)
})

check(`whole rack: playing all seven tiles adds ${WHOLE_RACK_BONUS}`, () => {
  const state = position('.'.repeat(CELLS), ['PAINTER', 'HOUSEAT'], BAG)
  const next = play(state, 0, place('PAINTER', 'D7', 'across'))
  // P on a double letter (D7), R on a double letter (J7).
  assert.equal(next.scores[0], 4 * 2 + 2 + 2 + 3 + 3 + 1 + 2 * 2 + WHOLE_RACK_BONUS)
  assert.equal(next.last!.wholeRack, true)
  assert.match(rules.describe(state, 0, place('PAINTER', 'D7', 'across')), /^PAINTER at D7 across for 83 — all seven tiles$/)
  const six = play(position('.'.repeat(CELLS), ['PAINTER', 'HOUSEAT'], BAG), 0, place('PAINT', 'E7', 'across'))
  assert.equal(six.last!.wholeRack, false)
})

check('blanks stand for any letter, score nothing, and still pass on a word multiplier', () => {
  const state = position('.'.repeat(CELLS), ['HO?SEAT', 'PLANTER'], BAG)
  const next = play(state, 0, place('HOuSE', 'E7', 'across'))
  assert.equal(next.scores[0], 4 + 2 + 0 + 2 + 1)
  assert.equal(next.board[at('G7')], 'u')
  assert.ok(!next.racks[0]!.slice(0, 2).includes(BLANK))
  // A blank on a double letter is still nothing; the blank must be on the rack.
  const doubled = play(position('.'.repeat(CELLS), ['?OUSEAT', 'PLANTER'], BAG), 0, place('hOUSE', 'D7', 'across'))
  assert.equal(doubled.scores[0], 0 + 2 + 4 + 2 + 1)
  refused(() => play(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG), 0, place('HOuSE', 'E7', 'across')), /not all on your rack/)
  refused(() => play(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG), 0, place('HORSE', 'E7', 'across')), /not all on your rack/)
  assert.equal(tileValue('?'), 0)
  assert.equal(tileValue('q'), 0)
  assert.equal(tileValue('Q'), 10)
})

// ── Swapping, passing, turns ──────────────────────────────────────────────────────────────────

check(`swap: allowed only while the bag holds ${EXCHANGE_MIN} or more; gives back as many tiles; costs the turn`, () => {
  const state = position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], 'ABCDEFG')
  const next = play(state, 0, { kind: 'exchange', tiles: 'HOU' })
  assert.equal(next.racks[0]!.length, RACK)
  assert.equal(next.bag.length, 7)
  assert.equal([...next.racks[0]!, ...next.bag].sort().join(''), [...'HOUSEAT', ...'ABCDEFG'].sort().join(''))
  assert.equal(next.racks[0], 'SEATGFE', 'kept tiles stay, then the next three from the bag')
  assert.equal(next.turn, 1)
  assert.equal(next.scores[0], 0)
  assert.deepEqual(next.last, { seat: 0, kind: 'exchange', cells: [], words: [], score: 0, wholeRack: false, swapped: 3, unchecked: false })
  assert.equal(rules.describe(state, 0, { kind: 'exchange', tiles: 'HOU' }), 'Swapped 3 tiles')
  refused(() => play(state, 0, { kind: 'exchange', tiles: 'ZZ' }), /not all on your rack/)
  refused(() => play(state, 0, { kind: 'exchange', tiles: 'HH' }), /not all on your rack/)
  refused(() => play(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], 'ABCDEF'), 0, { kind: 'exchange', tiles: 'H' }), /at least 7/)
  assert.equal(rules.view(state, 0).canExchange, true)
  assert.equal(rules.view(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], 'ABCDEF'), 0).canExchange, false)
})

check('turns: only the seat to move may move; junk is not a move; the state given is never changed', () => {
  const state = position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG)
  refused(() => play(state, 1, { kind: 'pass' }), /not your turn/)
  for (const junk of [null, 7, 'pass', {}, { kind: 'jump' }, { kind: 'place' }, { kind: 'place', tiles: [] }, { kind: 'place', tiles: [{ at: 169, letter: 'A' }] }, { kind: 'place', tiles: [{ at: 1.5, letter: 'A' }] },
    { kind: 'place', tiles: [{ at: 3, letter: 'AB' }] }, { kind: 'place', tiles: [{ at: 3, letter: '?' }] }, { kind: 'place', tiles: Array.from({ length: 8 }, (_, i) => ({ at: i, letter: 'A' })) },
    { kind: 'exchange' }, { kind: 'exchange', tiles: '' }, { kind: 'exchange', tiles: 'abc' }, { kind: 'exchange', tiles: 'AAAAAAAA' }]) {
    refused(() => rules.parseMove(junk), /not a move/)
  }
  assert.deepEqual(rules.parseMove({ kind: 'place', tiles: [{ at: 84, letter: 'a', blank: true, extra: 1 }], more: 2 }), { kind: 'place', tiles: [{ at: 84, letter: 'A', blank: true }] })
  assert.equal(rules.turn(state), 0)
  assert.equal(rules.outcome(state), null)
})

// ── How the game ends ─────────────────────────────────────────────────────────────────────────

check('end: playing the last tile with the bag empty ends it; the others lose their rack, the finisher gains it', () => {
  const board = boardOf(['HOUSE', 'E7', 'across'])
  const state: WordsState = { ...position(board, ['S', 'QK'], ''), scores: [100, 110] }
  const next = play(state, 0, place('HOUSES', 'E7', 'across', board))
  // HOUSES is 17. Q10 + K6 = 16 left on the other rack.
  assert.deepEqual(next.scores, [100 + 17 + 16, 110 - 16])
  assert.deepEqual(rules.outcome(next), { winners: [0], draw: false, reason: 'out-of-tiles', text: '{0} played their last tile and won 133 to 94.', scores: [133, 94] })
  assert.equal(rules.turn(next), null)
  refused(() => play(next, 1, { kind: 'pass' }), /game is over/)
  assert.equal(rules.view(next, 0).finalRacks, null, 'racks stay private after the game')
  // Going out does not make you the winner if you are still behind.
  const behind = play({ ...state, scores: [10, 110] }, 0, place('HOUSES', 'E7', 'across', board))
  assert.deepEqual(rules.outcome(behind), { winners: [1], draw: false, reason: 'out-of-tiles', text: '{0} played their last tile. {1} won 94 to 43.', scores: [43, 94] })
  // Tiles still in the bag: the game goes on.
  assert.equal(rules.outcome(play({ ...state, bag: 'E' }, 0, place('HOUSES', 'E7', 'across', board))), null)
})

check('end: two scoreless turns each in a row end it, and everyone loses the points left on their rack', () => {
  let state: WordsState = { ...position(boardOf(['HOUSE', 'E7', 'across']), ['QAT', 'KE?'], 'ABCDEFGH'), scores: [50, 30] }
  assert.equal(rules.view(state, 0).scorelessLeft, 4)
  state = play(state, 0, { kind: 'pass' })
  state = play(state, 1, { kind: 'exchange', tiles: 'K' })
  state = play(state, 0, { kind: 'pass' })
  assert.equal(rules.outcome(state), null)
  assert.equal(rules.view(state, 0).scorelessLeft, 1)
  const kept = state.racks[1]!
  state = play(state, 1, { kind: 'pass' })
  const left = [10 + 2 + 3, [...kept].reduce((sum, tile) => sum + tileValue(tile), 0)]
  assert.deepEqual(state.scores, [50 - left[0]!, 30 - left[1]!])
  assert.equal(rules.outcome(state)!.reason, 'scoreless')
  assert.match(rules.outcome(state)!.text, /^Nobody scored for 4 turns in a row\. \{0\} won 35 to \d+\.$/)
  // A scoring turn in between starts the count again.
  let again: WordsState = position(boardOf(['HOUSE', 'E7', 'across']), ['SAT', 'KEG'], 'ABCDEFGH')
  again = play(again, 0, { kind: 'pass' })
  again = play(again, 1, { kind: 'pass' })
  again = play(again, 0, place('HOUSES', 'E7', 'across', again.board))
  again = play(again, 1, { kind: 'pass' })
  again = play(again, 0, { kind: 'pass' })
  again = play(again, 1, { kind: 'pass' })
  assert.equal(rules.outcome(again), null)
  assert.equal(rules.outcome(play(again, 0, { kind: 'pass' }))!.reason, 'scoreless')
  // Level scores are a draw with no winner.
  const level = play({ ...position(boardOf(['HOUSE', 'E7', 'across']), ['A', 'A'], ''), scores: [30, 30], scoreless: 3, turn: 1 }, 1, { kind: 'pass' })
  assert.deepEqual(rules.outcome(level), { winners: [], draw: true, reason: 'scoreless', text: 'Nobody scored for 4 turns in a row. It finished level at 28 each.', scores: [28, 28] })
})

check('resigning, running out of time, leaving: the other player wins; with more seats the rest play on', () => {
  const state: WordsState = { ...position(boardOf(['HOUSE', 'E7', 'across']), ['QAT', 'KEG'], BAG), scores: [90, 20] }
  assert.deepEqual(rules.outcome(rules.forfeit(frozen(state), 0, 'resigned')), { winners: [1], draw: false, reason: 'resigned', text: '{0} resigned. {1} won.', scores: [90, 20] })
  assert.equal(rules.outcome(rules.forfeit(state, 1, 'time'))!.text, '{1} ran out of time. {0} won.')
  assert.equal(rules.outcome(rules.forfeit(state, 1, 'left'))!.text, '{1} left the game. {0} won.')
  const three = rules.start(3, 99)
  const after = rules.forfeit(frozen(three), 0, 'left')
  assert.equal(rules.outcome(after), null)
  assert.equal(rules.turn(after), 1, 'the turn moves on from the seat that left')
  assert.equal(after.racks[0], '')
  assert.equal(after.bag.length, three.bag.length + RACK, 'their tiles go back in the bag')
  assert.equal(rules.turn(play(play(after, 1, { kind: 'pass' }), 2, { kind: 'pass' })), 1, 'and it is skipped from then on')
  const two = rules.forfeit(after, 2, 'time')
  assert.deepEqual(rules.outcome(two)!.winners, [1])
  assert.equal(rules.forfeit(two, 1, 'resigned'), two, 'nothing changes once the game is over')
})

// ── What each seat is shown ───────────────────────────────────────────────────────────────────

/** The same position with every hidden tile dealt differently: what `seat` cannot see is reshuffled among the bag and the other racks. */
function reshuffled(state: WordsState, seat: number | null, salt: number): WordsState {
  const pool = [...state.bag, ...state.racks.flatMap((rack, index) => (index === seat ? [] : [...rack]))]
  let x = salt
  for (let i = pool.length - 1; i > 0; i--) {
    x = (x * 48271) % 2_147_483_647
    const j = x % (i + 1)
    const held = pool[i]!
    pool[i] = pool[j]!
    pool[j] = held
  }
  const racks = state.racks.map((rack, index) => (index === seat ? rack : pool.splice(0, rack.length).join('')))
  return { ...state, racks, bag: pool.join('') }
}

check('hidden: a seat sees its own rack and only counts of everything else; a watcher sees no rack at all', () => {
  let state = rules.start(2, 4242)
  state = play(state, 0, rules.bot(state, 0, 3, () => 0.5))
  state = play(state, 1, { kind: 'exchange', tiles: state.racks[1]!.slice(0, 3) })
  const mine = rules.view(state, 0), theirs = rules.view(state, 1), watching = rules.view(state, null)
  assert.equal(mine.rack, state.racks[0])
  assert.equal(theirs.rack, state.racks[1])
  assert.equal(watching.rack, null)
  assert.equal(rules.view(state, 7).rack, null, 'a seat number that is not in the game is a watcher')
  assert.deepEqual(mine.rackCounts, [7, 7])
  assert.equal(mine.bag, state.bag.length)
  assert.equal(mine.finalRacks, null)
  assert.deepEqual(Object.keys(watching).sort(), ['bag', 'board', 'canExchange', 'finalRacks', 'last', 'list', 'out', 'outcome', 'rack', 'rackCounts', 'scorelessLeft', 'scores', 'turn', 'unseen'])
  for (const [view, rack] of [[mine, state.racks[1]!], [theirs, state.racks[0]!], [watching, state.racks[0]!], [watching, state.racks[1]!]] as const) {
    const text = JSON.stringify(view)
    assert.ok(!text.includes(rack), 'another rack is in the view')
    assert.ok(!text.includes(state.bag), 'the bag order is in the view')
    assert.ok(!text.includes(state.bag.slice(-RACK)), 'the next tiles to be drawn are in the view')
  }
  // The swap is shown as a number of tiles, never as letters.
  assert.deepEqual(mine.last, { seat: 1, kind: 'exchange', cells: [], words: [], score: 0, wholeRack: false, swapped: 3, unchecked: false })
  // Unseen tiles are counted together: the bag and the other racks cannot be told apart.
  const unseenTotal = (view: typeof mine): number => Object.values(view.unseen).reduce((sum, count) => sum + count, 0)
  assert.equal(unseenTotal(mine), state.bag.length + RACK)
  assert.equal(unseenTotal(watching), state.bag.length + 2 * RACK)
})

check('hidden: deal the unseen tiles any other way and what a seat or a watcher is sent is byte-for-byte the same', () => {
  let state = rules.start(3, 77)
  for (let i = 0; i < 9; i++) state = play(state, rules.turn(state)!, rules.bot(state, rules.turn(state)!, 2, () => 0.3))
  for (const viewer of [0, 1, 2, null]) {
    const sent = JSON.stringify(rules.view(state, viewer))
    for (const salt of [11, 222, 3333]) {
      const other = reshuffled(state, viewer, salt)
      assert.notDeepEqual(other, state)
      assert.equal(JSON.stringify(rules.view(other, viewer)), sent)
    }
  }
})

check('hidden: racks and bag order stay hidden after the game ends', () => {
  let state = rules.start(2, 707)
  for (let turn = 0; turn < 4; turn++) state = play(state, rules.turn(state)!, { kind: 'pass' })
  assert.equal(rules.outcome(state)?.reason, 'scoreless')
  for (const viewer of [0, 1, null]) {
    const sent = JSON.stringify(rules.view(state, viewer))
    assert.equal(rules.view(state, viewer).finalRacks, null)
    for (const salt of [13, 131]) assert.equal(JSON.stringify(rules.view(reshuffled(state, viewer, salt), viewer)), sent)
  }
})

check('hidden: the computer player uses only what its seat is shown — reshuffle the unseen tiles and it plays the same move', () => {
  let state = rules.start(2, 31337)
  for (let i = 0; i < 24 && rules.turn(state) !== null; i++) {
    const seat = rules.turn(state)!
    for (const level of [1, 2, 3] as const) {
      const move = JSON.stringify(rules.bot(state, seat, level, () => 0.61))
      for (const salt of [5, 50]) assert.equal(JSON.stringify(rules.bot(reshuffled(state, seat, salt), seat, level, () => 0.61)), move)
    }
    state = play(state, seat, rules.bot(state, seat, 3, () => 0.61))
  }
})

// ── The computer player ───────────────────────────────────────────────────────────────────────

const lab = await labEnv() as WordsEnv

check('practice list: a short everyday subset of the full list, enough to play on the practice board', () => {
  assert.ok(lab.lexicon && lab.common && lab.practice && lab.isWord)
  assert.equal(lab.lexicon.words, 10_881)
  assert.equal(lab.common.words, 3_956)
  const every: string[] = []
  const walk = (node: number, prefix: string): void => {
    if (lab.lexicon!.accepts(node)) every.push(prefix)
    for (let code = 0; code < 26; code++) { const next = lab.lexicon!.next(node, code); if (next !== -1) walk(next, prefix + String.fromCharCode(65 + code)) }
  }
  walk(lab.lexicon.root, '')
  assert.equal(every.length, 10_881)
  assert.ok(every.every(word => isWord(word)), 'every practice word is in the full list')
  assert.equal(every.filter(word => word.length === 2).length, 96, 'every two-letter word is in')
  assert.equal(createRules(lab).view(rules.start(2, 1), 0).list, 'practice')
  assert.equal(rules.view(rules.start(2, 1), 0).list, 'full')
  note(`${lab.lexicon.words.toLocaleString('en')} words (${((lab.lexicon.words / words) * 100).toFixed(1)}% of the full list); the easy computer player draws on ${lab.common.words.toLocaleString('en')}`)
})

check('search: on real positions the move search finds exactly the placements a brute-force scan of the whole list finds', () => {
  const small = lab.lexicon!
  const list: string[] = []
  const walk = (node: number, prefix: string): void => {
    if (small.accepts(node)) list.push(prefix)
    for (let code = 0; code < 26; code++) { const next = small.next(node, code); if (next !== -1) walk(next, prefix + String.fromCharCode(65 + code)) }
  }
  walk(small.root, '')
  const practice = createRules(lab)
  let state = practice.start(2, 808)
  let compared = 0, total = 0
  for (let turn = 0; turn < 12 && practice.turn(state) !== null; turn++) {
    const seat = practice.turn(state)!
    const rack = state.racks[seat]!
    if (!rack.includes(BLANK)) {
      // Brute force: every word, every square, both ways; keep those the rack can make and the rules accept.
      // (On an empty board the search looks across only: the board is the same turned on its side.)
      const expected = new Map<string, number>()
      const ways = state.board === '.'.repeat(CELLS) ? [true] : [true, false]
      for (const word of list) for (const across of ways) for (let line = 0; line < SIZE; line++) for (let from = 0; from + word.length <= SIZE; from++) {
        const left = [...rack]
        const placing: Placement[] = []
        let fits = true
        for (let i = 0; i < word.length && fits; i++) {
          const square = across ? line * SIZE + from + i : (from + i) * SIZE + line
          if (state.board[square] !== '.') { fits = state.board[square]!.toUpperCase() === word[i]; continue }
          const held = left.indexOf(word[i]!)
          if (held === -1) fits = false; else { left.splice(held, 1); placing.push({ at: square, letter: word[i]! }) }
        }
        if (!fits || !placing.length) continue
        const reading = readPlacement(state.board, placing)
        if (!reading.ok || !reading.words.every(made => small.isWord(made.word))) continue
        expected.set(placing.map(tile => `${tile.at}${tile.letter}`).sort().join(' '), reading.score)
      }
      const found = new Map(findPlacements(state.board, rack, small).map(move => [move.tiles.map(tile => `${tile.at}${tile.letter}`).sort().join(' '), move.score]))
      assert.deepEqual([...found.keys()].sort(), [...expected.keys()].sort(), `turn ${turn}: the two sets of placements differ`)
      for (const [key, score] of expected) assert.equal(found.get(key), score, `turn ${turn}: ${key} is scored differently`)
      compared++
      total += expected.size
    }
    state = practice.apply(state, seat, practice.bot(state, seat, 3, () => 0.4))
  }
  assert.ok(compared >= 8)
  note(`${compared} positions, ${total.toLocaleString('en')} placements, same squares and same scores both ways`)
})

const timing: Record<number, { turns: number; total: number; worst: number }> = {}
check('computer player: 60 games against itself at each level and at 2, 3 and 4 seats — never an illegal move, every game ends, the sums add up', () => {
  let seed = 1
  const random = (): number => { seed = (seed * 48271) % 2_147_483_647; return seed / 2_147_483_647 }
  const summary: string[] = []
  for (const level of [1, 2, 3] as const) {
    timing[level] = { turns: 0, total: 0, worst: 0 }
    let games = 0, points = 0, players = 0, placements = 0, swaps = 0, passes = 0, wholeRacks = 0
    const reasons: Record<string, number> = {}
    for (let game = 0; game < 20; game++) {
      const seats = game < 14 ? 2 : game < 17 ? 3 : 4
      let state = rules.start(seats, 5000 + level * 100 + game)
      let turns = 0
      while (rules.turn(state) !== null) {
        const seat = rules.turn(state)!
        const started = performance.now()
        const move = rules.bot(state, seat, level, random)
        const took = performance.now() - started
        timing[level].turns++; timing[level].total += took; timing[level].worst = Math.max(timing[level].worst, took)
        const line = rules.describe(state, seat, move)
        // Any illegal move throws here and fails the check.
        const next = play(state, seat, move)
        if (move.kind === 'place') {
          placements++
          assert.match(line, /^[A-Z]{2,13} at [A-M]\d{1,2} (across|down) for \d+/)
          assert.equal(next.scores[seat]! - state.scores[seat]! >= next.last!.score, true)
          assert.ok(next.last!.words.every(word => isWord(word)))
          if (next.last!.wholeRack) wholeRacks++
        } else if (move.kind === 'exchange') swaps++
        else passes++
        const census = [...next.bag, ...next.racks.join(''), ...next.board.replace(/\./g, '').replace(/[a-z]/g, BLANK)].length
        assert.equal(census, TILE_TOTAL, 'a tile went missing or appeared')
        state = next
        assert.ok(++turns < 400, 'the game did not end')
      }
      const outcome = rules.outcome(state)!
      assert.deepEqual(outcome.scores, state.scores)
      assert.ok(outcome.draw ? outcome.winners.length === 0 : outcome.winners.every(seat => state.scores[seat] === Math.max(...state.scores)))
      reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1
      games++; players += seats; points += state.scores.reduce((sum, score) => sum + score, 0)
    }
    summary.push(`level ${level}: ${games} games, ${placements} words played, ${swaps} swaps, ${passes} passes, ${wholeRacks} whole-rack plays, mean final score ${(points / players).toFixed(0)}, ended ${Object.entries(reasons).map(([reason, count]) => `${reason} ×${count}`).join(', ')}`)
  }
  for (const line of summary) note(line)
})

check('computer player: the harder level wins — hard beats easy over 20 games, and outscores medium', () => {
  let seed = 9
  const random = (): number => { seed = (seed * 48271) % 2_147_483_647; return seed / 2_147_483_647 }
  const match = (a: 1 | 2 | 3, b: 1 | 2 | 3): { wins: number; pointsA: number; pointsB: number } => {
    let wins = 0, pointsA = 0, pointsB = 0
    for (let game = 0; game < 20; game++) {
      let state = rules.start(2, 9000 + game)
      const hardSeat = game % 2
      while (rules.turn(state) !== null) { const seat = rules.turn(state)!; state = rules.apply(state, seat, rules.bot(state, seat, seat === hardSeat ? a : b, random)) }
      if (rules.outcome(state)!.winners.includes(hardSeat)) wins++
      pointsA += state.scores[hardSeat]!; pointsB += state.scores[1 - hardSeat]!
    }
    return { wins, pointsA, pointsB }
  }
  const easy = match(3, 1), medium = match(3, 2), mid = match(2, 1)
  assert.ok(easy.wins >= 18)
  assert.ok(mid.wins >= 16)
  assert.ok(medium.pointsA > medium.pointsB)
  note(`hard v easy ${easy.wins}–${20 - easy.wins} (mean ${(easy.pointsA / 20).toFixed(0)} to ${(easy.pointsB / 20).toFixed(0)}); medium v easy ${mid.wins}–${20 - mid.wins}; hard v medium ${medium.wins}–${20 - medium.wins} (mean ${(medium.pointsA / 20).toFixed(0)} to ${(medium.pointsB / 20).toFixed(0)})`)
})

check('computer player: time per move stays far inside the 400 ms allowed, even holding both blanks on a crowded board', () => {
  for (const level of [1, 2, 3] as const) {
    const { turns, total, worst } = timing[level]!
    assert.ok(worst < 200, `level ${level} took ${worst.toFixed(0)} ms on one move`)
    note(`level ${level}: mean ${(total / turns).toFixed(2)} ms, slowest ${worst.toFixed(1)} ms over ${turns} moves`)
  }
  // The hardest case for the search: both blanks and good letters, mid-game.
  let worst = 0, moves = 0
  for (let game = 0; game < 6; game++) {
    let state = rules.start(2, 600 + game)
    for (let turn = 0; rules.turn(state) !== null; turn++) {
      const seat = rules.turn(state)!
      if (turn >= 4 && turn % 3 === 0) {
        const loaded: WordsState = { ...state, racks: state.racks.map((rack, index) => (index === seat ? '??ERSTA'.slice(0, rack.length) : rack)) }
        const started = performance.now()
        const move = rules.bot(loaded, seat, 3, () => 0.5)
        worst = Math.max(worst, performance.now() - started)
        moves++
        assert.equal(move.kind, 'place')
        rules.apply(loaded, seat, move)
      }
      state = rules.apply(state, seat, rules.bot(state, seat, 2, () => 0.5))
    }
  }
  assert.ok(worst < 300, `two blanks took ${worst.toFixed(0)} ms`)
  note(`both blanks in hand: slowest ${worst.toFixed(1)} ms over ${moves} moves; the search also stops itself after a fixed number of steps, so a slow machine is bounded too`)
})

check('computer player: with nothing to play it swaps while the bag allows and passes when it does not; with no word list it never guesses', () => {
  const stuck = position(boardOf(['HOUSE', 'E7', 'across']), ['VVVVVVV', 'PLANTER'], BAG)
  for (const level of [1, 2, 3] as const) {
    const move = rules.bot(stuck, 0, level, () => 0.5)
    assert.equal(move.kind, 'exchange')
    play(stuck, 0, move)
    assert.deepEqual(rules.bot({ ...stuck, bag: 'ABC' }, 0, level, () => 0.5), { kind: 'pass' })
  }
  const blind = createRules({})
  assert.deepEqual(blind.bot(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], 'ABC'), 0, 3, () => 0.5), { kind: 'pass' })
  assert.equal(blind.bot(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG), 0, 3, () => 0.5).kind, 'exchange')
})

check('no word list (the App on its own): placements are accepted on shape alone and marked unchecked', () => {
  const blind = createRules({})
  const state = position('.'.repeat(CELLS), ['XQZKVWJ', 'PLANTER'], BAG)
  const next = blind.apply(state, 0, { kind: 'place', tiles: tiles('XQZ', 'F7', 'across') })
  assert.equal(next.last!.unchecked, true)
  assert.equal(blind.view(next, 0).list, 'unchecked')
  refused(() => rules.apply(state, 0, { kind: 'place', tiles: tiles('XQZ', 'F7', 'across') }), /^XQZ is not in the word list\.$/)
  refused(() => blind.apply(state, 0, { kind: 'place', tiles: tiles('XQZ', 'A1', 'across') }), /centre square/)
  assert.equal(play(position('.'.repeat(CELLS), ['HOUSEAT', 'PLANTER'], BAG), 0, place('HOUSE', 'E7', 'across')).last!.unchecked, false)
})

if (!failed) console.log('\nAll Word Yard checks passed.')
