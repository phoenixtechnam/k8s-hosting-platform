-- Migration 0065: kubelet image-GC thresholds in system_settings
-- These three settings control how aggressively the kubelet's built-in image
-- garbage collector reclaims disk space.  They are shipped as k3s
-- --kubelet-arg flags on first install (see bootstrap.sh) and surfaced in
-- the admin panel so operators can review the cluster-wide defaults.
--
-- Reconciliation to running kubelets is deferred (see
-- backend/src/modules/cluster-settings/kubelet-gc-reconciler.ts).
ALTER TABLE system_settings
  ADD COLUMN image_gc_high_threshold INT NOT NULL DEFAULT 70,
  ADD COLUMN image_gc_low_threshold  INT NOT NULL DEFAULT 60,
  ADD COLUMN image_gc_min_ttl_minutes INT NOT NULL DEFAULT 60;
