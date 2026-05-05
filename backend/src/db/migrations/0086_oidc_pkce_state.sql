-- Postgres-backed PKCE state for the OIDC authorization-code flow.
--
-- Previously /api/v1/auth/oidc/authorize stored PKCE state in an in-memory
-- Map per platform-api replica. With multi-replica deployments the
-- /api/v1/auth/oidc/callback request often lands on a different pod than
-- the one that set the state, so the lookup fails and the user can never
-- complete an OIDC login. Surfaced by integration-oidc-dex.sh scenarios
-- 6+7 — admin and client panels both broke with empty Location on the
-- final redirect (no JWT minted).
--
-- This table replaces the Map. Rows are short-lived (10 min TTL) and
-- single-use — deleted on consume. A periodic cleanup query in
-- oidc/routes.ts removes anything past expires_at.

CREATE TABLE oidc_pkce_state (
  state             TEXT PRIMARY KEY,
  code_verifier     TEXT NOT NULL,
  frontend_redirect TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX oidc_pkce_state_expires_at_idx ON oidc_pkce_state (expires_at);
