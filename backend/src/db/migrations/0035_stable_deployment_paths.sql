-- Migration 0035: Stable deployment paths + missing columns
-- Replace resourceSuffix with storagePath for stable PVC folder naming.
-- PVC paths now follow /<type>/<code>/<slug>/ pattern.

-- Add missing 'path' column on ingress_routes (referenced by 0032 unique index but never added)
ALTER TABLE "ingress_routes" ADD COLUMN IF NOT EXISTS "path" varchar(255) NOT NULL DEFAULT '/';

-- Add storagePath column
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "storage_path" varchar(500);

-- Drop resourceSuffix column (no existing deployments in MVP beta)
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "resource_suffix";

-- Reduce name length to 63 (DNS-compatible K8s resource name limit)
ALTER TABLE "deployments" ALTER COLUMN "name" TYPE varchar(63);

-- Add statusMessage column for real-time status feedback during transitions
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "status_message" text;
