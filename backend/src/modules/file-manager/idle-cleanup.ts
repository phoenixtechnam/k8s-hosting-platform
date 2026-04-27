import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const LAST_ACCESS_ANNOTATION = 'platform.phoenix-host.net/file-manager-last-access';

// Per-process cache (reduces API server load between writes — we still
// reconcile against the Deployment annotation for cross-pod truth).
const lastAccessMap = new Map<string, number>();

/**
 * Record activity. Updates the in-process cache AND the FM Deployment
 * annotation so other platform-api replicas (each running their own
 * idle-cleanup loop) see the same access time. The annotation write
 * is fire-and-forget — a failure here would just mean another replica
 * might prematurely scale down, so we tolerate transient errors.
 */
export function recordFileManagerAccess(namespace: string, k8s?: K8sClients): void {
  const now = Date.now();
  lastAccessMap.set(namespace, now);
  // Wrap the k8s client call in a try block — a missing or partially
  // mocked client (`k8s.apps` undefined) would otherwise throw
  // synchronously, escaping the promise's `.catch`. Real callers
  // pass a fully-shaped client; tests pass a mock that may not
  // implement every nested property.
  if (!k8s?.apps?.patchNamespacedDeployment) return;
  try {
    void k8s.apps.patchNamespacedDeployment({
      name: 'file-manager',
      namespace,
      body: { metadata: { annotations: { [LAST_ACCESS_ANNOTATION]: String(now) } } },
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH).catch((err: unknown) => {
      // Deployment may not exist yet (first /start hasn't created
      // it), or pod may be racing the controller — either way, the
      // in-memory cache covers the current pod.
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) {
        console.warn(`[file-manager] last-access annotation write failed for ${namespace}:`, (err as Error).message);
      }
    });
  } catch (err) {
    console.warn(`[file-manager] last-access annotation skipped for ${namespace}:`, (err as Error).message);
  }
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

          // Cross-pod truth: annotation set by recordFileManagerAccess()
          // in any platform-api replica. Falls back to in-memory cache
          // if the annotation is missing (older Deployment, or a race
          // where /start hasn't yet annotated).
          //
          // CRITICAL: a Deployment that was JUST created by /start
          // has neither annotation nor cache entry on replicas other
          // than the one that handled the request. Treating that as
          // "idle since epoch" would scale it to 0 immediately —
          // racing /start. Use the Deployment's own creationTimestamp
          // as the floor so a brand-new FM gets a full IDLE_TIMEOUT_MS
          // grace window even before any /status poll lands.
          const annotations = (deploy as { metadata?: { annotations?: Record<string, string>; creationTimestamp?: string } }).metadata?.annotations ?? {};
          const annotated = Number(annotations[LAST_ACCESS_ANNOTATION] ?? '');
          const cached = lastAccessMap.get(ns) ?? 0;
          const created = Date.parse((deploy as { metadata?: { creationTimestamp?: string } }).metadata?.creationTimestamp ?? '');
          const createdMs = Number.isFinite(created) ? created : 0;
          const lastAccess = Math.max(
            Number.isFinite(annotated) ? annotated : 0,
            cached,
            createdMs, // NEW: floor at creation time so fresh FMs aren't insta-killed
          );

          if (now - lastAccess > IDLE_TIMEOUT_MS) {
            console.log(`[file-manager-cleanup] Scaling down idle file-manager in ${ns} (idle for ${Math.round((now - lastAccess) / 60_000)}m)`);
            await k8s.apps.patchNamespacedDeployment({
              name: 'file-manager',
              namespace: ns,
              body: { spec: { replicas: 0 } },
            } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
              STRATEGIC_MERGE_PATCH);
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
