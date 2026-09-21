#!/usr/bin/env bash
set -euo pipefail

source ./scripts/verify-tennis-postgres.sh
port="${TENNIS_COLD_START_PORT:-$((42000 + RANDOM % 10000))}"
workdir="$(mktemp -d)"
app_log="$workdir/app.log"
app_pid=""

cleanup() {
  if [[ -n "$app_pid" ]]; then
    kill "$app_pid" >/dev/null 2>&1 || true
    wait "$app_pid" >/dev/null 2>&1 || true
  fi
  stop_test_postgres
  rm -rf -- "$workdir"
}
trap cleanup EXIT

start_test_postgres
# Starting on an empty database must fail without creating migration history.
if TENNIS_DATABASE_URL="$database_url" TENNIS_ALLOW_NONLOCAL_DATABASE=true \
  NODE_ENV=development TENNIS_ALLOW_SIMULATION=true \
  TENNIS_PAYMENT_SIGNING_KEY=tennis-synthetic-signing-key-for-verification \
  node --import tsx scripts/tennis/server-entry.mts >"$app_log" 2>&1; then
  printf 'Runtime unexpectedly accepted an unmigrated database.\n' >&2
  exit 1
fi
test -z "$(docker exec "$container" psql -U "$user" -d "$database" -Atc "SELECT to_regclass('public.tennis_schema_migrations')")"
TENNIS_DATABASE_URL="$database_url" TENNIS_ALLOW_NONLOCAL_DATABASE=true npm run tennis:db:migrate >/dev/null

TENNIS_DATABASE_URL="$database_url" \
NODE_ENV=development \
TENNIS_ALLOW_SIMULATION=true \
TENNIS_ALLOW_NONLOCAL_DATABASE=true \
TENNIS_HTTP_HOST=127.0.0.1 \
TENNIS_HTTP_PORT="$port" \
TENNIS_WEB_ORIGINS="http://127.0.0.1:$port" \
TENNIS_PAYMENT_SIGNING_KEY=tennis-synthetic-signing-key-for-verification \
node --import tsx scripts/tennis/server-entry.mts >"$app_log" 2>&1 &
app_pid="$!"

ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != "true" ]]; then
  sed -n '1,200p' "$app_log" >&2
  printf 'Tennis cold-start API did not become ready on port %s.\n' "$port" >&2
  exit 1
fi

curl --fail --silent --show-error "http://127.0.0.1:$port/health" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$port/" >"$workdir/index.html"
grep -q 'type="module"' "$workdir/index.html"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$port/api/tennis/session")" = 401
test "$(docker exec "$container" psql -U "$user" -d "$database" -Atc 'SELECT count(*) FROM public.tennis_schema_migrations')" -gt 0
printf 'Tennis cold start verified: read-only runtime, explicit test migration, public UI, protected API and health.\n'
