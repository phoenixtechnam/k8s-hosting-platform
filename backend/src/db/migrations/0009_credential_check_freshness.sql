-- Credential-check freshness tracker. Every successful credential
-- challenge (password login, passkey authentication, step-up) bumps
-- this timestamp. Privileged operations like opening a root-shell on
-- a cluster node check the freshness (default 30 minutes) and require
-- a step-up re-authentication when stale.
--
-- Distinct from last_login_at: a fresh "login event" only happens
-- once per session, while credential-check freshness is renewable
-- by any successful step-up challenge inside an existing session.
--
-- Nullable so existing rows don't need a synthetic value. Code paths
-- that read it treat NULL as "stale" (forces a step-up).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_credential_check_at" TIMESTAMP;
