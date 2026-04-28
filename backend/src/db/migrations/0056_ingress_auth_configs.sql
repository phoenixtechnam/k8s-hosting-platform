-- Customer-managed OAuth2/OIDC ingress access control.
--
-- Each tenant ingress can opt into OIDC-gated access via an
-- entry in ingress_auth_configs. The platform-api reconciler
-- maintains a per-client oauth2-proxy + claim-validator Deployment
-- (one per client namespace) and injects nginx auth-request
-- annotations on enabled ingresses.
--
-- See docs/04-deployment/INGRESS_ACCESS_CONTROL.md for the full
-- contract, supported flows (PKCE / code), token-endpoint auth
-- methods (basic / post), response types (code / id_token /
-- code id_token), and the claim rule grammar.

CREATE TABLE IF NOT EXISTS ingress_auth_configs (
  id varchar(36) PRIMARY KEY,
  -- One config per ingress; CASCADE clears the row when an
  -- ingress is deleted, which the reconciler picks up on its
  -- next tick to also tear down the proxy if no others remain.
  ingress_route_id varchar(36) NOT NULL UNIQUE
    REFERENCES ingress_routes(id) ON DELETE CASCADE,

  enabled boolean NOT NULL DEFAULT false,

  -- OIDC discovery / client
  issuer_url varchar(500) NOT NULL,
  client_id varchar(255) NOT NULL,
  client_secret_encrypted text NOT NULL,

  -- Token-endpoint authentication method:
  --   client_secret_basic | client_secret_post
  auth_method varchar(32) NOT NULL DEFAULT 'client_secret_basic',

  -- Response type returned from /authorize:
  --   code | id_token | code_id_token
  response_type varchar(32) NOT NULL DEFAULT 'code',

  -- PKCE S256 — recommended for public clients and confidential
  -- clients alike (defence-in-depth against authcode interception).
  use_pkce boolean NOT NULL DEFAULT true,

  scopes varchar(500) NOT NULL DEFAULT 'openid profile email',

  -- Allow lists. NULL or empty = no restriction beyond a successful
  -- OIDC login. Stored as comma-separated strings so the UI's chip
  -- editor maps cleanly without an extra join table.
  allowed_emails text,
  allowed_email_domains text,
  allowed_groups text,

  -- Custom claim rules. JSON array of objects:
  --   [{"claim":"membership","operator":"contains","value":"paid"}]
  -- All rules must pass (AND). Supported operators:
  --   equals | not_equals | contains | not_contains | in | not_in
  --   exists | regex
  -- The claim-validator sidecar evaluates these against the ID token
  -- claims after oauth2-proxy validates the session. NULL = no rules.
  claim_rules jsonb,

  -- Identity propagation to the upstream app. Headers added by
  -- oauth2-proxy when each flag is true:
  --   pass_user_headers       → X-Auth-Request-User, -Email, -Preferred-Username
  --   pass_access_token       → X-Auth-Request-Access-Token
  --   pass_id_token           → X-Auth-Request-Id-Token
  --   pass_authorization_header → Authorization: Bearer <id_token>
  --   set_xauthrequest        → enables the X-Auth-Request-* family
  pass_authorization_header boolean NOT NULL DEFAULT true,
  pass_access_token boolean NOT NULL DEFAULT true,
  pass_id_token boolean NOT NULL DEFAULT true,
  pass_user_headers boolean NOT NULL DEFAULT true,
  set_xauthrequest boolean NOT NULL DEFAULT true,

  -- Cookie / session. cookie_domain auto-derived from the ingress
  -- hostname when NULL. Override only needed for cross-subdomain SSO.
  cookie_domain varchar(255),
  cookie_refresh_seconds integer NOT NULL DEFAULT 3600,
  cookie_expire_seconds integer NOT NULL DEFAULT 86400,

  -- Audit
  last_error text,
  last_reconciled_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ingress_auth_configs_enabled_idx
  ON ingress_auth_configs (enabled) WHERE enabled = true;

-- Per-client oauth2-proxy lifecycle state. The reconciler reads
-- this to decide whether the proxy resources already exist (and
-- therefore the cookie-secret has been generated) or whether to
-- provision from scratch.
CREATE TABLE IF NOT EXISTS client_oauth2_proxy_state (
  client_id varchar(36) PRIMARY KEY
    REFERENCES clients(id) ON DELETE CASCADE,
  cookie_secret_encrypted text NOT NULL,
  provisioned boolean NOT NULL DEFAULT false,
  last_provisioned_at timestamp,
  last_error text
);
