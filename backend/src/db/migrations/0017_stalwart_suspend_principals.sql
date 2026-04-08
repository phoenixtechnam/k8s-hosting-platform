-- Phase 3 (post-Phase-3 hardening): tighten stalwart.principals view to
-- also exclude mailboxes whose owning client is suspended.
--
-- Pre-fix state:
--   - stalwart.emails  filters on (mailbox.status='active' AND client.status IN ('active','pending'))
--   - stalwart.domains filters on (email_domains.enabled=1 AND domain.status IN ('active','pending') AND client.status IN ('active','pending'))
--   - stalwart.principals filters on (mailboxes.status='active') ONLY
--
-- The mismatch meant a suspended client's mailbox could still SUCCEED
-- at SMTP AUTH (the principals query returned the bcrypt hash) but
-- subsequent commands would fail because the address wasn't in
-- stalwart.emails. Side effects:
--   - Authentication errors are revealed only after AUTH success,
--     leaking information about which accounts exist
--   - Brute-force attempts against suspended accounts still succeed
--     enough to consume CPU on bcrypt validation
--   - Discrepancy between domain/email filters and principal filters
--     was confusing for operators tracing access logs
--
-- This migration replaces stalwart.principals with a tighter version
-- that joins through mailbox → client and excludes any client whose
-- status is not 'active' or 'pending'. The mail_submit_credentials
-- branch retains the same join to clients to keep its filter aligned.
--
-- Operator note: Stalwart caches prepared statement plans on its
-- Postgres connection. After applying this migration, restart the
-- Stalwart pod so it opens fresh connections:
--
--   kubectl -n mail delete pod -l app=stalwart-mail
--
-- (Same caveat as migration 0014.)

DROP VIEW IF EXISTS stalwart.principals CASCADE;

CREATE VIEW stalwart.principals AS
SELECT
  m.full_address AS name,
  CASE m."mailboxType"
    WHEN 'forward_only' THEN 'group'
    ELSE 'individual'
  END AS type,
  m.password_hash AS secret,
  COALESCE(m.display_name, m.full_address) AS description,
  (m.quota_mb::bigint * 1024 * 1024) AS quota
FROM mailboxes m
INNER JOIN clients c ON c.id = m.client_id
WHERE m.status = 'active'
  AND c.status IN ('active', 'pending')

UNION ALL

SELECT
  msc.username AS name,
  'individual'::text AS type,
  msc.password_hash AS secret,
  CONCAT('Submit credential for client ', msc.client_id) AS description,
  0::bigint AS quota
FROM mail_submit_credentials msc
INNER JOIN clients c ON c.id = msc.client_id
WHERE msc.revoked_at IS NULL
  AND c.status IN ('active', 'pending');

GRANT SELECT ON stalwart.principals TO stalwart_reader;
