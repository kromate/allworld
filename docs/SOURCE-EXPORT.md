# Export a frozen Allworld source candidate

This is local packaging. It does not publish a repository, deploy a host, register an account
provider or copy the original development App over this candidate.

## Review current bytes

Freeze integration before exporting the reviewed standalone runtime, native Worker wiring,
compiler inputs and license notices. Do not substitute an older source archive.
Every selected file gets its current SHA256 and byte count. The prior accepted reference
classifies retained assets and licenses; it never supplies old source bytes.

The tool excludes private state, environment files, credentials, private photo folders,
diagnostics, handover histories, node_modules, experimental cast and retired packs before
opening their contents. Known-pattern scanning covers selected text and decompressed packs.
Keep every third-party notice and the retained ODbL source tiles. New or changed public assets
need explicit provenance review. Review the final manifest for unknown private material.

## Prepare a plan

Use Node 22.18 or newer and Python 3. Supply an absent output directory whose parent exists,
outside the source root. Existing directories and symlinks are refused.

```sh
node scripts/export-source.mjs --root "$FINAL_SOURCE_ROOT" --output "$PLAN_OUTPUT" --plan
```

Inspect export-manifest.json and source-audit.json. A rejected plan exits nonzero and contains
no archive. Resolve findings and rerun the plan. Review selectedTreeSha256 and manifestSha256 before exporting. The manifest hash pins license and notice metadata as well as the selected rows.
Historical attribution and product copy are separate; Allworld must not depend on Goalmatic
sign-in or shared deployments.

## Create a matching archive

Use another absent output path and the accepted plan's reviewed selectedTreeSha256 and manifestSha256. Both pins are required.

```sh
node scripts/export-source.mjs --root "$FINAL_SOURCE_ROOT" --output "$ARCHIVE_OUTPUT" --expect-tree "$REVIEWED_TREE_SHA256" --expect-manifest "$REVIEWED_MANIFEST_SHA256"
```

The tool re-audits source, rejects a different tree or manifest, runs the existing manifest-gated exporter,
audits its staging directory, and writes allworld-source.tar.gz. Tar paths are sorted, ownership
and mode are normalized, and tar/gzip timestamps are zero. Every archived byte hash is checked.
A second source audit rejects concurrent drift before finalizing the output.

source-export-report.json records the reference, manifest, selected tree and verified archive hashes.
Reports and staging state stay outside the archive. No absolute source roots or credentials
appear in the report. Repeated exports of unchanged source/reference reproduce the same archive.

## Verify the extracted package

Verify and install using the trusted local tool, before executing anything from the archive:

```sh
python3 scripts/source-export-install.py --archive "$ARCHIVE_FILE" --expect-archive "$REVIEWED_ARCHIVE_SHA256" --expect-tree "$REVIEWED_TREE_SHA256" --expect-manifest "$REVIEWED_MANIFEST_SHA256" --source-root "$FINAL_SOURCE_ROOT" --dry-run
python3 scripts/source-export-install.py --archive "$ARCHIVE_FILE" --expect-archive "$REVIEWED_ARCHIVE_SHA256" --expect-tree "$REVIEWED_TREE_SHA256" --expect-manifest "$REVIEWED_MANIFEST_SHA256" --source-root "$FINAL_SOURCE_ROOT" --dest "$NEW_CANONICAL_DIRECTORY"
```

The destination must be absent and outside the original source. The installer checks the archive,
manifest, exact member set and every byte hash before writing. It refuses links, special files,
unsafe paths and duplicates. It writes a private staging directory beside the destination, fsyncs
files and directories, then uses atomic no-replace rename and fsyncs the parent. It checks hashes
again at the final path. A filesystem sync error is a failure; if the destination exists after an
error, inspect it rather than deleting it or overwriting it. This uses the filesystem fsync contract;
it cannot promise hardware behavior beyond that contract. macOS and Linux no-replace rename are
supported; other platforms are refused. The tool does not execute source or install dependencies.

Before npm ci, run scripts/source-export-audit.py in artifact mode using the same reference and
manifest. Then run both typechecks, structure/assets checks, build and existing probes. Keep private
world backups, scan photos and provider/session secrets outside the source, export and destination.
Use independent local state and a separately authorized free port. The default port is defined in
package.json. Installing source does not migrate runtime state.
Archive verification does not prove browser, account, device or production behavior.

scripts/export-opensource.mjs remains available for a reviewed custom manifest. The primary
command above points every source root at the frozen current source.

Required src/service roots and standalone entrypoints must be present as ordinary files. Selected
files with additional hard links are refused before reading. The source must remain frozen while
planning/exporting; the tool is not a sandbox against concurrent hostile filesystem mutation.
Known complete product capabilities, account-cookie values and embedded raster image payloads
block export. A public raster payload requires a separately reviewed per-file/hash decision; no
global bypass flag is provided. Ordinary scan code, stock assets and bundled word data remain valid.
