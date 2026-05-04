-- 0078_platform_storage_apply_runs.sql
--
-- Persistent run tracking for Apply HA / Apply Local. The synchronous
-- applyPolicy() call still returns within ~5s, but downstream Longhorn
-- replica rebuilds and CNPG instance scaling can run for several
-- minutes after. Operators want a live progress view that shows BOTH
-- the synchronous patch outcomes AND the post-patch convergence state.
--
-- Each row tracks one Apply HA / Apply Local invocation. The route
-- handler INSERTs the row at start with status='running', the
-- orchestration finishes its synchronous patches and updates
-- patch_outcome_json, then the convergence watcher updates
-- convergence_json each poll until the cluster reaches steady state
-- or the watcher times out.
--
-- The audit_logs row (resource_type='platform_storage_policy') still
-- gets written for the durable audit history; this table is the
-- live-progress / per-step trace surfaced to the operator's modal.

CREATE TABLE IF NOT EXISTS platform_storage_apply_runs (
  id                    UUID PRIMARY KEY,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  tier                  VARCHAR(8) NOT NULL CHECK (tier IN ('local', 'ha')),
  actor_user_id         VARCHAR(36),
  -- 'running'           — patches in flight or convergence still polling
  -- 'succeeded'         — every resource patched + every volume/cluster
  --                       converged within the watch window
  -- 'partial'           — patches succeeded but convergence timed out
  --                       (Longhorn rebuild slow / CNPG scale stuck)
  -- 'failed'            — at least one patch errored (capacity, RBAC, etc.)
  -- 'capacity_blocked'  — precheck rejected before any patches ran
  status                VARCHAR(32) NOT NULL DEFAULT 'running',
  -- The synchronous patch outcome (volumes/deployments/cnpgClusters
  -- arrays). Mirrors the route's response shape.
  patch_outcome_json    JSONB,
  -- Live convergence snapshot — refreshed by the watcher every ~5s.
  -- { volumesConverged, volumesTotal, cnpgConverged, cnpgTotal,
  --   deploymentsConverged, deploymentsTotal, lastObservedAt }.
  convergence_json      JSONB
);

CREATE INDEX IF NOT EXISTS idx_psar_status_started ON platform_storage_apply_runs (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_psar_actor ON platform_storage_apply_runs (actor_user_id);
