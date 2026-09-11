"""Copy a successful Unity build; store large assets as Git-sized parts."""
import hashlib
import json
import shutil
import sys
from pathlib import Path


def prepare(source, repo, part_size=48 * 1024 * 1024):
    source, repo = Path(source).resolve(), Path(repo).resolve()
    assert json.loads((source / 'build-info.json').read_text())['result'] == 'Succeeded'
    assert (source / 'index.html').is_file()
    site, parts = repo / 'site', repo / 'build-parts'
    assert not source.is_relative_to(site) and not source.is_relative_to(parts)
    for destination in (site, parts):
        if destination.exists():
            shutil.rmtree(destination)
    shutil.copytree(source, site)
    parts.mkdir()
    manifest = []
    for asset in sorted(site.rglob('*')):
        if not asset.is_file() or asset.stat().st_size <= part_size:
            continue
        relative = asset.relative_to(site).as_posix()
        prefix = hashlib.sha256(relative.encode()).hexdigest()[:16]
        entry = {'path': relative, 'size': asset.stat().st_size, 'sha256': '', 'parts': []}
        digest = hashlib.sha256()
        with asset.open('rb') as stream:
            while data := stream.read(part_size):
                name = f'{prefix}.{len(entry["parts"]):03d}.part'
                (parts / name).write_bytes(data)
                digest.update(data)
                entry['parts'].append(name)
        entry['sha256'] = digest.hexdigest()
        manifest.append(entry)
        asset.unlink()
    (repo / 'build-parts.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Prepared build: {len(manifest)} large file(s) split for Git storage.')


if __name__ == '__main__':
    prepare(sys.argv[1], Path(__file__).resolve().parents[1])
