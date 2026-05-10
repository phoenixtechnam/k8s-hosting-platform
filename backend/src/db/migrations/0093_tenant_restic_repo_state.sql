-- Phase 1 of tenant-backup-v2 (ADR-036): per-tenant restic repository
-- state and per-mailbox JMAP state.
--
-- One row per (clientId, component) for restic. Tracks last successful
-- snapshot id + repo URI so the orchestrator and retention sweeper can
-- act on the right per-tenant repo without re-deriving every time.
--
-- Per-mailbox JMAP state lives in its own table because Stalwart issues
-- per-mailbox state tokens and we want fine-grained restart semantics:
-- a single mailbox's state-token miss falls back to a full re-pull for
-- that mailbox, not the whole tenant.
--
-- Both tables CASCADE on client deletion so a tenant offboard cleans
-- the rows the same way it cleans backup_jobs.

CREATE TABLE IF NOT EXISTS tenant_restic_repo_state (
  client_id            VARCHAR(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  -- Component name matching backup_components.component. Today only
  -- 'files' and 'mailboxes' use restic; 'config' / 'secrets' are full
  -- each run and don't need state.
  component            VARCHAR(32) NOT NULL,
  -- The full restic repo URI as passed to `restic --repo`. Includes the
  -- backend type prefix (`s3:...`, `sftp:...`, or absolute path for
  -- hostpath). Stored verbatim so the retention sweeper can spawn restic
  -- without re-resolving the BackupConfiguration.
  repo_uri             VARCHAR(2000) NOT NULL,
  -- Backup target id (FK to backup_configurations) — required so we can
  -- decrypt the right credential blob when invoking restic later. NULL
  -- only during transient migration of a row created before the
  -- BackupConfiguration was set.
  target_config_id     VARCHAR(36)
    REFERENCES backup_configurations(id) ON DELETE SET NULL,
  -- Most recent snapshot id from `restic backup` for this (client,
  -- component). 8-char short ids are common in restic UIs but the full
  -- 64-char id is canonical; we store the full id.
  last_snapshot_id     VARCHAR(64),
  -- The bundle that produced last_snapshot_id, so the orchestrator can
  -- attribute the snapshot when the operator browses bundle history.
  last_backup_job_id   VARCHAR(64)
    REFERENCES backup_jobs(id) ON DELETE SET NULL,
  -- Last `restic stats --mode raw-data` total_size for this repo.
  -- Updated after each successful snapshot. Used by the admin UI for
  -- per-tenant storage cost.
  last_repo_size_bytes BIGINT NOT NULL DEFAULT 0,
  -- Wall-clock of the last successful snapshot. Distinct from
  -- last_run_at — if a snapshot fails mid-stream, last_run_at advances
  -- but last_snapshot_at does not.
  last_snapshot_at     TIMESTAMPTZ,
  last_run_at          TIMESTAMPTZ,
  -- Last `restic check` outcome — populated by the weekly check cron.
  -- 'ok' / 'error' / NULL (never checked).
  last_check_status    VARCHAR(32),
  last_check_at        TIMESTAMPTZ,
  last_check_error     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, component)
);

CREATE INDEX IF NOT EXISTS tenant_restic_repo_state_target_idx
  ON tenant_restic_repo_state (target_config_id);

CREATE INDEX IF NOT EXISTS tenant_restic_repo_state_check_idx
  ON tenant_restic_repo_state (last_check_status, last_check_at)
  WHERE last_check_status IS DISTINCT FROM 'ok';


CREATE TABLE IF NOT EXISTS tenant_jmap_state (
  client_id            VARCHAR(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  -- Mailbox principal id from Stalwart (JMAP `Account` id). Uniquely
  -- identifies a mailbox across the platform.
  mailbox_jmap_id      VARCHAR(255) NOT NULL,
  -- Human-readable email address of the mailbox. Cached here so admin UI
  -- can render restore lists without re-querying Stalwart.
  mailbox_address      VARCHAR(255) NOT NULL,
  -- The opaque state token last returned by Stalwart's `Email/changes`
  -- for this mailbox. NULL means "no prior state — do a full pull".
  -- Persisted ONLY after restic snapshot acks the corresponding
  -- backup. At-least-once semantics.
  last_jmap_state      TEXT,
  -- Last successful sync wall-clock — for admin "stale mailbox" alerts.
  last_synced_at       TIMESTAMPTZ,
  -- Last error from `Email/changes` (e.g. `cannotCalculateChanges` —
  -- triggers a full re-pull next run).
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, mailbox_jmap_id)
);

CREATE INDEX IF NOT EXISTS tenant_jmap_state_client_idx
  ON tenant_jmap_state (client_id, last_synced_at);


-- Global settings for tenant-backup v2. Single-row table by convention;
-- enforced via a CHECK that the row id is fixed. Reading the row is the
-- entire surface area; writes go through admin Settings UI.
CREATE TABLE IF NOT EXISTS tenant_backup_v2_settings (
  id                   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Daily snapshot retention count for `restic forget --keep-daily N`.
  retention_days       INT NOT NULL DEFAULT 30,
  -- `restic check` cadence in days (0 = disabled).
  check_interval_days  INT NOT NULL DEFAULT 7,
  -- Per-platform-api-pod cap on concurrent restic processes. Each
  -- restic process budgets ~200 MiB peak; the default 4 fits the 1Gi
  -- platform-api pod limit with margin.
  max_concurrent_restic INT NOT NULL DEFAULT 4,
  -- Cluster-wide cap, enforced via numbered pg_advisory_lock slots.
  -- 0 = unlimited (per-pod cap is the only limit).
  global_max_in_flight INT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenant_backup_v2_settings (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;
