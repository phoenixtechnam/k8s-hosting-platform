-- Phase M1: cluster_nodes table — backend mirror of k8s node inventory with
-- platform-specific role + config annotations that don't belong in node
-- labels (e.g. operator notes, ssh-target hints, custom labels).
--
-- The k8s-node-sync CronJob upserts from `kubectl get nodes` every 60s.
-- The table is authoritative for platform-managed fields (role,
-- canHostClientWorkloads) — bootstrap.sh + join flow writes here AND
-- labels the k8s node to match. For ad-hoc `kubectl label` drift, the
-- sync job trusts the k8s node label as the source of truth and updates
-- the DB row.
--
-- Role semantics (ADR-031):
--   server — runs k3s control plane + system workloads
--   worker — runs tenant workloads only
--
-- canHostClientWorkloads allows a server node to also accept tenant
-- workloads (small-deployment economy). Default false for servers,
-- always true for workers.

CREATE TYPE node_role AS ENUM ('server', 'worker');

CREATE TABLE cluster_nodes (
  -- k8s node name is the natural key (hostname-ish, unique).
  name VARCHAR(253) PRIMARY KEY,
  role node_role NOT NULL DEFAULT 'worker',
  can_host_client_workloads BOOLEAN NOT NULL DEFAULT TRUE,

  -- Observed values from `kubectl get node -o json` at last sync.
  -- public_ip is the node's primary external IP (for DNS routing + Hetzner LB).
  public_ip INET,
  kubelet_version VARCHAR(32),
  k3s_version VARCHAR(32),
  cpu_millicores INTEGER,             -- total allocatable CPU
  memory_bytes BIGINT,                -- total allocatable memory
  storage_bytes BIGINT,                -- total allocatable ephemeral storage
  status_conditions JSONB,            -- array of {type, status, reason, message}

  -- When the node first appeared in the sync job.
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  -- Last successful kubectl observation. Stale → possibly offline.
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Operator notes (free text surfaced in the admin UI node detail page).
  notes TEXT,

  -- Full k8s label+taint snapshot for audit. The platform-managed keys
  -- (platform.phoenix-host.net/*) mirror the dedicated columns above;
  -- other labels/taints (kubernetes.io/*, node-role.kubernetes.io/*,
  -- user custom) live here for visibility only.
  labels JSONB,
  taints JSONB,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX cluster_nodes_role_idx ON cluster_nodes(role);
CREATE INDEX cluster_nodes_last_seen_idx ON cluster_nodes(last_seen_at);

-- Seed current staging node as server (retroactive).
-- Safe because PRIMARY KEY(name) makes repeat runs no-op — but this
-- migration only runs once per DB per Drizzle's checksum tracking.
INSERT INTO cluster_nodes (name, role, can_host_client_workloads, public_ip)
VALUES ('staging', 'server', TRUE, '89.167.3.56'::inet)
ON CONFLICT (name) DO NOTHING;
