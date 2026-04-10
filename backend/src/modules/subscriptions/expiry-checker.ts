import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
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

  return result.length;
}
