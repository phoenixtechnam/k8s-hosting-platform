/**
 * Workload status reconciler.
 *
 * Checks actual k8s Deployment/pod status and updates DB accordingly.
 * Detects CrashLoopBackOff, OOMKilled, ImagePullBackOff.
 */

import { eq, inArray } from 'drizzle-orm';
import { workloads, clients } from '../../db/schema.js';
import { getWorkloadStatus } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReconcileResult {
  readonly checked: number;
  readonly updated: number;
  readonly errors: readonly string[];
}

// ─── Map k8s phase to DB status ─────────────────────────────────────────────

function phaseToDbStatus(phase: string): 'running' | 'stopped' | 'pending' | 'failed' {
  switch (phase) {
    case 'running': return 'running';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    case 'starting': return 'pending';
    case 'not_deployed': return 'pending';
    default: return 'pending';
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconcile all workloads that are in a non-terminal DB state
 * (running, pending) against actual k8s cluster state.
 */
export async function reconcileWorkloadStatuses(
  db: Database,
  k8s: K8sClients,
): Promise<ReconcileResult> {
  let checked = 0;
  let updated = 0;
  const errors: string[] = [];

  // Get all workloads in active states
  const activeWorkloads = await db
    .select()
    .from(workloads)
    .where(inArray(workloads.status, ['running', 'pending']));

  if (activeWorkloads.length === 0) {
    return { checked: 0, updated: 0, errors: [] };
  }

  // Group workloads by client for namespace lookup
  const clientIds = [...new Set(activeWorkloads.map(w => w.clientId))];
  const clientRows = await db
    .select({ id: clients.id, kubernetesNamespace: clients.kubernetesNamespace })
    .from(clients)
    .where(inArray(clients.id, clientIds));

  const namespaceMap = new Map<string, string>();
  for (const c of clientRows) {
    if (c.kubernetesNamespace) {
      namespaceMap.set(c.id, c.kubernetesNamespace);
    }
  }

  for (const workload of activeWorkloads) {
    const namespace = namespaceMap.get(workload.clientId);
    if (!namespace) continue;

    checked++;

    try {
      const k8sStatus = await getWorkloadStatus(k8s, namespace, workload.name);
      const newDbStatus = phaseToDbStatus(k8sStatus.phase);

      if (newDbStatus !== workload.status) {
        await db.update(workloads).set({ status: newDbStatus }).where(eq(workloads.id, workload.id));
        updated++;
      }
    } catch (err) {
      errors.push(`${workload.name} (${workload.id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked, updated, errors };
}
