# Hosting boundaries

Allworld has standalone guest identities, accounts, and world storage. It does not require a Goalmatic account or hosted App session.

## Local development

`npm run dev` binds Vite and its local world service to loopback on port 5189. Named actors are development identities. The Node-only development service uses `service/standalone.ts`. Each service process needs its own state file and cache directory.

The original development checkout can continue on its existing port. A second process must not open the same world state file. Local actors are never accepted by the public hosted adapter.

## Standalone accounts and guests

`service/hostedServer.ts` and `service/hostedStandalone.ts` provide the Node host. `service/cloudflare/worker.ts` composes the same domain rules with native WebSockets and SQLite Durable Object storage.

Accounts use a dedicated Firebase email/password project. The host keeps provider refresh data in an encrypted, Secure, HttpOnly account cookie. Account challenges and one-use grants establish short world leases. Server timestamps define their lifetime; clients enforce request-start deadlines with a monotonic clock. Sign-out invalidates the active account flow.

Guests receive scoped capabilities and can later claim their existing character after explicitly choosing an account. Claim receipts distinguish success, conflict, and an unanswered request. Guest transfer uses a one-use handoff and asks before replacing a character already held by the destination browser.

The network endpoint can change while the world audience, site, package, and channel remain stable. Changing that logical scope creates another identity boundary. Historical Goalmatic names in shared identity types do not add a runtime account dependency.

## Cloudflare configuration and storage

`WORLD_BINDING` identifies the public origin, stable world scope, build, and artifact. `WORLD_ACCOUNT` identifies the dedicated Firebase project. `WORLD_GUEST_ADMISSION` controls public or invited guest entry. `WORLD_MAX_CONNECTIONS` limits active sockets independently of room capacity.

`WORLD_FIREBASE_API_KEY` and `WORLD_SESSION_KEY` are server secrets. The session key must remain stable across ordinary deployments. Secret values and saved worlds stay outside source exports.

A new world opens only after a verified canonical import. The import receipt records the original snapshot and remains separate from later gameplay state. `WORLD_IMPORT_SECRET` authorizes this migration and can be removed after acceptance. A pre-launch snapshot is not a current backup and must not replace an active world.

The native road loader reads `assets/__world-data/yaba-vehicles.json` through the internal `ASSETS` binding and checks its exact size and hash. The outer Worker refuses that namespace to public requests. The complete deployment package includes this server asset and `_headers` in addition to the frontend builder output.

The [release package guard](../scripts/release-package-guard.md) checks the complete package before invoking deployment. Its file digest includes the internal road data and headers. A frontend build alone is not a complete Worker deployment.

## Release evidence and limits

A deployment receipt proves the provider accepted a package. Browser acceptance also covers fresh guest entry, account creation, claim, sign-out and return, independent players, and progress after a Worker restart. Local development actors and synthetic probes cover different boundaries.

Voice uses peer connections with no TURN relay, so strict networks can prevent audio. Physical-device and microphone checks remain separate from browser viewport tests. Email, WhatsApp, and push adapters remain dry-run. Creator identity stays disabled until an operator supplies a verified owner identity.

The [source export procedure](SOURCE-EXPORT.md) retains code, reviewed public assets, and their license notices. It excludes personal photos, saved worlds, credentials, and private verification records.
