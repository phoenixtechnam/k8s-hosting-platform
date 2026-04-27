-- 0054_refresh_tokens.sql
--
-- Phase 3 auth refactor: replace single 60-min JWT + in-memory denylist
-- with split access (30-min JWT) + refresh (24h opaque, DB-backed).
--
-- Why DB-backed: in-memory denylist on a per-pod Map only revokes the
-- token for one of N platform-api replicas. Refresh tokens are stored
-- here so any pod can validate / revoke them consistently.
--
-- Why hashed (sha256), not bcrypt: refresh tokens are 256-bit random
-- secrets — hashing is collision/integrity defense (database leak
-- shouldn't yield usable tokens), not password defense (offline brute
-- force is infeasible for 256 bits). sha256 is enough and fast.
--
-- Reuse detection: if the SAME refresh token is presented twice (i.e.
-- the rotation flow has already replaced it), all sibling tokens for
-- the same family are revoked — assume compromise. The `family_id`
-- groups successive tokens issued via rotation chain.
CREATE TABLE refresh_tokens (
  id            varchar(36)    PRIMARY KEY,
  user_id       varchar(36)    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id     varchar(36)    NOT NULL,
  token_hash    varchar(64)    NOT NULL,    -- sha256 hex
  panel         panel          NOT NULL,
  client_id     varchar(36)    REFERENCES clients(id) ON DELETE CASCADE,
  user_agent    varchar(500),               -- diagnostic only
  ip_address    varchar(64),                -- diagnostic only
  issued_at     timestamptz    NOT NULL DEFAULT now(),
  expires_at    timestamptz    NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_reason varchar(50)               -- 'logout' | 'rotated' | 'reuse_detected' | 'password_change' | 'admin_revoke'
);

CREATE UNIQUE INDEX refresh_tokens_hash_unique ON refresh_tokens(token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;
