// The service's bundled games. Each game's pure rules factory receives the same environment.
import { ARENA_GAMES } from '../../src/shared/arena.ts'
import type { ArenaGame, CreateRules, Rules, RulesEnv } from '../../src/shared/arena.ts'
import { createRules as walls } from '../../src/shared/games/walls.ts'
import { createRules as chess } from '../../src/shared/games/chess.ts'
import { createRules as words } from '../../src/shared/games/words.ts'
import { rulesEnv } from './words/index.ts'

const factories = { walls, chess, words } satisfies Record<ArenaGame, CreateRules>

const loaded = new Map<ArenaGame, Rules>()
const problems = new Map<ArenaGame, string>()

// The word graph stays lazy; asking for the environment does not unpack its bytes.
let env: RulesEnv = {}
try {
  env = rulesEnv()
} catch (error) {
  console.error('[arena] the word list could not be loaded; the word game stays closed', error)
}

for (const game of ARENA_GAMES) {
  try {
    const createRules = factories[game]
    // A word game with no word list would accept anything (or nothing): it stays closed instead.
    if (game === 'words' && typeof env.isWord !== 'function') { problems.set(game, 'the word list is not installed'); continue }
    const rules = createRules(env)
    if (rules.game !== game) { problems.set(game, `the rules file describes "${String(rules.game)}"`); continue }
    if (rules.seats.min > 2 || rules.seats.max < 2) { problems.set(game, 'the hall seats two players'); continue }
    loaded.set(game, rules)
  } catch (error) {
    problems.set(game, error instanceof Error ? error.message : String(error))
    console.error(`[arena] the rules for "${game}" could not be loaded; it is listed as coming soon`, error)
  }
}

export const rulesFor = (game: ArenaGame): Rules | null => loaded.get(game) ?? null
export const isAvailable = (game: ArenaGame): boolean => loaded.has(game)
/** Why a game is closed, for the service log and the probe. Never shown to members. */
export const problemWith = (game: ArenaGame): string | null => problems.get(game) ?? null
export const rulesEnvironment = (): RulesEnv => env

/**
 * Checks only: put a rules object in a game's place for this process (the probe plays the hall
 * with a tiny built-in game so it does not depend on which real games have landed). Returns a
 * function that puts back what was there.
 */
export function installRules(game: ArenaGame, rules: Rules | null): () => void {
  const previous = loaded.get(game) ?? null
  if (rules) loaded.set(game, rules); else loaded.delete(game)
  return () => { if (previous) loaded.set(game, previous); else loaded.delete(game) }
}
