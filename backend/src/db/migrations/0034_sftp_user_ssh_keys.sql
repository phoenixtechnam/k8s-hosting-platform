-- Link SSH keys to specific SFTP users (H-3: scope keys to individual users)
CREATE TABLE IF NOT EXISTS "sftp_user_ssh_keys" (
  "id" varchar(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  "sftp_user_id" varchar(36) NOT NULL REFERENCES "sftp_users"("id") ON DELETE CASCADE,
  "ssh_key_id" varchar(36) NOT NULL REFERENCES "ssh_keys"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE("sftp_user_id", "ssh_key_id")
);
CREATE INDEX IF NOT EXISTS "sftp_user_ssh_keys_user_idx" ON "sftp_user_ssh_keys" ("sftp_user_id");
CREATE INDEX IF NOT EXISTS "sftp_user_ssh_keys_key_idx" ON "sftp_user_ssh_keys" ("ssh_key_id");
