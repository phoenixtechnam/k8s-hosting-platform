-- Phase 3 T5.1: Stalwart submission directory view.
--
-- The Stalwart `principals` query resolves a principal by name and
-- returns (name, type, secret, description, quota). For sendmail-
-- compat submission credentials we need these principals to be
-- accepted at the SMTP SUBMISSION port (587) but NOT have a mailbox
-- to receive mail.
--
-- We can't use `individual` (that would provision a mailbox) and we
-- can't use `group` (that needs real recipients). Stalwart supports
-- a `class` value of `individual` for any authentication principal;
-- the directory query returns only what's needed to verify password
-- and enforce quota. Since submission credentials have no quota and
-- no inbox, we return quota = 0 and rely on mailbox lookup failing
-- at delivery time (these users aren't in `stalwart.emails`).
--
-- The principals view is EXTENDED (not replaced) by UNION ALL-ing
-- the regular mailbox principals with the submit credentials. The
-- new view `stalwart.principals` replaces the old one so Stalwart
-- picks up the new rows automatically via the existing `name` query.
--
-- Rate limiting: Stalwart's [queue.throttle] matches on the
-- authenticated principal. Since our submit usernames are scoped
-- per-client (`submit-<client_id>`), the existing throttle rules
-- keyed on `sender` effectively rate-limit at the client level.

DROP VIEW IF EXISTS stalwart.principals CASCADE;

CREATE VIEW stalwart.principals AS
-- Row-per-mailbox (unchanged from migration 0004_stalwart_directory.sql)
SELECT
  full_address AS name,
  CASE "mailboxType"
    WHEN 'forward_only' THEN 'group'
    ELSE 'individual'
  END AS type,
  password_hash AS secret,
  COALESCE(display_name, full_address) AS description,
  (quota_mb::bigint * 1024 * 1024) AS quota
FROM mailboxes
WHERE status = 'active'

UNION ALL

-- Row-per-active-submit-credential (new)
SELECT
  msc.username AS name,
  'individual'::text AS type,
  msc.password_hash AS secret,
  CONCAT('Submit credential for client ', msc.client_id) AS description,
  0::bigint AS quota
FROM mail_submit_credentials msc
WHERE msc.revoked_at IS NULL;

-- Recreate the grants after DROP VIEW ... CASCADE (CASCADE may have
-- revoked them).
GRANT SELECT ON stalwart.principals TO stalwart_reader;

-- NOTE for operators: Stalwart's PostgreSQL client caches prepared
-- statement plans on the connection. Replacing a view invalidates
-- those cached plans, so existing Stalwart connections will throw
-- "cached plan must not change result type" (PG error 0A000) until
-- they reconnect. After applying this migration, restart the
-- Stalwart pod(s) so they open fresh connections:
--
--   kubectl -n mail delete pod -l app=stalwart-mail
--
-- Or include the migration in a blue/green deploy where Stalwart
-- is restarted after the DB migration runs.
