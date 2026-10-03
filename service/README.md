# The world service

The service is the authority for shared state, permissions, ownership, and outcomes.
The local App mounts it through Vite. `npm run service` runs it alone and requires a separate
`WORLD_STATE` file. The standalone listener defaults to loopback port 5188.

| File | Responsibility |
| --- | --- |
| `kernel.ts`, `index.ts` | World clock, domain slices, operation dispatch, domain registration |
| `members.ts`, `rooms.ts` | Profiles and optional faces; presence, movement, chat, voice gating |
| `social.ts`, `direct.ts`, `homes.ts`, `notify.ts`, `comeback.ts` | Friends and groups, messages, home permissions and layouts, notifications, return reminders |
| `life.ts`, `work.ts`, `games.ts`, `travel.ts`, `market.ts`, `jobs.ts` | Needs, shifts, table games, game-coin wallet and documents, products, listings |
| `arena/` | Matches, rules registry, clocks, ratings, word dictionaries |
| `persist.ts` | Saved revisions, backups, one file owner |
| `server.ts`, `transport.ts`, `identity.ts` | Local HTTP and WebSocket transport and development identity |
| `hostedServer.ts`, `hostedStandalone.ts`, `hostedIdentity.ts`, `hostedFiles.ts`, `guests.ts` | Explicit hosted configuration, admission, scoped identity, durable delivery |
| `standalone.ts`, `cluster*.ts`, `diagnostics.ts` | Standalone process, sharded process composition, measurements |

Declare an operation in `src/shared/`, then register its parser and handler in the owning
module. The parser turns unknown input into validated values. The handler checks permission,
computes the result, changes its slice, and calls `world.touch()`. Extend or run the area's
existing probe with controlled state and the world's clock.

The service imports no browser windows, engine, or reactive state. Generated asset catalogues
are explicit data dependencies. Never accept client-computed prices, rewards, game results,
identity, or permission. Preserve audience and block filters on every response and event.
Old saved records must still load, with any migration stated in the change description.

A state file has one process owner. Do not point a standalone or diagnostic process at the
world used by another dev server. Hosted identity and guest admission never fall back to local
named actors. Read [hosting boundaries](../docs/HOSTING.md) before adapter changes and
[the architecture](../docs/ARCHITECTURE.md) before changing core ownership.
