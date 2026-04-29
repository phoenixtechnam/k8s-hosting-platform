/**
 * Boot-time reconciliation: re-apply every existing client ResourceQuota
 * with the new shape (no SYSTEM_*_RESERVE padding, scopeSelector matching
 * `tenant-default` PriorityClass).
 *
 * Idempotent. Safe to run on every boot — quotas that already match the
 * target shape are left alone (server-side replace is a no-op for byte-
 * identical specs). Quotas whose scopeSelector field is immutable (set
 * to a different scope or unset) are deleted + recreated by
 * applyResourceQuota's existing fallback path.
 *
 * RBAC: platform-api ServiceAccount already has cluster-wide
 * list/get/create/replace/delete on resourcequotas (used by the original
 * applyResourceQuota path).
 */

import type { Database } from '../../db/index.js';
import { clients, hostingPlans } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { applyResourceQuota } from './service.js';
import type { K8sClients } from './k8s-client.js';

interface ReconcileResult {
  readonly scanned: number;
  readonly reconciled: number;
  readonly skipped: number;
  readonly errors: ReadonlyArray<{ clientId: string; error: string }>;
}

export async function reconcileAllClientQuotas(
  db: Database,
  k8s: K8sClients,
  log: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void },
): Promise<ReconcileResult> {
  const rows = await db
    .select({
      id: clients.id,
      namespace: clients.kubernetesNamespace,
      planId: clients.planId,
      cpuLimit: hostingPlans.cpuLimit,
      memoryLimit: hostingPlans.memoryLimit,
      storageLimit: hostingPlans.storageLimit,
    })
    .from(clients)
    .leftJoin(hostingPlans, eq(hostingPlans.id, clients.planId));

  let reconciled = 0;
  let skipped = 0;
  const errors: Array<{ clientId: string; error: string }> = [];

  for (const c of rows) {
    if (!c.namespace || !c.cpuLimit || !c.memoryLimit || !c.storageLimit) {
      skipped++;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await applyResourceQuota(k8s, c.namespace, {
        cpu: String(c.cpuLimit),
        memory: String(c.memoryLimit),
        storage: String(c.storageLimit),
      });
      reconciled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ clientId: c.id, error: msg });
      log.warn(
        { clientId: c.id, namespace: c.namespace, err: msg },
        'quota-reconcile: failed for client; will retry on next boot',
      );
    }
  }

  log.info(
    { scanned: rows.length, reconciled, skipped, errors: errors.length },
    'quota-reconcile: done (auto-applied scopeSelector + plan-exact limits)',
  );

  return { scanned: rows.length, reconciled, skipped, errors };
}
