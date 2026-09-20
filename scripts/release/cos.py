"""Tencent COS adapter and immutable Tennis-Green-PMS bundle uploader."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Callable

try:
    from .common import (FILES, ReleaseError, json_bytes, release_prefix, sha256_file,
                         validate_bundle, validate_identity)
except ImportError:
    from common import (FILES, ReleaseError, json_bytes, release_prefix, sha256_file,
                        validate_bundle, validate_identity)


ROOT_PREFIX = "tennis-green-pms/releases/"
MARKER = "deployed.json"
_ROLES = {"UPLOAD", "MARKER", "RETENTION"}
_KNOWN_OBJECTS = set(FILES) | {"deployed.json"}
_RELEASE_KEY = re.compile(
    r"^tennis-green-pms/releases/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/[0-9a-f]{40}/(?:tennis-green-pms-linux-amd64\.docker\.tar\.zst|manifest\.json|SHA256SUMS|sbom\.spdx\.json|deployed\.json)$"
)
_RELEASE_PREFIX = re.compile(
    r"^tennis-green-pms/releases/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/[0-9a-f]{40}/$"
)
_JSON_LIMIT = 4 * 1024 * 1024
# qcloud_cos passes this value unchanged to requests. A tuple bounds the
# connection separately from a potentially slow archive read.
_SDK_TIMEOUT = (10, 60)
_ALLOWED_ENDPOINTS = frozenset({"cos.accelerate.myqcloud.com"})

# Tencent contracts used here:
# - API 7749: x-cos-forbid-overwrite=true returns 409 FileAlreadyExists.
# - API 19889: once versioning is enabled it cannot be disabled; Suspended is
#   still versioned, so both Enabled and Suspended are rejected.
# - API 71307: CAM cos:prefix values must URL-encode the slash
#   (tennis-green-pms%2Freleases%2F); prefix-scoped string_like policies need an
#   operator-side CAM simulation before production rollout.


def _first_env(names: list[str]) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _role_env(role: str | None, name: str) -> list[str]:
    if not role:
        return [f"COS_{name}"]
    role = role.upper().rstrip("_")
    return [f"{role}_COS_{name}", f"{role}_{name}"]


def _cos_endpoint() -> str | None:
    endpoint = os.environ.get("COS_ENDPOINT")
    if not endpoint:
        return None
    if endpoint not in _ALLOWED_ENDPOINTS:
        raise ReleaseError("invalid COS endpoint")
    return endpoint


def _safe_status(exc: BaseException) -> int | None:
    getter = getattr(exc, "get_status_code", None)
    if callable(getter):
        try:
            status = getter()
            if isinstance(status, int):
                return status
        except Exception:
            pass
    status = getattr(exc, "status_code", None)
    return status if isinstance(status, int) else None


class CosStore:
    """Small COS interface with injectable clients for offline tests.

    ``role`` is only required for mutating calls. Reads use role credentials
    when present and otherwise fall back to the server's read-only COS_* env.
    """

    def __init__(self, bucket: str | None = None, region: str | None = None,
                 prefix: str = ROOT_PREFIX, role: str | None = None,
                 client: Any | None = None,
                 client_factory: Callable[[str, str, str, str, str | None], Any] | None = None):
        self.bucket = bucket or _first_env(_role_env(role, "BUCKET"))
        self.region = region or _first_env(_role_env(role, "REGION"))
        self.prefix = prefix if prefix.endswith("/") else prefix + "/"
        if self.prefix != ROOT_PREFIX:
            raise ReleaseError("COS prefix must be tennis-green-pms/releases/")
        self.role = role.upper() if role else None
        if self.role is not None:
            if self.role not in _ROLES:
                raise ReleaseError("invalid COS credential role")
        self._client = client
        self._read_client = client
        self._write_client = client
        self._client_factory = client_factory
        self._versioning_checked = False
        if client is None and self.bucket is None:
            raise ReleaseError("COS bucket is required")
        if client is None and self.region is None:
            raise ReleaseError("COS region is required")

    def _credentials(self, write: bool) -> tuple[str, str, str | None]:
        role = self.role if write else self.role
        names = _role_env(role, "SECRET_ID") if role else ["COS_SECRET_ID"]
        secret_id = _first_env(names)
        names = _role_env(role, "SECRET_KEY") if role else ["COS_SECRET_KEY"]
        secret_key = _first_env(names)
        token = _first_env(_role_env(role, "TOKEN") if role else ["COS_TOKEN"])
        if not write and role and not (secret_id and secret_key):
            secret_id = _first_env(["COS_SECRET_ID"])
            secret_key = _first_env(["COS_SECRET_KEY"])
            token = _first_env(["COS_TOKEN"])
        if write:
            if not (secret_id and secret_key):
                raise ReleaseError(f"COS {role or 'write'} credentials are not configured")
        elif not (secret_id and secret_key):
            raise ReleaseError("COS read-only credentials are not configured")
        return secret_id, secret_key, token

    def _client_for(self, write: bool = False) -> Any:
        endpoint = _cos_endpoint()
        if write and self.role is None:
            raise ReleaseError("COS read-only client cannot perform mutations")
        if write and self._write_client is not None:
            return self._write_client
        if not write and self._read_client is not None:
            return self._read_client
        if not self.bucket or not self.region:
            raise ReleaseError("COS bucket and region are required")
        secret_id, secret_key, token = self._credentials(write)
        if self._client_factory is not None:
            client = self._client_factory(self.bucket, self.region, secret_id, secret_key, token)
            if write:
                self._write_client = client
            else:
                self._read_client = client
            return client
        try:
            from qcloud_cos import CosConfig, CosS3Client
        except ImportError as exc:
            raise ReleaseError("qcloud_cos is required for real COS operations") from exc
        # The checked SDK source stores Timeout unchanged and passes it to
        # requests; requests accepts (connect, read), giving COS calls a
        # 10-second connect and 60-second read bound. The SSH session remains
        # locked until the client has completed all requests.
        config_kwargs = {
            "Region": self.region,
            "SecretId": secret_id,
            "SecretKey": secret_key,
            "Token": token,
            "Timeout": _SDK_TIMEOUT,
        }
        if endpoint is not None:
            # cos-python-sdk-v5 1.9.38 accepts the global acceleration host
            # through CosConfig(Endpoint=...), while Region remains the
            # regional default when COS_ENDPOINT is unset.
            config_kwargs["Endpoint"] = endpoint
        config = CosConfig(**config_kwargs)
        # qcloud_cos logs request headers at DEBUG/INFO. Disable its handlers so
        # a token or signed metadata can never appear in an Actions log.
        for logger_name in ("qcloud_cos", "qcloud_cos.cos_client", "qcloud_cos.cos_comm"):
            sdk_logger = logging.getLogger(logger_name)
            sdk_logger.handlers.clear()
            sdk_logger.propagate = False
            sdk_logger.setLevel(logging.CRITICAL)
        client = CosS3Client(config)
        if write:
            self._write_client = client
        else:
            self._read_client = client
        return client

    def _assert_unversioned(self, client: Any) -> None:
        if self._versioning_checked:
            return
        method = getattr(client, "get_bucket_versioning", None)
        if not callable(method):
            raise ReleaseError("COS versioning status is unavailable; refusing mutation")
        try:
            response = method(Bucket=self.bucket)
        except Exception as exc:
            raise ReleaseError("COS versioning status check failed; refusing mutation") from exc
        if not isinstance(response, dict):
            raise ReleaseError("COS versioning status is unavailable; refusing mutation")
        status = response.get("Status")
        if status is None and isinstance(response, dict):
            configuration = response.get("VersioningConfiguration") or {}
            if not isinstance(configuration, dict):
                raise ReleaseError("COS versioning status is unknown; refusing mutation")
            status = configuration.get("Status")
        if status in {"Enabled", "Suspended"}:
            raise ReleaseError("COS bucket versioning must be Disabled or never enabled")
        # The SDK returns an empty dict for a bucket that has never had
        # versioning enabled. Any non-empty response without a known status is
        # treated as an unknown configuration and fails closed.
        empty_configurations = (
            {},
            {"VersioningConfiguration": {}},
            {"VersioningConfiguration": None},
        )
        if status in {None, ""} and response not in empty_configurations:
            raise ReleaseError("COS versioning status is unknown; refusing mutation")
        if status not in {None, "", "Disabled"}:
            raise ReleaseError("COS bucket versioning status is unknown; refusing mutation")
        self._versioning_checked = True

    def _validate_key(self, key: str, *, allow_marker: bool = True) -> None:
        if not isinstance(key, str) or _RELEASE_KEY.fullmatch(key) is None:
            raise ReleaseError("invalid Tennis-Green-PMS COS object key")
        if not allow_marker and key.endswith("deployed.json"):
            raise ReleaseError("COS object key is not allowed for this operation")

    def _validate_list_prefix(self, prefix: str) -> None:
        if prefix != self.prefix and _RELEASE_PREFIX.fullmatch(prefix) is None:
            raise ReleaseError("invalid Tennis-Green-PMS COS list prefix")

    @staticmethod
    def _not_found(exc: BaseException) -> bool:
        return isinstance(exc, (KeyError, FileNotFoundError)) or _safe_status(exc) == 404

    def _head(self, key: str) -> Any | None:
        self._validate_key(key)
        client = self._client_for(False)
        try:
            return client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            if self._not_found(exc):
                return None
            raise ReleaseError("COS object metadata request failed") from exc

    @staticmethod
    def _response_body(response: Any) -> Any:
        body = response.get("Body") if isinstance(response, dict) else response
        if body is None:
            raise ReleaseError("COS response body is unreadable")
        return body

    def _read_json_bytes(self, key: str) -> bytes:
        self._validate_key(key)
        client = self._client_for(False)
        try:
            body = self._response_body(client.get_object(Bucket=self.bucket, Key=key))
            if isinstance(body, bytes):
                data = body
            elif isinstance(body, bytearray):
                data = bytes(body)
            elif hasattr(body, "read"):
                data = body.read(_JSON_LIMIT + 1)
            elif hasattr(body, "get_raw_stream"):
                data = body.get_raw_stream().read(_JSON_LIMIT + 1)
            elif hasattr(body, "get_stream_to_file"):
                with tempfile.TemporaryDirectory(prefix="tennis-green-pms-cos-json-") as temporary:
                    path = Path(temporary) / "object"
                    body.get_stream_to_file(str(path))
                    if path.stat().st_size > _JSON_LIMIT:
                        raise ReleaseError("COS JSON object is too large")
                    data = path.read_bytes()
            else:
                raise ReleaseError("COS response body is unreadable")
            if len(data) > _JSON_LIMIT:
                raise ReleaseError("COS JSON object is too large")
            return data
        except Exception as exc:
            if self._not_found(exc):
                raise ReleaseError("COS object is missing") from None
            if isinstance(exc, ReleaseError):
                raise
            raise ReleaseError("COS object download failed") from exc

    def _sha256_object(self, key: str) -> str:
        with tempfile.TemporaryDirectory(prefix="tennis-green-pms-cos-hash-") as temporary:
            path = Path(temporary) / "object"
            self.download(key, path)
            return sha256_file(path)

    def download(self, key: str, path: str | Path) -> None:
        self._validate_key(key)
        client = self._client_for(False)
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.download")
        try:
            response = client.get_object(Bucket=self.bucket, Key=key)
            body = self._response_body(response)
            if isinstance(body, bytes):
                temporary.write_bytes(body)
            elif isinstance(body, bytearray):
                temporary.write_bytes(bytes(body))
            elif hasattr(body, "get_stream_to_file"):
                body.get_stream_to_file(str(temporary))
            elif hasattr(body, "read"):
                with temporary.open("wb") as stream:
                    while True:
                        chunk = body.read(1024 * 1024)
                        if not chunk:
                            break
                        stream.write(chunk)
            elif hasattr(body, "get_raw_stream"):
                stream_body = body.get_raw_stream()
                with temporary.open("wb") as stream:
                    while True:
                        chunk = stream_body.read(1024 * 1024)
                        if not chunk:
                            break
                        stream.write(chunk)
            else:
                raise ReleaseError("COS response body is unreadable")
            os.replace(temporary, destination)
        except Exception as exc:
            if self._not_found(exc):
                raise ReleaseError("COS object is missing") from None
            if isinstance(exc, ReleaseError):
                raise
            raise ReleaseError("COS object download failed") from exc
        finally:
            temporary.unlink(missing_ok=True)

    def read_json(self, key: str) -> dict[str, Any]:
        try:
            value = json.loads(self._read_json_bytes(key).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReleaseError("COS JSON object is invalid") from exc
        if not isinstance(value, dict):
            raise ReleaseError("COS JSON object must be an object")
        return value

    def put_immutable(self, key: str, path_or_bytes: str | Path | bytes | bytearray) -> dict[str, Any]:
        self._validate_key(key, allow_marker=self.role == "MARKER")
        if self.role == "UPLOAD" and key.endswith(MARKER):
            raise ReleaseError("UPLOAD role cannot write deployed.json")
        if self.role == "MARKER" and not key.endswith(MARKER):
            raise ReleaseError("MARKER role can only write deployed.json")
        if self.role != "UPLOAD" and self.role != "MARKER":
            raise ReleaseError("COS role cannot write release objects")
        if isinstance(path_or_bytes, (str, Path)):
            source = Path(path_or_bytes)
            expected = sha256_file(source)
            body_factory = lambda: source.open("rb")
        elif isinstance(path_or_bytes, (bytes, bytearray)):
            data = bytes(path_or_bytes)
            expected = hashlib.sha256(data).hexdigest()
            body_factory = lambda: io.BytesIO(data)
        else:
            raise ReleaseError("COS upload body must be a file or bytes")
        existing = self._head(key)
        if existing is not None:
            actual = self._sha256_object(key)
            if actual == expected:
                return {"status": "existing", "sha256": expected}
            raise ReleaseError("immutable COS object already contains different content")
        client = self._client_for(True)
        self._assert_unversioned(client)
        try:
            with body_factory() as body:
                response = client.put_object(
                    Bucket=self.bucket,
                    Body=body,
                    Key=key,
                    # Tencent COS API 7749: this header returns 409
                    # FileAlreadyExists instead of overwriting an object.
                    Metadata={"x-cos-forbid-overwrite": "true"},
                )
        except Exception as exc:
            if _safe_status(exc) in {409, 412}:
                actual = self._sha256_object(key)
                if actual == expected:
                    return {"status": "existing", "sha256": expected}
                raise ReleaseError("immutable COS object already contains different content") from None
            raise ReleaseError("COS object upload failed") from exc
        return {"status": "uploaded", "sha256": expected, "response": response}

    def list(self, prefix: str | None = None) -> list[dict[str, Any]]:
        self._validate_list_prefix(prefix or self.prefix)
        client = self._client_for(False)
        requested = prefix or self.prefix
        marker = ""
        objects: list[dict[str, Any]] = []
        while True:
            try:
                response = client.list_objects(Bucket=self.bucket, Prefix=requested, Marker=marker, MaxKeys=1000)
            except Exception as exc:
                raise ReleaseError("COS object listing failed") from exc
            if isinstance(response, list):
                contents = response
                truncated = False
                next_marker = ""
            else:
                contents = response.get("Contents", []) or []
                if isinstance(contents, dict):
                    contents = [contents]
                truncated = str(response.get("IsTruncated", "false")).lower() == "true"
                next_marker = response.get("NextMarker") or (contents[-1].get("Key") if truncated and contents else "")
            for item in contents:
                objects.append({
                    "key": item.get("Key") or item.get("key"),
                    "lastModified": item.get("LastModified", item.get("lastModified")),
                    "size": int(item.get("Size", item.get("size", 0)) or 0),
                })
            if not truncated or not next_marker or next_marker == marker:
                break
            marker = next_marker
        return [item for item in objects if item["key"]]

    def delete(self, key: str) -> None:
        self._validate_key(key)
        if self.role != "RETENTION":
            raise ReleaseError("only RETENTION role can delete COS objects")
        client = self._client_for(True)
        self._assert_unversioned(client)
        try:
            client.delete_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            if self._not_found(exc):
                return
            raise ReleaseError("COS object deletion failed") from exc


def upload_bundle(store: CosStore, directory: str | Path, prefix: str = ROOT_PREFIX) -> dict[str, Any]:
    root = Path(directory)
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReleaseError("manifest.json is not valid UTF-8 JSON") from exc
    validate_identity(manifest.get("version"), manifest.get("gitRevision"))
    manifest_sha = sha256_file(manifest_path)
    validate_bundle(root, manifest_sha, manifest["version"], manifest["gitRevision"])
    key_prefix = release_prefix(prefix, manifest["version"], manifest["gitRevision"])
    uploaded: list[str] = []
    with tempfile.TemporaryDirectory(prefix="tennis-green-pms-cos-readback-") as temporary:
        temporary_root = Path(temporary)
        for name in FILES:
            key = key_prefix + name
            store.put_immutable(key, root / name)
            readback = temporary_root / name
            store.download(key, readback)
            expected = sha256_file(root / name)
            if sha256_file(readback) != expected:
                raise ReleaseError(f"COS readback checksum mismatch: {name}")
            uploaded.append(name)
    return {"application": "tennis-green-pms", "version": manifest["version"], "gitRevision": manifest["gitRevision"],
            "prefix": key_prefix, "manifestSha256": manifest_sha, "uploaded": uploaded}


def fetch_bundle(store: CosStore, version: str, revision: str, directory: str | Path,
                 prefix: str = ROOT_PREFIX) -> int:
    """Reuse a complete immutable bundle without ever overwriting a target."""

    validate_identity(version, revision)
    key_prefix = release_prefix(prefix, version, revision)
    objects = store.list(key_prefix)
    if not objects:
        return 3
    names: set[str] = set()
    for item in objects:
        object_key = item.get("key")
        if not isinstance(object_key, str) or not object_key.startswith(key_prefix):
            raise ReleaseError("COS release listing returned an invalid object key")
        name = object_key[len(key_prefix):]
        if name not in set(FILES) | {MARKER} or name in names:
            raise ReleaseError("COS release prefix contains unexpected objects")
        names.add(name)
    if not set(FILES).issubset(names):
        raise ReleaseError("COS release prefix is partial; refusing rebuild reuse")
    destination = Path(directory)
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise ReleaseError("fetch destination is not a directory")
    if destination.exists() and any(destination.iterdir()):
        raise ReleaseError("fetch destination is not empty")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tennis-green-pms-fetch-", dir=destination.parent) as temporary:
        staging = Path(temporary)
        for name in FILES:
            store.download(key_prefix + name, staging / name)
        manifest_sha = sha256_file(staging / "manifest.json")
        manifest = validate_bundle(staging, manifest_sha, version, revision)
        try:
            from .package import inspect_archive
        except ImportError:
            from package import inspect_archive
        inspect_archive(staging / FILES[0], manifest)
        destination.mkdir(parents=True, exist_ok=True)
        if any(destination.iterdir()):
            raise ReleaseError("fetch destination changed during download")
        for name in FILES:
            os.replace(staging / name, destination / name)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Upload an immutable Tennis-Green-PMS bundle to COS")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    upload = subparsers.add_parser("upload")
    upload.add_argument("--directory", required=True)
    upload.add_argument("--prefix", default=ROOT_PREFIX)
    upload.add_argument("--bucket")
    upload.add_argument("--region")
    fetch = subparsers.add_parser("fetch")
    fetch.add_argument("--version", required=True)
    fetch.add_argument("--revision", required=True)
    fetch.add_argument("--directory", required=True)
    fetch.add_argument("--prefix", default=ROOT_PREFIX)
    fetch.add_argument("--bucket")
    fetch.add_argument("--region")
    args = parser.parse_args(argv)
    if args.operation == "upload":
        result = upload_bundle(CosStore(args.bucket, args.region, prefix=args.prefix, role="UPLOAD"), args.directory, args.prefix)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    elif args.operation == "fetch":
        code = fetch_bundle(CosStore(args.bucket, args.region, prefix=args.prefix, role="UPLOAD"), args.version, args.revision, args.directory, args.prefix)
        print(json.dumps({"application": "tennis-green-pms", "status": "missing" if code == 3 else "fetched", "version": args.version,
                          "gitRevision": args.revision, "prefix": release_prefix(args.prefix, args.version, args.revision)},
                         ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        return code
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseError as error:
        print(f"Tennis-Green-PMS: {error}", file=os.sys.stderr)
        raise SystemExit(1)
