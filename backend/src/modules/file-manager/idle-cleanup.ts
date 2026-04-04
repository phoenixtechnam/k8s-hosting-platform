import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Track last access time per namespace
const lastAccessMap = new Map<string, number>();

export function recordFileManagerAccess(namespace: string): void {
  lastAccessMap.set(namespace, Date.now());
}

export function startIdleCleanup(kubeconfigPath?: string, intervalMs = 60_000): NodeJS.Timeout | null {
  let k8s: ReturnType<typeof createK8sClients>;
  try {
    k8s = createK8sClients(kubeconfigPath);
  } catch {
    console.warn('[file-manager-cleanup] K8s not available, skipping idle cleanup');
    return null;
  }

  console.log('[file-manager-cleanup] Starting idle cleanup (10min timeout)');

  return setInterval(async () => {
    const now = Date.now();

    try {
      // List all namespaces with file-manager deployments
      const namespaces = await k8s.core.listNamespace({});
      const nsList = ((namespaces as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [])
        .map(ns => ns.metadata?.name)
        .filter((n): n is string => !!n && n.startsWith('client-'));

      for (const ns of nsList) {
        try {
          const deploy = await k8s.apps.readNamespacedDeployment({ name: 'file-manager', namespace: ns });
          const replicas = (deploy as { spec?: { replicas?: number } }).spec?.replicas ?? 0;

          if (replicas === 0) continue; // Already scaled down

          const lastAccess = lastAccessMap.get(ns) ?? 0;
          if (now - lastAccess > IDLE_TIMEOUT_MS) {
            console.log(`[file-manager-cleanup] Scaling down idle file-manager in ${ns}`);
            await k8s.apps.patchNamespacedDeployment({
              name: 'file-manager',
              namespace: ns,
              body: { spec: { replicas: 0 } },
              contentType: 'application/strategic-merge-patch+json',
            } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
            lastAccessMap.delete(ns);
          }
        } catch {
          // Deployment doesn't exist or other error — skip
        }
      }
    } catch (err) {
      console.error('[file-manager-cleanup] Error:', err);
    }
  }, intervalMs);
}
