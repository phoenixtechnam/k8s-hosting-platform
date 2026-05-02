-- Migration 0069: Add 'unverified' and 'verified' to domain_status enum.
-- PostgreSQL requires ALTER TYPE ... ADD VALUE to run outside a transaction
-- (or at least not be used in the same transaction as DML using the new value).
-- drizzle-kit uses a per-file transaction; the breakpoint comment below tells
-- the runner to commit before the next statement so the new enum values are
-- visible to the UPDATE in 0070.

ALTER TYPE domain_status ADD VALUE IF NOT EXISTS 'unverified' BEFORE 'pending';

-- breakpoint

ALTER TYPE domain_status ADD VALUE IF NOT EXISTS 'verified' AFTER 'unverified';

-- Add last_known_platform_ips to system_settings for cron IP-change detection.
-- A JSONB column to store { v4: string[], v6: string[] }.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS last_known_platform_ips JSONB;

-- notify_dns_failures_via_email: when true AND client has email, send domain
-- verification failure notifications via email in addition to in-app.
-- Default false (in-app only for Phase 1).
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS notify_dns_failures_via_email BOOLEAN NOT NULL DEFAULT false;
