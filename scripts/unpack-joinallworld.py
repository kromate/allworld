import pathlib
import sys
import tarfile

archive, destination = sys.argv[1:]
root = pathlib.Path(destination)
root.mkdir()
with tarfile.open(archive) as source:
    members = source.getmembers()
    if len(members) > 1000 or sum(item.size for item in members) > 50 * 1024 * 1024:
        raise ValueError('Package size limit')
    for item in members:
        path = pathlib.PurePosixPath(item.name)
        if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
            raise ValueError('Unsafe package entry')
    source.extractall(root, members=members, filter='data')
