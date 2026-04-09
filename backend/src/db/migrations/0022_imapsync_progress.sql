-- Round-4 Phase 3: imap_sync_jobs progress tracking columns.
--
-- Background: in round-4 phase 1 the user reported that running
-- IMAPSync jobs showed no progress at all in the client panel. The
-- reconciler only wrote the log tail at terminal state, which meant
-- a job migrating thousands of messages looked frozen for hours.
--
-- This migration adds columns the reconciler can update on every
-- tick while the K8s Job is still running, parsed from the
-- imapsync stdout (`+ Copying msg N/M ...`):
--
--   messages_total       — total messages discovered in the source
--                          (sum of all folder counts)
--   messages_transferred — messages successfully copied to date
--   current_folder       — folder imapsync is currently iterating
--   last_progress_at     — when the reconciler last updated these
--
-- All columns are nullable / default null because:
--   1. Pre-existing rows have no progress info to backfill.
--   2. While imapsync is starting up (folder discovery) it has not
--      emitted any progress lines yet, so the columns will be null.
--   3. Once the reconciler sees a progress line it populates them.
--
-- The reconciler also writes `log_tail` on every progress tick now
-- so the View Logs button (frontend) shows live output rather than
-- waiting for the job to finish.

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS messages_total integer;

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS messages_transferred integer;

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS current_folder varchar(255);

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS last_progress_at timestamp;
