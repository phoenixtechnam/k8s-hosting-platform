-- 0091_tasks_drop_partial_predicate.sql
--
-- The unique index `tasks_kind_ref_unique` was created with a partial
-- predicate `WHERE ref_id IS NOT NULL`. Postgres requires the
-- ON CONFLICT target to match a NON-partial unique constraint or be
-- annotated with the same predicate. Drizzle's
-- `onConflictDoUpdate({ target: [tasks.kind, tasks.refId] })` emits a
-- bare `ON CONFLICT ("kind","ref_id")` and trips SQLSTATE 42P10
-- ("there is no unique or exclusion constraint matching the ON CONFLICT
-- specification").
--
-- Fix: drop the partial predicate. The semantics are unchanged because
-- (kind, NULL) rows are still allowed any number of times — Postgres
-- treats NULL as not-equal-to-NULL inside a unique index, so multiple
-- ref_id IS NULL rows for the same kind are still permitted.

DROP INDEX IF EXISTS tasks_kind_ref_unique;
CREATE UNIQUE INDEX tasks_kind_ref_unique ON tasks (kind, ref_id);
