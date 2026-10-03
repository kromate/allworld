// How Word Yard's tile counts and tile values are derived from the word list, so they are this
// game's own numbers and can be re-derived by anyone (scripts/verify-game-words.ts does).
//
//   1. Count every letter in the list's 2- to 8-letter words — the words a seven-tile rack
//      actually makes. A letter's share is its count over the total.
//   2. 88 lettered tiles. S is held at 4 (by share it would get 8, and a bag full of plural
//      endings makes every word hookable). The other 84 are shared out by share with the
//      largest-remainder method: every letter gets the whole part of its quota (at least 1),
//      and the tiles left over go to the letters furthest below their quota.
//   3. Points: 1 + 1.5 × log2(share of the commonest letter ÷ share of this letter), rounded,
//      kept between 1 and 10. A letter half as common is worth a point and a half more.
//   4. Two blanks worth nothing make 90 tiles.

export const LETTERED_TILES = 88
export const S_TILES = 4
export const VALUE_STEP = 1.5

export interface DerivedTiles { shares: number[]; counts: number[]; values: number[] }

export function deriveTiles(words: Iterable<string>): DerivedTiles {
  const seen = new Array<number>(26).fill(0)
  let total = 0
  for (const word of words) {
    if (word.length < 2 || word.length > 8) continue
    for (let i = 0; i < word.length; i++) { seen[(word.charCodeAt(i) & 31) - 1]!++; total++ }
  }
  const shares = seen.map(count => count / total)
  const S = 18

  const rest = 1 - shares[S]!
  const quotas = shares.map((share, code) => (code === S ? S_TILES : (share / rest) * (LETTERED_TILES - S_TILES)))
  const counts = quotas.map(quota => Math.max(1, Math.floor(quota)))
  const byRemainder = quotas.map((quota, code) => ({ code, part: quota - counts[code]! })).filter(entry => entry.code !== S).sort((a, b) => b.part - a.part || a.code - b.code)
  let spare = LETTERED_TILES - counts.reduce((sum, count) => sum + count, 0)
  for (let i = 0; spare > 0; i = (i + 1) % byRemainder.length, spare--) counts[byRemainder[i]!.code]!++
  // Giving every letter at least one tile can overshoot: take back from the letters furthest above their quota.
  for (let i = byRemainder.length - 1; spare < 0 && i >= 0; i--) if (counts[byRemainder[i]!.code]! > 1) { counts[byRemainder[i]!.code]!--; spare++ }

  const most = Math.max(...shares)
  const values = shares.map(share => Math.min(10, Math.max(1, Math.round(1 + VALUE_STEP * Math.log2(most / share)))))
  return { shares, counts, values }
}
