# CI and release workflows

For the current game's separate `joinallworld-release.yml` workflow, see [Fast Allworld releases](FAST-RELEASES.md).

Two GitHub Actions workflows live in `.github/workflows/`. Neither uses `pull_request_target`,
`workflow_run` or a cache, and every action is pinned to a full commit SHA.

| Workflow | Runs | Secrets | Does |
| --- | --- | --- | --- |
| `ci.yml` | Pull requests to `main`, pushes to `main` | None, no environment, read-only token | `npm ci --ignore-scripts`, workflow validation, `npm run check`, the CI probes, a synthetic release package through the package gate, and a Worker bundle dry run. Never deploys |
| `release.yml` | Manual dispatch only | `CLOUDFLARE_API_TOKEN`, in the `production` environment only | `package` builds and gates the complete package with no secrets and seals it as one archive. `deploy` runs only for `refs/heads/main`, only when the `deploy` input is set, and when the environment's deployment restrictions allow it |

The environment scopes the provider token and restricts deployment branches. Human approval is
enforced only if required reviewers are configured in GitHub; naming the environment in the
workflow does not create an approval requirement.

`deploy` checks that its commit is still the head of `main`, verifies the sealed archive digest
from the `package` job's outputs, then calls `scripts/run-release-gate.mjs deploy`. That wrapper
builds the guard's argument list itself, refuses outside the `main` dispatch context, passes the
token to nothing but the guarded Wrangler child, and the
[release package guard](../scripts/release-package-guard.md) repeats its checks immediately before
upload. The run ends with `scripts/verify-deployed-build.mjs`, which reads `/world/health` for the
new build ID and confirms the internal road data is not public.

## One-time repository settings (owner)

Workflow files cannot set these. Verify the repository settings separately from workflow checks.

1. Environment `production`: deployment branches limited to `main`, and the
   secret `CLOUDFLARE_API_TOKEN` stored here and nowhere else. Scope the token to Workers Scripts
   edit on the one account. Add nothing else. Configure required reviewers if releases must wait
   for human approval; the workflow alone does not enforce it.
2. Branch protection on `main`: pull request required, status check `Check, build and
   package gate` required, no direct pushes. Verify the required approval count separately if
   the owner chooses to require a human review before merging.
3. Actions settings: read-only default token, approval required for fork pull request workflows.
4. Repository variables (public values, not secrets). Names only; values are the owner's:

| Variable | Meaning |
| --- | --- |
| `ALLWORLD_ORIGIN` | Serving origin, `https://<worker-host>` |
| `ALLWORLD_AUDIENCE` | Stable logical world audience origin. Changing it creates another identity boundary |
| `ALLWORLD_LEGACY_ORIGIN` | Optional. Defaults to the audience. Must differ from the serving origin |
| `ALLWORLD_SITE_ID`, `ALLWORLD_PACKAGE_ID` | Stable world scope. Must match the live Worker |
| `ALLWORLD_WORKER_NAME`, `ALLWORLD_CF_ACCOUNT_ID` | Worker name and account identifier. The identifier is not a secret |
| `ALLWORLD_FIREBASE_PROJECT_ID`, `ALLWORLD_FIREBASE_PROJECT_NUMBER` | Dedicated account project |
| `ALLWORLD_MAX_CONNECTIONS`, `ALLWORLD_IMPORT_MAX_BYTES` | Optional. Default 4 and 65536 |
| `ALLWORLD_DO_MIGRATION_TAG` | Optional. Default `v1`. Must equal the tag already applied to the live Durable Object |

The build ID is `allworld-<commit sha>`. `WORLD_FIREBASE_API_KEY` and `WORLD_SESSION_KEY` are Worker
secrets set by the operator with Wrangler. A deploy does not change them. `WORLD_IMPORT_SECRET` stays
removed. None of them belongs in GitHub.

## Pins

- Actions: full SHAs with the tag in a comment. Change one by looking the tag up and replacing the SHA.
- Wrangler: `.github/wrangler/package.json` and `package-lock.json`, installed with `npm ci
  --ignore-scripts` into a temporary folder. It is a release tool, not an App dependency.
- Node: `22.18.0`, the `engines` minimum. `scripts/check-workflows.mjs` fails if they drift.

## Run it locally

```sh
node scripts/check-workflows.mjs        # workflow rules, pins, private-path exclusion
node scripts/probe-cicd.mjs             # mocked workflow and CLI controls, no provider
node scripts/probe-cicd.mjs --build     # also the real frontend build; needs a real public/ folder
```

`scripts/assemble-release-package.mjs --synthetic --out <fresh absolute folder>` builds a package
from reserved `.invalid` hosts. It passes the gate and can never be deployed.

A passing probe does not show that the hosted workflow, the environment protection or a deployment
works. Those need a real run in the repository.
