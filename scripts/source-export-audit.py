#!/usr/bin/env python3
"""Create a review manifest or audit an export without opening excluded private paths.

Uses Python's standard library. All paths are arguments. Does not copy/export source.
Reports patterns and relative paths only, never matched credential text.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import posixpath
from pathlib import Path, PurePosixPath
import re
import sys

PRIVATE = re.compile(r'(^|/)(?:\.goalmatic|\.git|node_modules|dist|\.vite|\.env[^/]*|\.npmrc|\.netrc|credentials?[^/]*|tokens?[^/]*|world-state[^/]*|saved-world[^/]*|private|local|tmp|reference-photos?[^/]*|owner-photos?[^/]*|face-crops?[^/]*|evidence|__pycache__)(/|$)|\.(?:log|pem|key|p12|pfx|pyc)$', re.I)
EXCLUDED = re.compile(r'^(?:assets-src/|public/cast/|scripts/(?:cast/|qa/|regions/|wardrobe/|perf-|load-|build-private-playtest\.mjs|export-goalmatic\.mjs)|diagnostics/|docs/(?:handover/|evidence/|playtest/|3d/))|^public/packs/characters\.pack\.gz$')
TEXT_SUFFIX = {'.ts', '.vue', '.mjs', '.js', '.json', '.md', '.txt', '.html', '.css', '.yml', '.yaml', '.py'}
CODE_SUFFIX = {'.ts', '.vue', '.mjs', '.js'}
SECRETS = [
    ('allworld-capability', re.compile(r'\b(?:gst|gmc|gtx)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])')),
    ('account-cookie-value', re.compile(r'__Host-aw_session=[A-Za-z0-9_-]{32,}')),
    ('embedded-raster-review', re.compile(r'data:image/(?:png|jpe?g|webp|gif|bmp|heic|avif);base64,\s*[A-Za-z0-9+/]{24,}', re.I)),
    ('private-key', re.compile(r'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----')),
    ('aws-access-key', re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b')),
    ('provider-secret-key', re.compile(r'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b')),
    ('github-token', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b')),
    ('google-api-key-review', re.compile(r'\bAIza[A-Za-z0-9_-]{35}\b')),
    ('slack-token', re.compile(r'\bxox[baprs]-[A-Za-z0-9-]{20,}\b')),
    ('assigned-secret', re.compile(r'\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|password)\s*[:=]\s*[\"\'][A-Za-z0-9+/_=-]{24,}[\"\']', re.I)),
    ('credential-header', re.compile(r'\bBearer\s+[A-Za-z0-9_.=-]{30,}')),
    ('jwt', re.compile(r'\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b')),
    ('credential-url', re.compile(r'https?://[^\s/:]+:[^\s/@]+@')),
]
NEW_FILES = {
    'scripts/build-private-playtest.mjs': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/guard-release-package.mjs': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/probe-release-package-guard.mjs': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/release-package-guard.md': ('documentation', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'service/arena/words/bundled.ts': ('source', 'Apache-2.0 + Public-domain-ENABLE + SCOWL-permissive', ['LICENSE', 'NOTICE', 'service/arena/words/SOURCES.txt']),
    'service/data/homes/yaba-homes.json': ('asset', 'ODbL-1.0', ['service/data/homes/NOTICE.md', 'service/data/transport/NOTICE.md']),
    'service/data/homes/NOTICE.md': ('documentation', 'ODbL-1.0', ['service/data/homes/NOTICE.md']),
    'service/data/transport/street-arrivals.json': ('asset', 'ODbL-1.0', ['service/data/transport/NOTICE.md']),
    'scripts/build-home-parcels.ts': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/build-street-arrivals.ts': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'src/assets/homes/yaba-home-scene.json': ('source', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'cloudflare-env.d.ts': ('source', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'tsconfig.worker.json': ('source', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/export-source.mjs': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/source-export-audit.py': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/source-export-archive.py': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/source-export-install.py': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
    'scripts/source-export-reference.json': ('tooling', 'Apache-2.0', ['LICENSE', 'NOTICE']),
}
REQUIRED_FILES = {'main.ts', 'src/state/app.ts', 'src/assets/public-assets.index.json', 'service/hostedStandalone.ts', 'service/cloudflare/worker.ts', 'cloudflare-env.d.ts', 'tsconfig.worker.json'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def permitted(path):
    normalized = path.rstrip('/')
    parts = PurePosixPath(normalized)
    if parts.is_absolute() or '..' in parts.parts or not normalized or normalized != parts.as_posix():
        return False
    if normalized in ('scripts/regions', 'scripts/regions/models.mjs', 'scripts/build-private-playtest.mjs'):
        return True  # Exact reviewed portable inputs; neighboring private paths remain excluded.
    return not PRIVATE.search(path) and not EXCLUDED.search(path)

def inventory(root):
    files, excluded = [], []
    for directory, dirs, names in os.walk(root, followlinks=False):
        kept = []
        for name in sorted(dirs):
            p = Path(directory) / name
            rel = p.relative_to(root).as_posix()
            if p.is_symlink() or not permitted(rel + '/'):
                excluded.append({'path': rel + '/', 'reason': 'symlink' if p.is_symlink() else 'excluded-path'})
            else:
                kept.append(name)
        dirs[:] = kept
        for name in sorted(names):
            p = Path(directory) / name
            rel = p.relative_to(root).as_posix()
            if p.is_symlink() or not permitted(rel):
                excluded.append({'path': rel, 'reason': 'symlink' if p.is_symlink() else 'excluded-path'})
                continue
            files.append(rel)
    return sorted(files), excluded

def read_stable(root, rel):
    p = root / rel
    if not permitted(rel) or p.is_symlink() or not p.is_file():
        raise ValueError('excluded, symlink or missing file')
    # Refuse symlink ancestors even when checking an explicit manifest path.
    cursor = p.parent
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError('symlink ancestor')
        cursor = cursor.parent
    before = p.stat()
    if before.st_nlink != 1:
        raise ValueError('hard-linked file')
    data = p.read_bytes()
    after = p.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('file changed during read')
    return data

def dump(path, value, root):
    target = Path(path).resolve()
    if target == root or root in target.parents or target.is_symlink():
        raise ValueError('output must be outside source root and not a symlink')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--mode', choices=['candidate', 'artifact'], default='candidate')
    args = parser.parse_args()
    if Path(args.manifest).resolve() == Path(args.report).resolve():
        parser.error('manifest and report paths must differ')
    root = Path(args.root).resolve()
    if not root.is_dir() or '.goalmatic' in root.parts or any(p.startswith('nw-private') for p in root.parts):
        parser.error('root must be a public source candidate or export, never a private runtime root')
    for required in ('src', 'service'):
        directory = root / required
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('required source directory missing or symlinked')
    reference_path = Path(args.reference).resolve()
    if not permitted(reference_path.name) or '.goalmatic' in reference_path.parts or any(part.startswith('nw-private') for part in reference_path.parts):
        parser.error('reference must be public license metadata, never an environment or credential file')
    if args.mode == 'artifact' and not permitted(Path(args.manifest).name):
        parser.error('manifest must be public export metadata')
    reference_bytes = reference_path.read_bytes()
    reference = json.loads(reference_bytes)['files']
    files, excluded = inventory(root)
    issues, warnings, gm_refs, rows = [], [], [], []
    imports = []
    asset_index = json.loads(read_stable(root, 'src/assets/public-assets.index.json')).get('assets', {})
    wanted_assets = {'public' + path for path in asset_index}
    selected = set(reference) | (set(NEW_FILES) & set(files))
    # These are candidate rows requiring owner review, not publication approval.
    selected.update(p for p in files if p.startswith(('src/', 'service/')) and Path(p).suffix in CODE_SUFFIX)
    for required in sorted(REQUIRED_FILES):
        if required not in files or required not in selected:
            issues.append({'path': required, 'reason': 'required-standalone-input-missing-or-unselected'})
    if 'service/cloudflare/worker.ts' in files:
        for required in ('cloudflare-env.d.ts', 'tsconfig.worker.json'):
            if required not in files:
                issues.append({'path': required, 'reason': 'native-compiler-input-missing'})
    if 'service/homePhysical.ts' in files:
        for required in ('service/data/homes/yaba-homes.json', 'src/assets/homes/yaba-home-scene.json'):
            if required not in files:
                issues.append({'path': required, 'reason': 'home-runtime-data-missing'})
    expected_rows = {}
    if args.mode == 'artifact':
        supplied = json.loads(Path(args.manifest).read_text())['files']
        expected_rows = {row['target']: row for row in supplied}
        if len(expected_rows) != len(supplied):
            issues.append({'reason': 'duplicate-manifest-target'})
        selected = set(expected_rows)
        for entry in excluded:
            issues.append({**entry, 'reason': 'forbidden-export-entry'})
        for path in sorted(set(files) - selected - {'export-manifest.json'}):
            issues.append({'path': path, 'reason': 'unmanifested-export-file'})
        if 'export-manifest.json' not in files:
            issues.append({'path': 'export-manifest.json', 'reason': 'copied-export-manifest-missing'})
        elif digest(read_stable(root, 'export-manifest.json')) != digest(Path(args.manifest).read_bytes()):
            issues.append({'path': 'export-manifest.json', 'reason': 'copied-export-manifest-mismatch'})
    for path in sorted(selected):
        if not permitted(path):
            if args.mode == 'artifact':
                issues.append({'path': path, 'reason': 'forbidden-manifest-path'})
            continue
        if path not in files:
            issues.append({'path': path, 'reason': 'selected-file-missing'})
            continue
        if path in NEW_FILES:
            kind, licence, notices = NEW_FILES[path]
        elif path in reference:
            item = reference[path]
            kind, licence, notices = item['kind'], item['license'], item['notices']
        else:
            if not (path.startswith(('src/', 'service/')) and Path(path).suffix in CODE_SUFFIX):
                issues.append({'path': path, 'reason': 'unreviewed-file-license'})
                continue
            kind, licence, notices = 'source', 'Apache-2.0', ['LICENSE', 'NOTICE']
        if args.mode == 'artifact' and (expected_rows[path].get('license') != licence or set(expected_rows[path].get('notices', [])) != set(notices)):
            issues.append({'path': path, 'reason': 'license-or-notices-mismatch'})
        data = read_stable(root, path)
        check = data
        if path.endswith('.gz'):
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as packed:
                check = packed.read(64 * 1024 * 1024 + 1)
            if len(check) > 64 * 1024 * 1024:
                issues.append({'path': path, 'reason': 'decompressed-file-too-large'})
                continue
        text = check.decode('utf-8', errors='ignore') if Path(path).suffix in TEXT_SUFFIX or path.endswith('.gz') else ''
        findings = []
        for label, pattern in SECRETS:
            for match in pattern.finditer(text):
                findings.append({'path': path, 'reason': label, 'line': text.count('\n', 0, match.start()) + 1})
        if findings:
            issues.extend(findings)
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if re.search(r'Goalmatic|goalmatic\.site|GoalmaticAuth|GoalmaticApp', line):
                gm_refs.append({'path': path, 'line': number})
            if re.search('/' + r'Users/|/(?:private/)?tmp/nw-', line):
                issues.append({'path': path, 'reason': 'machine-specific-path', 'line': number})
        if Path(path).suffix in CODE_SUFFIX:
            for match in re.finditer(r'(?:from\s*|\bimport\s*|\bimport\(\s*|require\(\s*)[\"\'](\.{1,2}/[^\"\']+)[\"\']', text):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(path), match.group(1).split('?', 1)[0].split('#', 1)[0]))
                imports.append({'path': path, 'target': target})
        for notice in notices:
            if notice not in files or notice not in selected:
                issues.append({'path': path, 'reason': 'notice-missing-or-unselected', 'notice': notice})
        if path.startswith('public/') and path in reference and digest(data) != reference[path]['sha256']:
            issues.append({'path': path, 'reason': 'accepted-asset-bytes-changed-rights-review'})
        if path in wanted_assets:
            expected = asset_index['/' + path.removeprefix('public/')]
            if len(data) != expected['bytes'] or len(check) != expected['unpacked'] or digest(check) != expected['sha256']:
                issues.append({'path': path, 'reason': 'public-asset-manifest-mismatch'})
        rows.append({'root': 'project', 'path': path, 'target': path, 'kind': kind, 'license': licence, 'notices': notices, 'bytes': len(data), 'sha256': digest(data)})
    for path in sorted(wanted_assets - {row['target'] for row in rows}):
        issues.append({'path': path, 'reason': 'runtime-asset-not-selected-or-unreviewed'})
    targets = {row['target'] for row in rows}
    for entry in imports:
        candidates = [entry['target'], *[entry['target'] + suffix for suffix in ('.ts', '.js', '.mjs', '.vue', '.json')]]
        if not permitted(entry['target']) or not any(path in targets for path in candidates):
            issues.append({**entry, 'reason': 'relative-import-not-exported'})
    for needle, notice in [('yaba-homes.json', 'docs/ASSETS-LICENSES.md'), ('street-arrivals.json', 'docs/ASSETS-LICENSES.md'), ('street-arrivals.json', 'service/data/transport/NOTICE.md')]:
        if (('service/data/homes/yaba-homes.json' in files if needle == 'yaba-homes.json' else 'service/data/transport/street-arrivals.json' in files)
                and notice in files and needle not in read_stable(root, notice).decode()):
            issues.append({'path': notice, 'reason': 'derived-data-license-entry-missing', 'data': needle})
    if gm_refs:
        warnings.append({'reason': 'Goalmatic-reference-review', 'count': len(gm_refs), 'note': 'Review product/runtime dependency separately from historical source notices.'})
    manifest = {'schema': 1, 'sourceRevision': 'final-root-content-addressed', 'policy': 'Candidate explicit file rows require root review. No source copied. Private paths rejected before contents are read.', 'files': rows, 'exclusions': excluded}
    tree = digest(''.join(f"{row['target']}\0{row['sha256']}\n" for row in rows).encode())
    report = {'schema': 1, 'mode': args.mode, 'selectedFiles': len(rows), 'selectedTreeSha256': tree, 'referenceSha256': digest(reference_bytes), 'excludedEntries': excluded, 'issues': issues, 'warnings': warnings, 'goalmaticReferenceLocations': gm_refs, 'accepted': not issues, 'limitations': 'Known-pattern scan only. Accepted public files are hashed without image viewing. Unknown photos or secrets with innocent names cannot be ruled out automatically. Root must freeze/review final source and retain license notices.'}
    if args.mode == 'candidate':
        dump(args.manifest, manifest, root)
    else:
        expected = {path: row['sha256'] for path, row in expected_rows.items()}
        for row in rows:
            if row['sha256'] != expected[row['target']]:
                report['issues'].append({'path': row['target'], 'reason': 'export-byte-hash-mismatch'})
        report['accepted'] = not report['issues']
    dump(args.report, report, root)
    print(json.dumps({'selectedFiles': len(rows), 'treeSha256': tree, 'issues': len(report['issues']), 'accepted': report['accepted']}))
    return 0 if report['accepted'] else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({'accepted': False, 'error': type(error).__name__, 'reason': 'Audit input or filesystem operation failed; no source changed.'}), file=sys.stderr)
        sys.exit(2)
