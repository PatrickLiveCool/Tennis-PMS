import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from scripts.release.common import FILES, ReleaseError, json_bytes, sha256_file
from scripts.release.cos import CosStore, upload_bundle
from scripts.release.orchestrate import (MAX_RECEIPT_BYTES, LockedSSH, deploy, maintenance,
                                          retention_plan, validate_receipt)


ROOT = "tennis-green-pms/releases/"
SOURCE = "https://github.com/PatrickLiveCool/Tennis-PMS"


class FakeCosError(Exception):
    def __init__(self, status):
        self.status_code = status
        super().__init__(f"COS status {status}")

    def get_status_code(self):
        return self.status_code


class StreamOnlyBody:
    def __init__(self, data):
        self.data = data

    def get_stream_to_file(self, path):
        with open(path, "wb") as stream:
            for offset in range(0, len(self.data), 3):
                stream.write(self.data[offset:offset + 3])


class FakeCos:
    def __init__(self, status=None):
        self.objects = {}
        self.modified = {}
        self.status = status
        self.versioning_calls = 0
        self.put_calls = []
        self.delete_calls = []
        self.fail_put = None
        self.fail_delete = set()

    def get_bucket_versioning(self, Bucket):
        self.versioning_calls += 1
        return {} if self.status is None else {"Status": self.status}

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FakeCosError(404)
        return {"Content-Length": str(len(self.objects[Key]))}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise FakeCosError(404)
        return {"Body": StreamOnlyBody(self.objects[Key])}

    def put_object(self, Bucket, Body, Key, Metadata):
        if self.fail_put is not None:
            raise FakeCosError(self.fail_put)
        if Key in self.objects:
            raise FakeCosError(409)
        content = bytearray()
        while True:
            chunk = Body.read(4)
            if not chunk:
                break
            content.extend(chunk)
        self.objects[Key] = bytes(content)
        self.modified[Key] = "2026-09-09T12:00:00Z"
        self.put_calls.append((Key, Metadata))
        return {"ETag": hashlib.md5(bytes(content)).hexdigest()}

    def list_objects(self, Bucket, Prefix, Marker="", MaxKeys=1000):
        contents = [{"Key": key, "LastModified": self.modified.get(key, "2026-09-09T12:00:00Z"),
                     "Size": len(value)} for key, value in sorted(self.objects.items()) if key.startswith(Prefix)]
        return {"Contents": contents, "IsTruncated": "false"}

    def delete_object(self, Bucket, Key):
        self.delete_calls.append(Key)
        if Key in self.fail_delete:
            raise FakeCosError(500)
        self.objects.pop(Key, None)


class FakeSSH:
    def __init__(self, receipt, returncode=0, stderr=""):
        self.stdout = io.StringIO("" if receipt is None else json.dumps(receipt, separators=(",", ":")) + "\n")
        self.stderr = io.StringIO(stderr)
        self.stdin = RecordingStdin()
        self.returncode = returncode
        self.wait_calls = []

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        return self.returncode

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9


class RecordingStdin(io.StringIO):
    def __init__(self):
        super().__init__()
        self.closed_by_client = False

    def close(self):
        self.closed_by_client = True


def migrations(count=1):
    return [{"name": f"{index:03d}_migration.sql", "sha256": f"{index:064x}"} for index in range(count)]


def make_manifest(version, revision, archive=b"archive", sbom=b"{}", migration_count=1):
    image_id = "sha256:" + (revision * 2)[:64]
    return {
        "schemaVersion": 1,
        "application": "tennis-green-pms",
        "version": version,
        "gitRevision": revision,
        "platform": "linux/amd64",
        "imageId": image_id,
        "imageTag": f"tennis-green-pms:{version}-{revision}",
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
        "sbomSha256": hashlib.sha256(sbom).hexdigest(),
        "createdAt": "2026-09-09T00:00:00Z",
        "source": SOURCE,
        "requiredMigrations": migrations(migration_count),
        "rollbackCompatibility": {"mode": "same-migrations-only", "reason": "same migration baseline"},
    }


def add_release(client, version, revision, deployed_at, *, marker=True, migration_count=1):
    archive = f"archive-{version}".encode()
    sbom = json_bytes({"spdxVersion": "SPDX-2.3", "version": version})
    manifest = make_manifest(version, revision, archive, sbom, migration_count)
    manifest_bytes = json_bytes(manifest)
    prefix = f"{ROOT}{version}/{revision}/"
    values = {FILES[0]: archive, "manifest.json": manifest_bytes, "sbom.spdx.json": sbom}
    values["SHA256SUMS"] = ("\n".join(f"{hashlib.sha256(values[name]).hexdigest()}  {name}" for name in (FILES[0], "manifest.json", "sbom.spdx.json")) + "\n").encode()
    for name, value in values.items():
        client.objects[prefix + name] = value
        client.modified[prefix + name] = deployed_at
    if marker:
        client.objects[prefix + "deployed.json"] = json_bytes({
            "schemaVersion": 1,
            "application": "tennis-green-pms",
            "version": version,
            "gitRevision": revision,
            "imageId": manifest["imageId"],
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "deployedAt": deployed_at,
        })
        client.modified[prefix + "deployed.json"] = deployed_at
    return prefix, manifest, hashlib.sha256(manifest_bytes).hexdigest()


def complete_store(client, role="RETENTION"):
    return CosStore("bucket", "ap-guangzhou", role=role, client=client)


class CosStoreTests(unittest.TestCase):
    @staticmethod
    def sdk_stub(captured):
        module = types.ModuleType("qcloud_cos")

        class Config:
            def __init__(self, **kwargs):
                captured.update(kwargs)
                self._endpoint = kwargs.get("Endpoint") or f"{kwargs['Region']}.myqcloud.com"

        class Client:
            def __init__(self, config):
                captured["client_config"] = config

        module.CosConfig = Config
        module.CosS3Client = Client
        return module

    def test_sdk_config_uses_optional_global_acceleration_endpoint(self):
        captured = {}
        with patch.dict(os.environ, {
            "COS_ENDPOINT": "cos.accelerate.myqcloud.com",
            "COS_SECRET_ID": "test-id",
            "COS_SECRET_KEY": "test-key",
        }, clear=True), patch.dict(sys.modules, {"qcloud_cos": self.sdk_stub(captured)}):
            CosStore("bucket", "ap-guangzhou")._client_for()

        self.assertEqual(captured["Endpoint"], "cos.accelerate.myqcloud.com")
        self.assertEqual(captured["Region"], "ap-guangzhou")
        self.assertEqual(captured["Timeout"], (10, 60))

    def test_sdk_config_keeps_regional_default_when_endpoint_is_unset(self):
        captured = {}
        with patch.dict(os.environ, {
            "COS_SECRET_ID": "test-id",
            "COS_SECRET_KEY": "test-key",
        }, clear=True), patch.dict(sys.modules, {"qcloud_cos": self.sdk_stub(captured)}):
            CosStore("bucket", "ap-guangzhou")._client_for()

        self.assertNotIn("Endpoint", captured)
        self.assertEqual(captured["client_config"]._endpoint, "ap-guangzhou.myqcloud.com")

    def test_invalid_endpoint_is_rejected_before_sdk_or_cos_access(self):
        with patch.dict(os.environ, {
            "COS_ENDPOINT": "https://untrusted.example",
            "COS_SECRET_ID": "test-id",
            "COS_SECRET_KEY": "test-key",
        }, clear=True):
            with self.assertRaisesRegex(ReleaseError, "invalid COS endpoint"):
                CosStore("bucket", "ap-guangzhou")._client_for()

    def test_streams_download_and_reads_status_method(self):
        fake = FakeCos()
        fake.objects[ROOT + "v1.2.3/" + "a" * 40 + "/manifest.json"] = b'{"ok":true}'
        store = CosStore("bucket", "ap-guangzhou", client=fake)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "manifest.json"
            store.download(next(iter(fake.objects)), target)
            self.assertEqual(target.read_bytes(), b'{"ok":true}')
        self.assertEqual(fake.versioning_calls, 0, "read-only operations must not inspect bucket versioning")

    def test_mutation_roles_and_versioning_are_fail_closed(self):
        data = b"x"
        key = ROOT + "v1.2.3/" + "a" * 40 + "/tennis-green-pms-linux-amd64.docker.tar.zst"
        with tempfile.NamedTemporaryFile() as source:
            source.write(data)
            source.flush()
            with self.assertRaises(ReleaseError):
                CosStore("bucket", "region", client=FakeCos()).put_immutable(key, source.name)
            with self.assertRaises(ReleaseError):
                complete_store(FakeCos(), role="UPLOAD").delete(key)
            with self.assertRaises(ReleaseError):
                complete_store(FakeCos(), role="MARKER").put_immutable(key, data)
            with self.assertRaises(ReleaseError):
                complete_store(FakeCos(status="Suspended"), role="UPLOAD").put_immutable(key, source.name)

    def test_versioning_unknown_status_is_rejected(self):
        class UnknownVersioning(FakeCos):
            def get_bucket_versioning(self, Bucket):
                self.versioning_calls += 1
                return {"Unexpected": "value"}

        data = b"x"
        key = ROOT + "v1.2.3/" + "a" * 40 + "/tennis-green-pms-linux-amd64.docker.tar.zst"
        with tempfile.NamedTemporaryFile() as source:
            source.write(data)
            source.flush()
            with self.assertRaisesRegex(ReleaseError, "unknown"):
                complete_store(UnknownVersioning(), role="UPLOAD").put_immutable(key, source.name)

    def test_sdk_empty_versioning_configuration_allows_upload(self):
        class NeverVersioned(FakeCos):
            def get_bucket_versioning(self, Bucket):
                self.versioning_calls += 1
                return {"VersioningConfiguration": None}

        client = NeverVersioned()
        key = ROOT + "v1.2.3/" + "a" * 40 + "/tennis-green-pms-linux-amd64.docker.tar.zst"
        complete_store(client, role="UPLOAD").put_immutable(key, b"archive")

        self.assertEqual(client.versioning_calls, 1)
        self.assertEqual(client.objects[key], b"archive")

    def test_upload_failure_does_not_create_marker(self):
        client = FakeCos()
        client.fail_put = 500
        store = complete_store(client, role="UPLOAD")
        version, revision = "v1.2.3", "a" * 40
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / FILES[0]
            sbom = directory / "sbom.spdx.json"
            archive.write_bytes(b"archive")
            sbom.write_bytes(json_bytes({"spdxVersion": "SPDX-2.3"}))
            manifest = make_manifest(version, revision, archive.read_bytes(), sbom.read_bytes())
            (directory / "manifest.json").write_bytes(json_bytes(manifest))
            (directory / "SHA256SUMS").write_text("\n".join(
                f"{sha256_file(directory / name)}  {name}" for name in (FILES[0], "manifest.json", "sbom.spdx.json")
            ) + "\n")
            with self.assertRaises(ReleaseError):
                upload_bundle(store, directory)
        self.assertFalse(any(key.endswith("deployed.json") for key in client.objects))


class RetentionTests(unittest.TestCase):
    def test_five_keeps_all_and_six_deletes_oldest_safe(self):
        client = FakeCos()
        store = complete_store(client)
        releases = []
        for index in range(6):
            releases.append(add_release(client, f"v1.0.{index}", chr(ord("a") + index) * 40,
                                        f"2026-09-0{index + 1}T00:00:00Z")[0])
        result = retention_plan(store, {releases[0]}, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertIn(releases[1], result["deleted"])
        self.assertNotIn(releases[0], result["deleted"])
        self.assertFalse(any(key.startswith(releases[1]) for key in client.objects))

        client = FakeCos()
        store = complete_store(client)
        for index in range(5):
            add_release(client, f"v1.1.{index}", chr(ord("k") + index) * 40,
                        f"2026-09-{index + 1:02d}T00:00:00Z")
        result = retention_plan(store, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertEqual(result["deleted"], [])

    def test_more_than_six_deletes_until_five_and_preserves_unknown_prefix(self):
        client = FakeCos()
        store = complete_store(client)
        releases = []
        for index in range(8):
            releases.append(add_release(client, f"v1.2.{index}", f"{index + 16:040x}",
                                        f"2026-08-{index + 1:02d}T00:00:00Z")[0])
        client.objects[releases[0] + "unexpected.txt"] = b"keep"
        result = retention_plan(store, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertNotIn(releases[0], result["deleted"])
        self.assertTrue(any(item.get("reason") == "unknown-extra-object" for item in result["skipped"]))
        self.assertIn(releases[1], result["deleted"])
        self.assertIn(releases[2], result["deleted"])
        self.assertTrue(all(key.startswith(releases[0]) for key in client.objects if key.startswith(releases[0])))

        client = FakeCos()
        store = complete_store(client)
        releases = []
        for index in range(6):
            releases.append(add_release(client, f"v1.2.{index + 10}", f"{index + 32:040x}",
                                        f"2026-08-{index + 1:02d}T00:00:00Z")[0])
        client.objects[releases[0] + "extra/nested.txt"] = b"keep"
        result = retention_plan(store, keep=0,
                                now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertNotIn(releases[0], result["deleted"])
        self.assertTrue(any(item.get("prefix") == releases[0] and item.get("reason") == "unknown-extra-object"
                            for item in result["skipped"]))
        self.assertTrue(any(key.startswith(releases[0]) for key in client.objects))

    def test_corrupt_complete_release_is_skipped_and_partial_delete_retries(self):
        client = FakeCos()
        store = complete_store(client)
        prefix, _, _ = add_release(client, "v1.3.0", "a" * 40, "2026-08-01T00:00:00Z")
        client.objects[prefix + "SHA256SUMS"] = b"corrupt"
        result = retention_plan(store, keep=0, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertFalse(result["deleted"])
        self.assertTrue(any(item.get("reason") == "corrupt-success" for item in result["skipped"]))

        client = FakeCos()
        store = complete_store(client)
        old, _, _ = add_release(client, "v1.3.1", "b" * 40, "2026-08-01T00:00:00Z")
        for index in range(5):
            add_release(client, "v1.3.2", "c" * 40, "2026-08-02T00:00:00Z") if index == 0 else add_release(client, f"v1.3.{3 + index}", f"{index + 3:040x}", f"2026-09-{index + 1:02d}T00:00:00Z")
        client.fail_delete.add(old + FILES[0])
        first = retention_plan(store, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertTrue(first["deleteFailures"])
        client.fail_delete.clear()
        second = retention_plan(store, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertFalse(any(key.startswith(old) for key in client.objects))
        self.assertIn(old, second["deleted"])

    def test_protected_candidate_and_dry_run_do_not_delete(self):
        client = FakeCos()
        store = complete_store(client)
        prefix, manifest, _ = add_release(client, "v1.4.0", "e" * 40, "2026-08-01T00:00:00Z", marker=False)
        result = retention_plan(store, {prefix}, candidate_ttl_days=1, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertFalse(client.delete_calls)
        self.assertTrue(any(item["prefix"] == prefix and item["reason"] == "protected" for item in result["kept"]))

        client = FakeCos()
        store = complete_store(client)
        old, _, _ = add_release(client, "v1.4.1", "f" * 40, "2026-08-01T00:00:00Z")
        result = retention_plan(store, keep=0, dry_run=True, now=__import__("datetime").datetime.fromisoformat("2026-09-20T00:00:00+00:00"))
        self.assertIn(old, result["deleted"])
        self.assertFalse(client.delete_calls)


class OrchestrationTests(unittest.TestCase):
    def ssh_environment(self, temporary):
        key = Path(temporary) / "key"
        known_hosts = Path(temporary) / "known_hosts"
        key.write_text("key")
        known_hosts.write_text("host")
        return patch.dict(os.environ, {
            "DEPLOY_HOST": "deploy.example",
            "DEPLOY_USER": "tennis-green-pms-deploy",
            "DEPLOY_SSH_KEY_FILE": str(key),
            "DEPLOY_KNOWN_HOSTS_FILE": str(known_hosts),
        }, clear=False)

    def test_large_receipt_marker_health_gate_and_first_success_time(self):
        client = FakeCos()
        marker_store = CosStore("bucket", "region", role="MARKER", client=client)
        prefix, manifest, manifest_sha = add_release(client, "v2.0.0", "a" * 40, "2026-09-09T10:00:00Z", marker=False, migration_count=57)
        receipt = {"application": "tennis-green-pms", "status": "healthy", "deployedAt": "2026-09-09T10:00:00Z",
                   "current": {"prefix": prefix, "manifestSha256": manifest_sha, "manifest": manifest,
                               "runtimeImageId": "sha256:" + "f" * 64},
                   "previous": None, "rollbackFrom": None}
        processes = []
        with tempfile.TemporaryDirectory() as temporary, self.ssh_environment(temporary):
            def ssh_factory(argv):
                processes.append((argv, FakeSSH(receipt)))
                return processes[-1][1]
            result = deploy("v2.0.0", "a" * 40, prefix, manifest_sha, store=marker_store, ssh_factory=ssh_factory)
        argv = processes[0][0]
        for option in (
            "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3", "-o", "IdentitiesOnly=yes",
            "-o", "ForwardAgent=no", "-o", "RequestTTY=no",
        ):
            self.assertIn(option, argv)
        self.assertEqual(processes[0][1].wait_calls, [600])
        self.assertGreater(len(json.dumps(receipt)), 4096)
        self.assertLess(len(json.dumps(receipt)), MAX_RECEIPT_BYTES)
        marker = json.loads(client.objects[prefix + "deployed.json"])
        self.assertEqual(marker["deployedAt"], receipt["deployedAt"])
        self.assertEqual(processes[0][1].stdin.getvalue(), '{"result":"complete"}\n')

        old_marker_time = marker["deployedAt"]
        receipt["deployedAt"] = "2026-09-09T12:00:00Z"
        with tempfile.TemporaryDirectory() as temporary, self.ssh_environment(temporary):
            deploy("v2.0.0", "a" * 40, prefix, manifest_sha, store=marker_store,
                   ssh_factory=lambda argv: FakeSSH(receipt))
        self.assertEqual(json.loads(client.objects[prefix + "deployed.json"])["deployedAt"], old_marker_time)

    def test_dry_run_uses_maintenance_for_legacy_and_rejects_missing_current(self):
        client = FakeCos()
        store = complete_store(client, role="MARKER")
        prefix, manifest, manifest_sha = add_release(client, "v2.1.0", "b" * 40, "2026-09-09T10:00:00Z", marker=False)
        legacy_manifest = {"version": "v1.2.3", "gitRevision": "c" * 40, "imageId": "sha256:" + "1" * 64,
                           "imageTag": "sha256:" + "1" * 64, "requiredMigrations": migrations(57),
                           "rollbackCompatibility": {"mode": "same-migrations-only", "reason": "baseline"}}
        legacy_receipt = {"application": "tennis-green-pms", "status": "healthy", "deployedAt": "2026-09-09T10:00:00Z",
                          "current": {"legacy": True, "prefix": None, "manifestSha256": None, "manifest": legacy_manifest},
                          "previous": None, "rollbackFrom": None,
                          "localImagePlan": [{"imageId": "sha256:" + "2" * 64, "action": "keep", "reason": "current/previous"}]}
        with tempfile.TemporaryDirectory() as temporary, self.ssh_environment(temporary):
            captured = []
            result = deploy("v2.1.0", "b" * 40, prefix, manifest_sha, dry_run=True, store=store,
                            ssh_factory=lambda argv: captured.append((argv, FakeSSH(legacy_receipt))) or captured[-1][1])
        self.assertEqual(captured[0][0][-1], "maintenance")
        self.assertFalse(any(key.endswith("deployed.json") for key in client.objects))
        self.assertEqual(result["localImagePlan"][0]["imageId"], "sha256:" + "2" * 64)

        empty_receipt = dict(legacy_receipt, current=None)
        with tempfile.TemporaryDirectory() as temporary, self.ssh_environment(temporary):
            with self.assertRaises(ReleaseError):
                deploy("v2.1.0", "b" * 40, prefix, manifest_sha, dry_run=True, store=store,
                       ssh_factory=lambda argv: FakeSSH(empty_receipt))

    def test_receipt_schema_rejects_unexpected_fields(self):
        prefix = f"{ROOT}v2.1.0/{'b' * 40}/"
        manifest = make_manifest("v2.1.0", "b" * 40)
        current = {"prefix": prefix, "manifestSha256": "c" * 64, "manifest": manifest,
                   "runtimeImageId": "sha256:" + "f" * 64}
        receipt = {"application": "tennis-green-pms", "status": "healthy", "deployedAt": "2026-09-09T10:00:00Z",
                   "current": current, "previous": None, "rollbackFrom": None}
        validate_receipt(receipt)
        with self.assertRaisesRegex(ReleaseError, "unexpected schema"):
            validate_receipt({**receipt, "untrusted": "value"})
        with self.assertRaisesRegex(ReleaseError, "unexpected schema"):
            validate_receipt({**receipt, "current": {**current, "untrusted": "value"}})
        with self.assertRaisesRegex(ReleaseError, "runtime image identity"):
            validate_receipt({**receipt, "current": {**current, "runtimeImageId": "sha256:bad"}})

    def test_restricted_server_error_is_reported_without_arbitrary_stderr(self):
        with tempfile.TemporaryDirectory() as temporary, self.ssh_environment(temporary):
            session = LockedSSH("maintenance", ssh_factory=lambda argv: FakeSSH(
                None, returncode=1, stderr="Tennis-Green-PMS: running container differs from recorded current; recover first\n"
            ))
            with self.assertRaisesRegex(ReleaseError, "running container differs"):
                session.receipt()

            session = LockedSSH("maintenance", ssh_factory=lambda argv: FakeSSH(
                None, returncode=1, stderr="SENTINEL_DATABASE_PASSWORD\n"
            ))
            with self.assertRaisesRegex(ReleaseError, "did not return one JSON receipt") as error:
                session.receipt()
            self.assertNotIn("SENTINEL", str(error.exception))


if __name__ == "__main__":
    unittest.main()
