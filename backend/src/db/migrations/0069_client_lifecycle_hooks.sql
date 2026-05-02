-- Phase 1 of unified client-lifecycle hook registry
-- (see docs/07-reference/ADR — pending — and project_lifecycle_hook_registry memory).
--
-- Two tables:
--   * client_lifecycle_transitions  — one row per state transition the
--     dispatcher kicks off (active|suspended|archived|restored|deleted).
--     Acts as the parent that owns hook_runs; mirrors the storage_operations
--     pattern that already exists for snapshot/restore orchestration.
--
--   * client_lifecycle_hook_runs   — one row per (transition, hook, attempt).
--     Separate table (NOT a JSON column on transitions) so the scheduler
--     can SELECT … WHERE state='failed' AND next_attempt_at <= NOW() with
--     a proper index, and so SQL grep-ability survives.
--
-- Phase 1 is a no-op skeleton: dispatcher will write a transitions row
-- with zero hook_runs because no hooks are registered yet. Subsequent
-- phases populate the registry.

CREATE TYPE client_lifecycle_transition_kind AS ENUM (
  'active',
  'suspended',
  'archived',
  'restored',
  'deleted'
);

CREATE TYPE client_lifecycle_transition_state AS ENUM (
  'running',          -- dispatcher in flight
  'completed',        -- all hooks ok/noop
  'failed_partial',   -- one or more `continue`-blocking hooks failed
  'failed_blocking'   -- a `abort`-blocking hook failed; dispatcher halted
);

CREATE TYPE client_lifecycle_hook_run_state AS ENUM (
  'pending',          -- queued, not yet attempted
  'running',          -- attempt in flight
  'ok',               -- finished successfully
  'noop',             -- nothing to do (e.g. resource already absent)
  'failed'            -- attempt threw; scheduler will retry if attempts < max
);

CREATE TABLE client_lifecycle_transitions (
  id                     VARCHAR(36) PRIMARY KEY,
  client_id              VARCHAR(36) NOT NULL,
  -- audit_logs intentionally keeps client_id as a tombstone (no cascade);
  -- transitions are the same — we want history to outlive the client row.
  -- Consequence: deletes do NOT propagate to transitions; storage cron
  -- can prune rows older than N days if desired.
  transition_kind        client_lifecycle_transition_kind NOT NULL,
  from_status            VARCHAR(32),
  to_status              VARCHAR(32) NOT NULL,
  triggered_by_user_id   VARCHAR(36),
  state                  client_lifecycle_transition_state NOT NULL DEFAULT 'running',
  started_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMP,
  detail                 JSONB
);
CREATE INDEX client_lifecycle_transitions_client_idx
  ON client_lifecycle_transitions(client_id, started_at DESC);
CREATE INDEX client_lifecycle_transitions_state_idx
  ON client_lifecycle_transitions(state)
  WHERE state IN ('running', 'failed_blocking');

CREATE TABLE client_lifecycle_hook_runs (
  id                  VARCHAR(36) PRIMARY KEY,
  transition_id       VARCHAR(36) NOT NULL
    REFERENCES client_lifecycle_transitions(id) ON DELETE CASCADE,
  hook_name           VARCHAR(64) NOT NULL,
  hook_order          INT NOT NULL,
  blocking            VARCHAR(8) NOT NULL,  -- 'abort' | 'continue'
  state               client_lifecycle_hook_run_state NOT NULL DEFAULT 'pending',
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  last_error          JSONB,                -- OperatorError envelope on failure
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP,
  next_attempt_at     TIMESTAMP             -- set on retryable failure
);
CREATE INDEX client_lifecycle_hook_runs_transition_idx
  ON client_lifecycle_hook_runs(transition_id, hook_order);
-- Scheduler retry index: only failed rows that are eligible for retry.
CREATE INDEX client_lifecycle_hook_runs_retry_idx
  ON client_lifecycle_hook_runs(next_attempt_at)
  WHERE state = 'failed' AND next_attempt_at IS NOT NULL;
-- Idempotency key: a single (transition, hook) is unique — re-running the
-- same hook for the same transition increments `attempts`, doesn't add a
-- new row.
CREATE UNIQUE INDEX client_lifecycle_hook_runs_uniq_idx
  ON client_lifecycle_hook_runs(transition_id, hook_name);
