ALTER TABLE oidc_global_settings ADD COLUMN IF NOT EXISTS oauth2_proxy_cookie_secret_encrypted TEXT;
