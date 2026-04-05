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

/** Check if a pod/metrics entry is a system service (file-manager, etc.) */
function isSystemPod(labels: Record<string, string> | undefined): boolean {
  return labels?.['platform.io/system'] === 'true';
}

type PodMetricsItem = {
  readonly metadata?: { readonly labels?: Record<string, string> };
  readonly containers?: ReadonlyArray<{ readonly usage?: { readonly cpu?: string; readonly memory?: string } }>;
};

type PodItem = {
  readonly metadata?: { readonly labels?: Record<string, string> };
  readonly spec?: {
    readonly containers?: ReadonlyArray<{
      readonly resources?: {
        readonly limits?: { readonly cpu?: string; readonly memory?: string };
        readonly requests?: { readonly cpu?: string; readonly memory?: string };
      };
    }>;
  };
};

export async function collectClientMetrics(
  _db: Database,
  k8s: K8sClients,
  clientId: string,
  namespace: string,
  planLimits: { readonly cpuLimit: number; readonly memoryLimitGi: number; readonly storageLimitGi: number },
): Promise<ResourceMetrics> {
  // 1. Actual usage from Metrics API — exclude system pods
  let cpuInUse = 0;
  let memoryInUse = 0;

  try {
    const metricsResult = await k8s.custom.listNamespacedCustomObject({
      group: 'metrics.k8s.io',
      version: 'v1beta1',
      namespace,
      plural: 'pods',
    });

    const pods = (metricsResult as { items?: readonly PodMetricsItem[] }).items ?? [];

    for (const pod of pods) {
      if (isSystemPod(pod.metadata?.labels)) continue; // Skip file-manager etc.
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

  // 2. Reserved (allocated) from actual pod specs — exclude system pods
  //    This is more accurate than ResourceQuota status.used which includes
  //    system services (file-manager) that shouldn't count against user quota.
  let cpuReserved = 0;
  let memoryReserved = 0;

  try {
    const podList = await k8s.core.listNamespacedPod({ namespace });
    const pods = (podList as { items?: readonly PodItem[] }).items ?? [];

    for (const pod of pods) {
      if (isSystemPod(pod.metadata?.labels)) continue; // Skip file-manager etc.
      for (const container of pod.spec?.containers ?? []) {
        const limits = container.resources?.limits;
        if (limits?.cpu) cpuReserved += parseResourceValue(limits.cpu, 'cpu');
        if (limits?.memory) memoryReserved += parseResourceValue(limits.memory, 'memory');
      }
    }
  } catch {
    // Fall back to ResourceQuota if pod listing fails
    try {
      const quota = await k8s.core.readNamespacedResourceQuota({
        name: `${namespace}-quota`,
        namespace,
      });
      const used = (quota as { status?: { used?: Record<string, string> } }).status?.used ?? {};
      if (used['limits.cpu']) cpuReserved = parseResourceValue(used['limits.cpu'], 'cpu');
      if (used['limits.memory']) memoryReserved = parseResourceValue(used['limits.memory'], 'memory');
    } catch {
      // Quota might not exist yet
    }
  }

  // 3. Storage reserved from ResourceQuota (PVC-level, not affected by system pods)
  let storageReserved = 0;
  try {
    const quota = await k8s.core.readNamespacedResourceQuota({
      name: `${namespace}-quota`,
      namespace,
    });
    const used = (quota as { status?: { used?: Record<string, string> } }).status?.used ?? {};
    if (used['requests.storage']) storageReserved = parseResourceValue(used['requests.storage'], 'storage');
  } catch {
    // Quota might not exist yet
  }

  // 4. Storage actual usage from file-manager (if running)
  let storageInUse = 0;
  try {
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
