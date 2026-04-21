#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

cd "$BACKEND_DIR"

# Start test database
log "Starting test PostgreSQL..."
docker compose -f docker-compose.test.yml up -d

# Wait for PostgreSQL to be healthy
log "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.test.yml exec postgres-test pg_isready -U platform -d hosting_platform_test 2>/dev/null; then
    log "PostgreSQL is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "ERROR: PostgreSQL did not become ready in time"
    docker compose -f docker-compose.test.yml logs
    docker compose -f docker-compose.test.yml down
    exit 1
  fi
  sleep 2
done

# Run migrations
# Resolve the Postgres host — when running inside a DinD container the
# docker daemon is on a separate host (DOCKER_HOST=tcp://dind:2375), so
# `localhost:5433` doesn't reach the port mapping; use `dind` in that
# case. Default to localhost for plain-docker environments.
log "Running migrations..."
if [ -n "${DOCKER_HOST:-}" ] && [[ "$DOCKER_HOST" == tcp://dind:* ]]; then
  PG_HOST="dind"
else
  PG_HOST="${PG_HOST:-localhost}"
fi
export DATABASE_URL="postgresql://platform:platform@${PG_HOST}:5433/hosting_platform_test"
export JWT_SECRET="test-secret-key-for-testing-only"
export NODE_ENV="test"
npx tsx src/db/migrate.ts || log "Warning: Migration runner failed (tables may already exist)"

# Run integration tests
log "Running integration tests..."
TEST_EXIT=0
npx vitest run --config vitest.config.integration.ts || TEST_EXIT=$?

# Tear down
log "Tearing down test database..."
docker compose -f docker-compose.test.yml down

exit $TEST_EXIT
