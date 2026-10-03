# Release package guard

Run this gate on the fully assembled package before upload. The builder metadata excludes its own file and the later internal-road and headers additions. The guard requires an exact file set comprising `playtest-build.files`, `playtest-build.json`, `_headers`, and `__world-data/yaba-vehicles.json`. Extra files and missing files fail. Every declared file must match its byte count and SHA-256.

The road file must match the pinned reviewed `ROAD_ASSET` in `service/cloudflare/roads.ts`: 23,347,699 bytes and SHA-256 `44cf0458af265d8ceb5ad84216dc722e0df6e289e29b0acfcaf92b78127919e2`. The supplied road source must still declare these constants. A future road change requires a review and guard update.

`_headers` must equal the reviewed132/135 text. Wrangler assets must use the reviewed Worker-first protection, exactly the five reviewed public static exceptions, `ASSETS`, and no static fallback. The internal-road namespace stays Worker-first. Local configuration checks do not prove a hosted request is protected.

The expected build ID, complete config SHA and builder artifact SHA come from the reviewed release, supplied explicitly by the deployer. The gate recomputes the builder SHA using its existing JSON convention, compares the public config to the metadata and Worker binding, preserves the existing world audience and legacy origin, checks the asset revision, and checks the built entry's public configuration. It prints digests, counts and build ID. It does not print provider configuration values.

All inputs must be absolute canonical paths. On macOS, use `/private/tmp` instead of its `/tmp` symlink alias. The config must be `wrangler.json` directly inside the package root, and the artifact must be its `assets` directory. Ancestor and asset symlinks, path escapes, hidden paths, private state paths, and nonregular files fail before package contents are opened. No environment files, saved-world files, or private-photo directories are needed.

Run from any working directory with Node 22 or newer. No dependencies are added.

```sh
node scripts/guard-release-package.mjs check \
  --package '<absolute-package>' \
  --config '<absolute-package>/wrangler.json' \
  --artifact '<absolute-package>/assets' \
  --build-id '<reviewed-build-id>' \
  --artifact-sha '<reviewed-builder-artifact-sha>' \
  --config-sha '<reviewed-config-sha>' \
  --road-source '<canonical-source-root>/service/cloudflare/roads.ts'

node scripts/probe-release-package-guard.mjs
```

The probe creates and removes fixtures inside this candidate's directory. Its small synthetic positive fixture calls the verification function with a synthetic road digest. The CLI always uses the reviewed real-road constants. Negative controls call the real CLI in deploy mode with a synthetic marker executable. They prove rejection precedes execution for missing road, wrong road size/hash, metadata changes, binding mismatch, extra files, absent/bad headers, internal-road static bypass, symlinks, path mismatch, and config/assets overrides and config build hooks. Two direct synthetic checks also reject missing or changed declared files. It never invokes Wrangler or a provider.

For deployment, the sole deployer changes `check` to `deploy` and adds `--deploy-executable '<canonical-absolute-wrangler-executable>'`. The wrapper builds the command itself as `wrangler deploy --config <checked-config>` with the checked package as the working directory. It rejects unreviewed config keys such as a build command, checks the Worker entry path, and accepts no extra deploy flags and cannot accept a later config or assets override. Immediately before execution it repeats the gate and rejects a changed complete-package digest. The deployer must keep the package stable through upload; the local gate cannot prevent another process mutating files after it starts Wrangler.

The output contains the builder `artifactSha256`, the `configSha256`, and a separate `guardSha256`. The guard digest covers the config bytes and every ordered asset path, size and SHA, including the post-build road and `_headers`. Save this fingerprint with the release evidence. A passing local package gate does not establish deployment, provider receipt, or browser acceptance.

Hosted acceptance also checks public asset responses, entry execution order, and real account and gameplay flows. This gate does not change domain authority, persistence, or audience policy.
