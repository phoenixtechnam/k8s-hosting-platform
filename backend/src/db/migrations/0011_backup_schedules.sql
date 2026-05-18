-- Phase A.1 of backup UI consolidation.
--
-- 1. `backup_schedules` row per subsystem (mail, tenant_bundle,
--    system_pitr, longhorn_recurring) so every cron has the same
--    {enabled, cron, retention, updated_at, updated_by} shape. The
--    new /admin/backups/schedules CRUD enforces the strict-gate:
--    `enabled=true` is refused until the corresponding snapshot
--    class has at least one assignment.
--
-- 2. `hosting_plans.include_in_scheduled_bundles BOOLEAN` (plan-level
--    default) + `tenants.include_in_scheduled_bundles BOOLEAN NULL`
--    (per-tenant override). The tenant-bundle cron iterates
--    `WHERE COALESCE(tenants.include, plans.include) = true`. SYSTEM
--    tenant participates (no is_system filter).

-- ─── backup_schedules ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "backup_schedules" (
  -- Single row per subsystem. Free-form varchar lets us add new
  -- subsystems (e.g. stalwart_blob) without a schema change.
  "subsystem" VARCHAR(64) PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  -- Standard 5-field cron expression. Optional for subsystems
  -- whose schedule is managed elsewhere (e.g. longhorn-RJ stores
  -- cron in the CRD; this row tracks enable/retention only).
  "cron_expression" VARCHAR(128),
  -- Retention dimensions are subsystem-specific. The CRUD API
  -- exposes them as named fields and ignores the ones a given
  -- subsystem doesn't use.
  "retention_days" INTEGER,
  "retention_count" INTEGER,
  -- Audit trail.
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_by" VARCHAR(36),
  CONSTRAINT "backup_schedules_retention_nonneg"
    CHECK ((retention_days IS NULL OR retention_days >= 0)
       AND (retention_count IS NULL OR retention_count >= 0))
);

-- Seed the four current subsystems as DISABLED so the operator
-- has to explicitly Enable each one after configuring its target.
-- Strict-gate refuses enable until a target is assigned to the
-- relevant class.
INSERT INTO "backup_schedules" ("subsystem", "enabled", "cron_expression", "retention_days", "retention_count")
VALUES
  ('mail',           FALSE, '*/2 * * * *', NULL, 48),  -- every 2 min, keep last 48
  ('tenant_bundle',  FALSE, '0 2 * * *',   30,   NULL), -- nightly, 30-day retain
  ('system_pitr',    FALSE, '0 1 * * *',   30,   NULL), -- daily base backup
  ('longhorn_recurring', FALSE, '0 */6 * * *', 7, NULL) -- 6-hourly Longhorn RJ default
ON CONFLICT ("subsystem") DO NOTHING;

-- ─── include_in_scheduled_bundles ─────────────────────────────────────

ALTER TABLE "hosting_plans"
  ADD COLUMN IF NOT EXISTS "include_in_scheduled_bundles" BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "include_in_scheduled_bundles" BOOLEAN;

-- Index supports the cron's iteration query:
--   SELECT t.id FROM tenants t INNER JOIN hosting_plans p ON p.id=t.plan_id
--   WHERE COALESCE(t.include_in_scheduled_bundles, p.include_in_scheduled_bundles) = TRUE
-- Partial — most tenants will inherit (NULL) so partial-on-override
-- is the high-selectivity slice.
CREATE INDEX IF NOT EXISTS "tenants_include_bundles_idx"
  ON "tenants" ("include_in_scheduled_bundles")
  WHERE "include_in_scheduled_bundles" IS NOT NULL;
