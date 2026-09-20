#!/usr/bin/env bash
set -euo pipefail

source ./scripts/verify-tennis-postgres.sh
target_database=tennis_restore_test
workdir="$(mktemp -d)"
backup="$workdir/tennis.dump"

cleanup() {
  stop_test_postgres
  rm -rf -- "$workdir"
}
trap cleanup EXIT

start_test_postgres
source_database="$database"
TENNIS_DATABASE_URL="$database_url" TENNIS_ALLOW_NONLOCAL_DATABASE=true npm run tennis:db:migrate >/dev/null
docker exec "$container" psql -U "$user" -d "$source_database" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE tennis.backup_restore_sentinel (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO tennis.backup_restore_sentinel VALUES (1, 'synthetic-only');" >/dev/null

TENNIS_POSTGRES_CONTAINER_NAME="$container" TENNIS_POSTGRES_USER="$user" TENNIS_POSTGRES_DB="$source_database" \
  bash ./scripts/backup.sh "$backup" >/dev/null
test -s "$backup"

if bash ./scripts/restore.sh "$backup" "$target_database" >/dev/null 2>&1; then
  printf 'Restore accepted missing ALLOW_RESTORE guard.\n' >&2; exit 1
fi
if ALLOW_RESTORE=true TENNIS_POSTGRES_DB="$source_database" bash ./scripts/restore.sh "$backup" "$source_database" >/dev/null 2>&1; then
  printf 'Restore accepted the live database as target.\n' >&2; exit 1
fi

ALLOW_RESTORE=true \
TENNIS_POSTGRES_CONTAINER_NAME="$container" \
TENNIS_POSTGRES_USER="$user" \
TENNIS_POSTGRES_PASSWORD="$password" \
TENNIS_POSTGRES_DB="$source_database" \
bash ./scripts/restore.sh "$backup" "$target_database" >/dev/null

test "$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc "SELECT value FROM tennis.backup_restore_sentinel WHERE id = 1")" = "synthetic-only"
test "$(docker exec "$container" psql -U "$user" -d "$target_database" -Atc 'SELECT count(*) FROM public.tennis_schema_migrations')" -gt 0
if ALLOW_RESTORE=true TENNIS_POSTGRES_CONTAINER_NAME="$container" TENNIS_POSTGRES_USER="$user" \
  bash ./scripts/restore.sh "$backup" "$target_database" >/dev/null 2>&1; then
  printf 'Restore overwrote an existing target.\n' >&2; exit 1
fi
printf 'Tennis backup/restore verified with synthetic schema data only.\n'
