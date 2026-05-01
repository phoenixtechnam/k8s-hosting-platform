-- Default behaviour for newly-joined SERVER nodes.
--
-- bootstrap.sh defaults `--host-client-workloads true`, but operators
-- may want platform-only servers in HA setups. Storing the default in
-- system_settings lets the cluster-side reconciler (nodes/k8s-sync.ts)
-- apply the desired value when a fresh server node joins without an
-- explicit `platform.phoenix-host.net/host-client-workloads` label.
--
-- Default TRUE preserves the existing behaviour: every new server
-- node hosts client workloads unless the operator opts out either
-- in this toggle or by passing `--host-client-workloads false` to
-- bootstrap.sh on the joining host (explicit label always wins).

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS new_server_hosts_client_workloads BOOLEAN NOT NULL DEFAULT TRUE;
