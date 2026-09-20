"""Configuration transaction failure/recovery and secret-preservation coverage."""
import base64
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_config
import server
from common import ReleaseError
from test_server import DeployerFixture

COMPOSE = b'services:\n  app:\n    environment:\n      TENNIS_DATABASE_URL: ${TENNIS_DATABASE_URL}\n'
KEY = base64.b64encode(b'x' * 32)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DeployerFixture()
        self.addCleanup(self.fixture.close)
        self.d = self.fixture.deployer
        self.fixture.compose_file.write_bytes(COMPOSE)
        self.fixture.env_file.write_bytes(b'TENNIS_DATABASE_URL=do-not-log\n')
        state = json.loads(self.d.state_file.read_bytes())
        state['configurationSha256'] = self.d.config_hash()
        server.atomic_json(self.d.state_file, state)
        self.before = self.d.state()
        self.old = {name: Path(self.d.config[name]).read_bytes() for name in ('composeFile', 'envFile')}
        for target in ('check_key_ready', 'check_empty_settings', 'root_owned'):
            mock = patch.object(ai_config, target)
            setattr(self, target, mock.start())
            self.addCleanup(mock.stop)

    def test_success_preserves_release_state_and_existing_fields_and_is_idempotent(self):
        result = ai_config.configure(self.d)
        self.assertTrue(result['keyReady'])
        state = self.d.state()
        for key, value in self.before.items():
            if key != 'configurationSha256':
                self.assertEqual(state[key], value)
        env = self.fixture.env_file.read_bytes()
        self.assertTrue(env.startswith(self.old['envFile']))
        self.assertEqual(len(base64.b64decode(env.splitlines()[-1].split(b'=', 1)[1])), 32)
        self.assertNotIn(b'do-not-log', (self.d.directory / 'audit.jsonl').read_bytes())
        self.assertFalse(ai_config.configure(self.d)['changed'])
        self.assertEqual(self.fixture.env_file.read_bytes(), env)
        self.check_empty_settings.assert_called_once()
        self.assertEqual(len(self.fixture.docker.switches), 1)
        self.assertEqual(self.fixture.env_file.stat().st_mode & 0o777, 0o600)

    def test_preexisting_valid_key_is_never_rotated(self):
        compose, env, generated = ai_config.candidates(COMPOSE, b'OTHER=keep\nTENNIS_AI_ENCRYPTION_KEY=' + KEY + b'\n')
        self.assertFalse(generated)
        self.assertIn(KEY, env)
        self.assertEqual(compose.split(b'  app:', 1)[0], COMPOSE.split(b'  app:', 1)[0])
        self.assertNotIn(b'wecom-worker', compose)
        for invalid in (b'', b'bad', b'"' + KEY + b'"'):
            with self.subTest(invalid=bool(invalid)), self.assertRaises(ReleaseError):
                ai_config.candidates(COMPOSE, b'TENNIS_AI_ENCRYPTION_KEY=' + invalid + b'\n')

    def test_existing_encrypted_settings_prevent_initialization(self):
        self.check_empty_settings.side_effect = ReleaseError('existing settings')
        with self.assertRaises(ReleaseError):
            ai_config.configure(self.d)
        self.assertEqual(self.d.state(), self.before)
        self.assertFalse(self.d.journal.exists())
        self.assertEqual(self.fixture.env_file.read_bytes(), self.old['envFile'])

    def test_untracked_configuration_drift_is_rejected(self):
        self.fixture.env_file.write_bytes(b'changed')
        with self.assertRaisesRegex(ReleaseError, 'external configuration changed'):
            ai_config.configure(self.d)
        self.assertEqual(self.fixture.docker.switches, [])

    def test_health_failure_restores_files_and_state(self):
        # Initial health passes, switched candidate fails, restoration passes.
        self.d.health = unittest.mock.Mock(side_effect=[None, ReleaseError('health failed'), None])
        with self.assertRaisesRegex(ReleaseError, 'health failed'):
            ai_config.configure(self.d)
        self.assertEqual(self.d.state(), self.before)
        for name, contents in self.old.items():
            self.assertEqual(Path(self.d.config[name]).read_bytes(), contents)
        self.assertFalse(self.d.journal.exists())
        self.assertEqual(len(self.fixture.docker.switches), 2)

    def test_key_self_check_failure_restores_original_configuration(self):
        self.check_key_ready.side_effect = ReleaseError('key check failed')
        with self.assertRaisesRegex(ReleaseError, 'key check failed'):
            ai_config.configure(self.d)
        self.assertEqual(self.d.state(), self.before)
        self.assertEqual(self.fixture.env_file.read_bytes(), self.old['envFile'])
        self.assertFalse(self.d.journal.exists())

    def test_recovery_failure_keeps_transaction_for_retry(self):
        self.d.health = unittest.mock.Mock(side_effect=[None, ReleaseError('candidate failed'), ReleaseError('restore failed'), None])
        with self.assertRaisesRegex(ReleaseError, 'restore failed'):
            ai_config.configure(self.d)
        self.assertTrue(self.d.journal.exists())
        self.d.recover()
        self.assertEqual(self.d.state(), self.before)
        self.assertFalse(self.d.journal.exists())

    def test_interrupted_partial_file_write_recovers_after_restart(self):
        original = ai_config.atomic_bytes
        def fail_env(path, contents):
            if Path(path) == self.fixture.env_file:
                raise KeyboardInterrupt()
            return original(path, contents)
        with patch.object(ai_config, 'atomic_bytes', side_effect=fail_env), patch.object(ai_config, 'recover', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                ai_config.configure(self.d)
        self.assertTrue(self.d.journal.exists())
        self.d.recover()
        self.assertEqual(self.d.state(), self.before)
        self.assertEqual(self.fixture.compose_file.read_bytes(), COMPOSE)
        self.assertFalse(self.d.journal.exists())

    def test_committed_transaction_recovers_forward_without_rotating(self):
        original = self.d.audit
        def fail_audit(event, **fields):
            if event == 'ai-configuration-healthy':
                raise KeyboardInterrupt()
            original(event, **fields)
        with patch.object(self.d, 'audit', side_effect=fail_audit), patch.object(ai_config, 'recover', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                ai_config.configure(self.d)
        new_env = self.fixture.env_file.read_bytes()
        self.d.recover()
        self.assertEqual(self.fixture.env_file.read_bytes(), new_env)
        self.assertNotEqual(self.d.state()['configurationSha256'], self.before['configurationSha256'])
        self.assertFalse(self.d.journal.exists())

    def test_corrupt_backup_or_unexpected_external_edit_keeps_journal(self):
        with patch.object(self.d.docker, 'switch', side_effect=KeyboardInterrupt()), patch.object(ai_config, 'recover', side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                ai_config.configure(self.d)
        self.fixture.env_file.write_bytes(b'unexpected third config')
        with self.assertRaisesRegex(ReleaseError, 'outside transaction'):
            self.d.recover()
        self.assertTrue(self.d.journal.exists())


if __name__ == '__main__':
    unittest.main()
