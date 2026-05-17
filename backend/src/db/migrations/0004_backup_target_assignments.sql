-- Phase 2 of the snapshot-storage overhaul.
--
-- Introduces per-class target routing so the operator can send each
-- snapshot class to a different backup target (e.g. tenant_snapshot →
-- cheap CIFS; tenant_bundle → fast S3; system_etcd → separate bucket).
-- Replaces the single-active-target model used today, while keeping the
-- `backup_configurations.active` column as a deprecated no-op for one
-- release so rollback stays cheap.
--
-- Migration 0003 added `storage_snapshots.snapshot_class` as varchar
-- without a check constraint. This migration locks the value set via a
-- CHECK so existing rows stay legal and new code can rely on the
-- enumerated set.

-- ─── snapshot_class CHECK constraint ────────────────────────────────────

ALTER TABLE "storage_snapshots"
  ADD CONSTRAINT "storage_snapshots_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_snapshot',
    'system_etcd',
    'system_secrets'
  ));

-- ─── backup_target_assignments table ────────────────────────────────────
--
-- One row per (snapshot_class, target). Multiple targets per class are
-- allowed (priority ordering). The strict-primary resolver picks
-- ORDER BY priority ASC LIMIT 1 — failover requires manual operator
-- reassignment, per the locked decision.
--
-- ON DELETE RESTRICT on target_id: a target that is still routed-to
-- cannot be deleted; the operator must reassign the class first. This
-- preserves "where did snapshot X come from" forensics.

CREATE TABLE IF NOT EXISTS "backup_target_assignments" (
  "snapshot_class" VARCHAR(32) NOT NULL,
  "target_id" VARCHAR(36) NOT NULL REFERENCES "backup_configurations"("id") ON DELETE RESTRICT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("snapshot_class", "target_id"),
  CONSTRAINT "backup_target_assignments_snapshot_class_check"
    CHECK ("snapshot_class" IN (
      'tenant_snapshot',
      'tenant_bundle',
      'system_snapshot',
      'system_etcd',
      'system_secrets'
    )),
  CONSTRAINT "backup_target_assignments_priority_positive"
    CHECK ("priority" >= 0)
);

CREATE INDEX IF NOT EXISTS "backup_target_assignments_class_priority_idx"
  ON "backup_target_assignments" ("snapshot_class", "priority");

CREATE INDEX IF NOT EXISTS "backup_target_assignments_target_idx"
  ON "backup_target_assignments" ("target_id");

-- ─── Backfill: pre-existing active target gets all classes ──────────────
--
-- When an operator already had a single active backup_configurations
-- row, this seeds the new system with all 5 classes routed to it. The
-- behaviour is identical to the pre-Phase-2 single-target model — no
-- silent regression on upgrade.
--
-- When no active target exists, this is a no-op: the new install
-- starts with zero assignments and the resolver fails loud with a
-- clear "NO_SNAPSHOT_TARGET" error when any snapshot is attempted
-- (operator must explicitly configure assignments first). This matches
-- the locked "zero assignments + fail-loud" decision.

INSERT INTO "backup_target_assignments" ("snapshot_class", "target_id", "priority")
SELECT class_name, target.id, 100
  FROM (
    SELECT id FROM "backup_configurations" WHERE "active" = TRUE LIMIT 1
  ) AS target,
  unnest(ARRAY[
    'tenant_snapshot',
    'tenant_bundle',
    'system_snapshot',
    'system_etcd',
    'system_secrets'
  ]::VARCHAR(32)[]) AS class_name
ON CONFLICT ("snapshot_class", "target_id") DO NOTHING;

-- ─── storage_snapshots.target_id — forensic FK ──────────────────────────
--
-- ON DELETE SET NULL (not RESTRICT) so an operator who reassigns a
-- class and then deletes the now-unused target doesn't have to also
-- delete every historical snapshot row that pointed at it. The
-- target_id stays NULL post-delete but the row keeps its archive_path
-- for forensic lookup — restore-path errors can quote the original
-- target name from a separate audit log if needed.

ALTER TABLE "storage_snapshots"
  ADD COLUMN IF NOT EXISTS "target_id" VARCHAR(36)
    REFERENCES "backup_configurations"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "storage_snapshots_target_idx"
  ON "storage_snapshots" ("target_id");
