import { z } from 'zod';

/**
 * Mail server snapshot infrastructure — Stalwart state export/import
 * via `stalwart -e / -i` (store-agnostic directory format).
 *
 * Snapshots are uploaded to a configured BackupStore (S3 or SFTP)
 * via a restic sidecar in the snapshot CronJob. restic deduplication
 * provides effective incrementals even though the Stalwart export is
 * always a full dump.
 *
 * GET   /admin/mail/snapshot-status
 * POST  /admin/mail/snapshot/trigger
 * GET   /admin/mail/snapshot/jobs/:name
 * GET   /admin/mail/snapshot-schedule
 * PATCH /admin/mail/snapshot-schedule
 * GET   /admin/mail/snapshot-backup-target
 * PATCH /admin/mail/snapshot-backup-target
 */

export const mailSnapshotStatusResponseSchema = z.object({
  enabled: z.boolean(),
  scheduleExpression: z.string(),
  /** ISO-8601 datetime of the last successful snapshot, or null if none. */
  lastSnapshotAt: z.string().datetime().nullable(),
  /** Compressed size in bytes of the last snapshot export directory, or null. */
  lastSnapshotSizeBytes: z.number().int().nonnegative().nullable(),
  /** Total size of the restic repository in bytes (all snapshots), or null. */
  totalSnapshotSizeBytes: z.number().int().nonnegative().nullable(),
  /** Number of restic snapshots in the backup target. */
  snapshotCount: z.number().int().nonnegative(),
  /** Seconds since last snapshot. null when no snapshot exists yet. */
  secondsSinceLastSnapshot: z.number().int().nonnegative().nullable(),
  /**
   * True when the last snapshot is fresh (< 5 minutes old or schedule
   * has not yet fired). False when stale or errored.
   */
  healthy: z.boolean(),
  /** BackupStore id used for snapshots, or null if none configured. */
  backupStoreId: z.string().nullable(),
});
export type MailSnapshotStatusResponse = z.infer<typeof mailSnapshotStatusResponseSchema>;

/** GET /admin/mail/snapshot-schedule response. */
export const mailSnapshotScheduleResponseSchema = z.object({
  scheduleExpression: z.string(),
});
export type MailSnapshotScheduleResponse = z.infer<typeof mailSnapshotScheduleResponseSchema>;

/** PATCH /admin/mail/snapshot-schedule request. */
export const mailSnapshotScheduleUpdateSchema = z.object({
  // Standard 5-part cron expression, e.g. "star/2 * * * *" (every 2 min).
  scheduleExpression: z.string().min(1).max(100),
});
export type MailSnapshotScheduleUpdate = z.infer<typeof mailSnapshotScheduleUpdateSchema>;

/** GET /admin/mail/snapshot-backup-target response. */
export const mailSnapshotBackupTargetResponseSchema = z.object({
  /** backup_configurations.id, or null if no target is configured. */
  backupStoreId: z.string().nullable(),
  backupStoreName: z.string().nullable(),
  storageType: z.string().nullable(),
});
export type MailSnapshotBackupTargetResponse = z.infer<typeof mailSnapshotBackupTargetResponseSchema>;

/** PATCH /admin/mail/snapshot-backup-target request. */
export const mailSnapshotBackupTargetUpdateSchema = z.object({
  /** backup_configurations.id to use, or null to clear the target. */
  backupStoreId: z.string().nullable(),
});
export type MailSnapshotBackupTargetUpdate = z.infer<typeof mailSnapshotBackupTargetUpdateSchema>;

export const mailSnapshotTriggerResponseSchema = z.object({
  jobName: z.string().min(1),
  startedAt: z.string().datetime(),
});
export type MailSnapshotTriggerResponse = z.infer<typeof mailSnapshotTriggerResponseSchema>;

export const mailSnapshotJobStatusResponseSchema = z.object({
  jobName: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /** Tail of the pod log (last 50 lines), or null until logs are accessible. */
  podLogTail: z.string().nullable(),
  failureReason: z.string().nullable(),
});
export type MailSnapshotJobStatusResponse = z.infer<typeof mailSnapshotJobStatusResponseSchema>;
