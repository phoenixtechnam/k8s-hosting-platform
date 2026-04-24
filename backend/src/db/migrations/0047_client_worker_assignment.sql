-- M5: client worker assignment. Ties a client (namespace + workloads)
-- to a specific worker node. NULL means the default scheduler picks.
-- Referenced FK to cluster_nodes(name) keeps the pointer valid when a
-- node is removed from the fleet; cluster_nodes rows never get
-- deleted automatically by the reconciler, so cascading here is
-- conservative.
--
-- The admin panel's new-client flow shows the free resources per
-- worker and picks the best-fit by default; admins can override.
-- M3 already wired the nodeSelector plumbing into the deployer;
-- this column is the data source the provisioner reads from.

ALTER TABLE clients
  ADD COLUMN worker_node_name VARCHAR(253)
    REFERENCES cluster_nodes(name)
    ON DELETE SET NULL;

CREATE INDEX clients_worker_node_idx ON clients(worker_node_name);
