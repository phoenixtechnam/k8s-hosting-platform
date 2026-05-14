#!/bin/sh
# Postgres initdb script — creates the Roundcube session/auxiliary
# database on first postgres init.
#
# Phase 3.A.5: Roundcube was previously using SQLite on a RWO PVC
# which caused hard downtime on every rolling deploy. We now use the
# platform Postgres instance for Roundcube's own state
# (sessions, cache, identities, contacts, searches), while mail itself
# still lives in Stalwart.
#
# Runs only once on first postgres container start (standard initdb.d
# behavior). Safe to re-run manually via psql with appropriate
# IF NOT EXISTS guards.
#
# For production: duplicate this SQL into a migration or manual
# bootstrap step. See docs/04-deployment/MAIL_SERVER_OPERATIONS.md.

set -eu

ROUNDCUBE_DB="${ROUNDCUBE_DB_NAME:-roundcube}"
ROUNDCUBE_USER="${ROUNDCUBE_DB_USER:-roundcube}"
ROUNDCUBE_PASSWORD="${ROUNDCUBE_DB_PASSWORD:-roundcube-local-dev-password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROUNDCUBE_USER') THEN
    CREATE ROLE $ROUNDCUBE_USER WITH LOGIN PASSWORD '$ROUNDCUBE_PASSWORD';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE $ROUNDCUBE_DB OWNER $ROUNDCUBE_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$ROUNDCUBE_DB')\gexec

GRANT ALL PRIVILEGES ON DATABASE $ROUNDCUBE_DB TO $ROUNDCUBE_USER;
SQL

echo "[initdb] Roundcube database '$ROUNDCUBE_DB' ready (user: $ROUNDCUBE_USER)"
