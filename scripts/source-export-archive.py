#!/usr/bin/env python3
"""Pack manifest-selected regular files, then verify every archived byte."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import tarfile

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output)
    manifest_bytes = Path(args.manifest).read_bytes()
    manifest = json.loads(manifest_bytes)
    expected = {row['target']: row['sha256'] for row in manifest['files']}
    expected['export-manifest.json'] = sha(manifest_bytes)
    if output.exists() or output.is_symlink():
        raise ValueError('Archive output already exists')
    for name, checksum in expected.items():
        path = root / name
        if path.is_symlink() or not path.is_file() or root not in path.resolve().parents or sha(path.read_bytes()) != checksum:
            raise ValueError('Selected export bytes do not match the manifest')
    with output.open('xb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(expected):
                    path = root / name
                    info = tarfile.TarInfo(name)
                    info.size = path.stat().st_size
                    info.mode, info.uid, info.gid, info.mtime = 0o644, 0, 0, 0
                    info.uname = info.gname = ''
                    with path.open('rb') as source:
                        archive.addfile(info, source)
    with tarfile.open(output, 'r:gz') as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {m.name for m in members} != set(expected):
            raise ValueError('Archive member set differs')
        for member in members:
            if not member.isfile() or member.uid != 0 or member.gid != 0 or member.mtime != 0:
                raise ValueError('Unexpected archive metadata')
            if sha(archive.extractfile(member).read()) != expected[member.name]:
                raise ValueError('Archived byte hash differs')
    print(json.dumps({'archiveSha256': sha(output.read_bytes()), 'archiveBytes': output.stat().st_size, 'files': len(expected), 'verified': True}))

if __name__ == '__main__':
    main()
