-- Phase B3: backup_configurations gains an `active` flag so one config
-- at a time is designated the Longhorn backup target. The backend's
-- reconciler watches the row with active=TRUE and keeps the Longhorn
-- BackupTarget CR + credentials Secret in sync.
--
-- The unique partial index enforces "at most one active row per
-- cluster" at the database level — the service layer's setActive()
-- still swaps the flag in a transaction, but this index is the safety
-- net against concurrent updates racing to activate two configs.
ALTER TABLE "backup_configurations"
  ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "backup_configurations_one_active_idx"
  ON "backup_configurations" ("active")
  WHERE "active" = true;
