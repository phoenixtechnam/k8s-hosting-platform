-- Phase 1 of client-panel email parity round 2: plan-based mailbox limit.
--
-- Previously the mailbox count was limited per-email-domain via
-- email_domains.max_mailboxes (default 50). That didn't compose
-- across multiple domains on the same client, and operators had
-- no way to cap total mailboxes via hosting plan.
--
-- This migration adds:
--   1. hosting_plans.max_mailboxes — the plan-level cap
--   2. clients.max_mailboxes_override — null = inherit from plan
--
-- Migration 0019 then drops the per-email-domain column.
--
-- Default 50 is a generous starting point that matches the
-- previous per-email-domain default, so no existing clients get
-- blocked after the migration runs. Operators can raise the limit
-- on higher-tier plans via the admin panel.

ALTER TABLE hosting_plans
  ADD COLUMN IF NOT EXISTS max_mailboxes integer NOT NULL DEFAULT 50;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS max_mailboxes_override integer;
