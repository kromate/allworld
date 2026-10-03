# Contributing

Set-up and checks are in the [README](README.md). Where things live is in
[docs/CONTRIBUTOR-MAP.md](docs/CONTRIBUTOR-MAP.md). How they fit is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Original code uses Apache-2.0. Contributions intentionally submitted for inclusion follow that
license's contribution terms. Preserve third-party asset licenses and notices. No separate CLA
or sign-off requirement has been introduced.

## The rules

Short, and each one exists because of something that went wrong or something the project promises.

1. **Strict TypeScript.** `npm run typecheck` is clean before and after. No `any`, no casts to
   quiet the compiler, no `enum` or other non-erasable syntax (Node runs these files directly).
   Imports name the file with its extension.
2. **The service decides.** Anything shared or worth something — position in a room, chat, coins,
   fares, visas, shift rewards, match results, ratings — is validated and applied by the service.
   The App asks and shows; it never computes an outcome and reports it. A rule both sides need
   lives once, in `src/shared/`.
3. **Photos and places are private by default.** Match stores appearance choices without photo
   pixels or landmarks. Optional photo projection stores a crop and shape points, friends-only
   unless changed, with deletion available. The service holds a coarse area, never a precise real-world
   position; nothing shown to another member reveals where someone actually is.
4. **No fake members.** No sample people, seeded chat, invented counts or bot friends. Scenery
   pedestrians and computer opponents are allowed because they are labelled as such and never
   appear in member counts, lists, maps or chat. Sample market sellers are marked as samples.
5. **It works at 360 px and with a keyboard.** Every window is usable at 360 px wide with no
   horizontal scroll, reachable and operable by keyboard, with visible focus and text alternatives.
6. **Clean up what you start.** Every timer, animation frame, listener, worker, audio node and
   three.js geometry, material or texture is released when its owner goes away. Phones are the
   target; a leak is a bug.
7. **Assets need a paper trail.** Anything you did not make must be freely redistributable, and
   arrives with its source, its terms and what you changed, added to
   [docs/ASSETS-LICENSES.md](docs/ASSETS-LICENSES.md) and to a notice file beside the asset.
   No brands, no real people's likenesses, nothing scraped. See [Assets](#assets).
8. **Evidence, not a test framework.** Do not add Jest, Vitest, Playwright or similar. A change to
   behaviour comes with something that runs and shows it: extend the probe for that area
   (`scripts/verify-*.ts`), or add one in the same style — an in-memory world, plain `assert`, one
   `PASS` line per check, non-zero exit on failure.
9. **Say what you verified, and where.** "Passes locally" and "works when hosted" are different
   claims; so are "emulated phone" and "a phone". Use the current candidate and exact result.
   A private guest playtest does not prove account claiming or public release. If you did not
   check something, say so.
10. **Nothing costs money or sends anything.** No paid service, no API key, no real email, message
    or push from the default set-up. A new external host is a decision for the maintainers, goes
    in `src/config/providers.ts`, and needs a fallback when it is unreachable.

## Where a change goes

| You are | Do this |
| --- | --- |
| Changing a window | Edit its folder in `src/features/`. Parts used by several windows go in `src/ui/` |
| Adding a service operation | Add its input and output types to the area's file in `src/shared/` → register the handler in the area's module in `service/` (parse the input, check the member may do it, change state, call `world.touch()`) → call it from the window with `api()` or `attempt()` from `src/state/app.ts` → extend that area's probe. The compiler flags a mismatch on either side |
| Changing a rule (a fare, a reward, a rating) | Change the constant or function in `src/shared/`. Both sides pick it up. Extend the probe |
| Adding a game to the hall | Follow `src/features/arena/README.md`: one rules file, one board folder, one probe |
| Working on characters or face analysis | Follow `src/features/avatar/README.md`. Rendering is in `src/world/` |
| Working on the street scene or a region | Follow `src/world/README.md` |
| Adding a starter place | `src/shared/places.ts`. The map and standings pick it up |
| Adding or rebuilding assets | `scripts/README.md`, then [Assets](#assets) |
| Adding a route | `main.ts`. A route opens a window beside the world; the world is always mounted |
| Changing stored records | A world saved before your change must still load. Say in the pull request how old records are handled |

Scripts that are neither a probe nor a builder (screenshots, one-off measurements) do not need to
be committed. If one is, it takes its paths from arguments or the script's own location — never
from a home folder or a fixed temporary folder.

## Shared files

Some files are everyone's, so they change slowly and one person at a time. The maintainers own:

- `src/shared/` and `src/brand.ts` — the contract. Both sides and every probe depend on it.
- `service/kernel.ts`, `service/persist.ts`, `service/index.ts` — the service's core.
- `App.vue`, `main.ts`, `src/ui/base.css`, `src/state/app.ts` — the shell every window sits in.
- `package.json`, `tsconfig.json`, `vite.config.mjs` — a new dependency is a decision, not a detail.

You may propose changes to them. Keep such a change in its own pull request, or the smallest
part of one; add rather than alter; and include the service handler and the probe that use it, so
the contract is never ahead of the code. Today the maintainers are the project owner; no list
has been published.

Everything else belongs to whoever is working in that area. If two changes would touch the same
file, the second waits or rebases.

## Assets

For anything binary or third-party:

- Its terms allow free redistribution, including in a modified form. CC0, MIT, Apache-2.0,
  BSD and public-domain releases have been used so far. Share-alike, non-commercial and "free to
  use" without a licence are not accepted without the maintainers' say. Existing OpenStreetMap
  data and derivatives keep ODbL terms. The Monk Skin Tone swatches keep CC BY 4.0 attribution.
  Those existing data grants do not make unrelated share-alike artwork acceptable.
- You record: where it came from (a link to the exact item and version), its licence, the authors
  to credit, and what you changed. One row in [docs/ASSETS-LICENSES.md](docs/ASSETS-LICENSES.md),
  and the notice file beside the asset under `public/`.
- If you made it, say so, and say with what. Generated or procedurally built work is recorded as
  project work with the script that builds it.
- Existing notices are never removed or reworded.
- Photos of people are not assets. Do not add anyone's photograph, face crop or a render of a
  real person's face to the project, including as evidence.

## A pull request

- States what changed and why in a sentence or two, and which area it belongs to.
- `npm run typecheck` and `node scripts/check-structure.mjs` pass. The probes for the areas you
  touched pass; paste their last lines.
- For anything visible: what you looked at, at which widths, and what you did not check.
- Does not add a recorded debt to `scripts/check-structure.mjs` without saying why in the description.
- Leaves historical ledgers and trackers to the owner. They are outside the public source package.

## Pick a bounded task

[Good first contributions](docs/GOOD-FIRST-CONTRIBUTIONS.md) lists proposed tasks, acceptance
criteria, and files to keep out of each patch. Vehicle, expanded-home, and native-hosting work
is prepared separately from the runnable baseline. Read the status in the contributor map
before assuming those modules are integrated.

The owner still needs to select the repository location and private security contact. No
repository URL, maintainers list, or contact address has been invented. Public release uses
the reviewed [source export gate](docs/SOURCE-EXPORT.md), not a copy of the working directory.
