-- Migration 0100: mail snapshot settings in system_settings
--
-- mail_snapshot_schedule:
--   Cron expression override for the stalwart-snapshot CronJob.
--   When non-null, the backend patches spec.schedule on GET/PATCH.
--   When null, the CronJob's own spec.schedule is canonical (*/2 * * * *).
--
-- mail_snapshot_backup_store_id:
--   FK to backup_configurations.id (nullable, no strict FK to avoid
--   cascade surprises). When set, the backend creates the
--   stalwart-snapshot-restic-repo Secret in the mail namespace so the
--   upload sidecar can run restic backup.
--
-- mail_snapshot_last_run_stats:
--   JSON written by the snapshot-upload sidecar after each successful
--   restic run: { totalSnapshotSizeBytes, snapshotCount, runAt }.
--   Used by GET /admin/mail/snapshot-status to populate totalSnapshotSizeBytes.

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS mail_snapshot_schedule VARCHAR(100),
  ADD COLUMN IF NOT EXISTS mail_snapshot_backup_store_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS mail_snapshot_last_run_stats JSONB;
