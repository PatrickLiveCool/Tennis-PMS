import io
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.release.common import ReleaseError, json_bytes, sha256_file, validate_bundle
from scripts.release.package import forbidden_path, indexed_archive_path, inspect_archive


IMAGE_ID = "sha256:" + "0" * 64
VERSION = "v1.2.3"
REVISION = "a" * 40
IMAGE_TAG = f"tennis-green-pms:{VERSION}-{REVISION}"
CREATED = "2026-09-09T00:00:00Z"


def manifest():
    return {
        "schemaVersion": 1,
        "application": "tennis-green-pms",
        "version": VERSION,
        "gitRevision": REVISION,
        "platform": "linux/amd64",
        "imageId": IMAGE_ID,
        "imageTag": IMAGE_TAG,
        "archiveSha256": "1" * 64,
        "sbomSha256": "2" * 64,
        "createdAt": CREATED,
        "source": "https://github.com/PatrickLiveCool/Tennis-PMS",
        "requiredMigrations": [{"name": "001_initial.sql", "sha256": "3" * 64}],
        "rollbackCompatibility": {
            "mode": "same-migrations-only",
            "reason": "No migration change.",
        },
    }


def add_bytes(archive, name, content):
    info = tarfile.TarInfo(name)
    info.size = len(content)
    archive.addfile(info, io.BytesIO(content))


def docker_archive(current, *, tag=IMAGE_TAG, repo_tags=None, labels=None, layer_name="app/runtime.js", modern=False, manifest_last=False):
    labels = labels or {
        "org.opencontainers.image.version": VERSION,
        "org.opencontainers.image.revision": REVISION,
        "org.opencontainers.image.source": "https://github.com/PatrickLiveCool/Tennis-PMS",
        "org.opencontainers.image.created": CREATED,
    }
    layer_buffer = io.BytesIO()
    with tarfile.open(fileobj=layer_buffer, mode="w") as layer:
        add_bytes(layer, layer_name, b"runtime")
    layer_bytes = layer_buffer.getvalue()
    config = json.dumps({
        "os": "linux",
        "architecture": "amd64",
        "config": {"Labels": labels},
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{hashlib.sha256(layer_bytes).hexdigest()}"]},
    }).encode()
    config_digest = hashlib.sha256(config).hexdigest()
    current["imageId"] = f"sha256:{config_digest}"
    layer_path = f"blobs/sha256/{hashlib.sha256(layer_bytes).hexdigest()}" if modern else "layer/layer.tar"
    config_path = f"blobs/sha256/{config_digest}" if modern else f"{config_digest}.json"
    docker_manifest = json.dumps([{
        "Config": config_path,
        "RepoTags": repo_tags if repo_tags is not None else [tag],
        "Layers": [layer_path],
    }]).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        if manifest_last:
            add_bytes(archive, config_path, config)
            add_bytes(archive, layer_path, layer_bytes)
            add_bytes(archive, "manifest.json", docker_manifest)
        else:
            add_bytes(archive, "manifest.json", docker_manifest)
            add_bytes(archive, config_path, config)
            add_bytes(archive, layer_path, layer_bytes)
    return output.getvalue()


class PackageScannerTests(unittest.TestCase):
    def write_archive(self, content):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "image.tar"
        path.write_bytes(content)
        self.addCleanup(directory.cleanup)
        return path

    def test_accepts_valid_archive_and_tag(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current)), current)
        self.assertEqual(details["imageTag"], IMAGE_TAG)
        self.assertEqual(len(details["rootfsDiffIds"]), 1)

    def test_rejects_tag_mismatch(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, tag="tennis-green-pms:wrong")), current)

    def test_rejects_extra_repo_tags(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(
                self.write_archive(docker_archive(current, repo_tags=[IMAGE_TAG, "other-project:latest"])),
                current,
            )

    def test_rejects_label_mismatch(self):
        current = manifest()
        labels = {
            "org.opencontainers.image.version": VERSION,
            "org.opencontainers.image.revision": "b" * 40,
            "org.opencontainers.image.source": "https://github.com/PatrickLiveCool/Tennis-PMS",
            "org.opencontainers.image.created": CREATED,
        }
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, labels=labels)), current)

    def test_rejects_forbidden_file_without_reading_content(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, layer_name="app/.env")), current)

    def test_accepts_modern_blob_archive(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current, modern=True)), current)
        self.assertEqual(details["layerCount"], 1)

    def test_accepts_manifest_last_archive(self):
        current = manifest()
        details = inspect_archive(self.write_archive(docker_archive(current, manifest_last=True)), current)
        self.assertEqual(details["layerCount"], 1)

    def test_preserves_dot_prefixes_when_scanning_paths(self):
        self.assertTrue(forbidden_path("./.env"))
        self.assertTrue(forbidden_path("./.production-operator-password-fixture"))
        self.assertTrue(forbidden_path("app/.env.example"))
        self.assertTrue(forbidden_path("app/apps/api/src/main.ts"))
        self.assertFalse(forbidden_path(".env.example", allow_env_example=True))

    def test_allows_dependency_declaration_files(self):
        current = manifest()
        details = inspect_archive(
            self.write_archive(docker_archive(current, layer_name="app/node_modules/example/index.d.ts")),
            current,
        )
        self.assertEqual(details["layerCount"], 1)

    def test_rejects_env_example_in_final_image(self):
        current = manifest()
        with self.assertRaises(ReleaseError):
            inspect_archive(self.write_archive(docker_archive(current, layer_name="app/.env.example")), current)


@unittest.skipUnless(shutil.which("zstd"), "zstd is required for archive compression")
class CompressionTests(unittest.TestCase):
    def test_indexed_archive_path_decompresses_with_zstd(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "image.tar"
            compressed = root / "image.tar.zst"
            raw.write_bytes(b"archive bytes")
            subprocess.run(
                ["zstd", "--quiet", "--force", "-o", str(compressed), str(raw)],
                check=True,
            )

            temporary_directory, indexed = indexed_archive_path(compressed)
            try:
                self.assertEqual(indexed.read_bytes(), raw.read_bytes())
            finally:
                if temporary_directory is not None:
                    temporary_directory.cleanup()


class BundleValidationTests(unittest.TestCase):
    def test_rejects_sbom_hash_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "tennis-green-pms-linux-amd64.docker.tar.zst"
            sbom = directory / "sbom.spdx.json"
            archive.write_bytes(b"archive")
            sbom.write_text(json.dumps({"spdxVersion": "SPDX-2.3"}))
            current = manifest()
            current["archiveSha256"] = sha256_file(archive)
            current["sbomSha256"] = sha256_file(sbom)
            (directory / "manifest.json").write_bytes(json_bytes(current))
            (directory / "SHA256SUMS").write_text(
                f"{sha256_file(archive)}  {archive.name}\n"
                f"{sha256_file(directory / 'manifest.json')}  manifest.json\n"
                f"{sha256_file(sbom)}  {sbom.name}\n"
            )
            validate_bundle(directory, sha256_file(directory / "manifest.json"), VERSION, REVISION)
            sbom.write_text(json.dumps({"spdxVersion": "SPDX-2.3", "changed": True}))
            with self.assertRaises(ReleaseError):
                validate_bundle(directory, sha256_file(directory / "manifest.json"), VERSION, REVISION)


if __name__ == "__main__":
    unittest.main()
