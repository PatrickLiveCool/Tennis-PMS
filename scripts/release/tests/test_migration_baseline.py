"""Bootstrap reads the committed SQL baseline, not mutable checkout content."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "migration-baseline.mjs"


class MigrationBaselineTests(unittest.TestCase):
    def test_git_baseline_ignores_uncommitted_changes_and_sorts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, env=environment, check=True, capture_output=True)
            git("init", "-q")
            migrations = root / "packages/db/src/tennis/migrations"
            migrations.mkdir(parents=True)
            (migrations / "002_next.sql").write_bytes(b"SELECT 2;\n")
            (migrations / "001_initial.sql").write_bytes(b"SELECT 1;\n")
            git("add", ".")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture")
            (migrations / "001_initial.sql").write_bytes(b"uncommitted edit")
            (migrations / "003_untracked.sql").write_bytes(b"untracked")
            result = subprocess.run(["node", str(SCRIPT), "--git", "HEAD"], cwd=root, env=environment,
                                    check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(result.stdout), [
                {"name": "001_initial.sql", "sha256": hashlib.sha256(b"SELECT 1;\n").hexdigest()},
                {"name": "002_next.sql", "sha256": hashlib.sha256(b"SELECT 2;\n").hexdigest()}])

    def test_unknown_modes_and_options_are_rejected(self):
        for args in ([], ["--git", "--help"], ["--image", "unexpected"], ["--arbitrary-path", "/tmp"]):
            with self.subTest(args=args):
                result = subprocess.run(["node", str(SCRIPT), *args], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
