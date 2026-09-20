"""Local setup generation must preserve narrow permission boundaries."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts/release"))
spec = importlib.util.spec_from_file_location("release_setup", ROOT / "scripts/release/setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_generated_permissions_are_scoped_and_split(self):
        documents = setup.configuration("example-artifacts-1250000000", "ap-guangzhou", "pms.example.com")
        self.assertEqual(len(documents), 4)
        self.assertNotIn("cam-marker.json", documents)
        for role in ("upload", "retention", "reader"):
            for statement in documents[f"cam-{role}.json"]["statement"]:
                for resource in statement["resource"]:
                    self.assertTrue(resource.startswith("qcs::cos:ap-guangzhou:uid/1250000000:example-artifacts-1250000000/"))
                if "name/cos:DeleteObject" in statement["action"]:
                    self.assertEqual(role, "retention")
                if "name/cos:PutObject" in statement["action"]:
                    self.assertEqual(role, "upload")
                    self.assertTrue(any(resource.endswith("/deployed.json") for resource in statement["resource"]))
                if "name/cos:GetBucket" in statement["action"]:
                    self.assertEqual(statement["condition"]["string_like"]["cos:prefix"], ["tennis-green-pms%2Freleases%2F*"])
        upload = documents["cam-upload.json"]["statement"]
        self.assertEqual(
            {r.rsplit("/", 1)[-1] for s in upload if "name/cos:GetObject" in s["action"] for r in s["resource"]},
            {"tennis-green-pms-linux-amd64.docker.tar.zst", "manifest.json", "SHA256SUMS", "sbom.spdx.json", "deployed.json"},
        )
        self.assertEqual(
            {r.rsplit("/", 1)[-1] for s in upload if "name/cos:HeadObject" in s["action"] for r in s["resource"]},
            {"tennis-green-pms-linux-amd64.docker.tar.zst", "manifest.json", "SHA256SUMS", "sbom.spdx.json", "deployed.json"},
        )
        self.assertEqual(
            {r.rsplit("/", 1)[-1] for s in upload if "name/cos:PutObject" in s["action"] for r in s["resource"]},
            {"tennis-green-pms-linux-amd64.docker.tar.zst", "manifest.json", "SHA256SUMS", "sbom.spdx.json", "deployed.json"},
        )
        self.assertFalse(any("name/cos:DeleteObject" in s["action"] for s in upload))
        retention = documents["cam-retention.json"]["statement"]
        self.assertEqual(
            {r.rsplit("/", 1)[-1] for s in retention if "name/cos:DeleteObject" in s["action"] for r in s["resource"]},
            {"tennis-green-pms-linux-amd64.docker.tar.zst", "manifest.json", "SHA256SUMS", "sbom.spdx.json", "deployed.json"},
        )
        reader = documents["cam-reader.json"]["statement"]
        self.assertEqual(len(reader), 1)
        self.assertEqual(reader[0]["action"], ["name/cos:GetObject"])
        self.assertFalse(any(resource.endswith("/deployed.json") for resource in reader[0]["resource"]))
        self.assertEqual(documents["deploy.json"]["publicReadyUrl"], "https://pms.example.com/health")

    def test_invalid_input_is_rejected(self):
        for bucket, region, host in (("other/*", "ap-guangzhou", "pms.example.com"),
                                     ("example-1250000000", "*", "pms.example.com"),
                                     ("example-1250000000", "ap-guangzhou", "user:secret@pms.example.com"),
                                     ("example-1250000000", "ap-guangzhou", "https://pms.example.com/a")):
            with self.subTest(bucket=bucket, region=region, host=host), self.assertRaises(ValueError):
                setup.configuration(bucket, region, host)

    def test_existing_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "setup"
            documents = setup.configuration("example-1250000000", "ap-guangzhou", "pms.example.com")
            setup.write_configuration(output, documents)
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            with self.assertRaises(FileExistsError):
                setup.write_configuration(output, documents)
            self.assertEqual(before, {p.name: p.read_bytes() for p in output.iterdir()})


if __name__ == "__main__":
    unittest.main()
