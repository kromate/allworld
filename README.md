# Allworld

A social world on real maps, built with Vue 3, TypeScript and three.js. Make a character, explore
public streets, furnish a virtual home, work shifts, play games and travel. Allworld owns its
guest capabilities and accounts. Running this source does not require a Goalmatic account.

Original code uses Apache-2.0. Media and OpenStreetMap-derived databases keep their terms in
[NOTICE](NOTICE) and [the asset license record](docs/ASSETS-LICENSES.md).

## Build and run locally

Use Node 22.18 or newer and the pinned npm version in package.json.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5189/?as=a. Named actors are local development identities. Never expose
the development listener as public account verification. One state file has one process owner.
For another local copy, supply distinct STATE_PATH and CACHE_PATH paths outside the export,
then use NW_STATE and NW_CACHE_DIR with a free port.

```sh
npm run typecheck
npm run typecheck:worker
npm run check:structure
npm run check:assets
npm run verify
npm run build
```

Map and optional face-model downloads require network access. No saved world or private photo
is shipped. Source export and compilation do not prove hosted account or device behavior.

## Run a standalone host

service/hostedStandalone.ts accepts explicit state, origin, audience, build metadata and guest
admission flags. It binds to loopback by default. No live URL or owner configuration is included.

Accounts use a dedicated Firebase project's email/password provider. The Node listener needs
--firebase-project, --firebase-api-key-file and --session-key-file together. Keep both secret
files outside the checkout. The 32-byte session key also belongs outside the state folder.

The native Worker uses WORLD_BINDING, WORLD_GUEST_ADMISSION and WORLD_ACCOUNT configuration.
Server secret names are WORLD_FIREBASE_API_KEY, WORLD_SESSION_KEY and WORLD_IMPORT_SECRET.
Optional controls include WORLD_CREATOR_CONFIG, WORLD_MAX_CONNECTIONS, WORLD_LEGACY_ORIGIN and
WORLD_IMPORT_MAX_BYTES. No values, environment files, credentials or import payload are shipped.

Provisioning and deployment are operator steps. Read [hosting boundaries](docs/HOSTING.md).
Worker source and compiler inputs are included; their hashes are not deployment receipts.

## Export reviewed source

The local exporter needs Python 3 and Node. It prepares a manifest plan, then writes a deterministic
source archive only when the current source matches both the reviewed selected tree and complete manifest hashes.
Use a fresh output directory outside the source tree for each command.

```sh
node scripts/export-source.mjs --root "$PWD" --output "$PLAN_OUTPUT" --plan
node scripts/export-source.mjs --root "$PWD" --output "$ARCHIVE_OUTPUT" --expect-tree "$REVIEWED_TREE_SHA256" --expect-manifest "$REVIEWED_MANIFEST_SHA256"
```

Inspect the plan's export-manifest.json and source-audit.json. The export output adds a verified
allworld-source.tar.gz. See [the export procedure](docs/SOURCE-EXPORT.md). These commands make
no remote, account, Git or deployment change.
