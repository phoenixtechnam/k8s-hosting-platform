-- Migration 0070: Backfill existing 'pending' domains to 'unverified'.
-- The 'pending' value is retained in the enum for backwards compat with
-- the client_status, provisioning_status, etc. enums on other tables;
-- the domains table specifically migrates all pending rows to unverified.
UPDATE domains SET status = 'unverified' WHERE status = 'pending';
