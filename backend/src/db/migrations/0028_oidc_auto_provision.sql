ALTER TABLE oidc_providers ADD COLUMN IF NOT EXISTS auto_provision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_providers ADD COLUMN IF NOT EXISTS default_role VARCHAR(50) DEFAULT 'read_only';
ALTER TABLE oidc_providers ADD COLUMN IF NOT EXISTS additional_claims JSONB;
