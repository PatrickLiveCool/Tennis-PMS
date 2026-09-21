"""COS finalization and the locked SSH orchestration client."""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Callable

try:
    from .common import (FILES, HEX, ReleaseError, image_tag, json_bytes,
                         release_prefix, sha256_file, utcnow, validate_manifest,
                         validate_identity, validate_migrations)
    from .cos import CosStore, ROOT_PREFIX
except ImportError:
    from common import (FILES, HEX, ReleaseError, image_tag, json_bytes,
                        release_prefix, sha256_file, utcnow, validate_manifest,
                        validate_identity, validate_migrations)
    from cos import CosStore, ROOT_PREFIX


MARKER = "deployed.json"
SUCCESS_FILES = (*FILES, MARKER)
LOCK_TIMEOUT_SECONDS = 600
MAX_RECEIPT_BYTES = 256 * 1024
_VERSION_RE = r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
_REVISION_RE = r"[0-9a-f]{40}"
_RELEASE_KEY_RE = re.compile(rf"^(?P<version>{_VERSION_RE})/(?P<revision>{_REVISION_RE})/$")


def _event(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True, separators=(",", ":")), file=sys.stderr, flush=True)


def _timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        result = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return result.astimezone(timezone.utc)
    if not isinstance(value, str):
        raise ReleaseError("invalid release timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ReleaseError("invalid release timestamp") from exc
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def _prefix_from_ref(reference: Any) -> str | None:
    if not isinstance(reference, dict):
        return None
    prefix = reference.get("prefix")
    return prefix if isinstance(prefix, str) and prefix else None


def _validate_legacy(reference: dict[str, Any]) -> None:
    if not reference.get("legacy"):
        return
    if set(reference) != {"legacy", "prefix", "manifestSha256", "manifest"}:
        raise ReleaseError("legacy receipt reference has an unexpected schema")
    if reference.get("prefix") is not None or reference.get("manifestSha256") is not None:
        raise ReleaseError("legacy receipt reference has an unexpected release key")
    manifest = reference.get("manifest")
    if not isinstance(manifest, dict):
        raise ReleaseError("legacy receipt reference has no manifest")
    if set(manifest) != {"version", "gitRevision", "imageId", "imageTag", "requiredMigrations", "rollbackCompatibility"}:
        raise ReleaseError("legacy receipt manifest has an unexpected schema")
    validate_identity(manifest.get("version"), manifest.get("gitRevision"))
    if not isinstance(manifest.get("imageId"), str) or re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["imageId"]) is None:
        raise ReleaseError("legacy receipt image identity is invalid")
    if manifest.get("imageTag") != manifest.get("imageId"):
        raise ReleaseError("legacy receipt image identity is invalid")
    validate_migrations(manifest.get("requiredMigrations"))
    compatibility = manifest.get("rollbackCompatibility")
    if (not isinstance(compatibility, dict) or set(compatibility) != {"mode", "reason"}
            or compatibility.get("mode") not in {"same-migrations-only", "forward-only"}
            or not isinstance(compatibility.get("reason"), str)
            or not compatibility["reason"].strip()):
        raise ReleaseError("legacy receipt rollback compatibility is invalid")


def _validate_ref(reference: Any, *, allow_legacy: bool = True) -> None:
    if reference is None:
        return
    if not isinstance(reference, dict):
        raise ReleaseError("receipt release reference is invalid")
    if reference.get("legacy"):
        if not allow_legacy:
            raise ReleaseError("legacy receipt reference is not a deploy target")
        _validate_legacy(reference)
        return
    prefix = reference.get("prefix")
    manifest_sha = reference.get("manifestSha256")
    manifest = reference.get("manifest")
    if set(reference) not in ({"prefix", "manifestSha256", "manifest"},
                              {"prefix", "manifestSha256", "manifest", "runtimeImageId"}):
        raise ReleaseError("receipt release reference has an unexpected schema")
    if not isinstance(prefix, str) or not prefix.endswith("/"):
        raise ReleaseError("receipt release prefix is invalid")
    if not prefix.startswith(ROOT_PREFIX):
        raise ReleaseError("receipt release prefix is invalid")
    parts = prefix[len(ROOT_PREFIX):].split("/")
    if len(parts) != 3 or not parts[2] == "":
        raise ReleaseError("receipt release prefix is invalid")
    validate_identity(parts[0], parts[1])
    if not isinstance(manifest_sha, str) or HEX.fullmatch(manifest_sha) is None:
        raise ReleaseError("receipt manifest checksum is invalid")
    runtime_image_id = reference.get("runtimeImageId")
    if runtime_image_id is not None and (not isinstance(runtime_image_id, str)
                                         or re.fullmatch(r"sha256:[0-9a-f]{64}", runtime_image_id) is None):
        raise ReleaseError("receipt runtime image identity is invalid")
    validate_manifest(manifest, parts[0], parts[1])


def _validate_local_image_plan(value: Any) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 1000:
        raise ReleaseError("receipt local image plan is invalid")
    result: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"imageId", "action", "reason"}:
            raise ReleaseError("receipt local image plan is invalid")
        if not isinstance(item["imageId"], str) or re.fullmatch(r"sha256:[0-9a-f]{64}", item["imageId"]) is None:
            raise ReleaseError("receipt local image plan image identity is invalid")
        if item["action"] not in {"keep", "delete"} or (item["reason"] is not None and not isinstance(item["reason"], str)):
            raise ReleaseError("receipt local image plan decision is invalid")
        result.append(item)
    return result


def validate_receipt(receipt: Any, *, expected_prefix: str | None = None,
                     expected_manifest_sha: str | None = None,
                     expected_manifest: dict[str, Any] | None = None) -> dict[str, Any]:
    if not isinstance(receipt, dict):
        raise ReleaseError("server receipt is not JSON")
    required = {"application", "status", "deployedAt", "current", "previous", "rollbackFrom"}
    allowed = required | {"localImagePlan"}
    if not required.issubset(receipt) or not set(receipt).issubset(allowed):
        raise ReleaseError("server receipt has an unexpected schema")
    if receipt.get("application") != "tennis-green-pms" or receipt.get("status") != "healthy":
        raise ReleaseError("server did not report a healthy Tennis-Green-PMS release")
    _timestamp(receipt.get("deployedAt"))
    _validate_local_image_plan(receipt.get("localImagePlan"))
    current = receipt.get("current")
    if not isinstance(current, dict):
        raise ReleaseError("healthy receipt has no current release")
    _validate_ref(current, allow_legacy=False)
    if expected_prefix is not None:
        if not isinstance(current, dict) or current.get("prefix") != expected_prefix:
            raise ReleaseError("server healthy receipt identifies a different release")
    if expected_manifest_sha is not None and current.get("manifestSha256") != expected_manifest_sha:
        raise ReleaseError("server healthy receipt has a different manifest checksum")
    if expected_manifest is not None and current.get("manifest") != expected_manifest:
        raise ReleaseError("server healthy receipt manifest differs from COS manifest")
    for name in ("previous", "rollbackFrom"):
        _validate_ref(receipt.get(name), allow_legacy=True)
    return receipt


def _read_manifest(store: CosStore, prefix: str) -> tuple[dict[str, Any], str]:
    with tempfile.TemporaryDirectory(prefix="tennis-green-pms-manifest-") as temporary:
        path = Path(temporary) / "manifest.json"
        store.download(prefix + "manifest.json", path)
        digest = sha256_file(path)
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("COS manifest is invalid JSON") from exc
    validate_manifest(manifest)
    return manifest, digest


def _download_bytes(store: CosStore, key: str, limit: int | None = None) -> bytes:
    with tempfile.TemporaryDirectory(prefix="tennis-green-pms-cos-object-") as temporary:
        path = Path(temporary) / "object"
        store.download(key, path)
        if limit is not None and path.stat().st_size > limit:
            raise ReleaseError("COS object is too large")
        return path.read_bytes()


def _marker(manifest: dict[str, Any], manifest_sha: str, deployed_at: str) -> dict[str, Any]:
    validate_manifest(manifest)
    _timestamp(deployed_at)
    return {"schemaVersion": 1, "application": "tennis-green-pms", "version": manifest["version"],
            "gitRevision": manifest["gitRevision"], "imageId": manifest["imageId"],
            "manifestSha256": manifest_sha, "deployedAt": deployed_at}


def _ensure_marker(store: CosStore, prefix: str, manifest: dict[str, Any], manifest_sha: str,
                   deployed_at: str) -> dict[str, Any]:
    key = prefix + MARKER
    expected = _marker(manifest, manifest_sha, deployed_at)
    try:
        existing = store.read_json(key)
    except ReleaseError as exc:
        if "missing" not in str(exc):
            raise
        existing = None
    if existing is not None:
        if set(existing) != set(expected) or existing.get("schemaVersion") != 1 or existing.get("application") != "tennis-green-pms":
            raise ReleaseError("existing deployed marker is invalid")
        for field in ("version", "gitRevision", "imageId", "manifestSha256"):
            if existing.get(field) != expected[field]:
                raise ReleaseError("existing deployed marker identifies another release")
        _timestamp(existing.get("deployedAt"))
        expected["deployedAt"] = existing["deployedAt"]
    store.put_immutable(key, json_bytes(expected))
    return expected


def _object_manifest(store: CosStore, prefix: str) -> tuple[dict[str, Any], str]:
    return _read_manifest(store, prefix)


def _parse_checksum_file(data: bytes) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in data.decode("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or HEX.fullmatch(parts[0]) is None:
            raise ReleaseError("invalid SHA256SUMS object")
        name = parts[1].lstrip("*")
        if name not in {FILES[0], "manifest.json", "sbom.spdx.json"} or name in values:
            raise ReleaseError("invalid SHA256SUMS object")
        values[name] = parts[0]
    if set(values) != {FILES[0], "manifest.json", "sbom.spdx.json"}:
        raise ReleaseError("incomplete SHA256SUMS object")
    return values


def _release_groups(store: CosStore) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    groups: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    unknown: dict[str, list[dict[str, Any]]] = defaultdict(list)
    malformed: list[dict[str, Any]] = []
    root = store.prefix
    for item in store.list(root):
        key = item.get("key")
        if not isinstance(key, str) or not key.startswith(root):
            malformed.append(item)
            continue
        remainder = key[len(root):]
        parts = remainder.split("/")
        if len(parts) < 3 or not parts[0] or not parts[1]:
            malformed.append(item)
            continue
        candidate_prefix = root + parts[0] + "/" + parts[1] + "/"
        try:
            validate_identity(parts[0], parts[1])
        except ReleaseError:
            malformed.append(item)
            continue
        if len(parts) != 3 or not parts[2] or parts[2] not in SUCCESS_FILES:
            unknown[candidate_prefix].append(item)
        else:
            groups[candidate_prefix][parts[2]] = item
    return groups, unknown, malformed


def _valid_success(store: CosStore, prefix: str, files: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], str, dict[str, Any]]:
    missing = [name for name in SUCCESS_FILES if name not in files]
    if missing:
        raise ReleaseError("incomplete successful release: " + ",".join(missing))
    manifest, manifest_sha = _object_manifest(store, prefix)
    parts = prefix.removeprefix(store.prefix).split("/")
    validate_manifest(manifest, parts[0], parts[1])
    checksum = _parse_checksum_file(_download_bytes(store, prefix + "SHA256SUMS", 1024 * 1024))
    if checksum["manifest.json"] != manifest_sha or checksum["sbom.spdx.json"] != manifest["sbomSha256"] or checksum[FILES[0]] != manifest["archiveSha256"]:
        raise ReleaseError("successful release checksum metadata does not match manifest")
    marker = store.read_json(prefix + MARKER)
    expected = _marker(manifest, manifest_sha, marker.get("deployedAt"))
    if marker != expected:
        raise ReleaseError("deployed marker does not match manifest")
    return manifest, manifest_sha, marker


def _valid_partial_marker(store: CosStore, prefix: str, files: dict[str, dict[str, Any]]) -> dict[str, Any]:
    marker = store.read_json(prefix + MARKER)
    parts = prefix.removeprefix(store.prefix).split("/")
    if set(marker) != {"schemaVersion", "application", "version", "gitRevision", "imageId", "manifestSha256", "deployedAt"}:
        raise ReleaseError("partial release marker has an unexpected schema")
    if marker["schemaVersion"] != 1 or marker["application"] != "tennis-green-pms":
        raise ReleaseError("partial release marker is invalid")
    validate_identity(parts[0], parts[1])
    if marker["version"] != parts[0] or marker["gitRevision"] != parts[1]:
        raise ReleaseError("partial release marker identity does not match prefix")
    if not isinstance(marker["imageId"], str) or re.fullmatch(r"sha256:[0-9a-f]{64}", marker["imageId"]) is None:
        raise ReleaseError("partial release marker image identity is invalid")
    if HEX.fullmatch(marker["manifestSha256"]) is None:
        raise ReleaseError("partial release marker checksum is invalid")
    _timestamp(marker["deployedAt"])
    if "manifest.json" in files:
        manifest, manifest_sha = _object_manifest(store, prefix)
        validate_manifest(manifest, parts[0], parts[1])
        if manifest_sha != marker["manifestSha256"] or manifest["imageId"] != marker["imageId"]:
            raise ReleaseError("partial release manifest is not bound to marker")
    return marker


def _candidate_old(files: dict[str, dict[str, Any]], cutoff: datetime) -> bool:
    if not files:
        return False
    try:
        return all(_timestamp(item.get("lastModified")) <= cutoff for item in files.values())
    except ReleaseError:
        return False


def _delete_keys(store: CosStore, prefix: str, names: list[str], result: dict[str, Any]) -> None:
    # Keep deployed.json until every known payload deletion has succeeded.
    failures: list[str] = []
    deletion_order = (FILES[0], "sbom.spdx.json", "SHA256SUMS", "manifest.json")
    for name in [item for item in deletion_order if item in names]:
        try:
            store.delete(prefix + name)
        except ReleaseError:
            failures.append(name)
            _event("retention_delete_failed", prefix=prefix, object=name)
    if not failures and MARKER in names:
        try:
            store.delete(prefix + MARKER)
        except ReleaseError:
            failures.append(MARKER)
            _event("retention_delete_failed", prefix=prefix, object=MARKER)
    if failures:
        result["deleteFailures"].append({"prefix": prefix, "objects": failures})
    else:
        result["deleted"].append(prefix)


def retention_plan(store: CosStore, protected_prefixes: set[str] | None = None, *, keep: int = 5,
                   candidate_ttl_days: int = 7, dry_run: bool = False,
                   now: datetime | None = None) -> dict[str, Any]:
    protected = {prefix for prefix in (protected_prefixes or set()) if prefix}
    current_time = now or datetime.now(timezone.utc)
    cutoff = current_time - timedelta(days=candidate_ttl_days)
    groups, unknown, malformed = _release_groups(store)
    result: dict[str, Any] = {"status": "dry-run" if dry_run else "complete", "kept": [], "deleted": [],
                              "candidates": [], "skipped": [], "deleteFailures": []}
    successful: list[tuple[datetime, str]] = []
    partial: list[tuple[datetime, str, dict[str, dict[str, Any]]]] = []
    for prefix, files in sorted(groups.items()):
        # An extra object makes the whole immutable prefix untrusted. Do this
        # before validating or deleting any of its known release objects.
        if prefix in unknown:
            if prefix in protected:
                result["kept"].append({"prefix": prefix, "reason": "protected"})
            result["skipped"].append({"prefix": prefix, "reason": "unknown-extra-object"})
            continue
        if prefix in protected:
            result["kept"].append({"prefix": prefix, "reason": "protected"})
            if MARKER not in files:
                continue
        if MARKER not in files:
            try:
                if "manifest.json" in files:
                    manifest, _ = _object_manifest(store, prefix)
                    validate_manifest(manifest, prefix.removeprefix(store.prefix).split("/")[0], prefix.removeprefix(store.prefix).split("/")[1])
                if _candidate_old(files, cutoff):
                    result["candidates"].append({"prefix": prefix, "reason": "expired-unapproved-candidate"})
                    if not dry_run:
                        _delete_keys(store, prefix, list(files), result)
                else:
                    result["skipped"].append({"prefix": prefix, "reason": "candidate-not-expired"})
            except ReleaseError as exc:
                result["skipped"].append({"prefix": prefix, "reason": "corrupt-candidate"})
                _event("retention_skip", prefix=prefix, reason="corrupt-candidate")
            continue
        try:
            manifest, manifest_sha, marker = _valid_success(store, prefix, files)
            successful.append((_timestamp(marker["deployedAt"]), prefix))
        except ReleaseError:
            if all(name in files for name in SUCCESS_FILES):
                result["skipped"].append({"prefix": prefix, "reason": "corrupt-success"})
                _event("retention_skip", prefix=prefix, reason="corrupt-success")
                continue
            try:
                marker = _valid_partial_marker(store, prefix, files)
                partial.append((_timestamp(marker["deployedAt"]), prefix, files))
                _event("retention_partial", prefix=prefix, reason="trusted-marker-with-missing-payload")
            except ReleaseError:
                result["skipped"].append({"prefix": prefix, "reason": "incomplete-or-corrupt-success"})
                _event("retention_skip", prefix=prefix, reason="incomplete-or-corrupt-success")

    successful.sort(key=lambda item: (item[0], item[1]))
    excess = max(0, len(successful) - max(0, keep))
    planned_delete: set[str] = set()
    for _, prefix in successful:
        if prefix in protected:
            continue
        if excess and prefix not in planned_delete:
            planned_delete.add(prefix)
            excess -= 1
    for _, prefix in successful:
        if prefix in planned_delete:
            if dry_run:
                result["deleted"].append(prefix)
            else:
                _delete_keys(store, prefix, list(groups[prefix]), result)
        elif not any(item.get("prefix") == prefix for item in result["kept"]):
            result["kept"].append({"prefix": prefix, "reason": "newest-successes"})
    retained_successes = [(deployed_at, prefix) for deployed_at, prefix in successful if prefix not in planned_delete]
    oldest_kept = min((deployed_at for deployed_at, _ in retained_successes), default=None)
    for deployed_at, prefix, files in sorted(partial):
        if prefix in protected:
            result["skipped"].append({"prefix": prefix, "reason": "protected-partial-release"})
            continue
        beyond_boundary = oldest_kept is not None and deployed_at < oldest_kept
        expired = deployed_at <= cutoff
        if not (beyond_boundary or expired):
            result["skipped"].append({"prefix": prefix, "reason": "partial-within-retention-boundary"})
            continue
        result["candidates"].append({"prefix": prefix, "reason": "retry-partial-success-deletion"})
        if dry_run:
            result["deleted"].append(prefix)
        else:
            _delete_keys(store, prefix, list(files), result)
    for prefix, items in sorted(unknown.items()):
        if prefix not in groups:
            if prefix in protected:
                result["kept"].append({"prefix": prefix, "reason": "protected"})
            result["skipped"].append({"prefix": prefix, "reason": "unknown-extra-object", "count": len(items)})
    for item in malformed:
        result["skipped"].append({"key": item.get("key"), "reason": "invalid-release-key"})
    if result["deleteFailures"]:
        result["status"] = "warning"
    return result


class LockedSSH:
    def __init__(self, operation: str, version: str | None = None, revision: str | None = None,
                 key: str | None = None, manifest_sha: str | None = None,
                 ssh_factory: Callable[[list[str]], Any] | None = None):
        self.operation = operation
        self.process = self._start(operation, version, revision, key, manifest_sha, ssh_factory)

    @staticmethod
    def _start(operation: str, version: str | None, revision: str | None, key: str | None,
               manifest_sha: str | None, ssh_factory: Callable[[list[str]], Any] | None) -> Any:
        host = os.environ.get("DEPLOY_HOST")
        user = os.environ.get("DEPLOY_USER")
        identity = os.environ.get("DEPLOY_SSH_KEY_FILE")
        known_hosts = os.environ.get("DEPLOY_KNOWN_HOSTS_FILE")
        if not host or not user or not identity or not known_hosts:
            raise ReleaseError("restricted deployment SSH environment is incomplete")
        if not re.fullmatch(r"[A-Za-z0-9._-]+", host) or not re.fullmatch(r"[A-Za-z0-9._-]+", user):
            raise ReleaseError("deployment SSH identity is invalid")
        if not Path(identity).is_file() or not Path(known_hosts).is_file():
            raise ReleaseError("deployment SSH key or known_hosts file is unavailable")
        if operation in {"deploy", "rollback"}:
            validate_identity(version, revision)
            if not isinstance(key, str) or key != release_prefix(ROOT_PREFIX, version, revision):
                raise ReleaseError("invalid remote release key")
            if not isinstance(manifest_sha, str) or HEX.fullmatch(manifest_sha) is None:
                raise ReleaseError("invalid remote manifest checksum")
            remote = [operation, version, revision, key, manifest_sha]
        elif operation == "maintenance":
            remote = [operation]
        else:
            raise ReleaseError("unsupported remote operation")
        argv = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "RequestTTY=no",
                "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes",
                "-o", "ForwardAgent=no", "-o", "ConnectTimeout=15",
                "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
                "-o", f"UserKnownHostsFile={known_hosts}", "-o", "ClearAllForwardings=yes",
                "-i", identity, f"{user}@{host}", *remote]
        if ssh_factory is not None:
            return ssh_factory(argv)
        try:
            return subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True, shell=False)
        except OSError as exc:
            raise ReleaseError("unable to start restricted deployment SSH") from exc

    def receipt(self) -> dict[str, Any]:
        if self.process.stdout is None:
            raise ReleaseError("deployment SSH has no stdout")
        # The server deliberately holds the flock while it waits for this
        # receipt's ACK. The Actions job timeout owns the overall session
        # lifetime; the 600-second wait below starts only after ACK.
        line = self.process.stdout.readline(MAX_RECEIPT_BYTES + 1)
        if not line or len(line) > MAX_RECEIPT_BYTES or not line.endswith("\n"):
            if self.process.stderr is not None:
                remote_error = self.process.stderr.readline(513)
                if (remote_error.endswith("\n") and len(remote_error) <= 512
                        and remote_error.startswith("Tennis-Green-PMS: ")
                        and all(character.isprintable() for character in remote_error.rstrip("\n"))):
                    raise ReleaseError(remote_error.rstrip("\n"))
            raise ReleaseError("server did not return one JSON receipt line")
        try:
            receipt = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ReleaseError("server receipt is not JSON") from exc
        return receipt

    def ack(self, result: str) -> None:
        if result not in {"complete", "failed", "dry-run"}:
            raise ReleaseError("invalid orchestration result")
        if self.process.stdin is None:
            raise ReleaseError("deployment SSH has no stdin")
        self.process.stdin.write(json.dumps({"result": result}, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def finish(self, *, success: bool) -> None:
        # Wait for server cleanup after ACK; the server holds its lock until
        # this SSH session closes. The Actions job bounds the overall lifetime.
        remaining = LOCK_TIMEOUT_SECONDS
        try:
            return_code = self.process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            self.close(force=True)
            raise ReleaseError("server lock session timed out") from None
        finally:
            if self.process.stdin is not None:
                self.process.stdin.close()
        if success and return_code != 0:
            raise ReleaseError("server rejected completed deployment session")

    def close(self, *, force: bool = False) -> None:
        if force and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.process.stdin is not None:
            try:
                self.process.stdin.close()
            except OSError:
                pass


def _protected(receipt: dict[str, Any]) -> set[str]:
    return {_prefix_from_ref(receipt.get(name)) for name in ("current", "previous", "rollbackFrom") if _prefix_from_ref(receipt.get(name))}


def _session(operation: str, callback: Callable[[dict[str, Any]], tuple[str, dict[str, Any]]], *,
            version: str | None = None, revision: str | None = None, key: str | None = None,
            manifest_sha: str | None = None, ssh_factory: Callable[[list[str]], Any] | None = None) -> dict[str, Any]:
    session = LockedSSH(operation, version, revision, key, manifest_sha, ssh_factory)
    try:
        receipt = session.receipt()
        ack, result = callback(receipt)
        session.ack(ack)
        session.finish(success=ack == "complete")
        return result
    except BaseException:
        try:
            session.ack("failed")
            session.finish(success=False)
        except BaseException:
            session.close(force=True)
        raise


def _stores(store: CosStore | None, marker_store: CosStore | None, retention_store: CosStore | None) -> tuple[CosStore, CosStore]:
    if store is not None:
        return store, store
    marker = marker_store or CosStore(os.environ.get("COS_BUCKET"), os.environ.get("COS_REGION"), role="MARKER")
    retention = retention_store or CosStore(os.environ.get("COS_BUCKET"), os.environ.get("COS_REGION"), role="RETENTION")
    return marker, retention


def deploy(version: str, revision: str, key: str, manifest_sha: str, *, dry_run: bool = False,
           store: CosStore | None = None, marker_store: CosStore | None = None,
           retention_store: CosStore | None = None, ssh_factory: Callable[[list[str]], Any] | None = None,
           now: datetime | None = None) -> dict[str, Any]:
    return _deploy_or_rollback("deploy", version, revision, key, manifest_sha, dry_run=dry_run,
                               store=store, marker_store=marker_store, retention_store=retention_store,
                               ssh_factory=ssh_factory, now=now)


def rollback(version: str, revision: str, key: str, manifest_sha: str, *, dry_run: bool = False,
             store: CosStore | None = None, marker_store: CosStore | None = None,
             retention_store: CosStore | None = None, ssh_factory: Callable[[list[str]], Any] | None = None,
             now: datetime | None = None) -> dict[str, Any]:
    return _deploy_or_rollback("rollback", version, revision, key, manifest_sha, dry_run=dry_run,
                               store=store, marker_store=marker_store, retention_store=retention_store,
                               ssh_factory=ssh_factory, now=now)


def rollback_release(version: str, *, revision: str | None = None, dry_run: bool = False,
                     store: CosStore | None = None,
                     ssh_factory: Callable[[list[str]], Any] | None = None) -> dict[str, Any]:
    """Resolve one previously healthy COS release for the GitHub rollback form."""
    validate_identity(version, revision if revision is not None else "0" * 40)
    marker_client, retention_client = _stores(store, None, None)
    groups, unknown, _ = _release_groups(retention_client)
    matches = []
    for prefix, files in groups.items():
        parts = prefix.removeprefix(ROOT_PREFIX).split("/")
        if parts[0] != version or (revision is not None and parts[1] != revision):
            continue
        if MARKER not in files:
            continue
        if prefix in unknown:
            raise ReleaseError("rollback release contains unknown objects")
        manifest, digest, _ = _valid_success(retention_client, prefix, files)
        matches.append((manifest, prefix, digest))
    if not matches:
        raise ReleaseError("no complete successfully deployed COS release matches this version")
    if len(matches) != 1:
        raise ReleaseError("multiple successful revisions match; specify the full Git revision")
    manifest, prefix, digest = matches[0]
    return rollback(version, manifest["gitRevision"], prefix, digest, dry_run=dry_run,
                    marker_store=marker_client, retention_store=retention_client,
                    ssh_factory=ssh_factory)


def _deploy_or_rollback(operation: str, version: str, revision: str, key: str, manifest_sha: str, *,
                        dry_run: bool, store: CosStore | None, marker_store: CosStore | None,
                        retention_store: CosStore | None, ssh_factory: Callable[[list[str]], Any] | None,
                        now: datetime | None) -> dict[str, Any]:
    validate_identity(version, revision)
    if key != release_prefix(ROOT_PREFIX, version, revision) or HEX.fullmatch(manifest_sha) is None:
        raise ReleaseError("invalid release request")
    manifest_client, retention_client = _stores(store, marker_store, retention_store)
    manifest, actual_sha = _read_manifest(manifest_client, key)
    if actual_sha != manifest_sha:
        raise ReleaseError("COS manifest checksum does not match request")
    if operation == "rollback" and manifest["rollbackCompatibility"]["mode"] == "forward-only":
        raise ReleaseError("forward-only release cannot be directly rolled back")
    if dry_run:
        def snapshot(receipt: dict[str, Any]) -> tuple[str, dict[str, Any]]:
            current = receipt.get("current")
            if isinstance(current, dict) and current.get("legacy"):
                _validate_ref(receipt["current"], allow_legacy=True)
            else:
                validate_receipt(receipt)
            plan = retention_plan(retention_client, _protected(receipt), dry_run=True, now=now)
            return "dry-run", {"application": "tennis-green-pms", "status": "dry-run", "manifest": manifest,
                               "manifestSha256": manifest_sha, "snapshot": receipt, "localImagePlan": receipt.get("localImagePlan"),
                               "retention": plan}
        return _session("maintenance", snapshot, ssh_factory=ssh_factory)

    def finalize(receipt: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        validate_receipt(receipt, expected_prefix=key, expected_manifest_sha=manifest_sha, expected_manifest=manifest)
        marker = _ensure_marker(manifest_client, key, manifest, manifest_sha, receipt["deployedAt"])
        plan = retention_plan(retention_client, _protected(receipt), now=now)
        if plan["deleteFailures"]:
            raise ReleaseError("COS retention deletion failed; healthy version retained; retry required")
        return "complete", {"application": "tennis-green-pms", "status": "healthy", "receipt": receipt,
                            "marker": marker, "retention": plan}
    return _session(operation, finalize, version=version, revision=revision, key=key,
                    manifest_sha=manifest_sha, ssh_factory=ssh_factory)


def maintenance(*, dry_run: bool = False, store: CosStore | None = None,
                retention_store: CosStore | None = None,
                ssh_factory: Callable[[list[str]], Any] | None = None,
                now: datetime | None = None) -> dict[str, Any]:
    _, retention_client = _stores(store, None, retention_store)

    def finalize(receipt: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        current = receipt.get("current") or {}
        if current.get("legacy"):
            _validate_ref(current, allow_legacy=True)
            if receipt.get("previous") is not None or receipt.get("rollbackFrom") is not None:
                raise ReleaseError("legacy maintenance receipt has unexpected history")
        else:
            validate_receipt(receipt)
        _validate_local_image_plan(receipt.get("localImagePlan"))
        plan = retention_plan(retention_client, _protected(receipt), dry_run=dry_run, now=now)
        if not dry_run and plan["deleteFailures"]:
            raise ReleaseError("COS retention deletion failed; retry required")
        return ("dry-run" if dry_run else "complete"), {"application": "tennis-green-pms", "status": "dry-run" if dry_run else "healthy",
                                                        "snapshot": receipt, "localImagePlan": receipt.get("localImagePlan"),
                                                        "retention": plan}
    return _session("maintenance", finalize, ssh_factory=ssh_factory)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tennis-Green-PMS locked production orchestration")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for name in ("deploy", "rollback"):
        command = subparsers.add_parser(name)
        command.add_argument("--version", required=True)
        command.add_argument("--revision", required=True)
        command.add_argument("--key", required=True)
        command.add_argument("--manifest-sha", required=True)
        command.add_argument("--dry-run", action="store_true")
    maintenance_parser = subparsers.add_parser("maintenance")
    maintenance_parser.add_argument("--dry-run", action="store_true")
    rollback_parser = subparsers.add_parser("rollback-release")
    rollback_parser.add_argument("--version", required=True)
    rollback_parser.add_argument("--revision")
    rollback_parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.operation == "deploy":
        result = deploy(args.version, args.revision, args.key, args.manifest_sha, dry_run=args.dry_run)
    elif args.operation == "rollback":
        result = rollback(args.version, args.revision, args.key, args.manifest_sha, dry_run=args.dry_run)
    elif args.operation == "rollback-release":
        result = rollback_release(args.version, revision=args.revision, dry_run=args.dry_run)
    else:
        result = maintenance(dry_run=args.dry_run)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as error:
        print(f"Tennis-Green-PMS: {error}", file=sys.stderr)
        raise SystemExit(1)
