/**
 * Per-client K8s materialisation for private workers.
 *
 * Reference-counted on `private_workers` rows: a frps Deployment is
 * provisioned in the client namespace as soon as the client has at
 * least one `active` or `pending` worker, and torn down when the last
 * one leaves the active set.
 *
 * In `platform-system`:
 *   - Per-client Ingress `tunnel-<slug>` for each active slug, hosting
 *     `tunnels.${PLATFORM_BASE_DOMAIN}/c/<slug>(/|$)(.*)` and pointing
 *     at the per-client ExternalName Service.
 *   - Per-client ExternalName Service `tunnel-<slug>` pointing at the
 *     in-namespace frps Service.
 *
 * In the client namespace:
 *   - ConfigMap `private-worker-server-config` (frps.toml).
 *   - Service `pw-<workerId>` (ClusterIP, one per active worker).
 *   - Deployment `private-worker-server` (1 replica, frps).
 *   - NetworkPolicy `private-worker-server-policy` allowing ingress
 *     from the nginx-ingress namespace and DNS egress only.
 *
 * Idempotent. Errors per step are caught + collected; the function
 * always returns a `ReconcileOutcome` rather than throwing so the
 * caller (HTTP route or scheduler tick) gets a consistent envelope.
 */

import * as k8s from '@kubernetes/client-node';
import { and, eq, inArray } from 'drizzle-orm';
import { clients, privateWorkers, type PrivateWorker } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const FRPS_DEPLOYMENT_NAME = 'private-worker-server';
const FRPS_CONFIGMAP_NAME = 'private-worker-server-config';
const FRPS_NETPOL_NAME = 'private-worker-server-policy';
const FRPS_SECRET_NAME = 'private-worker-tokens';
const PLATFORM_SYSTEM_NAMESPACE = 'platform-system';
// The NGINX-ingress controller's namespace is `ingress-nginx` per the
// upstream Helm chart default. Operators with a different deployment
// can override via env (deferred — overlays + bootstrap pin this).
const NGINX_INGRESS_NAMESPACE =
  process.env.NGINX_INGRESS_NAMESPACE ?? 'ingress-nginx';
const FRPS_BIND_PORT = 7000;
const FRPS_IMAGE = process.env.PRIVATE_WORKER_FRPS_IMAGE ?? 'fatedier/frps:v0.62.1';

// ─── Public surface ─────────────────────────────────────────────────────────

export interface ReconcileDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
}

export interface ReconcileOutcome {
  readonly clientId: string;
  readonly action: 'apply' | 'noop' | 'teardown';
  readonly workerCount: number;
  readonly error: string | null;
}

export async function reconcilePrivateWorkersForClient(
  deps: ReconcileDeps,
  clientId: string,
): Promise<ReconcileOutcome> {
  const namespace = await getClientNamespace(deps.db, clientId);
  if (!namespace) {
    return {
      clientId,
      action: 'noop',
      workerCount: 0,
      error: 'client not found or has no namespace',
    };
  }

  // Active set: rows that should have cluster artefacts. Suspended +
  // revoked rows are deliberately excluded so the lifecycle hook's
  // `update status=suspended` causes the next reconcile to drop them.
  const activeWorkers = await deps.db
    .select()
    .from(privateWorkers)
    .where(
      and(
        eq(privateWorkers.clientId, clientId),
        inArray(privateWorkers.status, ['active', 'pending']),
      ),
    );

  if (activeWorkers.length === 0) {
    const err = await tearDown(deps, clientId, namespace);
    return {
      clientId,
      action: 'teardown',
      workerCount: 0,
      error: err,
    };
  }

  const err = await apply(deps, namespace, activeWorkers);
  return {
    clientId,
    action: 'apply',
    workerCount: activeWorkers.length,
    error: err,
  };
}

// ─── Apply path ─────────────────────────────────────────────────────────────

async function apply(
  deps: ReconcileDeps,
  namespace: string,
  workers: ReadonlyArray<PrivateWorker>,
): Promise<string | null> {
  const errors: string[] = [];

  // 0. Fetch the per-client shared auth token. frps requires this to
  //    authenticate frpc connections. The token must already exist in
  //    the DB (createPrivateWorker mints it on first worker create).
  //    If somehow missing, refuse to render — better to fail closed
  //    than render an unauthenticated frps.
  const clientId = workers[0].clientId;
  const sharedSecret = await loadClientSharedSecret(deps.db, clientId);
  if (!sharedSecret) {
    return 'private-worker shared secret missing on clients row; refusing to render unauthenticated frps';
  }
  const allowedPorts = workers.map((w) => w.exposedPort);

  // 1. ConfigMap — frps.toml with auth.token + allowPorts. The home
  //    agent's frpc dynamically registers proxies over the control
  //    connection but only on ports listed here, so revoked workers'
  //    ports vanish from the allowlist on the next tick.
  await safe(
    errors,
    'configmap',
    () => upsertFrpsConfigMap(deps.k8s.core, namespace, sharedSecret, allowedPorts),
  );

  // 2a. frps control-plane Service (`private-worker-server`). The
  //     `tunnel-<slug>` ExternalName Service in platform-system points
  //     at this Service via DNS — that's how the WSS dial-in lands on
  //     the frps pod. Without this Service, NGINX-ingress sees an
  //     unresolvable ExternalName and returns 503.
  await safe(
    errors,
    'service:frps-control',
    () =>
      upsertControlPlaneService(deps.k8s.core, namespace),
  );

  // 2b. Per-worker Service pw-<workerId>. Each one points at the frps
  //     pod and exposes the proxy's remote port. Tenant ingress targets
  //     these Services like any other in-namespace deployment.
  for (const w of workers) {

    await safe(
      errors,
      `service:${w.id}`,
      () =>
        upsertPerWorkerService(
          deps.k8s.core,
          namespace,
          `pw-${w.id}`,
          w.exposedPort,
        ),
    );
  }

  // 3. frps Deployment. 1 replica per client.
  await safe(
    errors,
    'frps-deployment',
    () => upsertFrpsDeployment(deps.k8s.apps, namespace),
  );

  // 4. NetworkPolicy. Allow ingress from the nginx-ingress namespace
  //    (and the same namespace, so the per-worker Services can reach
  //    the pod). Egress is restricted to kube-DNS — frps doesn't make
  //    outbound calls.
  await safe(
    errors,
    'networkpolicy',
    () => upsertFrpsNetworkPolicy(deps.k8s.networking, namespace),
  );

  // 5. Per-client ExternalName Service in platform-system, pointing
  //    at the frps Service in the client namespace. Used by the per-
  //    client tunnel Ingress.
  for (const w of workers) {
     
    await safe(
      errors,
      `externalname:${w.slug}`,
      () => upsertExternalNameService(deps.k8s.core, w.slug, namespace),
    );
     
    await safe(
      errors,
      `tunnel-ingress:${w.slug}`,
      () => upsertTunnelIngress(deps.k8s.networking, w.slug, namespace),
    );
  }

  // 6. Reap stale tunnel-* Ingresses + ExternalName Services in
  //    platform-system that no longer correspond to an active slug.
  //    We can't scope the listing to a per-client label cleanly
  //    because the slugs are global, so reap by client-namespace
  //    label injected by upsertTunnelIngress.
  await safe(
    errors,
    'reap-stale-tunnels',
    () =>
      reapStaleTunnels(
        deps.k8s.core,
        deps.k8s.networking,
        namespace,
        new Set(workers.map((w) => w.slug)),
      ),
  );

  // 7. Reap stale per-worker Services in the client namespace.
  await safe(
    errors,
    'reap-stale-pw-services',
    () =>
      reapStalePerWorkerServices(
        deps.k8s.core,
        namespace,
        new Set(workers.map((w) => `pw-${w.id}`)),
      ),
  );

  return errors.length === 0 ? null : errors.join('; ');
}

// ─── Teardown path ──────────────────────────────────────────────────────────

async function tearDown(
  deps: ReconcileDeps,
  clientId: string,
  namespace: string,
): Promise<string | null> {
  const errors: string[] = [];

  // Drop the per-client tunnels in platform-system first so external
  // traffic stops flowing before the in-namespace targets disappear.
  await safe(errors, 'reap-tunnels-all', () =>
    reapStaleTunnels(
      deps.k8s.core,
      deps.k8s.networking,
      namespace,
      new Set(), // empty active set => delete all this client's tunnels
    ),
  );

  await safe(errors, 'reap-pw-services-all', () =>
    reapStalePerWorkerServices(deps.k8s.core, namespace, new Set()),
  );

  await safe(errors, 'frps-deployment', () =>
    deleteIfExists(() =>
      deps.k8s.apps.deleteNamespacedDeployment({
        name: FRPS_DEPLOYMENT_NAME,
        namespace,
      } as never),
    ),
  );

  await safe(errors, 'frps-configmap', () =>
    deleteIfExists(() =>
      deps.k8s.core.deleteNamespacedConfigMap({
        name: FRPS_CONFIGMAP_NAME,
        namespace,
      } as never),
    ),
  );

  await safe(errors, 'frps-secret', () =>
    deleteIfExists(() =>
      deps.k8s.core.deleteNamespacedSecret({
        name: FRPS_SECRET_NAME,
        namespace,
      } as never),
    ),
  );

  await safe(errors, 'frps-netpol', () =>
    deleteIfExists(() =>
      deps.k8s.networking.deleteNamespacedNetworkPolicy({
        name: FRPS_NETPOL_NAME,
        namespace,
      } as never),
    ),
  );

  // clientId is not used in the teardown body but kept in the
  // signature for symmetry with apply(). Avoids "unused parameter"
  // friction if a future change wants to log/audit on this path.
  void clientId;

  return errors.length === 0 ? null : errors.join('; ');
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function getClientNamespace(
  db: Database,
  clientId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ ns: clients.kubernetesNamespace })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row?.ns ?? null;
}

async function loadClientSharedSecret(
  db: Database,
  clientId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ secret: clients.privateWorkerSharedSecret })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row?.secret ?? null;
}

// ─── K8s upserts ────────────────────────────────────────────────────────────

async function upsertFrpsConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  authToken: string,
  allowedPorts: ReadonlyArray<number>,
): Promise<void> {
  // frps config — token-authed + port-restricted.
  //
  //   auth.token        — per-client shared secret (clients.private_worker_shared_secret).
  //                       Without this, frps 0.62 accepts any frpc with no token,
  //                       which is a complete tunnel auth bypass.
  //   allowPorts        — only the ports of currently-active workers. Revoked
  //                       workers' ports drop out, so their frpc registrations
  //                       are rejected — that's how per-worker revocation
  //                       takes effect within the next reconcile tick.
  //
  // TLS terminates at NGINX-ingress; this WebSocket leg is plaintext between
  // NGINX and the frps pod inside the cluster.
  const allowPortsTable = allowedPorts.length === 0
    ? '# No active workers — placeholder allowPorts entry blocks all proxies.'
    : allowedPorts
      .map((p) => `[[allowPorts]]\nstart = ${p}\nend = ${p}`)
      .join('\n');

  const frpsToml = [
    '# Managed by platform-api private-worker reconciler.',
    'bindAddr = "0.0.0.0"',
    `bindPort = ${FRPS_BIND_PORT}`,
    'transport.tls.force = false',
    '',
    '# Control + data over the same WebSocket connection.',
    '# vhostHTTPPort is unset — we proxy raw TCP per worker.',
    '',
    '# Token authentication — shared per-client secret.',
    'auth.method = "token"',
    `auth.token = "${authToken.replace(/"/g, '\\"')}"`,
    '',
    '# Port allowlist — ONLY active workers are accepted.',
    allowPortsTable,
    '',
  ].join('\n');

  const body: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: FRPS_CONFIGMAP_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME,
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    data: { 'frps.toml': frpsToml },
  };

  try {
    await core.replaceNamespacedConfigMap({
      name: FRPS_CONFIGMAP_NAME,
      namespace,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedConfigMap({ namespace, body } as never);
  }
}

async function upsertControlPlaneService(
  core: k8s.CoreV1Api,
  namespace: string,
): Promise<void> {
  // Stable Service for the frps control plane. The
  // platform-system/tunnel-<slug> ExternalName resolves to this
  // Service name; NGINX-ingress proxies the WSS Upgrade to it.
  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME,
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      selector: { 'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME },
      ports: [
        {
          name: 'control',
          port: FRPS_BIND_PORT,
          targetPort: FRPS_BIND_PORT,
          protocol: 'TCP',
        },
      ],
    },
  };

  try {
    const existing = await core.readNamespacedService({
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
    } as never);
    body.spec!.clusterIP = (existing as k8s.V1Service).spec?.clusterIP;
    body.metadata!.resourceVersion = (existing as k8s.V1Service).metadata?.resourceVersion;
    await core.replaceNamespacedService({
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({ namespace, body } as never);
  }
}

async function upsertPerWorkerService(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
  exposedPort: number,
): Promise<void> {
  // Per-worker Service. Tenant ingress targets `<name>:<exposedPort>`
  // which forwards to the frps pod's `targetPort` (also exposedPort).
  // frps will be listening on that port because the home agent's frpc
  // registered a tcp proxy with that remote_port.
  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/name': name,
        'app.kubernetes.io/component': 'private-worker',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.phoenix-host.net/private-worker-service': 'true',
      },
    },
    spec: {
      selector: { 'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME },
      ports: [
        {
          name: 'tcp',
          port: exposedPort,
          targetPort: exposedPort,
          protocol: 'TCP',
        },
      ],
    },
  };

  try {
    const existing = await core.readNamespacedService({ name, namespace } as never);
    body.spec!.clusterIP = (existing as k8s.V1Service).spec?.clusterIP;
    body.metadata!.resourceVersion = (existing as k8s.V1Service).metadata?.resourceVersion;
    await core.replaceNamespacedService({ name, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({ namespace, body } as never);
  }
}

async function upsertFrpsDeployment(
  apps: k8s.AppsV1Api,
  namespace: string,
): Promise<void> {
  const body: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME,
        'app.kubernetes.io/managed-by': 'platform-api',
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME } },
      template: {
        metadata: {
          labels: { 'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME },
        },
        spec: {
          volumes: [
            {
              name: 'config',
              configMap: { name: FRPS_CONFIGMAP_NAME },
            },
          ],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
          },
          containers: [
            {
              name: 'frps',
              image: FRPS_IMAGE,
              command: ['/usr/bin/frps', '-c', '/etc/frp/frps.toml'],
              ports: [
                { name: 'control', containerPort: FRPS_BIND_PORT, protocol: 'TCP' },
              ],
              volumeMounts: [
                { name: 'config', mountPath: '/etc/frp', readOnly: true },
              ],
              resources: {
                requests: { cpu: '25m', memory: '24Mi' },
                limits: { cpu: '200m', memory: '128Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  };

  try {
    const existing = await apps.readNamespacedDeployment({
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
    } as never);
    body.metadata!.resourceVersion = (existing as k8s.V1Deployment).metadata?.resourceVersion;
    await apps.replaceNamespacedDeployment({
      name: FRPS_DEPLOYMENT_NAME,
      namespace,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await apps.createNamespacedDeployment({ namespace, body } as never);
  }
}

async function upsertFrpsNetworkPolicy(
  networking: k8s.NetworkingV1Api,
  namespace: string,
): Promise<void> {
  const body: k8s.V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: FRPS_NETPOL_NAME,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'platform-api',
        'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME,
      },
    },
    spec: {
      podSelector: { matchLabels: { 'app.kubernetes.io/name': FRPS_DEPLOYMENT_NAME } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        {
          _from: [
            // NGINX ingress controllers — they dial in via the
            // tunnel-<slug> Ingress in platform-system.
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': NGINX_INGRESS_NAMESPACE },
              },
            },
            // Same-namespace pods (the per-worker pw-<id> Services
            // route through the kube-proxy, which uses the source
            // pod's identity, so other pods in the tenant can reach
            // private workers if they need to — same as any other
            // in-namespace Service).
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': namespace },
              },
            },
          ],
        },
      ],
      egress: [
        // kube-DNS only. frps doesn't make outbound calls; this is
        // pure defense in depth.
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
              },
              podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
            },
          ],
          ports: [
            { protocol: 'UDP', port: 53 },
            { protocol: 'TCP', port: 53 },
          ],
        },
      ],
    },
  };

  try {
    const existing = await networking.readNamespacedNetworkPolicy({
      name: FRPS_NETPOL_NAME,
      namespace,
    } as never);
    body.metadata!.resourceVersion = (existing as k8s.V1NetworkPolicy).metadata?.resourceVersion;
    await networking.replaceNamespacedNetworkPolicy({
      name: FRPS_NETPOL_NAME,
      namespace,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await networking.createNamespacedNetworkPolicy({ namespace, body } as never);
  }
}

async function upsertExternalNameService(
  core: k8s.CoreV1Api,
  slug: string,
  clientNamespace: string,
): Promise<void> {
  const name = `tunnel-${slug}`;
  const externalName = `${FRPS_DEPLOYMENT_NAME}.${clientNamespace}.svc.cluster.local`;

  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.phoenix-host.net/private-worker-tunnel': 'true',
        'platform.phoenix-host.net/client-namespace': clientNamespace,
      },
    },
    spec: {
      type: 'ExternalName',
      externalName,
      ports: [
        { name: 'control', port: FRPS_BIND_PORT, targetPort: FRPS_BIND_PORT, protocol: 'TCP' },
      ],
    },
  };

  try {
    const existing = await core.readNamespacedService({
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
    } as never);
    body.metadata!.resourceVersion = (existing as k8s.V1Service).metadata?.resourceVersion;
    await core.replaceNamespacedService({
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      body,
    } as never);
  }
}

async function upsertTunnelIngress(
  networking: k8s.NetworkingV1Api,
  slug: string,
  clientNamespace: string,
): Promise<void> {
  const name = `tunnel-${slug}`;
  const platformDomain = resolvePlatformDomain();
  // Per-worker subdomain `<slug>.tunnels.${DOMAIN}`. frp v0.62 hardcodes
  // its WSS path to `/~!frp` so we cannot route by URL path — every
  // worker needs a distinct hostname. cert-manager issues a per-FQDN
  // HTTP-01 cert (no DNS-API requirement).
  const tunnelHost = `${slug}.tunnels.${platformDomain}`;
  const tlsSecret = `${name}-tls`;

  const body: k8s.V1Ingress = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.phoenix-host.net/private-worker-tunnel': 'true',
        // CRITICAL: client-namespace scope — reapStaleTunnels filters by
        // this label so one client's teardown can never delete another
        // client's live Ingresses.
        'platform.phoenix-host.net/client-namespace': clientNamespace,
      },
      annotations: {
        // cert-manager issues a per-FQDN HTTP-01 cert. The default
        // ClusterIssuer matches what tenant ingresses use.
        'cert-manager.io/cluster-issuer': 'letsencrypt-prod-http01',
        // WebSocket Upgrade headers are forwarded automatically by
        // NGINX-ingress when the client requests them and the backend
        // speaks HTTP/1.1.
        'nginx.ingress.kubernetes.io/proxy-http-version': '1.1',
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
        // Rate-limit failed handshakes per source IP. frps rejects
        // bad-token connections quickly so this caps brute-force
        // throughput against the auth.token at ~5 attempts/sec/IP.
        'nginx.ingress.kubernetes.io/limit-rps': '5',
        'nginx.ingress.kubernetes.io/limit-connections': '5',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [
        {
          hosts: [tunnelHost],
          secretName: tlsSecret,
        },
      ],
      rules: [
        {
          host: tunnelHost,
          http: {
            paths: [
              {
                // No rewrite — frpc dials the default WSS path `/~!frp`.
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: {
                    name,
                    port: { number: FRPS_BIND_PORT },
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
    const existing = await networking.readNamespacedIngress({
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
    } as never);
    body.metadata!.resourceVersion = (existing as k8s.V1Ingress).metadata?.resourceVersion;
    await networking.replaceNamespacedIngress({
      name,
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      body,
    } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await networking.createNamespacedIngress({
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      body,
    } as never);
  }
}

// ─── Reapers ────────────────────────────────────────────────────────────────

async function reapStaleTunnels(
  core: k8s.CoreV1Api,
  networking: k8s.NetworkingV1Api,
  clientNamespace: string,
  activeSlugs: ReadonlySet<string>,
): Promise<void> {
  // Find all tunnel-* Services + Ingresses in platform-system that
  // belong to this client namespace via the label set in
  // upsertExternalNameService / upsertTunnelIngress.
  // BOTH selectors include client-namespace — without it, one client's
  // teardown (activeSlugs=∅) deletes every other client's live tunnels.
  const labelSelector = `platform.phoenix-host.net/private-worker-tunnel=true,platform.phoenix-host.net/client-namespace=${clientNamespace}`;
  const ingressSelector = labelSelector;

  // Services carry the client-namespace label, so we can scope by
  // client. Ingresses don't (the slug-only label keeps them simple),
  // so we cross-reference by name with the Services we found.
  let services: k8s.V1ServiceList;
  try {
    services = (await core.listNamespacedService({
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      labelSelector,
    } as never)) as k8s.V1ServiceList;
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  const staleNames = (services.items ?? [])
    .map((svc) => svc.metadata?.name)
    .filter((n): n is string => typeof n === 'string')
    .filter((n) => {
      if (!n.startsWith('tunnel-')) return false;
      const slug = n.slice('tunnel-'.length);
      return !activeSlugs.has(slug);
    });

  for (const n of staleNames) {
     
    await deleteIfExists(() =>
      core.deleteNamespacedService({
        name: n,
        namespace: PLATFORM_SYSTEM_NAMESPACE,
      } as never),
    );
  }

  // For Ingresses we list by the simpler label, then drop any whose
  // name matches a stale Service (or whose slug is not in
  // activeSlugs and whose Service was already deleted).
  let ingresses: k8s.V1IngressList;
  try {
    ingresses = (await networking.listNamespacedIngress({
      namespace: PLATFORM_SYSTEM_NAMESPACE,
      labelSelector: ingressSelector,
    } as never)) as k8s.V1IngressList;
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  const staleSet = new Set(staleNames);
  const ingressNamesToDelete = (ingresses.items ?? [])
    .map((ing) => ing.metadata?.name)
    .filter((n): n is string => typeof n === 'string')
    .filter((n) => {
      if (!n.startsWith('tunnel-')) return false;
      if (staleSet.has(n)) return true;
      // Also drop tunnel-<slug> Ingresses whose ExternalName points
      // at this client's namespace via the rule's backend service —
      // that can happen if the Service was already deleted in a
      // previous tick but the Ingress survived.
      // Cheap heuristic: drop if not in activeSlugs at all.
      const slug = n.slice('tunnel-'.length);
      return !activeSlugs.has(slug);
    });

  for (const n of ingressNamesToDelete) {
     
    await deleteIfExists(() =>
      networking.deleteNamespacedIngress({
        name: n,
        namespace: PLATFORM_SYSTEM_NAMESPACE,
      } as never),
    );
  }
}

async function reapStalePerWorkerServices(
  core: k8s.CoreV1Api,
  namespace: string,
  activeServiceNames: ReadonlySet<string>,
): Promise<void> {
  let services: k8s.V1ServiceList;
  try {
    services = (await core.listNamespacedService({
      namespace,
      labelSelector: 'platform.phoenix-host.net/private-worker-service=true',
    } as never)) as k8s.V1ServiceList;
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  const stale = (services.items ?? [])
    .map((svc) => svc.metadata?.name)
    .filter((n): n is string => typeof n === 'string')
    .filter((n) => !activeServiceNames.has(n));

  for (const n of stale) {
     
    await deleteIfExists(() =>
      core.deleteNamespacedService({ name: n, namespace } as never),
    );
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

async function safe(
  errors: string[],
  step: string,
  op: () => Promise<unknown>,
): Promise<void> {
  try {
    await op();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${step}: ${msg}`);
  }
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

function resolvePlatformDomain(): string {
  return (
    process.env.PLATFORM_BASE_DOMAIN
    ?? process.env.INGRESS_BASE_DOMAIN
    ?? 'k8s-platform.test'
  );
}
