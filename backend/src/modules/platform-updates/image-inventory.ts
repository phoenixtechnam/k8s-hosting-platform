/**
 * Enumerate the container images currently running on the cluster for
 * the platform's own components. The Admin Panel renders this as a
 * table so the operator can see what's actually deployed (image +
 * resolved tag) vs what the UI reports as "current version".
 *
 * Sources:
 *   - Deployments in `platform` and `platform-system` namespaces
 *   - Platform-controlled deployments in cluster add-on namespaces
 *     (ingress-nginx, cert-manager, longhorn-system, flux-system,
 *     sealed-secrets) — useful to spot drift from pinned chart versions
 *
 * Returns image refs grouped by component with status hints (Running /
 * degraded / partial). Falls back to an empty list if the k8s API is
 * unreachable — the UI shows an error message rather than crashing.
 */

import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export interface ImageInventoryEntry {
  readonly component: string;
  readonly namespace: string;
  readonly image: string;
  readonly tag: string;
  readonly running: number;
  readonly desired: number;
  readonly healthy: boolean;
}

interface DeploymentListItem {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: Array<{ image?: string; name?: string }> } };
  };
  status?: { readyReplicas?: number; availableReplicas?: number };
}

interface DeploymentList {
  items?: DeploymentListItem[];
}

interface DaemonSetListItem {
  metadata?: { name?: string; namespace?: string };
  spec?: { template?: { spec?: { containers?: Array<{ image?: string; name?: string }> } } };
  status?: { numberReady?: number; desiredNumberScheduled?: number };
}

interface DaemonSetList {
  items?: DaemonSetListItem[];
}

interface StatefulSetListItem {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    template?: { spec?: { containers?: Array<{ image?: string; name?: string }> } };
  };
  status?: { readyReplicas?: number };
}

interface StatefulSetList {
  items?: StatefulSetListItem[];
}

// Namespaces whose platform-controlled workloads we surface. Client
// namespaces (`client-*`) are intentionally excluded — this view is
// about the platform itself, not tenants.
const PLATFORM_NAMESPACES = [
  'platform',
  'platform-system',
  'ingress-nginx',
  'cert-manager',
  'longhorn-system',
  'flux-system',
  'sealed-secrets',
  'calico-system',
  'tigera-operator',
];

function parseImageRef(image: string): { image: string; tag: string } {
  // Strip digest if present (image@sha256:...) — keep the repo path.
  const withoutDigest = image.split('@')[0];
  const lastColon = withoutDigest.lastIndexOf(':');
  // No tag → treat as :latest. A colon inside a port segment (e.g.
  // registry:5000/foo) doesn't count; check there's no slash after.
  if (lastColon === -1 || withoutDigest.indexOf('/', lastColon) !== -1) {
    return { image: withoutDigest, tag: 'latest' };
  }
  return {
    image: withoutDigest.slice(0, lastColon),
    tag: withoutDigest.slice(lastColon + 1),
  };
}

export async function getImageInventory(
  kubeconfigPath?: string,
): Promise<ImageInventoryEntry[]> {
  try {
    const clients = createK8sClients(kubeconfigPath);
    const entries: ImageInventoryEntry[] = [];

    for (const ns of PLATFORM_NAMESPACES) {
      // Deployments
      const deployments = await clients.apps
        .listNamespacedDeployment({ namespace: ns })
        .catch(() => ({ items: [] } as DeploymentList)) as DeploymentList;

      for (const d of deployments.items ?? []) {
        const name = d.metadata?.name;
        const containers = d.spec?.template?.spec?.containers ?? [];
        const desired = d.spec?.replicas ?? 0;
        const running = d.status?.readyReplicas ?? 0;
        for (const c of containers) {
          if (!name || !c.image) continue;
          const { image, tag } = parseImageRef(c.image);
          entries.push({
            component: containers.length > 1 ? `${name}/${c.name ?? 'main'}` : name,
            namespace: ns,
            image,
            tag,
            running,
            desired,
            healthy: desired > 0 && running >= desired,
          });
        }
      }

      // DaemonSets (ingress-nginx, calico-node, etc.)
      const daemonsets = await clients.apps
        .listNamespacedDaemonSet({ namespace: ns })
        .catch(() => ({ items: [] } as DaemonSetList)) as DaemonSetList;

      for (const ds of daemonsets.items ?? []) {
        const name = ds.metadata?.name;
        const containers = ds.spec?.template?.spec?.containers ?? [];
        const desired = ds.status?.desiredNumberScheduled ?? 0;
        const running = ds.status?.numberReady ?? 0;
        for (const c of containers) {
          if (!name || !c.image) continue;
          const { image, tag } = parseImageRef(c.image);
          entries.push({
            component: containers.length > 1 ? `${name}/${c.name ?? 'main'}` : name,
            namespace: ns,
            image,
            tag,
            running,
            desired,
            healthy: desired > 0 && running >= desired,
          });
        }
      }

      // StatefulSets (postgres, longhorn CSI, etc.)
      const statefulsets = await clients.apps
        .listNamespacedStatefulSet({ namespace: ns })
        .catch(() => ({ items: [] } as StatefulSetList)) as StatefulSetList;

      for (const ss of statefulsets.items ?? []) {
        const name = ss.metadata?.name;
        const containers = ss.spec?.template?.spec?.containers ?? [];
        const desired = ss.spec?.replicas ?? 0;
        const running = ss.status?.readyReplicas ?? 0;
        for (const c of containers) {
          if (!name || !c.image) continue;
          const { image, tag } = parseImageRef(c.image);
          entries.push({
            component: containers.length > 1 ? `${name}/${c.name ?? 'main'}` : name,
            namespace: ns,
            image,
            tag,
            running,
            desired,
            healthy: desired > 0 && running >= desired,
          });
        }
      }
    }

    // Stable ordering: group by namespace (matches our PLATFORM_NAMESPACES
    // list), then by component name.
    const nsOrder = new Map(PLATFORM_NAMESPACES.map((n, i) => [n, i]));
    entries.sort((a, b) => {
      const an = nsOrder.get(a.namespace) ?? 999;
      const bn = nsOrder.get(b.namespace) ?? 999;
      if (an !== bn) return an - bn;
      return a.component.localeCompare(b.component);
    });

    return entries;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[image-inventory] failed to enumerate:', err instanceof Error ? err.message : err);
    return [];
  }
}
