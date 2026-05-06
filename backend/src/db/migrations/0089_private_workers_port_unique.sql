-- Migration 0089: enforce unique (client_id, exposed_port) on private_workers.
--
-- The platform now auto-allocates exposed_port from a per-client pool of
-- 10000-19999 in service.ts::allocateExposedPort. Without a DB-level
-- backstop, two concurrent createPrivateWorker calls for the same client
-- can both pick the same lowest-free port between SELECT and INSERT,
-- producing a silently broken state (two workers sharing one frps remote
-- port). The reconciler would create two K8s Services with the same
-- targetPort and only one frpc registration would actually win.
--
-- This unique index makes the second INSERT fail atomically; the
-- application layer can retry the allocate-then-insert loop until it
-- succeeds. The retry is cheap (the SELECT only counts active rows for
-- the client) and bounded (10000 ports vs realistic worker counts).
--
-- Tightens the existing CHECK to match the auto-allocation pool too —
-- prevents an out-of-band SQL insert from placing a port outside the
-- range the reconciler expects.

CREATE UNIQUE INDEX IF NOT EXISTS private_workers_client_port_uq
  ON private_workers(client_id, exposed_port);

ALTER TABLE private_workers
  DROP CONSTRAINT IF EXISTS private_workers_exposed_port_range;

ALTER TABLE private_workers
  ADD CONSTRAINT private_workers_exposed_port_range
  CHECK (exposed_port BETWEEN 10000 AND 19999);
