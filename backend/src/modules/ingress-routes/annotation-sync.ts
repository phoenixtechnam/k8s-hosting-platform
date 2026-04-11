/**
 * K8s annotation sync for route-level ingress settings.
 *
 * Translates per-route settings (redirect, security, WAF, advanced)
 * into NGINX Ingress Controller annotations and K8s resources
 * (Secrets for basic auth, ConfigMaps for proxy headers).
 *
 * Called after any settings update and also during ingress reconciliation
 * to ensure annotations stay in sync.
 */

import { eq, and } from 'drizzle-orm';
import { ingressRoutes, routeProtectedDirs, routeAuthUsers, deployments, domains, clients } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

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

// ─── Auth Secret Sync ───────────────────────────────────────────────────────

/**
 * Generate htpasswd-format K8s Secret for basic auth users.
 *
 * The NGINX Ingress Controller expects an Opaque Secret with a key
 * named "auth" containing Apache htpasswd-format content.
 *
 * bcrypt hashes from the DB use the $2b$ prefix. Apache htpasswd
 * expects $2y$ — they are algorithmically identical, so we
 * swap the prefix for compatibility.
 */
/**
 * Sync htpasswd Secrets for all enabled protected directories on a route.
 *
 * Creates one Secret per protected directory that has enabled users.
 * Deletes Secrets for directories with no enabled users.
 */
export async function syncAuthSecret(
  db: Database,
  k8s: K8sClients,
  namespace: string,
  routeId: string,
): Promise<void> {
  // Find all enabled protected dirs for this route
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
      // No enabled users — delete Secret if it exists
      try {
        await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
      } catch (err: unknown) {
        if (!isK8s404(err)) throw err;
      }
      continue;
    }

    // Build htpasswd content: "user:$2y$10$hash\n"
    const htpasswdLines = users.map((u) => {
      // Swap $2b$ → $2y$ for Apache/NGINX compatibility
      const apacheHash = u.passwordHash.replace(/^\$2b\$/, '$2y$');
      return `${u.username}:${apacheHash}`;
    });
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
        auth: Buffer.from(htpasswdContent).toString('base64'),
      },
    };

    try {
      await k8s.core.createNamespacedSecret({ namespace, body: secretBody });
    } catch (err: unknown) {
      if (isK8s409(err)) {
        await k8s.core.replaceNamespacedSecret({
          name: secretName,
          namespace,
          body: secretBody,
        });
      } else {
        throw err;
      }
    }
  }

  // Also clean up the legacy route-level secret if it exists
  try {
    await k8s.core.deleteNamespacedSecret({ name: `route-auth-${routeId}`, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Proxy Headers ConfigMap ────────────────────────────────────────────────

async function syncProxyHeadersConfigMap(
  k8s: K8sClients,
  namespace: string,
  routeId: string,
  headers: Record<string, string>,
): Promise<string> {
  const cmName = `proxy-headers-${routeId.slice(0, 8)}`;

  const cmBody = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: cmName,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'hosting-platform',
        'hosting-platform/route-id': routeId,
      },
    },
    data: headers,
  };

  try {
    await k8s.core.createNamespacedConfigMap({ namespace, body: cmBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.core.replaceNamespacedConfigMap({
        name: cmName,
        namespace,
        body: cmBody,
      });
    } else {
      throw err;
    }
  }

  return cmName;
}

async function deleteProxyHeadersConfigMap(
  k8s: K8sClients,
  namespace: string,
  routeId: string,
): Promise<void> {
  const cmName = `proxy-headers-${routeId.slice(0, 8)}`;
  try {
    await k8s.core.deleteNamespacedConfigMap({ name: cmName, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Build Annotation Map ───────────────────────────────────────────────────

/**
 * Build the NGINX Ingress annotation map from route settings.
 *
 * Returns annotations that should be applied to the Ingress resource.
 * The caller (reconciler) merges these with any existing annotations.
 */
// ─── Header Validation Constants ─────────────────────────────────────────

const MAX_HEADERS = 50;
const MAX_HEADER_VALUE_LENGTH = 4096;

/**
 * Validate and sanitise a single header name.
 * Only alphanumeric characters, hyphens, and underscores are allowed.
 */
function sanitiseHeaderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_]/g, '');
}

/**
 * Validate and sanitise a single header value.
 * Strips newlines, carriage returns, curly braces, and backticks
 * to prevent NGINX configuration injection. Semicolons are allowed
 * (valid in header values like X-XSS-Protection: 1; mode=block).
 */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\n\r{}`]/g, '');
}

/**
 * Build a configuration-snippet with add_header directives from a
 * record of response headers.
 *
 * Returns the snippet string, or null if no valid headers remain.
 */
export function buildHeaderSnippet(
  headers: Record<string, string>,
): string | null {
  const entries = Object.entries(headers).slice(0, MAX_HEADERS);
  if (entries.length === 0) return null;

  const lines = entries
    .map(([name, value]) => {
      const safeName = sanitiseHeaderName(name);
      const safeValue = sanitiseHeaderValue(value).slice(0, MAX_HEADER_VALUE_LENGTH);
      if (!safeName) return null;
      // more_set_headers replaces existing header or adds if absent — no duplicates
      return `more_set_headers "${safeName}: ${safeValue}";`;
    })
    .filter(Boolean);

  return lines.length > 0 ? lines.join('\n') : null;
}

export function buildAnnotationsFromRoute(
  route: {
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
  },
  routeId: string,
  _namespace?: string,
  _proxyHeadersCmName?: string | null,
): Record<string, string> {
  const annotations: Record<string, string> = {};

  // ── Redirects ──
  if (route.forceHttps) {
    annotations['nginx.ingress.kubernetes.io/ssl-redirect'] = 'true';
  } else {
    annotations['nginx.ingress.kubernetes.io/ssl-redirect'] = 'false';
  }

  if (route.wwwRedirect === 'add-www') {
    annotations['nginx.ingress.kubernetes.io/from-to-www-redirect'] = 'true';
  }

  if (route.redirectUrl) {
    annotations['nginx.ingress.kubernetes.io/permanent-redirect'] = route.redirectUrl;
  }

  // Note: Basic auth annotations are now handled per-directory in the
  // ingress reconciler via protected dirs. The route-level annotation
  // builder no longer sets auth-type/auth-secret/auth-realm.

  // ── IP Allowlist ──
  if (route.ipAllowlist) {
    annotations['nginx.ingress.kubernetes.io/whitelist-source-range'] = route.ipAllowlist;
  }

  // ── Rate Limiting ──
  if (route.rateLimitRps) {
    annotations['nginx.ingress.kubernetes.io/limit-rps'] = String(route.rateLimitRps);
  }
  if (route.rateLimitConnections) {
    annotations['nginx.ingress.kubernetes.io/limit-connections'] = String(route.rateLimitConnections);
  }
  if (route.rateLimitBurstMultiplier) {
    annotations['nginx.ingress.kubernetes.io/limit-burst-multiplier'] = String(route.rateLimitBurstMultiplier);
  }

  // ── WAF / ModSecurity ──
  annotations['nginx.ingress.kubernetes.io/enable-modsecurity'] = route.wafEnabled ? 'true' : 'false';
  annotations['nginx.ingress.kubernetes.io/enable-owasp-core-rules'] = route.wafOwaspCrs ? 'true' : 'false';

  if (route.wafAnomalyThreshold !== 10 || route.wafExcludedRules) {
    let snippet = '';
    if (route.wafAnomalyThreshold !== 10) {
      snippet += `SecAction "id:900110,phase:1,nolog,pass,t:none,setvar:tx.inbound_anomaly_score_threshold=${route.wafAnomalyThreshold}"\n`;
    }
    if (route.wafExcludedRules) {
      for (const ruleId of route.wafExcludedRules.split(',').map((s) => s.trim())) {
        snippet += `SecRuleRemoveById ${ruleId}\n`;
      }
    }
    if (snippet) {
      annotations['nginx.ingress.kubernetes.io/modsecurity-snippet'] = snippet;
    }
  }

  // ── Custom Errors ──
  // Only set custom-http-errors if error codes are configured.
  // default-backend requires a K8s Service name (not a file path) —
  // customErrorPath stores a file path for future use but is NOT
  // a valid default-backend value. Omitting default-backend means
  // NGINX uses the global default backend for error responses.
  if (route.customErrorCodes) {
    annotations['nginx.ingress.kubernetes.io/custom-http-errors'] = route.customErrorCodes;
  }

  // ── Response Headers via configuration-snippet ──
  if (route.additionalHeaders && Object.keys(route.additionalHeaders).length > 0) {
    const snippet = buildHeaderSnippet(route.additionalHeaders);
    if (snippet) {
      // Append to existing configuration-snippet if WAF rules already set one
      const existing = annotations['nginx.ingress.kubernetes.io/configuration-snippet'];
      annotations['nginx.ingress.kubernetes.io/configuration-snippet'] = existing
        ? `${existing}\n${snippet}`
        : snippet;
    }
  }

  return annotations;
}

// ─── Main Sync Function ────────────────────────────────────────────────────

/**
 * Sync all route-level annotations and K8s resources for a given route.
 *
 * This function:
 * 1. Loads the route with all settings
 * 2. Resolves the client namespace
 * 3. Syncs the basic-auth K8s Secret (if basic auth is enabled)
 * 4. Cleans up legacy proxy-headers ConfigMap (now replaced by configuration-snippet)
 * 5. Returns the annotation map for the ingress reconciler to apply
 *
 * NOTE: This does NOT directly patch the Ingress. The ingress reconciler
 * in domains/k8s-ingress.ts owns the Ingress lifecycle and calls this
 * function to get the annotations to apply.
 */
export async function syncRouteAnnotations(
  db: Database,
  k8s: K8sClients,
  routeId: string,
  clientId: string,
): Promise<Record<string, string>> {
  // 1. Load the route with all settings
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) return {};

  // 2. Resolve client namespace
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client?.kubernetesNamespace) return {};
  const namespace = client.kubernetesNamespace;

  // 3. Sync basic-auth Secrets for all protected directories on this route
  await syncAuthSecret(db, k8s, namespace, routeId);

  // 4. Clean up legacy proxy-headers ConfigMap (replaced by configuration-snippet).
  // Safe to call unconditionally — ignores 404.
  await deleteProxyHeadersConfigMap(k8s, namespace, routeId);

  // 5. Build and return the annotation map
  const annotations = buildAnnotationsFromRoute(route, routeId);

  // 6. Sync protected directory child Ingresses
  await syncProtectedDirIngresses(db, k8s, routeId, clientId);

  return annotations;
}

/**
 * Collect annotations for all active routes of a client.
 *
 * Used by the ingress reconciler to gather per-route annotations
 * when building the Ingress resource. Since NGINX Ingress Controller
 * applies annotations at the Ingress level (not per-rule), the
 * reconciler should create per-route Ingress resources when routes
 * have divergent settings. For now, we merge annotations from all
 * routes — the last-write-wins behavior is acceptable for Phase 1.
 */
export async function syncAllRouteAnnotations(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  domainIds: string[],
): Promise<Record<string, string>> {
  const allRoutes = await db.select().from(ingressRoutes);
  const clientRoutes = allRoutes.filter(
    (r) => domainIds.includes(r.domainId) && r.deploymentId && r.status === 'active',
  );

  const merged: Record<string, string> = {};

  for (const route of clientRoutes) {
    const routeAnnotations = await syncRouteAnnotations(db, k8s, route.id, clientId);
    Object.assign(merged, routeAnnotations);
  }

  return merged;
}

// ─── Protected Directory Child Ingresses ────────────────────────────────────

/**
 * Create/update/delete child Ingress resources for protected directories.
 * Each enabled directory with users gets its own Ingress with auth.
 * Directories without users or disabled directories have their Ingress deleted.
 */
export async function syncProtectedDirIngresses(
  db: Database,
  k8s: K8sClients,
  routeId: string,
  clientId: string,
): Promise<void> {
  // 1. Load the parent route
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) return;

  // 2. Resolve namespace
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client?.kubernetesNamespace) return;
  const namespace = client.kubernetesNamespace;

  // 3. Resolve deployment service name + port
  let serviceName = 'default';
  const servicePort = 8080;
  if (route.deploymentId) {
    const [dep] = await db.select().from(deployments).where(eq(deployments.id, route.deploymentId));
    if (dep) {
      serviceName = dep.resourceSuffix ? `${dep.name}-${dep.resourceSuffix}` : dep.name;
    }
  }

  // 4. Build parent annotations (inherit everything)
  const parentAnnotations = buildAnnotationsFromRoute(route, routeId);

  // 5. Load all protected dirs for this route
  const dirs = await db.select().from(routeProtectedDirs)
    .where(eq(routeProtectedDirs.routeId, routeId));

  // 6. Create/update/delete child Ingress per directory
  for (const dir of dirs) {
    const ingressName = `route-dir-${dir.id.slice(0, 8)}`;
    const secretName = `route-auth-${dir.id}`;

    const users = await db.select().from(routeAuthUsers)
      .where(and(eq(routeAuthUsers.dirId, dir.id), eq(routeAuthUsers.enabled, 1)));

    if (!dir.enabled || users.length === 0) {
      // Delete child Ingress if disabled or no users
      try {
        await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
      } catch (e: unknown) {
        if (!isK8s404(e)) throw e;
      }
      continue;
    }

    // Build child annotations: parent annotations + auth overrides
    const childAnnotations: Record<string, string> = {
      ...parentAnnotations,
      'nginx.ingress.kubernetes.io/auth-type': 'basic',
      'nginx.ingress.kubernetes.io/auth-secret': secretName,
      'nginx.ingress.kubernetes.io/auth-realm': dir.realm || 'Restricted',
    };

    const ingressBody = {
      apiVersion: 'networking.k8s.io/v1' as const,
      kind: 'Ingress' as const,
      metadata: {
        name: ingressName,
        namespace,
        annotations: childAnnotations,
        labels: {
          'app.kubernetes.io/managed-by': 'hosting-platform',
          'hosting-platform/route-id': routeId,
          'hosting-platform/dir-id': dir.id,
        },
      },
      spec: {
        ingressClassName: 'nginx',
        rules: [{
          host: route.hostname,
          http: {
            paths: [{
              path: dir.path,
              pathType: 'Prefix' as const,
              backend: {
                service: { name: serviceName, port: { number: servicePort } },
              },
            }],
          },
        }],
      },
    };

    // Create or replace
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

  // 7. Clean up orphaned child Ingresses (dirs that were deleted from DB)
  try {
    const allIngresses = await k8s.networking.listNamespacedIngress({ namespace });
    const dirIds = new Set(dirs.map(d => d.id));
    for (const ing of (allIngresses.items ?? [])) {
      const dirLabel = ing.metadata?.labels?.['hosting-platform/dir-id'];
      const routeLabel = ing.metadata?.labels?.['hosting-platform/route-id'];
      if (routeLabel === routeId && dirLabel && !dirIds.has(dirLabel)) {
        try {
          await k8s.networking.deleteNamespacedIngress({ name: ing.metadata!.name!, namespace });
        } catch { /* Non-fatal orphan cleanup */ }
      }
    }
  } catch { /* Non-fatal — listing failure should not block sync */ }
}

/**
 * Delete a specific protected directory's child Ingress and Secret.
 */
export async function deleteProtectedDirIngress(
  k8s: K8sClients,
  namespace: string,
  dirId: string,
): Promise<void> {
  const ingressName = `route-dir-${dirId.slice(0, 8)}`;
  const secretName = `route-auth-${dirId}`;
  try {
    await k8s.networking.deleteNamespacedIngress({ name: ingressName, namespace });
  } catch (e: unknown) {
    if (!isK8s404(e)) throw e;
  }
  try {
    await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
  } catch (e: unknown) {
    if (!isK8s404(e)) throw e;
  }
}
