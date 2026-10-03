#!/usr/bin/env python3
"""Verify an allworld-source.tar.gz and optionally extract it into a new folder.

Uses Python's standard library. All paths are arguments. The archive is untrusted input: every
member is checked before any byte is written, nothing is executed, and dependencies are never
copied. With --dry-run nothing is written at all.
"""
import argparse
import ctypes
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile

MAX_FILES = 5000
MAX_MEMBER = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024


def load_audit():
    spec = importlib.util.spec_from_file_location('source_export_audit', Path(__file__).with_name('source-export-audit.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fail(reason):
    raise ValueError(reason)


def private_part(part):
    return part == '.goalmatic' or part.startswith('nw-private')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def rename_new(source, target):
    # Refuse replacement in the syscall itself, including a racing empty directory.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(os.fsencode(source), os.fsencode(target), 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith('linux') and hasattr(libc, 'renameat2'):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        result = rename(-100, os.fsencode(source), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    else:
        fail('no-atomic-no-replace-rename-on-this-platform')
    if result:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            fail('destination-appeared')
        raise OSError(code, 'atomic no-replace rename failed')


def check_member(audit, member, seen):
    name = member.name
    parts = PurePosixPath(name)
    if not member.isreg():
        fail('non-regular-member')
    if member.pax_headers or member.linkname:
        fail('unexpected-member-metadata')
    if parts.is_absolute() or '..' in parts.parts or '.' in parts.parts or name != parts.as_posix() or name.endswith('/'):
        fail('unsafe-member-path')
    if name in seen:
        fail('duplicate-member')
    if name != 'export-manifest.json' and not audit.permitted(name):
        fail('forbidden-member-path')
    if member.size > MAX_MEMBER:
        fail('member-too-large')
    seen.add(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--expect-archive', required=True, help='SHA256 of the archive, recorded when it was exported')
    parser.add_argument('--expect-tree', required=True, help='Reviewed selectedTreeSha256')
    parser.add_argument('--expect-manifest', required=True, help='Reviewed manifestSha256 (pins license and notice rows)')
    parser.add_argument('--dest', help='New folder to extract into; omit with --dry-run')
    parser.add_argument('--source-root', required=True, help='Source root the archive came from; the destination must not overlap it')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    for label, value in (('expect-archive', args.expect_archive), ('expect-tree', args.expect_tree), ('expect-manifest', args.expect_manifest)):
        if value is not None and (len(value) != 64 or any(c not in '0123456789abcdef' for c in value)):
            parser.error(f'--{label} must be a lowercase SHA256')
    if bool(args.dest) == args.dry_run:
        parser.error('Give exactly one of --dest or --dry-run')
    audit = load_audit()
    archive = Path(args.archive)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_nlink != 1 or any(private_part(p) for p in archive.resolve().parts):
        fail('archive-not-a-public-regular-file')
    raw = archive.read_bytes()
    if sha(raw) != args.expect_archive:
        fail('archive-sha256-differs')
    members, data, seen, total = [], {}, set(), 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tar:
        for member in tar:
            if len(members) >= MAX_FILES:
                fail('too-many-members')
            check_member(audit, member, seen)
            body = tar.extractfile(member).read(MAX_MEMBER + 1)
            total += len(body)
            if len(body) != member.size or total > MAX_TOTAL:
                fail('member-size-differs-or-total-too-large')
            members.append(member.name)
            data[member.name] = body
    if 'export-manifest.json' not in data:
        fail('manifest-missing')
    manifest_bytes = data['export-manifest.json']
    if args.expect_manifest and sha(manifest_bytes) != args.expect_manifest:
        fail('manifest-sha256-differs')
    rows = json.loads(manifest_bytes)['files']
    targets = [row['target'] for row in rows]
    if len(set(targets)) != len(targets) or set(targets) != set(data) - {'export-manifest.json'}:
        fail('member-set-differs-from-manifest')
    for row in rows:
        body = data[row['target']]
        if len(body) != row['bytes'] or sha(body) != row['sha256']:
            fail('member-bytes-differ-from-manifest')
    tree = sha(''.join(f"{row['target']}\0{row['sha256']}\n" for row in sorted(rows, key=lambda r: r['target'])).encode())
    if tree != args.expect_tree:
        fail('selected-tree-differs')
    result = {'verified': True, 'files': len(rows), 'selectedTreeSha256': tree, 'manifestSha256': sha(manifest_bytes), 'archiveSha256': args.expect_archive, 'extracted': False, 'durability': 'not-installed'}
    if args.dest:
        dest = Path(args.dest)
        if os.path.lexists(dest):
            fail('destination-exists')
        parent = dest.parent.resolve(strict=True)
        final = parent / dest.name
        if any(private_part(p) for p in final.parts):
            fail('private-destination')
        if args.source_root:
            source = Path(args.source_root).resolve(strict=True)
            if final == source or source in final.parents or final in source.parents:
                fail('destination-overlaps-source')
        stage = Path(tempfile.mkdtemp(prefix='.allworld-extract-', dir=parent))
        try:
            for name in sorted(data):
                target = stage / name
                if stage.resolve() not in target.resolve(strict=False).parents:
                    fail('member-escapes-destination')
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with target.open('xb') as out:
                    out.write(data[name])
                    out.flush()
                    os.fchmod(out.fileno(), 0o644)
                    os.fsync(out.fileno())
            for name, body in data.items():
                path = stage / name
                if path.is_symlink() or not path.is_file() or sha(path.read_bytes()) != sha(body):
                    fail('written-bytes-differ')
            if os.path.lexists(final):
                fail('destination-appeared')
            for directory, _, _ in os.walk(stage, topdown=False):
                sync_directory(directory)
            rename_new(stage, final)
            stage = None
            sync_directory(parent)
            for name, body in data.items():
                path = final / name
                if path.is_symlink() or not path.is_file() or sha(path.read_bytes()) != sha(body):
                    fail('installed-bytes-differ')
        finally:
            if stage is not None:
                shutil.rmtree(stage, ignore_errors=True)
        result['extracted'] = True
        result['durability'] = 'files-and-directories-fsynced'
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, json.JSONDecodeError, tarfile.TarError, EOFError) as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'verified': False, 'reason': reason}), file=sys.stderr)
        sys.exit(1)
