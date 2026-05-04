-- Migration 0076: private_workers feature.
-- Lets clients expose a service running outside the cluster (home box, NAS,
-- on-prem VPS) under their platform-issued ingress. The home agent dials
-- in over WSS to tunnels.${DOMAIN}/c/{slug}/, an frps pod in the client
-- namespace terminates the tunnel, and a normal Service is what the existing
-- ingressRoutes target. Single-token model — agent is stateless, token lives
-- in PRIVATE_WORKER_TOKEN env var.
--
-- See docs/04-deployment/PRIVATE_WORKER.md for the full design.
--
-- Two new tables:
--   private_workers       — per-client tunnel definitions
--   private_worker_audit  — append-only event log
--
-- Plus polymorphic target on ingress_routes so a route can point at either
-- a deployment or a private_worker.

-- ── ENUMs ────────────────────────────────────────────────────────────────

CREATE TYPE private_worker_status AS ENUM (
  'pending',
  'active',
  'revoked',
  'suspended'
);

CREATE TYPE ingress_target_type AS ENUM ('deployment', 'private_worker');

-- ── private_workers ──────────────────────────────────────────────────────

CREATE TABLE private_workers (
  id                 VARCHAR(36) PRIMARY KEY,
  client_id          VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name               VARCHAR(120) NOT NULL,
  slug               VARCHAR(60) NOT NULL UNIQUE,
  worker_token_hash  VARCHAR(64) NOT NULL,
  status             private_worker_status NOT NULL DEFAULT 'pending',
  exposed_port       INTEGER NOT NULL,
  description        TEXT,
  last_seen_at       TIMESTAMP,
  last_used_ip       INET,
  bytes_in           BIGINT NOT NULL DEFAULT 0,
  bytes_out          BIGINT NOT NULL DEFAULT 0,
  created_by         VARCHAR(36),
  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMP,
  revoked_by         VARCHAR(36),
  updated_at         TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT private_workers_exposed_port_range CHECK (exposed_port BETWEEN 1 AND 65535),
  CONSTRAINT private_workers_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,58}[a-z0-9]$')
);

CREATE INDEX private_workers_client_idx ON private_workers(client_id);
CREATE INDEX private_workers_status_idx ON private_workers(status);
CREATE UNIQUE INDEX private_workers_client_name_uq ON private_workers(client_id, name);

-- ── private_worker_audit ─────────────────────────────────────────────────

CREATE TABLE private_worker_audit (
  id                 BIGSERIAL PRIMARY KEY,
  private_worker_id  VARCHAR(36) NOT NULL REFERENCES private_workers(id) ON DELETE CASCADE,
  event              VARCHAR(40) NOT NULL,
  ip                 INET,
  detail             JSONB,
  occurred_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX private_worker_audit_worker_idx
  ON private_worker_audit(private_worker_id, occurred_at DESC);
CREATE INDEX private_worker_audit_event_idx
  ON private_worker_audit(event, occurred_at DESC);

-- ── ingress_routes polymorphic target ───────────────────────────────────

ALTER TABLE ingress_routes
  ADD COLUMN target_type ingress_target_type NOT NULL DEFAULT 'deployment',
  ADD COLUMN private_worker_id VARCHAR(36)
    REFERENCES private_workers(id) ON DELETE CASCADE,
  ALTER COLUMN deployment_id DROP NOT NULL;

ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_target_xor CHECK (
    (target_type = 'deployment'
       AND deployment_id IS NOT NULL
       AND private_worker_id IS NULL)
    OR
    (target_type = 'private_worker'
       AND private_worker_id IS NOT NULL
       AND deployment_id IS NULL)
  );

CREATE INDEX ingress_routes_private_worker_idx
  ON ingress_routes(private_worker_id)
  WHERE private_worker_id IS NOT NULL;
