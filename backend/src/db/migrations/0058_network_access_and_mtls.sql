-- Multi-mode network/auth foundation:
--   * deployment_network_access_configs — per-deployment Ziti tunneler
--     or zrok share (modes A and C of the access-control design)
--   * ingress_mtls_configs              — per-ingress mTLS gate (mode B)
--   * client_ziti_providers             — reusable Ziti controller +
--     enrollment JWT, referenced by tunneler-mode deployments
--   * client_zrok_accounts              — reusable zrok account
--     (BYO controller URL — supports self-hosted zrok), referenced by
--     zrok-mode deployments
--   * domains.suppress_public_ingress    — flag toggled by the
--     deployment-network-access reconciler when a deployment goes
--     mesh-only; annotation-sync skips Ingress creation when set
--   * client_mesh_proxy_state           — per-(client, kind) state
--     row mirroring client_oauth2_proxy_state shape but generalized
--     so tunneler and zrok don't fight over a shared row
--
-- Each table includes last_error / last_reconciled_at for the same
-- reasons as ingress_auth_configs (UI surface for failures).
--
-- All FKs ON DELETE CASCADE on the client/deployment side and
-- ON DELETE RESTRICT on the provider side: deleting a provider that's
-- still in use is rejected by the DB so the operator must detach
-- consumers first (matches the consumer-count UX in the settings UI).

-- ─── client_ziti_providers ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_ziti_providers (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  controller_url varchar(500) NOT NULL,
  -- Enrollment JWT, encrypted with OIDC_ENCRYPTION_KEY (reused for v1).
  -- One-shot token: invalidated by the controller on first use.
  enrollment_jwt_encrypted text,
  -- Set by the reconciler after ziti-edge-tunnel reports a successful
  -- enrollment. Used to display "cert expires in N days" in UI.
  cert_expires_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_ziti_providers_client_idx
  ON client_ziti_providers(client_id);

-- ─── client_zrok_accounts ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS client_zrok_accounts (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  -- Default 'https://api.zrok.io' for hosted; full URL for self-hosted.
  -- Always required so customers explicitly choose between the two.
  controller_url varchar(500) NOT NULL,
  account_email varchar(255) NOT NULL,
  account_token_encrypted text NOT NULL,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_zrok_accounts_client_idx
  ON client_zrok_accounts(client_id);

-- ─── ingress_mtls_configs (mode B) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS ingress_mtls_configs (
  id varchar(36) PRIMARY KEY,
  ingress_route_id varchar(36) NOT NULL UNIQUE
    REFERENCES ingress_routes(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- PEM-encoded CA bundle, encrypted at rest. NULLable so an operator
  -- can create the row before uploading the bundle (matches OIDC's
  -- two-step UX) but enabled=true requires it.
  ca_cert_pem_encrypted text,
  -- SHA-256 fingerprint of the CA cert DER, hex-encoded; computed
  -- server-side on upload, used for visual diff in UI.
  ca_cert_fingerprint varchar(64),
  -- Subject DN of the first cert in the bundle; for human display.
  ca_cert_subject varchar(500),
  ca_cert_expires_at timestamp,
  -- NGINX auth-tls-verify-client mode: 'on' | 'optional' | 'optional_no_ca'
  verify_mode varchar(32) NOT NULL DEFAULT 'on',
  -- Optional Subject regex applied AFTER cert validation.
  subject_regex varchar(500),
  pass_cert_to_upstream boolean NOT NULL DEFAULT false,
  pass_dn_to_upstream boolean NOT NULL DEFAULT true,
  last_error text,
  last_reconciled_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

-- ─── deployment_network_access_configs (modes A + C) ────────────────

CREATE TABLE IF NOT EXISTS deployment_network_access_configs (
  deployment_id varchar(36) PRIMARY KEY
    REFERENCES deployments(id) ON DELETE CASCADE,
  -- 'public' (no machinery) | 'tunneler' (Ziti) | 'zrok' (private share)
  mode varchar(32) NOT NULL DEFAULT 'public',
  ziti_provider_id varchar(36)
    REFERENCES client_ziti_providers(id) ON DELETE RESTRICT,
  -- Customer-defined name of the Ziti service this deployment binds to.
  ziti_service_name varchar(255),
  zrok_provider_id varchar(36)
    REFERENCES client_zrok_accounts(id) ON DELETE RESTRICT,
  zrok_share_token varchar(255),
  pass_identity_headers boolean NOT NULL DEFAULT true,
  -- True when the per-client mesh proxy pod has been provisioned.
  -- Mirrors client_oauth2_proxy_state.provisioned but per-deployment.
  provisioned boolean NOT NULL DEFAULT false,
  -- True when the public Ingress for routes pointing at this deployment
  -- is suppressed (because mode='tunneler'). Driven by the reconciler;
  -- annotation-sync reads this to short-circuit Ingress creation.
  public_ingress_suppressed boolean NOT NULL DEFAULT false,
  last_error text,
  last_reconciled_at timestamp,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deployment_network_access_ziti_idx
  ON deployment_network_access_configs(ziti_provider_id);
CREATE INDEX IF NOT EXISTS deployment_network_access_zrok_idx
  ON deployment_network_access_configs(zrok_provider_id);

-- ─── client_mesh_proxy_state ────────────────────────────────────────
-- One row per (client, kind) where kind is 'ziti-tunneler' or
-- 'zrok-frontdoor'. Provides the same role as client_oauth2_proxy_state
-- but allows multiple kinds of mesh proxies per client to coexist
-- (e.g. one deployment uses Ziti, another uses zrok in the same client).

CREATE TABLE IF NOT EXISTS client_mesh_proxy_state (
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  provisioned boolean NOT NULL DEFAULT false,
  last_provisioned_at timestamp,
  last_error text,
  PRIMARY KEY (client_id, kind)
);

-- ─── domains.suppress_public_ingress ────────────────────────────────
-- Set on each domain whose deployment goes mesh-only (mode=tunneler).
-- annotation-sync.ts checks this flag and short-circuits Ingress
-- creation when set. Per-domain (not per-route) because all routes
-- under the same domain share the same Ingress resource.
--
-- Default false so existing domains are unaffected.

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS suppress_public_ingress boolean NOT NULL DEFAULT false;
