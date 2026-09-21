"""Build and validate one immutable Tennis-Green-PMS Docker release bundle."""

from __future__ import annotations

import argparse
import bz2
import gzip
import hashlib
import json
import lzma
import posixpath
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

try:
    from .common import (
        ARCHIVE,
        FILES,
        SOURCE,
        ReleaseError,
        image_tag,
        json_bytes,
        sha256_file,
        utcnow,
        validate_bundle,
        validate_identity,
        validate_manifest,
    )
except ImportError:
    from common import (  # type: ignore[no-redef]
        ARCHIVE,
        FILES,
        SOURCE,
        ReleaseError,
        image_tag,
        json_bytes,
        sha256_file,
        utcnow,
        validate_bundle,
        validate_identity,
        validate_manifest,
    )


HEX40 = re.compile(r"[0-9a-f]{40}\Z")
MIGRATION = re.compile(r"[0-9]{3,}_[a-z0-9_]+\.sql\Z")
FORBIDDEN_SUFFIXES = (".dump", ".dump.gz", ".sql.gz", ".bak", ".pem", ".key", ".p12", ".pfx")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def command(argv: list[str], cwd: Path | None = None, *, binary: bool = False) -> bytes | str:
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=not binary,
        )
    except OSError:
        raise ReleaseError(f"release tool unavailable: {argv[0]}") from None
    except subprocess.CalledProcessError:
        raise ReleaseError(f"release tool command failed: {argv[0]}") from None
    return result.stdout


def command_text(argv: list[str], cwd: Path | None = None) -> str:
    result = command(argv, cwd)
    require(isinstance(result, str), "release tool returned invalid text")
    return result


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_bytes())
    except (OSError, UnicodeError, ValueError):
        raise ReleaseError("invalid release JSON") from None


def validate_release_identity(source_root: Path, version: str, revision: str) -> None:
    validate_identity(version, revision)
    status = command_text(["git", "status", "--porcelain=v1", "--untracked-files=all"], source_root)
    require(status == "", "Git worktree must be clean")
    head = command_text(["git", "rev-parse", "--verify", "HEAD"], source_root).strip()
    require(head == revision, "Git HEAD does not match release revision")
    tagged = command_text(["git", "rev-list", "-n", "1", f"refs/tags/{version}"], source_root).strip()
    require(tagged == revision, "Git tag does not match release revision")

    package = read_json(source_root / "package.json")
    lock = read_json(source_root / "package-lock.json")
    require(isinstance(package, dict) and package.get("version") == version[1:], "package version mismatch")
    require(isinstance(lock, dict), "invalid package lock")
    require(lock.get("version") == version[1:], "package-lock version mismatch")
    lock_root = lock.get("packages", {}).get("") if isinstance(lock.get("packages"), dict) else None
    require(isinstance(lock_root, dict) and lock_root.get("version") == version[1:], "workspace lock version mismatch")

    try:
        changelog = (source_root / "CHANGELOG.md").read_text()
    except (OSError, UnicodeError):
        raise ReleaseError("release notes are missing") from None
    changelog_version = version[1:]
    require(
        re.search(
            rf"^## (?:\[{re.escape(changelog_version)}\](?:\([^\n]+\))?|v{re.escape(changelog_version)}\b)",
            changelog,
            re.MULTILINE,
        ) is not None,
        "CHANGELOG version entry is missing",
    )
    validate_policy(source_root, version)


def validate_policy(source_root: Path, version: str) -> dict[str, str]:
    policy = read_json(source_root / "deploy" / "release-policy.json")
    require(isinstance(policy, dict), "invalid release policy")
    require(policy.get("application") == "tennis-green-pms", "release policy application mismatch")
    require(policy.get("version") in {version, version[1:]}, "release policy version mismatch")
    compatibility = policy.get("rollbackCompatibility")
    require(isinstance(compatibility, dict), "release policy compatibility is missing")
    require(set(compatibility) in ({"mode", "reason"}, {"mode", "reason", "releaseNotes"}), "invalid release policy fields")
    mode = compatibility.get("mode")
    reason = compatibility.get("reason")
    require(mode in {"same-migrations-only", "forward-only"}, "invalid release policy mode")
    require(isinstance(reason, str) and 0 < len(reason) <= 1000, "invalid release policy reason")
    release_notes = compatibility.get("releaseNotes")
    if release_notes is not None:
        require(isinstance(release_notes, dict), "release notes policy is invalid")
        require(set(release_notes) == {"path", "requiredText"}, "invalid release notes policy")
        require(release_notes.get("path") == f"docs/releases/{version}.md", "release notes policy path mismatch")
        required_text = release_notes.get("requiredText")
        require(isinstance(required_text, list) and required_text, "release notes policy text is missing")
        notes_path = source_root / "docs" / "releases" / f"{version}.md"
        try:
            notes = notes_path.read_text()
        except (OSError, UnicodeError):
            raise ReleaseError("release notes are missing") from None
        require(all(isinstance(text, str) and text and text in notes for text in required_text), "release notes do not match policy")
    return {"mode": mode, "reason": reason}


def forbidden_path(path: str, *, allow_env_example: bool = False, is_dir: bool = False) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    parts = [part.lower() for part in normalized.split("/") if part and part != "."]
    basename = parts[-1] if parts else ""
    if ".git" in parts or ".production-operator-password" in basename:
        return True
    if basename == ".env" or (basename.startswith(".env.") and (basename != ".env.example" or not allow_env_example)):
        return True
    if not is_dir and any(part in {"backups", "backup", "database-dumps", "server-private"} for part in parts):
        return True
    if basename.endswith(FORBIDDEN_SUFFIXES):
        return True
    if (normalized.startswith("app/apps/") or normalized.startswith("app/packages/")) and basename.endswith((".ts", ".tsx")):
        return True
    return False


def validate_build_context(source_root: Path) -> None:
    paths = command(["git", "ls-files", "-z"], source_root, binary=True)
    require(isinstance(paths, bytes), "invalid Git file list")
    for path in paths.decode("utf-8").split("\0"):
        if path and forbidden_path(path, allow_env_example=True):
            raise ReleaseError("build context contains a forbidden file")


def migration_manifest(source_root: Path) -> list[dict[str, str]]:
    migration_root = source_root / "packages" / "db" / "src" / "tennis" / "migrations"
    try:
        paths = sorted(path for path in migration_root.iterdir() if path.is_file() and path.suffix == ".sql")
    except OSError:
        raise ReleaseError("migration directory is missing") from None
    require(paths, "migration baseline is missing")
    result = []
    for path in paths:
        require(MIGRATION.fullmatch(path.name) is not None, "invalid migration filename")
        result.append({"name": path.name, "sha256": sha256_file(path)})
    return result


def docker_image_metadata(tag: str) -> dict[str, object]:
    raw = command_text(["docker", "image", "inspect", tag])
    try:
        values = json.loads(raw)
    except ValueError:
        raise ReleaseError("Docker image inspect returned invalid JSON") from None
    require(isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict), "Docker image inspect returned no image")
    image = values[0]
    require(image.get("Os") == "linux" and image.get("Architecture") == "amd64", "Docker image platform mismatch")
    image_id = image.get("Id")
    require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), "Docker image ID is invalid")
    require(isinstance(image.get("Config"), dict), "Docker image config is missing")
    return image


def expected_labels(manifest: dict[str, object]) -> dict[str, str]:
    return {
        "org.opencontainers.image.version": str(manifest["version"]),
        "org.opencontainers.image.revision": str(manifest["gitRevision"]),
        "org.opencontainers.image.source": SOURCE,
        "org.opencontainers.image.created": str(manifest["createdAt"]),
    }


def validate_image_labels(image: dict[str, object], manifest: dict[str, object]) -> None:
    config = image.get("Config")
    require(isinstance(config, dict), "Docker image config is missing")
    labels = config.get("Labels")
    require(isinstance(labels, dict), "Docker image OCI labels are missing")
    for name, expected in expected_labels(manifest).items():
        require(labels.get(name) == expected, "Docker image OCI labels mismatch")


class DigestReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()

    def read(self, size=-1):
        value = self.stream.read(size)
        if value:
            self.digest.update(value)
        return value

    def readable(self):
        return True

    def seekable(self):
        return False


def scan_layer(layer_file, forbidden: list[str]) -> str:
    try:
        layer_file.seek(0)
        prefix = layer_file.read(6)
        layer_file.seek(0)
        if prefix.startswith(b"\x1f\x8b"):
            payload = gzip.GzipFile(fileobj=layer_file, mode="rb")
        elif prefix.startswith(b"BZh"):
            payload = bz2.BZ2File(layer_file, mode="rb")
        elif prefix.startswith(b"\xfd7zXZ\x00"):
            payload = lzma.LZMAFile(layer_file, mode="rb")
        else:
            payload = layer_file
        digest_reader = DigestReader(payload)
        with tarfile.open(fileobj=digest_reader, mode="r|") as layer:
            for member in layer:
                if forbidden_path(member.name, is_dir=member.isdir()):
                    forbidden.append(member.name)
                    raise ReleaseError("Docker archive contains a forbidden file")
            while digest_reader.read(1024 * 1024):
                pass
        return digest_reader.digest.hexdigest()
    except (tarfile.TarError, OSError):
        raise ReleaseError("Docker archive layer is invalid") from None


def indexed_archive_path(path: Path):
    with path.open("rb") as stream:
        magic = stream.read(4)
    if magic != b"(\xb5/\xfd":
        return None, path
    temporary = tempfile.TemporaryDirectory(prefix="tennis-green-pms-archive-")
    raw = Path(temporary.name) / "image.tar"
    command(["zstd", "--quiet", "--decompress", "--force", "-o", str(raw), str(path)])
    return temporary, raw


def config_digest_from_member_name(name: str) -> str:
    if name.startswith("blobs/sha256/"):
        digest = name.rsplit("/", 1)[-1]
    elif name.endswith(".json"):
        digest = posixpath.basename(name)[:-5]
    else:
        raise ReleaseError("Docker archive config path is invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", digest) is not None, "Docker archive config digest is invalid")
    return digest


def inspect_archive(path: str | Path, manifest: dict[str, object]) -> dict[str, object]:
    """Inspect a docker save tar or zstd tar without extracting it."""
    validate_manifest(manifest)
    archive_file = Path(path)
    require(archive_file.is_file() and not archive_file.is_symlink(), "Docker archive is missing")
    temporary, indexed_path = indexed_archive_path(archive_file)
    try:
        try:
            with tarfile.open(indexed_path, mode="r:*") as outer:
                members = outer.getmembers()
                by_name = {}
                for member in members:
                    require(member.name not in by_name, "Docker archive contains duplicate members")
                    by_name[member.name] = member
                manifest_member = by_name.get("manifest.json")
                require(manifest_member is not None and manifest_member.isfile(), "Docker archive manifest is missing")
                manifest_file = outer.extractfile(manifest_member)
                require(manifest_file is not None, "Docker archive manifest is unreadable")
                try:
                    docker_manifest = json.loads(manifest_file.read())
                except (UnicodeError, ValueError):
                    raise ReleaseError("Docker archive manifest is invalid") from None
                require(isinstance(docker_manifest, list) and len(docker_manifest) == 1, "Docker archive manifest count mismatch")
                entry = docker_manifest[0]
                require(isinstance(entry, dict), "Docker archive image entry is invalid")
                require(entry.get("RepoTags") == [manifest["imageTag"]], "Docker archive tag mismatch")
                config_name = entry.get("Config")
                layers = entry.get("Layers")
                require(isinstance(config_name, str) and isinstance(layers, list), "Docker archive image entry is incomplete")
                require(all(isinstance(layer, str) for layer in layers), "Docker archive layer list is invalid")
                require(len(set(layers)) == len(layers), "Docker archive layer list is not unique")
                config_member = by_name.get(config_name)
                require(config_member is not None and config_member.isfile(), "Docker archive config is missing")
                config_file = outer.extractfile(config_member)
                require(config_file is not None, "Docker archive config is unreadable")
                config_bytes = config_file.read()
                config_digest = config_digest_from_member_name(config_name)
                require(hashlib.sha256(config_bytes).hexdigest() == config_digest, "Docker archive config hash mismatch")
                try:
                    config_data = json.loads(config_bytes)
                except (UnicodeError, ValueError):
                    raise ReleaseError("Docker archive config is invalid") from None
                require(isinstance(config_data, dict), "Docker archive config is invalid")
                config_id = f"sha256:{config_digest}"
                require(config_id == manifest["imageId"], "Docker archive image ID mismatch")
                require(config_data.get("os") == "linux" and config_data.get("architecture") == "amd64", "Docker archive platform mismatch")
                config = config_data.get("config")
                require(isinstance(config, dict), "Docker archive runtime config is missing")
                labels = config.get("Labels")
                require(isinstance(labels, dict), "Docker archive OCI labels are missing")
                for name, expected in expected_labels(manifest).items():
                    require(labels.get(name) == expected, "Docker archive OCI labels mismatch")
                rootfs = config_data.get("rootfs")
                diff_ids = rootfs.get("diff_ids") if isinstance(rootfs, dict) else None
                require(isinstance(diff_ids, list) and len(diff_ids) == len(layers), "Docker archive layer digest list is invalid")
                forbidden: list[str] = []
                for index, layer_name in enumerate(layers):
                    layer_member = by_name.get(layer_name)
                    require(layer_member is not None and layer_member.isfile(), "Docker archive layer is missing")
                    layer_file = outer.extractfile(layer_member)
                    require(layer_file is not None, "Docker archive layer is unreadable")
                    layer_digest = scan_layer(layer_file, forbidden)
                    require(diff_ids[index] == f"sha256:{layer_digest}", "Docker archive layer digest mismatch")
                require(not forbidden, "Docker archive contains a forbidden file")
                return {
                    "imageId": manifest["imageId"],
                    "imageTag": manifest["imageTag"],
                    "platform": "linux/amd64",
                    "layerCount": len(layers),
                    "rootfsDiffIds": list(diff_ids),
                }
        except tarfile.TarError:
            raise ReleaseError("Docker archive is invalid") from None
    finally:
        if temporary is not None:
            temporary.cleanup()


def build_bundle(source_root: Path, version: str, revision: str, output: Path) -> dict[str, object]:
    validate_release_identity(source_root, version, revision)
    validate_build_context(source_root)
    output.mkdir(parents=True, exist_ok=True)
    require(not any(output.iterdir()), "release output directory must be empty")
    rollback = validate_policy(source_root, version)
    tag = image_tag(version, revision)
    created_at = utcnow()
    build_args = [
        "docker",
        "build",
        "--platform",
        "linux/amd64",
        "--tag",
        tag,
        "--build-arg",
        f"OCI_VERSION={version}",
        "--build-arg",
        f"OCI_REVISION={revision}",
        "--build-arg",
        f"OCI_SOURCE={SOURCE}",
        "--build-arg",
        f"OCI_CREATED={created_at}",
        "--label",
        f"org.opencontainers.image.version={version}",
        "--label",
        f"org.opencontainers.image.revision={revision}",
        "--label",
        f"org.opencontainers.image.source={SOURCE}",
        "--label",
        f"org.opencontainers.image.created={created_at}",
        str(source_root),
    ]
    command(build_args)
    image = docker_image_metadata(tag)
    image_id = image.get("Id")
    provisional = {
        "schemaVersion": 1,
        "application": "tennis-green-pms",
        "version": version,
        "gitRevision": revision,
        "platform": "linux/amd64",
        "imageId": image_id,
        "imageTag": tag,
        "archiveSha256": "0" * 64,
        "sbomSha256": "0" * 64,
        "createdAt": created_at,
        "source": SOURCE,
        "requiredMigrations": migration_manifest(source_root),
        "rollbackCompatibility": rollback,
    }
    validate_image_labels(image, provisional)

    with tempfile.TemporaryDirectory(prefix="tennis-green-pms-package-") as temporary:
        raw_archive = Path(temporary) / "image.tar"
        command(["docker", "save", "--output", str(raw_archive), tag])
        inspect_archive(raw_archive, provisional)
        archive_path = output / ARCHIVE
        command(["zstd", "--quiet", "--threads=0", "--force", str(raw_archive), "-o", str(archive_path)])
        sbom_path = output / "sbom.spdx.json"
        command(["syft", f"docker:{tag}", "-o", f"spdx-json={sbom_path}"])
        provisional["archiveSha256"] = sha256_file(archive_path)
        provisional["sbomSha256"] = sha256_file(sbom_path)
        manifest = validate_manifest(provisional, version, revision)
        (output / "manifest.json").write_bytes(json_bytes(manifest))
        checksums = "\n".join(
            f"{sha256_file(output / name)}  {name}"
            for name in (ARCHIVE, "manifest.json", "sbom.spdx.json")
        ) + "\n"
        (output / "SHA256SUMS").write_text(checksums)
    validate_bundle(output, sha256_file(output / "manifest.json"), version, revision)
    return manifest


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-root", default=Path.cwd(), type=Path)
    return parser.parse_args()


def main() -> int:
    args = arguments()
    try:
        manifest = build_bundle(args.source_root.resolve(), args.version, args.revision, args.output.resolve())
    except (OSError, ReleaseError) as error:
        print(f"release packaging failed: {error}", file=__import__("sys").stderr)
        return 1
    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
