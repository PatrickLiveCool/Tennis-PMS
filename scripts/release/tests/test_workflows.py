from __future__ import annotations

import os
import json
import re
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
APP_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
CURRENT_TAG = f"v{APP_VERSION}"
MISMATCH_TAG = f"v{int(APP_VERSION.split('.')[0]) + 1}.0.0"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class ReleaseCheckTests(unittest.TestCase):
    def run_check(self, *arguments: str, **environment: str) -> subprocess.CompletedProcess[str]:
        child_environment = os.environ.copy()
        child_environment.pop("GITHUB_REF", None)
        child_environment.update(environment)
        return subprocess.run(
            ["node", str(ROOT / "scripts/check-release.mjs"), *arguments],
            cwd=ROOT,
            env=child_environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_current_release_accepts_matching_explicit_tag(self) -> None:
        result = self.run_check("--tag", CURRENT_TAG)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Release {CURRENT_TAG}", result.stdout)

    def test_explicit_root_is_checked_with_the_same_v_tag_contract(self) -> None:
        result = self.run_check("--root", str(ROOT), "--tag", CURRENT_TAG)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Release {CURRENT_TAG}", result.stdout)

    def test_tag_event_is_checked_and_mismatch_fails(self) -> None:
        matching = self.run_check(GITHUB_REF=f"refs/tags/{CURRENT_TAG}")
        self.assertEqual(matching.returncode, 0, matching.stderr)

        mismatch = self.run_check("--tag", MISMATCH_TAG)
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("must match package.json version", mismatch.stderr)

        conflicting_ref = self.run_check("--tag", CURRENT_TAG, GITHUB_REF=f"refs/tags/{MISMATCH_TAG}")
        self.assertNotEqual(conflicting_ref.returncode, 0)
        self.assertIn("does not match GITHUB_REF", conflicting_ref.stderr)

    def test_tag_format_is_strict(self) -> None:
        for tag in ("1.2.3", "v1.2", "v1.2.3-rc.1", "v01.2.3"):
            result = self.run_check("--tag", tag)
            self.assertNotEqual(result.returncode, 0, tag)
            self.assertIn("vX.Y.Z", result.stderr)


class WorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.ci = read(".github/workflows/ci.yml")
        cls.release_please = read(".github/workflows/release-please.yml")
        cls.release_please_config = json.loads(read(".release-please-config.json"))
        cls.release_please_manifest = json.loads(read(".release-please-manifest.json"))
        cls.release = read(".github/workflows/release.yml")
        cls.retention = read(".github/workflows/retention.yml")
        cls.rollback = read(".github/workflows/rollback.yml")
        cls.workflows = cls.ci + cls.release + cls.retention + cls.rollback

    def test_server_mutations_require_explicit_deployment_enablement(self) -> None:
        deploy = self.release.split("  deploy:", 1)[1]
        for workflow in (deploy, self.rollback, self.retention):
            self.assertIn("vars.TENNIS_DEPLOY_ENABLED == 'true'", workflow)
        self.assertIn("github.repository == 'PatrickLiveCool/Tennis-PMS'", self.release)
        validation = self.release.split("  package-upload:", 1)[0]
        for fragment in ("POSTGRES_DB: tennis_test", "POSTGRES_USER: tennis_dev", "run: npm run test:integration"):
            self.assertIn(fragment, validation)
        self.assertIn("image: postgres:18", validation)
        self.assertIn("image: postgres:16-alpine", self.ci)
        for workflow in (self.release, self.retention, self.rollback):
            for action in re.findall(r"uses: (.+)", workflow):
                self.assertRegex(action, r"@[0-9a-f]{40}(?: |$)")

    def test_release_please_prepares_version_pr_and_tag(self) -> None:
        for fragment in (
            "push:\n    branches:\n      - main",
            "workflow_dispatch:",
            "contents: write",
            "pull-requests: write",
            "release-please-action@8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5",
            "config-file: .release-please-config.json",
            "manifest-file: .release-please-manifest.json",
            "token: ${{ secrets.RELEASE_PLEASE_TOKEN }}",
        ):
            self.assertIn(fragment, self.release_please)
        self.assertNotIn("environment: production", self.release_please)
        self.assertNotIn("pull_request:", self.release_please)
        self.assertIn("github.repository == 'PatrickLiveCool/Tennis-PMS' && github.ref == 'refs/heads/main'", self.release_please)
        self.assertIn("target-branch: main", self.release_please)
        self.assertNotIn("github.token", self.release_please)
        self.assertNotIn("GITHUB_TOKEN", self.release_please)
        self.assertEqual(self.release_please_config["bootstrap-sha"], "47eb658a20aee5fc469a6ecbb17444999385da6a")
        package = self.release_please_config["packages"]["."]
        self.assertEqual(package["release-type"], "node")
        self.assertTrue(package["include-v-in-tag"])
        self.assertTrue(package["draft"])
        self.assertTrue(package["force-tag-creation"])
        self.assertEqual(package["pull-request-title-pattern"], "chore(release): release ${version}")
        for section in ("## 改动说明", "## 验证结果", "## 风险与回退"):
            self.assertIn(section, package["pull-request-header"])
        self.assertIn("This PR was generated with [Release Please]", package["pull-request-header"])
        self.assertEqual(package["extra-files"][0], {
            "type": "json",
            "path": "deploy/release-policy.json",
            "jsonpath": "$.version",
        })
        self.assertEqual(self.release_please_manifest["."], APP_VERSION)
        self.assertNotIn("actions/upload-artifact", self.release_please)
        self.assertNotIn("docker push", self.release_please)

    def test_missing_release_credential_fails_clearly_without_echoing_present_secret(self) -> None:
        preflight = self.release_please.split("      - name: Check dedicated release credential\n", 1)[1]
        script = preflight.split("        run: |\n", 1)[1].split("      - name:", 1)[0]
        script = "\n".join(line.removeprefix("          ") for line in script.splitlines())
        for token, expected in (("", 1), ("synthetic-private-release-token", 0)):
            environment = os.environ.copy()
            environment["RELEASE_PLEASE_TOKEN"] = token
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], env=environment,
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, expected, result.stderr)
            if token:
                self.assertEqual(result.stdout + result.stderr, "")
            else:
                self.assertIn("Missing repository secret RELEASE_PLEASE_TOKEN", result.stdout)

    def test_next_version_pr_is_compatible_with_existing_ci_and_release_policy(self) -> None:
        package = self.release_please_config["packages"]["."]
        next_version = f"{APP_VERSION.split('.')[0]}.{int(APP_VERSION.split('.')[1]) + 1}.0"
        pull_request = {
            "title": package["pull-request-title-pattern"].replace("${version}", next_version),
            "body": package["pull-request-header"] + f"\n\n## [{next_version}](https://example.invalid/release)\n\n### Features\n\n* Tennis changes\n",
            "head": {"ref": "release-please--branches--main"},
        }
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            event_path = directory / "event.json"
            event_path.write_text(json.dumps({"pull_request": pull_request}), encoding="utf-8")
            environment = os.environ.copy()
            environment["GITHUB_EVENT_PATH"] = str(event_path)
            result = subprocess.run(["node", str(ROOT / "scripts/check-pr.mjs")], cwd=ROOT,
                                    env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            for filename in ("package.json", "package-lock.json", "deploy/release-policy.json"):
                data = json.loads(read(filename))
                data["version"] = next_version
                if filename == "package-lock.json":
                    data["packages"][""]["version"] = next_version
                target = directory / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(data), encoding="utf-8")
            (directory / "CHANGELOG.md").write_text(f"## [{next_version}](https://example.invalid/release)\n\n### Features\n\n* Tennis changes\n", encoding="utf-8")
            environment.pop("GITHUB_REF", None)
            result = subprocess.run(["node", str(ROOT / "scripts/check-release.mjs"), "--root", str(directory)],
                                    cwd=ROOT, env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_ci_runs_required_checks_without_production_inputs(self) -> None:
        for fragment in (
            "pull_request:",
            "branches: [main]",
            "name: PR format",
            "if: github.event_name == 'pull_request'",
            "node --test scripts/check-pr-tests.mjs",
            "node scripts/check-pr.mjs",
            "name: Node and release checks",
            "node-version: 22.x",
            "run: npm ci",
            "run: npm run release:check",
            "run: npm run typecheck",
            "run: npm test",
            "run: npm run build",
            "run: npm run test:integration",
            "python3 -m unittest discover -s scripts/release/tests -p test_workflows.py -v",
        ):
            self.assertIn(fragment, self.ci)
        self.assertNotIn("environment: production", self.ci)
        self.assertNotIn("COS_", self.ci)
        self.assertNotIn("DEPLOY_", self.ci)

    def test_release_is_tagged_immutable_and_main_reachable(self) -> None:
        for fragment in (
            "release:\n    types: [published]",
            "github.event.release.prerelease == false",
            "github.event.release.tag_name",
            "tennis-green-pms-production",
            "cancel-in-progress: false",
            "git merge-base --is-ancestor \"$RELEASE_SHA\" origin/main",
            "node harness/scripts/check-release.mjs --root source --tag \"$RELEASE_TAG\"",
            "DOCKER_DEFAULT_PLATFORM: linux/amd64",
            "python3 harness/scripts/release/package.py",
            "python3 harness/scripts/release/cos.py upload",
            "tennis-green-pms/releases/",
            "UPLOAD_COS_SECRET_KEY",
            "environment: production",
            "persist-credentials: false",
            "DEPLOY_SSH_KEY_FILE",
            "DEPLOY_KNOWN_HOSTS_FILE",
            "python3 harness/scripts/release/orchestrate.py deploy",
            "--manifest-sha",
            "path: harness",
            "path: source",
            "--source-root \"$GITHUB_WORKSPACE/source\"",
            "harness_sha: ${{ steps.release.outputs.harness_sha }}",
            "HARNESS_SHA: ${{ needs.validate.outputs.harness_sha }}",
        ):
            self.assertIn(fragment, self.release)
        tagged_ref = "ref: ${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release_tag }}"
        self.assertEqual(self.release.count(tagged_ref), 1)
        self.assertEqual(self.release.count("ref: main"), 1)
        self.assertEqual(self.release.count("ref: ${{ needs.validate.outputs.harness_sha }}"), 2)
        self.assertNotIn("github.workflow_sha", self.release)
        self.assertIn("ref: ${{ needs.validate.outputs.release_tag }}", self.release)
        self.assertNotIn("ref: ${{ github.sha }}", self.release)
        self.assertIn("needs: [validate, package-upload]", self.release)
        self.assertNotIn("RELEASE_SHA: ${{ github.sha }}", self.release)
        self.assertNotIn("RELEASE_REVISION: ${{ github.sha }}", self.release)
        package_upload = self.release.split("  package-upload:", 1)[1].split("  deploy:", 1)[0]
        package_checkout = package_upload.split("      - name: Check out immutable release source", 1)[1].split(
            "      - name: Resolve release identity", 1
        )[0]
        self.assertIn("fetch-depth: 0", package_checkout)
        self.assertIn("ref: ${{ needs.validate.outputs.release_tag }}", package_checkout)
        self.assertIn("persist-credentials: false", package_checkout)
        self.assertIn("--source-root \"$GITHUB_WORKSPACE/source\"", package_upload)
        self.assertIn('test "$(git -C harness rev-parse HEAD)" = "$HARNESS_SHA"', package_upload)
        self.assertIn("working-directory: source", self.release.split("  package-upload:", 1)[0])
        self.assertIn("--version \"$RELEASE_VERSION\"", package_upload)
        deploy = self.release.split("  deploy:", 1)[1]
        self.assertIn("environment: production", package_upload)
        self.assertIn("UPLOAD_COS_SECRET_ID", package_upload)
        self.assertNotIn("DEPLOY_SSH_KEY", package_upload)
        self.assertNotIn("MARKER_COS_SECRET_ID", package_upload)
        self.assertIn("environment: production", deploy)
        for fragment in ("DEPLOY_SSH_KEY", "MARKER_COS_SECRET_ID", "RETENTION_COS_SECRET_ID"):
            self.assertIn(fragment, deploy)
        self.assertEqual(self.release.count("environment: production"), 2)
        self.assertNotIn("secrets.MARKER_COS_", self.workflows)
        self.assertNotIn("environment: release-build", self.workflows)
        self.assertNotIn("environment: release-maintenance", self.workflows)
        self.assertIn("python3 harness/scripts/release/cos.py fetch", package_upload)
        self.assertIn("if: steps.bundle.outputs.fetch_status == '3'", package_upload)
        self.assertIn('exit "$fetch_status"', package_upload)
        self.assertNotIn("RELEASE_TAG: ${{ github.event.release.tag_name }}", self.release)
        self.assertNotIn("RELEASE_VERSION: ${{ github.event.release.tag_name }}", self.release)
        self.assertIn("if: always()", self.release)
        self.assertNotIn("steps.metadata", self.release)
        self.assertNotIn("python3 scripts/release/orchestrate.py maintenance", self.release)

        harness_test = self.release.split("      - name: Test release harness", 1)[1].split("\n\n", 1)[0]
        self.assertIn("working-directory: harness", harness_test)
        self.assertIn("run: python3 -m unittest discover -s scripts/release/tests -v", harness_test)

    def test_release_checks_all_external_configuration_before_packaging(self) -> None:
        package_upload = self.release.split("  package-upload:", 1)[1].split("  deploy:", 1)[0]
        preflight = package_upload.split("      - name: Verify release infrastructure configuration", 1)[1].split(
            "      - name: Check out trusted release harness", 1
        )[0]
        for name in (
            "COS_BUCKET", "COS_REGION", "UPLOAD_COS_SECRET_ID", "UPLOAD_COS_SECRET_KEY",
        ):
            self.assertIn(name, preflight)
        self.assertIn("Missing Tennis-Green-PMS release configuration", preflight)
        self.assertNotIn("set -x", preflight)
        self.assertNotIn("DEPLOY_SSH_KEY", preflight)
        script = preflight.split("        run: |\n", 1)[1]
        script = "\n".join(line.removeprefix("          ") for line in script.splitlines())
        environment = {**os.environ, "COS_BUCKET": "synthetic-12345", "COS_REGION": "ap-shanghai",
                       "UPLOAD_COS_SECRET_ID": "synthetic", "UPLOAD_COS_SECRET_KEY": "synthetic-secret"}
        result = subprocess.run(["bash", "-eu", "-c", script], env=environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        environment["UPLOAD_COS_SECRET_KEY"] = ""
        result = subprocess.run(["bash", "-eu", "-c", script], env=environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("UPLOAD_COS_SECRET_KEY", result.stderr)
        self.assertNotIn("synthetic-secret", result.stdout + result.stderr)

    def test_package_key_command_preserves_v_prefix(self) -> None:
        package_step = self.release.split("      - name: Upload immutable release and verify stored bytes", 1)[1]
        package_step = package_step.split("      - name: Write release summary", 1)[0]
        version_line = next(line.strip() for line in package_step.splitlines() if line.strip().startswith("version="))
        key_line = next(line.strip() for line in package_step.splitlines() if line.strip().startswith("key="))
        self.assertEqual(version_line, 'version="$RELEASE_VERSION"')
        self.assertEqual(key_line, 'key="${COS_PREFIX}${version}/${revision}/"')
        with tempfile.TemporaryDirectory() as temporary:
            environment = os.environ.copy()
            environment.update({
                "RELEASE_VERSION": "v1.2.3",
                "RELEASE_REVISION": "a" * 40,
                "COS_PREFIX": "tennis-green-pms/releases/",
            })
            result = subprocess.run(
                ["bash", "-eu", "-c", "\n".join((version_line, "revision=\"$RELEASE_REVISION\"", key_line, "printf '%s\\n' \"$version|$key\""))],
                cwd=temporary,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), f"v1.2.3|tennis-green-pms/releases/v1.2.3/{'a' * 40}/")

    def test_runner_temp_is_step_scoped(self) -> None:
        for workflow in (self.release, self.retention, self.rollback):
            jobs = re.split(r"(?m)^  [a-z][a-z-]*:\n", workflow.split("jobs:\n", 1)[1])
            for job in jobs:
                job_env = job.split("    steps:", 1)[0]
                self.assertNotIn("runner.temp", job_env)

    def test_release_keeps_v_in_package_identity_and_cos_key(self) -> None:
        self.assertIn('version="$RELEASE_VERSION"', self.release)
        self.assertNotIn('version="${RELEASE_VERSION#v}"', self.release)

        with tempfile.TemporaryDirectory() as temporary:
            environment = os.environ.copy()
            environment.update({"RELEASE_VERSION": "v1.2.3", "RELEASE_REVISION": "a" * 40})
            result = subprocess.run(
                [
                    "bash",
                    "-eu",
                    "-c",
                    'version="$RELEASE_VERSION"; key="tennis-green-pms/releases/${version}/${RELEASE_REVISION}/"; test "$version" = v1.2.3; test "$key" = tennis-green-pms/releases/v1.2.3/'
                    + "a" * 40
                    + "/",
                ],
                cwd=temporary,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_ancestry_command_accepts_tag_before_later_main_commit(self) -> None:
        command = next(line.strip() for line in self.release.splitlines() if line.strip().startswith("git merge-base --is-ancestor"))
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repository, check=True)
            subprocess.run(["git", "config", "user.name", "Workflow Test"], cwd=repository, check=True)
            (repository / "release.txt").write_text("release\n", encoding="utf-8")
            subprocess.run(["git", "add", "release.txt"], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "release"], cwd=repository, check=True)
            release_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
            (repository / "docs.txt").write_text("post-release docs\n", encoding="utf-8")
            subprocess.run(["git", "add", "docs.txt"], cwd=repository, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "docs"], cwd=repository, check=True)
            main_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip()
            subprocess.run(["git", "update-ref", "refs/remotes/origin/main", main_sha], cwd=repository, check=True)

            environment = os.environ.copy()
            environment["RELEASE_SHA"] = release_sha
            result = subprocess.run(
                ["bash", "-eu", "-c", command],
                cwd=repository,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_retention_shares_lock_and_has_dry_run(self) -> None:
        for fragment in (
            "schedule:",
            "workflow_dispatch:",
            "dry_run:",
            "tennis-green-pms-production",
            "if: github.ref == 'refs/heads/main'",
            "environment: production",
            "RETENTION_COS_SECRET_ID",
            "RETENTION_COS_SECRET_KEY",
            "DEPLOY_SSH_KEY",
            "python3 scripts/release/orchestrate.py maintenance --dry-run",
            "python3 scripts/release/orchestrate.py maintenance",
            "if: always()",
        ):
            self.assertIn(fragment, self.retention)
        self.assertIn("secrets.DEPLOY_SSH_KEY", self.retention)
        self.assertNotIn("MAINTENANCE_SSH_KEY", self.workflows)

    def test_rollback_runs_trusted_main_tools_with_shared_environment_and_lock(self) -> None:
        for fragment in ("workflow_dispatch:", "if: github.ref == 'refs/heads/main'",
                         "environment: production", "group: tennis-green-pms-production",
                         'args=(rollback-release --version "$RELEASE_VERSION")',
                         "secrets.UPLOAD_COS_SECRET_KEY", "secrets.DEPLOY_SSH_KEY",
                         "if: always()"):
            self.assertIn(fragment, self.rollback)
        self.assertNotIn("ref: ${{ inputs.", self.rollback)
        self.assertNotIn("--manifest-sha", self.rollback)

    def test_secrets_are_not_inherited_by_setup_or_build_steps(self) -> None:
        for workflow in (self.release, self.retention, self.rollback):
            jobs = re.split(r"(?m)^  [a-z][a-z-]*:\n", workflow.split("jobs:\n", 1)[1])
            for job in jobs:
                self.assertNotIn("secrets.", job.split("    steps:", 1)[0])
            for step in workflow.split("      - name: ")[1:]:
                name = step.splitlines()[0]
                if name.startswith(("Set up", "Install", "Check out", "Build and package")):
                    self.assertNotIn("secrets.", step)

    def test_workflows_do_not_publish_github_or_registry_binaries(self) -> None:
        forbidden = (
            "actions/upload-artifact",
            "docker/build-push-action",
            "docker push",
            "gh release upload",
            "softprops/action-gh-release",
        )
        for fragment in forbidden:
            self.assertNotIn(fragment, self.workflows)
        self.assertNotIn("set -x", self.workflows)


if __name__ == "__main__":
    unittest.main()
