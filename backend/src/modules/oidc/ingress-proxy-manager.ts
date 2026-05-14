/**
 * OAuth2 Proxy admin-panel gating via Traefik ForwardAuth Middleware.
 *
 * When proxy protection is enabled for a panel (admin/client), this
 * module:
 *   1. Creates / updates a ForwardAuth Middleware named
 *      `platform-oauth2-proxy-auth` in the `platform` namespace. The
 *      Middleware calls oauth2-proxy's /oauth2/auth endpoint and
 *      injects the X-Auth-Request-* headers it returns.
 *   2. Maintains a separate break-glass IngressRoute that exposes a
 *      hidden URL prefix on the admin host, stripping the prefix
 *      before routing to admin-panel WITHOUT the ForwardAuth
 *      Middleware. This is the emergency-only escape hatch the
 *      operator uses if Dex/IdP is unreachable.
 *
 * The platform-ingress IngressRoute itself is owned by
 * system-settings/ingress-reconciler.ts — that reconciler reads the
 * `protectAdminViaProxy` / `protectClientViaProxy` flags from
 * system_settings and attaches the Middleware reference to the panel
 * routes by name. So we only need to ensure the Middleware EXISTS
 * here; the reconciler owns the spec.routes[].middlewares wiring.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import {
  buildMiddleware,
  buildIngressRoute,
  hostAndPathMatch,
  stripPrefixSpec,
  forwardAuthSpec,
  middlewareName,
} from '../ingress-routes/traefik-types.js';
import {
  applyMiddleware,
  deleteMiddleware,
  applyIngressRoute,
  deleteIngressRoute,
} from '../ingress-routes/traefik-apply.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';
const BREAK_GLASS_INGRESS_NAME = 'platform-break-glass-ingress';
const ADMIN_PANEL_SERVICE = 'admin-panel';
const ADMIN_PANEL_PORT = 80;

const OAUTH2_PROXY_HOST = 'oauth2-proxy.platform.svc.cluster.local';
const OAUTH2_PROXY_PORT = 4180;

/**
 * Stable Middleware name the platform-ingress reconciler references
 * when `protectAdminViaProxy` / `protectClientViaProxy` is true.
 * Kept here so both modules share one literal.
 */
export const OAUTH2_PROXY_MIDDLEWARE_NAME = 'platform-oauth2-proxy-auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if (isNotFound(err)) return true;
  return false;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ProxySettings {
  readonly protectAdminViaProxy: boolean;
  readonly protectClientViaProxy: boolean;
  readonly breakGlassPath: string | null;
  readonly adminHost?: string | null;
}

/**
 * Reconcile the OAuth2 Proxy Middleware + break-glass IngressRoute.
 *
 * - When `anyProtected` is true: ensure the ForwardAuth Middleware
 *   exists. The platform-ingress reconciler attaches it to the panel
 *   routes by name.
 * - When `anyProtected` is false: delete the Middleware (the reconciler
 *   stops referencing it, but a dangling Middleware CR is harmless;
 *   delete anyway for cleanliness).
 * - Break-glass: when `protectAdminViaProxy` AND `breakGlassPath` set,
 *   create a high-priority IngressRoute that strips the secret prefix
 *   and forwards to admin-panel without the auth Middleware. Otherwise
 *   delete the IngressRoute + its companion stripPrefix Middleware.
 */
export async function syncProxyIngressAnnotations(
  _db: Database,
  k8s: K8sClients,
  settings: ProxySettings,
): Promise<void> {
  const anyProtected = settings.protectAdminViaProxy || settings.protectClientViaProxy;

  if (anyProtected) {
    // Create / update the ForwardAuth Middleware. The platform-ingress
    // reconciler is responsible for attaching the reference to the
    // panel routes when protect* settings are true; we just ensure the
    // Middleware CR exists.
    const middleware = buildMiddleware({
      name: OAUTH2_PROXY_MIDDLEWARE_NAME,
      namespace: PLATFORM_NAMESPACE,
      spec: forwardAuthSpec({
        address: `http://${OAUTH2_PROXY_HOST}:${OAUTH2_PROXY_PORT}/oauth2/auth`,
        // Inherit forwardAuthSpec safe default (false). oauth2-proxy's
        // auth check is cookie-based, doesn't need the client IP.
        // Entrypoint trustedIPs=127.0.0.1/32 already strips spoofed XFF.
        authResponseHeaders: [
          'X-Auth-Request-User',
          'X-Auth-Request-Email',
          'X-Auth-Request-Access-Token',
        ],
      }),
      labels: {
        'app.kubernetes.io/component': 'oauth2-proxy-auth',
      },
    });
    await applyMiddleware(k8s.custom, middleware);
  } else {
    // No panel is protected — clean up the Middleware CR. Reference
    // removal is the platform-ingress reconciler's job; we just stop
    // shipping the resource.
    await deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, OAUTH2_PROXY_MIDDLEWARE_NAME);
  }

  await syncBreakGlassIngressRoute(k8s, settings);
}

// ─── Break-Glass IngressRoute ───────────────────────────────────────────────

async function syncBreakGlassIngressRoute(
  k8s: K8sClients,
  settings: ProxySettings,
): Promise<void> {
  const shouldExist =
    settings.protectAdminViaProxy &&
    !!settings.breakGlassPath &&
    !!settings.adminHost;

  const stripPrefixName = middlewareName(BREAK_GLASS_INGRESS_NAME, 'strip');

  if (!shouldExist) {
    await Promise.all([
      deleteIngressRoute(k8s.custom, PLATFORM_NAMESPACE, BREAK_GLASS_INGRESS_NAME),
      deleteMiddleware(k8s.custom, PLATFORM_NAMESPACE, stripPrefixName),
    ]);
    return;
  }

  const breakGlassPath = settings.breakGlassPath!;
  const adminHost = settings.adminHost!;

  // Path-stripping Middleware: requests to /<breakGlassPath>/<rest> get
  // rewritten to /<rest> before hitting admin-panel. This matches the
  // nginx rewrite-target shape (/(?<rest>.*) → /$rest) but expressed
  // declaratively via stripPrefix.
  const stripMiddleware = buildMiddleware({
    name: stripPrefixName,
    namespace: PLATFORM_NAMESPACE,
    spec: stripPrefixSpec([`/${breakGlassPath}`]),
    labels: {
      'app.kubernetes.io/component': 'break-glass',
    },
  });
  await applyMiddleware(k8s.custom, stripMiddleware);

  // Higher-priority IngressRoute for the admin host break-glass path.
  // Priority must exceed any catch-all route on the same host (the
  // platform-ingress panel route uses default priority, which is the
  // match-rule length — our match is longer due to PathPrefix, so we
  // win naturally; the explicit priority=100 documents the intent).
  const ingressRoute = buildIngressRoute({
    name: BREAK_GLASS_INGRESS_NAME,
    namespace: PLATFORM_NAMESPACE,
    routes: [
      {
        match: hostAndPathMatch(adminHost, `/${breakGlassPath}`),
        kind: 'Rule',
        priority: 100,
        middlewares: [{ name: stripPrefixName, namespace: PLATFORM_NAMESPACE }],
        services: [{ name: ADMIN_PANEL_SERVICE, port: ADMIN_PANEL_PORT }],
      },
    ],
    labels: {
      'app.kubernetes.io/component': 'break-glass',
    },
  });
  await applyIngressRoute(k8s.custom, ingressRoute);
}

// ─── OAuth2 Proxy K8s Secret ─────────────────────────────────────────────────

/**
 * Sync the cookie secret to the oauth2-proxy K8s Secret.
 * Creates the Secret if it does not exist, patches it otherwise.
 */
export async function syncOAuth2ProxySecret(k8s: K8sClients, cookieSecret: string): Promise<void> {
  const secretBody = {
    apiVersion: 'v1' as const,
    kind: 'Secret' as const,
    metadata: { name: 'oauth2-proxy-config', namespace: PLATFORM_NAMESPACE },
    stringData: { OAUTH2_PROXY_COOKIE_SECRET: cookieSecret },
  };

  try {
    // MERGE_PATCH (RFC 7396) — Secret has no patchMergeKey directives, so
    // strategic-merge offers no benefit over plain merge-patch. Match the
    // pattern used elsewhere for flat resources / CRDs.
    await k8s.core.patchNamespacedSecret({
      name: 'oauth2-proxy-config',
      namespace: PLATFORM_NAMESPACE,
      body: secretBody,
    }, MERGE_PATCH);
  } catch (err: unknown) {
    if (isK8s404(err)) {
      // backup-coverage: excluded:cluster-infrastructure
      // (oauth2-proxy-config in `platform` ns; reconciled from
      // ingress_oauth2_clients DB rows captured by config-tables.)
      await k8s.core.createNamespacedSecret({
        namespace: PLATFORM_NAMESPACE,
        body: secretBody,
      });
    } else {
      throw err;
    }
  }
}
