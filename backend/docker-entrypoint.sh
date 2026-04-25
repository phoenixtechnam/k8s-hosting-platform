#!/bin/sh
set -eu

# Resolve postgres host from DATABASE_URL or fall back to the conventional
# in-cluster Service DNS name. We only do a TCP/DNS gate — actual auth
# failures will surface from the migrate step itself.
PG_HOST="${PG_HOST:-postgres.platform.svc.cluster.local}"
PG_PORT="${PG_PORT:-5432}"
PG_WAIT_SECONDS="${PG_WAIT_SECONDS:-120}"

echo "Waiting for postgres at ${PG_HOST}:${PG_PORT} (max ${PG_WAIT_SECONDS}s)..."
i=0
while [ "$i" -lt "$PG_WAIT_SECONDS" ]; do
  # busybox nc accepts -z for zero-IO scan; coreutils nc accepts the same.
  # Fall back to /dev/tcp via bash if nc is missing — but the slim image
  # ships busybox, so nc is always there.
  if nc -z -w 2 "$PG_HOST" "$PG_PORT" >/dev/null 2>&1; then
    echo "  postgres reachable after ${i}s"
    break
  fi
  i=$((i + 2))
  sleep 2
done
if [ "$i" -ge "$PG_WAIT_SECONDS" ]; then
  echo "ERROR: postgres at ${PG_HOST}:${PG_PORT} did not become reachable within ${PG_WAIT_SECONDS}s." >&2
  exit 1
fi

# Migrate. Hard-fail on errors — silently swallowing them was the source
# of the 2026-04-25 staging incident where every backend table was
# missing because postgres DNS lookup raced and migrate exit was masked.
echo "Running database migrations..."
node dist/db/migrate.js

# Seed is allowed to fail (idempotency: re-runs hit unique constraints).
echo "Running database seed..."
node dist/db/seed.js 2>&1 || echo "Seed reported failure (likely already applied) — continuing"

echo "Starting main server..."
exec node dist/server.js
