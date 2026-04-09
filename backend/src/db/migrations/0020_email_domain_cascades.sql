-- Phase 3 of client-panel email parity round 3 — add ON DELETE CASCADE
-- foreign keys for the domain/email-domain/mailbox tree so that
-- deleting a domain reliably removes all of its children in one
-- atomic operation.
--
-- Background: the initial schema (migration 0000) declared these
-- foreign-key columns as plain varchar(36) NOT NULL without any
-- REFERENCES clause. Deleting a domain therefore SILENTLY ORPHANED
-- every child row:
--   email_domains.domain_id  → domains(id)
--   email_domains.client_id  → clients(id)
--   mailboxes.email_domain_id → email_domains(id)
--   mailboxes.client_id      → clients(id)
--   email_aliases.email_domain_id → email_domains(id)
--   email_aliases.client_id  → clients(id)
--   dns_records.domain_id    → domains(id)
--   ingress_routes.domain_id → domains(id)
--
-- Consequences of the orphan state included (a) Stalwart's directory
-- views silently dropping mailboxes for deleted domains while the
-- rows stayed in the DB and (b) operators accruing invisible data
-- drift over time.
--
-- Strategy (single-shot):
--   1. Pre-flight: DELETE orphan rows that would block FK creation.
--      Each DELETE uses a WHERE NOT IN (SELECT id FROM parent) so
--      it's idempotent and safe to re-run on a clean DB.
--   2. Add the FK constraints with ON DELETE CASCADE.
--
-- IRREVERSIBLE: orphan rows deleted by step 1 cannot be recovered.
-- Operators with production data should ensure any rows whose
-- parent domain still exists are preserved (the WHERE NOT IN clause
-- only targets true orphans).

-- ─── Step 1: pre-flight orphan cleanup ──────────────────────────────

-- email_domains without a matching domains row
DELETE FROM email_domains
  WHERE domain_id NOT IN (SELECT id FROM domains);

-- email_domains without a matching clients row
DELETE FROM email_domains
  WHERE client_id NOT IN (SELECT id FROM clients);

-- mailboxes whose email_domain_id no longer exists
DELETE FROM mailboxes
  WHERE email_domain_id NOT IN (SELECT id FROM email_domains);

-- mailboxes without a matching clients row
DELETE FROM mailboxes
  WHERE client_id NOT IN (SELECT id FROM clients);

-- email_aliases whose email_domain_id no longer exists
DELETE FROM email_aliases
  WHERE email_domain_id NOT IN (SELECT id FROM email_domains);

-- email_aliases without a matching clients row
DELETE FROM email_aliases
  WHERE client_id NOT IN (SELECT id FROM clients);

-- dns_records whose domain_id no longer exists
DELETE FROM dns_records
  WHERE domain_id NOT IN (SELECT id FROM domains);

-- ingress_routes whose domain_id no longer exists
DELETE FROM ingress_routes
  WHERE domain_id NOT IN (SELECT id FROM domains);

-- mailbox_access rows whose mailbox no longer exists. Review-3
-- HIGH-2: without this FK the cascade path
-- domain → email_domain → mailbox leaves orphan access rows behind.
DELETE FROM mailbox_access
  WHERE mailbox_id NOT IN (SELECT id FROM mailboxes);

-- ─── Step 2: add the ON DELETE CASCADE foreign keys ─────────────────

ALTER TABLE email_domains
  ADD CONSTRAINT fk_email_domains_domain_id
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE;

ALTER TABLE email_domains
  ADD CONSTRAINT fk_email_domains_client_id
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE mailboxes
  ADD CONSTRAINT fk_mailboxes_email_domain_id
  FOREIGN KEY (email_domain_id) REFERENCES email_domains(id) ON DELETE CASCADE;

ALTER TABLE mailboxes
  ADD CONSTRAINT fk_mailboxes_client_id
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE email_aliases
  ADD CONSTRAINT fk_email_aliases_email_domain_id
  FOREIGN KEY (email_domain_id) REFERENCES email_domains(id) ON DELETE CASCADE;

ALTER TABLE email_aliases
  ADD CONSTRAINT fk_email_aliases_client_id
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE dns_records
  ADD CONSTRAINT fk_dns_records_domain_id
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE;

ALTER TABLE ingress_routes
  ADD CONSTRAINT fk_ingress_routes_domain_id
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE;

-- Review-3 HIGH-2: mailbox_access cascade. Without this, orphan
-- rows accumulate in mailbox_access whenever a mailbox is removed
-- via the new cascade chain (domain → email_domain → mailbox).
ALTER TABLE mailbox_access
  ADD CONSTRAINT fk_mailbox_access_mailbox_id
  FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE;
