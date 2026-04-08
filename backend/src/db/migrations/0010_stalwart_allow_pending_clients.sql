-- Phase 3.C.3 follow-up: the original 0009 migration restricted the
-- stalwart views to c.status = 'active' which was too strict. Newly
-- created clients land in status='pending' by default and don't flip
-- to 'active' until provisioning completes (which for email only
-- work doesn't necessarily happen). Blocking 'pending' meant a new
-- customer couldn't set up their first mailbox.
--
-- The real intent was: block 'suspended' and 'cancelled' states,
-- allow 'active' and 'pending'. This matches how the stalwart.domains
-- view already filtered domain status.

CREATE OR REPLACE VIEW stalwart.principals AS
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
JOIN clients c ON c.id = m.client_id
WHERE m.status = 'active'
  AND c.status IN ('active', 'pending');

CREATE OR REPLACE VIEW stalwart.emails AS
SELECT
  m.full_address AS address,
  m.full_address AS name,
  'primary'::text AS type
FROM mailboxes m
JOIN clients c ON c.id = m.client_id
WHERE m.status = 'active'
  AND c.status IN ('active', 'pending');

CREATE OR REPLACE VIEW stalwart.domains AS
SELECT d.domain_name AS name
FROM email_domains ed
JOIN domains d ON d.id = ed.domain_id
JOIN clients c ON c.id = d.client_id
WHERE ed.enabled = 1
  AND d.status IN ('active', 'pending')
  AND c.status IN ('active', 'pending');

CREATE OR REPLACE VIEW stalwart.alias_expansion AS
SELECT
  ea.source_address AS list_address,
  jsonb_array_elements_text(ea.destination_addresses) AS member_address
FROM email_aliases ea
JOIN clients c ON c.id = ea.client_id
WHERE ea.enabled = 1
  AND c.status IN ('active', 'pending');
