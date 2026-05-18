import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { applySuspended } from '../tenant-lifecycle/cascades.js';

/**
 * Suspend every tenant whose subscription has expired. No grace period
 * — as soon as `subscriptionExpiresAt < now` the cascade fires:
 * workloads scale to 0, ingress swaps to platform-suspended, mail is
 * disabled. Admin can reactivate by updating the tenant with a new
 * `subscriptionExpiresAt` and `status='active'`.
 */
export async function suspendExpiredTenants(db: Database): Promise<number> {
  // Find candidates first so we can iterate per-tenant and run the
  // full cascade (ingress swap etc.). A bare UPDATE would skip the k8s
  // side entirely.
  // SYSTEM tenant protection (ADR-040): exclude is_system=true from
  // the candidate query. The updateTenant guard already blocks setting
  // subscription_expires_at on SYSTEM, but a direct-SQL write or a
  // missed code path could still leave a value there — this is the
  // belt-and-braces second line of defense. CI guard
  // scripts/ci-system-tenant-check.sh asserts this filter is present.
  const candidates = await db
    .select({ id: tenants.id, namespace: tenants.kubernetesNamespace })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, 'active'),
        eq(tenants.isSystem, false),
        isNotNull(tenants.subscriptionExpiresAt),
        lt(tenants.subscriptionExpiresAt, new Date()),
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
