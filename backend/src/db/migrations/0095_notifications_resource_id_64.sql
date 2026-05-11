-- Widen notifications.resource_id from VARCHAR(36) to VARCHAR(64).
--
-- The 36-char cap originated from the original "resource_id = UUID"
-- model. Newer surfaces use prefixed identifiers — most notably the
-- tenant-bundles orchestrator publishes `notifyUser(resourceId =
-- bkp-<uuid>)` which is 40 chars. createNotification()'s
-- fire-and-forget try/catch silently swallowed the
-- `value too long for type character varying(36)` insert error,
-- so failed-backup notifications never landed in the bell despite
-- the orchestrator believing it had sent them. Caught on staging
-- 2026-05-11.
--
-- 64 chars accommodates the current `bkp-<uuid>` form (40), the
-- pre-CNPG mailbox restore identifiers (up to 50), and leaves
-- room for future `<resource-kind>-<uuid>` patterns without
-- requiring another migration.

ALTER TABLE notifications
  ALTER COLUMN resource_id TYPE VARCHAR(64);
