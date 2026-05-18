-- Add the `system_mail` snapshot class + unify mail target binding.
--
-- Background:
--   Migration 0009 collapsed three system classes into a single
--   `system_backup`. That made etcd / secrets / longhorn / hostpath
--   route through one assignment but also pulled Stalwart's restic
--   snapshots into the same bucket. Operators may want mail to land
--   on a separate target (e.g. encrypted offsite vs. fast S3 for
--   everything else), so this migration adds `system_mail` as a peer
--   class to `system_backup` — both belong to the conceptual "system"
--   group but each gets its own row in `backup_target_assignments`.
--
--   No fallback semantics: `system_mail` is fail-loud the same way
--   every other class is — if it has no assignment, the mail-restic
--   sidecar exits with the existing skip log.
--
-- Steps:
--   1. Extend the CHECK constraints on `storage_snapshots` and
--      `backup_target_assignments` to allow `system_mail`.
--   2. Backfill any existing `system_settings.mail_snapshot_backup_store_id`
--      → `backup_target_assignments(system_mail, target_id, 0)` so
--      operators with a configured mail target keep working through
--      the rename. Idempotent: ON CONFLICT DO NOTHING + WHERE NOT EXISTS.

-- ─── CHECK constraints — add system_mail ────────────────────────────────

ALTER TABLE "storage_snapshots"
  DROP CONSTRAINT IF EXISTS "storage_snapshots_snapshot_class_check";

ALTER TABLE "storage_snapshots"
  ADD CONSTRAINT "storage_snapshots_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_backup',
    'system_mail'
  ));

ALTER TABLE "backup_target_assignments"
  DROP CONSTRAINT IF EXISTS "backup_target_assignments_snapshot_class_check";

ALTER TABLE "backup_target_assignments"
  ADD CONSTRAINT "backup_target_assignments_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_backup',
    'system_mail'
  ));

-- ─── Backfill ───────────────────────────────────────────────────────────
--
-- If an assignment already exists for system_mail, do nothing (operator
-- already picked their target via the new UI). Otherwise, if
-- mail_snapshot_backup_store_id is non-null + points at a still-existing
-- enabled backup_configurations row, insert it at priority 0.

INSERT INTO "backup_target_assignments" ("snapshot_class", "target_id", "priority")
SELECT
  'system_mail',
  s."mail_snapshot_backup_store_id",
  0
FROM "system_settings" s
INNER JOIN "backup_configurations" b
  ON b."id" = s."mail_snapshot_backup_store_id"
WHERE s."id" = 'system'
  AND s."mail_snapshot_backup_store_id" IS NOT NULL
  AND b."enabled" = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "backup_target_assignments" a
    WHERE a."snapshot_class" = 'system_mail'
  )
ON CONFLICT ("snapshot_class", "target_id") DO NOTHING;
