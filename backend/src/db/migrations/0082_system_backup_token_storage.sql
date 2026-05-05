-- System Backup Phase 1.5b — DB-backed download token storage.
--
-- Why this exists: platform-api runs as 3 replicas. The POST /export
-- hits one replica which signed an HMAC token and stashed the
-- unhashed value in a process-local Map. The next GET /runs/:id (UI
-- polling loop) round-robins across replicas → 2 out of 3 GETs see
-- no entry, surface downloadUrl=null, and the UI tells the operator
-- "this bundle has already been downloaded" the instant a fresh
-- export succeeds. Replication-safety requires the token live in
-- shared state — i.e. the same row that already carries the payload.
--
-- Security posture is unchanged: the raw token is wiped in the same
-- atomic UPDATE…RETURNING that wipes the payload on first download.
-- An attacker with DB-read access already has the payload, so adding
-- the token alongside is no weakening of the threat model. CHECK
-- constraints below add belt-and-braces enum validation flagged by
-- the database review.

ALTER TABLE system_backup_runs
  ADD COLUMN IF NOT EXISTS download_token_raw VARCHAR(256);

CREATE INDEX IF NOT EXISTS system_backup_runs_kind_created_idx
  ON system_backup_runs(kind, created_at DESC);

DROP INDEX IF EXISTS system_backup_runs_created_idx;

ALTER TABLE system_backup_runs
  DROP CONSTRAINT IF EXISTS system_backup_runs_kind_check;
ALTER TABLE system_backup_runs
  ADD CONSTRAINT system_backup_runs_kind_check
    CHECK (kind IN ('secrets'));

ALTER TABLE system_backup_runs
  DROP CONSTRAINT IF EXISTS system_backup_runs_status_check;
ALTER TABLE system_backup_runs
  ADD CONSTRAINT system_backup_runs_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed'));
