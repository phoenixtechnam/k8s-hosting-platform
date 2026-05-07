-- 0090_tasks.sql — Top-bar Task Tracker (Phase 1)
--
-- Canonical UI-projection table for long-running operations the user can
-- see in the top-bar chip. Per-module tables (client_lifecycle_transitions,
-- storage_operations, system_backup_runs, postgres_pitr_lock, …) remain
-- the source of truth for the operation itself; this table carries just
-- enough metadata to render the chip and route the click action to the
-- right modal/page.
--
-- Helper module (backend/src/modules/tasks/) owns ALL writes via
-- start/progress/finish — surfaces never INSERT/UPDATE this table directly.
-- Idempotent on (kind, ref_id) so retried task.start() returns the same row.
--
-- Visibility (RBAC enforced in the API layer):
--   * scope='admin'  + user_id IS NOT NULL  → visible to that admin
--   * scope='client' + user_id IS NOT NULL  → visible to that client user
--   * scope='system' + user_id IS NULL      → never appears in any chip;
--                                              failures land in notifications
--                                              instead (per UX agreement).
--
-- Retention: a cron in the helper deletes terminal rows older than 7 days
-- and reaps orphan running rows older than 24h (status → 'failed').

CREATE TABLE tasks (
  id              VARCHAR(36) PRIMARY KEY,
  kind            VARCHAR(64) NOT NULL,
  ref_id          VARCHAR(64),
  scope           VARCHAR(16) NOT NULL,
  user_id         VARCHAR(36),
  client_id       VARCHAR(36),
  label           TEXT NOT NULL,
  status          VARCHAR(16) NOT NULL,
  progress_pct    SMALLINT,
  progress_text   TEXT,
  target          JSONB NOT NULL,
  error_message   TEXT,
  details         JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  cleared_at      TIMESTAMPTZ,
  parent_task_id  VARCHAR(36) REFERENCES tasks(id) ON DELETE CASCADE,

  CONSTRAINT tasks_scope_chk
    CHECK (scope IN ('admin','client','system')),
  CONSTRAINT tasks_status_chk
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT tasks_progress_chk
    CHECK (progress_pct IS NULL OR (progress_pct >= 0 AND progress_pct <= 100)),
  CONSTRAINT tasks_terminal_chk
    CHECK (
      (status IN ('succeeded','failed','cancelled') AND finished_at IS NOT NULL)
      OR
      (status IN ('queued','running') AND finished_at IS NULL)
    ),
  CONSTRAINT tasks_system_user_null_chk
    CHECK (NOT (scope = 'system' AND user_id IS NOT NULL))
);

-- Idempotency: surfaces pass ref_id = the underlying row's natural id.
-- ON CONFLICT (kind, ref_id) DO UPDATE makes tasks.start() safe to retry.
-- Partial index — ref_id may be NULL for one-off ad-hoc tasks where there
-- is no natural underlying row.
CREATE UNIQUE INDEX tasks_kind_ref_unique
  ON tasks(kind, ref_id) WHERE ref_id IS NOT NULL;

-- Hot path: chip query "what's running for me?" — partial index keeps it tiny.
CREATE INDEX tasks_running_by_user
  ON tasks(user_id, updated_at DESC)
  WHERE status IN ('queued','running');

-- "Recently completed for me" (5-min window for the chip + 7-day retention).
CREATE INDEX tasks_recent_by_user
  ON tasks(user_id, finished_at DESC)
  WHERE finished_at IS NOT NULL AND cleared_at IS NULL;

-- Tenant-scope filter for the client panel chip.
CREATE INDEX tasks_client_scope
  ON tasks(client_id, updated_at DESC)
  WHERE client_id IS NOT NULL;

-- parent_task_id for fan-out (bulk → per-tenant children).
CREATE INDEX tasks_parent_idx
  ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

-- pg_notify channel `tasks_user_<user_id>` carries small JSON deltas.
-- The trigger fires on INSERT and on every UPDATE (status / progress /
-- cleared_at). Payload includes id + status + updated_at so the SSE
-- consumer can decide whether to refetch full row state. user_id may be
-- NULL on system-scope rows; we still emit on a global `tasks_system`
-- channel for ops dashboards even though no per-user chip subscribes.
CREATE OR REPLACE FUNCTION tasks_notify() RETURNS TRIGGER AS $$
DECLARE
  channel TEXT;
  payload JSONB;
BEGIN
  payload := jsonb_build_object(
    'id', NEW.id,
    'kind', NEW.kind,
    'status', NEW.status,
    'progress_pct', NEW.progress_pct,
    'updated_at', NEW.updated_at,
    'finished_at', NEW.finished_at
  );
  IF NEW.user_id IS NOT NULL THEN
    channel := 'tasks_user_' || NEW.user_id;
  ELSE
    channel := 'tasks_system';
  END IF;
  -- pg_notify payload limit is ~8000 bytes; our jsonb_build_object output
  -- is well under that for any plausible row.
  PERFORM pg_notify(channel, payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_notify_trigger
  AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_notify();

COMMENT ON TABLE tasks IS 'UI-projection of long-running operations for the top-bar Task Tracker. Source of truth lives in per-module tables; this row carries just enough to render the chip and route the click. Helper-only writes - see backend/src/modules/tasks/.';
