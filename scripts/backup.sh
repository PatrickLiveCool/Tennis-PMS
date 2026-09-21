#!/usr/bin/env bash
set -euo pipefail
umask 077

container="${TENNIS_POSTGRES_CONTAINER_NAME:-tennis-green-pms-postgres}"
database="${TENNIS_POSTGRES_DB:-tennis_dev}"
user="${TENNIS_POSTGRES_USER:-tennis_dev}"
timestamp="$(date +%Y%m%d-%H%M%S)"
output="${1:-backups/${database}-${timestamp}.dump}"
temporary=""
trap 'if [[ -n "$temporary" ]]; then rm -f -- "$temporary"; fi' EXIT

mkdir -p "$(dirname "$output")"
temporary="$(mktemp "${output}.tmp.XXXXXX")"
docker exec "$container" pg_dump -U "$user" -Fc "$database" > "$temporary"
test -s "$temporary"
chmod 600 "$temporary"
mv -- "$temporary" "$output"
temporary=""
chmod 600 "$output"
printf 'Tennis backup written: %s\n' "$output"
