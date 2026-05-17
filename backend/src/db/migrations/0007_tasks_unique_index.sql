-- Phase 10 of snapshot-storage overhaul: tasks UPSERT support.
--
-- The tasks.start() helper uses ON CONFLICT (kind, ref_id) DO UPDATE
-- for idempotency on retry paths (kind='backup.speedtest' + refId=
-- operationId is the canonical pattern; older mail + storage tasks
-- depend on the same shape).
--
-- Drizzle generates the ON CONFLICT clause without a WHERE qualifier,
-- so it cannot match a partial unique index. The original migration
-- 0090 (per the comments in tasks/service.ts) intended a partial
-- `WHERE ref_id IS NOT NULL` index, but that file isn't in the
-- migrations directory tracked here — clusters bootstrapped after
-- 0090 was renamed had no unique index at all, causing every UPSERT
-- to fail with "no unique or exclusion constraint matching the
-- ON CONFLICT specification".
--
-- A full unique index works fine: NULL values aren't considered
-- duplicates in Postgres unique indexes by default (NULL != NULL
-- in B-tree comparison), so the constraint is effectively partial
-- for the system-scope task rows that don't set ref_id.

CREATE UNIQUE INDEX IF NOT EXISTS tasks_kind_ref_id_unique
  ON tasks (kind, ref_id);
