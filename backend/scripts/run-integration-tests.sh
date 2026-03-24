#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

cd "$BACKEND_DIR"

# Start test database
log "Starting test MariaDB..."
docker compose -f docker-compose.test.yml up -d

# Wait for MariaDB to be healthy
log "Waiting for MariaDB to be ready..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.test.yml exec mariadb-test healthcheck.sh --connect --innodb_initialized 2>/dev/null; then
    log "MariaDB is ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "ERROR: MariaDB did not become ready in time"
    docker compose -f docker-compose.test.yml logs
    docker compose -f docker-compose.test.yml down
    exit 1
  fi
  sleep 2
done

# Run migrations
log "Running migrations..."
export DATABASE_URL="mysql://platform:platform@localhost:3307/hosting_platform_test"
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
