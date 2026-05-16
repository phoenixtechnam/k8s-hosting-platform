/**
 * Per-tenant oauth2-proxy + claim-validator reconciler.
 *
 * Lifecycle:
 *   - First ingress in a tenant namespace gets `enabled=true` →
 *     ensureTenantProxy() materialises a Deployment (oauth2-proxy +
 *     claim-validator sidecar), Service, ConfigMap, Secret in that
 *     namespace, and updates the ConfigMap with the per-route OIDC
 *     config + claim rules.
 *   - Subsequent ingresses just update the ConfigMap; the Deployment
 *     is unchanged. ConfigMap reload is picked up by:
 *       * oauth2-proxy via SIGHUP / mounted-config refresh
 *       * claim-validator via fs.watch
 *   - Last ingress disables → tearDownTenantProxy() deletes the four
 *     resources cleanly.
 *
 * Idempotent: every resource write is a server-side apply via
 * replace-or-create. Failures on individual sub-resources do NOT
 * leave the cluster in a broken state — the next reconciler tick
 * re-runs the same operations.
 *
 * NOTE on the K8s tenant API style: we call `replaceNamespacedX` /
 * `createNamespacedX` from `@kubernetes/client-node` v1, which
 * requires the args to be passed as an object literal (not positional)
 * and the body cast as an unknown type — the library's signatures
 * are defined for runtime flexibility, not for compile-time safety.
 */

import * as k8s from '@kubernetes/client-node';
import { eq, sql } from 'drizzle-orm';
import {
  tenantOauth2ProxyState,
  tenants,
  ingressAuthConfigs,
  ingressRoutes,
  domains,
} from '../../db/schema.js';
import {
  getOrCreateTenantCookieSecret,
  listEnabledForTenant as listEnabledForTenantJoined,
  type EnabledIngressAuthRow,
} from './service.js';
import { decryptProviderSecret } from './providers-service.js';
import { hostAndPathMatch } from '../ingress-routes/traefik-types.js';
import type { Database } from '../../db/index.js';
import type { IngressAuthConfig, IngressClaimRule } from '../../db/schema.js';

const PROXY_NAME = 'oauth2-proxy';
const PROXY_PORT = 4180;
const VALIDATOR_PORT = 4181;
const CONFIGMAP_NAME = 'oauth2-proxy-config';
const SECRET_NAME = 'oauth2-proxy-secrets';

// Sibling Ingress that exposes /oauth2/* without the auth_request gate.
// Required because the tenant Ingress carries `auth-url`/`auth-signin`
// annotations that gate every path on the host — including the
// /oauth2/start redirect target itself, which would otherwise loop.
// NGINX Ingress merges Ingresses by host into separate location blocks,
// each inheriting its OWN Ingress's annotations, so the path=/oauth2
// rule on this passthrough Ingress is not gated by auth_request.
const PASSTHROUGH_INGRESS_NAME = 'oauth2-proxy-passthrough';

// Image tags. The claim-validator image is built+pushed by the GHA
// workflow at .github/workflows/ci-claim-validator.yml. The
// oauth2-proxy image is the upstream community release used elsewhere
// in this codebase for the platform-side admin gate.
const OAUTH2_PROXY_IMAGE = process.env.OAUTH2_PROXY_IMAGE
  ?? 'quay.io/oauth2-proxy/oauth2-proxy:v7.6.0';
const CLAIM_VALIDATOR_IMAGE = process.env.CLAIM_VALIDATOR_IMAGE
  ?? 'ghcr.io/phoenixtechnam/hosting-platform/claim-validator:latest';

export interface IngressAuthTenants {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
  readonly networking: k8s.NetworkingV1Api;
  readonly custom: k8s.CustomObjectsApi;
}

export interface ReconcileDeps {
  readonly db: Database;
  readonly k8s: IngressAuthTenants;
  readonly encryptionKey: string;
}

/**
 * Top-level entry point: reconcile a single tenant's oauth2-proxy
 * resources to match the current set of enabled ingress_auth_configs.
 *
 * Returns an outcome that the caller can log / surface in lastError
 * back to the UI. Never throws — all errors are captured into the
 * outcome.
 */
export interface ReconcileOutcome {
  readonly tenantId: string;
  readonly namespace: string;
  readonly action: 'provisioned' | 'updated' | 'torn_down' | 'noop';
  readonly enabledIngresses: number;
  readonly error: string | null;
}

export async function reconcileTenant(
  deps: ReconcileDeps,
  tenantId: string,
): Promise<ReconcileOutcome> {
  const namespace = await getTenantNamespace(deps.db, tenantId);
  if (!namespace) {
    return {
      tenantId,
      namespace: '',
      action: 'noop',
      enabledIngresses: 0,
      error: 'tenant not found',
    };
  }

  const enabled = await listEnabledForTenantJoined(deps.db, tenantId);
  try {
    if (enabled.length === 0) {
      const wasProvisioned = await tearDownTenantProxy(deps, tenantId, namespace);
      return {
        tenantId,
        namespace,
        action: wasProvisioned ? 'torn_down' : 'noop',
        enabledIngresses: 0,
        error: null,
      };
    }
    const action = await ensureTenantProxy(deps, tenantId, namespace, enabled);
    return {
      tenantId,
      namespace,
      action,
      enabledIngresses: enabled.length,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStateError(deps.db, tenantId, msg);
    return {
      tenantId,
      namespace,
      action: 'noop',
      enabledIngresses: enabled.length,
      error: msg,
    };
  }
}

// Backward-compat re-export for callers that only need the list.
export { listEnabledForTenantJoined as listEnabledForTenant };

async function getTenantNamespace(
  db: Database,
  tenantId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row?.ns ?? null;
}

async function markStateError(
  db: Database,
  tenantId: string,
  error: string,
): Promise<void> {
  await db
    .update(tenantOauth2ProxyState)
    .set({ lastError: error })
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
}

/** Build the single oauth2_proxy.cfg ConfigMap key from the enabled
 *  ingress set. oauth2-proxy supports multiple --upstream lines and
 *  one set of OIDC settings per process; for a per-CLIENT proxy we
 *  serve all of that client's ingresses with the SAME OIDC config
 *  (the FIRST enabled ingress's row).
 *
 *  This is a pragmatic constraint of the per-tenant architecture —
 *  if a client wants different OIDC providers per ingress, they can
 *  request a per-ingress proxy in v2. Documented in the contract
 *  doc so the UI can show a warning when a second ingress under the
 *  same tenant uses a different issuer URL.
 */
function buildOauth2ProxyConfig(
  primary: EnabledIngressAuthRow,
  cookieSecret: string,
  clientSecret: string,
): string {
  // oauth2-proxy reads TOML. Booleans MUST be unquoted, strings MUST
  // be quoted. Durations are strings (`"3600s"`).
  const { cfg, provider, hostname } = primary;
  const lines: string[] = [];
  // Strip trailing slash from issuer URL — many IdPs (Zitadel,
  // Keycloak) return the bare hostname without a trailing slash in
  // discovery, and oauth2-proxy refuses to start on mismatch.
  const normalisedIssuer = provider.issuerUrl.replace(/\/+$/, '');
  lines.push(`provider="oidc"`);
  lines.push(`oidc_issuer_url="${normalisedIssuer}"`);
  lines.push(`client_id="${provider.oauthClientId}"`);
  lines.push(`client_secret="${clientSecret}"`);
  if (provider.usePkce) {
    lines.push(`code_challenge_method="S256"`);
  }
  // Scopes: ingress override wins; fall back to provider's default.
  const scopes = cfg.scopesOverride ?? provider.defaultScopes;
  lines.push(`scope="${scopes}"`);
  lines.push(`cookie_secret="${cookieSecret}"`);
  lines.push(`cookie_secure=true`);
  lines.push(`cookie_httponly=true`);
  lines.push(`cookie_samesite="lax"`);
  lines.push(`cookie_expire="${cfg.cookieExpireSeconds}s"`);
  lines.push(`cookie_refresh="${cfg.cookieRefreshSeconds}s"`);
  if (cfg.cookieDomain) {
    lines.push(`cookie_domains=["${cfg.cookieDomain}"]`);
  }
  lines.push(`pass_authorization_header=${cfg.passAuthorizationHeader}`);
  lines.push(`pass_access_token=${cfg.passAccessToken}`);
  lines.push(`set_authorization_header=${cfg.passAuthorizationHeader}`);
  lines.push(`set_xauthrequest=${cfg.setXauthrequest}`);
  lines.push(`pass_user_headers=${cfg.passUserHeaders}`);
  lines.push(`reverse_proxy=true`);
  lines.push(`whitelist_domains=["${hostname}"]`);
  lines.push(`email_domains=["*"]`);
  return lines.join('\n') + '\n';
}

function buildClaimRulesJson(
  configs: ReadonlyArray<EnabledIngressAuthRow>,
): string {
  const out: Record<string, ReadonlyArray<IngressClaimRule>> = {};
  for (const { cfg } of configs) {
    if (cfg.claimRules && cfg.claimRules.length > 0) {
      out[cfg.id] = cfg.claimRules;
    }
  }
  return JSON.stringify(out, null, 2);
}

/**
 * True when at least one enabled auth config under the tenant has a
 * non-empty claimRules array. Drives whether the claim-validator
 * sidecar is deployed: when false, the sidecar is omitted from the
 * Deployment and the auth-url annotation bypasses it (points at
 * oauth2-proxy:4180/oauth2/auth directly). See annotation-sync.ts.
 */
export function tenantNeedsClaimValidator(
  configs: ReadonlyArray<EnabledIngressAuthRow>,
): boolean {
  return configs.some(({ cfg }) => cfg.claimRules && cfg.claimRules.length > 0);
}

async function ensureTenantProxy(
  deps: ReconcileDeps,
  tenantId: string,
  namespace: string,
  enabled: ReadonlyArray<EnabledIngressAuthRow>,
): Promise<'provisioned' | 'updated'> {
  const cookieSecret = await getOrCreateTenantCookieSecret(
    deps.db,
    deps.encryptionKey,
    tenantId,
  );
  const primary = enabled[0]!;
  const clientSecret = decryptProviderSecret(primary.provider, deps.encryptionKey);
  const oauth2ProxyCfg = buildOauth2ProxyConfig(primary, cookieSecret, clientSecret);
  const needsValidator = tenantNeedsClaimValidator(enabled);
  const claimRulesJson = buildClaimRulesJson(enabled);

  // ConfigMap — always carries oauth2_proxy.cfg. rules.json is only
  // included when the claim-validator sidecar is deployed; when no
  // route has claim rules we skip both the sidecar AND the rules.json
  // key so the ConfigMap reflects what's actually mounted.
  const configMapData: Record<string, string> = { 'oauth2_proxy.cfg': oauth2ProxyCfg };
  if (needsValidator) {
    configMapData['rules.json'] = claimRulesJson;
  }
  await upsertConfigMap(deps.k8s.core, namespace, configMapData);

  // Secret — currently empty (config inlines secrets via ConfigMap
  // for v1). When we add Secret-volume mounting in v2 we'll move
  // client_secret + cookie_secret here for K8s-side encryption-at-rest.
  await upsertSecret(deps.k8s.core, namespace);

  // NetworkPolicy — limit oauth2-proxy egress to OIDC issuer host +
  // intra-namespace upstreams. Permissive in v1 (no policy); add in v2.

  // Service — exposes :4180 (oauth2-proxy) always; :4181 (validator)
  // only when the claim-validator sidecar is present.
  await upsertService(deps.k8s.core, namespace, needsValidator);

  // Deployment — main container oauth2-proxy; claim-validator sidecar
  // is added only when at least one route has claim rules.
  const wasNew = await upsertDeployment(deps.k8s.apps, namespace, needsValidator);

  // Passthrough Ingress — exposes /oauth2/* on every protected host
  // without the auth_request gate, breaking the redirect loop where
  // /oauth2/start would otherwise be gated by oauth2-proxy itself.
  const hostnames = Array.from(new Set(enabled.map((e) => e.hostname)));
  await upsertPassthroughIngress(deps.k8s.custom, namespace, hostnames);

  // Mark provisioned in DB.
  await deps.db
    .update(tenantOauth2ProxyState)
    .set({ provisioned: true, lastProvisionedAt: new Date(), lastError: null })
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));

  // Update last_reconciled_at on every config row so the UI shows a
  // recent timestamp even when nothing about the row changed.
  for (const { cfg } of enabled) {
    // eslint-disable-next-line no-await-in-loop
    await deps.db
      .update(ingressAuthConfigs)
      .set({ lastReconciledAt: new Date(), lastError: null })
      .where(eq(ingressAuthConfigs.id, cfg.id));
  }

  return wasNew ? 'provisioned' : 'updated';
}

async function tearDownTenantProxy(
  deps: ReconcileDeps,
  tenantId: string,
  namespace: string,
): Promise<boolean> {
  const [state] = await deps.db
    .select()
    .from(tenantOauth2ProxyState)
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));
  if (!state?.provisioned) return false;

  await deleteAuthIngressRoute(deps.k8s.custom, namespace, PASSTHROUGH_INGRESS_NAME);
  await deleteIfExists(() =>
    deps.k8s.apps.deleteNamespacedDeployment({
      name: PROXY_NAME,
      namespace,
    } as unknown as Parameters<typeof deps.k8s.apps.deleteNamespacedDeployment>[0]),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedService({
      name: PROXY_NAME,
      namespace,
    } as unknown as Parameters<typeof deps.k8s.core.deleteNamespacedService>[0]),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace,
    } as unknown as Parameters<typeof deps.k8s.core.deleteNamespacedConfigMap>[0]),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedSecret({
      name: SECRET_NAME,
      namespace,
    } as unknown as Parameters<typeof deps.k8s.core.deleteNamespacedSecret>[0]),
  );

  await deps.db
    .update(tenantOauth2ProxyState)
    .set({ provisioned: false, lastError: null })
    .where(eq(tenantOauth2ProxyState.tenantId, tenantId));

  return true;
}

// ─── K8s helpers (idempotent upsert + 404-tolerant delete) ──────────────────

async function upsertConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  data: Record<string, string>,
): Promise<void> {
  const body: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: CONFIGMAP_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'oauth2-proxy',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    data,
  };
  try {
    await core.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedConfigMap({ namespace, body } as never);
  }
}

async function upsertSecret(core: k8s.CoreV1Api, namespace: string): Promise<void> {
  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: SECRET_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'oauth2-proxy',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    type: 'Opaque',
    stringData: {
      // Reserved for v2 — Secret-volume mount of client_secret +
      // cookie_secret. v1 inlines them in oauth2_proxy.cfg via the
      // ConfigMap (acceptable because the ConfigMap is namespace-
      // scoped and access is restricted by RBAC).
      placeholder: 'reserved',
    },
  };
  try {
    await core.replaceNamespacedSecret({ name: SECRET_NAME, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // backup-coverage: excluded:reconciler-rebuilds-from-config-tables
    // (ingress-auth Secret holds session/cookie keys generated from
    // protected_directories DB rows. config-tables component captures
    // those rows; reconciler regenerates the Secret on restore.)
    await core.createNamespacedSecret({ namespace, body } as never);
  }
}

async function upsertService(
  core: k8s.CoreV1Api,
  namespace: string,
  withValidatorPort: boolean,
): Promise<void> {
  const ports: k8s.V1ServicePort[] = [
    { name: 'proxy', port: PROXY_PORT, targetPort: PROXY_PORT, protocol: 'TCP' },
  ];
  if (withValidatorPort) {
    ports.push({ name: 'validator', port: VALIDATOR_PORT, targetPort: VALIDATOR_PORT, protocol: 'TCP' });
  }
  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: PROXY_NAME,
      namespace,
      labels: { 'app.kubernetes.io/name': 'oauth2-proxy' },
    },
    spec: {
      selector: { 'app.kubernetes.io/name': 'oauth2-proxy' },
      ports,
    },
  };
  try {
    // Service replace requires preserving clusterIP — fall back to read+set
    // to avoid 422 ("clusterIP is immutable"). On 404 we create fresh.
    const existing = await core.readNamespacedService({ name: PROXY_NAME, namespace } as never);
    body.spec!.clusterIP = existing.spec?.clusterIP;
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await core.replaceNamespacedService({ name: PROXY_NAME, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({ namespace, body } as never);
  }
}

async function upsertDeployment(
  apps: k8s.AppsV1Api,
  namespace: string,
  withClaimValidator: boolean,
): Promise<boolean> {
  const oauth2ProxyContainer: k8s.V1Container = {
    name: 'oauth2-proxy',
    image: OAUTH2_PROXY_IMAGE,
    args: ['--config=/etc/oauth2-proxy/oauth2_proxy.cfg', `--http-address=0.0.0.0:${PROXY_PORT}`],
    ports: [{ containerPort: PROXY_PORT, name: 'proxy' }],
    volumeMounts: [
      {
        name: 'config',
        mountPath: '/etc/oauth2-proxy/oauth2_proxy.cfg',
        subPath: 'oauth2_proxy.cfg',
        readOnly: true,
      },
    ],
    resources: {
      requests: { cpu: '10m', memory: '32Mi' },
      limits: { cpu: '100m', memory: '128Mi' },
    },
    livenessProbe: { httpGet: { path: '/ping', port: PROXY_PORT } },
    readinessProbe: { httpGet: { path: '/ping', port: PROXY_PORT } },
  };
  const claimValidatorContainer: k8s.V1Container = {
    name: 'claim-validator',
    image: CLAIM_VALIDATOR_IMAGE,
    env: [
      { name: 'PORT', value: String(VALIDATOR_PORT) },
      { name: 'OAUTH2_PROXY_HOST', value: '127.0.0.1' },
      { name: 'OAUTH2_PROXY_PORT', value: String(PROXY_PORT) },
      { name: 'RULES_PATH', value: '/etc/claim-rules/rules.json' },
    ],
    ports: [{ containerPort: VALIDATOR_PORT, name: 'validator' }],
    volumeMounts: [
      {
        name: 'config',
        mountPath: '/etc/claim-rules/rules.json',
        subPath: 'rules.json',
        readOnly: true,
      },
    ],
    resources: {
      requests: { cpu: '5m', memory: '16Mi' },
      limits: { cpu: '50m', memory: '64Mi' },
    },
    livenessProbe: { httpGet: { path: '/ping', port: VALIDATOR_PORT } },
    readinessProbe: { httpGet: { path: '/ping', port: VALIDATOR_PORT } },
  };
  const containers: k8s.V1Container[] = withClaimValidator
    ? [oauth2ProxyContainer, claimValidatorContainer]
    : [oauth2ProxyContainer];
  const body: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: PROXY_NAME,
      namespace,
      labels: { 'app.kubernetes.io/name': 'oauth2-proxy' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'oauth2-proxy' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'oauth2-proxy' } },
        spec: {
          // oauth2-proxy mounts the ConfigMap's `oauth2_proxy.cfg`
          // subPath; the claim-validator sidecar (when present) mounts
          // `rules.json` from the same ConfigMap.
          volumes: [
            {
              name: 'config',
              configMap: { name: CONFIGMAP_NAME },
            },
          ],
          containers,
        },
      },
    },
  };
  try {
    const existing = await apps.readNamespacedDeployment({ name: PROXY_NAME, namespace } as never);
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await apps.replaceNamespacedDeployment({ name: PROXY_NAME, namespace, body } as never);
    return false; // existed
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await apps.createNamespacedDeployment({ namespace, body } as never);
    return true;
  }
}

/**
 * Build/update the sibling IngressRoute that exposes `/oauth2/*` without
 * the per-route OIDC ForwardAuth Middleware. The main tenant IngressRoute
 * (built by domains/k8s-ingress.ts) attaches a ForwardAuth Middleware
 * to every route, which gates `/anything` behind oauth2-proxy. That
 * same gate would 302-loop on `/oauth2/start` (oauth2-proxy's own
 * redirect-to-IdP endpoint), so we carve `/oauth2/*` out into a
 * higher-priority companion IngressRoute that routes straight to
 * oauth2-proxy WITHOUT the auth Middleware.
 *
 * TLS: not declared here. Traefik's TLSStore is keyed by SNI hostname;
 * any IngressRoute for the same host that DOES carry tls.secretName
 * loads the cert into the store and this IngressRoute serves on the
 * same EntryPoint with the same cert via SNI matching.
 */
async function upsertPassthroughIngress(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  hostnames: ReadonlyArray<string>,
): Promise<void> {
  if (hostnames.length === 0) {
    // Nothing to gate → nothing to passthrough. Best-effort delete.
    await deleteAuthIngressRoute(custom, namespace, PASSTHROUGH_INGRESS_NAME);
    return;
  }

  // hostAndPathMatch runs the hostname through encodeMatchLiteral —
  // a backtick in `host` (which Traefik uses as the match-rule
  // delimiter) would let an attacker break out of the literal and
  // inject arbitrary match-rule fragments. DB hostname validation
  // already rejects backticks today, but defence-in-depth keeps the
  // guard local to the match-rule builder so any future validation
  // gap doesn't reach Traefik.
  const routes = hostnames.map((host) => ({
    match: hostAndPathMatch(host, '/oauth2'),
    kind: 'Rule' as const,
    priority: 100,
    services: [{ name: PROXY_NAME, port: PROXY_PORT }],
  }));

  const body = {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: {
      name: PASSTHROUGH_INGRESS_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': 'oauth2-proxy',
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      entryPoints: ['websecure'],
      routes,
    },
  };

  await applyAuthIngressRoute(custom, body);
}

async function applyAuthIngressRoute(
  custom: k8s.CustomObjectsApi,
  body: Record<string, unknown>,
): Promise<void> {
  const { applyIngressRoute } = await import('../ingress-routes/traefik-apply.js');
  // applyIngressRoute expects the proper IngressRouteBody shape; cast
  // here to keep the local body free of structural-type churn.
  await applyIngressRoute(custom, body as unknown as Parameters<typeof applyIngressRoute>[1]);
}

async function deleteAuthIngressRoute(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<void> {
  const { deleteIngressRoute } = await import('../ingress-routes/traefik-apply.js');
  await deleteIngressRoute(custom, namespace, name);
}

async function deleteIfExists(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; code?: number; message?: string };
  if (e.statusCode === 404 || e.code === 404) return true;
  if (typeof e.message === 'string' && /HTTP-Code:\s*404/.test(e.message)) return true;
  return false;
}
