"""Generate verified, cacheable startup chunks without changing Unity build bytes.

Copy this standalone script to the Pages repository and run it after the existing
verified build assembly: python3 scripts/generate-startup-chunks.py site
"""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import tempfile
import zlib


CHUNK_BYTES = 4 * 1024 * 1024
MAX_SITE_BYTES = 1_000_000_000
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
BEGIN = "// HIPLIN streamed startup begin"
END = "// HIPLIN streamed startup end"
MANIFEST = "hiplin-startup-manifest.json"
SUFFIXES = ("data", "framework.js", "wasm")
ASSET_URL = re.compile(
    r"Build/UnityTrial/HiplinTownWebGL\.(data|framework\.js|wasm)"
    r"\.unityweb\?v=([0-9a-f]{64})\Z"
)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate startup asset URL")
        result[key] = value
    return result


def startup_assets(html):
    """Read the existing generated size map as JSON, never execute page scripts."""
    if html.count(BEGIN) != 1 or html.count(END) != 1:
        raise ValueError("Expected one streamed startup HTML block")
    start, end = html.index(BEGIN) + len(BEGIN), html.index(END)
    if end <= start:
        raise ValueError("Invalid streamed startup HTML block")
    block = html[start:end]
    calls = re.findall(
        r"window\.HiplinStartupDownloads\.install\s*\(\s*config\s*,"
        r"\s*(\{[^{}]*\})\s*(?=[,)])", block
    )
    if len(calls) != 1 or block.count("HiplinStartupDownloads.install") != 1:
        raise ValueError("Expected one startup install size map")
    try:
        sizes = json.loads(calls[0], object_pairs_hook=unique_object)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError("Invalid startup install size map") from error
    if len(sizes) != 3:
        raise ValueError("Expected exactly three HQ startup assets")
    assets = {}
    for url, size in sizes.items():
        match = ASSET_URL.fullmatch(url)
        if not match:
            raise ValueError("Unsafe or unsupported HQ startup asset URL")
        if type(size) is not int or not 0 < size <= MAX_EXPANDED_BYTES:
            raise ValueError("Invalid expanded startup asset size")
        suffix, sha256 = match.groups()
        if suffix in assets:
            raise ValueError("Duplicate HQ startup asset type")
        assets[suffix] = {"url": url, "sha256": sha256, "expandedBytes": size}
    if set(assets) != set(SUFFIXES):
        raise ValueError("Expected data, framework and WASM startup assets")
    return [assets[suffix] for suffix in SUFFIXES]


def child(site, relative):
    """Reject both lexical traversal and any existing symlink in the path."""
    path = Path(relative)
    if path.is_absolute() or not path.parts or any(p in (".", "..") for p in path.parts):
        raise ValueError("Unsafe site path")
    current = site
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Site paths must not contain symlinks")
    if not current.resolve().is_relative_to(site):
        raise ValueError("Site path escapes its directory")
    return current


def site_sizes(site):
    sizes = {}
    for directory, directories, files in os.walk(site, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("Site must not contain symlinks")
        for name in files:
            path = Path(directory) / name
            if not path.is_file():
                raise ValueError("Site contains a non-regular file")
            sizes[path.relative_to(site).as_posix()] = path.stat().st_size
    return sizes


def fingerprint(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while data := source.read(CHUNK_BYTES):
            digest.update(data)
            size += len(data)
    return size, digest.hexdigest()


def inspect_asset(site, asset, chunk_bytes):
    path = child(site, asset["url"].split("?", 1)[0])
    digest, compressed, chunks = hashlib.sha256(), 0, []
    with path.open("rb") as source:
        header = source.read(3)
        if header != b"\x1f\x8b\x08":
            raise ValueError("Startup asset is not gzip")
        source.seek(-4, os.SEEK_END)
        if struct.unpack("<I", source.read(4))[0] != asset["expandedBytes"]:
            raise ValueError("Gzip trailer does not match expanded size")
        source.seek(0)
        while data := source.read(chunk_bytes):
            sha256 = hashlib.sha256(data).hexdigest()
            chunks.append({
                "url": f"startup/{asset['sha256']}/{len(chunks):03d}-{sha256}.bin",
                "sha256": sha256,
                "bytes": len(data),
            })
            digest.update(data)
            compressed += len(data)
    if digest.hexdigest() != asset["sha256"]:
        raise ValueError("Startup asset SHA does not match its HTML URL")
    # Reading the stream verifies its CRC as well as its declared ISIZE. This
    # never retains the full inflated data archive in Python memory.
    expanded = 0
    try:
        with gzip.open(path, "rb") as source:
            while data := source.read(CHUNK_BYTES):
                expanded += len(data)
                if expanded > asset["expandedBytes"]:
                    raise ValueError("Gzip expands beyond its verified size")
    except (OSError, EOFError, zlib.error) as error:
        raise ValueError("Invalid gzip startup asset") from error
    if expanded != asset["expandedBytes"]:
        raise ValueError("Gzip expanded size does not match HTML")
    return {
        "url": asset["url"], "sha256": asset["sha256"],
        "compressedBytes": compressed, "expandedBytes": expanded, "chunks": chunks,
    }


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix="." + path.name + ".", suffix=".tmp", delete=False
        ) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o644)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def generate(site, *, chunk_bytes=CHUNK_BYTES):
    if type(chunk_bytes) is not int or not 0 < chunk_bytes <= CHUNK_BYTES:
        raise ValueError("Invalid startup chunk size")
    site = Path(site)
    if site.is_symlink() or not site.is_dir():
        raise ValueError("Site must be an existing directory without a symlink")
    site = site.resolve()
    sizes = site_sizes(site)
    assets = startup_assets(child(site, "graphics-trial.html").read_text(encoding="utf-8"))
    manifest = {"schemaVersion": 1, "assets": [
        inspect_asset(site, asset, chunk_bytes) for asset in assets
    ]}
    encoded = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    projected = sum(sizes.values()) + len(encoded) - sizes.get(MANIFEST, 0)
    manifest_path = child(site, MANIFEST)
    if manifest_path.exists() and not manifest_path.is_file():
        raise ValueError("Manifest destination is not a regular file")
    destinations = {chunk["url"]: chunk for asset in manifest["assets"] for chunk in asset["chunks"]}
    for relative, chunk in destinations.items():
        path = child(site, relative)
        if path.exists():
            if not path.is_file() or fingerprint(path) != (chunk["bytes"], chunk["sha256"]):
                raise ValueError("Existing startup chunk does not match its content hash")
        projected += chunk["bytes"] - sizes.get(relative, 0)
    if projected >= MAX_SITE_BYTES:
        raise ValueError(f"Projected site is {projected} bytes; must be below {MAX_SITE_BYTES}")

    # Write only after the entire plan passes. Recheck original bytes while
    # producing the chunks, and publish the complete manifest as the final step.
    for asset in manifest["assets"]:
        source_path = child(site, asset["url"].split("?", 1)[0])
        with source_path.open("rb") as source:
            for chunk in asset["chunks"]:
                data = source.read(chunk["bytes"])
                if len(data) != chunk["bytes"] or hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                    raise ValueError("Startup original changed during chunk generation")
                path = child(site, chunk["url"])
                if not path.exists():
                    atomic_write(path, data)
            if source.read(1):
                raise ValueError("Startup original grew during chunk generation")
    if not manifest_path.exists() or manifest_path.read_bytes() != encoded:
        atomic_write(manifest_path, encoded)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    args = parser.parse_args()
    manifest = generate(args.site)
    count = sum(len(asset["chunks"]) for asset in manifest["assets"])
    print(f"Verified {len(manifest['assets'])} startup assets in {count} chunks; originals retained.")


if __name__ == "__main__":
    main()
