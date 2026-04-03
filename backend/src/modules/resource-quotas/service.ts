import { eq, and, notInArray } from 'drizzle-orm';
import { resourceQuotas, clients, hostingPlans, deployments } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { parseResourceValue } from '../../shared/resource-parser.js';
import { clientNotFound } from '../../shared/errors.js';

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

// ─── Resource Availability ────────────────────────────────────────────────────

const DEFAULT_CPU_LIMIT = 2;     // cores
const DEFAULT_MEMORY_LIMIT = 4;  // Gi
const DEFAULT_STORAGE_LIMIT = 50; // Gi

interface ResourceAvailability {
  readonly cpuLimit: number;
  readonly memoryLimitGi: number;
  readonly storageLimitGi: number;
  readonly cpuUsed: number;
  readonly memoryUsedGi: number;
  readonly storageUsedGi: number;
  readonly cpuAvailable: number;
  readonly memoryAvailableGi: number;
  readonly storageAvailableGi: number;
}

export async function getClientResourceAvailability(
  db: Database,
  clientId: string,
): Promise<ResourceAvailability> {
  // 1. Fetch client record
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId));

  if (!client) {
    throw clientNotFound(clientId);
  }

  // 2. Fetch the hosting plan
  const [plan] = await db
    .select()
    .from(hostingPlans)
    .where(eq(hostingPlans.id, client.planId));

  // 3. Resolve effective limits: override > plan > default
  const cpuLimit = Number(client.cpuLimitOverride) || Number(plan?.cpuLimit) || DEFAULT_CPU_LIMIT;
  const memoryLimitGi = Number(client.memoryLimitOverride) || Number(plan?.memoryLimit) || DEFAULT_MEMORY_LIMIT;
  const storageLimitGi = Number(client.storageLimitOverride) || Number(plan?.storageLimit) || DEFAULT_STORAGE_LIMIT;

  // 4. Sum current usage from active deployments
  const excludedStatuses = ['deleted', 'failed'] as const;
  const activeDeployments = await db
    .select({
      cpuRequest: deployments.cpuRequest,
      memoryRequest: deployments.memoryRequest,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.clientId, clientId),
        notInArray(deployments.status, [...excludedStatuses]),
      ),
    );

  // 5. Parse and sum resource values
  let cpuUsed = 0;
  let memoryUsedGi = 0;

  for (const dep of activeDeployments) {
    cpuUsed += parseResourceValue(dep.cpuRequest, 'cpu');
    memoryUsedGi += parseResourceValue(dep.memoryRequest, 'memory');
  }

  // Storage: estimate 1 Gi per active deployment (MVP approximation)
  const storageUsedGi = activeDeployments.length * 1;

  return {
    cpuLimit,
    memoryLimitGi,
    storageLimitGi,
    cpuUsed,
    memoryUsedGi,
    storageUsedGi,
    cpuAvailable: Math.max(0, cpuLimit - cpuUsed),
    memoryAvailableGi: Math.max(0, memoryLimitGi - memoryUsedGi),
    storageAvailableGi: Math.max(0, storageLimitGi - storageUsedGi),
  };
}
