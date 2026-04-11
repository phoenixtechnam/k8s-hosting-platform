-- Add path column to ingress_routes for custom path mappings.
-- Response headers move from proxy-set-headers ConfigMap to
-- configuration-snippet with add_header directives (no schema change needed
-- for that — it is purely an annotation-sync code change).

ALTER TABLE ingress_routes ADD COLUMN IF NOT EXISTS path VARCHAR(255) NOT NULL DEFAULT '/';
