/**
 * Ingress reconciler.
 *
 * Builds Ingress resources from ingress_routes table.
 * Each route with an assigned deployment becomes an Ingress rule.
 *
 * Phase 2c: TLS secret names are resolved via the central certificates
 * module (ensureRouteCertificate), which:
 *   - Creates/updates a cert-manager Certificate CR per domain (or
 *     per hostname for non-wildcard cases)
 *   - Returns the correct secret name to put in the Ingress TLS section
 *   - Handles wildcard cert reuse when dnsMode=primary + PowerDNS
 *
 * This replaces the old "cert-manager.io/cluster-issuer" Ingress
 * annotation approach, which was ambiguous (the annotation triggered
 * implicit Certificate creation that conflicted with explicit ones).
 */

import { eq } from 'drizzle-orm';
import { ingressRoutes, deployments, domains } from '../../db/schema.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { ensureRouteCertificate } from '../certificates/service.js';
import { createRoute } from '../ingress-routes/service.js';
import { syncAllRouteAnnotations } from '../ingress-routes/annotation-sync.js';
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
 * Builds rules from ingress_routes that have deployments assigned.
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

  // Get all ingress routes with assigned deployments for this client's domains
  const allRoutes = await db.select().from(ingressRoutes);
  const clientRoutes = allRoutes.filter(
    r => domainIds.includes(r.domainId) && r.deploymentId && r.status === 'active',
  );

  // Auto-migrate: create ingress_routes for legacy domains with deploymentId
  for (const domain of clientDomains) {
    if (!domain.deploymentId) continue;
    const alreadyRouted = clientRoutes.some(r => r.hostname === domain.domainName);
    if (alreadyRouted) continue;

    try {
      await createRoute(db, domain.id, clientId, domain.domainName, domain.deploymentId);
    } catch {
      // Route already exists or creation failed — continue
    }
  }

  // Re-fetch routes after migration
  const updatedAllRoutes = await db.select().from(ingressRoutes);
  const updatedRoutes = updatedAllRoutes.filter(
    r => domainIds.includes(r.domainId) && r.deploymentId && r.status === 'active',
  );

  if (updatedRoutes.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  // Build deployment name lookup
  const clientDeployments = await db.select().from(deployments).where(eq(deployments.clientId, clientId));
  const deploymentMap = new Map<string, string>();
  for (const d of clientDeployments) {
    // K8s service name is {name}-{resourceSuffix} (see k8s-deployer.ts:k8sResourceName)
    const k8sServiceName = d.resourceSuffix ? `${d.name}-${d.resourceSuffix}` : d.name;
    deploymentMap.set(d.id, k8sServiceName);
  }

  // Build rules from ingress_routes (single source of truth), tracking
  // each rule's (hostname, domainId) so we can resolve TLS secret names
  // below via the certificates module.
  interface RuleWithDomain {
    rule: {
      host: string;
      http: {
        paths: Array<{
          path: string;
          pathType: 'Prefix';
          backend: { service: { name: string; port: { number: number } } };
        }>;
      };
    };
    domainId: string;
    hostname: string;
  }

  const rulesWithDomain: RuleWithDomain[] = updatedRoutes
    .map((route): RuleWithDomain | null => {
      const serviceName = deploymentMap.get(route.deploymentId!);
      if (!serviceName) return null;
      return {
        rule: {
          host: route.hostname,
          http: {
            paths: [{
              path: '/',
              pathType: 'Prefix',
              backend: {
                service: { name: serviceName, port: { number: 8080 } },
              },
            }],
          },
        },
        domainId: route.domainId,
        hostname: route.hostname,
      };
    })
    .filter((r): r is RuleWithDomain => r !== null);

  if (rulesWithDomain.length === 0) {
    try {
      await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  const rules = rulesWithDomain.map((r) => r.rule);

  // Phase 2c: resolve TLS secret names via the certificates module.
  // No more cert-manager.io/cluster-issuer annotation — the Certificate
  // CRs are explicit and the Ingress just references the resulting
  // secret names.
  const autoTls = await isAutoTlsEnabled(db);
  const tlsEntries: Array<{ hosts: string[]; secretName: string }> = [];
  if (autoTls) {
    // Deduplicate secrets so a wildcard cert shared by many hostnames
    // only produces one TLS entry (with all covered hostnames listed).
    const secretMap = new Map<string, Set<string>>();
    for (const r of rulesWithDomain) {
      try {
        const cert = await ensureRouteCertificate(db, k8s, r.domainId, r.hostname);
        if (cert.skipped || !cert.secretName) continue;
        if (!secretMap.has(cert.secretName)) {
          secretMap.set(cert.secretName, new Set());
        }
        secretMap.get(cert.secretName)!.add(r.hostname);
      } catch {
        // Cert provisioning failure is non-blocking — the Ingress still
        // exists without TLS for this hostname and the operator can
        // investigate the logged error. cert-manager will retry
        // independently if the Certificate CR was created.
      }
    }
    for (const [secretName, hosts] of secretMap) {
      tlsEntries.push({ secretName, hosts: Array.from(hosts) });
    }
  }

  // Sync route-level annotations (redirect, security, WAF, advanced).
  // This also creates/updates K8s Secrets (basic auth) and ConfigMaps
  // (proxy headers) in the client namespace.
  let routeAnnotations: Record<string, string> = {};
  try {
    routeAnnotations = await syncAllRouteAnnotations(db, k8s, clientId, domainIds);
  } catch {
    // Non-blocking — annotation sync failure should not prevent
    // the Ingress from being created/updated.
  }

  const ingressBody = {
    metadata: {
      name: ingressName,
      namespace,
      annotations: {
        ...routeAnnotations,
      },
    },
    spec: {
      ingressClassName: 'nginx',
      rules,
      ...(tlsEntries.length > 0 ? { tls: tlsEntries } : {}),
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
