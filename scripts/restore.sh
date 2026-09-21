#!/usr/bin/env bash
set -euo pipefail

if [[ "${ALLOW_RESTORE:-false}" != "true" ]]; then
  printf 'Refusing restore. Set ALLOW_RESTORE=true and restore only into a new Tennis database.\n' >&2
  exit 2
fi

backup="${1:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
target="${2:?usage: ALLOW_RESTORE=true ./scripts/restore.sh BACKUP TARGET_DATABASE}"
container="${TENNIS_POSTGRES_CONTAINER_NAME:-tennis-green-pms-postgres}"
user="${TENNIS_POSTGRES_USER:-tennis_dev}"
live_database="${TENNIS_POSTGRES_DB:-tennis_dev}"

if [[ "$target" == "$live_database" ]]; then
  printf 'Refusing to restore over the configured live Tennis database %s.\n' "$live_database" >&2
  exit 2
fi
if [[ ! "$target" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,62}$ ]]; then
  printf 'Refusing unsafe target database name: %s\n' "$target" >&2
  exit 2
fi
test -s "$backup"

target_exists="$(docker exec "$container" psql -U "$user" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$target'")"
if [[ "$target_exists" == "1" ]]; then
  printf 'Refusing restore because target database %s already exists. Choose a new database name.\n' "$target" >&2
  exit 2
fi

docker exec "$container" createdb -U "$user" "$target"
if ! docker exec -i "$container" pg_restore -U "$user" -d "$target" --no-owner --no-privileges < "$backup"; then
  printf 'Restore failed; partial target database %s was retained for manual inspection.\n' "$target" >&2
  exit 1
fi

migration_count="$(docker exec "$container" psql -U "$user" -d "$target" -Atc "SELECT count(*) FROM public.tennis_schema_migrations")"
if [[ ! "$migration_count" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Restore target %s does not contain a Tennis migration history.\n' "$target" >&2
  exit 1
fi
printf 'Tennis restore verified: %s migrations restored into %s.\n' "$migration_count" "$target"
