-- Drop 'cancelled' from client_status enum.
--
-- Rationale: the lifecycle terminal state was renamed to "delete" which
-- hard-removes the client row from the database (no persistent state).
-- The 'cancelled' value was never reachable in production code (no call
-- site sets status='cancelled'), and leaving it in the enum clutters
-- the API contract.
--
-- PostgreSQL doesn't support ALTER TYPE ... DROP VALUE. The only way
-- to remove an enum value is to recreate the type. We guard with a
-- pre-check so re-running this migration on an already-migrated
-- database is a no-op.

DO $$
DECLARE
  stuck_count int;
BEGIN
  -- Refuse to run if any client row still has status='cancelled' —
  -- data migration needed first. This should never trip because no
  -- production code writes the value, but defense-in-depth.
  SELECT COUNT(*) INTO stuck_count FROM clients WHERE status = 'cancelled';
  IF stuck_count > 0 THEN
    RAISE EXCEPTION 'Cannot drop cancelled status: % client(s) still have status=cancelled. Migrate them first.', stuck_count;
  END IF;

  -- Skip if the enum no longer contains 'cancelled'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'client_status' AND e.enumlabel = 'cancelled'
  ) THEN
    RAISE NOTICE 'client_status already lacks cancelled; skipping';
    RETURN;
  END IF;

  -- Four stalwart.* views reference client_status via `c.status`. Drop
  -- them all before the enum swap, then recreate identically. Any new
  -- view that adds a client_status reference must be handled here.
  CREATE TYPE client_status_new AS ENUM ('active', 'suspended', 'archived', 'pending');

  DROP VIEW IF EXISTS stalwart.emails;
  DROP VIEW IF EXISTS stalwart.domains;
  DROP VIEW IF EXISTS stalwart.alias_expansion;
  DROP VIEW IF EXISTS stalwart.principals;

  ALTER TABLE clients
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN status TYPE client_status_new USING status::text::client_status_new,
    ALTER COLUMN status SET DEFAULT 'pending'::client_status_new;

  DROP TYPE client_status;
  ALTER TYPE client_status_new RENAME TO client_status;

  CREATE VIEW stalwart.emails AS
    SELECT m.full_address AS address,
           m.full_address AS name,
           'primary'::text AS type
    FROM mailboxes m
    JOIN clients c ON c.id::text = m.client_id::text
    WHERE m.status = 'active'::mailbox_status
      AND (c.status = ANY (ARRAY['active'::client_status, 'pending'::client_status]));

  CREATE VIEW stalwart.domains AS
    SELECT d.domain_name AS name
    FROM email_domains ed
    JOIN domains d ON d.id::text = ed.domain_id::text
    JOIN clients c ON c.id::text = d.client_id::text
    WHERE ed.enabled = 1
      AND (d.status = ANY (ARRAY['active'::domain_status, 'pending'::domain_status]))
      AND (c.status = ANY (ARRAY['active'::client_status, 'pending'::client_status]));

  CREATE VIEW stalwart.alias_expansion AS
    SELECT ea.source_address AS list_address,
           jsonb_array_elements_text(ea.destination_addresses) AS member_address
    FROM email_aliases ea
    JOIN clients c ON c.id::text = ea.client_id::text
    WHERE ea.enabled = 1
      AND (c.status = ANY (ARRAY['active'::client_status, 'pending'::client_status]));

  CREATE VIEW stalwart.principals AS
    SELECT m.full_address AS name,
           CASE m."mailboxType"
               WHEN 'forward_only'::mailbox_type THEN 'group'::text
               ELSE 'individual'::text
           END AS type,
           m.password_hash AS secret,
           COALESCE(m.display_name, m.full_address) AS description,
           m.quota_mb::bigint * 1024 * 1024 AS quota
    FROM mailboxes m
    JOIN clients c ON c.id::text = m.client_id::text
    WHERE m.status = 'active'::mailbox_status
      AND (c.status = ANY (ARRAY['active'::client_status, 'pending'::client_status]))
    UNION ALL
    SELECT msc.username AS name,
           'individual'::text AS type,
           msc.password_hash AS secret,
           concat('Submit credential for client ', msc.client_id) AS description,
           0::bigint AS quota
    FROM mail_submit_credentials msc
    JOIN clients c ON c.id::text = msc.client_id::text
    WHERE msc.revoked_at IS NULL
      AND (c.status = ANY (ARRAY['active'::client_status, 'pending'::client_status]));
END$$;
