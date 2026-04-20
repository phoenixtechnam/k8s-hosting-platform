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

import { eq, inArray } from 'drizzle-orm';
import { ingressRoutes, deployments, domains, catalogEntries } from '../../db/schema.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { ensureRouteCertificate } from '../certificates/service.js';
import { createRoute } from '../ingress-routes/service.js';
import { syncAllRouteAnnotations } from '../ingress-routes/annotation-sync.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// ─── Ingress backend resolution ─────────────────────────────────────────────

/**
 * Raised when a catalog entry cannot be exposed via an Ingress — because it
 * is a database/service tier, or because no component declared an
 * `ingress: true` port. Callers use this to skip the entry AND to surface a
 * user-visible error (can't route traffic at a DB).
 */
export class NotIngressableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NotIngressableError';
  }
}

type CatalogEntryLike = {
  readonly type?: string | null;
  readonly components?: ReadonlyArray<{
    readonly name: string;
    readonly type?: string;
    readonly ports?: ReadonlyArray<{ port: number; protocol?: string; ingress?: boolean }>;
  }> | null;
  readonly networking?: {
    readonly ingress_ports?: ReadonlyArray<{ port: number; protocol: string; tls?: boolean }>;
  } | null;
};

/**
 * Pick the backend (K8s service name + port) that the tenant's Ingress rule
 * should route to for a given deployment. Enforces the invariant that
 * database/service entries are never ingressable and that exactly one
 * component per app declares an `ingress: true` port.
 *
 * - Single-component: serviceName = deploymentName (deployer emits service
 *   under that exact name; see k8s-deployer.k8sResourceName).
 * - Multi-component: serviceName = `${deploymentName}-${componentName}` for
 *   the component that owns the ingress port.
 * - Legacy single-image entries (no components array): fall back to the
 *   top-level networking.ingress_ports.
 */
export function resolveIngressBackend(
  entry: CatalogEntryLike,
  deploymentName: string,
): { serviceName: string; port: number } {
  if (entry.type === 'database' || entry.type === 'service') {
    throw new NotIngressableError(
      `Catalog type '${entry.type}' cannot be exposed via Ingress (databases and internal services are cluster-only).`,
    );
  }

  const components = entry.components ?? [];
  if (components.length > 0) {
    const ingressComponents = components.filter(c =>
      (c.ports ?? []).some(p => p.ingress === true),
    );
    if (ingressComponents.length === 0) {
      throw new NotIngressableError(
        'No component declares an ingress: true port — this deployment cannot be routed.',
      );
    }
    // Validator ensures only one at sync-time; if multiple sneak in at
    // runtime (e.g. an older DB row), pick the first deterministically.
    const comp = ingressComponents[0];
    const ingressPort = (comp.ports ?? []).find(p => p.ingress === true)!;
    const serviceName = components.length <= 1
      ? deploymentName
      : `${deploymentName}-${comp.name}`;
    return { serviceName, port: ingressPort.port };
  }

  // Legacy path: no components array → single-image runtime. Use the
  // networking.ingress_ports declaration if present.
  const topPort = entry.networking?.ingress_ports?.[0]?.port;
  if (typeof topPort === 'number') {
    return { serviceName: deploymentName, port: topPort };
  }

  throw new NotIngressableError(
    'Catalog entry has no components and no networking.ingress_ports — nothing to route to.',
  );
}

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

  // Build deployment → (service, port) lookup. For multi-component apps
  // (WordPress, Immich, Nextcloud, …) the routable K8s service is the
  // `<deployment>-<component>` one, not the deployment name itself. Also
  // catches the hardcoded 8080 bug — each catalog entry declares its own
  // ingress port via components[*].ports[*].ingress = true.
  const clientDeployments = await db.select().from(deployments).where(eq(deployments.clientId, clientId));
  const entryIds = [...new Set(clientDeployments.map(d => d.catalogEntryId))];
  const entryRows = entryIds.length > 0
    ? await db.select().from(catalogEntries).where(inArray(catalogEntries.id, entryIds))
    : [];
  const entryMap = new Map(entryRows.map(e => [e.id, e]));

  const backendMap = new Map<string, { serviceName: string; port: number }>();
  for (const d of clientDeployments) {
    const entry = entryMap.get(d.catalogEntryId);
    if (!entry) continue;
    try {
      backendMap.set(d.id, resolveIngressBackend(entry, d.name));
    } catch (err) {
      // Not ingressable (DB, service, or missing ingress port). Skip — the
      // reconciler will silently leave this deployment off the Ingress.
      // Surface it via deployment.lastError so the UI shows the reason.
      if (err instanceof NotIngressableError) {
        try {
          await db.update(deployments)
            .set({ lastError: err.message })
            .where(eq(deployments.id, d.id));
        } catch { /* best-effort logging */ }
      } else {
        throw err;
      }
    }
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

  const rulesWithDomain: RuleWithDomain[] = [];
  for (const route of updatedRoutes) {
    const backend = backendMap.get(route.deploymentId!);
    if (!backend) continue; // Not ingressable or deployment missing — skip.

    const primaryRule = {
      host: route.hostname,
      http: {
        paths: [{
          path: route.path || '/',
          pathType: 'Prefix' as const,
          backend: {
            service: { name: backend.serviceName, port: { number: backend.port } },
          },
        }],
      },
    };

    // For www redirect: only add the DESTINATION hostname as a rule.
    // NGINX's from-to-www-redirect annotation auto-creates a redirect
    // server block for the missing source hostname.
    if (route.wwwRedirect === 'add-www' && !route.hostname.startsWith('www.')) {
      // Replace primary hostname with www variant — NGINX redirects non-www automatically
      rulesWithDomain.push({
        rule: { host: `www.${route.hostname}`, http: primaryRule.http },
        domainId: route.domainId,
        hostname: `www.${route.hostname}`,
      });
    } else if (route.wwwRedirect === 'remove-www' && route.hostname.startsWith('www.')) {
      // Replace www hostname with bare variant — NGINX redirects www automatically
      const bareHostname = route.hostname.replace(/^www\./, '');
      rulesWithDomain.push({
        rule: { host: bareHostname, http: primaryRule.http },
        domainId: route.domainId,
        hostname: bareHostname,
      });
    } else {
      // No www redirect — use the primary hostname as-is
      rulesWithDomain.push({
        rule: primaryRule,
        domainId: route.domainId,
        hostname: route.hostname,
      });
    }

  }

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
        if (cert.skipped) {
          console.warn(`[ingress-reconcile] ${r.hostname}: cert skipped (${cert.reason ?? 'unknown'}) — no TLS will be attached`);
          continue;
        }
        if (!cert.secretName) {
          console.warn(`[ingress-reconcile] ${r.hostname}: cert ready but no secretName returned — no TLS will be attached`);
          continue;
        }
        if (!secretMap.has(cert.secretName)) {
          secretMap.set(cert.secretName, new Set());
        }
        secretMap.get(cert.secretName)!.add(r.hostname);
      } catch (err) {
        // Cert provisioning failure is non-blocking — the Ingress still
        // exists without TLS for this hostname. Log so we can spot routes
        // that silently lose their HTTPS.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ingress-reconcile] ${r.hostname}: ensureRouteCertificate threw: ${msg}`);
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

  // Sync protected directory child Ingresses for per-path auth
  try {
    const { syncProtectedDirIngresses } = await import('../ingress-routes/annotation-sync.js');
    for (const route of updatedRoutes) {
      await syncProtectedDirIngresses(db, k8s, route.id, clientId);
    }
  } catch { /* Non-blocking */ }
}
