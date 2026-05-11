-- Per-user client certificates issued by a client_mtls_provider.
--
-- Adds DB persistence + CRL tracking to the previously stateless
-- "issue user cert" flow (migration 0060). Two reasons we now need it:
--
--   1. Operators want to see the certs they've handed out (audit,
--      lifecycle, recall) — UI list of issued certs per provider.
--   2. Revocation: NGINX ingress can be told to reject revoked certs
--      via a CRL ("ca.crl" Secret key alongside "ca.crt"). The CRL is
--      regenerated from this table on every revocation.
--
-- Storage policy:
--   * cert PEM is stored encrypted at rest (same OIDC_ENCRYPTION_KEY
--     envelope used elsewhere). The cert itself is public material,
--     but we encrypt-by-default to keep one envelope policy.
--   * Private key is NEVER stored. It's emitted to the operator once
--     at issuance time and never seen by the server again — defense
--     in depth, even if the platform DB is compromised, leaked certs
--     are useless without the matching key.
--   * Serial numbers are unique per provider (issuer). Format: lowercase
--     hex with no leading 0s (matches openssl x509 -serial output once
--     normalised). Used as the cert's primary identifier within a CA.
--
-- CRL state lives on the provider row: a monotonic crl_number (X.509
-- CRL Number extension), the last-generated timestamp, and the cached
-- PEM body. The reconciler reads crl_pem when reconciling each route.

CREATE TABLE IF NOT EXISTS client_certificates (
  id varchar(36) PRIMARY KEY,
  provider_id varchar(36) NOT NULL
    REFERENCES client_mtls_providers(id) ON DELETE CASCADE,
  -- Denormalised tenant id for fast scoping in the routes layer.
  -- Kept consistent with provider.client_id by the service layer.
  client_id varchar(36) NOT NULL
    REFERENCES clients(id) ON DELETE CASCADE,
  -- Hex-encoded serial number (lowercase, no leading 0x). Unique
  -- per CA — that's what makes it a usable revocation identifier.
  serial_hex varchar(64) NOT NULL,
  -- PEM-encoded user cert, encrypted at rest. We store the full PEM
  -- so the operator can re-download it later if they lost the file
  -- (private key was emitted once and is NOT recoverable).
  cert_pem_encrypted text NOT NULL,
  -- SHA-256 of the cert DER, hex-encoded; used for client-side
  -- dedupe and visual fingerprint display.
  cert_fingerprint_sha256 varchar(64) NOT NULL,
  -- Subject CN — single field for table display.
  subject_cn varchar(255) NOT NULL,
  -- Full Subject DN (e.g. "/O=Acme/OU=Eng/CN=alice@acme") for the
  -- detail view. Mirrors what nginx sets in ssl-client-subject-dn.
  subject_full varchar(500) NOT NULL,
  issued_at timestamp NOT NULL DEFAULT NOW(),
  expires_at timestamp NOT NULL,
  -- Revocation state. NULL = active.
  revoked_at timestamp,
  -- RFC 5280 reason codes mapped to symbolic strings; the API enforces
  -- the enum. Stored as text so a future enum extension doesn't need a
  -- migration. NULL when revoked_at IS NULL.
  revocation_reason varchar(64),
  -- Audit: which platform user clicked Revoke (may be NULL when
  -- triggered by a system process like auto-expiry-revoke).
  revoked_by_user_id varchar(36),
  created_at timestamp NOT NULL DEFAULT NOW(),
  -- One CA cannot reuse a serial. Enforced at the issuance layer
  -- (crypto-random 128-bit) but constrained here for safety.
  CONSTRAINT client_certificates_provider_serial_unique
    UNIQUE (provider_id, serial_hex)
);

CREATE INDEX IF NOT EXISTS client_certificates_provider_idx
  ON client_certificates(provider_id);

CREATE INDEX IF NOT EXISTS client_certificates_client_idx
  ON client_certificates(client_id);

-- Partial index over revoked certs only — accelerates CRL build by
-- letting Postgres skip the dominant active-cert population entirely.
CREATE INDEX IF NOT EXISTS client_certificates_revoked_idx
  ON client_certificates(provider_id, revoked_at)
  WHERE revoked_at IS NOT NULL;

-- Lifecycle / expiry sweeps.
CREATE INDEX IF NOT EXISTS client_certificates_expires_idx
  ON client_certificates(expires_at);

-- CRL state on the provider row.
ALTER TABLE client_mtls_providers
  ADD COLUMN IF NOT EXISTS crl_number bigint NOT NULL DEFAULT 0;

ALTER TABLE client_mtls_providers
  ADD COLUMN IF NOT EXISTS crl_pem text;

ALTER TABLE client_mtls_providers
  ADD COLUMN IF NOT EXISTS crl_last_generated_at timestamp;

-- next_serial_hex: monotonic per-CA serial allocator. Optional —
-- the service uses crypto-random 128-bit serials, but having a
-- column lets operators force-bump the next serial if they ever
-- need to (e.g. legacy CA import that already issued certs).
ALTER TABLE client_mtls_providers
  ADD COLUMN IF NOT EXISTS next_serial_seq bigint NOT NULL DEFAULT 1;
