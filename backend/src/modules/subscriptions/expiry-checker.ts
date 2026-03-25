import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export async function suspendExpiredClients(db: Database): Promise<number> {
  const now = new Date();

  const result = await db
    .update(clients)
    .set({ status: 'suspended' })
    .where(
      and(
        eq(clients.status, 'active'),
        isNotNull(clients.subscriptionExpiresAt),
        lt(clients.subscriptionExpiresAt, now),
      ),
    );

  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}
