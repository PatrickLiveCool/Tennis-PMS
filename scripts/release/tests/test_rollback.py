"""GitHub rollback form resolves only verified successful releases, without SSH login."""
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

from scripts.release.common import ReleaseError
from scripts.release.orchestrate import rollback_release
from scripts.release.tests import test_cos as fixtures
from scripts.release.tests.test_cos import FakeCos, FakeSSH, add_release, complete_store


class RollbackFormTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeCos()
        self.store = complete_store(self.client, role="MARKER")
        self.prefix, self.manifest, self.digest = add_release(
            self.client, "v1.2.4", "a" * 40, "2026-09-09T10:00:00Z")

    def test_version_form_passes_exact_cos_identity_to_locked_rollback(self):
        receipt = {"application": "tennis-green-pms", "status": "healthy",
                   "deployedAt": "2026-09-10T10:00:00Z",
                   "current": {"prefix": self.prefix, "manifestSha256": self.digest,
                               "manifest": self.manifest, "runtimeImageId": "sha256:" + "f" * 64},
                   "previous": None, "rollbackFrom": None}
        calls = []
        with tempfile.TemporaryDirectory() as temporary, fixtures.OrchestrationTests().ssh_environment(temporary):
            result = rollback_release("v1.2.4", store=self.store,
                                      ssh_factory=lambda argv: calls.append(argv) or FakeSSH(receipt))
        self.assertEqual(calls[0][-5:], ["rollback", "v1.2.4", "a" * 40, self.prefix, self.digest])
        self.assertEqual(result["status"], "healthy")
        self.assertFalse(self.client.delete_calls)
        self.assertFalse(self.client.put_calls)  # Original successful marker remains immutable.

    def test_candidates_missing_payload_and_corrupt_markers_never_start_ssh(self):
        original = dict(self.client.objects)
        for scenario in ("candidate", "missing", "corrupt"):
            self.client.objects = dict(original)
            if scenario == "candidate":
                del self.client.objects[self.prefix + "deployed.json"]
            elif scenario == "missing":
                del self.client.objects[self.prefix + "sbom.spdx.json"]
            else:
                marker = json.loads(self.client.objects[self.prefix + "deployed.json"])
                marker["manifestSha256"] = "0" * 64
                self.client.objects[self.prefix + "deployed.json"] = json.dumps(marker).encode()
            ssh = Mock()
            with self.subTest(scenario=scenario), self.assertRaises(ReleaseError):
                rollback_release("v1.2.4", store=self.store, ssh_factory=ssh)
            ssh.assert_not_called()
        self.assertFalse(self.client.delete_calls)

    def test_ambiguous_version_requires_revision_instead_of_guessing(self):
        add_release(self.client, "v1.2.4", "b" * 40, "2026-09-09T11:00:00Z")
        with self.assertRaisesRegex(ReleaseError, "multiple successful revisions"):
            rollback_release("v1.2.4", store=self.store)
        with patch("scripts.release.orchestrate.rollback", return_value={}) as run:
            rollback_release("v1.2.4", revision="a" * 40, store=self.store)
        self.assertEqual(run.call_args.args, ("v1.2.4", "a" * 40, self.prefix, self.digest))

    def test_form_input_is_validated_before_cos_or_ssh(self):
        store = Mock()
        for version, revision in (("v01.2.4", None), ("v1.2.4;id", None),
                                  ("v1.2.4", "bad"), ("v1.2.4\n", None)):
            with self.subTest(version=version), self.assertRaises(ReleaseError):
                rollback_release(version, revision=revision, store=store)
        store.list.assert_not_called()


if __name__ == "__main__":
    unittest.main()
