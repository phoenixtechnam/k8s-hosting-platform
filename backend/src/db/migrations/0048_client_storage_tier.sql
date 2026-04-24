-- M7: per-client storage tier. Drives the StorageClass picked by the
-- provisioner for the client's PVC (M2 defined five classes; this
-- ties clients to either the cheap single-replica tier or the
-- 2-replica HA tier). Default 'local' preserves pre-M7 behavior —
-- existing clients stay on cheap storage until an admin opts in.
--
-- The tier governs TENANT storage only (the client's shared PVC).
-- System + mail storage tiers are chosen by the workload manifests,
-- not per-client.

CREATE TYPE client_storage_tier AS ENUM ('local', 'ha');

ALTER TABLE clients
  ADD COLUMN storage_tier client_storage_tier NOT NULL DEFAULT 'local';
