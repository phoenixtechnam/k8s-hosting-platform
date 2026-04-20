-- Fix: storage_lifecycle_state enum was missing `resizing` and
-- `archiving` — the orchestrator code in service.ts writes those values
-- (see `markClientState('resizing', ...)` in resizeClient() and the
-- parallel call in archiveClient()), so the original 0041 migration
-- actually could not support the happy path.
--
-- Use ADD VALUE IF NOT EXISTS to stay idempotent for deploys that
-- already accidentally got the values added out-of-band.

ALTER TYPE storage_lifecycle_state ADD VALUE IF NOT EXISTS 'resizing';
ALTER TYPE storage_lifecycle_state ADD VALUE IF NOT EXISTS 'archiving';
