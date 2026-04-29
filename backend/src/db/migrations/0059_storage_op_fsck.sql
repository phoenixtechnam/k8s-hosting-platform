-- Add 'fsck' to the storage_operation_type enum so the
-- storage-lifecycle service can record filesystem-check / repair
-- operations alongside snapshot/resize/etc.
--
-- Postgres ALTER TYPE ADD VALUE is non-transactional so it must run
-- in its own statement. IF NOT EXISTS guards re-runs on partial
-- migrations.

ALTER TYPE storage_operation_type ADD VALUE IF NOT EXISTS 'fsck';
