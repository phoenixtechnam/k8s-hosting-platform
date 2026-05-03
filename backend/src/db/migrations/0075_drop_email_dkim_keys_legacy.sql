-- M13 — Drop email_dkim_keys_legacy (the old email_dkim_keys table).
--
-- Platform-side DKIM rotation was retired in M12. The table was renamed
-- to email_dkim_keys_legacy in migration 0074 to surface any lingering
-- code references at compile time. No references remain, so we drop it
-- here.
--
-- Also drops the dkim_* legacy columns from email_domains that were only
-- needed when the platform managed DKIM keys locally. Stalwart 0.16
-- manages DKIM natively; the platform reads status via JMAP (jmap-status.ts).

-- Step 1: Drop the legacy DKIM keys table.
DROP TABLE IF EXISTS email_dkim_keys_legacy;

-- Step 2: Drop legacy dkim_* columns from email_domains.
-- These were populated by the old enableEmailForDomain path; they are
-- no longer written after M12 and will be empty for any domains created
-- after the M12 migration ran.
ALTER TABLE email_domains
  DROP COLUMN IF EXISTS dkim_selector,
  DROP COLUMN IF EXISTS dkim_private_key_encrypted,
  DROP COLUMN IF EXISTS dkim_public_key;
