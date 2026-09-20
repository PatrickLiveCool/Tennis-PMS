"""Generate non-secret setup files locally; never contact COS, SSH or Docker."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

from common import FILES


def configuration(bucket: str, region: str, public_host: str) -> dict[str, dict]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,48}-[0-9]{5,20}", bucket):
        raise ValueError("bucket must include the numeric APPID suffix")
    if not re.fullmatch(r"[a-z]{2}-[a-z]+(?:-[a-z]+)?(?:-[0-9]+)?", region):
        raise ValueError("region must be a COS region, e.g. ap-guangzhou")
    if (len(public_host) > 253 or "." not in public_host or
            any(not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", part)
                for part in public_host.split("."))):
        raise ValueError("public host must be a hostname without https://, path or credentials")
    appid = bucket.rsplit("-", 1)[1]
    bucket_resource = f"qcs::cos:{region}:uid/{appid}:{bucket}/*"
    objects = f"qcs::cos:{region}:uid/{appid}:{bucket}/tennis-green-pms/releases/*"
    result = {}
    upload_names = (*FILES, "deployed.json")
    for role in ("upload", "retention", "reader"):
        read_names = upload_names if role == "upload" else (
            ("manifest.json", "SHA256SUMS", "deployed.json") if role == "retention" else FILES)
        statements = [{"effect": "allow", "action": ["name/cos:GetObject"],
                       "resource": [objects + "/" + name for name in read_names]}]
        if role == "upload":
            statements.append({"effect": "allow", "action": ["name/cos:HeadObject"],
                               "resource": [objects + "/" + name for name in upload_names]})
        if role != "reader":
            statements.append({"effect": "allow", "action": ["name/cos:GetBucketVersioning"],
                               "resource": [bucket_resource]})
        # Upload's fetch command also lists an existing immutable release for reuse.
        if role in ("upload", "retention"):
            statements.append({"effect": "allow", "action": ["name/cos:GetBucket"],
                               "resource": [bucket_resource],
                               "condition": {"string_like": {"cos:prefix": ["tennis-green-pms%2Freleases%2F*"]}}})
        if role == "upload":
            statements.append({"effect": "allow", "action": ["name/cos:PutObject"],
                               "resource": [objects + "/" + name for name in upload_names]})
        elif role == "retention":
            statements.append({"effect": "allow", "action": ["name/cos:DeleteObject"],
                               "resource": [objects + "/" + name for name in (*FILES, "deployed.json")]})
        result[f"cam-{role}.json"] = {"version": "2.0", "statement": statements}
    template = Path(__file__).resolve().parents[2] / "deploy/server-config.example.json"
    deploy = json.loads(template.read_text())
    deploy["cos"] = {"bucket": bucket, "region": region}
    deploy["publicReadyUrl"] = f"https://{public_host}/health"
    deploy["publicVersionUrl"] = f"https://{public_host}/version"
    result["deploy.json"] = deploy
    return result


def write_configuration(output: Path, documents: dict[str, dict]) -> None:
    # A new directory makes accidental overwrite of earlier setup impossible.
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, document in documents.items():
        with (output / name).open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(document, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        documents = configuration(args.bucket, args.region, args.public_host)
        write_configuration(args.output, documents)
    except (ValueError, OSError) as error:
        parser.exit(1, f"Tennis-Green-PMS setup: {error}\n")
    print("Created three CAM policy files and deploy.json. No cloud or server changes made.")


if __name__ == "__main__":
    main()
