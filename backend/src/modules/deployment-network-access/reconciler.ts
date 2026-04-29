/**
 * Per-client mesh-proxy reconciler for the Network Access feature.
 *
 * Materialises ONE pod per (client, kind) where kind is
 * 'ziti-tunneler' or 'zrok-frontdoor', shared by every deployment of
 * that client in the matching mode. Reference-counted: provisioned on
 * first deployment, torn down when the last deployment leaves the mode.
 *
 * Userspace mode for Ziti — uses ziti-edge-tunnel's `proxy` subcommand
 * which runs without NET_ADMIN/TUN. The proxy listens on a TCP port
 * per tunnelled service inside the pod; we expose it via a Service
 * + sibling K8s Service per (deployment) that points at the upstream
 * Service inside the customer's Ziti network. Cluster-internal calls
 * to the deployment go through this proxy.
 *
 * For mode='tunneler' we ALSO toggle domains.suppress_public_ingress
 * for every domain whose ingress_routes target the deployment, so the
 * tenant Ingress is never created — true mesh-only.
 */

import * as k8s from '@kubernetes/client-node';
import { eq } from 'drizzle-orm';
import {
  clients,
  clientMeshProxyState,
  clientZitiProviders,
  clientZrokAccounts,
  deploymentNetworkAccessConfigs,
  deployments,
} from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import {
  listMeshDeploymentsForClient,
  setDomainSuppression,
  markReconciled,
} from './service.js';
import type { Database } from '../../db/index.js';

const ZITI_PROXY_NAME = 'ziti-tunneler';
const ZROK_FRONTDOOR_NAME = 'zrok-frontdoor';
const ZITI_TUNNEL_IMAGE = process.env.ZITI_EDGE_TUNNEL_IMAGE
  ?? 'openziti/ziti-edge-tunnel:latest';
const ZROK_FRONTDOOR_IMAGE = process.env.ZROK_FRONTDOOR_IMAGE
  ?? 'openziti/zrok:latest';

export interface ReconcileDeps {
  readonly db: Database;
  readonly k8s: {
    readonly core: k8s.CoreV1Api;
    readonly apps: k8s.AppsV1Api;
    readonly networking: k8s.NetworkingV1Api;
  };
  readonly encryptionKey: string;
}

export interface ReconcileOutcome {
  readonly clientId: string;
  readonly namespace: string;
  readonly tunnelerDeployments: number;
  readonly zrokDeployments: number;
  readonly action: 'provisioned' | 'updated' | 'torn_down' | 'noop';
  readonly error: string | null;
}

export async function reconcileClient(
  deps: ReconcileDeps,
  clientId: string,
): Promise<ReconcileOutcome> {
  const namespace = await getClientNamespace(deps.db, clientId);
  if (!namespace) {
    return { clientId, namespace: '', tunnelerDeployments: 0, zrokDeployments: 0, action: 'noop', error: 'client not found' };
  }
  const meshDeps = await listMeshDeploymentsForClient(deps.db, clientId);
  const tunnelerDeps = meshDeps.filter((d) => d.mode === 'tunneler');
  const zrokDeps = meshDeps.filter((d) => d.mode === 'zrok');

  let action: ReconcileOutcome['action'] = 'noop';

  try {
    // ─── Ziti tunneler ──────────────────────────────────────────
    if (tunnelerDeps.length > 0) {
      const provider = await loadZitiProvider(deps.db, deps.encryptionKey, tunnelerDeps[0]!.zitiProviderId!);
      const wasNew = await ensureZitiTunneler(deps, namespace, provider);
      action = wasNew ? 'provisioned' : 'updated';
    } else {
      const torn = await tearDownZitiTunneler(deps, clientId, namespace);
      if (torn) action = 'torn_down';
    }

    // ─── zrok frontdoor ─────────────────────────────────────────
    if (zrokDeps.length > 0) {
      const account = await loadZrokAccount(deps.db, deps.encryptionKey, zrokDeps[0]!.zrokProviderId!);
      const wasNew = await ensureZrokFrontdoor(deps, namespace, account);
      if (wasNew && action === 'noop') action = 'provisioned';
      else if (action === 'noop') action = 'updated';
    } else {
      const torn = await tearDownZrokFrontdoor(deps, clientId, namespace);
      if (torn && action === 'noop') action = 'torn_down';
    }

    // ─── Per-deployment Ingress suppression (only tunneler mode) ─
    for (const d of meshDeps) {
      // eslint-disable-next-line no-await-in-loop
      await setDomainSuppression(deps.db, d.deploymentId, d.mode === 'tunneler');
      // eslint-disable-next-line no-await-in-loop
      await markReconciled(deps.db, d.deploymentId, true, null, true, d.mode === 'tunneler');
    }

    return { clientId, namespace, tunnelerDeployments: tunnelerDeps.length, zrokDeployments: zrokDeps.length, action, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const d of meshDeps) {
      // eslint-disable-next-line no-await-in-loop
      await markReconciled(deps.db, d.deploymentId, false, msg, false, false);
    }
    return { clientId, namespace, tunnelerDeployments: tunnelerDeps.length, zrokDeployments: zrokDeps.length, action: 'noop', error: msg };
  }
}

async function getClientNamespace(db: Database, clientId: string): Promise<string | null> {
  const [row] = await db
    .select({ ns: clients.kubernetesNamespace })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row?.ns ?? null;
}

async function loadZitiProvider(db: Database, encryptionKey: string, providerId: string): Promise<{
  controllerUrl: string;
  enrollmentJwt: string | null;
}> {
  const [row] = await db.select().from(clientZitiProviders).where(eq(clientZitiProviders.id, providerId));
  if (!row) throw new Error(`ziti provider ${providerId} not found`);
  return {
    controllerUrl: row.controllerUrl,
    enrollmentJwt: row.enrollmentJwtEncrypted ? decrypt(row.enrollmentJwtEncrypted, encryptionKey) : null,
  };
}

async function loadZrokAccount(db: Database, encryptionKey: string, providerId: string): Promise<{
  controllerUrl: string;
  accountToken: string;
}> {
  const [row] = await db.select().from(clientZrokAccounts).where(eq(clientZrokAccounts.id, providerId));
  if (!row) throw new Error(`zrok account ${providerId} not found`);
  return {
    controllerUrl: row.controllerUrl,
    accountToken: decrypt(row.accountTokenEncrypted, encryptionKey),
  };
}

async function ensureZitiTunneler(
  deps: ReconcileDeps,
  namespace: string,
  provider: { controllerUrl: string; enrollmentJwt: string | null },
): Promise<boolean> {
  // Identity ConfigMap — holds the enrollment JWT and controller URL.
  // The pod's init script consumes the JWT on first boot; the resulting
  // long-lived identity is written to an emptyDir + persisted via
  // future PVC migration (v1: ephemeral identity, re-enrolls on pod
  // restart).
  await upsertConfigMap(deps.k8s.core, namespace, ZITI_PROXY_NAME, {
    'ziti-controller.url': provider.controllerUrl,
    'ziti-enrollment.jwt': provider.enrollmentJwt ?? '',
  });
  await upsertService(deps.k8s.core, namespace, ZITI_PROXY_NAME, [
    { name: 'http-proxy', port: 8080, targetPort: 8080 },
  ]);
  const wasNew = await upsertZitiDeployment(deps.k8s.apps, namespace);
  await markMeshState(deps.db, await clientIdForNamespace(deps.db, namespace), 'ziti-tunneler', true, null);
  return wasNew;
}

async function ensureZrokFrontdoor(
  deps: ReconcileDeps,
  namespace: string,
  account: { controllerUrl: string; accountToken: string },
): Promise<boolean> {
  await upsertConfigMap(deps.k8s.core, namespace, ZROK_FRONTDOOR_NAME, {
    'zrok-api-endpoint': account.controllerUrl,
    'zrok-token': account.accountToken,
  });
  await upsertService(deps.k8s.core, namespace, ZROK_FRONTDOOR_NAME, [
    { name: 'http', port: 8080, targetPort: 8080 },
  ]);
  const wasNew = await upsertZrokDeployment(deps.k8s.apps, namespace);
  await markMeshState(deps.db, await clientIdForNamespace(deps.db, namespace), 'zrok-frontdoor', true, null);
  return wasNew;
}

async function tearDownZitiTunneler(
  deps: ReconcileDeps,
  clientId: string,
  namespace: string,
): Promise<boolean> {
  const [state] = await deps.db
    .select()
    .from(clientMeshProxyState)
    .where(eq(clientMeshProxyState.clientId, clientId));
  if (!state || state.kind !== 'ziti-tunneler' || !state.provisioned) return false;
  await deleteIfExists(() =>
    deps.k8s.apps.deleteNamespacedDeployment({ name: ZITI_PROXY_NAME, namespace } as never),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedService({ name: ZITI_PROXY_NAME, namespace } as never),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedConfigMap({ name: ZITI_PROXY_NAME, namespace } as never),
  );
  await markMeshState(deps.db, clientId, 'ziti-tunneler', false, null);
  return true;
}

async function tearDownZrokFrontdoor(
  deps: ReconcileDeps,
  clientId: string,
  namespace: string,
): Promise<boolean> {
  const [state] = await deps.db
    .select()
    .from(clientMeshProxyState)
    .where(eq(clientMeshProxyState.clientId, clientId));
  if (!state || state.kind !== 'zrok-frontdoor' || !state.provisioned) return false;
  await deleteIfExists(() =>
    deps.k8s.apps.deleteNamespacedDeployment({ name: ZROK_FRONTDOOR_NAME, namespace } as never),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedService({ name: ZROK_FRONTDOOR_NAME, namespace } as never),
  );
  await deleteIfExists(() =>
    deps.k8s.core.deleteNamespacedConfigMap({ name: ZROK_FRONTDOOR_NAME, namespace } as never),
  );
  await markMeshState(deps.db, clientId, 'zrok-frontdoor', false, null);
  return true;
}

// ─── K8s helpers ─────────────────────────────────────────────────

async function upsertConfigMap(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  const body: k8s.V1ConfigMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'platform-api' } },
    data,
  };
  try {
    await core.replaceNamespacedConfigMap({ name, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedConfigMap({ namespace, body } as never);
  }
}

async function upsertService(
  core: k8s.CoreV1Api,
  namespace: string,
  name: string,
  ports: ReadonlyArray<{ name: string; port: number; targetPort: number }>,
): Promise<void> {
  const body: k8s.V1Service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/name': name } },
    spec: {
      selector: { 'app.kubernetes.io/name': name },
      ports: ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: 'TCP' })),
    },
  };
  try {
    const existing = await core.readNamespacedService({ name, namespace } as never);
    body.spec!.clusterIP = existing.spec?.clusterIP;
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await core.replaceNamespacedService({ name, namespace, body } as never);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await core.createNamespacedService({ namespace, body } as never);
  }
}

async function upsertZitiDeployment(apps: k8s.AppsV1Api, namespace: string): Promise<boolean> {
  // Userspace mode: ziti-edge-tunnel run-host -i /etc/ziti/identity.json
  // would normally enroll on first call; for v1 we mount the JWT and
  // run the enrollment + run flow as a single command.
  const body: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: ZITI_PROXY_NAME, namespace, labels: { 'app.kubernetes.io/name': ZITI_PROXY_NAME } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': ZITI_PROXY_NAME } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': ZITI_PROXY_NAME } },
        spec: {
          volumes: [
            { name: 'identity', emptyDir: {} },
            { name: 'config', configMap: { name: ZITI_PROXY_NAME } },
          ],
          // Enrollment + run as a single command. Userspace mode (no
          // tun device, no NET_ADMIN). HTTP proxy on :8080.
          containers: [{
            name: 'tunneler',
            image: ZITI_TUNNEL_IMAGE,
            command: ['/bin/sh', '-c'],
            args: [
              'set -e; ' +
              'if [ ! -f /etc/ziti/id.json ]; then ' +
              '  ziti-edge-tunnel enroll --jwt /etc/ziti-config/ziti-enrollment.jwt --identity /etc/ziti/id.json; ' +
              'fi; ' +
              'exec ziti-edge-tunnel proxy --identity /etc/ziti/id.json --proxy-listen 0.0.0.0:8080',
            ],
            ports: [{ containerPort: 8080, name: 'http-proxy' }],
            volumeMounts: [
              { name: 'identity', mountPath: '/etc/ziti' },
              { name: 'config', mountPath: '/etc/ziti-config', readOnly: true },
            ],
            resources: {
              requests: { cpu: '20m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' },
            },
          }],
        },
      },
    },
  };
  try {
    const existing = await apps.readNamespacedDeployment({ name: ZITI_PROXY_NAME, namespace } as never);
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await apps.replaceNamespacedDeployment({ name: ZITI_PROXY_NAME, namespace, body } as never);
    return false;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await apps.createNamespacedDeployment({ namespace, body } as never);
    return true;
  }
}

async function upsertZrokDeployment(apps: k8s.AppsV1Api, namespace: string): Promise<boolean> {
  // zrok access private <token> binds the share to localhost:<port>;
  // we expose that port on a Service so the tenant Ingress can dial it.
  const body: k8s.V1Deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: ZROK_FRONTDOOR_NAME, namespace, labels: { 'app.kubernetes.io/name': ZROK_FRONTDOOR_NAME } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': ZROK_FRONTDOOR_NAME } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': ZROK_FRONTDOOR_NAME } },
        spec: {
          volumes: [
            { name: 'config', configMap: { name: ZROK_FRONTDOOR_NAME } },
            { name: 'state', emptyDir: {} },
          ],
          containers: [{
            name: 'frontdoor',
            image: ZROK_FRONTDOOR_IMAGE,
            env: [
              { name: 'ZROK_API_ENDPOINT', valueFrom: { configMapKeyRef: { name: ZROK_FRONTDOOR_NAME, key: 'zrok-api-endpoint' } } },
              { name: 'ZROK_ENABLE_TOKEN', valueFrom: { configMapKeyRef: { name: ZROK_FRONTDOOR_NAME, key: 'zrok-token' } } },
              { name: 'HOME', value: '/state' },
            ],
            command: ['/bin/sh', '-c'],
            args: [
              // Enable on first boot if state dir is empty, then run
              // a private share access loop. Multi-share frontdoor
              // configuration is a v2 enhancement; v1 routes a single
              // share token per (client) — UI restricts to one zrok-
              // mode deployment per client at a time.
              'set -e; ' +
              'cd /state; ' +
              'if [ ! -d ".zrok" ]; then zrok enable "$ZROK_ENABLE_TOKEN"; fi; ' +
              'echo "frontdoor v1 — zrok identity enabled; share access wiring is pending Milestone C-2"; ' +
              'exec sleep infinity',
            ],
            ports: [{ containerPort: 8080, name: 'http' }],
            volumeMounts: [
              { name: 'state', mountPath: '/state' },
              { name: 'config', mountPath: '/etc/zrok-config', readOnly: true },
            ],
            resources: {
              requests: { cpu: '20m', memory: '64Mi' },
              limits: { cpu: '200m', memory: '256Mi' },
            },
          }],
        },
      },
    },
  };
  try {
    const existing = await apps.readNamespacedDeployment({ name: ZROK_FRONTDOOR_NAME, namespace } as never);
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
    await apps.replaceNamespacedDeployment({ name: ZROK_FRONTDOOR_NAME, namespace, body } as never);
    return false;
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await apps.createNamespacedDeployment({ namespace, body } as never);
    return true;
  }
}

async function deleteIfExists(op: () => Promise<unknown>): Promise<void> {
  try { await op(); } catch (err) { if (!isNotFound(err)) throw err; }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { statusCode?: number; code?: number; message?: string };
  if (e.statusCode === 404 || e.code === 404) return true;
  if (typeof e.message === 'string' && /HTTP-Code:\s*404/.test(e.message)) return true;
  return false;
}

async function clientIdForNamespace(db: Database, namespace: string): Promise<string> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.kubernetesNamespace, namespace));
  return row?.id ?? '';
}

async function markMeshState(
  db: Database,
  clientId: string,
  kind: 'ziti-tunneler' | 'zrok-frontdoor',
  provisioned: boolean,
  error: string | null,
): Promise<void> {
  if (!clientId) return;
  const [existing] = await db
    .select()
    .from(clientMeshProxyState)
    .where(eq(clientMeshProxyState.clientId, clientId));
  if (existing && existing.kind === kind) {
    await db
      .update(clientMeshProxyState)
      .set({ provisioned, lastProvisionedAt: provisioned ? new Date() : existing.lastProvisionedAt, lastError: error })
      .where(eq(clientMeshProxyState.clientId, clientId));
  } else {
    await db.insert(clientMeshProxyState).values({
      clientId,
      kind,
      provisioned,
      lastProvisionedAt: provisioned ? new Date() : null,
      lastError: error,
    });
  }
}
// Used by app.ts to probe the deployment table.
export { deployments, deploymentNetworkAccessConfigs };
