-- 0052_node_alias_and_ingress_mode.sql
--
-- M-NS-1: extend cluster_nodes with two operator-managed columns.
--
-- 1. display_name — purely a UI alias. The k8s `metadata.name` is
--    immutable identity (changing it would require drain + re-bootstrap),
--    but operators want to see "frankfurt-1" instead of "k3s-srv-04".
--    Falls back to `name` when null. Length matches name (RFC1123 hostname).
--
-- 2. ingress_mode — three-state value controlling how this node
--    participates in cluster ingress:
--      'all'   = ingress-nginx pod runs here, advertises this node's
--                public IP, forwards to any pod cluster-wide. Default
--                for system servers (matches today's behavior).
--      'local' = ingress-nginx pod runs here, but only forwards to
--                pods whose .spec.nodeName == this node. Cross-node
--                forwards return 503. Used to localise traffic on a
--                tenant node so it doesn't proxy to other servers.
--      'none'  = no ingress-nginx pod here. Workloads still run, but
--                public traffic is served via the system servers.
--                Achieved by adding the
--                platform.phoenix-host.net/ingress-mode=none label
--                which the ingress-nginx DaemonSet's nodeSelector
--                excludes.
--
--    The label is the source of truth (same convention as node-role
--    and host-client-workloads); the DB column mirrors it for fast
--    queries and historical reporting. The reconciler treats the
--    label as authoritative.

ALTER TABLE cluster_nodes
  ADD COLUMN display_name varchar(253),
  ADD COLUMN ingress_mode varchar(8) NOT NULL DEFAULT 'all';

-- CHECK enforces the three valid values. Single-letter typo would
-- otherwise propagate to the k8s label and silently break ingress
-- routing.
ALTER TABLE cluster_nodes
  ADD CONSTRAINT cluster_nodes_ingress_mode_chk
  CHECK (ingress_mode IN ('all', 'local', 'none'));
