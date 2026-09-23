"""Unit tests for the Tennis-Green-PMS server deployment boundary.

These tests intentionally use only local fakes.  They do not require Docker,
COS, SSH, a database, or a production configuration.
"""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch


RELEASE_DIR = Path(__file__).resolve().parents[1]
if str(RELEASE_DIR) not in sys.path:
    sys.path.insert(0, str(RELEASE_DIR))

from common import ARCHIVE, SOURCE, ReleaseError, image_tag, json_bytes, sha256_file  # noqa: E402


try:
    import server
except Exception as import_error:  # Keep the contract failure visible as a test.
    server = None
    SERVER_IMPORT_ERROR = import_error
else:
    SERVER_IMPORT_ERROR = None


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def migration(name: str = "001_initial.sql") -> dict[str, str]:
    return {"name": name, "sha256": "a" * 64}


def release_key(version: str, revision: str) -> str:
    return f"tennis-green-pms/releases/{version}/{revision}/"


def make_manifest(
    version: str,
    revision: str,
    image_id: str,
    *,
    migrations: list[dict[str, str]] | None = None,
    compatibility_mode: str = "same-migrations-only",
    archive: bytes = b"fake docker archive",
    sbom: bytes = b'{"spdxVersion":"SPDX-2.3"}',
) -> tuple[dict[str, object], dict[str, bytes]]:
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "application": "tennis-green-pms",
        "version": version,
        "gitRevision": revision,
        "platform": "linux/amd64",
        "imageId": image_id,
        "imageTag": image_tag(version, revision),
        "archiveSha256": digest(archive),
        "sbomSha256": digest(sbom),
        "createdAt": "2026-09-09T00:00:00Z",
        "source": SOURCE,
        "requiredMigrations": migrations if migrations is not None else [migration()],
        "rollbackCompatibility": {
            "mode": compatibility_mode,
            "reason": "fixture migration baseline",
        },
    }
    manifest_bytes = json_bytes(manifest)
    checksums = "\n".join(
        (
            f"{digest(archive)}  {ARCHIVE}",
            f"{digest(manifest_bytes)}  manifest.json",
            f"{digest(sbom)}  sbom.spdx.json",
        )
    ).encode("ascii") + b"\n"
    objects = {
        ARCHIVE: archive,
        "manifest.json": manifest_bytes,
        "SHA256SUMS": checksums,
        "sbom.spdx.json": sbom,
    }
    return manifest, objects


class FakeStore:
    """Read-only COS client: it deliberately has no upload or marker method."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.downloads: list[str] = []
        self.markers: dict[str, bytes] = {}
        self.fail_key: str | None = None

    def add_bundle(self, key: str, objects: dict[str, bytes]) -> None:
        for name, value in objects.items():
            self.objects[key + name] = value

    def download(self, key: str, destination: Path) -> None:
        self.downloads.append(key)
        if key not in self.objects:
            raise ReleaseError("fake COS object missing")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if key == self.fail_key:
            destination.write_bytes(b"partial download")
            raise ReleaseError("fake COS download failed")
        destination.write_bytes(self.objects[key])


class FakeDocker:
    def __init__(self, current_image_id: str) -> None:
        self.current_image_id = current_image_id
        self.image_records: dict[str, dict[str, object]] = {}
        self.tag_to_id: dict[str, str] = {}
        self.extra_containers: list[dict[str, object]] = []
        self.switches: list[str] = []
        self.load_calls: list[Path] = []
        self.remove_calls: list[str] = []
        self.volumes = ["tennis-green-pms-data", "other-project-data"]

    def add_image(
        self,
        image_id: str,
        tags: list[str],
        *,
        version: str | None = None,
        revision: str | None = None,
        source: str = SOURCE,
        created: str = "2026-09-09T00:00:00Z",
        rootfs_diff_ids: list[str] | None = None,
    ) -> None:
        labels = {
            "org.opencontainers.image.version": version,
            "org.opencontainers.image.revision": revision,
            "org.opencontainers.image.source": source,
            "org.opencontainers.image.created": created,
        }
        record = {
            "Id": image_id,
            "RepoTags": list(tags),
            "Os": "linux",
            "Architecture": "amd64",
            "Labels": labels,
            "RootfsDiffIds": rootfs_diff_ids or ["sha256:" + "d" * 64],
        }
        self.image_records[image_id] = record
        for tag in tags:
            self.tag_to_id[tag] = image_id

    def current(self) -> dict[str, object]:
        return {
            "id": "container-id",
            "imageId": self.current_image_id,
            "name": "/tennis-green-pms-app",
            "running": True,
            "health": "healthy",
            "labels": {"com.docker.compose.project": "tennis-green-pms", "com.docker.compose.service": "app"},
        }

    def containers(self) -> list[dict[str, object]]:
        return [self.current(), *self.extra_containers]

    def inspect_image(self, identity: str) -> dict[str, object]:
        image_id = self.tag_to_id.get(identity, identity)
        if image_id not in self.image_records:
            raise ReleaseError("fake image missing")
        return json.loads(json.dumps(self.image_records[image_id]))

    def load(self, archive: Path) -> None:
        self.load_calls.append(archive)

    def switch(self, release: dict[str, object]) -> None:
        manifest = release["manifest"]
        identity = manifest["imageId"] if release.get("legacy") else manifest["imageTag"]
        image = self.inspect_image(str(identity))
        self.current_image_id = str(image["Id"])
        self.switches.append(self.current_image_id)

    def images(self) -> list[dict[str, object]]:
        return [json.loads(json.dumps(record)) for record in self.image_records.values()]

    def remove_tag(self, tag: str) -> None:
        self.remove_calls.append(tag)
        image_id = self.tag_to_id.pop(tag)
        tags = self.image_records[image_id]["RepoTags"]
        self.image_records[image_id]["RepoTags"] = [value for value in tags if value != tag]


class DockerAdapterTests(unittest.TestCase):
    def test_container_inspection_handles_containers_without_healthchecks(self) -> None:
        calls: list[list[str]] = []

        def fake_command(args: list[str], **_kwargs: object) -> str:
            calls.append(args)
            if args[:3] == ["docker", "ps", "-aq"]:
                return "healthy-id\nplain-id\n"
            return "\n".join((
                '{"id":"healthy-id","imageId":"sha256:a","name":"/tennis-green-pms-app","running":true,"health":"healthy","labels":{}}',
                '{"id":"plain-id","imageId":"sha256:b","name":"/other","running":true,"health":"none","labels":{}}',
            ))

        original = server.command
        server.command = fake_command
        try:
            containers = server.Docker({}).containers()
        finally:
            server.command = original

        self.assertEqual([item["health"] for item in containers], ["healthy", "none"])
        template = calls[1][calls[1].index("--format") + 1]
        self.assertIn('index .State "Health"', template)
        self.assertNotIn(".State.Health", template)

    def test_image_inspection_handles_images_without_labels(self) -> None:
        calls: list[list[str]] = []

        def fake_command(args: list[str], **_kwargs: object) -> str:
            calls.append(args)
            return '{"Id":"sha256:db","RepoTags":["postgres:18"],"Os":"linux","Architecture":"amd64","Labels":null,"RootfsDiffIds":[]}'

        original = server.command
        server.command = fake_command
        try:
            image = server.Docker({}).inspect_image("sha256:db")
        finally:
            server.command = original

        self.assertIsNone(image["Labels"])
        template = calls[0][calls[0].index("--format") + 1]
        self.assertIn('index .Config "Labels"', template)
        self.assertNotIn(".Config.Labels", template)
        self.assertIn(".RootFS.Layers", template)

    def test_health_rejects_an_unhealthy_app(self) -> None:
        docker = Mock()
        docker.current.return_value = {
            "imageId": "sha256:" + "a" * 64,
            "running": True,
            "health": "starting",
        }
        health = server.Health(docker, {
            "healthTimeoutSeconds": 1,
            "localBaseUrl": "http://127.0.0.1:4200",
            "publicReadyUrl": "https://example.test/health",
            "publicVersionUrl": "https://example.test/version",
        })
        release = {
            "runtimeImageId": "sha256:" + "a" * 64,
            "manifest": {"version": "v1.2.4", "imageId": "sha256:" + "c" * 64},
        }
        with patch("server.time.monotonic", side_effect=[0, 0, 2]), \
                patch("server.time.sleep") as sleep, \
                self.assertRaisesRegex(ReleaseError, "readiness or version gate failed"):
            health(release)
        sleep.assert_called_once_with(2)

    def test_health_checks_public_and_local_release_identity(self) -> None:
        revision = "b" * 40
        release = {"runtimeImageId": "sha256:" + "a" * 64,
                   "manifest": {"version": "v1.2.4", "gitRevision": revision}}
        docker = Mock()
        docker.current.return_value = {"imageId": release["runtimeImageId"], "running": True, "health": "healthy"}
        health = server.Health(docker, {"healthTimeoutSeconds": 1, "localBaseUrl": "http://127.0.0.1:4200",
                                       "publicReadyUrl": "https://example.test/health",
                                       "publicVersionUrl": "https://example.test/version"})
        for version, actual_revision, accepted in (("1.2.4", revision, True), ("1.2.3", revision, False),
                                                    ("1.2.4", "c" * 40, False)):
            with self.subTest(version=version, revision=actual_revision):
                def response(url, timeout):
                    result = BytesIO(json.dumps({"version": version, "revision": actual_revision}).encode())
                    result.status = 200
                    return result
                with patch("server.urllib.request.urlopen", side_effect=response) as request, \
                        patch("server.time.monotonic", side_effect=[0, 0, 2]), patch("server.time.sleep"):
                    if accepted:
                        health(release)
                        self.assertEqual(request.call_count, 4)
                    else:
                        with self.assertRaisesRegex(ReleaseError, "readiness or version gate failed"):
                            health(release)


class FakeHealth:
    def __init__(self, *, failures: set[str] | None = None, interruptions: set[str] | None = None) -> None:
        self.failures = failures or set()
        self.interruptions = interruptions or set()
        self.calls: list[str] = []

    def __call__(self, release: dict[str, object]) -> None:
        image_id = str(release.get("runtimeImageId", release["manifest"]["imageId"]))
        self.calls.append(image_id)
        if image_id in self.interruptions:
            raise KeyboardInterrupt
        if image_id in self.failures:
            raise ReleaseError("fake health check failed")


class DeployerFixture:
    old_version = "v1.2.3"
    old_revision = "b" * 40
    old_image_id = "sha256:" + "b" * 64
    new_version = "v1.2.4"
    new_revision = "a" * 40
    new_image_id = "sha256:" + "a" * 64
    new_runtime_image_id = "sha256:" + "c" * 64

    def __init__(self, *, health: FakeHealth | None = None) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tennis-green-pms-server-test-")
        root = Path(self.temp.name)
        self.state_dir = root / "state"
        self.state_dir.mkdir()
        self.compose_file = root / "compose.server.yaml"
        self.env_file = root / "app.env"
        self.compose_file.write_text("services: {}\n", encoding="utf-8")
        self.env_file.write_text("APP_ENV=test\n", encoding="utf-8")
        self.config = {
            "stateDir": str(self.state_dir),
            "composeFile": str(self.compose_file),
            "envFile": str(self.env_file),
            "localBaseUrl": "http://127.0.0.1:4200",
            "publicReadyUrl": "https://example.test/health",
            "publicVersionUrl": "https://example.test/version",
            "healthTimeoutSeconds": 0,
        }
        self.docker = FakeDocker(self.old_image_id)
        self.store = FakeStore()
        self.health = health or FakeHealth()
        self.decompress_calls: list[tuple[Path, Path]] = []
        self.scanner_calls: list[tuple[Path, dict[str, object]]] = []
        self.deployer = server.Deployer(  # type: ignore[union-attr]
            self.config,
            self.docker,
            self.store,
            self.health,
            scanner=self.scan,
            decompress=self.decompress,
        )
        self.old_manifest, _ = make_manifest(self.old_version, self.old_revision, self.old_image_id)
        self.docker.add_image(
            self.old_image_id,
            [str(self.old_manifest["imageTag"])],
            version=self.old_version,
            revision=self.old_revision,
        )
        self.write_state(self.old_manifest, self.old_version, self.old_revision, self.old_image_id)

    def close(self) -> None:
        self.temp.cleanup()

    def __enter__(self) -> "DeployerFixture":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def scan(self, archive: Path, manifest: dict[str, object]) -> dict[str, object]:
        self.scanner_calls.append((archive, manifest))
        image = self.docker.inspect_image(str(manifest["imageTag"]))
        return {"rootfsDiffIds": image["RootfsDiffIds"]}

    def decompress(self, source: Path, target: Path) -> None:
        self.decompress_calls.append((source, target))
        shutil.copyfile(source, target)

    def write_state(
        self,
        manifest: dict[str, object],
        version: str,
        revision: str,
        image_id: str,
        *,
        previous: dict[str, object] | None = None,
    ) -> dict[str, object]:
        release = {
            "prefix": release_key(version, revision),
            "manifestSha256": digest(json_bytes(manifest)),
            "manifest": manifest,
            "runtimeImageId": image_id,
        }
        state = {
            "schemaVersion": 1,
            "current": release,
            "previous": previous,
            "rollbackFrom": None,
            "deployedAt": "2026-09-09T00:00:00Z",
            "configurationSha256": self.deployer.config_hash(),
        }
        server.atomic_json(self.deployer.state_file, state)  # type: ignore[union-attr]
        self.docker.current_image_id = image_id
        return state

    def add_new_release(
        self,
        *,
        migrations: list[dict[str, str]] | None = None,
        compatibility_mode: str = "same-migrations-only",
        labels: dict[str, str | None] | None = None,
        runtime_image_id: str | None = None,
    ) -> tuple[dict[str, object], str]:
        manifest, objects = make_manifest(
            self.new_version,
            self.new_revision,
            self.new_image_id,
            migrations=migrations,
            compatibility_mode=compatibility_mode,
        )
        key = release_key(self.new_version, self.new_revision)
        self.store.add_bundle(key, objects)
        image_labels = {
            "version": self.new_version,
            "revision": self.new_revision,
            "source": SOURCE,
            "created": "2026-09-09T00:00:00Z",
        }
        if labels:
            image_labels.update(labels)
        self.docker.add_image(
            runtime_image_id or self.new_image_id,
            [str(manifest["imageTag"])],
            version=image_labels["version"],
            revision=image_labels["revision"],
            source=str(image_labels["source"]),
            created=str(image_labels["created"]),
        )
        return manifest, key

    def temp_downloads(self) -> list[Path]:
        return list((self.state_dir / "tmp").glob("download-*")) if (self.state_dir / "tmp").exists() else []


def _hold_lock(directory: str, ready: object, release: object, result: object) -> None:
    try:
        with server.deployment_lock(directory):  # type: ignore[union-attr]
            result.put("held")  # type: ignore[union-attr]
            ready.set()  # type: ignore[union-attr]
            release.wait(5)  # type: ignore[union-attr]
    except Exception as error:
        result.put(f"error:{type(error).__name__}")  # type: ignore[union-attr]
        ready.set()  # type: ignore[union-attr]


class ServerImportTests(unittest.TestCase):
    def test_server_import_contract(self) -> None:
        self.assertIsNone(SERVER_IMPORT_ERROR, f"server.py import failed: {SERVER_IMPORT_ERROR!r}")

    def test_default_scanner_returns_verified_archive_identity(self) -> None:
        import package as release_package

        expected = {"rootfsDiffIds": ["sha256:" + "d" * 64]}
        original = release_package.inspect_archive
        release_package.inspect_archive = lambda _path, _manifest: expected
        try:
            self.assertIs(server.Deployer.scan(Path("image.tar"), {}), expected)
        finally:
            release_package.inspect_archive = original


@unittest.skipIf(server is None, "server.py import contract must be fixed first")
@unittest.skipUnless(shutil.which("zstd"), "zstd is required for archive decompression")
class CompressionTests(unittest.TestCase):
    def test_deployer_uncompresses_zstd_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "image.tar"
            compressed = root / "image.tar.zst"
            target = root / "uncompressed.tar"
            raw.write_bytes(b"archive bytes")
            subprocess.run(
                ["zstd", "--quiet", "--force", "-o", str(compressed), str(raw)],
                check=True,
            )

            server.Deployer.uncompress(compressed, target)  # type: ignore[union-attr]
            self.assertEqual(target.read_bytes(), raw.read_bytes())


@unittest.skipIf(server is None, "server.py import contract must be fixed first")
class DeploymentTests(unittest.TestCase):
    def test_load_accepts_a_different_daemon_runtime_id_and_records_it(self) -> None:
        with DeployerFixture() as fixture:
            manifest, key = fixture.add_new_release(runtime_image_id=fixture.new_runtime_image_id)
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            result = fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(result["current"]["manifest"]["imageId"], manifest["imageId"])
            self.assertEqual(result["current"]["runtimeImageId"], fixture.new_runtime_image_id)
            self.assertEqual(fixture.docker.current_image_id, fixture.new_runtime_image_id)

    def test_load_rejects_runtime_rootfs_that_differs_from_archive(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])
            fixture.deployer.scanner = lambda *_: {"rootfsDiffIds": ["sha256:" + "e" * 64]}

            with self.assertRaisesRegex(ReleaseError, "rootfs differs"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)

    def test_bundle_validation_rejects_before_docker_load(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            archive_key = key + ARCHIVE
            fixture.store.objects[archive_key] = b"tampered archive"
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaises(ReleaseError):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_image_labels_must_match_manifest(self) -> None:
        with DeployerFixture() as fixture:
            manifest, key = fixture.add_new_release(labels={"revision": "c" * 40})
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaises(ReleaseError):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(len(fixture.docker.load_calls), 1)
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.deployer.state()["current"]["manifest"]["imageId"], fixture.old_image_id)
            self.assertEqual(fixture.temp_downloads(), [])
            self.assertEqual(manifest["imageId"], fixture.new_image_id)

    def test_store_download_failure_cleans_partial_download(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            fixture.store.fail_key = key + "sbom.spdx.json"
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaisesRegex(ReleaseError, "fake COS download failed"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_scanner_rejection_happens_before_docker_load(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            def reject_scanned_archive(_path: Path, _manifest: dict[str, object]) -> None:
                raise ReleaseError("fake archive scanner rejected bundle")

            fixture.deployer.scanner = reject_scanned_archive
            with self.assertRaisesRegex(ReleaseError, "fake archive scanner rejected bundle"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(len(fixture.decompress_calls), 1)
            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.temp_downloads(), [])

    def test_health_failure_restores_old_container_and_keeps_store_read_only(self) -> None:
        health = FakeHealth(failures={DeployerFixture.new_image_id})
        with DeployerFixture(health=health) as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaisesRegex(ReleaseError, "previous container restored"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)
            self.assertEqual(fixture.docker.switches, [fixture.new_image_id, fixture.old_image_id])
            self.assertFalse(fixture.deployer.journal.exists())
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_migration_baseline_mismatch_refuses_switch(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release(migrations=[migration("002_new.sql")])
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaisesRegex(ReleaseError, "migration baseline changed"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.store.markers, {})

    def test_forward_migration_extension_refuses_switch(self) -> None:
        with DeployerFixture() as fixture:
            current_migrations = list(fixture.old_manifest["requiredMigrations"])
            target_migrations = current_migrations + [migration("061_room_catalog_management.sql")]
            _, key = fixture.add_new_release(
                migrations=target_migrations,
                compatibility_mode="forward-only",
            )
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            before = fixture.deployer.state_file.read_bytes()
            with self.assertRaisesRegex(ReleaseError, "migration baseline changed"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)
            self.assertEqual(fixture.deployer.state_file.read_bytes(), before)
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.docker.load_calls, [])

    def test_forward_only_release_allows_forward_switch_but_refuses_rollback(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release(compatibility_mode="forward-only")
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            result = fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)
            self.assertEqual(result["status"], "healthy")
            self.assertEqual(fixture.docker.current_image_id, fixture.new_image_id)

            with self.assertRaisesRegex(ReleaseError, "forward-only release"):
                fixture.deployer.deploy(
                    fixture.old_version,
                    fixture.old_revision,
                    release_key(fixture.old_version, fixture.old_revision),
                    digest(json_bytes(fixture.old_manifest)),
                    rollback=True,
                )

            self.assertEqual(len(fixture.docker.load_calls), 1)
            self.assertEqual(fixture.docker.switches, [fixture.new_image_id])
            self.assertEqual(fixture.store.markers, {})

    def test_success_cleans_download_directory_and_does_not_write_marker(self) -> None:
        with DeployerFixture() as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            result = fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(result["status"], "healthy")
            self.assertEqual(fixture.docker.current_image_id, fixture.new_image_id)
            self.assertFalse(fixture.deployer.journal.exists())
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_interruption_restores_old_container_and_cleans_download_directory(self) -> None:
        health = FakeHealth(interruptions={DeployerFixture.new_image_id})
        with DeployerFixture(health=health) as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])

            with self.assertRaisesRegex(ReleaseError, "previous container restored"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)

            self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)
            self.assertFalse(fixture.deployer.journal.exists())
            self.assertEqual(fixture.temp_downloads(), [])
            self.assertEqual(fixture.store.markers, {})

    def test_idempotent_same_image_does_not_load_or_switch(self) -> None:
        with DeployerFixture() as fixture:
            manifest, key_objects = make_manifest(fixture.old_version, fixture.old_revision, fixture.old_image_id)
            key = release_key(fixture.old_version, fixture.old_revision)
            fixture.store.add_bundle(key, key_objects)
            state = fixture.deployer.state()
            state["current"]["prefix"] = key
            state["current"]["manifestSha256"] = digest(key_objects["manifest.json"])
            state["current"]["manifest"] = manifest
            server.atomic_json(fixture.deployer.state_file, state)  # type: ignore[union-attr]
            manifest_sha = digest(key_objects["manifest.json"])

            result = fixture.deployer.deploy(fixture.old_version, fixture.old_revision, key, manifest_sha)

            self.assertEqual(result["status"], "healthy")
            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [])
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_adopted_target_registers_verified_bundle_without_switch(self) -> None:
        for runtime_differs in (False, True):
            with self.subTest(runtime_differs=runtime_differs), DeployerFixture() as fixture:
                fixture.deployer.state_file.unlink()
                fixture.deployer.adopt(fixture.old_version, fixture.old_revision, fixture.old_image_id, [migration()])
                archive_id = fixture.new_image_id if runtime_differs else fixture.old_image_id
                manifest, objects = make_manifest(fixture.old_version, fixture.old_revision, archive_id)
                key = release_key(fixture.old_version, fixture.old_revision)
                fixture.store.add_bundle(key, objects)
                result = fixture.deployer.deploy(fixture.old_version, fixture.old_revision, key, digest(objects["manifest.json"]))
                self.assertEqual(result["status"], "healthy")
                current = fixture.deployer.state()["current"]
                self.assertFalse(current.get("legacy", False))
                self.assertEqual(current["manifestSha256"], digest(objects["manifest.json"]))
                self.assertEqual(current["runtimeImageId"], fixture.old_image_id)
                self.assertEqual(fixture.docker.switches, [])
                self.assertEqual(fixture.docker.load_calls, [])
                self.assertEqual(len(fixture.decompress_calls), 1)
                self.assertEqual(fixture.temp_downloads(), [])
                # Formal registration is safely replayable.
                fixture.deployer.deploy(fixture.old_version, fixture.old_revision, key, digest(objects["manifest.json"]))

    def test_adoption_registration_failure_preserves_legacy_state(self) -> None:
        for failure in ("archive", "health", "labels"):
            with self.subTest(failure=failure), DeployerFixture() as fixture:
                fixture.deployer.state_file.unlink()
                fixture.deployer.adopt(fixture.old_version, fixture.old_revision, fixture.old_image_id, [migration()])
                manifest, objects = make_manifest(fixture.old_version, fixture.old_revision, fixture.old_image_id)
                key = release_key(fixture.old_version, fixture.old_revision)
                fixture.store.add_bundle(key, objects)
                if failure == "archive":
                    fixture.deployer.scanner = Mock(side_effect=ReleaseError("archive rejected"))
                elif failure == "health":
                    fixture.health.failures.add(fixture.old_image_id)
                else:
                    fixture.docker.image_records[fixture.old_image_id]["Labels"]["org.opencontainers.image.source"] = "https://example.invalid/other"
                before = fixture.deployer.state_file.read_bytes()
                with self.assertRaises(ReleaseError):
                    fixture.deployer.deploy(fixture.old_version, fixture.old_revision, key, digest(objects["manifest.json"]))
                self.assertEqual(fixture.deployer.state_file.read_bytes(), before)
                self.assertEqual(fixture.docker.switches, [])
                self.assertEqual(fixture.temp_downloads(), [])

    def test_adopted_same_image_rejects_conflicting_version(self) -> None:
        with DeployerFixture() as fixture:
            fixture.deployer.state_file.unlink()
            fixture.deployer.adopt(fixture.old_version, fixture.old_revision, fixture.old_image_id, [migration()])
            manifest, objects = make_manifest(fixture.new_version, fixture.new_revision, fixture.old_image_id)
            key = release_key(fixture.new_version, fixture.new_revision)
            fixture.store.add_bundle(key, objects)
            fixture.docker.add_image(fixture.old_image_id, [manifest["imageTag"]],
                                     version=fixture.new_version, revision=fixture.new_revision)
            before = fixture.deployer.state_file.read_bytes()
            with self.assertRaisesRegex(ReleaseError, "conflicting release identity"):
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, digest(objects["manifest.json"]))
            self.assertEqual(fixture.deployer.state_file.read_bytes(), before)
            self.assertEqual(fixture.docker.switches, [])

    def test_checksum_change_refuses_both_deploy_and_rollback(self) -> None:
        for rollback in (False, True):
            with DeployerFixture() as fixture:
                _, key = fixture.add_new_release(migrations=[{**migration(), "sha256": "c" * 64}])
                before = fixture.deployer.state_file.read_bytes()
                with self.assertRaisesRegex(ReleaseError, "migration baseline changed"):
                    fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key,
                                             digest(fixture.store.objects[key + "manifest.json"]), rollback=rollback)
                self.assertEqual(fixture.deployer.state_file.read_bytes(), before)
                self.assertEqual(fixture.docker.switches, [])

    def test_rollback_reuses_matching_previous_image_without_cos_download(self) -> None:
        with DeployerFixture() as fixture:
            target_manifest, key = fixture.add_new_release()
            target_manifest_sha = digest(fixture.store.objects[key + "manifest.json"])
            before = fixture.deployer.state()
            previous = {
                "prefix": key,
                "manifestSha256": target_manifest_sha,
                "manifest": target_manifest,
                "runtimeImageId": fixture.new_image_id,
            }
            before["previous"] = previous
            server.atomic_json(fixture.deployer.state_file, before)  # type: ignore[union-attr]
            fixture.store.objects.clear()

            result = fixture.deployer.deploy(
                fixture.new_version,
                fixture.new_revision,
                key,
                target_manifest_sha,
                rollback=True,
            )

            self.assertEqual(result["status"], "healthy")
            self.assertEqual(fixture.store.downloads, [])
            self.assertEqual(fixture.docker.load_calls, [])
            self.assertEqual(fixture.docker.switches, [fixture.new_image_id])
            self.assertEqual(fixture.deployer.state()["current"]["manifest"]["imageId"], fixture.new_image_id)
            self.assertEqual(fixture.store.markers, {})
            self.assertEqual(fixture.temp_downloads(), [])

    def test_journal_recovery_restores_committed_state_and_removes_journal(self) -> None:
        with DeployerFixture() as fixture:
            state = fixture.deployer.state()
            fixture.docker.current_image_id = fixture.new_image_id
            server.atomic_json(  # type: ignore[union-attr]
                fixture.deployer.journal,
                {"before": state, "target": {"manifest": {**fixture.old_manifest, "imageId": fixture.new_image_id}}, "startedAt": "2026-09-09T00:00:00Z"},
            )

            fixture.deployer.recover()

            self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)
            self.assertFalse(fixture.deployer.journal.exists())
            self.assertEqual(fixture.docker.switches, [fixture.old_image_id])

    def test_recovery_refuses_uncommitted_cross_baseline_transaction(self) -> None:
        with DeployerFixture() as fixture:
            before = fixture.deployer.state()
            target_manifest, _ = fixture.add_new_release(migrations=[migration(), migration("002_new.sql")])
            server.atomic_json(fixture.deployer.journal, {"before": before, "target": {"manifest": target_manifest}})
            with self.assertRaisesRegex(ReleaseError, "migration baseline changed"):
                fixture.deployer.recover()
            self.assertTrue(fixture.deployer.journal.exists())
            self.assertEqual(fixture.docker.switches, [])
            # A committed target is recovered in place, never by reverting its SQL.
            after = {**before, "current": {"manifest": target_manifest}}
            server.atomic_json(fixture.deployer.state_file, after)
            fixture.deployer.recover()
            self.assertEqual(fixture.docker.switches, [fixture.new_image_id])
            self.assertFalse(fixture.deployer.journal.exists())

    def test_flock_allows_only_one_process(self) -> None:
        if "fork" not in multiprocessing.get_all_start_methods():
            self.skipTest("POSIX fork is required for this flock test")
        with tempfile.TemporaryDirectory(prefix="tennis-green-pms-flock-test-") as temporary:
            context = multiprocessing.get_context("fork")
            ready = context.Event()
            release = context.Event()
            result = context.Queue()
            process = context.Process(target=_hold_lock, args=(temporary, ready, release, result))
            process.start()
            try:
                self.assertTrue(ready.wait(5))
                self.assertEqual(result.get(timeout=5), "held")
                with self.assertRaises(ReleaseError):
                    with server.deployment_lock(temporary):  # type: ignore[union-attr]
                        pass
            finally:
                release.set()
                process.join(5)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
            self.assertEqual(process.exitcode, 0)

    def test_signal_interrupt_does_not_leave_real_subprocess_running(self) -> None:
        class Interrupted(Exception):
            pass

        with tempfile.TemporaryDirectory(prefix="tennis-green-pms-command-signal-") as temporary:
            probe = Path(temporary) / "child.pid"
            previous_handler = signal.getsignal(signal.SIGTERM)

            def interrupt(_signum: int, _frame: object) -> None:
                raise Interrupted

            def interrupt_after_child_started() -> None:
                # Heavy image builds can delay process startup beyond 200ms.
                # Signal only after the child has written its PID evidence.
                for _ in range(500):
                    try:
                        child_pid = probe.read_text(encoding="ascii").strip()
                    except FileNotFoundError:
                        child_pid = ""
                    if child_pid.isdigit():
                        os.kill(os.getpid(), signal.SIGTERM)
                        return
                    time.sleep(0.01)

            timer = threading.Timer(0, interrupt_after_child_started)
            try:
                signal.signal(signal.SIGTERM, interrupt)
                child_code = (
                    "import os, pathlib, sys, time; "
                    "pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); "
                    "time.sleep(5)"
                )
                timer.start()
                with self.assertRaises(Interrupted):
                    server.command([sys.executable, "-c", child_code, str(probe)])  # type: ignore[union-attr]
                child_pid = int(probe.read_text(encoding="ascii"))
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    child_alive = False
                else:
                    child_alive = True
                    os.kill(child_pid, signal.SIGKILL)
                self.assertFalse(child_alive, "command() left the interrupted subprocess running")
            finally:
                timer.cancel()
                signal.signal(signal.SIGTERM, previous_handler)

    def test_failure_audit_error_still_restores_old_container(self) -> None:
        health = FakeHealth(failures={DeployerFixture.new_image_id})
        with DeployerFixture(health=health) as fixture:
            _, key = fixture.add_new_release()
            manifest_sha = digest(fixture.store.objects[key + "manifest.json"])
            original_audit = fixture.deployer.audit

            def broken_audit(event: str, **fields: object) -> None:
                if event == "failed":
                    raise OSError("simulated audit disk failure")
                original_audit(event, **fields)

            fixture.deployer.audit = broken_audit
            raised: BaseException | None = None
            try:
                fixture.deployer.deploy(fixture.new_version, fixture.new_revision, key, manifest_sha)
            except BaseException as error:
                raised = error

            self.assertIsInstance(raised, ReleaseError)
            self.assertEqual(fixture.docker.current_image_id, fixture.old_image_id)
            self.assertFalse(fixture.deployer.journal.exists())

    def test_cleanup_rejects_tag_rebind_before_final_inspect(self) -> None:
        old_id = "sha256:" + "9" * 64
        replacement_id = "sha256:" + "a" * 64
        tag = "tennis-green-pms:v1.0.2"

        class RetaggingDocker(FakeDocker):
            def __init__(self) -> None:
                super().__init__("sha256:" + "1" * 64)
                self.container_calls = 0

            def containers(self) -> list[dict[str, object]]:
                self.container_calls += 1
                result = super().containers()
                if self.container_calls == 2:
                    self.add_image(replacement_id, [tag])
                return result

        docker = RetaggingDocker()
        docker.add_image(old_id, [tag])
        state = {
            "current": {"manifest": {"imageId": "sha256:" + "1" * 64}},
            "previous": None,
        }
        raised: BaseException | None = None
        try:
            server.cleanup_images(docker, state)  # type: ignore[union-attr]
        except BaseException as error:
            raised = error

        self.assertIsInstance(raised, ReleaseError)
        self.assertEqual(docker.tag_to_id.get(tag), replacement_id)


@unittest.skipIf(server is None, "server.py import contract must be fixed first")
class CleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.docker = FakeDocker("sha256:" + "1" * 64)
        self.current_id = "sha256:" + "1" * 64
        self.previous_id = "sha256:" + "2" * 64

    def state(self) -> dict[str, object]:
        return {
            "current": {"manifest": {"imageId": self.current_id}},
            "previous": {"manifest": {"imageId": self.previous_id}},
        }

    def test_cleanup_deduplicates_by_image_id_and_removes_all_owned_tags(self) -> None:
        old_id = "sha256:" + "3" * 64
        self.docker.add_image(old_id, ["tennis-green-pms:v1.0.0", "tennis-green-pms:legacy"])
        decisions = server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["imageId"], old_id)
        self.assertEqual(set(self.docker.remove_calls), {"tennis-green-pms:v1.0.0", "tennis-green-pms:legacy"})

    def test_cleanup_protects_any_container_reference(self) -> None:
        referenced_id = "sha256:" + "4" * 64
        self.docker.add_image(referenced_id, ["tennis-green-pms:v1.0.1"])
        self.docker.extra_containers.append({"imageId": referenced_id, "name": "/stopped-tennis-green-pms", "running": False})

        decisions = server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]

        self.assertEqual(decisions[0]["action"], "keep")
        self.assertEqual(decisions[0]["reason"], "container reference")
        self.assertEqual(self.docker.remove_calls, [])

    def test_cleanup_only_removes_managed_images_and_preserves_volumes(self) -> None:
        old_id = "sha256:" + "5" * 64
        other_id = "sha256:" + "6" * 64
        self.docker.add_image(old_id, ["tennis-green-pms-app:v1.0.0"])
        self.docker.add_image(other_id, ["other-project:latest"])
        volumes_before = list(self.docker.volumes)

        server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]

        self.assertEqual(self.docker.remove_calls, ["tennis-green-pms-app:v1.0.0"])
        self.assertEqual(self.docker.inspect_image("other-project:latest")["RepoTags"], ["other-project:latest"])
        self.assertEqual(self.docker.volumes, volumes_before)

    def test_cleanup_removes_tennis_green_pms_tags_from_image_shared_with_other_repository(self) -> None:
        shared_id = "sha256:" + "9" * 64
        managed_tag = "tennis-green-pms:v1.0.3"
        other_tag = "other-project:shared"
        self.docker.add_image(shared_id, [managed_tag, other_tag])

        decisions = server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]

        self.assertEqual(decisions[0]["action"], "delete")
        self.assertEqual(self.docker.remove_calls, [managed_tag])
        self.assertEqual(self.docker.inspect_image(other_tag)["RepoTags"], [other_tag])

    def test_old_demo_tags_protect_stopped_container_and_housing_tags(self) -> None:
        referenced = "sha256:" + "7" * 64
        unreferenced = "sha256:" + "8" * 64
        self.docker.add_image(referenced, ["tennis-demo:c80696a"])
        self.docker.add_image(unreferenced, ["tennis-demo:old", "greenpms:shared"])
        self.docker.extra_containers.append({"imageId": referenced, "name": "/tennis-demo-app-1", "running": False})
        volumes = list(self.docker.volumes)
        server.cleanup_images(self.docker, self.state(), dry_run=True)
        self.assertEqual(self.docker.remove_calls, [])
        server.cleanup_images(self.docker, self.state())
        self.assertEqual(self.docker.remove_calls, ["tennis-demo:old"])
        self.assertEqual(self.docker.inspect_image("greenpms:shared")["RepoTags"], ["greenpms:shared"])
        self.assertIn("tennis-demo:c80696a", self.docker.tag_to_id)
        self.assertEqual(self.docker.volumes, volumes)

    def test_repeated_cleanup_is_idempotent(self) -> None:
        old_id = "sha256:" + "7" * 64
        self.docker.add_image(old_id, ["tennis-green-pms:v1.0.0"])

        server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]
        first_removals = list(self.docker.remove_calls)
        second = server.cleanup_images(self.docker, self.state())  # type: ignore[union-attr]

        self.assertEqual(first_removals, ["tennis-green-pms:v1.0.0"])
        self.assertEqual(self.docker.remove_calls, first_removals)
        self.assertEqual(second, [])

    def test_dry_run_does_not_write_resources(self) -> None:
        old_id = "sha256:" + "8" * 64
        self.docker.add_image(old_id, ["tennis-green-pms:v1.0.0", "tennis-green-pms:alias"])
        before = self.docker.images()

        decisions = server.cleanup_images(self.docker, self.state(), dry_run=True)  # type: ignore[union-attr]

        self.assertEqual(self.docker.remove_calls, [])
        self.assertEqual(self.docker.images(), before)
        self.assertEqual(decisions[0]["action"], "delete")


if __name__ == "__main__":
    unittest.main()
