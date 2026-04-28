/**
 * Backup-health scheduler.
 *
 * Runs every BACKUP_HEALTH_TICK_MS in the in-cluster process. Each
 * tick: list health-watched Jobs, find new failures (dedup via
 * notifications.resourceId=uid), route to admin or client recipients
 * per the Job's `client-id` label, emit one notification per Job UID.
 *
 * Idempotent: the next tick re-derives the already-notified set from
 * the notifications table, so a pod restart mid-tick is safe.
 */

import { eq, and, inArray } from 'drizzle-orm';
import * as k8s from '@kubernetes/client-node';
import { notifications } from '../../db/schema.js';
import { notifyUsers } from '../notifications/service.js';
import { resolveRecipients } from '../notifications/recipients.js';
import { listHealthWatchedJobs, findNewFailures } from './service.js';
import { severityToNotificationType } from './labels.js';
import type { BackupJobMeta } from './service.js';
import type { Database } from '../../db/index.js';

const RESOURCE_TYPE_BACKUP_JOB = 'backup_job';

/** Default tick interval — 5 minutes balances freshness vs apiserver load. */
export const BACKUP_HEALTH_TICK_MS = 5 * 60 * 1000;

export interface BackupHealthSchedulerDeps {
  readonly db: Database;
  readonly batch: k8s.BatchV1Api;
  readonly tickMs?: number;
  readonly logger?: { warn: (msg: string, err?: unknown) => void };
}

export function startBackupHealthScheduler(
  deps: BackupHealthSchedulerDeps,
): () => void {
  const tickMs = deps.tickMs ?? BACKUP_HEALTH_TICK_MS;
  const log = deps.logger ?? {
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[backup-health] ${msg}`, err ?? ''),
  };

  void runTick(deps.db, deps.batch, log);

  const timer = setInterval(() => {
    void runTick(deps.db, deps.batch, log);
  }, tickMs);

  return () => clearInterval(timer);
}

export async function runTick(
  db: Database,
  batch: k8s.BatchV1Api,
  log: { warn: (msg: string, err?: unknown) => void },
): Promise<void> {
  let jobs: ReadonlyArray<BackupJobMeta>;
  try {
    jobs = await listHealthWatchedJobs(batch);
  } catch (err) {
    log.warn('listHealthWatchedJobs failed', err);
    return;
  }

  if (jobs.length === 0) return;

  const alreadyNotified = await loadAlreadyNotifiedUids(
    db,
    jobs.map((j) => j.uid),
  );

  const newFailures = findNewFailures(jobs, alreadyNotified);
  if (newFailures.length === 0) return;

  for (const failure of newFailures) {
    // eslint-disable-next-line no-await-in-loop
    await notifyForFailure(db, failure, log);
  }
}

async function loadAlreadyNotifiedUids(
  db: Database,
  candidateUids: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (candidateUids.length === 0) return new Set();
  const rows = await db
    .select({ resourceId: notifications.resourceId })
    .from(notifications)
    .where(
      and(
        eq(notifications.resourceType, RESOURCE_TYPE_BACKUP_JOB),
        inArray(notifications.resourceId, candidateUids as string[]),
      ),
    );
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.resourceId) seen.add(row.resourceId);
  }
  return seen;
}

async function notifyForFailure(
  db: Database,
  failure: BackupJobMeta,
  log: { warn: (msg: string, err?: unknown) => void },
): Promise<void> {
  const recipients = failure.clientId
    ? await resolveRecipients(db, { kind: 'client', clientId: failure.clientId })
    : await resolveRecipients(db, { kind: 'admin' });

  if (recipients.length === 0) {
    log.warn(
      `no recipients for failed backup job ${failure.namespace}/${failure.name} (clientId=${failure.clientId ?? 'admin'})`,
    );
    return;
  }

  const reason = failure.failureReason
    ? failure.failureReason.slice(0, 500)
    : 'Job entered Failed state without a status condition message.';

  await notifyUsers(db, recipients, {
    type: severityToNotificationType(failure.severity),
    title: `Backup job failed: ${failure.displayName}`,
    message:
      `The backup job ${failure.namespace}/${failure.name} failed. ` +
      `Category: ${failure.category}, severity: ${failure.severity}. ` +
      `Reason: ${reason}`,
    resourceType: RESOURCE_TYPE_BACKUP_JOB,
    resourceId: failure.uid,
  });
}
