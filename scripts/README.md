# Scripts

Run these from the project root with Node 22.18 or newer after `npm ci`.
The source package includes portable checks and selected builders. Machine-specific browser,
load, performance, private-playtest, and experimental-cast tools are excluded.

## Checks

| Command or probe | Covers |
| --- | --- |
| `npm run typecheck` | App, service, and TypeScript scripts |
| `npm run check:structure` | Imports, documented paths, probe coverage, asset notices, ignore patterns |
| `npm run check:assets` | Public asset manifest, hashes, classifications, budgets, asset-store behavior |
| `verify-social.ts` | Rooms, chat, voice gating, friends, communities, homes, meetups, notifications |
| `verify-direct.ts` | Direct messages, waves, invitations, presence |
| `verify-comeback.ts` | Away detection, digests, caps, quiet hours, dry-run unsubscribe |
| `verify-life.ts` | Food, energy, meals, rest |
| `verify-play.ts` | Work shifts, older table games |
| `verify-travel.ts` | Fares, passport, visas, wallet |
| `verify-market.ts` | Sellers, products, quotes, jobs |
| `verify-arena.ts` | Matches, clocks, ratings, watching, standings |
| `verify-game-walls.ts`, `verify-game-chess.ts`, `verify-game-words.ts` | Rules and computer players, slower than the service probes |
| `verify-persist.ts` | One state owner, restarts, backups |
| `verify-assets.ts` | Asset downloading, hashes, refusals, storage budget |
| `verify-geo.ts` | Live map data; requires network access |
| `verify-guest.ts` | Guest permission and lifecycle rules |
| `verify-creator.ts` | Creator welcome contract and consent |

Run a focused probe with `node scripts/verify-social.ts`, replacing the filename for your area.
`npm run verify` runs nine service probes. Geo, game-specific, guest, and creator probes are
separate. The [contributor map](../docs/CONTRIBUTOR-MAP.md) points to every retained probe.
Probes use plain assertions against the real service modules with controlled state.

## Asset builders

The public packs are prebuilt. Setup does not run a builder. Selected builders are
`build-asset-packs.mjs`, `build-avatars.mjs`, `build-wardrobe.mjs`, `build-regions.mjs`, and
`build-vehicle-road-data.ts`. The vehicle builder and retained ODbL source tiles are shipped
with `service/data/transport/NOTICE.md`.
Read the script header before running one. Some require source archives or authoring tools
that are intentionally absent from the runnable export. Regional original models use
`regions/models.mjs`, retained with the regional builder.

After an intentional asset change, record its source, terms, and modifications in
[ASSETS-LICENSES.md](../docs/ASSETS-LICENSES.md), preserve its companion notice, and run
`node scripts/build-asset-manifest.mjs`. The manifest builder rewrites the device-download
index. Its `--check` option writes nothing and rejects stale hashes or unclassified files.
Do not regenerate a manifest just to hide an unexpected pack change.

The separate source export tool uses an exact reviewed manifest. See
[SOURCE-EXPORT.md](../docs/SOURCE-EXPORT.md). It is preparation tooling, not a game runtime.
