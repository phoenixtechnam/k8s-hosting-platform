import type { V1CSINode } from '@kubernetes/client-node';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// Surface the readiness of key infrastructure Deployments without
// requiring Prometheus. The admin panel uses this for a simple
// traffic-light row on the Load Balancer settings page (CNPG,
// cert-manager, Longhorn manager, ingress-nginx).
//
// Plus per-node networking + storage subsystem health for the M4
// Cluster Nodes page. Without this, a worker that joined but never
// got Calico / Longhorn-CSI healthy would show as "Ready" on the
// node card but silently refuse tenant workloads.

export interface ComponentReadiness {
  readonly name: string;
  readonly namespace: string;
  readonly kind: 'Deployment' | 'DaemonSet';
  readonly desired: number;
  readonly ready: number;
  readonly healthy: boolean;
  readonly message?: string;
}

const TRACKED: ReadonlyArray<{ ns: string; name: string; kind: 'Deployment' | 'DaemonSet'; optional?: boolean }> = [
  { ns: 'cnpg-system', name: 'cnpg-controller-manager', kind: 'Deployment', optional: true },
  { ns: 'cert-manager', name: 'cert-manager', kind: 'Deployment' },
  { ns: 'cert-manager', name: 'cert-manager-webhook', kind: 'Deployment' },
  { ns: 'ingress-nginx', name: 'ingress-nginx-controller', kind: 'DaemonSet' },
  { ns: 'longhorn-system', name: 'longhorn-manager', kind: 'DaemonSet', optional: true },
  { ns: 'flux-system', name: 'kustomize-controller', kind: 'Deployment' },
  { ns: 'flux-system', name: 'source-controller', kind: 'Deployment' },
];

export async function collectClusterHealth(k8s: K8sClients): Promise<ComponentReadiness[]> {
  // Fan out all reads in parallel — the original sequential loop
  // added ~100-300 ms × 7 of latency per request. Logging the
  // underlying error server-side keeps debuggability while the
  // response only carries a generic message so we don't leak
  // cluster-internal details to the admin UI.
  const results = await Promise.all(TRACKED.map(async (t): Promise<ComponentReadiness> => {
    try {
      if (t.kind === 'Deployment') {
        const res = await k8s.apps.readNamespacedDeployment({ namespace: t.ns, name: t.name });
        const desired = res.spec?.replicas ?? 0;
        const ready = res.status?.readyReplicas ?? 0;
        return {
          name: t.name,
          namespace: t.ns,
          kind: 'Deployment',
          desired,
          ready,
          healthy: desired > 0 && ready === desired,
        };
      }
      const res = await k8s.apps.readNamespacedDaemonSet({ namespace: t.ns, name: t.name });
      const desired = res.status?.desiredNumberScheduled ?? 0;
      const ready = res.status?.numberReady ?? 0;
      return {
        name: t.name,
        namespace: t.ns,
        kind: 'DaemonSet',
        desired,
        ready,
        healthy: desired > 0 && ready === desired,
      };
    } catch (err) {
      const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status === 404 && t.optional) {
        return {
          name: t.name,
          namespace: t.ns,
          kind: t.kind,
          desired: 0,
          ready: 0,
          healthy: false,
          message: 'not installed',
        };
      }
      console.error(`[cluster-health] ${t.ns}/${t.name} read failed:`, err instanceof Error ? err.message : err);
      return {
        name: t.name,
        namespace: t.ns,
        kind: t.kind,
        desired: 0,
        ready: 0,
        healthy: false,
        message: 'read failed',
      };
    }
  }));

  return results;
}

export type NodeSubsystemStatus = 'healthy' | 'degraded' | 'missing';

export interface NodeSubsystemReport {
  readonly nodeName: string;
  readonly calico: NodeSubsystemStatus;
  readonly calicoMessage?: string;
  readonly longhornCsi: NodeSubsystemStatus;
  readonly longhornCsiMessage?: string;
  readonly csiDriverRegistered: boolean;
}

/**
 * Per-node networking + storage health. Surfaces the case where a
 * worker joined the cluster but the CNI / CSI plugins never reached
 * Ready — exactly the failure mode that hit the admin worker on
 * 2026-04-24 (Calico BIRD socket + Longhorn CSI plugin
 * CrashLoopBackOff because of cross-subnet network plumbing).
 */
export async function collectNodeSubsystemHealth(k8s: K8sClients): Promise<NodeSubsystemReport[]> {
  const nodes = await k8s.core.listNode();
  const out: NodeSubsystemReport[] = [];
  // Field selector on listNamespacedPod is per-namespace, so we query
  // each tracked namespace once and bucket by spec.nodeName.
  const calicoPods = await k8s.core.listNamespacedPod({ namespace: 'calico-system' }).catch(() => ({ items: [] as unknown[] }));
  const longhornPods = await k8s.core.listNamespacedPod({ namespace: 'longhorn-system' }).catch(() => ({ items: [] as unknown[] }));

  // CSINode resources tell us which CSI drivers are registered on each node.
  // CSINode lives in storage.k8s.io/v1 — a built-in API, NOT a CRD — so the
  // CustomObjects client returns empty lists for it. Use the typed
  // StorageV1Api directly. (Bug fix 2026-04-25: customObjects path silently
  // reported every node as "csiDriverRegistered: false" even on healthy
  // nodes, scaring operators on the Cluster Nodes page.)
  let csiNodes: V1CSINode[] = [];
  try {
    const res = await k8s.storage.listCSINode();
    csiNodes = res.items;
  } catch (err) {
    console.error('[cluster-health] listCSINode failed:', err instanceof Error ? err.message : err);
  }

  type Pod = { metadata?: { labels?: Record<string, string>; name?: string }; spec?: { nodeName?: string }; status?: { phase?: string; containerStatuses?: { ready?: boolean; name?: string }[] } };

  function podHealth(pods: Pod[], nodeName: string, labelKey: string, labelValue: string): { status: NodeSubsystemStatus; message?: string } {
    const match = pods.find((p) => p.spec?.nodeName === nodeName && p.metadata?.labels?.[labelKey] === labelValue);
    if (!match) return { status: 'missing', message: `No ${labelValue} pod scheduled on this node` };
    const allReady = (match.status?.containerStatuses ?? []).every((c) => c.ready === true);
    if (allReady && match.status?.phase === 'Running') return { status: 'healthy' };
    const notReady = (match.status?.containerStatuses ?? []).filter((c) => c.ready !== true).map((c) => c.name).join(', ');
    return { status: 'degraded', message: `Containers not ready: ${notReady || match.status?.phase || 'unknown'}` };
  }

  for (const node of nodes.items ?? []) {
    const name = node.metadata?.name ?? '<unknown>';
    const calico = podHealth(calicoPods.items as Pod[], name, 'k8s-app', 'calico-node');
    const longhornCsi = podHealth(longhornPods.items as Pod[], name, 'app', 'longhorn-csi-plugin');
    const csiNode = csiNodes.find((c) => c.metadata?.name === name);
    const csiDriverRegistered = (csiNode?.spec?.drivers ?? []).some((d) => d.name === 'driver.longhorn.io');

    out.push({
      nodeName: name,
      calico: calico.status,
      calicoMessage: calico.message,
      longhornCsi: longhornCsi.status,
      longhornCsiMessage: longhornCsi.message,
      csiDriverRegistered,
    });
  }

  return out;
}
