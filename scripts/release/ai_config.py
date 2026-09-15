"""Administrator-only, recoverable initialization of AI key protection.

Never rotate an existing key, change provider settings, or log env contents.
Called by server.serve under the same lock as deployment and recovery.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile

from common import require, sha256_file, utcnow
from server import atomic_json, command, root_owned

KEY = "AI_SETTINGS_ENCRYPTION_KEY"
MAPPING = "      AI_SETTINGS_ENCRYPTION_KEY: ${AI_SETTINGS_ENCRYPTION_KEY:-}\n"


def atomic_bytes(path, data):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".ai-config-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def candidates(compose, env):
    # Only support the reviewed production layout; preserve all unrelated bytes.
    require(compose.count(b"  app:\n") == 1 and compose.count(b"  wecom-worker:\n") == 1,
            "unexpected production Compose layout")
    start, end = compose.index(b"  app:\n"), compose.index(b"  wecom-worker:\n")
    require(start < end, "unexpected production Compose order")
    app = compose[start:end]
    if KEY.encode() in compose:
        require(compose.count(KEY.encode()) == 2 and MAPPING.encode() in app,
                "existing AI Compose mapping requires administrator review")
    else:
        require(app.count(b"    environment:\n") == 1, "unexpected app environment layout")
        app = app.replace(b"    environment:\n", b"    environment:\n" + MAPPING.encode(), 1)
        compose = compose[:start] + app + compose[end:]
    # Refuse ambiguous/quoted/exported/empty definitions, rather than rotate keys.
    lines = [line for line in env.splitlines() if KEY.encode() in line and not line.lstrip().startswith(b"#")]
    if lines:
        require(len(lines) == 1 and re.fullmatch(rb"AI_SETTINGS_ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=", lines[0]) is not None,
                "existing AI key requires administrator review; no rotation performed")
        value = lines[0].split(b"=", 1)[1]
        require(base64.b64encode(base64.b64decode(value)) == value, "noncanonical AI key; no rotation performed")
        generated = False
    else:
        env += (b"" if not env or env.endswith(b"\n") else b"\n") + KEY.encode() + b"=" + base64.b64encode(secrets.token_bytes(32)) + b"\n"
        generated = True
    return compose, env, generated


def check_empty_settings():
    # Read only an existence bit. Never emit database URLs, provider keys or rows.
    command(["docker", "exec", "qintopia-pms-app", "node", "--input-type=module", "-e", """
import pg from 'pg';
if (process.env.AI_SETTINGS_ENCRYPTION_KEY) process.exit(1);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await db.connect();
  const result = await db.query('SELECT EXISTS (SELECT 1 FROM ai_model_settings WHERE encrypted_key IS NOT NULL) AS present');
  if (result.rows[0].present) process.exitCode = 1;
} catch { process.exitCode = 1; } finally { await db.end(); }
"""])


def check_key_ready():
    # Exercise the actual deployed encryption/decryption implementation, not a copy.
    command(["docker", "exec", "qintopia-pms-app", "node", "--input-type=module", "-e", """
try {
  const { keyReady, encryptKey, decryptKey } = await import('/app/apps/api/src/assistant-model.js');
  if (!keyReady() || decryptKey(encryptKey('deployment-self-check')) !== 'deployment-self-check') process.exitCode = 1;
} catch { process.exitCode = 1; }
"""])


def recover(deployer, transaction):
    require(transaction.get("kind") == "ai-configuration", "unexpected configuration transaction")
    state = json.loads(deployer.state_file.read_bytes())
    require(state in (transaction["before"], transaction["after"]), "configuration recovery state changed")
    committed = state == transaction["after"]
    target = "after" if committed else "before"
    backup = deployer.directory / transaction["backup"]
    require(re.fullmatch(r"ai-config-[a-zA-Z0-9_-]+", transaction["backup"]) is not None,
            "invalid configuration backup path")
    root_owned(backup, secret=True)
    for name in ("composeFile", "envFile"):
        path = Path(deployer.config[name])
        root_owned(path, secret=name == "envFile")
        require(sha256_file(path) in [transaction["files"][name][side] for side in ("before", "after")],
                "configuration changed outside transaction; administrator investigation required")
        for side in ("before", "after"):
            source = backup / (name + "." + side)
            root_owned(source, secret=True)
            require(sha256_file(source) == transaction["files"][name][side], "configuration backup checksum mismatch")
    for name in ("composeFile", "envFile"):
        atomic_bytes(deployer.config[name], (backup / (name + "." + target)).read_bytes())
    require(deployer.config_hash() == state["configurationSha256"], "restored configuration checksum mismatch")
    deployer.docker.switch(state["current"])
    deployer.health(state["current"])
    if committed:
        check_key_ready()
    deployer.audit("ai-configuration-recovered", committed=committed, backup=transaction["backup"])
    deployer.journal.unlink()


def configure(deployer):
    require(not deployer.journal.exists(), "recover unfinished deployment first")
    before = deployer.state()  # Validate old hash BEFORE touching files.
    deployer.observe(before)
    deployer.health(before["current"])
    paths = {name: Path(deployer.config[name]) for name in ("composeFile", "envFile")}
    old = {name: path.read_bytes() for name, path in paths.items()}
    compose, env, generated = candidates(old["composeFile"], old["envFile"])
    new = {"composeFile": compose, "envFile": env}
    if new == old:
        check_key_ready()
        return {"status": "healthy", "keyReady": True, "changed": False}
    if generated:
        check_empty_settings()
    backup = Path(tempfile.mkdtemp(prefix="ai-config-", dir=deployer.directory))
    hashes = {}
    for name in paths:
        hashes[name] = {}
        for side, contents in (("before", old[name]), ("after", new[name])):
            atomic_bytes(backup / (name + "." + side), contents)
            hashes[name][side] = hashlib.sha256(contents).hexdigest()
    after = {**before, "configurationSha256": hashlib.sha256(
        (hashes["composeFile"]["after"] + hashes["envFile"]["after"]).encode()).hexdigest()}
    transaction = {"kind": "ai-configuration", "before": before, "after": after,
                   "backup": backup.name, "files": hashes, "startedAt": utcnow()}
    atomic_json(deployer.journal, transaction)
    try:
        deployer.audit("ai-configuration-started", backup=backup.name)
        for name, path in paths.items():
            atomic_bytes(path, new[name])
        require(deployer.config_hash() == after["configurationSha256"], "candidate configuration checksum mismatch")
        deployer.docker.switch(before["current"])
        deployer.health(before["current"])
        check_key_ready()
        # Preserve current/previous, migration baseline, release time and identity.
        atomic_json(deployer.state_file, after)
        deployer.audit("ai-configuration-healthy", backup=backup.name)
        deployer.journal.unlink()
    except BaseException:
        recover(deployer, transaction)
        raise
    return {"status": "healthy", "keyReady": True, "changed": True, "backup": backup.name}
