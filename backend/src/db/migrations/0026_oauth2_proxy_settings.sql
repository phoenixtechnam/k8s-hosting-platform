ALTER TABLE oidc_global_settings ADD COLUMN IF NOT EXISTS protect_admin_via_proxy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_global_settings ADD COLUMN IF NOT EXISTS protect_client_via_proxy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_global_settings ADD COLUMN IF NOT EXISTS break_glass_path VARCHAR(100);
