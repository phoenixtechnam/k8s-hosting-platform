-- 0000_tenant_rename.sql renamed oidc_providers.client_id → tenant_id
-- by mistake (bulk rename pass over-applied — these are OIDC protocol
-- identifiers, NOT tenant entity FKs). This migration reverts the
-- column name so the OAuth2 client_id / client_secret pair on the
-- relying-party row uses the canonical OIDC naming.
--
-- Safe to apply on any cluster created from 0000_tenant_rename.sql
-- — no data transform, just a column rename. New deployments skip
-- this migration entirely (the column never had the wrong name).

ALTER TABLE "oidc_providers" RENAME COLUMN "tenant_id" TO "client_id";
