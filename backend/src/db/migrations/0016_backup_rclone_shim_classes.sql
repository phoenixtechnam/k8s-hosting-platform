-- R-X4 follow-up: extend backup_target_assignments to accept the
-- three shim-class routing keys.
--
-- The backup-rclone-shim is the universal mediator between every
-- platform backup callsite and its upstream storage. It exposes ONE
-- ClusterIP that serves THREE buckets ('system', 'tenant', 'mail') —
-- one per backup-class scope. Operators assign each shim class to a
-- backup_configurations row (S3 / SFTP / CIFS / NFS) by inserting
-- into backup_target_assignments.
--
-- The legacy snapshot_class values ('tenant_snapshot', 'tenant_bundle',
-- 'system_backup', 'system_mail') remain valid — existing per-class
-- snapshot/restore code paths continue to use them until R-X8 / R-X9
-- migrate every consumer to the 3-class model.
--
-- No DELETE / UPDATE of existing rows: this is a strictly additive
-- migration. Pre-existing assignments keep working; the shim simply
-- ignores them (it filters WHERE snapshot_class IN ('system','tenant','mail')).
--
-- Safety: PostgreSQL's CHECK constraint replacement is atomic when
-- wrapped in a single transaction; migrate.ts already wraps every
-- *.sql file in BEGIN/COMMIT.

ALTER TABLE "backup_target_assignments"
  DROP CONSTRAINT IF EXISTS "backup_target_assignments_snapshot_class_check";

ALTER TABLE "backup_target_assignments"
  ADD CONSTRAINT "backup_target_assignments_snapshot_class_check"
  CHECK ("snapshot_class" IN (
    'tenant_snapshot',
    'tenant_bundle',
    'system_backup',
    'system_mail',
    'system',
    'tenant',
    'mail'
  ));

-- storage_snapshots.snapshot_class also has a CHECK constraint. We
-- DON'T extend it here — only `backup_target_assignments` accepts the
-- new shim-routing keys. Stored snapshots will continue to carry the
-- granular legacy class values until R-X8/R-X9 migrate writers.
