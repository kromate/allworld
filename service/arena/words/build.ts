// Builds the word lists Word Yard ships, from the two downloads named in SOURCES.txt.
//
//   node service/arena/words/build.ts <folder holding enable1.txt and scowl-2020.12.07/>
//   node service/arena/words/build.ts --blocked        (print the blocklist in clear)
//
// Writes:
//   service/arena/words/enable.txt.gz      the full list the service checks words against
//   service/arena/words/everyday.txt.gz    everyday words, for the easy computer player
//   src/shared/games/words-practice.ts   the short list the practice board uses
// and prints the tile counts and values derived from the list (see tiles.ts).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { SIZE } from '../../../src/shared/games/words.ts'
import { BLOCKED } from './blocklist.ts'
import { deriveTiles } from './tiles.ts'

const here = import.meta.dirname
const app = join(here, '../../..')
const [source] = process.argv.slice(2)

if (source === '--blocked') {
  console.log([...BLOCKED].join(' '))
  process.exit(0)
}
if (!source) {
  console.error('Give the folder that holds enable1.txt and scowl-2020.12.07/ (see SOURCES.txt).')
  process.exit(1)
}

const raw = readFileSync(join(source, 'enable1.txt'))
const sha = createHash('sha256').update(raw).digest('hex')
const all = raw.toString('utf8').split(/\r?\n/).filter(Boolean)
// A word longer than the board is wide can never be played.
const fits = all.filter(word => /^[a-z]+$/.test(word) && word.length >= 2 && word.length <= SIZE)
const kept = fits.filter(word => !BLOCKED.has(word)).sort()
const inList = new Set(kept)

const scowl = (file: string): string[] => readFileSync(join(source, 'scowl-2020.12.07/final', file), 'latin1').split('\n').filter(word => /^[a-z]+$/.test(word) && inList.has(word))
// SCOWL sorts words by how widely known they are: size 10 is the most everyday, 20 the next.
const everyday = [...new Set([...scowl('english-words.10'), ...scowl('american-words.10')])].sort()
const everydaySet = new Set(everyday)
const twoLetter = kept.filter(word => word.length === 2)
const more = [...new Set([...scowl('english-words.20'), ...scowl('american-words.20'), ...twoLetter])].filter(word => !everydaySet.has(word)).sort()

const gz = (words: string[]): Buffer => gzipSync(words.join('\n') + '\n', { level: 9 })
const full = gz(kept)
writeFileSync(join(here, 'enable.txt.gz'), full)
writeFileSync(join(here, 'everyday.txt.gz'), gz(everyday))
const practice = `// The practice board's word list: ${(everyday.length + more.length).toLocaleString('en')} everyday words — a small part of the full list the hall
// checks against, which only the service holds. Built by service/arena/words/build.ts from the
// ENABLE list (public domain), keeping the words SCOWL ranks as most widely known (sizes 10 and
// 20) and every two-letter word. Licences: service/arena/words/SOURCES.txt. Do not edit by hand.

/** The most everyday words (SCOWL size 10): what the easy computer player plays. */
export const EVERYDAY_WORDS = '${everyday.join(' ').toUpperCase()}'

/** The next most everyday (SCOWL size 20), and every two-letter word in the full list. */
export const MORE_WORDS = '${more.join(' ').toUpperCase()}'
`
writeFileSync(join(app, 'src/shared/games/words-practice.ts'), practice)

const { shares, counts, values } = deriveTiles(kept)
console.log(`source enable1.txt: ${all.length.toLocaleString('en')} entries, ${raw.length.toLocaleString('en')} bytes, sha256 ${sha}`)
console.log(`2 to ${SIZE} letters: ${fits.length.toLocaleString('en')} · blocked: ${fits.length - kept.length} of ${BLOCKED.size} on the blocklist · shipped: ${kept.length.toLocaleString('en')}`)
console.log(`enable.txt.gz ${full.length.toLocaleString('en')} bytes · everyday ${everyday.length.toLocaleString('en')} words · practice ${(everyday.length + more.length).toLocaleString('en')} words, ${practice.length.toLocaleString('en')} bytes (${gzipSync(practice).length.toLocaleString('en')} gzipped)`)
console.log('letter  share   tiles  points')
for (let code = 0; code < 26; code++) console.log(`  ${String.fromCharCode(65 + code)}    ${(shares[code]! * 100).toFixed(2).padStart(5)}%   ${String(counts[code]).padStart(2)}     ${String(values[code]).padStart(2)}`)
console.log(`COUNTS = [${counts.join(', ')}]`)
console.log(`VALUES = [${values.join(', ')}]`)
