-- Phase 12.5 follow-up: SSH backup targets can authenticate via password
-- in addition to (or instead of) a PEM private key.
--
-- Rationale: not every operator wants to manage SSH keypairs for their
-- backup destination. Many SFTP services (Hetzner Storage Box, corporate
-- file servers) accept password auth out of the box. This migration adds
-- the optional `ssh_password_encrypted` column; existing rows with
-- `ssh_key_encrypted` keep working unchanged. At runtime the resolver
-- prefers key over password when both are set (operator override via
-- clearing one of the fields).
--
-- Password storage: same encrypted-at-rest pattern as cifs_password —
-- AES-256-GCM via PLATFORM_ENCRYPTION_KEY. At Job time the server-side
-- handler decrypts + runs rclone-obscure + passes the obscured form via
-- RCLONE_CONFIG_REMOTE_PASS (same env var name SMB uses; rclone parses
-- per-backend).

ALTER TABLE backup_configurations
  ADD COLUMN IF NOT EXISTS ssh_password_encrypted text;

-- DB-level CHECK so neither the API nor the UI can persist an SSH
-- target with NO credentials. ssh_key_encrypted or ssh_password_encrypted
-- (or both) must be present whenever storage_type = 'ssh'.
-- Note: the column was created at v0001 as the quoted camelCase
-- identifier "storageType" (drizzle's default quoting), not the
-- snake_case `storage_type` you'd expect. Subsequent migrations
-- have to use the quoted form to match.
--
-- `NOT VALID` is intentional: pre-existing rows that were created
-- without proper credentials (dev seed data, test fixtures, broken
-- migrations) would otherwise block the ALTER. Those rows fail the
-- runtime resolver anyway (resolveSnapshotStoreForClass throws
-- TARGET_INCOMPLETE 400), so they're effectively dead letters.
-- Future INSERTs and UPDATEs WILL be enforced.
ALTER TABLE backup_configurations
  ADD CONSTRAINT ssh_must_have_credentials
  CHECK (
    "storageType" <> 'ssh'
    OR ssh_key_encrypted IS NOT NULL
    OR ssh_password_encrypted IS NOT NULL
  )
  NOT VALID;
