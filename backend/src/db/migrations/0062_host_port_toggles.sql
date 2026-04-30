-- Two new System Settings toggles that gate catalog deploys whose
-- workloads request host-network ports (hostPort or
-- platform.io/firewall-{tcp,udp}-ports annotations).
--
-- Default OFF on both because host-port exposure is a real
-- attack-surface decision the operator must consciously enable.
-- When OFF, the catalog deploy is rejected with a clear error
-- pointing at the corresponding toggle.

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS allow_host_ports_server BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS allow_host_ports_worker BOOLEAN NOT NULL DEFAULT FALSE;
