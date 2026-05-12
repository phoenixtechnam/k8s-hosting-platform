// Status reconciler integration for custom deployments.
//
// Called from the existing `deployments/status-reconciler.ts` loop
// for rows with `source='custom'`. The catalog reconciler resolves
// the catalog entry's component list to figure out what Deployment
// names to check; custom deployments have exactly ONE Deployment
// per row in Phase 1 (the `deployment.name` itself), so we can skip
// that resolver entirely.
//
// Side effects per tick:
//   1. Read the k8s Deployment by name + namespace.
//   2. Translate observed readyReplicas / Pod phases to a DB status.
//   3. Capture the first scheduled node (for the "Node" admin column).
//   4. Record image-audit rows from pod.containerStatuses.

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { recordImageAudit } from './image-audit.js';

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

type DbStatus = 'running' | 'stopped' | 'pending' | 'failed';

interface ReconcileOutcome {
  readonly status: DbStatus;
  readonly statusMessage: string | null;
  readonly node: string | null;
}

/**
 * Reconcile a single custom-deployment row against the cluster.
 * Returns the desired DB state; the caller persists it. Errors are
 * thrown so the parent reconciler can surface them in its
 * `errors[]` summary.
 */
export async function reconcileCustomRow(
  db: Database,
  k8s: K8sClients,
  row: typeof deployments.$inferSelect,
  namespace: string,
): Promise<ReconcileOutcome> {
  const k8sDeployment = await readDeploymentSafe(k8s, namespace, row.name);

  if (k8sDeployment === null) {
    // Deployment not found in the cluster — either we've just
    // created the DB row and the k8s apply is in flight, or
    // someone deleted the underlying object out-of-band.
    if (row.status === 'deploying' || row.status === 'pending') {
      const age = Date.now() - row.updatedAt.getTime();
      if (age > STALE_TIMEOUT_MS) {
        return {
          status: 'failed',
          statusMessage: 'k8s Deployment was not created within 60 minutes.',
          node: null,
        };
      }
      return { status: row.status as DbStatus, statusMessage: row.statusMessage, node: null };
    }
    return { status: 'failed', statusMessage: 'k8s Deployment is missing.', node: null };
  }

  const ready = k8sDeployment.status?.readyReplicas ?? 0;
  const desired = k8sDeployment.spec?.replicas ?? 1;

  // Capture host node + run audit in parallel with the status read —
  // both are read-only ops and don't depend on the reconcile outcome.
  const [podObservation] = await Promise.all([
    readFirstPodObservation(k8s, namespace, row.name),
    recordImageAudit(db, k8s, row.id, namespace, row.name).catch(() => 0),
  ]);

  // If the Deployment is at-or-above desired replicas, it's running.
  // If there are SOME ready replicas, it's progressing. Zero ready
  // and at least one Pod in CrashLoopBackOff / ImagePullBackOff is a
  // failure.
  let status: DbStatus;
  let statusMessage: string | null = null;
  if (ready >= desired && desired > 0) {
    status = 'running';
  } else if (podObservation.failureReason) {
    status = 'failed';
    statusMessage = podObservation.failureReason;
  } else if (desired === 0) {
    status = 'stopped';
  } else {
    status = 'pending';
    statusMessage = podObservation.pendingReason ?? null;

    // Staleness escalation — same shape as the catalog reconciler.
    if (row.status === 'pending' || row.status === 'deploying') {
      const age = Date.now() - row.updatedAt.getTime();
      if (age > STALE_TIMEOUT_MS) {
        status = 'failed';
        statusMessage = `Timed out after 60 minutes: ${statusMessage ?? 'no progress'}`;
      }
    }
  }

  return {
    status,
    statusMessage,
    node: podObservation.node,
  };
}

interface PodObservation {
  readonly node: string | null;
  readonly failureReason: string | null;
  readonly pendingReason: string | null;
}

async function readFirstPodObservation(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
): Promise<PodObservation> {
  type PodListItem = {
    spec?: { nodeName?: string };
    status?: {
      phase?: string;
      containerStatuses?: Array<{
        name?: string;
        state?: {
          waiting?: { reason?: string; message?: string };
          terminated?: { reason?: string; message?: string };
        };
        ready?: boolean;
        restartCount?: number;
      }>;
      conditions?: Array<{ type?: string; status?: string; message?: string }>;
    };
  };
  let pods: { items?: PodListItem[] };
  try {
    pods = (await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${deploymentName}`,
    } as Parameters<typeof k8s.core.listNamespacedPod>[0])) as unknown as { items?: PodListItem[] };
  } catch {
    return { node: null, failureReason: null, pendingReason: null };
  }

  let node: string | null = null;
  let failureReason: string | null = null;
  let pendingReason: string | null = null;
  for (const pod of pods.items ?? []) {
    if (!node && pod.spec?.nodeName) node = pod.spec.nodeName;
    for (const cs of pod.status?.containerStatuses ?? []) {
      const waitingReason = cs.state?.waiting?.reason;
      const terminatedReason = cs.state?.terminated?.reason;
      if (waitingReason && (waitingReason.includes('Err') || waitingReason.includes('BackOff'))) {
        failureReason = `${cs.name ?? 'container'}: ${waitingReason} — ${cs.state?.waiting?.message ?? ''}`.trim();
      } else if (waitingReason && !cs.ready) {
        pendingReason = `${cs.name ?? 'container'}: ${waitingReason}`;
      }
      if (terminatedReason === 'OOMKilled') {
        failureReason = `${cs.name ?? 'container'}: OOMKilled (restart count ${cs.restartCount ?? 0})`;
      }
    }
  }
  return { node, failureReason, pendingReason };
}

interface K8sDeploymentLike {
  status?: { readyReplicas?: number };
  spec?: { replicas?: number };
}

async function readDeploymentSafe(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<K8sDeploymentLike | null> {
  try {
    return (await k8s.apps.readNamespacedDeployment({ name, namespace })) as unknown as K8sDeploymentLike;
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return null;
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** Apply the reconcile outcome to the DB row. Idempotent — no-op
 *  when nothing changed. */
export async function applyReconcileOutcome(
  db: Database,
  rowId: string,
  current: typeof deployments.$inferSelect,
  outcome: ReconcileOutcome,
): Promise<boolean> {
  const nodeChanged = outcome.node !== (current.currentNodeName ?? null);
  const statusChanged = outcome.status !== current.status;
  const messageChanged = outcome.statusMessage !== (current.statusMessage ?? null);
  if (!nodeChanged && !statusChanged && !messageChanged) return false;
  await db.update(deployments)
    .set({
      status: outcome.status,
      statusMessage: outcome.statusMessage,
      currentNodeName: outcome.node,
    })
    .where(eq(deployments.id, rowId));
  return true;
}
