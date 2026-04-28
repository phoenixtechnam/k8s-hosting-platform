/**
 * Backup-health service — pure functions over Kubernetes Job listings.
 *
 * Side-effect-free: no DB writes, no notifications. The scheduler
 * (`scheduler.ts`) owns side effects and calls into here for the
 * pure shape transformations. Easy to unit-test against fixture
 * Job JSON.
 */

import * as k8s from '@kubernetes/client-node';
import {
  ANNOTATION_DISPLAY_NAME,
  LABEL_CATEGORY,
  LABEL_CLIENT_ID,
  LABEL_HEALTH_WATCH,
  LABEL_SEVERITY,
  parseCategory,
  parseSeverity,
  type BackupCategory,
  type BackupSeverity,
} from './labels.js';

export interface BackupJobMeta {
  readonly uid: string;
  readonly name: string;
  readonly namespace: string;
  readonly groupKey: string;
  readonly displayName: string;
  readonly category: BackupCategory;
  readonly severity: BackupSeverity;
  readonly clientId: string | null;
  readonly state: 'succeeded' | 'failed' | 'running' | 'unknown';
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly failureReason: string | null;
}

export interface BackupHealthSummary {
  readonly groupKey: string;
  readonly displayName: string;
  readonly namespace: string;
  readonly category: BackupCategory;
  readonly severity: BackupSeverity;
  readonly clientId: string | null;
  readonly state: 'healthy' | 'failing' | 'never_run';
  readonly lastSuccessAt: Date | null;
  readonly lastFailedAt: Date | null;
  readonly lastFailedReason: string | null;
  readonly recentRuns: number;
}

/**
 * List Jobs cluster-wide matching the backup-health-watch label.
 *
 * Throws on apiserver errors so the calling tick can log + skip rather
 * than silently no-oping (a token rotation or transient 5xx would
 * otherwise hide the failure for hours). The scheduler's outer
 * try/catch in runTick converts the throw into a logged warning.
 */
export async function listHealthWatchedJobs(
  batch: k8s.BatchV1Api,
): Promise<ReadonlyArray<BackupJobMeta>> {
  const jobList = await batch.listJobForAllNamespaces({
    labelSelector: `${LABEL_HEALTH_WATCH}=true`,
  } as unknown as Parameters<typeof batch.listJobForAllNamespaces>[0]);

  const result: BackupJobMeta[] = [];
  for (const job of jobList.items ?? []) {
    const meta = parseJob(job);
    if (meta) result.push(meta);
  }
  return result;
}

export function parseJob(job: k8s.V1Job): BackupJobMeta | null {
  const uid = job.metadata?.uid;
  const name = job.metadata?.name;
  const namespace = job.metadata?.namespace;
  if (!uid || !name || !namespace) return null;

  const labels = job.metadata?.labels ?? {};
  const annotations = job.metadata?.annotations ?? {};

  const category = parseCategory(labels[LABEL_CATEGORY]);
  const severity = parseSeverity(labels[LABEL_SEVERITY]);
  const clientId = labels[LABEL_CLIENT_ID] ?? null;

  const parentRef = (job.metadata?.ownerReferences ?? []).find(
    (ref) => ref.kind === 'CronJob' || ref.kind === 'cronjob',
  );
  const groupKey = parentRef?.name ?? name;

  const displayName = annotations[ANNOTATION_DISPLAY_NAME] ?? groupKey;

  const state = deriveJobState(job);
  const startedAt = job.status?.startTime ? new Date(job.status.startTime) : null;
  const completedAt = job.status?.completionTime
    ? new Date(job.status.completionTime)
    : null;

  const failureReason = state === 'failed' ? extractFailureReason(job) : null;

  return {
    uid,
    name,
    namespace,
    groupKey,
    displayName,
    category,
    severity,
    clientId,
    state,
    startedAt,
    completedAt,
    failureReason,
  };
}

function deriveJobState(job: k8s.V1Job): BackupJobMeta['state'] {
  const conditions = job.status?.conditions ?? [];
  for (const cond of conditions) {
    if (cond.status !== 'True') continue;
    if (cond.type === 'Complete') return 'succeeded';
    if (cond.type === 'Failed') return 'failed';
  }
  if ((job.status?.succeeded ?? 0) > 0) return 'succeeded';
  if ((job.status?.failed ?? 0) > 0) return 'failed';
  if ((job.status?.active ?? 0) > 0) return 'running';
  return 'unknown';
}

function extractFailureReason(job: k8s.V1Job): string | null {
  const conditions = job.status?.conditions ?? [];
  for (const cond of conditions) {
    if (cond.type === 'Failed' && cond.status === 'True' && cond.message) {
      return cond.message;
    }
  }
  return null;
}

export function summariseHealth(
  jobs: ReadonlyArray<BackupJobMeta>,
): ReadonlyArray<BackupHealthSummary> {
  const byGroup = new Map<string, BackupJobMeta[]>();
  for (const j of jobs) {
    const key = `${j.namespace}/${j.groupKey}`;
    const arr = byGroup.get(key) ?? [];
    arr.push(j);
    byGroup.set(key, arr);
  }

  const result: BackupHealthSummary[] = [];
  for (const [, runs] of byGroup) {
    runs.sort((a, b) => {
      const at = a.startedAt?.getTime() ?? 0;
      const bt = b.startedAt?.getTime() ?? 0;
      return bt - at;
    });
    const newest = runs[0]!;
    const lastSuccess = runs.find((r) => r.state === 'succeeded') ?? null;
    const lastFailed = runs.find((r) => r.state === 'failed') ?? null;

    let state: BackupHealthSummary['state'];
    if (!lastSuccess && !lastFailed) {
      state = 'never_run';
    } else if (
      lastFailed &&
      (!lastSuccess ||
        (lastFailed.startedAt?.getTime() ?? 0) > (lastSuccess.startedAt?.getTime() ?? 0))
    ) {
      state = 'failing';
    } else {
      state = 'healthy';
    }

    result.push({
      groupKey: newest.groupKey,
      displayName: newest.displayName,
      namespace: newest.namespace,
      category: newest.category,
      severity: newest.severity,
      clientId: newest.clientId,
      state,
      lastSuccessAt: lastSuccess?.completedAt ?? lastSuccess?.startedAt ?? null,
      lastFailedAt: lastFailed?.completedAt ?? lastFailed?.startedAt ?? null,
      lastFailedReason: lastFailed?.failureReason ?? null,
      recentRuns: runs.length,
    });
  }
  const order: Record<BackupHealthSummary['state'], number> = {
    failing: 0,
    never_run: 1,
    healthy: 2,
  };
  result.sort((a, b) => {
    const so = order[a.state] - order[b.state];
    if (so !== 0) return so;
    return a.displayName.localeCompare(b.displayName);
  });
  return result;
}

export function findNewFailures(
  jobs: ReadonlyArray<BackupJobMeta>,
  alreadyNotifiedUids: ReadonlySet<string>,
): ReadonlyArray<BackupJobMeta> {
  return jobs.filter((j) => j.state === 'failed' && !alreadyNotifiedUids.has(j.uid));
}
