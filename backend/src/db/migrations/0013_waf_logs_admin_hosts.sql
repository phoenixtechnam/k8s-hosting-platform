-- waf_logs: capture admin/api/client-host WAF events too (not just per-tenant
-- ingress_routes). Today the scraper drops every event whose hostname doesn't
-- match an ingress_routes row, so when CRS blocks a request to admin.<apex>
-- (e.g. the 930120 LFI false-positive on `secretsRestoredCount` that hit
-- POST /admin/system-backup/dr-drill/runs on 2026-05-19) it's invisible in
-- the platform — operators have to `kubectl logs -n traefik deploy/modsec-crs`.
--
-- After this migration:
--   route_id   → nullable (NULL for admin/api/client/platform hosts)
--   tenant_id  → nullable (same reason)
--   hostname   → NOT NULL, always populated (was implicit via route join)
--
-- The per-route endpoint /tenants/:tenantId/routes/:routeId/waf-logs keeps
-- working because the WHERE route_id = $1 still matches the rows that do
-- have a route_id. The new /admin/security/waf-events endpoint is the
-- cluster-wide view (super_admin only).

ALTER TABLE "waf_logs" DROP CONSTRAINT IF EXISTS "waf_logs_route_id_ingress_routes_id_fk";
ALTER TABLE "waf_logs" DROP CONSTRAINT IF EXISTS "waf_logs_tenant_id_tenants_id_fk";

ALTER TABLE "waf_logs" ALTER COLUMN "route_id" DROP NOT NULL;
ALTER TABLE "waf_logs" ALTER COLUMN "tenant_id" DROP NOT NULL;

-- Backfill hostname for existing rows from the ingress_routes join. New rows
-- get hostname populated by the scraper directly. Default '' keeps the NOT
-- NULL constraint satisfiable on legacy rows that lost their route already.
ALTER TABLE "waf_logs" ADD COLUMN IF NOT EXISTS "hostname" VARCHAR(255) NOT NULL DEFAULT '';

UPDATE "waf_logs" wl
SET hostname = ir.hostname
FROM "ingress_routes" ir
WHERE wl.route_id = ir.id
  AND wl.hostname = '';

-- Drop legacy rows whose route was already deleted (ON DELETE CASCADE before
-- this migration nulled the route_id) AND we have no hostname to backfill.
-- Without this they'd appear in the new cluster-wide view as `hostname=""`
-- + `scope='admin-host'`, which is misleading — they were tenant events
-- originally. Better to drop than to mis-attribute.
DELETE FROM "waf_logs" WHERE route_id IS NULL AND hostname = '';

-- Re-add FKs with ON DELETE SET NULL (was cascade). With cascade, deleting
-- a route nuked its audit trail — surprising in a forensic context. SET NULL
-- preserves the event with route_id=NULL so it still shows in the cluster-
-- wide view even after the route is gone.
ALTER TABLE "waf_logs" ADD CONSTRAINT "waf_logs_route_id_ingress_routes_id_fk"
  FOREIGN KEY ("route_id") REFERENCES "public"."ingress_routes"("id") ON DELETE SET NULL;
ALTER TABLE "waf_logs" ADD CONSTRAINT "waf_logs_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;

-- Indexes for cluster-wide queries (existing waf_logs_created_idx covers
-- ORDER BY created_at DESC; add hostname + rule_id for filterability).
CREATE INDEX IF NOT EXISTS "waf_logs_hostname_created_idx"
  ON "waf_logs" ("hostname", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "waf_logs_rule_id_created_idx"
  ON "waf_logs" ("rule_id", "created_at" DESC);
