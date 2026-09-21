#!/usr/bin/env bash
# Sourced by verification only. Always owns a disposable container, never a live DB.
start_test_postgres() {
  container="tennis-green-pms-verify-$$_${RANDOM}"
  user=tennis_dev
  password=tennis_synthetic_verification_only
  database=tennis_test
  container_created=false
  docker run --rm --detach --name "$container" \
    --label tennis-green-pms.verification=true \
    --publish 127.0.0.1::5432 \
    --env POSTGRES_USER="$user" --env POSTGRES_PASSWORD="$password" --env POSTGRES_DB="$database" \
    "${TENNIS_VERIFY_POSTGRES_IMAGE:-docker.m.daocloud.io/library/postgres:16-alpine}" >/dev/null
  container_created=true
  host_port="$(docker port "$container" 5432/tcp | sed 's/.*://')"
  # shellcheck disable=SC2034 # Consumed by the verification script sourcing this helper.
  database_url="postgres://$user:$password@127.0.0.1:$host_port/$database"
  for _ in {1..60}; do
    if docker exec "$container" pg_isready -U "$user" -d "$database" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  printf 'Disposable Tennis PostgreSQL did not become ready.\n' >&2
  return 1
}

stop_test_postgres() {
  if [[ "${container_created:-false}" == true ]]; then
    docker rm --force --volumes "$container" >/dev/null
  fi
}
