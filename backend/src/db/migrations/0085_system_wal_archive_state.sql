-- System Backup Phase 4 — WAL archive runtime state.
--
-- One row per (cluster_namespace, cluster_name) tracks operator intent:
-- which backup_configurations target the WAL stream is pointing at,
-- the chosen retention, and audit fields. The actual CNPG state lives
-- on the Cluster CR (.spec.backup.barmanObjectStore) and is the source
-- of truth for what the cluster is doing — this table is the source
-- of truth for what the OPERATOR last asked for.
--
-- We don't try to reconcile drift here: enable/disable POST routes
-- patch the CR + write/clear the row in the same transaction. Drift
-- detection is a future hardening item.

CREATE TABLE IF NOT EXISTS system_wal_archive_state (
  cluster_namespace VARCHAR(63) NOT NULL,
  cluster_name      VARCHAR(63) NOT NULL,
  target_config_id  VARCHAR(36) NOT NULL,
  retention_days    INTEGER     NOT NULL DEFAULT 30,
  destination_path  VARCHAR(1024) NOT NULL,
  enabled_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_user_id  VARCHAR(36),
  PRIMARY KEY (cluster_namespace, cluster_name),
  CONSTRAINT system_wal_archive_state_retention_check
    CHECK (retention_days BETWEEN 1 AND 3650)
);

-- Helpful index for the list endpoint that joins with backup_configurations.
CREATE INDEX IF NOT EXISTS system_wal_archive_state_target_idx
  ON system_wal_archive_state(target_config_id);
