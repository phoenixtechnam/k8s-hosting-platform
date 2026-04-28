-- Backup-health notification dedup. The scheduler in
-- modules/backup-health/scheduler.ts checks notifications.resourceId for
-- existing alerts before emitting a new one, but in HA mode (multiple
-- platform-api replicas) two ticks can read the same empty set and
-- both INSERT before either commits, producing duplicate notifications.
--
-- Partial unique index: scoped to resource_type='backup_job' so it does
-- NOT affect existing notification rows for other domains (mailboxes,
-- DKIM, IMAPSync, etc.) which intentionally allow re-firing on each
-- event.
--
-- Constraint violations are silently swallowed by notifyUser's existing
-- fire-and-forget try-catch — the second-writer's INSERT throws, the
-- catch eats it, and the user sees exactly one notification per Job UID.
-- This is the desired behavior; no further code change required.

CREATE UNIQUE INDEX IF NOT EXISTS notifications_backup_job_dedup_idx
  ON notifications (user_id, resource_id)
  WHERE resource_type = 'backup_job';
