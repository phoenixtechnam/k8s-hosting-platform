/**
 * Stalwart-native, app-level mail archive (operator-triggered).
 *
 * Distinct from the continuous restic backup of the raw data dir
 * (see mail-snapshot-*). An archive run is a one-shot orchestrated
 * sequence:
 *   1. scale Stalwart Deployment to 0
 *   2. wait for pod terminate (releases RocksDB LOCK)
 *   3. run `stalwart -e` to write a store-agnostic LZ4 export
 *   4. upload the LZ4 via restic to the configured backup target
 *   5. scale Stalwart back to its original replica count
 *
 * The whole thing takes ~60-120s typical with brief mail downtime.
 *
 * Use cases:
 *   - Weekly app-level archival point that survives RocksDB version
 *     bumps + DataStore swaps (unlike the file-level restic backup)
 *   - Pre-upgrade safety snapshot before bumping Stalwart
 *   - Long-term retention (yearly archive)
 *
 * Cron-able once stalwartlabs/stalwart#3175 (--secondary flag) lands;
 * until then it remains operator-triggered.
 */
import { z } from 'zod';

/**
 * State machine for a single archive run.
 * Mirror of mail_archive_runs.state (see migrations/0105_*).
 */
export const mailArchiveStateSchema = z.enum([
  'queued',
  'scaling_down',
  'exporting',
  'scaling_up',
  'succeeded',
  'failed',
]);
export type MailArchiveState = z.infer<typeof mailArchiveStateSchema>;

/**
 * Archive trigger mode — chooses between two implementations:
 *
 *   no_downtime   — DEFAULT. Uses RocksDB OpenAsSecondary + Checkpoint
 *                   (rocksdb-secondary-checkpoint binary) to take a hard-
 *                   linked snapshot of the live primary's data dir, then
 *                   runs `stalwart -e` against the checkpoint via an
 *                   alt-config. Live Stalwart keeps serving SMTP/IMAP
 *                   throughout. Wall-clock cost: seconds.
 *
 *   downtime      — Fallback. Scales the stalwart-mail Deployment to 0
 *                   first (releases the RocksDB LOCK), then runs
 *                   `stalwart -e` against the live data dir, then scales
 *                   back. ~60-120s mail downtime. Belt-and-suspenders
 *                   choice for cases where the operator wants the
 *                   strongest app-level-atomic semantics.
 *
 * Stored on each run for audit; the orchestrator picks the implementation
 * based on this value.
 */
export const mailArchiveModeSchema = z.enum(['no_downtime', 'downtime']);
export type MailArchiveMode = z.infer<typeof mailArchiveModeSchema>;

/**
 * Lifecycle row for one archive run. Returned by GET /admin/mail/archive-runs
 * + the inner shape of the trigger endpoint's response after the orchestrator
 * starts.
 */
export const mailArchiveRunSchema = z.object({
  id: z.string(),
  state: mailArchiveStateSchema,
  currentStep: z.string().nullable(),
  /** Which implementation ran this archive (see mailArchiveModeSchema). */
  mode: mailArchiveModeSchema,
  /** Replica count BEFORE the run started — what we scale back to on completion.
   *  Always recorded even in no_downtime mode (for symmetry + observability). */
  originalReplicas: z.number().int().nonnegative(),
  /** k8s Job name running stalwart -e + restic upload (null until exporting). */
  jobName: z.string().nullable(),
  /** restic snapshot ID once upload completes (8-char hex). */
  resticSnapshotId: z.string().nullable(),
  /** LZ4 export size in bytes BEFORE restic dedupe — what an operator wants
   *  to see for "how big is my mail right now". */
  exportSizeBytes: z.number().int().nonnegative().nullable(),
  /** restic's "Added to the repository" — the per-run upload delta. */
  resticAddedBytes: z.number().int().nonnegative().nullable(),
  triggeredBy: z.string(),
  triggeredByUserId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type MailArchiveRun = z.infer<typeof mailArchiveRunSchema>;

/**
 * Latest archive summary for the Mail Archive card.
 *
 * `last` is the most-recent terminal run (succeeded OR failed). `current`
 * is the running run if any (operator can poll this for live progress).
 * `backupTarget` echoes the same backup_configurations row used by the
 * continuous restic CronJob — we deliberately reuse the same repo so
 * operators see one place to manage credentials.
 */
export const mailArchiveStatusResponseSchema = z.object({
  last: mailArchiveRunSchema.nullable(),
  current: mailArchiveRunSchema.nullable(),
  backupTarget: z.object({
    backupStoreId: z.string().nullable(),
    backupStoreName: z.string().nullable(),
    storageType: z.string().nullable(),
  }),
  /** Hint string for the UI: explains why scheduled (cron) archiving is
   *  NOT available today — it'll lift once Stalwart upstream issue #3175
   *  ships a `--secondary` flag on `-e`. */
  scheduledArchivingAvailable: z.boolean(),
  scheduledArchivingBlockedBy: z.string().nullable(),
});
export type MailArchiveStatusResponse = z.infer<typeof mailArchiveStatusResponseSchema>;

/**
 * Paginated history of archive runs. Driven by mail_archive_runs.started_at
 * DESC. The UI shows this in a table with Restore buttons on the succeeded
 * rows.
 */
export const mailArchiveListResponseSchema = z.object({
  data: z.array(mailArchiveRunSchema),
  total: z.number().int().nonnegative(),
});
export type MailArchiveListResponse = z.infer<typeof mailArchiveListResponseSchema>;

/**
 * POST /admin/mail/archive/trigger request — operator picks the mode.
 * Empty body → default ('no_downtime').
 */
export const mailArchiveTriggerRequestSchema = z.object({
  mode: mailArchiveModeSchema.optional(),
});
export type MailArchiveTriggerRequest = z.infer<typeof mailArchiveTriggerRequestSchema>;

/**
 * POST /admin/mail/archive/trigger response: returns the run-id so the
 * UI can immediately open the progress modal and start polling.
 */
export const mailArchiveTriggerResponseSchema = z.object({
  runId: z.string(),
});
export type MailArchiveTriggerResponse = z.infer<typeof mailArchiveTriggerResponseSchema>;

/**
 * POST /admin/mail/archive/restore — operator picks a past run by id;
 * the orchestrator scales Stalwart down, wipes the data dir, downloads
 * + extracts the LZ4 from restic, runs `stalwart -i`, then scales back.
 *
 * The confirm field is a required tripwire — destroys live mail data.
 */
export const mailArchiveRestoreRequestSchema = z.object({
  runId: z.string().min(1),
  /** Must be the literal string "yes-replace-live-mail" — operator must
   *  type/click to confirm. Lets API guard against accidental restores
   *  from typo'd run IDs. */
  confirm: z.literal('yes-replace-live-mail'),
});
export type MailArchiveRestoreRequest = z.infer<typeof mailArchiveRestoreRequestSchema>;

export const mailArchiveRestoreResponseSchema = z.object({
  runId: z.string(),
});
export type MailArchiveRestoreResponse = z.infer<typeof mailArchiveRestoreResponseSchema>;
