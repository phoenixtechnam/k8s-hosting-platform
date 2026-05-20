-- ADR-041 follow-up — DB-backed session lookup for the admin
-- node-terminal feature. Replaces the per-platform-api in-memory
-- registry (which broke under HA when WS upgrades landed on
-- non-owner replicas with SESSION_NOT_FOUND / REPLICA_MISMATCH).
--
-- Each row carries enough state for ANY platform-api replica to
-- look up the session by id, validate the single-use wsToken (hash
-- compared in constant time), and re-attach a fresh exec stream
-- into the still-running privileged Pod. Owner is tracked but only
-- as diagnostic metadata — the fresh-exec path is the same regardless.

CREATE TABLE IF NOT EXISTS "node_terminal_sessions" (
  "id"                  UUID PRIMARY KEY,
  "node_name"           TEXT NOT NULL,
  "pod_name"            TEXT NOT NULL,
  "pod_namespace"       TEXT NOT NULL DEFAULT 'platform',
  "user_id"             VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "user_email"          VARCHAR(255) NOT NULL,
  "client_ip"           VARCHAR(45) NOT NULL,
  -- SHA-256 of the 32-byte random wsToken. The token itself is only
  -- ever in memory + the URL handed to the client. We store the hash
  -- so any replica can validate the token via constant-time compare
  -- without trusting plaintext-at-rest. NULL once consumed.
  "ws_token_hash"       BYTEA,
  "ws_token_issued_at"  TIMESTAMPTZ,
  -- The platform-api Pod hostname that LAST attached an exec stream.
  -- Diagnostic only; updated atomically on every successful attach.
  "owner_replica"       TEXT NOT NULL,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at"          TIMESTAMPTZ NOT NULL,
  "last_activity_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "node_terminal_sessions_user_idx"
  ON "node_terminal_sessions" ("user_id", "expires_at");

CREATE INDEX IF NOT EXISTS "node_terminal_sessions_expires_idx"
  ON "node_terminal_sessions" ("expires_at");

CREATE INDEX IF NOT EXISTS "node_terminal_sessions_activity_idx"
  ON "node_terminal_sessions" ("last_activity_at");
