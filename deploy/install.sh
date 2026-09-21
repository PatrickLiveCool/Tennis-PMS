#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

INSTALL_ROOT=/opt/tennis-green-pms-release
LIB_DIR=$INSTALL_ROOT/lib
VENV_DIR=$INSTALL_ROOT/venv
CONFIG_DIR=/etc/tennis-green-pms
STATE_DIR=/var/lib/tennis-green-pms-release
HOME_DIR=/home/tennis-green-pms-deploy
DEPLOY_USER=tennis-green-pms-deploy
KEY_DIR=$HOME_DIR/.ssh
KEY_FILE=$KEY_DIR/authorized_keys
SUDOERS_FILE=/etc/sudoers.d/tennis-green-pms-deploy
SERVICE_FILE=/etc/systemd/system/tennis-green-pms-release-recovery.service
TIMER_FILE=/etc/systemd/system/tennis-green-pms-release-recovery.timer
LOGROTATE_FILE=/etc/logrotate.d/tennis-green-pms-release

DRY_RUN=0
DEPLOY_PUBLIC_KEY=
STAGE=

die() { printf 'Tennis-Green-PMS installer: %s\n' "$*" >&2; exit 1; }
note() { printf 'Tennis-Green-PMS installer: %s\n' "$*"; }

usage() {
    cat <<'EOF'
Usage: sudo bash deploy/install.sh [--dry-run] \
  --deploy-public-key /root/tennis-green-pms-setup/deploy.pub

Installs the Tennis-Green-PMS release runtime and one restricted forced-command SSH key.
It does not create app/COS configuration, adopt a release, enable the recovery
timer, or operate Docker containers or databases.
EOF
}

while (($#)); do
    case "$1" in
        --dry-run) DRY_RUN=1; shift ;;
        --deploy-public-key) (($# >= 2)) || die "--deploy-public-key needs a file path"; DEPLOY_PUBLIC_KEY=$2; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1" ;;
    esac
done
[[ -n "$DEPLOY_PUBLIC_KEY" ]] || die "--deploy-public-key is required"
(( DRY_RUN )) || [[ ${EUID:-$(id -u)} -eq 0 ]] || die "run as root"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
for required in \
    "$SOURCE_ROOT/compose.server.yaml" "$SOURCE_ROOT/deploy/entry.py" \
    "$SOURCE_ROOT/deploy/tennis-green-pms-deploy" "$SOURCE_ROOT/deploy/tennis-green-pms-deploy.sudoers" \
    "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.service" \
    "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.timer" \
    "$SOURCE_ROOT/deploy/tennis-green-pms-release.logrotate" "$SOURCE_ROOT/deploy/ssh-entry.py" \
    "$SOURCE_ROOT/scripts/release/requirements.txt"; do
    [[ -f "$required" && ! -L "$required" ]] || die "reviewed archive is incomplete: $required"
done
shopt -s nullglob
RUNTIME_SOURCES=("$SOURCE_ROOT"/scripts/release/*.py)
(( ${#RUNTIME_SOURCES[@]} )) || die "reviewed archive has no release runtime scripts"

normalize_public_key() {
    local path=$1
    [[ -f "$path" && ! -L "$path" ]] || die "public key is missing or a symlink: $path"
    awk '
        BEGIN { count = 0 }
        /^[[:space:]]*$/ { next }
        NF < 2 { exit 2 }
        $1 !~ /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/ { exit 2 }
        $2 !~ /^[A-Za-z0-9+\/=]+$/ { exit 2 }
        { value = $1 " " $2; count++ }
        END { if (count != 1) exit 2; print value }
    ' "$path" || die "public key must contain exactly one OpenSSH key: $path"
}

DEPLOY_KEY=$(normalize_public_key "$DEPLOY_PUBLIC_KEY")

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"; }
for command_name in python3 zstd sudo visudo sshd systemctl docker install cmp stat id getent useradd usermod flock mktemp; do
    need_cmd "$command_name"
done
python3 -c 'import sys, venv; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' \
    || die "Python 3.10 or newer with the venv module is required"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

STAGE=$(mktemp -d /tmp/tennis-green-pms-install.XXXXXX)
trap 'status=$?; [[ -z "${STAGE:-}" || ! -d "$STAGE" ]] || rm -rf -- "$STAGE"; exit "$status"' EXIT
install -d -m 0700 "$STAGE"
printf '%s\n' \
    "restrict,command=\"/usr/local/libexec/tennis-green-pms-ssh-entry\" $DEPLOY_KEY" \
    > "$STAGE/authorized_keys"

effective_sshd=$(sshd -T -C user="$DEPLOY_USER",addr=127.0.0.1,laddr=127.0.0.1,lport=22 2>/dev/null) \
    || die "sshd effective configuration cannot be checked"
printf '%s\n' "$effective_sshd" | awk '
    $1 == "authorizedkeysfile" { for (i = 2; i <= NF; i++) if ($i == ".ssh/authorized_keys") found = 1 }
    $1 == "forcecommand" && $2 != "none" { conflict = 1 }
    END { exit !(found && !conflict) }
' || die "sshd must use .ssh/authorized_keys and have no applicable ForceCommand"
visudo -cf "$SOURCE_ROOT/deploy/tennis-green-pms-deploy.sudoers" >/dev/null \
    || die "sudoers validation failed"

assert_root() {
    local path=$1 label=$2 owner mode
    (( DRY_RUN )) && return
    [[ ! -L "$path" ]] || die "$label is a symlink: $path"
    owner=$(stat -c '%u:%g' -- "$path")
    mode=$(stat -c '%a' -- "$path")
    [[ "$owner" == 0:0 ]] || die "$label must be root-owned: $path"
    case "${mode: -2}" in *[2367]*) die "$label is group/world writable: $path";; esac
}
ensure_dir() {
    local path=$1 mode=$2 label=$3
    [[ ! -L "$path" ]] || die "$label is a symlink: $path"
    [[ ! -e "$path" || -d "$path" ]] || die "$label is not a directory: $path"
    if (( DRY_RUN )); then note "would ensure $label: $path"; return; fi
    [[ -d "$path" ]] || install -o root -g root -d -m "$mode" "$path"
    assert_root "$path" "$label"
}
check_existing() {
    local source=$1 target=$2 label=$3
    if [[ -e "$target" || -L "$target" ]]; then
        [[ ! -L "$target" ]] || die "$label is a symlink: $target"
        cmp -s "$source" "$target" || die "existing $label differs; review it before rerunning: $target"
        assert_root "$target" "$label"
    fi
}

ensure_dir "$INSTALL_ROOT" 0755 "release root"
ensure_dir "$LIB_DIR" 0755 "release library"
ensure_dir "$CONFIG_DIR" 0700 "application configuration directory"
ensure_dir "$STATE_DIR" 0700 "release state directory"
ensure_dir "$HOME_DIR" 0755 "deployment home"
ensure_dir "$KEY_DIR" 0755 "deployment SSH directory"
ensure_dir /usr/local/sbin 0755 "system wrapper directory"
ensure_dir /usr/local/libexec 0755 "SSH entry directory"
ensure_dir /etc/sudoers.d 0755 "sudoers directory"
ensure_dir /etc/systemd/system 0755 "systemd directory"
ensure_dir /etc/logrotate.d 0755 "logrotate directory"
if [[ -e "$VENV_DIR" || -L "$VENV_DIR" ]]; then ensure_dir "$VENV_DIR" 0755 "release virtual environment"; fi
[[ ! -e "$KEY_DIR/authorized_keys2" && ! -L "$KEY_DIR/authorized_keys2" ]] \
    || die "remove or reconcile unmanaged $KEY_DIR/authorized_keys2 before installing"

if (( ! DRY_RUN )); then
    exec 9>"$STATE_DIR/deploy.lock"
    flock -n 9 || die "another Tennis-Green-PMS install or release operation owns the lock"
fi

check_existing "$SOURCE_ROOT/deploy/tennis-green-pms-deploy.sudoers" "$SUDOERS_FILE" "sudoers file"
check_existing "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.service" "$SERVICE_FILE" "recovery service"
check_existing "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.timer" "$TIMER_FILE" "recovery timer"
check_existing "$SOURCE_ROOT/deploy/tennis-green-pms-release.logrotate" "$LOGROTATE_FILE" "logrotate file"
check_existing "$SOURCE_ROOT/compose.server.yaml" "$CONFIG_DIR/compose.server.yaml" "production compose file"
check_existing "$STAGE/authorized_keys" "$KEY_FILE" "authorized keys"
for source in "${RUNTIME_SOURCES[@]}"; do check_existing "$source" "$LIB_DIR/$(basename "$source")" "release runtime file"; done
for pair in \
    "$SOURCE_ROOT/deploy/entry.py:$INSTALL_ROOT/entry.py" \
    "$SOURCE_ROOT/deploy/tennis-green-pms-deploy:/usr/local/sbin/tennis-green-pms-deploy" \
    "$SOURCE_ROOT/deploy/ssh-entry.py:/usr/local/libexec/tennis-green-pms-ssh-entry"; do
    source=${pair%%:*}; target=${pair#*:}
    check_existing "$source" "$target" "managed runtime file"
done

if (( DRY_RUN )); then
    note "dry-run passed; no user, file, service, venv, SSH key, or Docker state changed"
    exit 0
fi

if entry=$(getent passwd "$DEPLOY_USER"); then
    IFS=: read -r _ _ _ _ _ deploy_home deploy_shell _ <<< "$entry"
    [[ "$deploy_home" == "$HOME_DIR" && "$deploy_shell" == /bin/sh ]] \
        || die "$DEPLOY_USER must use home $HOME_DIR and shell /bin/sh"
else
    useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /bin/sh "$DEPLOY_USER"
fi
for group in $(id -nG "$DEPLOY_USER"); do
    [[ "$group" != docker && "$group" != sudo ]] || die "$DEPLOY_USER must not belong to docker or sudo group"
done
usermod --password '*' "$DEPLOY_USER"
chown root:root "$HOME_DIR" "$KEY_DIR"
chmod 0755 "$HOME_DIR" "$KEY_DIR"

if [[ ! -x "$VENV_DIR/bin/python3" ]]; then
    [[ ! -e "$VENV_DIR" ]] || die "existing release venv is incomplete; repair it before rerunning"
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python3" -m pip install --disable-pip-version-check --no-input -r "$SOURCE_ROOT/scripts/release/requirements.txt" >/dev/null

install_if_absent() {
    local source=$1 target=$2 owner=$3 mode=$4
    [[ -e "$target" ]] || install -o "$owner" -g "$owner" -m "$mode" "$source" "$target"
}
for source in "${RUNTIME_SOURCES[@]}"; do install_if_absent "$source" "$LIB_DIR/$(basename "$source")" root 0644; done
install_if_absent "$SOURCE_ROOT/deploy/entry.py" "$INSTALL_ROOT/entry.py" root 0644
install_if_absent "$SOURCE_ROOT/deploy/tennis-green-pms-deploy" /usr/local/sbin/tennis-green-pms-deploy root 0755
install_if_absent "$SOURCE_ROOT/deploy/ssh-entry.py" /usr/local/libexec/tennis-green-pms-ssh-entry root 0755
install_if_absent "$SOURCE_ROOT/deploy/tennis-green-pms-deploy.sudoers" "$SUDOERS_FILE" root 0440
install_if_absent "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.service" "$SERVICE_FILE" root 0644
install_if_absent "$SOURCE_ROOT/deploy/tennis-green-pms-release-recovery.timer" "$TIMER_FILE" root 0644
install_if_absent "$SOURCE_ROOT/deploy/tennis-green-pms-release.logrotate" "$LOGROTATE_FILE" root 0644
install_if_absent "$SOURCE_ROOT/compose.server.yaml" "$CONFIG_DIR/compose.server.yaml" root 0644
install_if_absent "$STAGE/authorized_keys" "$KEY_FILE" root 0644
systemctl daemon-reload

note "installed runtime, forced-command SSH keys, sudoers, recovery units, logrotate, and missing compose file"
note "recovery timer remains disabled; after adoption run: sudo systemctl enable --now tennis-green-pms-release-recovery.timer"
note "next create /etc/tennis-green-pms/app.env, deploy.json, and cos-readonly.json, then run adoption"
