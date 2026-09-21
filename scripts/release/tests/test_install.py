"""Exercise the one-time installer without touching a server."""
from pathlib import Path
import os
import stat
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
INSTALLER = ROOT / "deploy/install.sh"
DEPLOY_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"


class InstallerTests(unittest.TestCase):
    def write_executable(self, directory: Path, name: str, body: str) -> None:
        path = directory / name
        path.write_text(body, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def fake_path(self, directory: Path, log: Path) -> str:
        logger = 'printf "%s\\n" "$*" >> "${FAKE_LOG}"\n'
        for name in ("docker", "zstd", "sudo", "visudo", "sshd", "systemctl", "useradd", "getent", "usermod", "flock"):
            body = "#!/bin/sh\n"
            if name == "docker":
                body += logger
                body += 'test "$*" = "compose version"\n'
            elif name == "sshd":
                body += "printf '%s\\n' 'authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2' 'forcecommand none'\n"
            elif name in ("systemctl", "useradd", "usermod", "sudo", "flock"):
                body += 'echo "unexpected system mutation in dry-run" >&2; exit 99\n'
            else:
                body += "exit 0\n"
            self.write_executable(directory, name, body)
        self.write_executable(directory, "python3", f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
        python_dir = str(Path(sys.executable).parent)
        return os.pathsep.join((str(directory), python_dir, "/usr/bin", "/bin"))

    def run_dry_run(self, key_path: str, path: str, log: Path) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update({"PATH": path, "FAKE_LOG": str(log)})
        return subprocess.run(
            ["bash", str(INSTALLER), "--dry-run", "--deploy-public-key", key_path],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_dry_run_checks_compose_version_and_does_not_run_docker_operations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            deploy_key = directory / "deploy.pub"
            deploy_key.write_text(DEPLOY_KEY + " deploy\n", encoding="utf-8")
            fake_bin = directory / "bin"
            fake_bin.mkdir()
            log = directory / "commands.log"
            path = self.fake_path(fake_bin, log)

            result = self.run_dry_run(str(deploy_key), path, log)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("dry-run passed", result.stdout)
            self.assertEqual(log.read_text(encoding="utf-8").splitlines(), ["compose version"])

    def test_invalid_public_key_fails_before_any_install_check(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            bad_key = directory / "bad.pub"
            good_key = directory / "good.pub"
            bad_key.write_text("not-a-public-key\n", encoding="utf-8")
            good_key.write_text(DEPLOY_KEY + "\n", encoding="utf-8")
            result = subprocess.run(
                ["bash", str(INSTALLER), "--dry-run", "--deploy-public-key", str(bad_key)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("public key must contain exactly one OpenSSH key", result.stderr)

    def test_removed_maintenance_public_key_option_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            key = directory / "deploy.pub"
            key.write_text(DEPLOY_KEY + "\n", encoding="utf-8")
            result = subprocess.run(
                ["bash", str(INSTALLER), "--dry-run", "--deploy-public-key", str(key),
                 "--maintenance-public-key", str(key)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unknown argument: --maintenance-public-key", result.stderr)

    def test_custom_force_command_refuses_install(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            deploy_key = directory / "deploy.pub"
            deploy_key.write_text(DEPLOY_KEY + "\n")
            fake_bin = directory / "bin"
            fake_bin.mkdir()
            log = directory / "commands.log"
            path = self.fake_path(fake_bin, log)
            self.write_executable(fake_bin, "sshd", "#!/bin/sh\nprintf '%s\\n' 'authorizedkeysfile .ssh/authorized_keys' 'forcecommand custom'\n")
            result = self.run_dry_run(str(deploy_key), path, log)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no applicable ForceCommand", result.stderr)

    def test_help_and_source_boundary_are_explicit(self) -> None:
        result = subprocess.run(["bash", str(INSTALLER), "--help"], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("/root/tennis-green-pms-setup/deploy.pub", result.stdout)
        self.assertNotIn("maintenance-public-key", result.stdout)

        source = INSTALLER.read_text(encoding="utf-8")
        self.assertIn('RUNTIME_SOURCES=("$SOURCE_ROOT"/scripts/release/*.py)', source)
        self.assertIn('"$SOURCE_ROOT/deploy/entry.py"', source)
        self.assertIn('docker compose version', source)
        self.assertIn('printf \'%s\\n\' \\', source)
        self.assertIn('restrict,command=\\"/usr/local/libexec/tennis-green-pms-ssh-entry\\" $DEPLOY_KEY', source)
        for forbidden in ("docker ps", "docker load", "docker compose up", "docker system prune", "apt-get"):
            self.assertNotIn(forbidden, source)
        self.assertNotIn('"$SOURCE_ROOT/apps', source)
        self.assertNotIn('"$SOURCE_ROOT/packages', source)

    def test_script_is_executable_and_ssh_restrictions_are_declared(self) -> None:
        self.assertTrue(INSTALLER.stat().st_mode & stat.S_IXUSR)
        source = INSTALLER.read_text(encoding="utf-8")
        for fragment in (
            "visudo -cf",
            "sshd -T -C",
            "authorizedkeysfile",
            "forcecommand",
            "HOME_DIR=/home/tennis-green-pms-deploy",
            "KEY_DIR=$HOME_DIR/.ssh",
            "chmod 0755 \"$HOME_DIR\" \"$KEY_DIR\"",
            "install_if_absent \"$STAGE/authorized_keys\" \"$KEY_FILE\" root 0644",
            "--shell /bin/sh",
            "usermod --password '*'",
            "systemctl enable --now tennis-green-pms-release-recovery.timer",
        ):
            self.assertIn(fragment, source)
        for fragment in (
            "sshd -t", "systemctl reload", "SSH_DROPIN", "AuthorizedKeysFile /etc/ssh",
            "MAINTENANCE_PUBLIC_KEY", "MAINTENANCE_KEY", "maintenance-only",
        ):
            self.assertNotIn(fragment, source)


if __name__ == "__main__":
    unittest.main()
