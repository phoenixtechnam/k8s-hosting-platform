-- Phase 1 of the snapshot-storage overhaul (ADR pending).
--
-- Adds accountability columns so every snapshot row is attributable to
-- a subsystem and a logical class. Phase 2 will add a per-class target
-- assignment table; this migration only extends existing tables so the
-- admin UI can surface "who wrote how much, when" while no behaviour
-- changes yet.
--
-- snapshot_class is intentionally a free-form varchar in this phase —
-- the enum is locked in migration 0004 alongside backup_target_assignments
-- so we don't have to coordinate two type changes inside one migration.
-- All existing rows are tenant PVC snapshots (the only writer today),
-- so the backfill is unambiguous.

ALTER TABLE "storage_snapshots"
  ADD COLUMN IF NOT EXISTS "subsystem" VARCHAR(64) NOT NULL DEFAULT 'tenant-pvc',
  ADD COLUMN IF NOT EXISTS "snapshot_class" VARCHAR(32) NOT NULL DEFAULT 'tenant_snapshot';

-- Backfill is the default above; explicit UPDATE belt-and-braces so a
-- pre-existing column with a different default still ends up consistent.
UPDATE "storage_snapshots"
   SET "subsystem" = 'tenant-pvc'
 WHERE "subsystem" IS NULL OR "subsystem" = '';

UPDATE "storage_snapshots"
   SET "snapshot_class" = 'tenant_snapshot'
 WHERE "snapshot_class" IS NULL OR "snapshot_class" = '';

-- bytes_transferred lets the admin UI show live throughput on a long-
-- running snapshot/restore Job (rclone JSON log parse will populate it
-- in Phase 4). numeric(20,0) matches storage_snapshots.size_bytes so
-- the two are directly comparable at the API layer.
ALTER TABLE "storage_operations"
  ADD COLUMN IF NOT EXISTS "bytes_transferred" NUMERIC(20, 0) NOT NULL DEFAULT 0;

-- Indexes that the snapshot-accounting endpoint will scan. Per-class
-- aggregation is the hot read path; tenant-scoped aggregation is the
-- per-tenant detail page.
CREATE INDEX IF NOT EXISTS "storage_snapshots_class_idx"
  ON "storage_snapshots" ("snapshot_class");

CREATE INDEX IF NOT EXISTS "storage_snapshots_subsystem_idx"
  ON "storage_snapshots" ("subsystem");
