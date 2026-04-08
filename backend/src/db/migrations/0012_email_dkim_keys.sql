-- Phase 3 T1.1 (B.2): email_dkim_keys for key rotation with grace period.
--
-- Previously email_domains held a single DKIM key (dkim_selector +
-- dkim_private_key_encrypted + dkim_public_key). Rotating the key
-- meant deleting the old one, publishing the new public key in DNS,
-- and hoping no in-flight mail was still carrying the old signature.
--
-- This table allows multiple active keys per email domain so we can
-- do proper rotation with overlap:
--
--   1. Generate new key. Insert row with status='pending',
--      public_key published to DNS (for primary mode) OR displayed
--      in admin UI for manual DNS entry (for secondary/cname mode).
--   2. Wait for DNS propagation. For primary mode, the backend
--      verifies the TXT record exists before flipping status.
--      For manual mode, admin clicks "Activate" after confirming.
--   3. Flip new key status='active'. Now both old and new keys
--      can sign outgoing mail — configure Stalwart to use the
--      newest active key (by created_at DESC).
--   4. After grace period (default 7 days), old key transitions
--      from 'active' to 'retired'. Stalwart stops signing with it
--      but the public TXT record stays in DNS so in-flight mail
--      signed during the overlap still verifies.
--   5. After retention period (default 30 days from retirement),
--      the retired key is deleted entirely and its DNS TXT record
--      is removed.
--
-- email_domains.dkim_selector + dkim_public_key are kept as the
-- "current primary key" view for backwards compat with existing
-- callers. The rotation cron updates them to match the newest
-- active row in email_dkim_keys.

CREATE TABLE IF NOT EXISTS email_dkim_keys (
  id varchar(36) PRIMARY KEY,
  email_domain_id varchar(36) NOT NULL REFERENCES email_domains(id) ON DELETE CASCADE,
  selector varchar(63) NOT NULL,
  private_key_encrypted text NOT NULL,
  public_key text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  dns_verified_at timestamp,
  activated_at timestamp,
  retired_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_dkim_keys_domain_idx
  ON email_dkim_keys (email_domain_id);

CREATE INDEX IF NOT EXISTS email_dkim_keys_status_idx
  ON email_dkim_keys (status);

-- A given (email_domain_id, selector) must be unique so we can't
-- accidentally create duplicate keys with the same selector.
CREATE UNIQUE INDEX IF NOT EXISTS email_dkim_keys_domain_selector_unique
  ON email_dkim_keys (email_domain_id, selector);
