-- R-X5: per-target drain timeout for the universal backup-rclone-shim.
--
-- When an operator changes the target bound to a shim class (system /
-- tenant / mail), platform-api waits for in-flight backup operations
-- using the OLD target to complete before rolling the shim DaemonSet
-- onto the NEW target. The wait is bounded by this per-target value
-- so a hung backup cannot lock out a target switch indefinitely.
--
-- Bounds (mirrored in @k8s-hosting/api-contracts BackupRcloneShim):
--   * MIN 30 s  — anything lower would force-roll on healthy backups.
--   * MAX 1800 s (30 min) — a multi-GiB tenant bundle to slow SFTP can
--                            take this long; 30 min is the longest we
--                            tolerate without admin escalation.
--   * DEFAULT 300 s (5 min) — RFC §13a recommendation.
--
-- Strictly additive: existing backup_configurations rows pick up the
-- 300-second default. No code path is downgraded — the column is read
-- by the new drain module only.

ALTER TABLE "backup_configurations"
  ADD COLUMN IF NOT EXISTS "drain_timeout_seconds" INTEGER NOT NULL DEFAULT 300;

ALTER TABLE "backup_configurations"
  DROP CONSTRAINT IF EXISTS "backup_configurations_drain_timeout_seconds_check";

ALTER TABLE "backup_configurations"
  ADD CONSTRAINT "backup_configurations_drain_timeout_seconds_check"
  CHECK ("drain_timeout_seconds" BETWEEN 30 AND 1800);
