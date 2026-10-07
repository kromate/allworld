# Fast Allworld releases

`joinallworld-release.yml` defaults to focused checks. Set `full_checks=true` only when you want exhaustive validation in that release run. Full validation can instead run locally or in the public source repository's manual CI, once for the exact source SHA.

Fast mode performs these steps:

1. Verify the exact source SHA belongs to public `kromate/joinallworld` main.
2. Install locked dependencies without lifecycle scripts.
3. Build once and enforce the download budget.
4. Run the existing entry, release contract, and protocol test files.
5. Run five existing Worker checks covering public IDs, duplicate fares, restart durability, settlement and expiry, static headers, the combined gameplay journey, and missing assets. Fail if the selection no longer produces five passing checks.
6. Bundle and seal the fixed Worker package. The protected deployment job verifies and deploys that artifact without rebuilding.

The source and Worker smoke steps each have a one-minute limit. The build and download-budget step has a three-minute limit. These limits reject stalled steps; they do not guarantee a successful five-minute release. Queue time, environment approval, provider delays, and installation remain variable.

Full mode replaces the source smoke step with type checking and the complete core suite. It replaces the five Worker checks with all `deploy/*.test.ts` suites. The frontend is built first in both modes so tests that inspect `dist/` cannot silently skip for lack of a build.

Use full validation for authentication, stored data, economy rules, city generation, Worker behavior, and dependency changes. Record the source SHA and result. Fast mode does not automatically verify a claimed local result. A result from different source code does not cover the candidate.

`deploy` and `publish_staging` still default off. The protected credential, fixed Worker identity, archive digest, package hashes, allowed assets, main-only deployment, and stale-policy refusal remain enforced. Fast mode changes test scope, not these deployment controls.

## Measured bottleneck

The successful [October 7 release run](https://github.com/kromate/allworld/actions/runs/37600431808) took 17 minutes. Its log contains:

| Work | Seconds |
| --- | ---: |
| Full core suite, 3,066 tests | 784.1 |
| Vite production build | 26.2 |
| Cloudflare conformance suite, 45 tests | 151.6 |
| Complete deployment job | 25 |

The five selected Worker smoke checks accounted for about 3.8 seconds of that full run. This is historical evidence, not a measurement of the updated hosted workflow. Initial installs took seconds, so adding cache exceptions to the deployment policy would not address the main delay.

The target is less than five minutes for the default hosted path. Hosted confirmation requires publishing these workflow changes and running them. The full path is intentionally allowed to take longer.

An isolated local copy of source `e659ca1d304001cae8bda4f15d00dca4d8d97ff6` with the source pipeline changes completed type checking, the build, download budgets, and all 15 source smoke assertions in 61.07 seconds on Node 24.14.1. The exact fast Worker step, including its five-pass assertion, completed in 2.73 seconds. Dependencies were already installed. These figures exclude installation, queue time, approval, and deployment.

## Research decisions

- GitHub distinguishes [artifacts from dependency caches](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts#artifacts-versus-dependency-caching). The existing release already passes an exact sealed artifact between package and deploy jobs. Keep that behavior.
- [Artifact digest validation](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts) can report a mismatch as a warning. Keep the existing explicit digest check that fails deployment on a mismatch.
- [Cross-run artifact downloads](https://github.com/actions/toolkit/tree/main/packages/artifact#download-artifacts-from-other-workflow-runs-or-repositories) require selecting the exact run and appropriate read access. They can remove another build, but the measured build is only 26 seconds. Avoid adding cross-repository credential and provenance handling to remove that small cost in this change.
- Node supports [test concurrency](https://nodejs.org/docs/latest-v22.x/api/cli.html#--test-concurrency) and [test sharding](https://nodejs.org/docs/latest-v22.x/api/cli.html#--test-shardindextotal). Sharding is a follow-up for shortening full checks after measuring file balance and resource isolation. It is not required to remove the exhaustive suite from each fast release.

The source repository documents its local commands and optional full CI in `docs/FAST-CHECKS.md`.
