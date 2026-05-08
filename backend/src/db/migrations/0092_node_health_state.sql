-- Per-node health snapshot, persisted by the node-health-reconciler
-- so transitions (normal → warning → critical) can fire admin
-- notifications without re-spamming on every 5-min tick.
--
-- Why: the 2026-05-08 worker incident — Calico Felix crash-looped
-- for 10 days writing core dumps into the calico-node container's
-- writable layer (28GB), kubelet hit DiskPressure, evicted Longhorn
-- pods, worker silently lost its `driver.longhorn.io` registration.
-- The platform had no alert on any of: host disk pressure, CSI
-- driver count drop, or pod-eviction loops. This table backs the
-- new node-health module that closes those three gaps.

CREATE TABLE IF NOT EXISTS node_health_state (
  node_name              TEXT PRIMARY KEY,
  ready                  BOOLEAN NOT NULL DEFAULT TRUE,
  -- Subset of {'disk','memory','pid'} reported by kubelet conditions.
  pressures              TEXT[] NOT NULL DEFAULT '{}',
  csi_drivers_present    INTEGER NOT NULL DEFAULT 0,
  csi_drivers_expected   INTEGER NOT NULL DEFAULT 0,
  -- Driver names (e.g. 'driver.longhorn.io') registered on baseline
  -- nodes but missing on this one. Empty array == in line with cluster.
  csi_drivers_missing    TEXT[] NOT NULL DEFAULT '{}',
  evictions_last_hour    INTEGER NOT NULL DEFAULT 0,
  -- Disk-fill percentage from kubelet `/stats/summary`. NULL when the
  -- kubelet endpoint was unreachable on the last tick.
  disk_used_pct          NUMERIC(5,2),
  -- 'normal' | 'warning' | 'critical'. CHECK keeps the value space
  -- documented at the schema layer (matches NodeHealthSeverity in
  -- api-contracts/node-health.ts).
  severity               TEXT NOT NULL DEFAULT 'normal'
                         CHECK (severity IN ('normal', 'warning', 'critical')),
  -- Last time we fanned out a notification for THIS node (any
  -- severity transition). Used to throttle subsequent 'still
  -- critical' notices to once per 24h.
  last_notified_at       TIMESTAMPTZ,
  observed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick "give me only the unhealthy ones" lookup from the
-- monitoring page header banner.
CREATE INDEX IF NOT EXISTS node_health_state_severity_idx
  ON node_health_state (severity)
  WHERE severity != 'normal';
