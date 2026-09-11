"""Restore exact Unity files before uploading the GitHub Pages artifact."""
import hashlib
import json
import sys
from pathlib import Path


def child(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError('Build path escapes its directory')
    return path


def assemble(repo, output=None):
    repo = Path(repo).resolve()
    site = Path(output).resolve() if output else repo / 'site'
    for entry in json.loads((repo / 'build-parts.json').read_text()):
        destination = child(site, entry['path'])
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(destination.name + '.assembling')
        digest, size = hashlib.sha256(), 0
        try:
            with temporary.open('wb') as target:
                for name in entry['parts']:
                    with child(repo / 'build-parts', name).open('rb') as source:
                        while data := source.read(1024 * 1024):
                            target.write(data)
                            digest.update(data)
                            size += len(data)
            if size != entry['size'] or digest.hexdigest() != entry['sha256']:
                raise ValueError(f'Build checksum mismatch: {entry["path"]}')
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        print(f'Verified {entry["path"]}: {size} bytes')


if __name__ == '__main__':
    assemble(Path(__file__).resolve().parents[1], sys.argv[1] if len(sys.argv) > 1 else None)
