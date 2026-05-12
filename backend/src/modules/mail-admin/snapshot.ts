/**
 * Mail snapshot management — Stalwart state export (stalwart -e) via CronJob.
 *
 * The stalwart binary (not stalwart-cli) supports store-agnostic export/import:
 *   Export: stalwart -c /etc/stalwart/config.json -e <output-path>
 *   Import: stalwart -c /etc/stalwart/config.json -i <input-path>
 * Output format: LZ4-compressed binary (~6× compression), store-agnostic.
 *
 * A CronJob (k8s/base/stalwart-mail/stalwart/snapshot-cronjob.yaml) runs the
 * export every 2 minutes. This module manages and observes that CronJob, and
 * can trigger one-shot manual snapshot Jobs.
 *
 * Used for DR recovery when DataStore moves to RocksDB on local-path: on pod
 * reschedule the restore-state initContainer in the Stalwart Deployment
 * downloads the latest snapshot and runs `stalwart -i`.
 *
 * GET  /admin/mail/snapshot-status
 * POST /admin/mail/snapshot/trigger
 * GET  /admin/mail/snapshot/jobs/:name
 */

import { ApiError } from '../../shared/errors.js';
import {
  type MailSnapshotStatusResponse,
  type MailSnapshotTriggerResponse,
  type MailSnapshotJobStatusResponse,
  mailSnapshotStatusResponseSchema,
  mailSnapshotTriggerResponseSchema,
  mailSnapshotJobStatusResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const SNAPSHOT_CRONJOB_NAME = 'stalwart-snapshot';
const SNAPSHOT_JOB_LABEL_KEY = 'app.kubernetes.io/component';
const SNAPSHOT_JOB_LABEL_VALUE = 'stalwart-snapshot';
const SNAPSHOT_JOB_MANUAL_PREFIX = 'stalwart-snapshot-manual-';
/** A snapshot is considered stale if its age exceeds this threshold. */
const SNAPSHOT_STALE_THRESHOLD_SECONDS = 300; // 5 minutes

export interface SnapshotOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sClientsBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
  batch: import('@kubernetes/client-node').BatchV1Api;
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sClientsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
  };
}

function randomShort(): string {
  // Lowercase alnum 8 chars — fits in K8s name constraints.
  return Math.random().toString(36).slice(2, 10);
}

interface CronJobShape {
  spec?: {
    schedule?: string;
    suspend?: boolean;
    jobTemplate?: {
      spec?: Record<string, unknown>;
    };
  };
}

interface JobShape {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
  };
  status?: {
    startTime?: string;
    completionTime?: string;
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: { type: string; status: string; message?: string }[];
  };
}

interface JobListShape {
  items?: JobShape[];
}

function jobStatusFromConditions(
  job: JobShape,
): MailSnapshotJobStatusResponse['status'] {
  const conds = job.status?.conditions ?? [];
  if (conds.some((c) => c.type === 'Complete' && c.status === 'True')) return 'succeeded';
  if (conds.some((c) => c.type === 'Failed' && c.status === 'True')) return 'failed';
  if ((job.status?.active ?? 0) > 0) return 'running';
  if (job.status?.startTime) return 'running';
  return 'queued';
}

/**
 * GET /admin/mail/snapshot-status
 *
 * Returns the live state of the stalwart-snapshot CronJob + the most recent
 * Job it produced. Does NOT fetch pod logs (too expensive for a status poll).
 */
export async function getMailSnapshotStatus(
  opts: SnapshotOptions,
): Promise<MailSnapshotStatusResponse> {
  const { batch } = await loadK8sClients(opts.kubeconfigPath);

  // ── 1. Read the CronJob to check enabled/schedule ──────────────────
  let cronJob: CronJobShape | null = null;
  try {
    cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as CronJobShape;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code !== 404) throw err;
    // CronJob does not exist → disabled
  }

  const enabled = cronJob != null && !cronJob.spec?.suspend;
  const scheduleExpression = cronJob?.spec?.schedule ?? '*/2 * * * *';

  // ── 2. List Jobs with the snapshot label ──────────────────────────
  let jobs: JobShape[] = [];
  try {
    const result = await batch.listNamespacedJob({
      namespace: MAIL_NAMESPACE,
      labelSelector: `${SNAPSHOT_JOB_LABEL_KEY}=${SNAPSHOT_JOB_LABEL_VALUE}`,
    } as unknown as Parameters<typeof batch.listNamespacedJob>[0]) as JobListShape;
    jobs = result.items ?? [];
  } catch {
    // Non-fatal — we'll just report no jobs
    jobs = [];
  }

  // Count only successfully completed Jobs — failed/running jobs are not
  // persisted snapshots. TTL-GC means the window is ~1h for automatic jobs.
  const snapshotCount = jobs.filter((j) =>
    (j.status?.conditions ?? []).some((c) => c.type === 'Complete' && c.status === 'True'),
  ).length;

  // ── 3. Find the most recently completed Job ────────────────────────
  const successfulJobs = jobs.filter((j) => {
    const conds = j.status?.conditions ?? [];
    return conds.some((c) => c.type === 'Complete' && c.status === 'True');
  });

  // Sort descending by completionTime to find the most recent
  successfulJobs.sort((a, b) => {
    const ta = a.status?.completionTime ?? '';
    const tb = b.status?.completionTime ?? '';
    return tb.localeCompare(ta);
  });

  const lastJob = successfulJobs[0] ?? null;
  const lastSnapshotAt = lastJob?.status?.completionTime ?? null;

  // ── 4. Compute seconds since last snapshot ────────────────────────
  let secondsSinceLastSnapshot: number | null = null;
  if (lastSnapshotAt) {
    const elapsed = Math.floor(
      (Date.now() - new Date(lastSnapshotAt).getTime()) / 1000,
    );
    secondsSinceLastSnapshot = Math.max(0, elapsed);
  }

  // ── 5. Determine health ───────────────────────────────────────────
  // Healthy when: CronJob is enabled AND either no snapshot exists yet
  // (schedule hasn't fired yet) OR the last snapshot is fresh.
  const healthy = enabled && (
    lastSnapshotAt === null ||
    (secondsSinceLastSnapshot !== null &&
      secondsSinceLastSnapshot < SNAPSHOT_STALE_THRESHOLD_SECONDS)
  );

  return mailSnapshotStatusResponseSchema.parse({
    enabled,
    scheduleExpression,
    lastSnapshotAt: lastSnapshotAt ?? null,
    lastSnapshotSizeBytes: null, // not available from Job metadata (would need pod log parsing)
    snapshotCount,
    secondsSinceLastSnapshot,
    healthy,
    backupStoreId: null, // Phase 2: wired when active BackupStore integration is complete
  });
}

/**
 * POST /admin/mail/snapshot/trigger
 *
 * Spawns a one-shot Job based on the stalwart-snapshot CronJob template.
 * Returns immediately with the Job name. UI polls
 * GET /admin/mail/snapshot/jobs/:name for status.
 */
export async function triggerMailSnapshot(
  opts: SnapshotOptions,
): Promise<MailSnapshotTriggerResponse> {
  const { batch } = await loadK8sClients(opts.kubeconfigPath);

  // Read the CronJob to get the job template
  let cronJob: CronJobShape | null = null;
  try {
    cronJob = await batch.readNamespacedCronJob({
      namespace: MAIL_NAMESPACE,
      name: SNAPSHOT_CRONJOB_NAME,
    }) as CronJobShape;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError(
        'SNAPSHOT_CRONJOB_NOT_FOUND',
        'stalwart-snapshot CronJob does not exist — apply the manifest first',
        404,
      );
    }
    throw err;
  }

  const jobName = `${SNAPSHOT_JOB_MANUAL_PREFIX}${randomShort()}`;
  const startedAt = new Date().toISOString();

  const jobManifest = renderManualSnapshotJob(jobName, cronJob);

  try {
    await batch.createNamespacedJob({
      namespace: MAIL_NAMESPACE,
      body: jobManifest as unknown as object,
    });
  } catch (err) {
    throw new ApiError(
      'SNAPSHOT_JOB_CREATE_FAILED',
      `failed to create snapshot Job: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  return mailSnapshotTriggerResponseSchema.parse({
    jobName,
    startedAt,
  });
}

/**
 * GET /admin/mail/snapshot/jobs/:name
 *
 * Poll endpoint — the UI reads this every 3s while the Job is running.
 * Returns the Job status + last 50 lines of pod log.
 */
export async function getMailSnapshotJobStatus(
  jobName: string,
  opts: SnapshotOptions,
): Promise<MailSnapshotJobStatusResponse> {
  if (!/^stalwart-snapshot-(?:manual-|)[a-z0-9-]+$/.test(jobName)) {
    throw new ApiError(
      'SNAPSHOT_JOB_INVALID_NAME',
      'job name must match the stalwart-snapshot-* shape',
      400,
    );
  }

  const { core, batch } = await loadK8sClients(opts.kubeconfigPath);

  const job = await batch.readNamespacedJob({
    namespace: MAIL_NAMESPACE,
    name: jobName,
  }).catch((err) => {
    const code = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError('SNAPSHOT_JOB_NOT_FOUND', `job ${jobName} not found`, 404);
    }
    throw err;
  }) as JobShape;

  const status = jobStatusFromConditions(job);
  const startedAt = job.status?.startTime ?? null;
  const completedAt = job.status?.completionTime ?? null;
  const failureReason =
    (job.status?.conditions ?? []).find((c) => c.type === 'Failed')?.message ?? null;

  // Read Pod log (best-effort)
  let podLogTail: string | null = null;
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: `job-name=${jobName}`,
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0]) as {
      items?: { metadata?: { name?: string } }[];
    };
    const podName = pods.items?.[0]?.metadata?.name;
    if (podName) {
      const log = await core.readNamespacedPodLog({
        namespace: MAIL_NAMESPACE,
        name: podName,
        tailLines: 50,
        // Read from the `snapshot` container (not render-config)
        container: 'snapshot',
      });
      podLogTail =
        typeof log === 'string' ? log : (log as { body?: string }).body ?? null;
    }
  } catch {
    podLogTail = null;
  }

  return mailSnapshotJobStatusResponseSchema.parse({
    jobName,
    status,
    startedAt: typeof startedAt === 'string' ? startedAt : null,
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    podLogTail,
    failureReason,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Render a one-shot Job from the CronJob's jobTemplate spec.
 * The Job is labelled with stalwart-snapshot so it shows up in
 * `getMailSnapshotStatus()` counts and the snapshot-status poll.
 */
function renderManualSnapshotJob(jobName: string, cronJob: CronJobShape): unknown {
  const jobTemplateSpec = cronJob.spec?.jobTemplate?.spec ?? {};
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: MAIL_NAMESPACE,
      labels: {
        [SNAPSHOT_JOB_LABEL_KEY]: SNAPSHOT_JOB_LABEL_VALUE,
        'stalwart-snapshot-trigger': 'manual',
      },
    },
    spec: {
      ...jobTemplateSpec,
      // Override ttlSecondsAfterFinished so manual jobs are visible for 1 hour
      ttlSecondsAfterFinished: 3600,
      template: {
        ...((jobTemplateSpec as Record<string, unknown>).template ?? {}),
        metadata: {
          labels: {
            [SNAPSHOT_JOB_LABEL_KEY]: SNAPSHOT_JOB_LABEL_VALUE,
            'job-name': jobName,
            'stalwart-snapshot-trigger': 'manual',
          },
        },
      },
    },
  };
}
