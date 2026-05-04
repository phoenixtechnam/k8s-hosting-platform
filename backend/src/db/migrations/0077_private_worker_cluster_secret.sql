-- Migration 0077: per-client shared auth secret for private-worker frps.
-- frps 0.62 supports exactly one auth.token per server, and we run one
-- frps pod per client. So all workers under a client share a single
-- auth token. The token is generated on first worker mint, stored
-- plaintext in this column (DB is encrypted at rest), and re-used
-- for every subsequent worker minted under the same client.
--
-- Per-worker revocation is enforced via frps `allowPorts` (rendered
-- from the active workers' exposedPort list) — when a worker is
-- revoked, its port disappears from allowPorts and frpc's proxy
-- registration is rejected.
--
-- Rotating the cluster secret is a separate operator action (not yet
-- exposed in v1) that rotates this column + invalidates all the
-- currently-running agents at once.

ALTER TABLE clients
  ADD COLUMN private_worker_shared_secret VARCHAR(64);
