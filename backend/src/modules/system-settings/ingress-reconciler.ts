/**
 * Reconcile the `platform-ingress` IngressRoute + Certificate from the
 * admin/client panel URLs configured in System Settings.
 *
 * The DB is the single source of truth. On startup and on every write
 * to admin_panel_url / client_panel_url, this reconciler rebuilds the
 * IngressRoute's routes[] and the cert-manager Certificate's dnsNames[]
 * from the URLs' hostnames using server-side apply with
 * fieldManager: platform-api. The reconciler OWNS both resources
 * end-to-end — there is no static base manifest to merge with.
 *
 * The Traefik migration removed k8s/base/ingress.yaml entirely; the
 * IngressRoute is created from scratch by this code path on the first
 * call after platform-api startup. The Certificate CR is created in
 * the same call so cert-manager has the SANs it needs to provision
 * the TLS Secret.
 */

import * as k8s from '@kubernetes/client-node';

// ─── Public types ────────────────────────────────────────────────────────

export interface IngressReconcileInput {
  readonly adminPanelUrl: string | null;
  readonly clientPanelUrl: string | null;
  readonly tlsSecretName: string;
  /**
   * When true, the reconciler emits a `/oauth2` prefix route on the admin
   * host pointing at the oauth2-proxy Service. Required for transparent
   * oauth2-proxy protection: without this route, the browser's redirect
   * to `admin.<base>/oauth2/start` 404s because the IngressRoute only
   * matches `/` to the admin panel.
   */
  readonly protectAdminViaProxy?: boolean;
  /** Same as protectAdminViaProxy but for the client panel host. */
  readonly protectClientViaProxy?: boolean;
}

export interface IngressReconcileResult {
  readonly changed: boolean;
}

export interface IngressRouteCurrentSpec {
  readonly routes: ReadonlyArray<{
    readonly host: string;
    readonly serviceName: string;
    readonly oauth2Backend?: string | null;
  }>;
  readonly tlsSecret: string | null;
}

export interface CertificateCurrentSpec {
  readonly dnsNames: ReadonlyArray<string>;
  readonly secretName: string | null;
  readonly issuerName: string | null;
}

export interface IngressReconcileDeps {
  readIngressRoute(): Promise<IngressRouteCurrentSpec | null>;
  readCertificate(): Promise<CertificateCurrentSpec | null>;
  applyIngressRoute(body: Record<string, unknown>): Promise<void>;
  applyCertificate(body: Record<string, unknown>): Promise<void>;
}

export interface IngressReconcileOptions {
  readonly kubeconfigPath?: string;
  readonly namespace?: string;
  readonly ingressName?: string;
  readonly clusterIssuerName?: string;
}

const DEFAULTS = {
  namespace: 'platform',
  ingressName: 'platform-ingress',
  certificateName: 'platform-ingress',
  fieldManager: 'platform-api',
  // Per-overlay default. Each environment bootstraps an issuer with this
  // name; bootstrap.sh seeds the platform-cluster-config CM with the
  // resolved value used by static manifests.
  clusterIssuerName: 'letsencrypt-prod-http01',
} as const;

const PANEL_SERVICES: Record<'admin' | 'client', string> = {
  admin: 'admin-panel',
  client: 'client-panel',
};

const OAUTH2_PROXY_SERVICE = 'oauth2-proxy';
const OAUTH2_PROXY_PORT = 4180;

/**
 * Name of the ForwardAuth Middleware managed by oidc/ingress-proxy-manager.ts.
 * Duplicated as a constant here (rather than imported) to avoid a circular
 * module dependency — both files are loaded at startup and the reconciler
 * doesn't need the rest of the proxy-manager.
 *
 * The Middleware lives in the `platform` namespace; admin-ingress routes
 * reference it as `platform-oauth2-proxy-auth@platform` when protect* is on.
 */
const OAUTH2_PROXY_MIDDLEWARE_NAME = 'platform-oauth2-proxy-auth';

/**
 * WAF Middleware attached to platform-ingress panel routes. Currently
 * `modsecurity-crs` (the ModSecurity-CRS sidecar Deployment in the
 * traefik namespace, fronted by the madebymode plugin). The Coraza
 * scaffolding under k8s/base/traefik/middlewares-waf.yaml remains
 * documented dead code; when a working in-process Coraza plugin lands
 * upstream this flips back to `coraza-platform` with no schema change.
 */
const PLATFORM_WAF_MIDDLEWARE_NAME = 'modsecurity-crs';

/**
 * CrowdSec bouncer Middleware — platform-wide IP-reputation gate
 * attached to EVERY route the platform ingresses (admin/client panels
 * here, tenant routes via the buildAllRouteSpecs path). Runs first in
 * the middleware chain so known-bad IPs short-circuit before any other
 * processing.
 */
const PLATFORM_CROWDSEC_MIDDLEWARE_NAME = 'crowdsec';

// ─── Pure helpers (exported for testability) ─────────────────────────────

/**
 * Extract a bare hostname from a URL string. Returns null for empty,
 * malformed, or unparseable input — caller must treat null as "skip this
 * route", never as "omit the host field" in the IngressRoute spec.
 *
 * Enforces that the hostname is something cert-manager can realistically
 * issue a cert for:
 *   - must be a DNS name, not an IPv4/IPv6 literal (Let's Encrypt can't
 *     issue for bare IPs; putting one into the Certificate dnsNames would
 *     leave it stuck in pending forever)
 *   - must not be `localhost` or a single-label name (same reason)
 *   - must pass a conservative FQDN regex (RFC-1123 labels, at least one
 *     dot). Wildcard not allowed at the API level.
 * Invalid input → null, logged at the call site as "skipping bad host".
 */
const FQDN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/i;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function extractHost(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (IPV4_RE.test(normalized)) return null;
  if (normalized.includes(':')) return null;
  if (normalized === 'localhost') return null;
  if (!FQDN_RE.test(normalized)) return null;
  return normalized.toLowerCase();
}

interface DesiredRoute {
  host: string;
  serviceName: string;
  oauth2: boolean;
}

/**
 * Build the desired route list from the input. Pure — exported for tests.
 */
export function buildDesiredRoutes(input: IngressReconcileInput): DesiredRoute[] {
  const desired: DesiredRoute[] = [];
  const adminHost = extractHost(input.adminPanelUrl);
  const clientHost = extractHost(input.clientPanelUrl);
  if (adminHost) {
    desired.push({
      host: adminHost,
      serviceName: PANEL_SERVICES.admin,
      oauth2: input.protectAdminViaProxy === true,
    });
  }
  if (clientHost) {
    desired.push({
      host: clientHost,
      serviceName: PANEL_SERVICES.client,
      oauth2: input.protectClientViaProxy === true,
    });
  }
  return desired;
}

/**
 * Render a Traefik IngressRoute body for the given hosts + services.
 * Pure — exported for tests.
 */
export function buildIngressRouteBody(
  routes: ReadonlyArray<DesiredRoute>,
  opts: { namespace: string; name: string; tlsSecretName: string },
): Record<string, unknown> {
  // One route per host. The /oauth2 prefix gets a higher priority so it
  // wins over `/` matching against the same hostname. When protect* is
  // on, the panel route ALSO gets a ForwardAuth Middleware reference
  // so every non-/oauth2 request is gated by oauth2-proxy's /oauth2/auth
  // endpoint (the actual ForwardAuth Middleware CR is owned by
  // oidc/ingress-proxy-manager.ts).
  const traefikRoutes: Array<Record<string, unknown>> = [];
  for (const r of routes) {
    if (r.oauth2) {
      // /oauth2/* passes through to oauth2-proxy itself — no auth
      // Middleware here, because oauth2-proxy IS the auth endpoint.
      traefikRoutes.push({
        match: `Host(\`${r.host}\`) && PathPrefix(\`/oauth2\`)`,
        kind: 'Rule',
        priority: 100,
        services: [{ name: OAUTH2_PROXY_SERVICE, port: OAUTH2_PROXY_PORT }],
      });
    }
    // Panel route middlewares — in order of execution:
    //   1. CrowdSec bouncer — short-circuit known-bad IPs before any
    //      downstream processing. Always-on, platform-wide.
    //   2. ForwardAuth (oauth2-proxy) when protect* is on.
    //   3. WAF (`modsecurity-crs@traefik`) — admin / client panels are
    //      sensitive surfaces, so WAF is always-on here regardless of
    //      tenant-level wafEnabled (which only controls tenant routes).
    const panelMiddlewares: Array<{ name: string; namespace: string }> = [
      { name: PLATFORM_CROWDSEC_MIDDLEWARE_NAME, namespace: 'traefik' },
    ];
    if (r.oauth2) {
      panelMiddlewares.push({ name: OAUTH2_PROXY_MIDDLEWARE_NAME, namespace: 'platform' });
    }
    panelMiddlewares.push({ name: PLATFORM_WAF_MIDDLEWARE_NAME, namespace: 'traefik' });
    const panelRoute: Record<string, unknown> = {
      match: `Host(\`${r.host}\`)`,
      kind: 'Rule',
      middlewares: panelMiddlewares,
      services: [{ name: r.serviceName, port: 80 }],
    };
    traefikRoutes.push(panelRoute);
  }

  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': DEFAULTS.fieldManager,
      },
    },
    spec: {
      entryPoints: ['websecure'],
      routes: traefikRoutes,
      tls: {
        secretName: opts.tlsSecretName,
      },
    },
  };
}

/**
 * Render a cert-manager Certificate body matching the hostnames. Pure.
 */
export function buildCertificateBody(
  hosts: ReadonlyArray<string>,
  opts: { namespace: string; name: string; secretName: string; issuerName: string },
): Record<string, unknown> {
  return {
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/managed-by': DEFAULTS.fieldManager,
      },
    },
    spec: {
      secretName: opts.secretName,
      duration: '2160h',
      renewBefore: '720h',
      privateKey: {
        algorithm: 'ECDSA',
        size: 256,
        rotationPolicy: 'Always',
      },
      usages: ['digital signature', 'key encipherment', 'server auth'],
      dnsNames: [...hosts],
      issuerRef: {
        name: opts.issuerName,
        kind: 'ClusterIssuer',
        group: 'cert-manager.io',
      },
    },
  };
}

// ─── Core reconciler ─────────────────────────────────────────────────────

export async function reconcileIngressHosts(
  input: IngressReconcileInput,
  deps?: IngressReconcileDeps,
  opts: IngressReconcileOptions = {},
): Promise<IngressReconcileResult> {
  const d = deps ?? defaultDeps(opts);

  const desired = buildDesiredRoutes(input);

  // Never render an empty IngressRoute — Traefik would skip it and the
  // hostnames would 404. Leave whatever is currently applied.
  if (desired.length === 0) {
    return { changed: false };
  }

  const namespace = opts.namespace ?? DEFAULTS.namespace;
  const ingressName = opts.ingressName ?? DEFAULTS.ingressName;
  const certificateName = DEFAULTS.certificateName;
  const issuerName = opts.clusterIssuerName ?? DEFAULTS.clusterIssuerName;

  // Compare current vs desired to skip no-op applies.
  let routesUnchanged = false;
  const currentRoute = await d.readIngressRoute();
  if (currentRoute) {
    routesUnchanged =
      currentRoute.routes.length === desired.length &&
      currentRoute.routes.every((r, i) => {
        const currentOauth2 = r.oauth2Backend === OAUTH2_PROXY_SERVICE;
        return (
          r.host === desired[i].host &&
          r.serviceName === desired[i].serviceName &&
          currentOauth2 === desired[i].oauth2
        );
      }) &&
      currentRoute.tlsSecret === input.tlsSecretName;
  }

  let certUnchanged = false;
  const currentCert = await d.readCertificate();
  const desiredHosts = desired.map((r) => r.host);
  if (currentCert) {
    certUnchanged =
      currentCert.dnsNames.length === desiredHosts.length &&
      currentCert.dnsNames.every((h, i) => h === desiredHosts[i]) &&
      currentCert.secretName === input.tlsSecretName &&
      currentCert.issuerName === issuerName;
  }

  if (routesUnchanged && certUnchanged) {
    return { changed: false };
  }

  const certBody = buildCertificateBody(desiredHosts, {
    namespace,
    name: certificateName,
    secretName: input.tlsSecretName,
    issuerName,
  });
  const ingressBody = buildIngressRouteBody(desired, {
    namespace,
    name: ingressName,
    tlsSecretName: input.tlsSecretName,
  });

  // Cert first so the Secret has a chance to materialise before Traefik
  // tries to load it. cert-manager is async — the Secret won't appear in
  // the same tick — but ordering keeps the dependency chain visible in
  // logs (a missing Cert is easier to debug than a missing Secret).
  await d.applyCertificate(certBody);
  await d.applyIngressRoute(ingressBody);
  return { changed: true };
}

// ─── Default k8s-backed deps ─────────────────────────────────────────────

const TRAEFIK_GROUP = 'traefik.io';
const TRAEFIK_VERSION = 'v1alpha1';
const INGRESSROUTE_PLURAL = 'ingressroutes';
const CERTMANAGER_GROUP = 'cert-manager.io';
const CERTMANAGER_VERSION = 'v1';
const CERTIFICATE_PLURAL = 'certificates';

function defaultDeps(opts: IngressReconcileOptions): IngressReconcileDeps {
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const namespace = opts.namespace ?? DEFAULTS.namespace;
  const ingressName = opts.ingressName ?? DEFAULTS.ingressName;
  const certificateName = DEFAULTS.certificateName;

  return {
    readIngressRoute: async () => {
      try {
        const res = await custom.getNamespacedCustomObject({
          group: TRAEFIK_GROUP,
          version: TRAEFIK_VERSION,
          namespace,
          plural: INGRESSROUTE_PLURAL,
          name: ingressName,
        });
        const spec = (res as { spec?: Record<string, unknown> }).spec ?? {};
        const routes = ((spec.routes as Array<Record<string, unknown>>) ?? [])
          // The reconciler emits two routes per oauth2 host (the /oauth2
          // priority-100 route + the catch-all `/` route). When reading
          // back we collapse the pair into a single "panel route" with
          // the oauth2Backend field populated, so the desired-vs-current
          // comparison stays symmetrical with the desired-routes shape.
          .reduce<
            Array<{ host: string; serviceName: string; oauth2Backend: string | null }>
          >((acc, route) => {
            const match = String(route.match ?? '');
            const hostMatch = match.match(/Host\(`([^`]+)`\)/);
            const host = hostMatch?.[1] ?? '';
            if (!host) return acc;
            const services = (route.services as Array<Record<string, unknown>>) ?? [];
            const svcName = (services[0]?.name as string | undefined) ?? '';
            const isOauth2Path = /PathPrefix\(`\/oauth2`\)/.test(match);
            const existing = acc.find((r) => r.host === host);
            if (existing) {
              if (isOauth2Path) {
                existing.oauth2Backend = svcName;
              } else {
                existing.serviceName = svcName;
              }
            } else {
              acc.push({
                host,
                serviceName: isOauth2Path ? '' : svcName,
                oauth2Backend: isOauth2Path ? svcName : null,
              });
            }
            return acc;
          }, []);
        const tls = (spec.tls as { secretName?: string } | undefined) ?? null;
        return {
          routes,
          tlsSecret: tls?.secretName ?? null,
        };
      } catch (err: unknown) {
        if (isK8sNotFound(err)) return null;
        throw err;
      }
    },
    readCertificate: async () => {
      try {
        const res = await custom.getNamespacedCustomObject({
          group: CERTMANAGER_GROUP,
          version: CERTMANAGER_VERSION,
          namespace,
          plural: CERTIFICATE_PLURAL,
          name: certificateName,
        });
        const spec = (res as { spec?: Record<string, unknown> }).spec ?? {};
        return {
          dnsNames: ((spec.dnsNames as string[]) ?? []).slice(),
          secretName: (spec.secretName as string | undefined) ?? null,
          issuerName: ((spec.issuerRef as { name?: string } | undefined)?.name) ?? null,
        };
      } catch (err: unknown) {
        if (isK8sNotFound(err)) return null;
        throw err;
      }
    },
    applyIngressRoute: async (body) => {
      await createOrReplaceCustomObject(custom, {
        group: TRAEFIK_GROUP,
        version: TRAEFIK_VERSION,
        namespace,
        plural: INGRESSROUTE_PLURAL,
        name: ingressName,
        body,
      });
    },
    applyCertificate: async (body) => {
      await createOrReplaceCustomObject(custom, {
        group: CERTMANAGER_GROUP,
        version: CERTMANAGER_VERSION,
        namespace,
        plural: CERTIFICATE_PLURAL,
        name: certificateName,
        body,
      });
    },
  };
}

function isK8sNotFound(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number })?.statusCode === 404) return true;
  if ((err as { code?: number })?.code === 404) return true;
  return false;
}

interface ApplyArgs {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: Record<string, unknown>;
}

async function createOrReplaceCustomObject(
  custom: k8s.CustomObjectsApi,
  args: ApplyArgs,
): Promise<void> {
  // Try GET first to get the current resourceVersion for a clean
  // replace. CustomObjectsApi.patchNamespacedCustomObject would be
  // nicer (SSA) but its content-type handling varies across
  // @kubernetes/client-node releases, so a read-then-replace is the
  // most portable shape today (mirrors the pattern in
  // backend/src/modules/k8s-provisioner/k8s-client.ts).
  try {
    const existing = await custom.getNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      name: args.name,
    });
    const meta = ((existing as { metadata?: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>;
    const replaceBody = {
      ...args.body,
      metadata: {
        ...(args.body.metadata as Record<string, unknown>),
        resourceVersion: meta.resourceVersion,
      },
    };
    await custom.replaceNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      name: args.name,
      body: replaceBody,
    });
  } catch (err: unknown) {
    if (!isK8sNotFound(err)) throw err;
    await custom.createNamespacedCustomObject({
      group: args.group,
      version: args.version,
      namespace: args.namespace,
      plural: args.plural,
      body: args.body,
    });
  }
}
