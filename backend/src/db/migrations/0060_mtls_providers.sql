-- Per-client mTLS CA-cert providers (Mode B refactor — Round 2).
--
-- Lifts the previously inline-on-ingress CA bundle into a reusable
-- table. One provider can be referenced by multiple ingress_mtls_configs,
-- mirroring the OIDC provider/config split done in 0057.
--
-- Differences vs. OIDC providers:
--   * Optional CA private key (encrypted). Present only when the
--     provider was created via the "generate CA" flow OR uploaded with
--     a key — required only for the issue-user-cert action.
--   * The provider stores the cert MATERIAL, not just config; the
--     reconciler mounts it directly as a Secret on the tenant Ingress.
--
-- ingress_mtls_configs gains a NULLable provider_id FK. NULL means
-- "use the legacy inline ca_cert_pem_encrypted column"; rows created
-- via the new flow set provider_id and leave the inline column NULL.
-- Migration is non-destructive: existing inline configs keep working.

CREATE TABLE IF NOT EXISTS client_mtls_providers (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  -- PEM-encoded CA bundle (root + intermediates), encrypted at rest.
  ca_cert_pem_encrypted text NOT NULL,
  -- PEM-encoded CA private key. Encrypted at rest. NULL when the
  -- provider was uploaded without a key — operator can still SELECT
  -- the provider on an ingress but cannot issue user certs from it.
  ca_key_pem_encrypted text,
  -- SHA-256 of the CA cert DER, hex-encoded; computed server-side
  -- on creation/edit, used for visual diff and dedupe.
  ca_cert_fingerprint varchar(64) NOT NULL,
  -- Subject DN of the first cert in the bundle.
  ca_cert_subject varchar(500) NOT NULL,
  ca_cert_expires_at timestamp NOT NULL,
  -- True when ca_key_pem_encrypted is set, denormalised for
  -- consumer-count + can-issue checks without decrypting.
  can_issue boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_mtls_providers_client_idx
  ON client_mtls_providers(client_id);

-- Add provider_id FK on ingress_mtls_configs. NULLable so existing
-- inline-uploaded configs (created in migration 0058) keep working.
-- New upserts via the provider flow set provider_id and leave the
-- inline ca_cert_pem_encrypted column NULL.
ALTER TABLE ingress_mtls_configs
  ADD COLUMN IF NOT EXISTS provider_id varchar(36)
    REFERENCES client_mtls_providers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ingress_mtls_configs_provider_idx
  ON ingress_mtls_configs(provider_id);
