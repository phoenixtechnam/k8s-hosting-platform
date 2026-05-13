-- Adds the `mode` column to mail_archive_runs.
--
-- Two implementations of `stalwart -e` archive:
--
--   no_downtime  — opens the primary RocksDB as a SECONDARY instance
--                  (no LOCK conflict), takes a hard-linked Checkpoint,
--                  then runs `stalwart -e` against the checkpoint via an
--                  alt-config. Live Stalwart keeps serving SMTP/IMAP.
--                  Requires the rocksdb-secondary-checkpoint container
--                  image (built from images/rocksdb-secondary-checkpoint).
--
--   downtime     — scales the stalwart-mail Deployment to 0 first, then
--                  runs `stalwart -e` against the released LOCK, then
--                  scales back. ~60-120s mail downtime.
--
-- Default is 'downtime' for any pre-existing rows from before this
-- migration (they all used the scale-down dance). New rows default to
-- 'no_downtime' via the application layer.
ALTER TABLE mail_archive_runs
  ADD COLUMN IF NOT EXISTS mode varchar(16) NOT NULL DEFAULT 'downtime';

-- Backfill historic 'restore' rows: those are operator-confirmed restores
-- that DO require downtime (same scale-down dance + import). The mode is
-- about the EXPORT half — for restores we always need downtime, since
-- `stalwart -i` writes into an empty primary which must hold the LOCK.
-- Keep the default for them.

-- New rows from PR #N onward default to 'no_downtime' (set by archive.ts
-- when triggered_by='operator'). The DB default of 'downtime' is the
-- safety fallback in case the application layer omits the column.
