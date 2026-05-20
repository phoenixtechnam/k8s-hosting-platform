-- ADR-041 follow-up — page-reload survival for node-terminal sessions.
--
-- A clean WS close used to call terminateSession synchronously, which
-- killed the privileged Pod + DB row the moment the user reloaded the
-- page. Sessions could not survive a reload.
--
-- The new model: WS close schedules a delayed termination at
-- `terminate_after`. A reconnect (POST /sessions/:id/ws-token) clears
-- the timer. An explicit `{type:'terminate'}` frame from the client
-- (sent by × buttons in the modal/dock) bypasses the grace period.
--
-- `terminate_after` is NULL while the session is healthy. Set by the
-- WS close handler to `now() + GRACE_MS`. Cleared by refreshWsToken.
-- The cross-replica scheduler reaps rows whose `terminate_after` has
-- elapsed — so an in-memory timer dying with its replica is recovered
-- within one sweep tick.

ALTER TABLE "node_terminal_sessions"
  ADD COLUMN IF NOT EXISTS "terminate_after" TIMESTAMPTZ;

-- Partial index — only the rows actually pending termination get
-- indexed. The hot path (no pending termination) pays nothing.
CREATE INDEX IF NOT EXISTS "node_terminal_sessions_terminate_after_idx"
  ON "node_terminal_sessions" ("terminate_after")
  WHERE "terminate_after" IS NOT NULL;
