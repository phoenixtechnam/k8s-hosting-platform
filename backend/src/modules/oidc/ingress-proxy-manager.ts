/**
 * Ingress annotation manager for OAuth2 Proxy protection.
 *
 * When proxy protection is enabled for a panel (admin/client), this module
 * adds nginx auth annotations to the platform Ingress rules so that
 * oauth2-proxy gates access. A separate break-glass Ingress provides an
 * unauthenticated path for emergency admin access.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';
const PLATFORM_INGRESS_NAME = 'platform-ingress';
const BREAK_GLASS_INGRESS_NAME = 'platform-break-glass-ingress';
const ADMIN_PANEL_SERVICE = 'admin-panel';
const ADMIN_PANEL_PORT = 80;

const OAUTH2_PROXY_AUTH_URL = 'http://oauth2-proxy.platform.svc.cluster.local:4180/oauth2/auth';
const OAUTH2_PROXY_RESPONSE_HEADERS = 'X-Auth-Request-User,X-Auth-Request-Email,X-Auth-Request-Access-Token';

// Annotation keys managed by this module
const AUTH_URL_ANNOTATION = 'nginx.ingress.kubernetes.io/auth-url';
const AUTH_SIGNIN_ANNOTATION = 'nginx.ingress.kubernetes.io/auth-signin';
const AUTH_RESPONSE_HEADERS_ANNOTATION = 'nginx.ingress.kubernetes.io/auth-response-headers';
const PROXY_MANAGED_ANNOTATION = 'hosting-platform/oauth2-proxy-managed';

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

function buildSigninUrl(host: string): string {
  return `https://${host}/oauth2/start?rd=$scheme://$host$escaped_request_uri`;
}

function buildProxyAnnotations(host: string): Record<string, string> {
  return {
    [AUTH_URL_ANNOTATION]: OAUTH2_PROXY_AUTH_URL,
    [AUTH_SIGNIN_ANNOTATION]: buildSigninUrl(host),
    [AUTH_RESPONSE_HEADERS_ANNOTATION]: OAUTH2_PROXY_RESPONSE_HEADERS,
    [PROXY_MANAGED_ANNOTATION]: 'true',
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ProxySettings {
  readonly protectAdminViaProxy: boolean;
  readonly protectClientViaProxy: boolean;
  readonly breakGlassPath: string | null;
}

/**
 * Reconcile the platform Ingress annotations based on proxy settings.
 *
 * For each panel (admin, client):
 * - If proxy enabled: add auth-url, auth-signin, auth-response-headers annotations
 *   to the corresponding Ingress rule
 * - If proxy disabled: remove those annotations
 *
 * For break-glass: create/update a separate Ingress that routes
 * /{breakGlassPath} to the admin panel WITHOUT auth annotations.
 */
export async function syncProxyIngressAnnotations(
  _db: Database,
  k8s: K8sClients,
  settings: ProxySettings,
): Promise<void> {
  // Read the current platform Ingress
  let currentIngress: Record<string, unknown>;
  try {
    currentIngress = await k8s.networking.readNamespacedIngress({
      name: PLATFORM_INGRESS_NAME,
      namespace: PLATFORM_NAMESPACE,
    }) as unknown as Record<string, unknown>;
  } catch (err: unknown) {
    if (isK8s404(err)) {
      // Ingress doesn't exist yet — nothing to annotate
      return;
    }
    throw err;
  }

  const metadata = (currentIngress as { metadata?: Record<string, unknown> }).metadata ?? {};
  const annotations = { ...(metadata.annotations ?? {}) } as Record<string, string>;
  const spec = (currentIngress as { spec?: Record<string, unknown> }).spec ?? {};
  const rules = (spec.rules ?? []) as Array<{ host?: string }>;

  // Determine hosts for each panel from the existing Ingress rules
  const adminHost = findHostForService(rules, spec, 'admin-panel');
  const clientHost = findHostForService(rules, spec, 'client-panel');

  // Decide whether ANY rule needs proxy annotations on the shared Ingress.
  // The platform Ingress is a single resource with multiple host rules.
  // NGINX Ingress annotations apply to the entire Ingress, so we use
  // snippet annotations or, when both panels share one Ingress, we set
  // annotations when at least one panel needs protection.
  //
  // Strategy: if either panel is protected, add the auth annotations.
  // The oauth2-proxy itself is responsible for allowing/denying based
  // on the request host. This keeps the Ingress simple.
  const anyProtected = settings.protectAdminViaProxy || settings.protectClientViaProxy;

  if (anyProtected) {
    // Use the admin host for the signin URL (primary), fall back to client
    const signinHost = adminHost ?? clientHost ?? 'localhost';
    const proxyAnnotations = buildProxyAnnotations(signinHost);
    for (const [key, value] of Object.entries(proxyAnnotations)) {
      annotations[key] = value;
    }
  } else {
    // Remove proxy annotations
    delete annotations[AUTH_URL_ANNOTATION];
    delete annotations[AUTH_SIGNIN_ANNOTATION];
    delete annotations[AUTH_RESPONSE_HEADERS_ANNOTATION];
    delete annotations[PROXY_MANAGED_ANNOTATION];
  }

  // Patch annotations on the existing Ingress
  const patchBody = {
    metadata: {
      name: PLATFORM_INGRESS_NAME,
      namespace: PLATFORM_NAMESPACE,
      annotations,
    },
  };

  try {
    await k8s.networking.patchNamespacedIngress({
      name: PLATFORM_INGRESS_NAME,
      namespace: PLATFORM_NAMESPACE,
      body: patchBody,
    });
  } catch {
    // Fall back to full replace if strategic merge patch fails
    const fullBody = { ...currentIngress, metadata: { ...metadata, annotations } };
    await k8s.networking.replaceNamespacedIngress({
      name: PLATFORM_INGRESS_NAME,
      namespace: PLATFORM_NAMESPACE,
      body: fullBody,
    });
  }

  // Manage break-glass Ingress
  await syncBreakGlassIngress(k8s, settings, adminHost);
}

// ─── Break-Glass Ingress ────────────────────────────────────────────────────

async function syncBreakGlassIngress(
  k8s: K8sClients,
  settings: ProxySettings,
  adminHost: string | null,
): Promise<void> {
  const shouldExist = settings.protectAdminViaProxy && settings.breakGlassPath;

  if (!shouldExist) {
    // Delete the break-glass Ingress if it exists
    try {
      await k8s.networking.deleteNamespacedIngress({
        name: BREAK_GLASS_INGRESS_NAME,
        namespace: PLATFORM_NAMESPACE,
      });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
    return;
  }

  if (!adminHost) return;

  const breakGlassPath = settings.breakGlassPath!;

  const ingressBody = {
    metadata: {
      name: BREAK_GLASS_INGRESS_NAME,
      namespace: PLATFORM_NAMESPACE,
      labels: {
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'break-glass',
      },
      annotations: {
        'nginx.ingress.kubernetes.io/rewrite-target': '/$2',
        'nginx.ingress.kubernetes.io/proxy-body-size': '64m',
        // Explicitly NO auth annotations — this is the emergency path
      } as Record<string, string>,
    },
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: adminHost,
          http: {
            paths: [
              {
                path: `/${breakGlassPath}(/|$)(.*)`,
                pathType: 'ImplementationSpecific' as const,
                backend: {
                  service: {
                    name: ADMIN_PANEL_SERVICE,
                    port: { number: ADMIN_PANEL_PORT },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  };

  try {
    await k8s.networking.createNamespacedIngress({
      namespace: PLATFORM_NAMESPACE,
      body: ingressBody,
    });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.networking.replaceNamespacedIngress({
        name: BREAK_GLASS_INGRESS_NAME,
        namespace: PLATFORM_NAMESPACE,
        body: ingressBody,
      });
    } else {
      throw err;
    }
  }
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
    await k8s.core.patchNamespacedSecret({
      name: 'oauth2-proxy-config',
      namespace: PLATFORM_NAMESPACE,
      body: secretBody,
    });
  } catch (err: unknown) {
    if (isK8s404(err)) {
      await k8s.core.createNamespacedSecret({
        namespace: PLATFORM_NAMESPACE,
        body: secretBody,
      });
    } else {
      throw err;
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Find the host that routes to a given service name in the Ingress rules.
 */
function findHostForService(
  rules: Array<{ host?: string }>,
  spec: Record<string, unknown>,
  serviceName: string,
): string | null {
  const fullRules = (spec.rules ?? rules) as Array<{
    host?: string;
    http?: {
      paths?: Array<{
        backend?: {
          service?: { name?: string };
        };
      }>;
    };
  }>;

  for (const rule of fullRules) {
    const paths = rule.http?.paths ?? [];
    for (const p of paths) {
      if (p.backend?.service?.name === serviceName) {
        return rule.host ?? null;
      }
    }
  }
  return null;
}
