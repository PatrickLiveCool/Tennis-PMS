"""Exercise the actual command boundary without sshd, sudo, Docker or COS."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts/release"))
from common import ReleaseError, SOURCE, validate_manifest
from server import Docker, command


class EntryTests(unittest.TestCase):
    def test_manifest_schema_fails_closed_before_external_commands(self):
        import copy
        revision = "a" * 40
        manifest = {"schemaVersion": 1, "application": "tennis-green-pms", "version": "v1.2.4", "gitRevision": revision,
                    "platform": "linux/amd64", "imageId": "sha256:" + "b" * 64,
                    "imageTag": "tennis-green-pms:v1.2.4-" + revision, "archiveSha256": "c" * 64,
                    "sbomSha256": "d" * 64, "source": SOURCE, "createdAt": "2026-09-09T12:00:00Z",
                    "requiredMigrations": [{"name": "001_initial.sql", "sha256": "e" * 64}],
                    "rollbackCompatibility": {"mode": "same-migrations-only", "reason": "No migration changes"}}
        validate_manifest(manifest)
        changes = [{"unexpected": "metadata"}, {"schemaVersion": True}, {"gitRevision": "a" * 64},
                   {"version": "v01.2.4"}, {"requiredMigrations": []},
                   {"requiredMigrations": [{"name": "../001_initial.sql", "sha256": "e" * 64}]},
                   {"requiredMigrations": [{"name": "plain.txt", "sha256": "e" * 64}]},
                   {"rollbackCompatibility": {"mode": "same-migrations-only", "reason": "ok", "ignore": True}},
                   {"source": "https://example.invalid"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                validate_manifest({**copy.deepcopy(manifest), **change})

    def run_entry(self, original, *entry_arguments):
        with patch.dict(os.environ, {"SSH_ORIGINAL_COMMAND": original}, clear=True), \
                patch.object(sys, "argv", [str(ROOT / "deploy/ssh-entry.py"), *entry_arguments]), \
                patch("subprocess.run") as run:
            run.return_value.returncode = 0
            with self.assertRaises(SystemExit):
                runpy.run_path(str(ROOT / "deploy/ssh-entry.py"), run_name="__main__")
            return run.call_args_list

    def test_only_exact_fixed_command_reaches_sudo(self):
        revision, digest = "a" * 40, "b" * 64
        key = f"tennis-green-pms/releases/v1.2.4/{revision}/"
        calls = self.run_entry(f"deploy v1.2.4 {revision} {key} {digest}")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[0], ["sudo", "-n", "/usr/local/sbin/tennis-green-pms-deploy", "deploy", "v1.2.4", revision, key, digest])
        self.assertNotIn("shell", calls[0].kwargs)
        self.assertEqual(set(calls[0].kwargs["env"]), {"PATH"})

    def test_maintenance_entry_uses_the_shared_deploy_key_protocol(self):
        calls = self.run_entry("maintenance")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[0], ["sudo", "-n", "/usr/local/sbin/tennis-green-pms-deploy", "maintenance"])

        revision, digest = "a" * 40, "b" * 64
        deploy_request = f"deploy v1.2.4 {revision} tennis-green-pms/releases/v1.2.4/{revision}/ {digest}"
        rollback_request = f"rollback v1.2.4 {revision} tennis-green-pms/releases/v1.2.4/{revision}/ {digest}"
        for request in (deploy_request, rollback_request):
            with self.subTest(request=request):
                calls = self.run_entry(request)
                self.assertEqual(len(calls), 1)

    def test_entry_mode_arguments_are_rejected_before_sudo(self):
        for entry_arguments in (("--maintenance-only",), ("--bad-flag",)):
            with self.subTest(entry_arguments=entry_arguments):
                self.assertEqual(self.run_entry("maintenance", *entry_arguments), [])

    def test_shell_injection_interaction_recovery_and_bad_identity_rejected(self):
        revision, digest = "a" * 40, "b" * 64
        request = f"deploy v1.2.4 {revision} tennis-green-pms/releases/v1.2.4/{revision}/ {digest}"
        for value in ("", "bash", "maintenance; id", "maintenance\n", "recover", "adopt", "rollback-local", "configure-ai",
                      request + " ; id", request + " --help", request.replace("v1.2.4/", "v1.2.3/"),
                      request.replace("tennis-green-pms/releases/", "other/releases/"), request.replace("v1.2.4", "v01.2.4")):
            with self.subTest(request=value):
                self.assertEqual(self.run_entry(value), [])

    def test_docker_adapter_uses_fixed_project_no_build_no_pull_and_clean_env(self):
        config = {"composeFile": "/etc/tennis-green-pms/compose.server.yaml", "envFile": "/etc/tennis-green-pms/app.env"}
        docker = Docker(config)
        runtime_image_id = "sha256:" + "c" * 64
        manifest = {"imageId": "sha256:" + "a" * 64, "imageTag": "tennis-green-pms:v1.2.4-" + "b" * 40,
                    "version": "v1.2.4", "gitRevision": "b" * 40, "source": SOURCE,
                    "createdAt": "2026-09-09T00:00:00Z"}
        image = {"Id": runtime_image_id, "RepoTags": [manifest["imageTag"]], "Os": "linux", "Architecture": "amd64",
                 "Labels": {f"org.opencontainers.image.{field}": manifest[value] for field, value in
                            (("version", "version"), ("revision", "gitRevision"), ("source", "source"), ("created", "createdAt"))}}
        with patch.object(docker, "inspect_image", return_value=image), patch("server.command") as run:
            docker.switch({"manifest": manifest, "runtimeImageId": runtime_image_id})
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ["docker", "compose", "--project-name", "tennis-green-pms"])
            self.assertIn("--no-build", args)
            self.assertEqual(args[args.index("--pull") + 1], "never")
            self.assertEqual(args[-1:], ["app"])
            self.assertEqual(set(run.call_args.kwargs["env"]), {"PATH", "TENNIS_GREEN_PMS_IMAGE"})

    def test_production_compose_uses_one_immutable_image_for_app(self):
        compose = (ROOT / "compose.server.yaml").read_text(encoding="utf-8")
        self.assertEqual(compose.count("image: ${TENNIS_GREEN_PMS_IMAGE:"), 1)
        self.assertIn("container_name: ${TENNIS_GREEN_PMS_CONTAINER_NAME:-tennis-green-pms-app}", compose)
        self.assertNotIn("wecom-worker", compose)
        self.assertNotIn("build:", compose)

    def test_subprocess_failure_does_not_include_secret_output(self):
        with patch("server.subprocess.run") as run:
            run.return_value.returncode = 1
            run.return_value.stdout = b"SENTINEL_DATABASE_PASSWORD"
            run.return_value.stderr = b"SENTINEL_COS_TOKEN"
            with self.assertRaises(ReleaseError) as error:
                command(["docker", "load", "--input", "/tmp/fake"])
            self.assertNotIn("SENTINEL", str(error.exception))


if __name__ == "__main__":
    unittest.main()
