"""A workflow retry must reuse verified bytes or stop before a fresh upload."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from scripts.release.common import FILES, ReleaseError, json_bytes
from scripts.release.cos import fetch_bundle
from scripts.release.tests.test_cos import FakeCos, complete_store
from scripts.release.tests.test_package import VERSION, REVISION, docker_archive, manifest


class FetchRetryTests(unittest.TestCase):
    def bundle(self, *, forbidden=False):
        fake = FakeCos()
        current = manifest()
        # The scanner accepts plain Docker tar as well as zstd; this fixture
        # exercises actual layer/label checks without requiring a compressor.
        archive = docker_archive(current, layer_name="app/.env" if forbidden else "app/runtime.js")
        sbom = json_bytes({"spdxVersion": "SPDX-2.3"})
        current["archiveSha256"] = hashlib.sha256(archive).hexdigest()
        current["sbomSha256"] = hashlib.sha256(sbom).hexdigest()
        values = {FILES[0]: archive, "sbom.spdx.json": sbom, "manifest.json": json_bytes(current)}
        values["SHA256SUMS"] = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n"
                                         for name, data in values.items()).encode()
        prefix = f"tennis-green-pms/releases/{VERSION}/{REVISION}/"
        fake.objects = {prefix + name: data for name, data in values.items()}
        return fake, prefix, values

    def test_complete_retry_reuses_exact_bytes_without_writes(self):
        fake, _, expected = self.bundle()
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "bundle"
            result = fetch_bundle(complete_store(fake, role="UPLOAD"), VERSION, REVISION, destination)
            self.assertEqual(result, 0)
            self.assertEqual({path.name: path.read_bytes() for path in destination.iterdir()}, expected)
        self.assertFalse(fake.put_calls)
        self.assertFalse(fake.delete_calls)

    def test_deployed_release_retry_ignores_only_the_valid_marker(self):
        fake, prefix, expected = self.bundle()
        fake.objects[prefix + "deployed.json"] = json_bytes({"status": "marker is validated by deploy flow"})
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "bundle"
            result = fetch_bundle(complete_store(fake, role="UPLOAD"), VERSION, REVISION, destination)
            self.assertEqual(result, 0)
            self.assertEqual({path.name: path.read_bytes() for path in destination.iterdir()}, expected)

        fake.objects[prefix + "unexpected.txt"] = b"unexpected"
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(ReleaseError, "unexpected"):
            fetch_bundle(complete_store(fake, role="UPLOAD"), VERSION, REVISION, Path(temporary) / "bundle")

    def test_only_empty_prefix_allows_fresh_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = fetch_bundle(complete_store(FakeCos(), role="UPLOAD"), VERSION, REVISION, temporary)
            self.assertEqual(result, 3)
        fake, prefix, _ = self.bundle()
        del fake.objects[prefix + "SHA256SUMS"]
        with tempfile.TemporaryDirectory() as temporary, self.assertRaisesRegex(ReleaseError, "partial"):
            fetch_bundle(complete_store(fake, role="UPLOAD"), VERSION, REVISION, temporary)

    def test_corruption_and_forbidden_layers_leave_no_reusable_files(self):
        for forbidden in (False, True):
            fake, prefix, _ = self.bundle(forbidden=forbidden)
            if not forbidden:
                fake.objects[prefix + "sbom.spdx.json"] = b"corrupt"
            with self.subTest(forbidden=forbidden), tempfile.TemporaryDirectory() as temporary:
                destination = Path(temporary) / "bundle"
                with self.assertRaises(ReleaseError):
                    fetch_bundle(complete_store(fake, role="UPLOAD"), VERSION, REVISION, destination)
                self.assertEqual(list(Path(temporary).iterdir()), [])
            self.assertFalse(fake.put_calls)
            self.assertFalse(fake.delete_calls)


if __name__ == "__main__":
    unittest.main()
