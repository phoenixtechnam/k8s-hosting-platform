/**
 * Ingress reconciler.
 *
 * Builds Ingress resources from ingress_routes table.
 * Each route with an assigned workload becomes an Ingress rule.
 * Applies cert-manager TLS annotations when auto-TLS is enabled.
 */

import { eq } from 'drizzle-orm';
import { ingressRoutes, workloads, domains } from '../../db/schema.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';
import { createRoute } from '../ingress-routes/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconcile the Ingress resource for a client namespace.
 * Builds rules from ingress_routes that have workloads assigned.
 * If no routable routes exist, deletes the Ingress.
 */
export async function reconcileIngress(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  namespace: string,
): Promise<void> {
  // Get all domains for this client
  const clientDomains = await db.select().from(domains).where(eq(domains.clientId, clientId));
  const domainIds = clientDomains.map(d => d.id);

  const ingressName = `${namespace}-ingress`;

  if (domainIds.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  // Get all ingress routes with assigned workloads for this client's domains
  const allRoutes = await db.select().from(ingressRoutes);
  const clientRoutes = allRoutes.filter(
    r => domainIds.includes(r.domainId) && r.workloadId && r.status === 'active',
  );

  // Auto-migrate: create ingress_routes for legacy domains with workloadId
  for (const domain of clientDomains) {
    if (!domain.workloadId) continue;
    const alreadyRouted = clientRoutes.some(r => r.hostname === domain.domainName);
    if (alreadyRouted) continue;

    try {
      await createRoute(db, domain.id, clientId, domain.domainName, domain.workloadId);
    } catch {
      // Route already exists or creation failed — continue
    }
  }

  // Re-fetch routes after migration
  const updatedAllRoutes = await db.select().from(ingressRoutes);
  const updatedRoutes = updatedAllRoutes.filter(
    r => domainIds.includes(r.domainId) && r.workloadId && r.status === 'active',
  );

  if (updatedRoutes.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  // Build workload name lookup
  const clientWorkloads = await db.select().from(workloads).where(eq(workloads.clientId, clientId));
  const workloadMap = new Map<string, string>();
  for (const w of clientWorkloads) {
    workloadMap.set(w.id, w.name);
  }

  // Build rules from ingress_routes (single source of truth)
  const rules = updatedRoutes
    .map(route => {
      const serviceName = workloadMap.get(route.workloadId!);
      if (!serviceName) return null;

      return {
        host: route.hostname,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: {
                name: serviceName,
                port: { number: 80 },
              },
            },
          }],
        },
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rules.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  // Build annotations
  const annotations: Record<string, string> = {};
  const autoTls = await isAutoTlsEnabled(db);
  if (autoTls) {
    annotations['cert-manager.io/cluster-issuer'] = await getClusterIssuerName(db);
  }

  // Build TLS section from all routed hostnames
  const routedHostnames = rules.map(r => (r as { host: string }).host);
  const tls = autoTls
    ? routedHostnames.map(h => ({
        hosts: [h],
        secretName: domainToSecretName(h),
      }))
    : undefined;

  const ingressBody = {
    metadata: {
      name: ingressName,
      namespace,
      annotations,
    },
    spec: {
      ingressClassName: 'nginx',
      rules,
      ...(tls ? { tls } : {}),
    },
  };

  try {
    await k8s.networking.createNamespacedIngress({ namespace, body: ingressBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.networking.replaceNamespacedIngress({ name: ingressName, namespace, body: ingressBody });
    } else {
      throw err;
    }
  }
}
