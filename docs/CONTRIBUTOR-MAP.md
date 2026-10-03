# Contributor map

This map describes the runnable source baseline. Use [ARCHITECTURE.md](ARCHITECTURE.md) for
ownership rules and [CONTRIBUTING.md](../CONTRIBUTING.md) for review evidence.
This export selects runtime 119. Integrated driving and reconnect recovery are listed below.
The separate candidates remain outside this export. See [CURRENT-SOURCE.md](CURRENT-SOURCE.md).

## Runnable baseline

| Area | Start here | Authority and rules | Focused check |
| --- | --- | --- | --- |
| Avatars and image analysis | `src/features/avatar/README.md`, `FaceCapture.vue`, `faceScan.ts`, `hairAnalysis.ts`, `useFace.ts`; rendering in `src/world/avatars.ts`, `faces.ts`, `wardrobe.ts`, and `surface*.ts` | `src/shared/appearance.ts`, face types in `src/shared/model.ts`, `service/members.ts` | Typecheck and editor at 360 px. `scripts/verify-social.ts` has limited face visibility coverage, not full save, audience, and deletion coverage |
| Maps and regions | `src/world/README.md`, `src/world/districtScene.ts`, `src/world/regions/`, `src/geo/`, `src/features/map/`, `src/features/world/AreaPicker.vue` | `src/shared/geo.ts`, `src/shared/places.ts`, `service/rooms.ts`, providers in `src/config/providers.ts` | `scripts/verify-geo.ts`, `scripts/verify-social.ts` |
| Asset delivery | `src/assets/assetStore.ts`, `publicAssets.ts`, `assetProgress.ts`, `src/ui/AssetProgress.vue` | `src/assets/public-assets.index.json`; pack readers in `src/world/packs.ts` | `scripts/verify-assets.ts`, `npm run check:assets` |
| Homes | `src/features/world/HomePage.vue`, `src/world/interior.ts` | `src/shared/social.ts`, `service/homes.ts` | `scripts/verify-social.ts`, `scripts/verify-persist.ts` |
| Game hall | `src/features/arena/README.md`, `src/features/arena/games/`, `src/state/arena.ts` | `src/shared/arena.ts`, `src/shared/games/`, `service/arena/` | `scripts/verify-arena.ts`, `scripts/verify-game-walls.ts`, `scripts/verify-game-chess.ts`, `scripts/verify-game-words.ts` |
| Older table games and work | `src/features/play/`, work helpers in `src/features/life/` | `src/shared/play.ts`, `service/games.ts`, `service/work.ts` | `scripts/verify-play.ts` |
| Food, energy, and rest | `src/features/life/`, `src/state/life.ts` | `src/shared/life.ts`, `service/life.ts` | `scripts/verify-life.ts` |
| Social and multiplayer | `src/features/people/`, `src/features/social/`, `src/features/inbox/`, `src/state/social.ts`, `src/state/world.ts` | `src/shared/social.ts`, `direct.ts`, `notify.ts`; `service/rooms.ts`, `social.ts`, `direct.ts`, `notify.ts` | `scripts/verify-social.ts`, `scripts/verify-direct.ts` |
| Return reminders | `src/features/settings/ComebackPanel.vue` | `src/shared/comeback.ts`, `service/comeback.ts` | `scripts/verify-comeback.ts`; external delivery remains dry-run |
| Drivable vehicles | `src/features/transport/`, `src/state/vehicles.ts`, `src/world/vehicles/`, `src/shared/vehicles.ts`, `service/vehicles.ts`, `service/vehicleRoutes.ts` | Service owns seats, route, fare, control epoch, and collision. The client validates its scene against the service graph; ODbL data and notices live in `service/data/transport/` | Typecheck and structure; ride recovery and rendered two-client behavior require focused runtime acceptance |
| Travel and wallet | `src/features/travel/`, `src/state/travel.ts` | `src/shared/travel.ts`, `service/travel.ts` | `scripts/verify-travel.ts` |
| Market and jobs | `src/features/market/` | `src/shared/market.ts`, `service/market.ts`, `service/jobs.ts`; generated `src/assets/furniture.index.json` catalogue | `scripts/verify-market.ts` |
| SEO and social previews | `index.html`, `service/pageMetadata.ts`, `public/social/`, `public/robots.txt`, `public/sitemap.xml`; authoring sources in `scripts/seo/` | Static root metadata; HTTP noindex for nonroot and query HTML; no private URL interpolation | `scripts/verify-seo.ts`; hosted crawler responses and image MIME require release acceptance |
| UI and routes | `App.vue`, `main.ts`, `src/ui/`, `src/ui/base.css`, `src/ui/shell.ts` | Calls through `src/state/app.ts`; no client authority over rewards or outcomes | Typecheck, structure check, keyboard and 360 px checks |
| Sessions and guest admission | `src/state/app.ts`, `src/platform/gateway.ts`, `runtime.ts`, `guestService.ts`, `hostedService.ts`, `src/features/guest/` | `src/shared/guest.ts`, `service/identity.ts`, `hostedIdentity.ts`, `guests.ts` | `scripts/verify-guest.ts`; never expose local `?as=` identity to a hosted audience |
| Creator welcome | `src/shared/creator.ts`, `service/creator.ts` | Verified creator configuration and consent checks; no guessed creator identity | `scripts/verify-creator.ts` |
| Persistence and host transports | `service/README.md`, `service/server.ts`, `transport.ts`, `hostedServer.ts`, `hostedStandalone.ts`, `hostedFiles.ts`, `persist.ts` | `service/kernel.ts` owns operation dispatch; persistence has one writer | `scripts/verify-persist.ts`; hosted identity, TLS, origins, admission, and durability require separate acceptance |
| CI and release | `.github/workflows/`, `docs/CI-CD.md`, `scripts/assemble-release-package.mjs`, `run-release-gate.mjs`, `verify-deployed-build.mjs`, `check-workflows.mjs` | `scripts/guard-release-package.mjs` stays the only deploy gate; the provider token exists only in the protected environment | `scripts/check-workflows.mjs`, `scripts/probe-cicd.mjs`, `scripts/probe-release-package-guard.mjs` |

Some table cells name files relative to the folder at the start of that cell.
Read the imports and callers before changing an entry point.

Match me analyses a photo in the browser and saves editable appearance. An account's optional
photo face saves a reduced crop and shape points through the service. Guest photo projection
is a temporary preview. No image-generation provider exists. The experimental GNM fitter in
`src/features/avatar/identityFit.ts` is parked; do not mistake its vendored code for an accepted
avatar pipeline. Preserve the notices with any derived work.

## Prepared integration tracks

These names are handoff entry points, not claims that the runnable baseline contains them.
Do not copy one client file without its reviewed contract and service dependencies.

| Track | Entry points in the prepared source | Ownership and acceptance boundary |
| --- | --- | --- |
| Passenger pose 074 | One isolated passenger-pose candidate | Geometry and lifecycle passed isolated review. It is not part of runtime 119; current stock rendered review and integration remain pending |
| Expanded homes 091 | Separate home service, contract, renderer, and panels | Isolated candidate, not integrated into runtime 119. Its physical entry, authority, and gameplay acceptance must be reviewed before source integration |
| Native Cloudflare runtime, adapter 055 | service/cloudflare/worker.ts and transport.ts, with the separately owned SQLite persistence and resource adapters | Existing protocol and domain authority remain shared. No Node HTTP, ws listener, or file persistence enters the native Worker transport. Free account, configuration, deployment, durable acknowledgements, restart, timer shutdown, and connection limits require direct provider-runtime evidence |

After a track lands, update this table against the integrated imports and add its actual probe
commands. Do not add missing-path entries to the baseline or turn an isolated diagnostic into
a claim of production support.
