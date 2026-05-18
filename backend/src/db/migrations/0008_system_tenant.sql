-- System tenant flag: adds the boolean column and a partial unique
-- index enforcing the at-most-one-SYSTEM-row invariant at the DB
-- layer. Bootstrap creates the SYSTEM row idempotently from
-- backend/src/modules/system-tenant/.
--
-- The partial unique index allows many is_system=false rows (every
-- normal customer) while permitting at most one is_system=true row.
-- A future direct-SQL deletion of the SYSTEM row is recoverable: the
-- next backend startup re-runs ensureSystemTenant() and re-inserts
-- under the same flag (the unique index allows insertion when no
-- existing true-row blocks it).

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "is_system" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_only_one_system_idx"
  ON "tenants" ("is_system")
  WHERE "is_system" = TRUE;
