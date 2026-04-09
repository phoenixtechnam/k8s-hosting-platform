/**
 * Phase 3 T2.1 — IMAPSync job reconciler.
 *
 * Polls active (pending/running) imap_sync_jobs rows, queries the
 * owning K8s Job, and writes terminal status + log tail back to the
 * DB. Cleans up the K8s Job + Secret once the row reaches a
 * terminal state.
 *
 * Pattern mirrors backend/src/modules/deployments/status-reconciler.ts
 * but scoped to BatchV1 jobs in the `mail` namespace.
 */

import { eq, inArray } from 'drizzle-orm';
import { imapSyncJobs } from '../../db/schema.js';
import { notifyClientImapsyncTerminal } from '../notifications/events.js';
import { parseImapsyncProgress } from './progress-parser.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// Round-4 Phase 3: minimum interval between log fetches for the
// same running job. Caps the K8s API load when many jobs are
// active concurrently. 10 seconds matches the typical reconciler
// tick (which is set externally), so we usually do exactly one
// fetch per cycle per job.
const PROGRESS_FETCH_INTERVAL_MS = 10_000;

// Maximum bytes of log tail to persist in the DB. Larger logs get
// truncated from the front so we keep the most recent output.
const MAX_LOG_TAIL_BYTES = 32 * 1024;

interface ReconcilerLogger {
  warn: (msg: string) => void;
  info?: (msg: string) => void;
}

const noopLogger: ReconcilerLogger = {
  warn: (msg) => console.warn(msg),
  info: (msg) => console.log(msg),
};

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function truncateTail(s: string): string {
  if (s.length <= MAX_LOG_TAIL_BYTES) return s;
  return s.slice(s.length - MAX_LOG_TAIL_BYTES);
}

async function fetchPodLogs(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
): Promise<string> {
  try {
    // Find the pod owned by this Job. The Job controller adds a
    // `job-name=<name>` label to its pods. We use that label
    // selector to fetch the pod name then read its logs.
    const pods = await (k8s.core as unknown as {
      listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
        items: { metadata?: { name?: string } }[];
      }>;
    }).listNamespacedPod({
      namespace,
      labelSelector: `job-name=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) return '';
    const log = await (k8s.core as unknown as {
      readNamespacedPodLog: (args: {
        name: string;
        namespace: string;
        tailLines?: number;
      }) => Promise<string>;
    }).readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines: 500,
    });
    return typeof log === 'string' ? log : '';
  } catch {
    return '';
  }
}

async function deleteJobAndSecret(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
): Promise<void> {
  try {
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<void>;
    }).deleteNamespacedJob({
      name: jobName,
      namespace,
      propagationPolicy: 'Background',
    });
  } catch (err) {
    if (!isK8s404(err)) throw err;
  }
  try {
    await (k8s.core as unknown as {
      deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
    }).deleteNamespacedSecret({
      name: jobName, // Secret + Job share the name
      namespace,
    });
  } catch (err) {
    if (!isK8s404(err)) throw err;
  }
}

/**
 * Reconcile all active IMAPSync jobs in one pass. Called from the
 * scheduler tick.
 */
export async function reconcileImapSyncJobs(
  db: Database,
  k8s: K8sClients,
  logger: ReconcilerLogger = noopLogger,
): Promise<{ reconciled: number; finished: number }> {
  const active = await db
    .select()
    .from(imapSyncJobs)
    .where(inArray(imapSyncJobs.status, ['pending', 'running']));

  let reconciled = 0;
  let finished = 0;
  for (const row of active) {
    if (!row.k8sJobName) continue; // pending but never started — leave alone
    reconciled += 1;
    try {
      const job = await (k8s.batch as unknown as {
        readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
          status?: { active?: number; succeeded?: number; failed?: number };
        }>;
      }).readNamespacedJob({
        name: row.k8sJobName,
        namespace: row.k8sNamespace,
      });
      const status = job.status ?? {};

      if ((status.succeeded ?? 0) >= 1) {
        const log = await fetchPodLogs(k8s, row.k8sNamespace, row.k8sJobName);
        await db
          .update(imapSyncJobs)
          .set({
            status: 'succeeded',
            finishedAt: new Date(),
            logTail: truncateTail(log),
          })
          .where(eq(imapSyncJobs.id, row.id));
        await deleteJobAndSecret(k8s, row.k8sNamespace, row.k8sJobName);
        finished += 1;
        logger.info?.(`[mail-imapsync] job ${row.id} succeeded`);
        // Phase 3 round-2: notify client on terminal success.
        void notifyClientImapsyncTerminal(db, row.clientId, {
          jobId: row.id,
          status: 'succeeded',
        });
        continue;
      }

      if ((status.failed ?? 0) >= 1) {
        const log = await fetchPodLogs(k8s, row.k8sNamespace, row.k8sJobName);
        await db
          .update(imapSyncJobs)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: 'imapsync job failed — see logTail',
            logTail: truncateTail(log),
          })
          .where(eq(imapSyncJobs.id, row.id));
        await deleteJobAndSecret(k8s, row.k8sNamespace, row.k8sJobName);
        finished += 1;
        logger.warn(`[mail-imapsync] job ${row.id} failed`);
        // Phase 3 round-2: notify client on terminal failure.
        void notifyClientImapsyncTerminal(db, row.clientId, {
          jobId: row.id,
          status: 'failed',
          errorMessage: 'imapsync job failed — see the job log tail in the client panel.',
        });
        continue;
      }

      // Round-4 Phase 3: still active — fetch a fresh log tail and
      // parse out the latest progress markers (messages_total,
      // messages_transferred, current_folder). Throttle so we
      // don't hammer the K8s API: only fetch logs when at least
      // PROGRESS_FETCH_INTERVAL_MS has elapsed since the last
      // progress write for this row.
      const lastProgress = row.lastProgressAt?.getTime() ?? 0;
      const now = Date.now();
      if (now - lastProgress >= PROGRESS_FETCH_INTERVAL_MS) {
        try {
          const log = await fetchPodLogs(k8s, row.k8sNamespace, row.k8sJobName);
          const parsed = parseImapsyncProgress(log);
          // Build a partial UPDATE — never overwrite existing
          // columns with null/empty. The parser returns null for
          // fields it couldn't extract from this batch, but older
          // information from a previous tick may still be valid
          // (imapsync only emits "From Folder" lines once at
          // startup, for example).
          //
          // Review MEDIUM-1: don't overwrite logTail with an empty
          // string. lastProgressAt always advances so the throttle
          // works regardless.
          const updates: Record<string, unknown> = {
            lastProgressAt: new Date(),
          };
          if (log.length > 0) updates.logTail = truncateTail(log);
          if (parsed.messagesTotal !== null) updates.messagesTotal = parsed.messagesTotal;
          if (parsed.messagesTransferred !== null) updates.messagesTransferred = parsed.messagesTransferred;
          if (parsed.currentFolder !== null) updates.currentFolder = parsed.currentFolder;
          await db
            .update(imapSyncJobs)
            .set(updates)
            .where(eq(imapSyncJobs.id, row.id));
        } catch (logErr) {
          // Non-fatal — log fetching failures should not break the
          // status reconciliation loop.
          logger.warn(
            `[mail-imapsync] progress log fetch failed for ${row.id}: ${
              logErr instanceof Error ? logErr.message : String(logErr)
            }`,
          );
        }
      }
    } catch (err) {
      if (isK8s404(err)) {
        // The K8s Job is gone but the DB row says it should be
        // running. Most likely cause: ttlSecondsAfterFinished
        // already cleaned up the Job before we polled, OR an
        // operator deleted it manually. Mark the row as failed
        // and ALSO clean up the per-job Secret — the Job's
        // ttlSecondsAfterFinished sweep does NOT cascade to
        // owner-less Secrets, and we don't want the cleartext
        // STALWART_MASTER_SECRET sitting in the cluster.
        await db
          .update(imapSyncJobs)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: `Kubernetes Job '${row.k8sJobName}' disappeared before reconciler could observe completion`,
          })
          .where(eq(imapSyncJobs.id, row.id));
        // Best-effort secret cleanup. Suppress its own 404 since
        // the Secret may have already been removed.
        try {
          await (k8s.core as unknown as {
            deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<void>;
          }).deleteNamespacedSecret({
            name: row.k8sJobName,
            namespace: row.k8sNamespace,
          });
        } catch (secretErr) {
          if (!isK8s404(secretErr)) {
            logger.warn(
              `[mail-imapsync] secret cleanup failed for ${row.id}: ${
                secretErr instanceof Error ? secretErr.message : String(secretErr)
              }`,
            );
          }
        }
        finished += 1;
        logger.warn(`[mail-imapsync] job ${row.id} disappeared`);
        // Phase 3 round-2: notify client on terminal failure (disappeared).
        void notifyClientImapsyncTerminal(db, row.clientId, {
          jobId: row.id,
          status: 'failed',
          errorMessage: `Kubernetes Job '${row.k8sJobName}' disappeared before reconciler could observe completion.`,
        });
        continue;
      }
      logger.warn(
        `[mail-imapsync] reconcile error for ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { reconciled, finished };
}
