import { eq } from 'drizzle-orm';
import { resourceQuotas } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export async function getResourceQuota(db: Database, clientId: string) {
  const [quota] = await db
    .select()
    .from(resourceQuotas)
    .where(eq(resourceQuotas.clientId, clientId));

  if (!quota) {
    // Auto-create default quota for client
    const id = crypto.randomUUID();
    await db.insert(resourceQuotas).values({ id, clientId });
    const [created] = await db.select().from(resourceQuotas).where(eq(resourceQuotas.id, id));
    return created;
  }

  return quota;
}

interface UpdateQuotaInput {
  readonly cpu_cores_limit?: number;
  readonly memory_gb_limit?: number;
  readonly storage_gb_limit?: number;
  readonly bandwidth_gb_limit?: number;
}

export async function updateResourceQuota(db: Database, clientId: string, input: UpdateQuotaInput) {
  // Ensure quota exists
  await getResourceQuota(db, clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.cpu_cores_limit !== undefined) updateValues.cpuCoresLimit = String(input.cpu_cores_limit);
  if (input.memory_gb_limit !== undefined) updateValues.memoryGbLimit = input.memory_gb_limit;
  if (input.storage_gb_limit !== undefined) updateValues.storageGbLimit = input.storage_gb_limit;
  if (input.bandwidth_gb_limit !== undefined) updateValues.bandwidthGbLimit = input.bandwidth_gb_limit;

  if (Object.keys(updateValues).length > 0) {
    await db.update(resourceQuotas).set(updateValues).where(eq(resourceQuotas.clientId, clientId));
  }

  return getResourceQuota(db, clientId);
}
