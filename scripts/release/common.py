"""Shared validation and release bundle helpers for Tennis-Green-PMS publishing."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ARCHIVE = "tennis-green-pms-linux-amd64.docker.tar.zst"
FILES = (ARCHIVE, "manifest.json", "SHA256SUMS", "sbom.spdx.json")
SOURCE = "https://github.com/PatrickLiveCool/Tennis-PMS"
_VERSION_RE = re.compile(r"^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$")
_REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX = _SHA256_RE


class ReleaseError(RuntimeError):
    """A safe, user-facing release validation or orchestration error."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


require = _require


def validate_identity(version: str, revision: str) -> tuple[str, str]:
    """Validate and return the exact immutable version identity."""

    _require(isinstance(version, str) and _VERSION_RE.fullmatch(version) is not None, "invalid release version")
    _require(isinstance(revision, str) and _REVISION_RE.fullmatch(revision) is not None, "invalid full git revision")
    return version, revision


def release_prefix(root: str, version: str, revision: str) -> str:
    validate_identity(version, revision)
    _require(isinstance(root, str) and root == root.strip() and root.endswith("/"), "invalid COS release root")
    _require(root == "tennis-green-pms/releases/", "invalid Tennis-Green-PMS COS release root")
    return f"{root}{version}/{revision}/"


def validate_migrations(migrations: Any) -> list[dict[str, str]]:
    _require(isinstance(migrations, list) and migrations, "full migration baseline is required")
    normalized: list[dict[str, str]] = []
    for migration in migrations:
        _require(isinstance(migration, dict) and set(migration) == {"name", "sha256"}, "invalid migration entry")
        name = migration.get("name")
        _require(isinstance(name, str) and re.fullmatch(r"[0-9]{3,}_[a-z0-9_]+\.sql", name), "invalid migration filename")
        _require(isinstance(migration.get("sha256"), str) and _SHA256_RE.fullmatch(migration["sha256"]) is not None, "invalid migration checksum")
        normalized.append({"name": name, "sha256": migration["sha256"]})
    _require([item["name"] for item in normalized] == sorted(item["name"] for item in normalized), "migration baseline must be sorted")
    _require(len({item["name"] for item in normalized}) == len(normalized), "migration baseline contains duplicates")
    return normalized


def image_tag(version: str, revision: str) -> str:
    version, revision = validate_identity(version, revision)
    return f"tennis-green-pms:{version}-{revision}"


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: Any) -> bytes:
    """Serialize JSON in the canonical form used for hashes and markers."""

    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _validate_timestamp(value: Any) -> None:
    _require(isinstance(value, str) and value.endswith("Z"), "createdAt must be an ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ReleaseError("createdAt must be an ISO-8601 UTC timestamp") from exc
    _require(parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed), "createdAt must be UTC")


def _validate_sha(value: Any, field: str) -> None:
    _require(isinstance(value, str) and _SHA256_RE.fullmatch(value) is not None, f"invalid {field}")


def validate_manifest(m: Any, version: str | None = None, revision: str | None = None) -> dict[str, Any]:
    """Validate the release manifest schema and immutable identity."""

    _require(isinstance(m, dict), "manifest must be a JSON object")
    fields = {"schemaVersion", "application", "version", "gitRevision", "platform", "imageId", "imageTag", "archiveSha256", "sbomSha256", "createdAt", "source", "requiredMigrations", "rollbackCompatibility"}
    _require(set(m) == fields, "invalid manifest fields")
    _require(type(m.get("schemaVersion")) is int and m["schemaVersion"] == 1, "manifest schemaVersion must be 1")
    _require(m.get("application") == "tennis-green-pms", "manifest application must be tennis-green-pms")
    manifest_version, manifest_revision = validate_identity(m.get("version"), m.get("gitRevision"))
    if version is not None:
        validate_identity(version, manifest_revision)
        _require(manifest_version == version, "manifest version does not match requested version")
    if revision is not None:
        validate_identity(manifest_version, revision)
        _require(manifest_revision == revision, "manifest git revision does not match requested revision")

    _require(m.get("platform") == "linux/amd64", "manifest platform must be linux/amd64")
    _require(isinstance(m.get("imageId"), str) and _IMAGE_ID_RE.fullmatch(m["imageId"]) is not None, "invalid imageId")
    _require(m.get("imageTag") == image_tag(manifest_version, manifest_revision), "manifest imageTag does not match identity")
    _validate_sha(m.get("archiveSha256"), "archiveSha256")
    _validate_sha(m.get("sbomSha256"), "sbomSha256")
    _validate_timestamp(m.get("createdAt"))
    _require(m.get("source") == SOURCE, "manifest source is not Tennis-Green-PMS")

    validate_migrations(m["requiredMigrations"])

    compatibility = m.get("rollbackCompatibility")
    _require(isinstance(compatibility, dict) and set(compatibility) == {"mode", "reason"}, "invalid rollbackCompatibility fields")
    _require(compatibility.get("mode") in {"same-migrations-only", "forward-only"}, "invalid rollbackCompatibility mode")
    _require(isinstance(compatibility.get("reason"), str) and 0 < len(compatibility["reason"].strip()) <= 1000, "rollbackCompatibility reason is required")
    return m


def _read_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        _require(len(parts) == 2 and _SHA256_RE.fullmatch(parts[0]) is not None, "invalid SHA256SUMS entry")
        name = parts[1].lstrip("*")
        _require(name in {ARCHIVE, "manifest.json", "sbom.spdx.json"}, "SHA256SUMS contains an unexpected file")
        _require(name not in checksums, "SHA256SUMS contains duplicate entries")
        checksums[name] = parts[0]
    _require(set(checksums) == {ARCHIVE, "manifest.json", "sbom.spdx.json"}, "SHA256SUMS is incomplete")
    return checksums


def validate_bundle(directory: str | Path, expected_manifest_sha: str, version: str, revision: str) -> dict[str, Any]:
    """Validate a complete local release bundle before it can be uploaded."""

    root = Path(directory)
    _require(root.is_dir(), "release bundle directory does not exist")
    _validate_sha(expected_manifest_sha, "expected manifest sha256")
    validate_identity(version, revision)
    for name in FILES:
        path = root / name
        _require(path.is_file() and not path.is_symlink(), f"bundle file missing: {name}")

    manifest_path = root / "manifest.json"
    actual_manifest_sha = sha256_file(manifest_path)
    _require(actual_manifest_sha == expected_manifest_sha, "manifest sha256 does not match expected value")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseError("manifest.json is not valid UTF-8 JSON") from exc
    validate_manifest(manifest, version, revision)

    checksums = _read_checksums(root / "SHA256SUMS")
    for name, expected in checksums.items():
        _require(sha256_file(root / name) == expected, f"bundle checksum mismatch: {name}")
    _require(checksums[ARCHIVE] == manifest["archiveSha256"], "archive checksum does not match manifest")
    _require(checksums["sbom.spdx.json"] == manifest["sbomSha256"], "SBOM checksum does not match manifest")
    try:
        sbom = json.loads((root / "sbom.spdx.json").read_bytes())
    except (ValueError, UnicodeError):
        raise ReleaseError("invalid SPDX SBOM JSON") from None
    _require(isinstance(sbom, dict) and isinstance(sbom.get("spdxVersion"), str)
             and sbom["spdxVersion"].startswith("SPDX-2."), "invalid SPDX SBOM")
    return manifest
