-- 0053_deployment_current_node.sql
--
-- Track which node currently hosts each deployment's pod(s). Populated
-- by the status-reconciler on every tick; used by the admin UI to
-- surface workload placement (Deployments tab in client detail, the
-- Installed Applications admin table).
--
-- For multi-replica deployments we store ONE node — the first found.
-- The UI labels it "host node" rather than "the only node" to be
-- honest about the simplification.
ALTER TABLE deployments
  ADD COLUMN current_node_name varchar(253);
