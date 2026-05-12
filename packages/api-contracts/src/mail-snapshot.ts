import { z } from 'zod';

/**
 * Mail server snapshot infrastructure — Stalwart state export/import
 * via `stalwart -e / -i` (store-agnostic LZ4 format).
 *
 * Snapshots are written to the platform's active BackupStore (S3 or
 * SFTP). They are the DR recovery mechanism: on pod reschedule to a
 * node without existing DataStore state (e.g. after migrating to
 * RocksDB on local-path), the Stalwart Deployment's restore-state
 * initContainer downloads the latest snapshot and runs `stalwart -i`.
 *
 * GET  /admin/mail/snapshot-status
 * POST /admin/mail/snapshot/trigger
 * GET  /admin/mail/snapshot/jobs/:name
 */

export const mailSnapshotStatusResponseSchema = z.object({
  enabled: z.boolean(),
  scheduleExpression: z.string(),
  /** ISO-8601 datetime of the last successful snapshot, or null if none. */
  lastSnapshotAt: z.string().datetime().nullable(),
  /** Compressed size in bytes of the last snapshot, or null if none. */
  lastSnapshotSizeBytes: z.number().int().nonnegative().nullable(),
  /** Number of stored snapshots in the backup target. */
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
