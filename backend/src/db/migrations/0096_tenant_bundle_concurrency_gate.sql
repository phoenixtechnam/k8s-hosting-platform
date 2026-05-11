-- Cluster-wide concurrency gate for tenant-bundle restic streams.
--
-- Background: per-pod restic concurrency is capped by an in-process
-- semaphore (TENANT_BUNDLES_MAX_CONCURRENT_RESTIC, default 2). With 3
-- platform-api replicas that's 6 cluster-wide. For 50-100 tenants on
-- daily-overnight schedules at ~110s per 5 GiB capture, the math says
-- ~90 min to complete 100 backups at concurrency 2 — well within an
-- 8h window. Higher cluster concurrency only adds Hetzner S3 request
-- pressure (parallel TCP sockets per bucket) and SFTP-side SSH-session
-- concurrency on the Storage Box, both of which have non-published caps.
--
-- This migration:
--   1. Lowers the row defaults to match the new shipped values:
--      max_concurrent_restic 4 → 2,  global_max_in_flight 0 → 4.
--   2. Creates `tenant_bundle_in_flight`, a row-per-active-capture
--      table that the runtime acquire/release uses to enforce the
--      cluster cap atomically. Pre-existing rows from a crashed
--      platform-api pod expire via `refreshed_at` heartbeat (5 min);
--      stale rows are ignored by the count check and reaped by the
--      retention sweeper.
--
-- The lock-acquire pattern (see `modules/tenant-bundles/cluster-concurrency.ts`):
--
--   BEGIN;
--   SELECT pg_advisory_xact_lock(0x'tenant-bundles-cluster-gate');
--   SELECT COUNT(*) FROM tenant_bundle_in_flight
--     WHERE refreshed_at > NOW() - INTERVAL '5 minutes';
--   -- if count < global_max_in_flight:
--   INSERT INTO tenant_bundle_in_flight (...) RETURNING ...;
--   COMMIT;   -- releases the xact lock
--
-- The xact-lock serialises all concurrent acquire attempts so the
-- count-then-insert is race-free without holding a long-lived lock.
-- The heartbeat path (every 60s during a capture) writes
-- refreshed_at = NOW() so a stalled-but-alive backup doesn't get
-- counted out.

ALTER TABLE tenant_backup_v2_settings
  ALTER COLUMN max_concurrent_restic SET DEFAULT 2,
  ALTER COLUMN global_max_in_flight  SET DEFAULT 4;

-- One-time pull-forward: clusters that booted under the old defaults
-- (4 / 0) and never had an operator change the setting row get the
-- new defaults too. We DO NOT trample customer overrides — only the
-- exact prior-default values are migrated.
UPDATE tenant_backup_v2_settings
  SET max_concurrent_restic = 2
  WHERE max_concurrent_restic = 4;
UPDATE tenant_backup_v2_settings
  SET global_max_in_flight = 4
  WHERE global_max_in_flight = 0;

CREATE TABLE IF NOT EXISTS tenant_bundle_in_flight (
  -- Bundle + component compound key — one captures of the same bundle
  -- can run for files + mailboxes in parallel; each gets its own slot.
  bundle_id     VARCHAR(64)  NOT NULL,
  component     VARCHAR(32)  NOT NULL,
  pod_name      VARCHAR(255),
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Heartbeat. The acquiring code updates this every 60s during the
  -- capture. Rows older than 5 min are treated as stale by the count
  -- check (orphans from a crashed pod) and reaped by the retention
  -- sweeper.
  refreshed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (bundle_id, component)
);

CREATE INDEX IF NOT EXISTS tenant_bundle_in_flight_refreshed_idx
  ON tenant_bundle_in_flight (refreshed_at);
