-- System Backup Phase 2 hardening (post-review).
--
-- 1. Per-kind NOT NULL CHECK so a kind='pg_dump' row without source
--    identity is rejected at the storage layer (defence-in-depth — the
--    application code already fills these, but a future code path or
--    direct SQL UPDATE could violate the invariant). DB review H1.
-- 2. Replace the partial index from 0083 with a CONCURRENTLY-built
--    version using the optimal column order. The original is fine for
--    correctness but takes ShareLock during build (DB review M1) and
--    has a redundant leading column (DB review L1).

-- Tighten kind='pg_dump' to require source identity + target.
-- 'secrets' rows (Phase 1) are unaffected.
ALTER TABLE system_backup_runs
  DROP CONSTRAINT IF EXISTS system_backup_runs_pg_dump_required_check;
ALTER TABLE system_backup_runs
  ADD CONSTRAINT system_backup_runs_pg_dump_required_check
    CHECK (
      kind <> 'pg_dump' OR (
        source_namespace IS NOT NULL
        AND source_cluster   IS NOT NULL
        AND source_database  IS NOT NULL
        AND target_config_id IS NOT NULL
      )
    );

-- Replace 0083's index. The leading `kind` column is redundant when
-- the partial predicate already pins kind='pg_dump'. Reorder to
-- (source_namespace, source_cluster, created_at DESC) and rebuild
-- CONCURRENTLY so we don't hold ShareLock during the rebuild.
--
-- IF NOT EXISTS guards both halves so reruns are safe. CONCURRENTLY
-- cannot run inside an explicit transaction; the migration runner
-- (backend/src/db/migrate.ts:113) executes each statement separately
-- with no surrounding BEGIN/COMMIT, so this works as written.
CREATE INDEX CONCURRENTLY IF NOT EXISTS system_backup_runs_pg_dump_source_idx
  ON system_backup_runs(source_namespace, source_cluster, created_at DESC)
  WHERE kind = 'pg_dump';

DROP INDEX IF EXISTS system_backup_runs_source_cluster_idx;
