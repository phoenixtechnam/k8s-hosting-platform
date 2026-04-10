import { eq } from 'drizzle-orm';
import { clients, domains, deployments, cronJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface BulkResult {
  readonly succeeded: string[];
  readonly failed: ReadonlyArray<{ readonly id: string; readonly error: string }>;
}

export async function bulkUpdateClientStatus(
  db: Database,
  clientIds: readonly string[],
  action: 'suspend' | 'reactivate',
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  const targetStatus = action === 'suspend' ? 'suspended' : 'active';

  for (const id of clientIds) {
    try {
      const [client] = await db.select({ id: clients.id, status: clients.status })
        .from(clients)
        .where(eq(clients.id, id));

      if (!client) {
        failed.push({ id, error: `Client '${id}' not found` });
        continue;
      }

      await db.update(clients)
        .set({ status: targetStatus as typeof clients.$inferInsert['status'] })
        .where(eq(clients.id, id));

      if (targetStatus === 'suspended') {
        await db.update(domains).set({ status: 'suspended' }).where(eq(domains.clientId, id));
        await db.update(deployments).set({ status: 'stopped' }).where(eq(deployments.clientId, id));
        await db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.clientId, id));
      } else if (targetStatus === 'active') {
        await db.update(domains).set({ status: 'active' }).where(eq(domains.clientId, id));
        await db.update(cronJobs).set({ enabled: 1 }).where(eq(cronJobs.clientId, id));
      }

      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}

export async function bulkDeleteClients(
  db: Database,
  clientIds: readonly string[],
  k8sClients?: K8sClients,
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of clientIds) {
    try {
      const [client] = await db.select()
        .from(clients)
        .where(eq(clients.id, id));

      if (!client) {
        failed.push({ id, error: `Client '${id}' not found` });
        continue;
      }

      // Best-effort k8s namespace cleanup
      if (k8sClients && client.kubernetesNamespace && client.provisioningStatus === 'provisioned') {
        try {
          await k8sClients.core.deleteNamespace({ name: client.kubernetesNamespace });
        } catch (err: unknown) {
          console.warn(`[bulk-delete] Failed to delete namespace ${client.kubernetesNamespace}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await db.delete(clients).where(eq(clients.id, id));
      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}
