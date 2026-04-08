-- Phase 3.C.3: enforce client + mailbox suspension at the Stalwart
-- SQL directory layer.
--
-- Previously the stalwart.principals view filtered only on
-- mailboxes.status = 'active', and stalwart.domains filtered on
-- domains.status but NOT on the owning clients.status. That meant:
--
--   - Suspending a client via the admin UI marked the client row as
--     suspended and cascaded to domains/deployments, but mailboxes
--     stayed active at the Stalwart level. A suspended customer
--     could still log in to IMAP and send mail.
--   - Individually suspended mailboxes (mailboxes.status = 'suspended')
--     worked correctly, but there was no path to cascade from client
--     suspension without mutating every mailbox row.
--
-- This migration replaces the three user-facing views with versions
-- that JOIN clients and exclude any row whose owning client is
-- suspended or cancelled. The suspend state is retained (data is
-- not deleted) but access is blocked at all four mail paths:
--
--   1. IMAP/POP login → stalwart.principals hides the row, auth fails
--   2. SMTP AUTH → same
--   3. SMTP delivery (incoming mail) → stalwart.domains hides the
--      domain, Stalwart rejects at 550 "relay access denied"
--   4. Address resolution → stalwart.emails hides the row
--
-- Webmail SSO is blocked separately in mailboxes/service.ts
-- generateWebmailToken (returns 403 when the client is suspended).

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
  AND c.status = 'active';

CREATE OR REPLACE VIEW stalwart.emails AS
SELECT
  m.full_address AS address,
  m.full_address AS name,
  'primary'::text AS type
FROM mailboxes m
JOIN clients c ON c.id = m.client_id
WHERE m.status = 'active'
  AND c.status = 'active';

CREATE OR REPLACE VIEW stalwart.domains AS
SELECT d.domain_name AS name
FROM email_domains ed
JOIN domains d ON d.id = ed.domain_id
JOIN clients c ON c.id = d.client_id
WHERE ed.enabled = 1
  AND d.status IN ('active', 'pending')
  AND c.status = 'active';

CREATE OR REPLACE VIEW stalwart.alias_expansion AS
SELECT
  ea.source_address AS list_address,
  jsonb_array_elements_text(ea.destination_addresses) AS member_address
FROM email_aliases ea
JOIN clients c ON c.id = ea.client_id
WHERE ea.enabled = 1
  AND c.status = 'active';
