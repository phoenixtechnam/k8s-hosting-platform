-- Phase 2a: Stalwart SQL directory views and read-only role.
--
-- Stalwart Mail Server queries these views to resolve mailbox accounts,
-- email addresses, and local domains. The view layer keeps the platform
-- schema decoupled from Stalwart's expected column layout — if Stalwart's
-- query contract changes, only these views need to be updated.
--
-- Runtime access is via a dedicated `stalwart_reader` role with SELECT-only
-- rights on the stalwart schema. Other platform tables are NOT visible to
-- this role.
--
-- See docs/04-deployment/MAIL_SERVER_OPERATIONS.md §5 for the Stalwart
-- config that consumes these views.

CREATE SCHEMA IF NOT EXISTS stalwart;

-- Principals view: one row per active mailbox.
-- Stalwart's `name` query reads this; it expects columns: name, type, secret,
-- description, quota.
-- NOTE: the mailbox_type column in mailboxes is stored as camelCase
-- `mailboxType` (Drizzle default), which requires double-quoting in SQL.
CREATE OR REPLACE VIEW stalwart.principals AS
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
WHERE status = 'active';

-- Emails view: one row per (account, address) pair.
-- Stalwart's `emails`, `recipients`, `verify` queries read this.
-- For Phase 2a every mailbox has exactly one primary address (its
-- `full_address`); aliases are resolved separately in `expand`.
CREATE OR REPLACE VIEW stalwart.emails AS
SELECT
  full_address AS address,
  full_address AS name,
  'primary'::text AS type
FROM mailboxes
WHERE status = 'active';

-- Domains view: which domains Stalwart considers local.
-- Joins `email_domains` (the enable flag) to `domains` (the name).
-- Excludes `suspended` and `deleted` domain states so mail for a
-- suspended client is rejected at the edge rather than silently delivered.
-- `pending` domains (newly created, not yet DNS-verified) are allowed so
-- initial mailbox setup can exercise the mail server before verification.
CREATE OR REPLACE VIEW stalwart.domains AS
SELECT d.domain_name AS name
FROM email_domains ed
JOIN domains d ON d.id = ed.domain_id
WHERE ed.enabled = 1
  AND d.status IN ('active', 'pending');

-- Alias expansion view: one row per (source, destination) pair.
-- Stalwart's `expand` query uses this to route mail for alias addresses
-- to their underlying recipients. `email_aliases.destination_addresses` is
-- a JSONB array, unnested here.
CREATE OR REPLACE VIEW stalwart.alias_expansion AS
SELECT
  source_address AS list_address,
  jsonb_array_elements_text(destination_addresses) AS member_address
FROM email_aliases
WHERE enabled = 1;

-- Read-only role for Stalwart.
--
-- The role is created with NO password and NOLOGIN. A deployment-specific
-- step (local dev: scripts/local.sh _bootstrap_stalwart_reader; production:
-- the bootstrap job documented in docs/04-deployment/MAIL_SERVER_OPERATIONS.md §3.2)
-- must run `ALTER ROLE stalwart_reader WITH LOGIN PASSWORD '<secret>'`
-- before Stalwart can authenticate to the platform DB.
--
-- Rationale: committing a dev password to a SQL migration would let it
-- reach production environments via the normal migration runner.
--
-- The migrate runner tolerates duplicate_object (42710) on re-runs so the
-- CREATE ROLE statement is idempotent.
CREATE ROLE stalwart_reader NOLOGIN;

-- Grant minimal access to the stalwart schema only.
GRANT USAGE ON SCHEMA stalwart TO stalwart_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA stalwart TO stalwart_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA stalwart GRANT SELECT ON TABLES TO stalwart_reader;

-- Defense-in-depth: prevent accidental access to the `public` schema.
-- PostgreSQL 16 denies SELECT on `public` tables by default unless an
-- explicit grant exists, but a future `GRANT ... TO PUBLIC` would
-- implicitly apply to stalwart_reader. Revoke explicit rights and pin
-- the search_path so queries cannot resolve public objects even if
-- Stalwart sends an unqualified table name.
REVOKE ALL ON SCHEMA public FROM stalwart_reader;
ALTER ROLE stalwart_reader SET search_path = stalwart;
