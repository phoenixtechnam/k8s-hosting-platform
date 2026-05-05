-- Add 'pre-restore' to storage_snapshot_kind so the tenant-backup-restore
-- cart can write a pre-restore safety snapshot before any destructive
-- restore item executes.
--
-- ADR-034 §2 — single pre-restore snapshot per cart, written on first
-- MUTATING item, retention 7 days, recorded on restore_jobs.pre_restore_snapshot_id.
ALTER TYPE storage_snapshot_kind ADD VALUE IF NOT EXISTS 'pre-restore';
