/**
 * Traefik IngressRoute + Middleware shape helpers.
 *
 * Replaces the prior nginx-ingress annotation-driven model. Each
 * Middleware is a separate CRD; an IngressRoute references them by name
 * inside `routes[].middlewares[]`. Tenant reconcilers emit a
 * `RouteSpec` per ingress_routes row; the spec carries both the
 * IngressRoute body and any companion Middleware bodies that need to
 * be applied side-by-side.
 *
 * The companion Middlewares have stable names derived from the route
 * id so reconciler runs are idempotent and orphan-cleanup can target
 * exact names without label scans.
 *
 * `traefik.io/v1alpha1` is the only API version Traefik v3.7 ("Langres")
 * accepts for these CRDs.
 */

export const TRAEFIK_GROUP = 'traefik.io';
export const TRAEFIK_VERSION = 'v1alpha1';
export const INGRESSROUTE_PLURAL = 'ingressroutes';
export const MIDDLEWARE_PLURAL = 'middlewares';
export const TLSOPTION_PLURAL = 'tlsoptions';

export const CERTMANAGER_GROUP = 'cert-manager.io';
export const CERTMANAGER_VERSION = 'v1';
export const CERTIFICATE_PLURAL = 'certificates';

export interface TraefikService {
  name: string;
  port: number;
  /** Optional kube-namespace override for cross-ns Service refs. */
  namespace?: string;
}

export interface TraefikRoute {
  match: string;
  kind: 'Rule';
  /** Higher = wins. Default = match-rule length. */
  priority?: number;
  /** Middlewares to apply BEFORE the route's services. Order matters. */
  middlewares?: Array<{ name: string; namespace?: string }>;
  services: TraefikService[];
}

export interface TraefikIngressRouteSpec {
  entryPoints: string[];
  routes: TraefikRoute[];
  tls?: {
    secretName?: string;
    options?: { name: string; namespace?: string };
  };
}

export interface MiddlewareBody {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'Middleware';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  // The spec is one of many top-level kinds (forwardAuth, rateLimit,
  // redirectScheme, redirectRegex, ipWhiteList, basicAuth, headers,
  // chain, …). Typed loosely here — call sites are typed by the
  // builder functions.
  spec: Record<string, unknown>;
}

export interface IngressRouteBody {
  apiVersion: 'traefik.io/v1alpha1';
  kind: 'IngressRoute';
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: TraefikIngressRouteSpec;
}

/**
 * Aggregate of what a single ingress_routes row produces in the
 * Traefik model. The reconciler:
 *   1. Applies every body in `middlewares[]` first (Middleware CRDs
 *      must exist before the IngressRoute that references them).
 *   2. Applies `ingressRoute` (one per host or per hostname-group).
 *   3. Reads `expectedMiddlewareNames` to compute orphan cleanup
 *      (Middleware CRDs no longer referenced by any RouteSpec for the
 *      same client get deleted).
 */
export interface RouteSpec {
  /** Hostname this spec services — for diagnostics + grouping. */
  hostname: string;
  /** Companion Middleware CRDs to apply before the IngressRoute. */
  middlewares: MiddlewareBody[];
  /** Middleware names this spec references (subset of middlewares[]). */
  expectedMiddlewareNames: string[];
  /** The IngressRoute body itself. */
  ingressRoute: IngressRouteBody;
}

// ─── Pure builders ─────────────────────────────────────────────────

const MANAGED_BY = 'platform-api';
const PART_OF = 'hosting-platform';

function defaultLabels(extra?: Record<string, string>): Record<string, string> {
  return {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    ...extra,
  };
}

export function buildMiddleware(args: {
  name: string;
  namespace: string;
  spec: Record<string, unknown>;
  labels?: Record<string, string>;
}): MiddlewareBody {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'Middleware',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: defaultLabels(args.labels),
    },
    spec: args.spec,
  };
}

export function buildIngressRoute(args: {
  name: string;
  namespace: string;
  routes: TraefikRoute[];
  tls?: TraefikIngressRouteSpec['tls'];
  entryPoints?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}): IngressRouteBody {
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: args.name,
      namespace: args.namespace,
      labels: defaultLabels(args.labels),
      ...(args.annotations ? { annotations: args.annotations } : {}),
    },
    spec: {
      entryPoints: args.entryPoints ?? ['websecure'],
      routes: args.routes,
      ...(args.tls ? { tls: args.tls } : {}),
    },
  };
}

/**
 * Build a stable Middleware name from a route id + a suffix that
 * identifies the kind of middleware. Stable names let reconciles be
 * idempotent and orphan cleanup be deterministic.
 *
 * 8-char prefix of the route id keeps names within the K8s 63-char
 * limit even with long suffixes.
 */
export function middlewareName(routeId: string, suffix: string): string {
  return `r-${routeId.slice(0, 8)}-${suffix}`;
}

export type MiddlewareKind =
  | 'ratelimit'
  | 'ipallowlist'
  | 'redirectregex'
  | 'redirectscheme'
  | 'basicauth'
  | 'forwardauth'
  | 'headers'
  | 'stripprefix'
  | 'mtls';

// ─── Pure spec helpers ────────────────────────────────────────────────

export interface RateLimitArgs {
  /** Avg requests per second. Maps to nginx `limit-rps`. */
  average: number;
  /** Burst — additional queued requests before throttle kicks in. */
  burst: number;
}
export function rateLimitSpec(args: RateLimitArgs): Record<string, unknown> {
  return {
    rateLimit: {
      average: args.average,
      burst: args.burst,
    },
  };
}

/**
 * Concurrent-connection cap. Traefik's `inFlightReq` Middleware throttles
 * based on the number of simultaneous requests from one source IP. Maps
 * to the nginx `limit-connections` annotation we used to emit.
 */
export function inFlightReqSpec(amount: number): Record<string, unknown> {
  return {
    inFlightReq: {
      amount,
      // ipStrategy with no depth defaults to the immediate remote
      // address — matches nginx limit_conn's `$binary_remote_addr`
      // bucket key. Operators behind a known L4 LB can patch this to
      // `ipStrategy: { depth: 1 }` to read the X-Forwarded-For chain.
      sourceCriterion: { ipStrategy: {} },
    },
  };
}

export interface ErrorsArgs {
  /** HTTP status codes to intercept (e.g. ['404', '503'] or ['500-599']). */
  status: string[];
  /** Backend Service name to serve the error page. */
  serviceName: string;
  /** Service port. Default 80. */
  servicePort?: number;
  /** Cross-namespace ref override. Defaults to the IngressRoute's namespace. */
  serviceNamespace?: string;
  /** Path on the backend (Traefik's `query`). Default `/{status}.html`. */
  query?: string;
}

/**
 * `errors` Middleware — intercept upstream responses with status codes
 * matching `status` and serve content from a different Service instead.
 * Replaces the nginx `custom-http-errors` annotation + default-backend
 * pattern.
 */
export function errorsSpec(args: ErrorsArgs): Record<string, unknown> {
  return {
    errors: {
      status: args.status,
      service: {
        name: args.serviceName,
        port: args.servicePort ?? 80,
        ...(args.serviceNamespace ? { namespace: args.serviceNamespace } : {}),
      },
      query: args.query ?? '/{status}.html',
    },
  };
}

export function ipAllowListSpec(cidrs: string[]): Record<string, unknown> {
  return {
    ipAllowList: {
      sourceRange: cidrs,
    },
  };
}

export function redirectSchemeSpec(scheme: 'http' | 'https', permanent = true): Record<string, unknown> {
  return {
    redirectScheme: { scheme, permanent },
  };
}

export interface RedirectRegexArgs {
  regex: string;
  replacement: string;
  permanent?: boolean;
}
export function redirectRegexSpec(args: RedirectRegexArgs): Record<string, unknown> {
  return {
    redirectRegex: {
      regex: args.regex,
      replacement: args.replacement,
      permanent: args.permanent ?? false,
    },
  };
}

/**
 * Basic-auth Middleware backed by a K8s Secret in the same namespace.
 * The Secret must contain a key `users` with htpasswd-format content
 * (one user per line, password hashed with bcrypt/$2y$).
 */
export function basicAuthSpec(secretName: string, realm?: string): Record<string, unknown> {
  return {
    basicAuth: {
      secret: secretName,
      ...(realm ? { realm } : {}),
    },
  };
}

export interface ForwardAuthArgs {
  address: string;
  trustForwardHeader?: boolean;
  authResponseHeaders?: string[];
  authRequestHeaders?: string[];
}
export function forwardAuthSpec(args: ForwardAuthArgs): Record<string, unknown> {
  return {
    forwardAuth: {
      address: args.address,
      trustForwardHeader: args.trustForwardHeader ?? true,
      ...(args.authResponseHeaders ? { authResponseHeaders: args.authResponseHeaders } : {}),
      ...(args.authRequestHeaders ? { authRequestHeaders: args.authRequestHeaders } : {}),
    },
  };
}

export interface HeadersArgs {
  /** Custom request headers added before forwarding upstream. */
  customRequestHeaders?: Record<string, string>;
  /** Custom response headers added before sending back to client. */
  customResponseHeaders?: Record<string, string>;
  /** Server-side cors-allow-* equivalents (rare; opt-in). */
  accessControlAllowOriginList?: string[];
  /** When true, strip the listed request headers before upstream. */
  removeRequestHeaders?: string[];
}
export function headersSpec(args: HeadersArgs): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  if (args.customRequestHeaders) spec.customRequestHeaders = args.customRequestHeaders;
  if (args.customResponseHeaders) spec.customResponseHeaders = args.customResponseHeaders;
  if (args.accessControlAllowOriginList) spec.accessControlAllowOriginList = args.accessControlAllowOriginList;
  if (args.removeRequestHeaders) {
    // Traefik's headers Middleware doesn't have a remove-list field per se;
    // the closest path is to set each header to "" in customRequestHeaders.
    // Done here so callers don't need to know that quirk.
    spec.customRequestHeaders = {
      ...((spec.customRequestHeaders as Record<string, string> | undefined) ?? {}),
      ...Object.fromEntries(args.removeRequestHeaders.map((h) => [h, ''])),
    };
  }
  return { headers: spec };
}

export function stripPrefixSpec(prefixes: string[]): Record<string, unknown> {
  return {
    stripPrefix: {
      prefixes,
    },
  };
}

/**
 * Chain Middleware: composes several Middlewares into a pipeline that
 * other IngressRoutes can reference as a single name.
 */
export function chainSpec(middlewares: Array<{ name: string; namespace?: string }>): Record<string, unknown> {
  return { chain: { middlewares } };
}

export interface CorazaArgs {
  /** Include OWASP CRS v4 rule bundle. Default true. */
  owaspCrs?: boolean;
  /** Anomaly-scoring threshold (inbound). Lower = stricter. Default 10. */
  anomalyThreshold?: number;
  /** Outbound anomaly threshold. Default 5. */
  outboundAnomalyThreshold?: number;
  /** CRS rule IDs to disable (e.g. ['911100', '920420']). */
  excludedRules?: string[];
  /** Max body size buffered for inspection (bytes). Default 50 MiB. */
  bodyLimit?: number;
}

/**
 * Build a Coraza WAF plugin Middleware spec. The plugin slug `coraza`
 * is set in Traefik's Helm `experimental.plugins.coraza` block by
 * scripts/bootstrap.sh. Directives use the OWASP CRS v4 bundle that
 * ships with the Coraza plugin's wasm payload.
 *
 * For the base/platform variants ship as static YAML in
 * k8s/base/traefik/middlewares-waf.yaml. This builder is for per-route
 * customisations only (excluded rules + threshold overrides).
 */
export function corazaSpec(args: CorazaArgs = {}): Record<string, unknown> {
  const includeCrs = args.owaspCrs ?? true;
  const inboundThreshold = args.anomalyThreshold ?? 10;
  const outboundThreshold = args.outboundAnomalyThreshold ?? 5;
  const bodyLimit = args.bodyLimit ?? 52428800;
  const lines: string[] = [
    'Include @coraza.conf-recommended',
  ];
  if (includeCrs) {
    lines.push('Include @crs-setup.conf.example');
    lines.push('Include @owasp_crs/*.conf');
  }
  lines.push('SecRuleEngine On');
  lines.push('SecResponseBodyAccess Off');
  lines.push('SecRequestBodyAccess On');
  lines.push(`SecRequestBodyLimit ${bodyLimit}`);
  lines.push('SecRequestBodyNoFilesLimit 131072');
  // CRS anomaly-scoring threshold tunables — must be set BEFORE the
  // CRS rules evaluate. We include the SecAction here regardless of
  // whether the threshold differs from default so the directive block
  // is self-contained.
  lines.push(`SecAction "id:900110,phase:1,nolog,pass,t:none,setvar:tx.inbound_anomaly_score_threshold=${inboundThreshold}"`);
  lines.push(`SecAction "id:900120,phase:1,nolog,pass,t:none,setvar:tx.outbound_anomaly_score_threshold=${outboundThreshold}"`);
  for (const id of args.excludedRules ?? []) {
    // SecRuleRemoveById accepts a single id per directive. CRS rule
    // ids are 6-digit integers (e.g. 911100); reject anything else as
    // a defence against directive injection.
    if (!/^\d{3,7}$/.test(id)) continue;
    lines.push(`SecRuleRemoveById ${id}`);
  }
  return {
    plugin: {
      coraza: {
        directives: lines.join('\n'),
      },
    },
  };
}

// ─── Match-expression helpers ─────────────────────────────────────────

/**
 * Encode an identifier for safe insertion into a Traefik match
 * expression — Traefik route expressions use backticks as string
 * delimiters; embedded backticks in hostnames/paths would let an
 * attacker (or a typo in a tenant domain) break out of the literal.
 * RFC-1123 DNS labels can't contain backticks, but we still defence-
 * in-depth here.
 */
export function encodeMatchLiteral(s: string): string {
  if (s.includes('`')) {
    throw new Error(`Traefik match literal cannot contain backticks: ${s}`);
  }
  return s;
}

export function hostMatch(hostname: string): string {
  return `Host(\`${encodeMatchLiteral(hostname)}\`)`;
}

export function hostAndPathMatch(hostname: string, pathPrefix: string): string {
  return `Host(\`${encodeMatchLiteral(hostname)}\`) && PathPrefix(\`${encodeMatchLiteral(pathPrefix)}\`)`;
}
