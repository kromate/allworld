// The word list Word Yard checks words against, and what the hall hands to the game's rules.
//
// The list is ENABLE (public domain; SOURCES.txt), cut to the 2- to 13-letter words that fit the
// board, with a short blocklist of slurs removed (blocklist.ts). It is shipped as gzipped text
// (415 KB) and unpacked once, on first use, into a word graph of about one megabyte: a lookup is
// one step per letter, and the computer player explores the same graph to find its moves.
// The App never downloads this list.
import { wordListBytes } from './bundled.ts'
import { gunzipSync } from 'node:zlib'
import { buildLexicon } from '../../../src/shared/games/words.ts'
import type { Lexicon, WordsEnv } from '../../../src/shared/games/words.ts'

/** Shown wherever the list is credited. */
export const WORD_LIST_CREDIT = 'Word list: ENABLE (Enhanced North American Benchmark Lexicon), public domain, originated by Alan Beale and M. Cooper.'

const read = (file: 'enable.txt.gz' | 'everyday.txt.gz'): string[] => gunzipSync(wordListBytes(file)).toString('latin1').split('\n').filter(Boolean)

let full: Lexicon | null = null
let everyday: Lexicon | null = null
/** How long the list took to unpack and build, for the probe. */
export let loadedInMs = 0

/** The full list as a word graph. Built the first time anything asks. */
export function lexicon(): Lexicon {
  if (!full) {
    const started = performance.now()
    full = buildLexicon(read('enable.txt.gz'))
    loadedInMs = performance.now() - started
  }
  return full
}

/** Everyday words only: what the easy computer player plays from. */
export function everydayLexicon(): Lexicon {
  everyday ??= buildLexicon(read('everyday.txt.gz'))
  return everyday
}

/** Is this an accepted word? Any case; only A–Z. */
export const isWord = (word: string): boolean => lexicon().isWord(word)

/** How many words are accepted. */
export const wordCount = (): number => lexicon().words

/** What the hall passes to every game's `createRules`. Cheap to call: the list loads on first use. */
export function rulesEnv(): WordsEnv {
  return {
    isWord,
    get lexicon() { return lexicon() },
    get common() { return everydayLexicon() },
  }
}
