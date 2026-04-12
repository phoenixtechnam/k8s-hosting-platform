-- SFTP Users table
CREATE TABLE IF NOT EXISTS "sftp_users" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "client_id" varchar(36) NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "username" varchar(100) NOT NULL,
  "password_hash" varchar(255),
  "description" varchar(255),
  "enabled" integer NOT NULL DEFAULT 1,
  "home_path" varchar(512) NOT NULL DEFAULT '/',
  "allow_write" integer NOT NULL DEFAULT 1,
  "allow_delete" integer NOT NULL DEFAULT 0,
  "ip_whitelist" text,
  "max_concurrent_sessions" integer NOT NULL DEFAULT 3,
  "last_login_at" timestamp,
  "last_login_ip" varchar(45),
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "sftp_users_username_unique" ON "sftp_users" ("username");
CREATE INDEX IF NOT EXISTS "sftp_users_client_idx" ON "sftp_users" ("client_id");
CREATE INDEX IF NOT EXISTS "sftp_users_expires_idx" ON "sftp_users" ("expires_at");

-- SFTP Audit Log table
CREATE TABLE IF NOT EXISTS "sftp_audit_log" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "sftp_user_id" varchar(36) REFERENCES "sftp_users"("id") ON DELETE SET NULL,
  "client_id" varchar(36) NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "event" varchar(50) NOT NULL,
  "source_ip" varchar(45) NOT NULL,
  "protocol" varchar(10) NOT NULL DEFAULT 'sftp',
  "session_id" varchar(128),
  "duration_seconds" integer,
  "bytes_transferred" numeric(18, 0),
  "error_message" varchar(512),
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "sftp_audit_client_idx" ON "sftp_audit_log" ("client_id", "created_at");
CREATE INDEX IF NOT EXISTS "sftp_audit_user_idx" ON "sftp_audit_log" ("sftp_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "sftp_audit_created_idx" ON "sftp_audit_log" ("created_at");
