-- Phase 9 of the snapshot-storage overhaul: CIFS/SMB target support.
--
-- Extends the storage_type enum + backup_configurations with cifs_*
-- fields. The rclone smb backend talks to any SMB1/2/3 server (Hetzner
-- Storage Box, Samba, Windows shares, NetApp, TrueNAS). Operator picks
-- it alongside S3 + SSH in the BackupSettings UI.
--
-- Password storage: same encrypted pattern as ssh_key_encrypted /
-- s3_secret_key_encrypted — plaintext is encrypted with
-- PLATFORM_ENCRYPTION_KEY before insert. At Job time the server-side
-- handler decrypts + runs the rclone-obscure algorithm + passes the
-- obscured form via RCLONE_CONFIG_REMOTE_PASS.

-- ─── extend storage_type enum ──────────────────────────────────────────

ALTER TYPE "storage_type" ADD VALUE IF NOT EXISTS 'cifs';

-- ─── backup_configurations CIFS fields ─────────────────────────────────

ALTER TABLE "backup_configurations"
  ADD COLUMN IF NOT EXISTS "cifs_host" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "cifs_port" INTEGER DEFAULT 445,
  ADD COLUMN IF NOT EXISTS "cifs_share" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "cifs_user" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "cifs_password_encrypted" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "cifs_domain" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "cifs_path" VARCHAR(500);

-- ─── speedtest fields (Phase 10) ───────────────────────────────────────
--
-- Lands here with Phase 9 so we only need one ALTER round; the actual
-- speedtest endpoint + UI come in Phase 10. Defaults to NULL/never.

ALTER TABLE "backup_configurations"
  ADD COLUMN IF NOT EXISTS "last_speedtest_at" TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "last_speedtest_upload_mbps" NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS "last_speedtest_download_mbps" NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS "last_speedtest_latency_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "last_speedtest_payload_bytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "last_speedtest_error" TEXT;
