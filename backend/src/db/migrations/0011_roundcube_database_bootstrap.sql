-- Phase 3 T4.4: bootstrap the Roundcube Postgres database + user via
-- the platform migration runner, so fresh deploys (and existing dev
-- volumes that predate scripts/postgres-initdb/01-roundcube-db.sh)
-- don't require a manual SQL step.
--
-- This migration creates the `roundcube` role and database idempotently.
-- The migrate runner tolerates the duplicate_database (42P04) and
-- duplicate_object (42710) error codes, so re-running is safe.
--
-- Operators must rotate the password after first deploy via
--   ALTER ROLE roundcube WITH PASSWORD '...'
-- and update the Roundcube Secret's ROUNDCUBEMAIL_DB_PASSWORD to match.

DO $bootstrap$
DECLARE
  role_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundcube')
    INTO role_exists;
  IF NOT role_exists THEN
    EXECUTE 'CREATE ROLE roundcube WITH LOGIN PASSWORD ''roundcube-local-dev-password''';
  END IF;
END
$bootstrap$;

-- CREATE DATABASE must run outside a transaction block. The migrate
-- runner commits after each top-level statement so this works. If the
-- database already exists the runner tolerates the 42P04 error code.
CREATE DATABASE roundcube OWNER roundcube;

GRANT ALL PRIVILEGES ON DATABASE roundcube TO roundcube;
