-- Migration 0035: Stable deployment paths
-- Replace resourceSuffix with storagePath for stable PVC folder naming.
-- PVC paths now follow /<type>/<code>/<slug>/ pattern.

-- Add storagePath column
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "storage_path" varchar(500);

-- Drop resourceSuffix column (no existing deployments in MVP beta)
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "resource_suffix";

-- Reduce name length to 63 (DNS-compatible K8s resource name limit)
ALTER TABLE "deployments" ALTER COLUMN "name" TYPE varchar(63);
