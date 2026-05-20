-- migration 0015 — NFS as a first-class backup target type.
--
-- Path D-final (BACKUP_ARCHITECTURE_RFC §13a-ii) makes S3, SFTP, CIFS,
-- and NFS uniformly supported via the backup-rclone-shim DaemonSet.
-- The schema already has columns for S3, SSH (≈SFTP), CIFS — we add
-- NFS columns + extend the storage_type enum.
--
-- No data backfill required: existing rows have storage_type IN
-- ('s3', 'ssh', 'cifs') and the new 'nfs' value is purely additive.

-- Add 'nfs' to the storage_type enum. Quoted identifier matches the
-- pattern used by earlier migrations (e.g. 0006) so the SQL form is
-- uniform across the migrations directory.
ALTER TYPE "storage_type" ADD VALUE IF NOT EXISTS 'nfs';

-- Add NFS columns. All nullable; CHECK constraint enforces presence
-- only when storage_type='nfs' (added after the columns exist).
ALTER TABLE backup_configurations
  ADD COLUMN IF NOT EXISTS nfs_server VARCHAR(255),
  ADD COLUMN IF NOT EXISTS nfs_export VARCHAR(500),
  ADD COLUMN IF NOT EXISTS nfs_version VARCHAR(16) DEFAULT '4.2',
  ADD COLUMN IF NOT EXISTS nfs_options VARCHAR(255);

-- Enforce that NFS targets have a server + export. Using NOT VALID so
-- existing non-NFS rows aren't re-checked (none have these columns
-- populated anyway).
ALTER TABLE backup_configurations
  ADD CONSTRAINT backup_configurations_nfs_required CHECK (
    storage_type <> 'nfs' OR (nfs_server IS NOT NULL AND nfs_export IS NOT NULL)
  ) NOT VALID;
