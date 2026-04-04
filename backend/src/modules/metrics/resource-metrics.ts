import { getRedis } from '../../shared/redis.js';
import { parseResourceValue } from '../../shared/resource-parser.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

const CACHE_KEY_PREFIX = 'metrics:';
const CACHE_TTL = 7200; // 2 hours (auto-expire even if refresh fails)

export interface ResourceMetrics {
  readonly clientId: string;
  readonly cpu: { readonly inUse: number; readonly reserved: number; readonly available: number };
  readonly memory: { readonly inUse: number; readonly reserved: number; readonly available: number }; // in Gi
  readonly storage: { readonly inUse: number; readonly reserved: number; readonly available: number }; // in Gi
  readonly lastUpdatedAt: string;
}

export async function collectClientMetrics(
  _db: Database,
  k8s: K8sClients,
  clientId: string,
  namespace: string,
  planLimits: { readonly cpuLimit: number; readonly memoryLimitGi: number; readonly storageLimitGi: number },
): Promise<ResourceMetrics> {
  // 1. Actual usage from Metrics API
  let cpuInUse = 0;
  let memoryInUse = 0;

  try {
    // Use the K8s custom objects API to hit metrics.k8s.io
    const metricsResult = await k8s.custom.listNamespacedCustomObject({
      group: 'metrics.k8s.io',
      version: 'v1beta1',
      namespace,
      plural: 'pods',
    });

    const pods = (metricsResult as { items?: ReadonlyArray<{ containers?: ReadonlyArray<{ usage?: { cpu?: string; memory?: string } }> }> }).items ?? [];

    for (const pod of pods) {
      for (const container of pod.containers ?? []) {
        if (container.usage?.cpu) {
          cpuInUse += parseResourceValue(container.usage.cpu, 'cpu');
        }
        if (container.usage?.memory) {
          memoryInUse += parseResourceValue(container.usage.memory, 'memory');
        }
      }
    }
  } catch (err) {
    console.warn(`[metrics] Failed to get metrics for ${namespace}:`, err instanceof Error ? err.message : String(err));
  }

  // 2. Reserved (allocated) from ResourceQuota
  let cpuReserved = 0;
  let memoryReserved = 0;
  let storageReserved = 0;

  try {
    const quota = await k8s.core.readNamespacedResourceQuota({
      name: `${namespace}-quota`,
      namespace,
    });
    const used = (quota as { status?: { used?: Record<string, string> } }).status?.used ?? {};

    if (used['limits.cpu']) cpuReserved = parseResourceValue(used['limits.cpu'], 'cpu');
    if (used['limits.memory']) memoryReserved = parseResourceValue(used['limits.memory'], 'memory');
    if (used['requests.storage']) storageReserved = parseResourceValue(used['requests.storage'], 'storage');
  } catch {
    // Quota might not exist yet
  }

  // 3. Storage actual usage from file-manager (if running)
  let storageInUse = 0;
  try {
    // Try to get disk usage via file-manager sidecar service proxy
    // This is optional — if sidecar isn't running, we skip
    const { proxyToFileManager } = await import('../file-manager/service.js');
    const kubeconfigPath = process.env.KUBECONFIG_PATH;
    const result = await proxyToFileManager(kubeconfigPath, namespace, '/disk-usage');
    if (result.status === 200) {
      const data = JSON.parse(result.body) as { usedBytes?: number };
      storageInUse = (data.usedBytes ?? 0) / (1024 * 1024 * 1024); // bytes to Gi
    }
  } catch {
    // File manager not running — leave storageInUse as 0
  }

  const metrics: ResourceMetrics = {
    clientId,
    cpu: {
      inUse: Math.round(cpuInUse * 1000) / 1000,
      reserved: Math.round(cpuReserved * 1000) / 1000,
      available: planLimits.cpuLimit,
    },
    memory: {
      inUse: Math.round(memoryInUse * 1000) / 1000,
      reserved: Math.round(memoryReserved * 1000) / 1000,
      available: planLimits.memoryLimitGi,
    },
    storage: {
      inUse: Math.round(storageInUse * 1000) / 1000,
      reserved: Math.round(storageReserved * 1000) / 1000,
      available: planLimits.storageLimitGi,
    },
    lastUpdatedAt: new Date().toISOString(),
  };

  // Cache in Redis
  const redis = getRedis();
  await redis.setex(`${CACHE_KEY_PREFIX}${clientId}`, CACHE_TTL, JSON.stringify(metrics));

  return metrics;
}

export async function getCachedMetrics(clientId: string): Promise<ResourceMetrics | null> {
  const redis = getRedis();
  const cached = await redis.get(`${CACHE_KEY_PREFIX}${clientId}`);
  if (!cached) return null;
  return JSON.parse(cached) as ResourceMetrics;
}

export async function getAllCachedMetrics(clientIds: readonly string[]): Promise<Record<string, ResourceMetrics>> {
  if (clientIds.length === 0) return {};
  const redis = getRedis();
  const keys = clientIds.map(id => `${CACHE_KEY_PREFIX}${id}`);
  const values = await redis.mget(...keys);

  const result: Record<string, ResourceMetrics> = {};
  for (let i = 0; i < clientIds.length; i++) {
    const raw = values[i];
    if (raw) {
      result[clientIds[i]] = JSON.parse(raw) as ResourceMetrics;
    }
  }
  return result;
}
