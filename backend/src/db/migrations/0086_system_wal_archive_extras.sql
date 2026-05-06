-- System Backup Phase 4b — extend WAL archive state with operator-
-- chosen base-backup cadence + archive_timeout. Both are nullable
-- so existing rows from migration 0085 remain valid:
--   archive_timeout NULL  → CNPG default (5min) applies
--   base_backup_schedule NULL → no ScheduledBackup CR created
ALTER TABLE system_wal_archive_state
  ADD COLUMN IF NOT EXISTS archive_timeout       VARCHAR(16),
  ADD COLUMN IF NOT EXISTS base_backup_schedule  VARCHAR(64),
  ADD COLUMN IF NOT EXISTS base_backup_retention_days INTEGER;

-- Sanity check on archive_timeout values — Postgres accepts duration
-- strings like '30s', '5min', '1h'. We restrict to a small enum at the
-- API layer; this CHECK is belt-and-braces so a direct UPDATE can't
-- break the cluster spec.
ALTER TABLE system_wal_archive_state
  DROP CONSTRAINT IF EXISTS system_wal_archive_state_archive_timeout_check;
ALTER TABLE system_wal_archive_state
  ADD CONSTRAINT system_wal_archive_state_archive_timeout_check
    CHECK (
      archive_timeout IS NULL
      OR archive_timeout ~ '^[0-9]+(s|min|h)$'
    );

-- Reasonable bound on base-backup retention — same shape as WAL retention.
ALTER TABLE system_wal_archive_state
  DROP CONSTRAINT IF EXISTS system_wal_archive_state_base_retention_check;
ALTER TABLE system_wal_archive_state
  ADD CONSTRAINT system_wal_archive_state_base_retention_check
    CHECK (
      base_backup_retention_days IS NULL
      OR base_backup_retention_days BETWEEN 1 AND 3650
    );
