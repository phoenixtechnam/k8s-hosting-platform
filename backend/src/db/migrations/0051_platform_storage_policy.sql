-- Platform-level storage replication policy.
--
-- Distinct from `clients.storage_tier` (M7) which controls per-tenant PVC
-- replica count. This row decides what replication factor the platform's
-- own StatefulSets (postgres, stalwart-mail) get on their Longhorn
-- volumes.
--
-- Single-row table (id = 'singleton') matching the `platform_settings`
-- pattern used elsewhere. Default 'local' = 1 replica, matches today's
-- behaviour and prevents surprise replica scheduling on existing
-- clusters. Operators flip to 'ha' from the admin panel once the
-- cluster has at least 3 servers (Phase 6 banner / notification).
--
-- Reconciler runs against this row and patches longhorn.io Volume CRs
-- (`volume.spec.numberOfReplicas`). Longhorn schedules new replicas or
-- removes excess ones in the background — no StatefulSet restart, no
-- snapshot/restore dance. This is dramatically safer than the
-- delete-recreate path the StorageClass header in
-- k8s/base/longhorn/storageclasses.yaml describes for tenant tier
-- migrations; that doc applies to changing the SC NAME, not the
-- replica COUNT, which is mutable on a live volume.

CREATE TYPE platform_storage_tier AS ENUM ('local', 'ha');

CREATE TABLE platform_storage_policy (
  id              VARCHAR(16)               NOT NULL PRIMARY KEY DEFAULT 'singleton',
  system_tier     platform_storage_tier     NOT NULL DEFAULT 'local',
  -- Sticky once the operator clicks: prevents an automatic flip back
  -- to 'local' if a server is temporarily NotReady (would otherwise
  -- trigger replica deletion → data loss risk on transient network
  -- partitions).
  pinned_by_admin BOOLEAN                   NOT NULL DEFAULT FALSE,
  last_applied_at TIMESTAMPTZ,
  last_applied_by VARCHAR(36),
  -- Stamped when the bootstrap notification (Phase 6) fires so we
  -- don't re-spam admins on every backend restart. Cleared whenever
  -- system_tier flips to 'ha' or pinned_by_admin becomes true.
  ha_recommendation_notified_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ               NOT NULL DEFAULT now(),
  CONSTRAINT platform_storage_policy_singleton CHECK (id = 'singleton')
);

INSERT INTO platform_storage_policy (id, system_tier) VALUES ('singleton', 'local')
  ON CONFLICT (id) DO NOTHING;
