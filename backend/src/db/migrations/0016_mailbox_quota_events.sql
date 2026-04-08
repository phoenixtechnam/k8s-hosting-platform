-- Phase 3 T5.3: per-mailbox quota threshold tracking.
--
-- The mail-stats reconciler runs every 15 minutes and updates
-- mailboxes.used_mb. After each reconcile we want to fire ONE
-- notification per mailbox per crossed threshold (80% / 90% /
-- 100%) — not one notification per cycle, which would spam users.
--
-- Dedupe via this table: a row exists for each (mailbox_id,
-- threshold) pair that has been hit since the last clear. The
-- ON CONFLICT DO NOTHING insert pattern means concurrent
-- reconciler instances are safe — exactly one INSERT will succeed.
--
-- Hysteresis: rows are cleared when usage drops below
-- (threshold - 5)% so a flapping mailbox doesn't re-fire
-- notifications every reconcile cycle.

CREATE TABLE IF NOT EXISTS mailbox_quota_events (
  mailbox_id varchar(36) NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  threshold smallint NOT NULL CHECK (threshold IN (80, 90, 100)),
  first_seen_at timestamp NOT NULL DEFAULT now(),
  cleared_at timestamp,
  notification_id varchar(36),
  PRIMARY KEY (mailbox_id, threshold)
);

CREATE INDEX IF NOT EXISTS mailbox_quota_events_open_idx
  ON mailbox_quota_events (mailbox_id) WHERE cleared_at IS NULL;
