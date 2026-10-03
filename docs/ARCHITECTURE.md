# Architecture

The browser presents the world. The service decides shared outcomes. Both use one typed
contract. The [contributor map](CONTRIBUTOR-MAP.md) lists the files for each area.

## Ownership

| Owner | Responsibility | Dependencies |
| --- | --- | --- |
| `src/shared/` and `src/brand.ts` | Record, operation, and event types; deterministic rules that both sides use | The contract itself |
| `service/kernel.ts` | Registers operations, dispatches validated calls, runs the world clock and ticks, holds domain slices | Contract and service modules |
| `service/index.ts` | Assembles the domain modules into one world | Service modules |
| Domain modules in `service/` | Validate permissions, update their slice, mark the world changed, emit filtered events | Contract, service helpers, generated catalogues in `src/assets/`, Node runtime dependencies |
| `service/persist.ts` | Stores revisions, backups, and state with one file owner | Service persistence interface and Node filesystem |
| `service/server.ts`, `hostedServer.ts`, `transport.ts` | HTTP and WebSocket boundaries, session admission, size limits, socket lifecycle, persistence-aware replies | Kernel, identity, persistence, protocol, Node HTTP and `ws` |
| `src/state/app.ts` and `src/platform/gateway.ts` | Current actor, link state, typed requests, reconnection, server events | Contract and platform adapters |
| `src/state/world.ts` | Scene selection and controller wiring | Contract, platform, engine |
| `src/world/engine.ts` | Renderer, camera, frame loop, scene resources | Contract, geo, config, asset readers, three.js |
| `src/geo/` | Vector-tile decoding, geographic areas, geocoding, district data | Contract, provider config, framework-free routing in `src/world/nav.ts` |
| `src/features/` | Domain windows and their local helpers | State, shared rules, engine, UI components |
| `App.vue`, `main.ts`, `src/ui/` | Routes, dock, floating windows, shared controls and styles | Features, state, contract |

Ownership describes code responsibility, not a published maintainer roster. The project owner
coordinates changes to shared contracts, core transport, persistence, shell, and package files.
One writer at a time owns each of those files.

## Dependencies that matter

1. The contract imports only the contract. It runs in the browser, Node service, and probes.
2. The service does not import browser windows, scene code, or reactive state. Generated asset
   catalogues are explicit data dependencies.
3. Browser code does not import service code, scripts, or Node built-ins.
4. World, geo, config, and platform modules do not import feature windows.
5. Geo code imports neither Vue nor three.js.

`npm run check:structure` checks these rules, resolves relative imports, checks documented
paths and probe coverage, checks asset notices, and checks local-data ignore patterns.
The selected contributor source has zero recorded debt. New exceptions fail the check.
Do not add debt to pass a contribution.

## One operation

A window calls `api()` or `attempt()` in `src/state/app.ts`. Its operation input and output
come from `src/shared/protocol.ts` and the domain contracts that it combines.
`src/platform/gateway.ts` sends the typed frame over a WebSocket.

The transport authenticates the caller and gives the call to the kernel. A domain module's
registered parser rejects malformed input. Its handler checks permission and current world
state, computes the result, updates its slice, and calls `world.touch()`. The service emits
viewer-filtered events to the relevant sessions. The client renders those answers and events.

Persistence owns the saved revision. Hosted state-changing replies must respect the configured
durability barrier. A received frame is not proof of a committed purchase when persistence
failed. Domain request IDs and receipts make retries safe; the UI must retain an unresolved
intent rather than create a second charge.

## Scene and assets

The world controller selects a district, venue, or home. The engine builds the scene and owns
the frame loop. `src/world/districtScene.ts` combines decoded map geometry with stylised region
props. Map positions are game-scene coordinates, distinct from a player's real location.
The service stores a chosen coarse area, never a device's precise real-world position.

`src/world/packs.ts` loads packs through the asset-delivery layer. The generated
`src/assets/public-assets.index.json` lists hashes, byte counts, and classification for files
the device may keep. A pack change requires a matching manifest. Timers, workers, listeners,
geometries, textures, and materials belong to the module that creates them and must be released.

## Runtime boundaries

`npm run dev` mounts a local world service inside Vite. Named local actors are development
identities. `npm run service` runs that service alone and requires its own `WORLD_STATE` path.
Two service processes must never share a state file.

Public guests use scoped capabilities. Standalone Firebase accounts use an explicit account choice, a verified grant exchange, and renewable world leases. Neither path falls back to a named local actor. The host checks origin and logical world scope before admitting a session.

The integrated source includes vehicle authority and recovery, physical homes, guest claiming, and the native Cloudflare adapter. Domain rules own seats, fares, entry, collision permission, and durable acknowledgements. Renderer geometry presents those decisions.

See [HOSTING.md](HOSTING.md) for storage and deployment boundaries, and [CONTRIBUTOR-MAP.md](CONTRIBUTOR-MAP.md) for module ownership. Runtime acceptance belongs to the exact deployed artifact, separately from source checks.
