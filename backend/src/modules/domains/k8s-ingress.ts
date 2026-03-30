/**
 * Ingress reconciler.
 *
 * Creates/updates a single Ingress resource per client namespace,
 * routing all client domains to their assigned workloads.
 * Applies cert-manager TLS annotations when auto-TLS is enabled.
 */

import { eq } from 'drizzle-orm';
import { domains, workloads } from '../../db/schema.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';
import { domainToSecretName } from '../ssl-certs/cert-manager.js';
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
 * Builds the full Ingress from all client domains + workload mappings.
 * If no domains exist, deletes the Ingress.
 */
export async function reconcileIngress(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  namespace: string,
): Promise<void> {
  // Fetch all domains for this client
  const clientDomains = await db.select().from(domains).where(eq(domains.clientId, clientId));

  const ingressName = `${namespace}-ingress`;

  // No domains → delete Ingress if it exists
  if (clientDomains.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  // Fetch all workloads for routing
  const clientWorkloads = await db.select().from(workloads).where(eq(workloads.clientId, clientId));
  const workloadMap = new Map<string, string>();
  for (const w of clientWorkloads) {
    workloadMap.set(w.id, w.name);
  }

  // Build Ingress rules
  const rules = clientDomains.map(domain => {
    const serviceName = domain.workloadId
      ? (workloadMap.get(domain.workloadId) ?? clientWorkloads[0]?.name ?? 'default')
      : (clientWorkloads[0]?.name ?? 'default');

    return {
      host: domain.domainName,
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
  });

  // Build annotations
  const annotations: Record<string, string> = {};
  const autoTls = await isAutoTlsEnabled(db);
  if (autoTls) {
    annotations['cert-manager.io/cluster-issuer'] = await getClusterIssuerName(db);
  }

  // Build TLS section
  const tls = autoTls
    ? clientDomains.map(d => ({
        hosts: [d.domainName],
        secretName: domainToSecretName(d.domainName),
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

  // Create or replace Ingress
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
