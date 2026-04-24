import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// Surface the readiness of key infrastructure Deployments without
// requiring Prometheus. The admin panel uses this for a simple
// traffic-light row on the Load Balancer settings page (CNPG,
// cert-manager, Longhorn manager, ingress-nginx).

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
  const out: ComponentReadiness[] = [];

  for (const t of TRACKED) {
    try {
      if (t.kind === 'Deployment') {
        const res = await k8s.apps.readNamespacedDeployment({ namespace: t.ns, name: t.name });
        const desired = res.spec?.replicas ?? 0;
        const ready = res.status?.readyReplicas ?? 0;
        out.push({
          name: t.name,
          namespace: t.ns,
          kind: 'Deployment',
          desired,
          ready,
          healthy: desired > 0 && ready === desired,
        });
      } else {
        const res = await k8s.apps.readNamespacedDaemonSet({ namespace: t.ns, name: t.name });
        const desired = res.status?.desiredNumberScheduled ?? 0;
        const ready = res.status?.numberReady ?? 0;
        out.push({
          name: t.name,
          namespace: t.ns,
          kind: 'DaemonSet',
          desired,
          ready,
          healthy: desired > 0 && ready === desired,
        });
      }
    } catch (err) {
      const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status === 404 && t.optional) {
        out.push({
          name: t.name,
          namespace: t.ns,
          kind: t.kind,
          desired: 0,
          ready: 0,
          healthy: false,
          message: 'not installed',
        });
        continue;
      }
      out.push({
        name: t.name,
        namespace: t.ns,
        kind: t.kind,
        desired: 0,
        ready: 0,
        healthy: false,
        message: (err as Error).message ?? 'read failed',
      });
    }
  }

  return out;
}
