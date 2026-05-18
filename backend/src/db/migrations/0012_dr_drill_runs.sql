-- DR-bundle roadmap Phase 1 — dr_drill_runs.
--
-- One row per DR drill execution. Posted by CI (GitHub Actions) via
-- POST /admin/system-backup/dr-drill/runs (super_admin service token).
-- Read by the admin DR Drill tab via GET /admin/system-backup/dr-drill/runs.
--
-- Index on started_at DESC so the UI's "last 12 runs" query is a
-- single index scan. No tenantId — DR drills are cluster-scoped.
CREATE TABLE IF NOT EXISTS dr_drill_runs (
  id                       VARCHAR(36) PRIMARY KEY,
  started_at               TIMESTAMPTZ NOT NULL,
  finished_at              TIMESTAMPTZ,
  status                   VARCHAR(16) NOT NULL,    -- running|success|failed|cancelled
  trigger                  VARCHAR(32) NOT NULL,    -- cron|workflow_dispatch|manual|meta_test
  source_bundle_sha256     VARCHAR(64),
  secrets_restored_count   INTEGER,
  bundle_size_bytes        BIGINT,
  duration_seconds         INTEGER,
  failure_reason           VARCHAR(500),
  report                   JSONB,                   -- structured phase + smoke-assertion results
  runner                   VARCHAR(200) NOT NULL,   -- e.g. github-actions/dr-drill@01HXYZ
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dr_drill_runs_started_at_idx
  ON dr_drill_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS dr_drill_runs_status_idx
  ON dr_drill_runs (status);
