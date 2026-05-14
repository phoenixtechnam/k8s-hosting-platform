/**
 * Per-route Middleware / IngressRoute spec builder.
 *
 * Replaces the prior nginx-annotation-driven model. Each ingress_routes
 * row → a list of companion Middleware CRDs + a list of middleware
 * references that the tenant IngressRoute attaches to its corresponding
 * `spec.routes[]` entry.
 *
 * The tenant reconciler in domains/k8s-ingress.ts:
 *   1. Calls buildRouteSpecs(db, k8s, clientId, domainIds) to get a
 *      RouteSpec per active ingress_routes row.
 *   2. Applies every Middleware in `spec.middlewares[]` first (the
 *      IngressRoute that references them must come AFTER, otherwise
 *      Traefik briefly logs a "Middleware not found" diag).
 *   3. Builds a single IngressRoute with one TraefikRoute per RouteSpec
 *      (the RouteSpec.routes are merged into the IngressRoute by host).
 *   4. Deletes any orphan Middleware CRDs (labelled hosting-platform/
 *      route-id) that no longer appear in any expectedMiddlewareNames.
 *
 * K8s Secrets (htpasswd basic auth, mTLS CA bundles) are still created
 * directly by this module — they are not Middlewares. The Middleware
 * specs reference the Secret names.
 */

import { eq, and } from 'drizzle-orm';
import {
  ingressRoutes,
  routeProtectedDirs,
  routeAuthUsers,
  domains,
  clients,
  ingressAuthConfigs,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import {
  buildMiddleware,
  middlewareName,
  redirectSchemeSpec,
  redirectRegexSpec,
  ipAllowListSpec,
  rateLimitSpec,
  inFlightReqSpec,
  errorsSpec,
  basicAuthSpec,
  forwardAuthSpec,
  headersSpec,
} from './traefik-types.js';
import type {
  MiddlewareBody,
  TraefikRoute,
} from './traefik-types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if (isNotFound(err)) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

// ─── Auth Secret Sync (htpasswd) ────────────────────────────────────────────

/**
 * Sync htpasswd Secrets for all enabled protected directories on a route.
 *
 * Traefik's basicAuth Middleware reads from a Secret with key `users`
 * (NOT `auth` — nginx's convention). bcrypt hashes from the DB use the
 * $2b$ prefix; htpasswd accepts $2b$ and $2y$ interchangeably so no
 * prefix swap needed for Traefik.
 */
export async function syncAuthSecret(
  db: Database,
  k8s: K8sClients,
  namespace: string,
  routeId: string,
): Promise<void> {
  const dirs = await db
    .select()
    .from(routeProtectedDirs)
    .where(and(eq(routeProtectedDirs.routeId, routeId), eq(routeProtectedDirs.enabled, 1)));

  for (const dir of dirs) {
    const users = await db
      .select()
      .from(routeAuthUsers)
      .where(and(eq(routeAuthUsers.dirId, dir.id), eq(routeAuthUsers.enabled, 1)));

    const secretName = `route-auth-${dir.id}`;

    if (users.length === 0) {
      try {
        await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
      } catch (err: unknown) {
        if (!isK8s404(err)) throw err;
      }
      continue;
    }

    // Traefik basicAuth reads from `users` key (one htpasswd line per user).
    const htpasswdLines = users.map((u) => `${u.username}:${u.passwordHash}`);
    const htpasswdContent = htpasswdLines.join('\n') + '\n';

    const secretBody = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'hosting-platform',
          'hosting-platform/route-id': routeId,
          'hosting-platform/dir-id': dir.id,
        },
      },
      type: 'Opaque',
      data: {
        users: Buffer.from(htpasswdContent).toString('base64'),
      },
    };

    try {
      // backup-coverage: excluded:reconciler-rebuilds-from-config-tables
      await k8s.core.createNamespacedSecret({ namespace, body: secretBody });
    } catch (err: unknown) {
      if (isK8s409(err)) {
        await k8s.core.replaceNamespacedSecret({ name: secretName, namespace, body: secretBody });
      } else {
        throw err;
      }
    }
  }

  // Clean up legacy route-level secret if it exists (pre-protected-dirs era).
  try {
    await k8s.core.deleteNamespacedSecret({ name: `route-auth-${routeId}`, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Header validation ──────────────────────────────────────────────────────

const MAX_HEADERS = 50;
const MAX_HEADER_VALUE_LENGTH = 4096;

/** Only alphanumeric, hyphens, underscores. Strips other characters. */
function sanitiseHeaderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '');
}

/** Strip newlines, curly braces, backticks. Semicolons OK. */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\n\r{}`]/g, '');
}

/**
 * Sanitise a Record<string,string> of response headers (drops bad keys,
 * caps the total count and value lengths). Returns the cleaned map or
 * null if nothing valid remains.
 */
export function sanitiseHeaderMap(headers: Record<string, string>): Record<string, string> | null {
  const entries = Object.entries(headers).slice(0, MAX_HEADERS);
  if (entries.length === 0) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const safeName = sanitiseHeaderName(name);
    const safeValue = sanitiseHeaderValue(value).slice(0, MAX_HEADER_VALUE_LENGTH);
    if (safeName) out[safeName] = safeValue;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ─── Middleware-spec builder ────────────────────────────────────────────────

export interface RouteSettingsLike {
  forceHttps: number;
  wwwRedirect: string;
  redirectUrl: string | null;
  ipAllowlist: string | null;
  rateLimitRps: number | null;
  rateLimitConnections: number | null;
  rateLimitBurstMultiplier: string | null;
  wafEnabled: number;
  wafOwaspCrs: number;
  wafAnomalyThreshold: number;
  wafExcludedRules: string | null;
  customErrorCodes: string | null;
  customErrorPath: string | null;
  additionalHeaders?: Record<string, string> | null;
}

/**
 * Translate per-route settings into a list of companion Middleware CRDs.
 * Pure — does not touch the K8s API. The reconciler applies the
 * Middlewares before referencing them from the IngressRoute.
 *
 * Returns:
 *   - middlewares: Middleware bodies to apply (each may already exist;
 *     the reconciler uses create-or-replace semantics).
 *   - referenceList: the names to inject into IngressRoute
 *     spec.routes[].middlewares[] (preserves order).
 *
 * Order of references matters — Traefik runs middlewares left-to-right.
 * We chain: forceHttps-redirect (very first, before any auth) → ip-allow
 * → rate-limit → headers → redirect-regex (catches www / generic URL
 * redirect). Auth middlewares (OIDC, mTLS, basic-auth) live separately
 * and are appended by their respective sync paths.
 */
export function buildMiddlewaresForRoute(
  route: RouteSettingsLike,
  routeId: string,
  namespace: string,
): { middlewares: MiddlewareBody[]; referenceList: Array<{ name: string; namespace: string }> } {
  const middlewares: MiddlewareBody[] = [];
  const refs: Array<{ name: string; namespace: string }> = [];

  // ── Force HTTPS via RedirectScheme ──────────────────────────────────
  // forceHttps: routes that need HTTPS-only get a redirect Middleware
  // that 301s any HTTP request → HTTPS. The IngressRoute itself lives on
  // the `websecure` entrypoint, so HTTP traffic only hits this Middleware
  // when a parallel route on the `web` entrypoint references it (Phase 2
  // future work — the current shape only emits websecure routes, making
  // forceHttps a no-op until the parallel web-entrypoint shape lands).
  if (route.forceHttps) {
    const name = middlewareName(routeId, 'force-https');
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec: redirectSchemeSpec('https', true),
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'force-https',
      },
    }));
    refs.push({ name, namespace });
  }

  // ── IP Allowlist ────────────────────────────────────────────────────
  if (route.ipAllowlist) {
    const cidrs = route.ipAllowlist
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cidrs.length > 0) {
      const name = middlewareName(routeId, 'ipallow');
      middlewares.push(buildMiddleware({
        name,
        namespace,
        spec: ipAllowListSpec(cidrs),
        labels: {
          'hosting-platform/route-id': routeId,
          'hosting-platform/middleware-kind': 'ipallow',
        },
      }));
      refs.push({ name, namespace });
    }
  }

  // ── Rate Limiting ───────────────────────────────────────────────────
  // Traefik's rateLimit has `average` (steady-state req/s) and `burst`
  // (additional queued requests before throttle kicks in). Map nginx's
  // limit-rps + limit-rps × burst-multiplier.
  if (route.rateLimitRps) {
    const burstMultiplier = route.rateLimitBurstMultiplier
      ? Number(route.rateLimitBurstMultiplier)
      : 5;
    const burst = Math.max(1, Math.round(route.rateLimitRps * burstMultiplier));
    const name = middlewareName(routeId, 'ratelimit');
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec: rateLimitSpec({ average: route.rateLimitRps, burst }),
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'ratelimit',
      },
    }));
    refs.push({ name, namespace });
  }

  // ── Concurrent-Connection Cap (rateLimitConnections) ───────────────
  // Maps the old nginx `limit-connections` annotation. Distinct from
  // request-rate (above) — `inFlightReq` throttles the count of
  // simultaneous in-flight requests per source IP. Used to protect
  // backends that fork-per-request (PHP-FPM child pools, single-
  // threaded apps) from connection storms even when the request rate
  // is acceptable. nginx's `limit-connections` was previously emitted
  // here but the Phase-2 rewrite silently dropped it; this restores
  // parity.
  if (route.rateLimitConnections && route.rateLimitConnections > 0) {
    const name = middlewareName(routeId, 'inflight');
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec: inFlightReqSpec(route.rateLimitConnections),
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'inflight',
      },
    }));
    refs.push({ name, namespace });
  }

  // ── Additional response headers ─────────────────────────────────────
  if (route.additionalHeaders) {
    const cleaned = sanitiseHeaderMap(route.additionalHeaders);
    if (cleaned) {
      const name = middlewareName(routeId, 'headers');
      middlewares.push(buildMiddleware({
        name,
        namespace,
        spec: headersSpec({ customResponseHeaders: cleaned }),
        labels: {
          'hosting-platform/route-id': routeId,
          'hosting-platform/middleware-kind': 'headers',
        },
      }));
      refs.push({ name, namespace });
    }
  }

  // ── Generic URL redirect (operator-configured) ──────────────────────
  // Sends a 301/302 to `redirectUrl` for any request path. We use
  // redirectRegex with `.*` regex so every path matches.
  if (route.redirectUrl) {
    const name = middlewareName(routeId, 'redirect');
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec: redirectRegexSpec({
        regex: '.*',
        replacement: route.redirectUrl,
        permanent: true,
      }),
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'redirect',
      },
    }));
    refs.push({ name, namespace });
  }

  // ── WAF (ModSecurity-CRS sidecar) ───────────────────────────────────
  // The 2026-05-14 smoke test established that the per-route Coraza
  // model (option-C hybrid) is not viable: vendored Yaegi plugins fail
  // because Coraza imports `unsafe`, and the WASM build path crashes
  // Traefik with a split-stack-overflow during startup. The working
  // alternative is `github.com/madebymode/traefik-modsecurity-plugin`,
  // a Yaegi plugin that proxies request bodies to an EXTERNAL
  // ModSecurity-CRS service for verdict.
  //
  // Trade-off: the external-service architecture doesn't support
  // per-route directives. Every wafEnabled route attaches the SAME
  // shared `modsecurity-crs@traefik` Middleware backed by the
  // `modsec-crs.traefik.svc.cluster.local` Deployment. Per-route
  // `wafExcludedRules` / `wafAnomalyThreshold` / `wafOwaspCrs` columns
  // are read for forwards-compat but currently have no runtime effect —
  // the shared sidecar honours its own config baked into the OWASP CRS
  // image. Schema fields stay so the panel UI keeps working and a
  // future plugin choice (Coraza when upstream stabilises) can read
  // them again without a migration.
  //
  // The k8s/base/traefik/middlewares-waf.yaml Coraza scaffold is kept
  // in tree as documented dead code — see its header comment.
  if (route.wafEnabled) {
    refs.push({ name: 'modsecurity-crs', namespace: 'traefik' });
  }

  // ── Custom Error Pages ─────────────────────────────────────────────
  // Traefik's `errors` Middleware intercepts upstream responses with
  // the listed status codes and serves them from a different Service.
  // Restores the nginx `custom-http-errors` + default-backend behaviour
  // dropped by the Phase-2 rewrite.
  //
  // Behaviour mapping:
  //   * customErrorCodes (CSV like "404,503") → status[]
  //   * customErrorPath  (URL path string)    → query (path on backend)
  //
  // IMPORTANT: this Middleware is emitted ONLY when BOTH columns are
  // set. customErrorCodes alone is insufficient — Traefik would then
  // point the route at a Service that doesn't exist, which surfaces
  // every blocked-upstream 4xx/5xx as a Traefik 500 to the end user.
  //
  // The errors backend is the platform-shared `tenant-errors` Service
  // in the `platform-system` namespace (k8s/base/tenant-errors/) —
  // explicit cross-namespace reference is required so that a tenant
  // who happens to deploy their own `tenant-errors` Service into their
  // namespace cannot hijack the platform-managed error pages with
  // attacker-controlled content. The reconciler sets
  // serviceNamespace='platform-system' on every emitted errors
  // Middleware to make this guarantee explicit. Per-tenant errors
  // backends (sourceful tenant content) are out of scope for this
  // phase.
  if (route.customErrorCodes && route.customErrorPath) {
    // Two-stage filter: regex shape (3-digit code, optionally a 3-digit
    // range) AND for ranges, low <= high. The second check stops
    // operators submitting `503-200` which would parse but get rejected
    // by Traefik's admission webhook at apply time, taking the entire
    // IngressRoute reconcile down with it.
    const status = route.customErrorCodes
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d{3}(-\d{3})?$/.test(s))
      .filter((s) => {
        const m = s.match(/^(\d{3})-(\d{3})$/);
        if (!m) return true;
        return Number(m[1]) <= Number(m[2]);
      });
    if (status.length > 0) {
      const name = middlewareName(routeId, 'errors');
      middlewares.push(buildMiddleware({
        name,
        namespace,
        spec: errorsSpec({
          status,
          serviceName: 'tenant-errors',
          serviceNamespace: 'platform-system',
          servicePort: 80,
          query: route.customErrorPath ?? undefined,
        }),
        labels: {
          'hosting-platform/route-id': routeId,
          'hosting-platform/middleware-kind': 'errors',
        },
      }));
      refs.push({ name, namespace });
    }
  }

  // ── www redirect ────────────────────────────────────────────────────
  // nginx's from-to-www-redirect was bidirectional: visiting either
  // variant redirects to the canonical one. Traefik has no built-in
  // bidirectional Middleware, so we emit a redirectRegex that matches
  // ANY scheme + ANY host (with or without www) and rewrites the host
  // to the canonical form. The IngressRoute matches both variants via
  // a single host expression in k8s-ingress.ts — this Middleware just
  // performs the redirect when the user lands on the non-canonical
  // form.
  if (route.wwwRedirect === 'add-www' || route.wwwRedirect === 'remove-www') {
    const name = middlewareName(routeId, 'wwwredir');
    // We don't know the hostname here (this is a pure builder). The
    // regex below uses Traefik's $1/$2 capture syntax to preserve the
    // scheme + path while toggling the www. prefix. The reconciler
    // could be smarter (host-aware patterns) but this is sufficient
    // for the catalog use case.
    const spec = route.wwwRedirect === 'add-www'
      ? redirectRegexSpec({
          regex: '^https?://(?:www\\.)?([^/]+)(/.*)?$',
          replacement: 'https://www.$1$2',
          permanent: true,
        })
      : redirectRegexSpec({
          regex: '^https?://www\\.([^/]+)(/.*)?$',
          replacement: 'https://$1$2',
          permanent: true,
        });
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec,
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'wwwredir',
      },
    }));
    refs.push({ name, namespace });
  }

  return { middlewares, referenceList: refs };
}

// ─── Main per-route sync ────────────────────────────────────────────────────

export interface RouteBuildResult {
  /** Companion Middleware CRDs to apply before the IngressRoute. */
  middlewares: MiddlewareBody[];
  /** Names to attach to the IngressRoute route's middlewares list (in order). */
  middlewareRefs: Array<{ name: string; namespace: string }>;
  /** Optional child routes (per-path basic-auth dirs) the IngressRoute should expose. */
  childRoutes: TraefikRoute[];
}

/**
 * Build everything needed to render this route into a Traefik IngressRoute:
 *   - Companion Middlewares (settings, mTLS, OIDC, sanitise-only headers, …).
 *   - The list of Middleware names the IngressRoute attaches to its
 *     primary route entry.
 *   - Child routes for protected directories (each carries its own
 *     basicAuth Middleware reference).
 *
 * Side effects: still syncs the htpasswd + mTLS Secrets that the
 * Middlewares reference.
 */
export async function buildRouteSpec(
  db: Database,
  k8s: K8sClients,
  routeId: string,
  clientId: string,
  serviceName: string,
  servicePort: number,
): Promise<RouteBuildResult | null> {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) return null;

  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client?.kubernetesNamespace) return null;
  const namespace = client.kubernetesNamespace;

  // 1. Sync htpasswd Secrets (kept here because they're K8s Secrets, not
  //    Middlewares — the basicAuth Middleware just references them).
  await syncAuthSecret(db, k8s, namespace, routeId);

  // 2. Settings-derived Middlewares.
  const { middlewares: settingsMws, referenceList: settingsRefs } = buildMiddlewaresForRoute(
    route,
    routeId,
    namespace,
  );

  // 3. mTLS Middleware (passTLSClientCert + the TLSOption — TLSOption
  //    is referenced at the IngressRoute tls level, returned via the
  //    out struct in a later phase. For now mTLS only emits the
  //    forward-cert Middleware so upstream apps see the cert.)
  const mtlsResult = await syncMtlsSecretAndBuildSpec(db, k8s, namespace, routeId);

  // 4. OIDC ForwardAuth Middleware (per-route, since the auth URL
  //    encodes ?route=<id> for the claim-validator sidecar).
  const oidcRefs = await buildOidcMiddleware(db, namespace, routeId, route.hostname);

  // Platform-wide CrowdSec bouncer — every tenant route attaches it as
  // the FIRST middleware so known-bad IPs short-circuit before any
  // per-route processing (rate-limit, auth, WAF, …). Cross-namespace
  // ref into `traefik` namespace; the controller's
  // allowCrossNamespace=true flag (set by bootstrap.sh) permits it.
  const platformRefs: Array<{ name: string; namespace: string }> = [
    { name: 'crowdsec', namespace: 'traefik' },
  ];

  // Combined ref order (left-to-right execution):
  //   1. crowdsec (platform-wide IP gate)
  //   2. settings (forceHttps, ipAllow, rate-limit, in-flight, headers,
  //      redirect, WAF when wafEnabled=1, errors)
  //   3. mTLS forward-cert
  //   4. OIDC ForwardAuth
  const combinedRefs = [
    ...platformRefs,
    ...settingsRefs,
    ...mtlsResult.refs,
    ...oidcRefs.refs,
  ];

  // 5. Protected-directory child routes — one TraefikRoute per
  //    enabled dir with users. Each child route references its own
  //    basicAuth Middleware (pointing at the route-auth-<dirId> Secret).
  //    `combinedRefs` flows into the child routes too, so crowdsec
  //    gates the protected-dir paths as well.
  const childRoutes = await buildProtectedDirChildRoutes(
    db,
    routeId,
    route.hostname,
    namespace,
    serviceName,
    servicePort,
    combinedRefs,
  );

  return {
    middlewares: [
      ...settingsMws,
      ...mtlsResult.middlewares,
      ...oidcRefs.middlewares,
      ...childRoutes.basicAuthMiddlewares,
    ],
    middlewareRefs: combinedRefs,
    childRoutes: childRoutes.routes,
  };
}

/**
 * Walk every active ingress_routes row for a client and build a RouteSpec
 * per row. The reconciler in domains/k8s-ingress.ts iterates this to
 * assemble the tenant IngressRoute.
 */
export async function buildAllRouteSpecs(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  domainIds: string[],
  backendResolver: (route: { id: string; deploymentId: string | null; privateWorkerId: string | null; servicePort: number | null }) => { serviceName: string; port: number } | null,
): Promise<Map<string, RouteBuildResult>> {
  const out = new Map<string, RouteBuildResult>();
  const allRoutes = await db.select().from(ingressRoutes);
  const clientRoutes = allRoutes.filter(
    (r) => domainIds.includes(r.domainId)
      && (r.deploymentId || r.privateWorkerId)
      && r.status === 'active',
  );
  for (const route of clientRoutes) {
    const backend = backendResolver(route);
    if (!backend) continue;
    const spec = await buildRouteSpec(
      db,
      k8s,
      route.id,
      clientId,
      backend.serviceName,
      backend.port,
    );
    if (spec) out.set(route.id, spec);
  }
  return out;
}

// ─── Protected-directory child routes ───────────────────────────────────────

interface ProtectedDirChildResult {
  basicAuthMiddlewares: MiddlewareBody[];
  routes: TraefikRoute[];
}

async function buildProtectedDirChildRoutes(
  db: Database,
  routeId: string,
  hostname: string,
  namespace: string,
  serviceName: string,
  servicePort: number,
  parentMiddlewareRefs: Array<{ name: string; namespace: string }>,
): Promise<ProtectedDirChildResult> {
  const dirs = await db.select().from(routeProtectedDirs).where(eq(routeProtectedDirs.routeId, routeId));
  const basicAuthMiddlewares: MiddlewareBody[] = [];
  const routes: TraefikRoute[] = [];

  for (const dir of dirs) {
    if (!dir.enabled) continue;
    const users = await db.select().from(routeAuthUsers)
      .where(and(eq(routeAuthUsers.dirId, dir.id), eq(routeAuthUsers.enabled, 1)));
    if (users.length === 0) continue;

    const mwName = `dir-${dir.id.slice(0, 8)}-auth`;
    const secretName = `route-auth-${dir.id}`;
    basicAuthMiddlewares.push(buildMiddleware({
      name: mwName,
      namespace,
      spec: basicAuthSpec(secretName, dir.realm || 'Restricted'),
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/dir-id': dir.id,
        'hosting-platform/middleware-kind': 'basicauth',
      },
    }));

    // Child route: match the hostname AND the directory path. Higher
    // priority than the parent route (`Host(...)`) so the basic-auth
    // gate wins for paths under /dir.
    routes.push({
      match: `Host(\`${hostname}\`) && PathPrefix(\`${dir.path}\`)`,
      kind: 'Rule',
      priority: 100,
      middlewares: [
        ...parentMiddlewareRefs,
        { name: mwName, namespace },
      ],
      services: [{ name: serviceName, port: servicePort }],
    });
  }
  return { basicAuthMiddlewares, routes };
}

/**
 * Delete the Secret + Middleware (if any) for a removed protected dir.
 * Called from the routes API when an operator deletes a dir.
 */
export async function deleteProtectedDirIngress(
  k8s: K8sClients,
  namespace: string,
  dirId: string,
): Promise<void> {
  const secretName = `route-auth-${dirId}`;
  const mwName = `dir-${dirId.slice(0, 8)}-auth`;
  try {
    await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
  } catch (e: unknown) {
    if (!isK8s404(e)) throw e;
  }
  // Best-effort Middleware delete — if traefik-apply lazy-imports
  // would create a cycle, do it inline here.
  try {
    const { deleteMiddleware } = await import('./traefik-apply.js');
    await deleteMiddleware(k8s.custom, namespace, mwName);
  } catch { /* non-fatal */ }
}

// ─── OIDC ForwardAuth Middleware ────────────────────────────────────────────

/**
 * True when at least one enabled auth config under the same client as
 * `routeId` has a non-empty claim_rules array. The claim-validator
 * sidecar is deployed only when this is true; in that case the
 * ForwardAuth address points at the sidecar (port 4181), otherwise
 * directly at oauth2-proxy (port 4180).
 */
export async function clientHasActiveClaimRules(
  db: Database,
  routeId: string,
): Promise<boolean> {
  const [routeRow] = await db
    .select({ clientId: domains.clientId })
    .from(ingressRoutes)
    .innerJoin(domains, eq(ingressRoutes.domainId, domains.id))
    .where(eq(ingressRoutes.id, routeId));
  if (!routeRow) return false;

  const rows = await db
    .select({ claimRules: ingressAuthConfigs.claimRules })
    .from(ingressAuthConfigs)
    .innerJoin(ingressRoutes, eq(ingressAuthConfigs.ingressRouteId, ingressRoutes.id))
    .innerJoin(domains, eq(ingressRoutes.domainId, domains.id))
    .where(
      and(
        eq(ingressAuthConfigs.enabled, true),
        eq(domains.clientId, routeRow.clientId),
      ),
    );
  return rows.some((r) => Array.isArray(r.claimRules) && r.claimRules.length > 0);
}

async function buildOidcMiddleware(
  db: Database,
  namespace: string,
  routeId: string,
  _hostname: string,
): Promise<{ middlewares: MiddlewareBody[]; refs: Array<{ name: string; namespace: string }> }> {
  const [cfg] = await db
    .select()
    .from(ingressAuthConfigs)
    .where(eq(ingressAuthConfigs.ingressRouteId, routeId));
  if (!cfg || !cfg.enabled) return { middlewares: [], refs: [] };

  const sidecarPresent = await clientHasActiveClaimRules(db, routeId);
  const proxyHost = `oauth2-proxy.${namespace}.svc.cluster.local`;
  // When the sidecar is present, claim-validator at :4181/auth accepts
  // ?route=<id> to select the matching rule set; otherwise we hit
  // oauth2-proxy directly at :4180/oauth2/auth.
  const address = sidecarPresent
    ? `http://${proxyHost}:4181/auth?route=${routeId}`
    : `http://${proxyHost}:4180/oauth2/auth`;

  // Headers oauth2-proxy populates on a successful auth_request — Traefik
  // copies them into the upstream request via authResponseHeaders.
  const responseHeaders: string[] = [];
  if (cfg.passUserHeaders) {
    responseHeaders.push('X-Auth-Request-User', 'X-Auth-Request-Email', 'X-Auth-Request-Preferred-Username');
  }
  if (cfg.setXauthrequest) responseHeaders.push('X-Auth-Request-Groups');
  if (cfg.passAccessToken) responseHeaders.push('X-Auth-Request-Access-Token');
  if (cfg.passIdToken) responseHeaders.push('X-Auth-Request-Id-Token');
  if (cfg.passAuthorizationHeader) responseHeaders.push('Authorization');

  const name = middlewareName(routeId, 'oidc');
  const body = buildMiddleware({
    name,
    namespace,
    spec: forwardAuthSpec({
      address,
      // Inherit forwardAuthSpec's safe default (false). Traefik's
      // entryPoint trustedIPs=127.0.0.1/32 already strips attacker XFF
      // upstream; oauth2-proxy / claim-validator don't need the
      // client IP — they enforce auth via cookie/JWT.
      authResponseHeaders: responseHeaders.length > 0 ? responseHeaders : undefined,
    }),
    labels: {
      'hosting-platform/route-id': routeId,
      'hosting-platform/middleware-kind': 'oidc',
    },
  });

  return { middlewares: [body], refs: [{ name, namespace }] };
}

// ─── mTLS Secret + Middleware ──────────────────────────────────────────────

/**
 * Sync the CA-bundle Secret for an mTLS-enabled route and emit the
 * companion passTLSClientCert Middleware that forwards the client cert
 * details to the upstream as a header.
 *
 * mTLS REQUIRES a TLSOption CR (clientAuth.clientAuthType + secretNames
 * pointing at the CA bundle Secret) — that piece is returned by a
 * separate function consumed by the IngressRoute builder (which
 * attaches it via spec.tls.options). For now, this function only emits
 * the request-forwarding Middleware; the IngressRoute reconciler will
 * pick up the TLSOption hook in a follow-up.
 */
async function syncMtlsSecretAndBuildSpec(
  db: Database,
  k8s: K8sClients,
  namespace: string,
  routeId: string,
): Promise<{ middlewares: MiddlewareBody[]; refs: Array<{ name: string; namespace: string }> }> {
  const { loadEnabledForRoute } = await import('../ingress-mtls/service.js');
  const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    console.error('[annotation-sync] PLATFORM_ENCRYPTION_KEY missing — mTLS skipped for route', routeId);
    return { middlewares: [], refs: [] };
  }
  const secretName = `route-mtls-${routeId.slice(0, 8)}`;

  const loaded = await loadEnabledForRoute(db, encryptionKey, routeId);
  if (!loaded) {
    try {
      await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return { middlewares: [], refs: [] };
  }

  const { config, caCertPem, crlPem } = loaded;
  // Traefik's TLSOption reads `tls.ca` (PEM) AND optionally `tls.crl`
  // from the Secret. Format matches what cert-manager would emit, so
  // we keep the key names matching Traefik's CRD convention.
  const data: Record<string, string> = {
    'tls.ca': Buffer.from(caCertPem).toString('base64'),
  };
  if (crlPem) {
    data['tls.crl'] = Buffer.from(crlPem).toString('base64');
  }
  const secretBody = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'hosting-platform',
        'hosting-platform/route-id': routeId,
        'hosting-platform/purpose': 'mtls-ca',
      },
    },
    type: 'Opaque',
    data,
  };
  try {
    // backup-coverage: excluded:reconciler-rebuilds-from-config-tables
    await k8s.core.createNamespacedSecret({ namespace, body: secretBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.core.replaceNamespacedSecret({ name: secretName, namespace, body: secretBody });
    } else {
      throw err;
    }
  }

  // Forward the cert details to the upstream service if requested.
  const middlewares: MiddlewareBody[] = [];
  const refs: Array<{ name: string; namespace: string }> = [];
  if (config.passCertToUpstream) {
    const name = middlewareName(routeId, 'mtls-fwd');
    middlewares.push(buildMiddleware({
      name,
      namespace,
      spec: {
        passTLSClientCert: {
          pem: true,
        },
      },
      labels: {
        'hosting-platform/route-id': routeId,
        'hosting-platform/middleware-kind': 'mtls-fwd',
      },
    }));
    refs.push({ name, namespace });
  }

  return { middlewares, refs };
}

/**
 * Backwards-compatible export: the platform-mTLS reconciler caller from
 * domains/k8s-ingress.ts used to read this via `syncRouteAnnotations`.
 * We now expose only the spec shape; legacy callers should switch to
 * `buildRouteSpec` / `buildAllRouteSpecs`.
 */
export { syncMtlsSecretAndBuildSpec };
