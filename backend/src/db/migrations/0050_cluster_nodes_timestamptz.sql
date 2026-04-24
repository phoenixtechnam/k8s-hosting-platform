-- Post-review CRITICAL fix: cluster_nodes timestamp columns need
-- timezone awareness. `freshServerCount` in modules/load-balancer/
-- service.ts compares last_seen_at against NOW() - INTERVAL, which
-- returns timestamptz; PostgreSQL silently casts using the session
-- TimeZone GUC. On a UTC session this is correct, but a DBA-set
-- non-UTC session would let the HA gate flip incorrectly.
--
-- Converting TIMESTAMP → TIMESTAMPTZ reinterprets the existing
-- values using the session timezone at migration time. All platform
-- databases run in UTC (`timezone = 'UTC'` in postgres.conf and
-- `TZ=UTC` container env), so this is a lossless conversion for
-- the current fleet.
--
-- Only cluster_nodes is touched in this migration — the rest of the
-- codebase also uses TIMESTAMP but doesn't compare against NOW() in
-- SQL-level intervals (comparisons happen in TS with Date objects,
-- which are pre-converted to UTC). A follow-up can migrate those
-- for consistency, but the HA gate is the urgent case.

ALTER TABLE cluster_nodes
  ALTER COLUMN joined_at TYPE TIMESTAMPTZ USING joined_at AT TIME ZONE 'UTC',
  ALTER COLUMN last_seen_at TYPE TIMESTAMPTZ USING last_seen_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';
