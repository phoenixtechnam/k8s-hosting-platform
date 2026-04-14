-- Migration 0036: Platform system settings (single-row)

CREATE TABLE IF NOT EXISTS "system_settings" (
  "id" varchar(36) PRIMARY KEY,
  "platform_name" varchar(255) NOT NULL DEFAULT 'Hosting Platform',
  "admin_panel_url" varchar(500),
  "client_panel_url" varchar(500),
  "support_email" varchar(255),
  "support_url" varchar(500),
  "ingress_base_domain" varchar(255),
  "mail_hostname" varchar(255),
  "webmail_url" varchar(500),
  "api_rate_limit" integer NOT NULL DEFAULT 100,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- Seed the single settings row
INSERT INTO "system_settings" ("id", "platform_name")
VALUES ('system', 'Hosting Platform')
ON CONFLICT ("id") DO NOTHING;
