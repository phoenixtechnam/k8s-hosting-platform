import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { applySuspended } from '../client-lifecycle/cascades.js';

/**
 * Suspend every client whose subscription has expired. No grace period
 * — as soon as `subscriptionExpiresAt < now` the cascade fires:
 * workloads scale to 0, ingress swaps to platform-suspended, mail is
 * disabled. Admin can reactivate by updating the client with a new
 * `subscriptionExpiresAt` and `status='active'`.
 */
export async function suspendExpiredClients(db: Database): Promise<number> {
  // Find candidates first so we can iterate per-client and run the
  // full cascade (ingress swap etc.). A bare UPDATE would skip the k8s
  // side entirely.
  const candidates = await db
    .select({ id: clients.id, namespace: clients.kubernetesNamespace })
    .from(clients)
    .where(
      and(
        eq(clients.status, 'active'),
        isNotNull(clients.subscriptionExpiresAt),
        lt(clients.subscriptionExpiresAt, new Date()),
      ),
    );

  if (candidates.length === 0) return 0;

  const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
  const ctx = { db, k8s };

  for (const c of candidates) {
    try {
      await applySuspended(ctx, c.id, c.namespace);
    } catch (err) {
      console.warn(`[expiry-checker] applySuspended failed for ${c.id}: ${(err as Error).message}`);
    }
  }

  return candidates.length;
}
