-- Split OIDC config: provider (per-client, reusable) vs ingress
-- access policy (per-ingress, references provider).
--
-- Why: a client running OIDC on N ingresses with the same IdP would
-- otherwise paste the same client_id + client_secret N times. Secret
-- rotation becomes an N-row UPDATE; OIDC discovery probe runs N
-- times; consistency drift is hand-managed. Normalising to a provider
-- table makes one provider serve any number of ingresses.
--
-- Migration is data-preserving: the data block synthesises one
-- provider row per existing ingress_auth_configs row, then rewires
-- the FK before dropping the moved columns.

CREATE TABLE IF NOT EXISTS client_oidc_providers (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  -- Operator-facing label shown in the provider dropdown. Doesn't
  -- have to be unique across providers (operator may have two
  -- "Google" entries for two different OAuth apps).
  name varchar(120) NOT NULL,
  issuer_url varchar(500) NOT NULL,
  oauth_client_id varchar(255) NOT NULL,
  oauth_client_secret_encrypted text NOT NULL,
  -- Token-endpoint authentication method. See ingress_auth_configs
  -- comment block in 0056 for the supported values.
  auth_method varchar(32) NOT NULL DEFAULT 'client_secret_basic',
  response_type varchar(32) NOT NULL DEFAULT 'code',
  use_pkce boolean NOT NULL DEFAULT true,
  -- Scopes used by every ingress that picks this provider, unless
  -- the ingress sets scopes_override.
  default_scopes varchar(500) NOT NULL DEFAULT 'openid profile email',
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_oidc_providers_client_idx
  ON client_oidc_providers (client_id);

-- Reshape ingress_auth_configs:
--   1) Add provider_id (nullable initially so we can populate it)
--   2) Add post_login_redirect_url (new feature)
--   3) Add scopes_override (was `scopes`, now optional override)
--   4) Backfill provider_id from existing inline OIDC fields
--   5) Make provider_id NOT NULL + drop the inline columns.

ALTER TABLE ingress_auth_configs
  ADD COLUMN IF NOT EXISTS provider_id varchar(36)
    REFERENCES client_oidc_providers(id) ON DELETE RESTRICT,
  -- Optional override for the rd= parameter on /oauth2/start.
  -- When NULL, oauth2-proxy honours the original request URI
  -- (default browser-back behaviour). When set, every successful
  -- login lands on this URL — useful for forwarding into an app's
  -- own OIDC callback or a fixed post-login landing page.
  ADD COLUMN IF NOT EXISTS post_login_redirect_url varchar(2048),
  -- Per-ingress override of the provider's default_scopes. NULL =
  -- inherit. Keeps the scopes column logically separate from the
  -- provider so a single provider can serve ingresses with
  -- different scope sets.
  ADD COLUMN IF NOT EXISTS scopes_override varchar(500);

-- Data migration. Done in a DO block so repeated runs (the file
-- runner re-applies each migration once, but we still want IF NOT
-- EXISTS-style guards in case of partial failure).
DO $$
DECLARE
  rec RECORD;
  new_provider_id text;
BEGIN
  -- Only operate on rows that still carry the legacy inline columns.
  -- Once provider_id is populated + columns dropped, this block is
  -- a no-op on re-run.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ingress_auth_configs' AND column_name = 'issuer_url'
  ) THEN
    FOR rec IN
      SELECT iac.id AS cfg_id,
             iac.issuer_url,
             iac.client_id AS oauth_client_id,
             iac.client_secret_encrypted,
             iac.auth_method,
             iac.response_type,
             iac.use_pkce,
             iac.scopes,
             d.client_id AS platform_client_id,
             ir.hostname
      FROM ingress_auth_configs iac
      JOIN ingress_routes ir ON ir.id = iac.ingress_route_id
      JOIN domains d ON d.id = ir.domain_id
      WHERE iac.provider_id IS NULL
    LOOP
      new_provider_id := gen_random_uuid()::text;
      INSERT INTO client_oidc_providers (
        id, client_id, name, issuer_url, oauth_client_id,
        oauth_client_secret_encrypted, auth_method, response_type,
        use_pkce, default_scopes
      ) VALUES (
        new_provider_id,
        rec.platform_client_id,
        'Migrated provider for ' || rec.hostname,
        rec.issuer_url,
        rec.oauth_client_id,
        rec.client_secret_encrypted,
        rec.auth_method,
        rec.response_type,
        rec.use_pkce,
        rec.scopes
      );
      UPDATE ingress_auth_configs
        SET provider_id = new_provider_id,
            scopes_override = NULL  -- migrated cfg uses provider's scopes verbatim
        WHERE id = rec.cfg_id;
    END LOOP;
  END IF;
END $$;

-- Lock down provider_id and drop the legacy inline columns.
ALTER TABLE ingress_auth_configs
  ALTER COLUMN provider_id SET NOT NULL;

ALTER TABLE ingress_auth_configs
  DROP COLUMN IF EXISTS issuer_url,
  DROP COLUMN IF EXISTS client_id,
  DROP COLUMN IF EXISTS client_secret_encrypted,
  DROP COLUMN IF EXISTS auth_method,
  DROP COLUMN IF EXISTS response_type,
  DROP COLUMN IF EXISTS use_pkce,
  DROP COLUMN IF EXISTS scopes;

CREATE INDEX IF NOT EXISTS ingress_auth_configs_provider_idx
  ON ingress_auth_configs (provider_id);
