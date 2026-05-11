-- 0095_deployment_upgrade_path.sql
-- Catalog upgrade path support — rollback data on deployments + per-app lock mode

-- Rollback data: previousVersion captures where we came from, set on upgrade,
-- cleared on rollback. Only the immediately preceding version is rollback-eligible.
ALTER TABLE deployments
  ADD COLUMN previous_version VARCHAR(50);

-- Per-deployment auto-upgrade opt-in. Daily cron picks up these when set,
-- but only acts on apps whose entry has version_lock_mode != 'strict'.
ALTER TABLE deployments
  ADD COLUMN auto_upgrade BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-app upgrade policy. Drives both the API guard (strict blocks
-- jumps not in upgradeFrom) and the auto-upgrade cron (strict apps skipped).
ALTER TABLE catalog_entries
  ADD COLUMN version_lock_mode VARCHAR(20) NOT NULL DEFAULT 'advisory'
  CHECK (version_lock_mode IN ('strict', 'advisory', 'open'));

-- Apps known to require one-major-at-a-time upgrades (Nextcloud occ:upgrade
-- is a known offender; Moodle's admin/cli/upgrade.php only handles N → N+1).
-- These match the post-analysis list documented in catalog/CATALOG_AUDIT.md.
UPDATE catalog_entries SET version_lock_mode = 'strict'
  WHERE code IN ('nextcloud', 'moodle-bitnami', 'wordpress', 'immich', 'bookstack');

-- Stateless infra: no schema, no migration, safe to bump at will.
UPDATE catalog_entries SET version_lock_mode = 'open'
  WHERE type IN ('runtime', 'database', 'service', 'static')
     OR code IN ('coturn', 'static-nginx', 'static-apache');

-- Note: databases land in 'open' above by type, but the platform should
-- still prevent major-version upgrades on databases (postgres 17→18 needs
-- pg_upgrade). The guard against DB upgrades belongs in a separate
-- DB-specific check, not version_lock_mode.

-- Index for the cron query: WHERE auto_upgrade=true AND status='running'
CREATE INDEX IF NOT EXISTS deployments_auto_upgrade_idx
  ON deployments (auto_upgrade, status)
  WHERE auto_upgrade = TRUE;
