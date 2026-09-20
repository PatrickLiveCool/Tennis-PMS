#!/usr/bin/env bash
set -euo pipefail

compose_command=()
if [[ -n "${COMPOSE_BIN:-}" ]]; then
  [[ -x "$COMPOSE_BIN" ]] || { printf 'COMPOSE_BIN is not executable: %s\n' "$COMPOSE_BIN" >&2; exit 1; }
  compose_command=("$COMPOSE_BIN")
elif docker compose version >/dev/null 2>&1; then
  compose_command=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_command=(docker-compose)
else
  printf 'Docker Compose v2 is required.\n' >&2
  exit 1
fi

run_id="$$_$(date +%s)_${RANDOM}"
project="tennis-green-pms-verify-${run_id//_/-}"
app_port="${COMPOSE_VERIFY_APP_PORT:-$((43000 + RANDOM % 8000))}"
postgres_port="${COMPOSE_VERIFY_POSTGRES_PORT:-$((52000 + RANDOM % 8000))}"
postgres_container="${project}-postgres"
workdir="$(mktemp -d)"
started=false

compose() {
  "${compose_command[@]}" --env-file /dev/null --project-name "$project" --file compose.yaml "$@"
}
cleanup() {
  if [[ "$started" == true ]]; then
    compose down --volumes --remove-orphans --rmi local >/dev/null 2>&1 || true
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

export TENNIS_APP_HOST_PORT="$app_port"
export TENNIS_POSTGRES_HOST_PORT="$postgres_port"
export TENNIS_POSTGRES_CONTAINER_NAME="$postgres_container"
export TENNIS_APP_CONTAINER_NAME="${project}-app"
export TENNIS_ALLOW_SIMULATION=true
export TENNIS_POSTGRES_USER=tennis_dev
export TENNIS_POSTGRES_PASSWORD=tennis_synthetic_verification_only
export TENNIS_POSTGRES_DB=tennis_dev
export TENNIS_APP_BIND=127.0.0.1
export TENNIS_POSTGRES_BIND=127.0.0.1
export TENNIS_PAYMENT_SIGNING_KEY=tennis-synthetic-signing-key-for-verification
export TENNIS_AI_ENCRYPTION_KEY=

started=true
if ! compose up --build --detach --wait; then
  compose logs --no-color >&2 || true
  exit 1
fi

base_url="http://127.0.0.1:$app_port"
curl --fail --silent --show-error "$base_url/health" >/dev/null
curl --fail --silent --show-error "$base_url/" >/dev/null
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$base_url/api/tennis/session")" = 401
test "$(docker exec "$postgres_container" psql -U "${TENNIS_POSTGRES_USER:-tennis_dev}" -d "${TENNIS_POSTGRES_DB:-tennis_dev}" -Atc 'SELECT count(*) FROM public.tennis_schema_migrations')" -gt 0
printf 'Tennis Compose cold start verified on %s with isolated project %s.\n' "$base_url" "$project"
