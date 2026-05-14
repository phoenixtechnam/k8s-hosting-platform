/**
 * Tenant IngressRoute reconciler.
 *
 * Builds Traefik IngressRoute + Middleware resources from
 * ingress_routes table. Each row with an assigned target (deployment
 * OR private_worker) becomes one route inside the per-namespace
 * IngressRoute, plus a small set of companion Middleware CRDs
 * (per-route rate-limit, ip-allowlist, OIDC auth, mTLS forwarding, etc.)
 * built by annotation-sync.buildAllRouteSpecs.
 *
 * TLS secret names are resolved via the central certificates module
 * (ensureRouteCertificate), which:
 *   - Creates/updates a cert-manager Certificate CR per domain (or
 *     per hostname for non-wildcard cases)
 *   - Returns the correct secret name to put in the IngressRoute's
 *     `tls.secretName`
 *   - Handles wildcard cert reuse when dnsMode=primary + PowerDNS
 *
 * Replaces the prior nginx-annotation model. There is no per-Ingress
 * default-annotation block in Traefik — the equivalent (no proxy body
 * cap, streaming uploads, long timeouts) is configured at the Traefik
 * EntryPoint / ServersTransport level in the Helm chart and applies to
 * all IngressRoutes uniformly.
 */

import { eq, inArray } from 'drizzle-orm';
import { ingressRoutes, deployments, domains, catalogEntries, privateWorkers } from '../../db/schema.js';
import { isAutoTlsEnabled } from '../tls-settings/service.js';
import { ensureRouteCertificate } from '../certificates/service.js';
import { createRoute } from '../ingress-routes/service.js';
import { buildAllRouteSpecs } from '../ingress-routes/annotation-sync.js';
import {
  buildIngressRoute,
  hostMatch,
} from '../ingress-routes/traefik-types.js';
import type { TraefikRoute } from '../ingress-routes/traefik-types.js';
import {
  applyIngressRoute,
  applyMiddleware,
  deleteIngressRoute,
  deleteMiddleware,
  listMiddlewares,
} from '../ingress-routes/traefik-apply.js';
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
    await deleteIngressRoute(k8s.custom, namespace, ingressName);
    await gcOrphanMiddlewares(k8s, namespace, new Set());
    return;
  }

  // Get all ingress routes with an assigned target (deployment OR
  // private_worker) for this client's domains. Migration 0076 added
  // the private_worker_id polymorphic target column.
  const allRoutes = await db.select().from(ingressRoutes);
  const clientRoutes = allRoutes.filter(
    r =>
      domainIds.includes(r.domainId)
      && (r.deploymentId || r.privateWorkerId)
      && r.status === 'active',
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
  // Exclude routes whose domain has suppress_public_ingress=true. The
  // deployment-network-access reconciler sets this flag for domains
  // pointing at deployments in mesh-only modes (mode='tunneler'). The
  // public Ingress is then never created for that hostname — true
  // zero-trust on the network layer.
  const suppressedDomainIds = new Set(
    clientDomains.filter((d) => d.suppressPublicIngress).map((d) => d.id),
  );
  const updatedRoutes = updatedAllRoutes.filter(
    r =>
      domainIds.includes(r.domainId)
      && (r.deploymentId || r.privateWorkerId)
      && r.status === 'active'
      && !suppressedDomainIds.has(r.domainId),
  );

  if (updatedRoutes.length === 0) {
    await deleteIngressRoute(k8s.custom, namespace, ingressName);
    await gcOrphanMiddlewares(k8s, namespace, new Set());
    return;
  }

  // Build deployment → (service, port) lookup. For multi-component apps
  // (WordPress, Immich, Nextcloud, …) the routable K8s service is the
  // `<deployment>-<component>` one, not the deployment name itself. Also
  // catches the hardcoded 8080 bug — each catalog entry declares its own
  // ingress port via components[*].ports[*].ingress = true.
  const clientDeployments = await db.select().from(deployments).where(eq(deployments.clientId, clientId));
  // Custom deployments (ADR-036) carry no catalog entry; PR-2 wires
  // their ingress backends via a separate path. Drop them here so the
  // catalog inArray lookup is well-typed.
  const entryIds = [...new Set(
    clientDeployments.map(d => d.catalogEntryId).filter((id): id is string => id !== null),
  )];
  const entryRows = entryIds.length > 0
    ? await db.select().from(catalogEntries).where(inArray(catalogEntries.id, entryIds))
    : [];
  const entryMap = new Map(entryRows.map(e => [e.id, e]));

  const backendMap = new Map<string, { serviceName: string; port: number }>();
  for (const d of clientDeployments) {
    if (d.catalogEntryId === null) {
      // Custom deployment (ADR-036): no catalog entry. The ingressEligible
      // port is resolved from the customSpec on a per-route basis below,
      // using route.servicePort when set, else the first ingressEligible port.
      // Register a placeholder so the route loop can distinguish "custom" from
      // "missing/broken catalog" — the actual per-route resolution happens when
      // we iterate routes below using the customSpec on the deployment row.
      continue;
    }
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

  // Build custom-deployment lookup by id for fast per-route resolution.
  const customDeploymentMap = new Map(
    clientDeployments.filter(d => d.catalogEntryId === null).map(d => [d.id, d]),
  );

  // Build private-worker → (service, port) lookup. Each active worker has a
  // per-worker ClusterIP Service `pw-<id>` in the client's namespace
  // (created by private-workers/reconciler.ts) backed by the frps pod
  // bound to the worker's exposed_port. The Ingress backend is that
  // Service — same shape as a deployment-targeted route.
  const privateWorkerBackends = new Map<string, { serviceName: string; port: number }>();
  const clientPrivateWorkers = await db
    .select()
    .from(privateWorkers)
    .where(eq(privateWorkers.clientId, clientId));
  for (const pw of clientPrivateWorkers) {
    if (pw.status !== 'active' && pw.status !== 'pending') continue;
    privateWorkerBackends.set(pw.id, {
      serviceName: `pw-${pw.id}`,
      port: pw.exposedPort,
    });
  }

  // Map every active route to its backend (deployment / custom / private
  // worker). The result is keyed by route id so the route-spec builder
  // can resolve service+port without re-reading the catalog.
  interface RouteRowLike {
    id: string;
    deploymentId: string | null;
    privateWorkerId: string | null;
    servicePort: number | null;
    hostname: string;
    path: string | null;
    wwwRedirect: string;
    domainId: string;
  }

  const resolveBackend = (route: { deploymentId: string | null; privateWorkerId: string | null; servicePort: number | null }): { serviceName: string; port: number } | null => {
    if (route.privateWorkerId) {
      return privateWorkerBackends.get(route.privateWorkerId) ?? null;
    }
    if (route.deploymentId) {
      const catalogBackend = backendMap.get(route.deploymentId);
      if (catalogBackend) return catalogBackend;
      // Custom deployment: resolve from customSpec.
      const dep = customDeploymentMap.get(route.deploymentId);
      if (dep?.customSpec) {
        const spec = dep.customSpec as {
          services?: Record<string, {
            ports?: Array<{ containerPort: number; exposeAsService?: boolean; ingressEligible?: boolean }>;
          }>;
        };
        const services = Object.entries(spec.services ?? {});
        if (services.length > 0) {
          let resolved: { svcName: string; port: number } | undefined;
          if (route.servicePort) {
            for (const [svcName, svc] of services) {
              const p = (svc.ports ?? []).find((p) => p.containerPort === route.servicePort);
              if (p) { resolved = { svcName, port: p.containerPort }; break; }
            }
          } else {
            for (const [svcName, svc] of services) {
              const p = (svc.ports ?? []).find((p) => p.ingressEligible && p.exposeAsService);
              if (p) { resolved = { svcName, port: p.containerPort }; break; }
            }
          }
          if (resolved) {
            const k8sSvcName = services.length <= 1 ? dep.name : `${dep.name}-${resolved.svcName}`;
            return { serviceName: k8sSvcName, port: resolved.port };
          }
        }
      }
    }
    return null;
  };

  // Build per-route Middleware + child-route specs. Each RouteSpec
  // carries the Middleware bodies to apply BEFORE the IngressRoute
  // references them and the list of names attached to the route entry
  // in spec.routes[].middlewares.
  const routeSpecs = await buildAllRouteSpecs(db, k8s, clientId, domainIds, resolveBackend);

  // Apply every Middleware first. Track the names actually applied so we
  // can GC orphans afterwards.
  const expectedMiddlewareNames = new Set<string>();
  for (const spec of routeSpecs.values()) {
    for (const mw of spec.middlewares) {
      await applyMiddleware(k8s.custom, mw);
      expectedMiddlewareNames.add(mw.metadata.name);
    }
  }

  // Build the IngressRoute spec.routes[] from the merged set. Each
  // ingress_routes row produces 1 primary route + 0..N child routes
  // (protected directories) on the same hostname. We then dedupe per
  // hostname so a single tenant IngressRoute carries every route.
  const traefikRoutes: TraefikRoute[] = [];
  const tlsHostnames = new Set<string>();
  for (const route of updatedRoutes as RouteRowLike[]) {
    const spec = routeSpecs.get(route.id);
    if (!spec) continue;
    const backend = resolveBackend(route);
    if (!backend) continue;

    // www redirect rewrite: the original code rewrote `route.hostname`
    // to the canonical form (with or without www); the wwwredir
    // Middleware (created in annotation-sync) handles the actual
    // redirect for the non-canonical form. We keep the same canonical-
    // hostname behaviour here so cert provisioning targets the right
    // SAN.
    let canonicalHost = route.hostname;
    if (route.wwwRedirect === 'add-www' && !route.hostname.startsWith('www.')) {
      canonicalHost = `www.${route.hostname}`;
    } else if (route.wwwRedirect === 'remove-www' && route.hostname.startsWith('www.')) {
      canonicalHost = route.hostname.replace(/^www\./, '');
    }
    tlsHostnames.add(canonicalHost);

    // Primary route: matches the canonical hostname (no path prefix
    // unless explicitly set in route.path).
    //
    // Middleware ordering (left-to-right execution): annotation-sync
    // already prepended the platform-wide `crowdsec@traefik` ref to
    // spec.middlewareRefs, so the same list flows into both the
    // primary route AND every protected-dir child route below.
    traefikRoutes.push({
      match: route.path && route.path !== '/'
        ? `${hostMatch(canonicalHost)} && PathPrefix(\`${route.path}\`)`
        : hostMatch(canonicalHost),
      kind: 'Rule',
      ...(spec.middlewareRefs.length > 0 ? { middlewares: spec.middlewareRefs } : {}),
      services: [{ name: backend.serviceName, port: backend.port }],
    });
    // Protected-directory child routes (higher priority — set by
    // buildProtectedDirChildRoutes; they reuse parentMiddlewareRefs
    // which already carries crowdsec at slot 0).
    for (const child of spec.childRoutes) traefikRoutes.push(child);
  }

  if (traefikRoutes.length === 0) {
    await deleteIngressRoute(k8s.custom, namespace, ingressName);
    await gcOrphanMiddlewares(k8s, namespace, new Set());
    return;
  }

  // Resolve TLS secret names via the certificates module. cert-manager
  // owns the Certificate CR + Secret lifecycle; we just pick which
  // Secret to reference. Traefik supports multiple Secrets via
  // `tls.options` + TLSStore — but for the tenant ingress we use a
  // single primary secretName (the first hostname's cert) and let
  // Traefik fall back to the SNI-routed cert from
  // `default` TLSStore for additional hostnames. Wildcard reuse
  // collapses naturally because all hostnames covered by a wildcard
  // resolve to the same Secret.
  const autoTls = await isAutoTlsEnabled(db);
  let primaryTlsSecret: string | null = null;
  if (autoTls) {
    for (const hostname of tlsHostnames) {
      // Find the domain row matching this hostname so we can pass its
      // id to ensureRouteCertificate (it looks up dns_provider settings
      // by domainId).
      const matchingDomain = clientDomains.find((d) =>
        d.domainName === hostname || hostname.endsWith(`.${d.domainName}`),
      );
      if (!matchingDomain) continue;
      try {
        const cert = await ensureRouteCertificate(db, k8s, matchingDomain.id, hostname);
        if (cert.skipped) {
          console.warn(`[ingress-reconcile] ${hostname}: cert skipped (${cert.reason ?? 'unknown'})`);
          continue;
        }
        if (!cert.secretName) {
          console.warn(`[ingress-reconcile] ${hostname}: cert ready but no secretName returned`);
          continue;
        }
        if (!primaryTlsSecret) primaryTlsSecret = cert.secretName;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[ingress-reconcile] ${hostname}: ensureRouteCertificate threw: ${msg}`);
      }
    }
  }

  // Build + apply the tenant IngressRoute.
  const ingressBody = buildIngressRoute({
    name: ingressName,
    namespace,
    routes: traefikRoutes,
    entryPoints: ['websecure'],
    ...(primaryTlsSecret ? { tls: { secretName: primaryTlsSecret } } : {}),
    labels: {
      'hosting-platform/client-id': clientId,
    },
  });
  await applyIngressRoute(k8s.custom, ingressBody);

  // GC orphan Middlewares that this client's reconcile no longer
  // produces. Limited to labels matching hosting-platform/route-id IN
  // (current route ids) — anything else (cluster-shared admin-auth
  // Middlewares, oauth2-proxy break-glass middleware, …) stays put.
  await gcOrphanMiddlewares(k8s, namespace, expectedMiddlewareNames);
}

// ─── Middleware orphan cleanup ──────────────────────────────────────────────

/**
 * Delete every hosting-platform-owned Middleware in `namespace` whose
 * name does NOT appear in `keepNames`. Limited by labelSelector so we
 * only touch CRDs we created. Best-effort — failure to clean up an
 * orphan does not abort the reconcile.
 */
async function gcOrphanMiddlewares(
  k8s: K8sClients,
  namespace: string,
  keepNames: ReadonlySet<string>,
): Promise<void> {
  try {
    const existing = await listMiddlewares(
      k8s.custom,
      namespace,
      'app.kubernetes.io/managed-by=platform-api',
    );
    for (const mw of existing) {
      if (keepNames.has(mw.name)) continue;
      // Don't sweep Middlewares we DON'T own — only orphans tied to a
      // route-id (the buildMiddlewaresForRoute / mTLS / OIDC builders
      // always stamp hosting-platform/route-id). suspend Middlewares
      // managed by ingress-suspend get their own GC pass.
      const isRouteOwned = 'hosting-platform/route-id' in mw.labels
        || 'hosting-platform/dir-id' in mw.labels;
      if (!isRouteOwned) continue;
      try {
        await deleteMiddleware(k8s.custom, namespace, mw.name);
      } catch (err) {
        console.warn(`[ingress-reconcile] GC of orphan Middleware ${namespace}/${mw.name} failed:`, err);
      }
    }
  } catch (err) {
    console.warn(`[ingress-reconcile] failed to list Middlewares for GC in ${namespace}:`, err);
  }
}
