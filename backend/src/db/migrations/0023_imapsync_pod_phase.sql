-- IMAP Phase 3: imap_sync_jobs pod-level observability.
--
-- Background: a client reported a sync job that had been "running"
-- for 5+ minutes with zero progress and zero logs. Investigation
-- showed the Job was scheduled but the Pod was stuck `Pending` with
-- a `FailedScheduling: 0/1 nodes are available: 1 Too many pods`
-- event. The reconciler previously only inspected the Job status
-- (active/succeeded/failed counts) and surfaced nothing about why
-- the Pod might not actually be running — so the UI showed the
-- sync as "running" indefinitely with no error state.
--
-- This migration adds two columns the reconciler now writes on every
-- tick so the client panel can distinguish three states:
--
--   1. Job active + pod Running            → genuinely syncing
--   2. Job active + pod Pending + message  → cannot schedule / pull
--   3. Job active + no pod yet              → first few seconds
--
-- Examples of pod_phase:
--   'Pending'        — stuck before container start
--   'Running'        — executing normally
--   'Succeeded'      — terminal (reconciler clears at terminal flip)
--   'Failed'         — terminal
--
-- pod_message is the most recent Pod condition message, e.g.
-- `0/1 nodes are available: 1 Too many pods` or
-- `Back-off pulling image "gilleslamiral/imapsync:2.296"`.
-- The UI shows this verbatim as a warning banner on the row.

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS pod_phase varchar(32);

ALTER TABLE imap_sync_jobs
  ADD COLUMN IF NOT EXISTS pod_message text;
