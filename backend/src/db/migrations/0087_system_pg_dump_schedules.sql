-- System Backup Phase 4b — pg_dump scheduled exports.
-- One row per (ns, cluster, db) tuple — we don't allow multiple
-- schedules for the same DB (would just be redundant runs).
CREATE TABLE IF NOT EXISTS system_pg_dump_schedules (
  id                VARCHAR(36) PRIMARY KEY,
  source_namespace  VARCHAR(63) NOT NULL,
  source_cluster    VARCHAR(63) NOT NULL,
  source_database   VARCHAR(63) NOT NULL,
  target_config_id  VARCHAR(36) NOT NULL,
  cron_schedule     VARCHAR(64) NOT NULL,
  retention_days    INTEGER     NOT NULL DEFAULT 30,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  last_run_at       TIMESTAMPTZ,
  last_run_id       VARCHAR(36),
  next_run_at       TIMESTAMPTZ,
  operator_user_id  VARCHAR(36),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT system_pg_dump_schedules_unique_target
    UNIQUE (source_namespace, source_cluster, source_database)
);

-- Tick query reads `enabled=true AND next_run_at < now()` — keep the
-- index narrow.
CREATE INDEX IF NOT EXISTS system_pg_dump_schedules_due_idx
  ON system_pg_dump_schedules(next_run_at)
  WHERE enabled = TRUE;
