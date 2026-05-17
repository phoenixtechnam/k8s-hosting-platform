-- Phase 6 of the snapshot-storage overhaul: per-tenant snapshot quotas.
--
-- Mirrors the existing tenant-bundle quota columns (max_backup_size_bytes,
-- max_backups, max_backup_retention_days). The snapshot orchestrator
-- consults these at /storage/snapshot entry time and refuses creation
-- with STORAGE_QUOTA_EXCEEDED if the tenant is over its plan cap.
--
-- Defaults:
--   max_snapshot_size_bytes  = 50 GiB    (53687091200)
--   max_snapshot_count       = 10        snapshots per tenant
--   max_snapshot_retention_days = 90     mirrors max_backup_retention_days
--
-- These are per-tenant plan caps. System snapshots have a separate
-- platform-wide cap configured in platform_settings (storage.system_snapshot.max_bytes).

ALTER TABLE "hosting_plans"
  ADD COLUMN IF NOT EXISTS "max_snapshot_size_bytes" BIGINT NOT NULL DEFAULT 53687091200,
  ADD COLUMN IF NOT EXISTS "max_snapshot_count" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "max_snapshot_retention_days" INTEGER NOT NULL DEFAULT 90;
