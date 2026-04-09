-- Phase 2 of client-panel email parity round 2: drop per-email-domain
-- mailbox limits in favor of the plan-based client-total limit
-- added in migration 0018.
--
-- Previously:
--   email_domains.max_mailboxes (integer, default 50) — per-domain
--       mailbox count cap, enforced in mailboxes/service.ts
--   email_domains.max_quota_mb (integer, default 10240) — stored but
--       never enforced anywhere in the code base (dead data).
--
-- Both are replaced by hosting_plans.max_mailboxes +
-- clients.max_mailboxes_override, which cap the TOTAL mailboxes
-- across all of a client's email domains (the correct unit for
-- billing / plan tiers).
--
-- IRREVERSIBLE: this migration drops columns. Existing values are
-- lost. Production operators should verify their plan-level limit
-- is set correctly before applying (default 50 is generous).

ALTER TABLE email_domains DROP COLUMN IF EXISTS max_mailboxes;
ALTER TABLE email_domains DROP COLUMN IF EXISTS max_quota_mb;
