# The game hall

Matches between two members or against the computer, with clocks, ratings, watching, chat and
standings. The hall knows no game's rules: a game is three things found by name.

| File | Does |
| --- | --- |
| `ArenaPage.vue`, `ArenaNewMatch.vue`, `ArenaMatchRow.vue`, `ArenaStandings.vue` | The hall: open matches, starting one, standings |
| `ArenaMatch.vue`, `ArenaPlayerBar.vue`, `ArenaChat.vue`, `ArenaSheet.vue` | A match: players and clocks, chat, the result |
| `ArenaLab.vue` | A practice board with no service, at `/arena/lab/<game>` |
| `arenaGames.ts` | Finds each game's board and how-to by folder name |
| `games/` | One folder per game |

## Adding a game

1. **Rules** — `src/shared/games/<game>.ts`, exporting `createRules` that returns the `Rules`
   interface in `src/shared/arena.ts`: `start`, `turn`, `parseMove`, `apply`, `outcome`, `view`
   (what a seat or a watcher may see), `bot` (a computer move at three levels, well inside
   400 ms), `describe` and `forfeit`. Pure and deterministic, with state and moves as plain JSON;
   the same file runs in the service (which decides) and in the browser (which previews).
2. **Name** — add the game to `ARENA_GAMES` in `src/shared/arena.ts`. This is a contract change.
3. **Board** — `games/<game>/Board.vue`, and optionally a how-to-play component beside it
   (`games/<game>/HowTo.vue`). The hall mounts them by name.
4. **Proof** — `scripts/verify-game-<game>.ts`, in the style of the existing three: rule checks,
   then the computer playing itself to the end without an illegal move.

The service picks the rules up through `service/arena/registry.ts`; a game whose rules fail to
load is listed as coming soon rather than breaking the hall.

## Rules for this folder

- **The board never decides.** It sends a move; the service applies the rules and answers. A
  board may preview legality with the same rules file, never the outcome.
- **Hidden information stays hidden.** What a seat or a watcher may see is the rules' `view`;
  do not send more and hide it in the board.
- **Clocks belong to the service.** The board shows them.
- **Playable by keyboard and at 360 px.** Every move has a non-drag way to make it.
- **Sound and motion are optional** and respect the member's settings.
- **Standings never say where anyone is** — a name, a portrait, a rating.

Read [the contributor map](../../../docs/CONTRIBUTOR-MAP.md) for service and probe ownership.
