-- Dedicated timestamps for client lifecycle transitions.
--
-- Without these, auto-archive / auto-delete crons must use the generic
-- `updated_at` column as a proxy for "how long has this client been
-- suspended/archived?". But `updated_at` is bumped by any column
-- change — including admin tweaks to rate limits, contact emails, or
-- mailbox count overrides — which silently resets the clock and
-- indefinitely delays the cron's destructive action. These two
-- columns are stamped ONLY by the lifecycle cascades.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS suspended_at timestamp,
  ADD COLUMN IF NOT EXISTS archived_at timestamp;

CREATE INDEX IF NOT EXISTS clients_suspended_at_idx ON clients (suspended_at) WHERE suspended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_archived_at_idx  ON clients (archived_at)  WHERE archived_at  IS NOT NULL;
