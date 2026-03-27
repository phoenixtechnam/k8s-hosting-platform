import { eq } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

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

      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}
