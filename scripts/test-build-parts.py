import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


prepare = module('prepare-build').prepare
assemble = module('assemble-build').assemble


class BuildPartsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source, self.repo = self.base / 'source', self.base / 'repo'
        (self.source / 'Build').mkdir(parents=True)
        self.repo.mkdir()
        (self.source / 'index.html').write_text('game')
        (self.source / 'build-info.json').write_text('{"result":"Succeeded"}')
        self.data = bytes(range(256)) * 3 + b'last partial chunk'
        (self.source / 'Build/game.data').write_bytes(self.data)
        prepare(self.source, self.repo, part_size=256)

    def test_round_trip_and_original_preserved(self):
        self.assertFalse((self.repo / 'site/Build/game.data').exists())
        assemble(self.repo)
        for original in self.source.rglob('*'):
            if original.is_file():
                self.assertEqual(original.read_bytes(), (self.repo / 'site' / original.relative_to(self.source)).read_bytes())

    def test_corrupt_part_fails_without_replacing_existing_output(self):
        target = self.repo / 'site/Build/game.data'
        target.write_bytes(b'prior verified output')
        next((self.repo / 'build-parts').glob('*.part')).write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            assemble(self.repo)
        self.assertEqual(target.read_bytes(), b'prior verified output')
        self.assertFalse(target.with_name(target.name + '.assembling').exists())

    def test_missing_part_fails(self):
        next((self.repo / 'build-parts').glob('*.part')).unlink()
        with self.assertRaises(FileNotFoundError):
            assemble(self.repo)

    def test_escape_path_rejected(self):
        manifest = self.repo / 'build-parts.json'
        entries = json.loads(manifest.read_text())
        entries[0]['path'] = '../outside'
        manifest.write_text(json.dumps(entries))
        with self.assertRaises(ValueError):
            assemble(self.repo)


if __name__ == '__main__':
    unittest.main()
