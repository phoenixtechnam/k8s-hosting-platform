import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { clients, domains, deployments, cronJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export async function suspendExpiredClients(db: Database): Promise<number> {
  const result = await db
    .update(clients)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(
      and(
        eq(clients.status, 'active'),
        isNotNull(clients.subscriptionExpiresAt),
        lt(clients.subscriptionExpiresAt, new Date()),
      ),
    )
    .returning({ id: clients.id });

  // Cascade suspension to child resources
  for (const row of result) {
    await db.update(domains).set({ status: 'suspended' }).where(eq(domains.clientId, row.id));
    await db.update(deployments).set({ status: 'stopped' }).where(eq(deployments.clientId, row.id));
    await db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.clientId, row.id));
  }

  return result.length;
}
