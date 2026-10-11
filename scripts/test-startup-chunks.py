"""Checks for exact Unity bytes, conservative refusal and atomic manifest updates."""

import gzip
import hashlib
import json
from pathlib import Path
import random
import struct
import tempfile
import unittest
from unittest.mock import patch

import importlib.util
spec = importlib.util.spec_from_file_location("startup_chunks", Path(__file__).with_name("generate-startup-chunks.py"))
chunks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chunks)


class StartupChunksTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.site = Path(self.tmp.name) / "site"
        self.site.mkdir()
        self.originals = {}
        self.expanded = {}
        self.urls = {}
        randomizer = random.Random(3927)
        for index, suffix in enumerate(chunks.SUFFIXES):
            raw = bytes(randomizer.randrange(256) for _ in range(550 + index * 100))
            data = gzip.compress(raw, mtime=0)
            relative = f"Build/UnityTrial/HiplinTownWebGL.{suffix}.unityweb"
            path = self.site / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            self.originals[suffix] = data
            self.expanded[suffix] = raw
            self.urls[suffix] = relative + "?v=" + hashlib.sha256(data).hexdigest()
        self.write_html()
        (self.site / "unrelated.txt").write_bytes(b"keep this")

    def size_map(self):
        return {self.urls[suffix]: len(self.expanded[suffix]) for suffix in chunks.SUFFIXES}

    def write_html(self, sizes=None, extra=""):
        sizes = self.size_map() if sizes is None else sizes
        html = (
            "<script>\n" + chunks.BEGIN + "\n"
            "var restoreStartupDownloads = function () {};\n"
            'if (deviceBuild === "astc") {\n'
            "restoreStartupDownloads = window.HiplinStartupDownloads.install(config, "
            + json.dumps(sizes, indent=2) + extra + ");\n}\n"
            + chunks.END + "\n</script>"
        )
        (self.site / "graphics-trial.html").write_text(html)

    def source_path(self, suffix):
        return self.site / self.urls[suffix].split("?", 1)[0]

    def replace_original(self, suffix, data):
        self.source_path(suffix).write_bytes(data)
        self.urls[suffix] = self.urls[suffix].split("?", 1)[0] + "?v=" + hashlib.sha256(data).hexdigest()
        self.write_html()

    def assert_no_outputs(self):
        self.assertFalse((self.site / chunks.MANIFEST).exists())
        self.assertFalse((self.site / "startup").exists())

    def test_chunk_sizes_digests_and_exact_reassembly(self):
        before = {p.relative_to(self.site): p.read_bytes() for p in self.site.rglob("*") if p.is_file()}
        manifest = chunks.generate(self.site, chunk_bytes=128)
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(len(manifest["assets"]), 3)
        for suffix, asset in zip(chunks.SUFFIXES, manifest["assets"]):
            self.assertEqual(asset["url"], self.urls[suffix])
            self.assertEqual(asset["expandedBytes"], len(self.expanded[suffix]))
            self.assertEqual(asset["compressedBytes"], len(self.originals[suffix]))
            reassembled = bytearray()
            for index, chunk in enumerate(asset["chunks"]):
                data = (self.site / chunk["url"]).read_bytes()
                self.assertEqual(chunk["bytes"], len(data))
                self.assertLessEqual(len(data), 128)
                if index < len(asset["chunks"]) - 1:
                    self.assertEqual(len(data), 128)
                self.assertEqual(chunk["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(chunk["url"], f"startup/{asset['sha256']}/{index:03d}-{chunk['sha256']}.bin")
                reassembled.extend(data)
            self.assertEqual(bytes(reassembled), self.originals[suffix])
            self.assertEqual(gzip.decompress(reassembled), self.expanded[suffix])
        self.assertEqual(json.loads((self.site / chunks.MANIFEST).read_text()), manifest)
        for path, content in before.items():
            self.assertEqual((self.site / path).read_bytes(), content)

    def test_default_is_four_mib_and_small_assets_remain_single_chunks(self):
        self.assertEqual(chunks.CHUNK_BYTES, 4 * 1024 * 1024)
        manifest = chunks.generate(self.site)
        self.assertTrue(all(len(asset["chunks"]) == 1 for asset in manifest["assets"]))

    def test_idempotent_and_optional_installer_argument(self):
        self.write_html(extra=", window")
        first = chunks.generate(self.site, chunk_bytes=128)
        before = {p.relative_to(self.site): (p.read_bytes(), p.stat().st_mtime_ns)
                  for p in self.site.rglob("*") if p.is_file()}
        self.assertEqual(chunks.generate(self.site, chunk_bytes=128), first)
        after = {p.relative_to(self.site): (p.read_bytes(), p.stat().st_mtime_ns)
                 for p in self.site.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_stale_original_or_url_hash_rejected_before_writes(self):
        self.source_path("data").write_bytes(gzip.compress(b"changed", mtime=0))
        with self.assertRaises(ValueError):
            chunks.generate(self.site)
        self.assert_no_outputs()
        self.source_path("data").write_bytes(self.originals["data"])
        sizes = self.size_map()
        size = sizes.pop(self.urls["data"])
        sizes[self.urls["data"].split("?", 1)[0] + "?v=" + "0" * 64] = size
        self.write_html(sizes)
        with self.assertRaisesRegex(ValueError, "SHA"):
            chunks.generate(self.site)
        self.assert_no_outputs()

    def test_bad_gzip_trailer_rejected_even_with_matching_url_sha(self):
        bad = self.originals["data"][:-4] + struct.pack("<I", len(self.expanded["data"]) + 1)
        self.replace_original("data", bad)
        with self.assertRaisesRegex(ValueError, "trailer"):
            chunks.generate(self.site)
        self.assert_no_outputs()

    def test_bad_gzip_crc_rejected_even_with_matching_url_sha(self):
        bad = bytearray(self.originals["data"])
        bad[-8] ^= 1
        self.replace_original("data", bytes(bad))
        with self.assertRaisesRegex(ValueError, "gzip"):
            chunks.generate(self.site)
        self.assert_no_outputs()

    def test_unsafe_or_other_origin_urls_rejected(self):
        unsafe = [
            "../Build/UnityTrial/HiplinTownWebGL.data.unityweb",
            "/Build/UnityTrial/HiplinTownWebGL.data.unityweb",
            "https://example.org/Build/UnityTrial/HiplinTownWebGL.data.unityweb",
            "//example.org/Build/UnityTrial/HiplinTownWebGL.data.unityweb",
            "Build/UnityTrial/../HiplinTownWebGL.data.unityweb",
            "Build/UnityTrial/%2e%2e/HiplinTownWebGL.data.unityweb",
            "Build/Mobile/HiplinTownWebGL.data.unityweb",
            "Build\\UnityTrial\\HiplinTownWebGL.data.unityweb",
        ]
        for url in unsafe:
            with self.subTest(url=url):
                sizes = self.size_map()
                size = sizes.pop(self.urls["data"])
                sizes[url + "?v=" + "a" * 64] = size
                self.write_html(sizes)
                with self.assertRaises(ValueError):
                    chunks.generate(self.site)
                self.assert_no_outputs()

    def test_invalid_html_markers_calls_and_maps_rejected(self):
        path = self.site / "graphics-trial.html"
        original = path.read_text()
        bad_html = [
            original.replace(chunks.BEGIN, ""), original + original,
            original.replace(chunks.BEGIN, "TEMP_BEGIN").replace(chunks.END, chunks.BEGIN).replace("TEMP_BEGIN", chunks.END),
            original.replace("install(config,", "install(other,"),
            original.replace("window.HiplinStartupDownloads.install", "somethingElse"),
            original.replace('"Build/UnityTrial/', "'Build/UnityTrial/", 1),
        ]
        for value in bad_html:
            with self.subTest(html=value[:100]):
                path.write_text(value)
                with self.assertRaises(ValueError):
                    chunks.generate(self.site)
                self.assert_no_outputs()
        for bad_size in (0, -1, True, "550", 1.5, chunks.MAX_EXPANDED_BYTES + 1):
            sizes = self.size_map()
            sizes[self.urls["data"]] = bad_size
            self.write_html(sizes)
            with self.assertRaises(ValueError):
                chunks.generate(self.site)
        sizes = self.size_map()
        del sizes[self.urls["wasm"]]
        self.write_html(sizes)
        with self.assertRaises(ValueError):
            chunks.generate(self.site)

    def test_duplicate_json_key_rejected(self):
        path = self.site / "graphics-trial.html"
        text = path.read_text()
        pair = json.dumps(self.urls["data"]) + ": " + str(len(self.expanded["data"]))
        path.write_text(text.replace(pair, pair + ",\n" + pair))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            chunks.generate(self.site)
        self.assert_no_outputs()

    def test_symlink_input_output_or_unrelated_site_file_rejected(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        for relative in ("startup", "unrelated-link"):
            path = self.site / relative
            path.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                chunks.generate(self.site)
            path.unlink()
            self.assert_no_outputs()
        original = self.source_path("data")
        target = outside / "data.gz"
        target.write_bytes(original.read_bytes())
        original.unlink()
        original.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "symlink"):
            chunks.generate(self.site)
        self.assert_no_outputs()

    def test_projected_budget_includes_existing_assets_chunks_and_manifest(self):
        original_sizes = sum(chunks.site_sizes(self.site).values())
        manifest = chunks.generate(self.site, chunk_bytes=128)
        manifest_bytes = (self.site / chunks.MANIFEST).stat().st_size
        added = sum(a["compressedBytes"] for a in manifest["assets"]) + manifest_bytes
        projected = original_sizes + added
        self.assertEqual(sum(chunks.site_sizes(self.site).values()), projected)
        # Equal to the cap is refused, even on an idempotent rerun.
        with patch.object(chunks, "MAX_SITE_BYTES", projected):
            with self.assertRaisesRegex(ValueError, "Projected site"):
                chunks.generate(self.site, chunk_bytes=128)
        with patch.object(chunks, "MAX_SITE_BYTES", projected + 1):
            self.assertEqual(chunks.generate(self.site, chunk_bytes=128), manifest)

    def test_over_budget_fresh_site_does_not_write_chunks_or_manifest(self):
        with patch.object(chunks, "MAX_SITE_BYTES", sum(chunks.site_sizes(self.site).values()) + 1):
            with self.assertRaisesRegex(ValueError, "Projected site"):
                chunks.generate(self.site)
        self.assert_no_outputs()

    def test_corrupt_existing_chunk_refused_without_replacing_manifest(self):
        manifest = chunks.generate(self.site, chunk_bytes=128)
        old = (self.site / chunks.MANIFEST).read_bytes()
        chunk = self.site / manifest["assets"][0]["chunks"][0]["url"]
        chunk.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "Existing startup chunk"):
            chunks.generate(self.site, chunk_bytes=128)
        self.assertEqual((self.site / chunks.MANIFEST).read_bytes(), old)
        self.assertEqual(chunk.read_bytes(), b"corrupt")

    def test_write_failure_preserves_prior_manifest_and_unrelated_files(self):
        old = b'{"previous":true}\n'
        (self.site / chunks.MANIFEST).write_bytes(old)
        actual = chunks.atomic_write
        count = 0

        def fail_second(path, data):
            nonlocal count
            count += 1
            if count == 2:
                raise OSError("simulated disk failure")
            actual(path, data)

        with patch.object(chunks, "atomic_write", side_effect=fail_second):
            with self.assertRaises(OSError):
                chunks.generate(self.site, chunk_bytes=128)
        self.assertEqual((self.site / chunks.MANIFEST).read_bytes(), old)
        self.assertEqual((self.site / "unrelated.txt").read_bytes(), b"keep this")
        self.assertFalse(list(self.site.rglob("*.tmp")))
        # Verified chunks from an interrupted run are safely reused.
        chunks.generate(self.site, chunk_bytes=128)
        self.assertEqual(json.loads((self.site / chunks.MANIFEST).read_text())["schemaVersion"], 1)

    def test_source_change_between_preflight_and_write_keeps_old_manifest(self):
        old = b'{"previous":true}\n'
        (self.site / chunks.MANIFEST).write_bytes(old)
        actual = chunks.inspect_asset
        count = 0

        def change_after_inspection(*args):
            nonlocal count
            result = actual(*args)
            count += 1
            if count == 3:
                self.source_path("data").write_bytes(b"changed after verification")
            return result

        with patch.object(chunks, "inspect_asset", side_effect=change_after_inspection):
            with self.assertRaisesRegex(ValueError, "original changed"):
                chunks.generate(self.site, chunk_bytes=128)
        self.assertEqual((self.site / chunks.MANIFEST).read_bytes(), old)


if __name__ == "__main__":
    unittest.main()
