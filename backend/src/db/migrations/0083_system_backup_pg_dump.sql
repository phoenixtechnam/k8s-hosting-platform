-- System Backup Phase 2 — pg_dump support.
--
-- Extends system_backup_runs (introduced for secrets-bundle exports
-- in 0081) to track per-CNPG-cluster pg_dump runs as well. Same row
-- shape, different `kind` value + extra source-cluster identity
-- columns. The dump itself does NOT live in the `payload` BYTEA
-- (multi-GB would blow the row); it streams to the operator's chosen
-- off-site BackupStore (S3 or SSH/SFTP) and the row stores a handle
-- pointing at the artifact.

ALTER TABLE system_backup_runs
  DROP CONSTRAINT IF EXISTS system_backup_runs_kind_check;
ALTER TABLE system_backup_runs
  ADD CONSTRAINT system_backup_runs_kind_check
    CHECK (kind IN ('secrets', 'pg_dump'));

ALTER TABLE system_backup_runs
  ADD COLUMN IF NOT EXISTS source_namespace VARCHAR(63),
  ADD COLUMN IF NOT EXISTS source_cluster   VARCHAR(63),
  ADD COLUMN IF NOT EXISTS source_database  VARCHAR(63);

ALTER TABLE system_backup_runs
  ADD COLUMN IF NOT EXISTS target_config_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS bundle_id        VARCHAR(64),
  ADD COLUMN IF NOT EXISTS artifact_name    VARCHAR(255);

ALTER TABLE system_backup_runs
  ADD COLUMN IF NOT EXISTS job_name VARCHAR(63);

CREATE INDEX IF NOT EXISTS system_backup_runs_source_cluster_idx
  ON system_backup_runs(kind, source_namespace, source_cluster, created_at DESC)
  WHERE kind = 'pg_dump';
