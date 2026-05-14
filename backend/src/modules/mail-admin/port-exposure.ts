/**
 * Mail port exposure mode — toggle between:
 *
 *   thisNodeOnly   — Stalwart pod binds mail ports via hostPort directly;
 *                    only the node the pod is scheduled on receives traffic.
 *                    No haproxy DaemonSet present in the cluster.
 *
 *   allServerNodes — haproxy DaemonSet bound on every server-role node
 *                    forwards mail traffic to stalwart-mail.mail.svc with
 *                    PROXY Protocol v2 so Stalwart sees real client IPs.
 *                    DS is CREATED by platform-api on entry to this mode,
 *                    DELETED on exit.
 *
 * Switching modes is a two-step operation that avoids port conflicts:
 *
 *   thisNodeOnly → allServerNodes:
 *     1. Remove hostPort from Stalwart Deployment (JSON-Patch on the
 *        ports array; Deployment rolls).
 *     2. CREATE the haproxy DaemonSet (apps.createNamespacedDaemonSet
 *        from the buildHaproxyDaemonSet() spec).
 *     3. Persist mode in system_settings.
 *
 *   allServerNodes → thisNodeOnly:
 *     1. DELETE the haproxy DaemonSet (apps.deleteNamespacedDaemonSet).
 *     2. Re-add hostPort to Stalwart Deployment (Deployment rolls).
 *     3. Persist mode in system_settings.
 *
 * 2026-05-14 streamline: previously the DS was always-applied by Flux
 * with a dummy nodeSelector and platform-api SSA-patched the selector
 * to toggle. That created an ongoing field-ownership war with Flux's
 * kustomize-controller (PRs #43–#45). Moving the DS object lifecycle
 * to platform-api ends the war — Flux still owns the ConfigMap and
 * NetworkPolicy, both of which are static and benefit from GitOps.
 *
 * GET  /admin/mail/port-exposure  → MailPortExposureResponse
 * PATCH /admin/mail/port-exposure → 204
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { JSON_PATCH } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPortExposureResponse,
  mailPortExposureResponseSchema,
} from '@k8s-hosting/api-contracts';
import {
  buildHaproxyDaemonSet,
  HAPROXY_DS_NAME,
  HAPROXY_DS_NAMESPACE,
} from './haproxy-builder.js';

const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';
// Stalwart Deployment + haproxy DaemonSet both live in the `mail`
// namespace; aliasing this constant here for readability — code that
// patches the Stalwart Deployment shouldn't read as if it were
// patching the haproxy namespace.
const MAIL_NS = HAPROXY_DS_NAMESPACE;

// Mail ports that Stalwart binds via hostPort in 'thisNodeOnly' mode.
const MAIL_HOST_PORTS = [25, 465, 587, 143, 993, 4190] as const;

export interface PortExposureOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sAppsBundle {
  apps: import('@kubernetes/client-node').AppsV1Api;
}

async function loadK8sAppsClient(kubeconfigPath: string | undefined): Promise<K8sAppsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return { apps: kc.makeApiClient(k8s.AppsV1Api) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the current port-exposure mode and haproxy DaemonSet status.
 *
 * The DS is expected to be ABSENT in `thisNodeOnly` mode (platform-api
 * deleted it) and PRESENT with the expected pod count in `allServerNodes`
 * mode. Drift (DS present but mode=thisNodeOnly, or DS absent but
 * mode=allServerNodes) shows up in the response as `daemonSetStatus`
 * not matching `proxyProtocolActive` — operator-visible in the UI.
 */
export async function getMailPortExposure(
  db: Database,
  opts: PortExposureOptions,
): Promise<MailPortExposureResponse> {
  const { apps } = await loadK8sAppsClient(opts.kubeconfigPath);

  const [row] = await db.select({ v: systemSettings.mailPortExposureMode })
    .from(systemSettings)
    .where(eq(systemSettings.id, SETTINGS_ID));

  const mode = (row?.v as 'thisNodeOnly' | 'allServerNodes' | null) ?? 'thisNodeOnly';

  let daemonSetStatus: { ready: number; desired: number } | null = null;
  try {
    const ds = await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    }) as { status?: { numberReady?: number; desiredNumberScheduled?: number } };
    daemonSetStatus = {
      ready: ds.status?.numberReady ?? 0,
      desired: ds.status?.desiredNumberScheduled ?? 0,
    };
  } catch (err) {
    if (isNotFound(err)) {
      // DS not present — expected in thisNodeOnly mode.
      daemonSetStatus = null;
    }
    // Non-404 errors are swallowed — mode is still readable from DB.
  }

  return mailPortExposureResponseSchema.parse({
    mode,
    proxyProtocolActive: mode === 'allServerNodes',
    daemonSetStatus,
  });
}

/**
 * Switch the port-exposure mode.
 * Applies the two-step transition to avoid port conflicts on nodes.
 */
export async function updateMailPortExposure(
  { mode }: { mode: 'thisNodeOnly' | 'allServerNodes' },
  db: Database,
  opts: PortExposureOptions,
): Promise<void> {
  const { apps } = await loadK8sAppsClient(opts.kubeconfigPath);

  if (mode === 'allServerNodes') {
    // Step 1: Remove hostPort from Stalwart Deployment so haproxy can bind
    // the same ports on the same nodes without conflict.
    await removeHostPortsFromDeployment(apps);

    // Step 2: Create the haproxy DaemonSet.
    await ensureHaproxyDaemonSetExists(apps);
  } else {
    // thisNodeOnly path — reverse order.

    // Step 1: Delete the haproxy DaemonSet first so its hostPorts are
    // released before Stalwart tries to bind them.
    await ensureHaproxyDaemonSetAbsent(apps);

    // Step 2: Re-add hostPorts to Stalwart Deployment.
    await addHostPortsToDeployment(apps);
  }

  // Step 3: Persist the new mode.
  await db.update(systemSettings)
    .set({ mailPortExposureMode: mode })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── Private helpers ────────────────────────────────────────────────────────────

type ContainerShape = {
  name: string;
  ports?: Array<{ containerPort: number; hostPort?: number; name?: string; protocol?: string }>;
};

type DeploymentShape = {
  spec?: {
    template?: {
      spec?: {
        containers?: ContainerShape[];
      };
    };
  };
};

async function readDeployment(apps: import('@kubernetes/client-node').AppsV1Api): Promise<DeploymentShape> {
  try {
    return await apps.readNamespacedDeployment({
      namespace: MAIL_NS,
      name: DEPLOYMENT_NAME,
    }) as DeploymentShape;
  } catch (err) {
    throw new ApiError(
      'MAIL_DEPLOYMENT_READ_FAILED',
      `Could not read Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      503,
    );
  }
}

/**
 * Replace the Stalwart Deployment's container ports array.
 *
 * We use JSON-Patch (`replace` on the whole ports array) rather than
 * strategic-merge-patch because strategic-merge merges port entries by
 * `containerPort`, which means omitting `hostPort` from a port entry does
 * NOT remove the existing hostPort — it just leaves the existing value
 * in place. To toggle hostPort on/off reliably we have to replace the
 * array wholesale.
 */
async function replaceStalwartContainerPorts(
  apps: import('@kubernetes/client-node').AppsV1Api,
  withHostPorts: boolean,
): Promise<void> {
  const dep = await readDeployment(apps);
  const containers = dep.spec?.template?.spec?.containers ?? [];
  const stalwartIdx = containers.findIndex((c) => c.name === 'stalwart');
  if (stalwartIdx < 0) {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      'Stalwart container not found in Deployment spec',
      503,
    );
  }
  const stalwart = containers[stalwartIdx];

  const newPorts = (stalwart.ports ?? []).map((p) => {
    const isMailPort = (MAIL_HOST_PORTS as readonly number[]).includes(p.containerPort);
    if (!isMailPort) {
      // Non-mail port (mgmt-http :8080, http-acme :80) — never gets a hostPort.
      const { hostPort: _drop, ...rest } = p;
      return rest;
    }
    if (withHostPorts) {
      return { ...p, hostPort: p.containerPort };
    }
    // Mail port + hostPorts disabled → strip hostPort.
    const { hostPort: _drop, ...rest } = p;
    return rest;
  });

  const body = [
    {
      op: 'replace',
      path: `/spec/template/spec/containers/${stalwartIdx}/ports`,
      value: newPorts,
    },
  ];

  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NS,
      name: DEPLOYMENT_NAME,
      body: body as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    JSON_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      `Failed to ${withHostPorts ? 're-add' : 'remove'} hostPorts on Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });

  // CRITICAL: wait for the rollout to actually complete before
  // returning. The streamline E2E harness Phase C3/C4 caught the
  // race: patchNamespacedDeployment returns as soon as the apiserver
  // accepts the patch, but the existing Stalwart pod KEEPS binding
  // its hostPorts until the rollout terminates it. If
  // ensureHaproxyDaemonSetExists creates the haproxy DS in that
  // window, haproxy on the Stalwart-pod node fails to bind the
  // hostPort (already taken by the old Stalwart pod) and either
  // CrashLoopBacks or schedules without serving traffic. By waiting
  // for the rollout we guarantee:
  //   - withHostPorts=false (flip to allServerNodes) → old pod gone
  //     before haproxy DS is created
  //   - withHostPorts=true  (flip to thisNodeOnly)  → new pod ready
  //     before mode flip returns (operator sees consistent state in
  //     the response)
  // 90s budget: a typical Stalwart pod restart is ~25s; 90s covers
  // local-path PVC re-attach + restore-state initContainer.
  await waitForDeploymentRollout(apps, 90_000);
}

async function removeHostPortsFromDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  await replaceStalwartContainerPorts(apps, /* withHostPorts= */ false);
}

async function addHostPortsToDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  await replaceStalwartContainerPorts(apps, /* withHostPorts= */ true);
}

/**
 * Poll the Stalwart Deployment until its rollout completes (or
 * `timeoutMs` elapses).
 *
 * "Rollout complete" means the apiserver has observed the latest
 * generation AND all replicas reflect the new template AND no
 * unavailable replicas remain. K8s expresses this in
 * `Deployment.status` fields:
 *   - observedGeneration == spec.generation  (apiserver caught up)
 *   - updatedReplicas    == spec.replicas    (rollout finished)
 *   - readyReplicas      == spec.replicas    (new pods are ready)
 *   - unavailableReplicas absent or 0
 *
 * This mirrors what `kubectl rollout status deployment/stalwart-mail`
 * checks. On timeout we throw MAIL_DEPLOYMENT_ROLLOUT_TIMEOUT — the
 * port-exposure mode flip cannot safely proceed if the old pod is
 * still binding its hostPorts.
 */
async function waitForDeploymentRollout(
  apps: import('@kubernetes/client-node').AppsV1Api,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastObservedGen = -1;
  let lastUpdatedReplicas = -1;
  let lastUnavailable = -1;
  // Poll every 2s — Deployment status updates aren't faster than
  // kubelet's pod-status refresh (typically ~1s) so faster polling
  // just adds apiserver load.
  while (Date.now() < deadline) {
    let dep: DeploymentRolloutShape;
    try {
      dep = await apps.readNamespacedDeployment({
        namespace: MAIL_NS,
        name: DEPLOYMENT_NAME,
      }) as DeploymentRolloutShape;
    } catch (err) {
      throw new ApiError(
        'MAIL_DEPLOYMENT_ROLLOUT_READ_FAILED',
        `Could not read Stalwart Deployment during rollout wait: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    const generation = dep.metadata?.generation ?? 0;
    const observedGeneration = dep.status?.observedGeneration ?? -1;
    const replicas = dep.spec?.replicas ?? 0;
    const updatedReplicas = dep.status?.updatedReplicas ?? 0;
    const readyReplicas = dep.status?.readyReplicas ?? 0;
    const unavailableReplicas = dep.status?.unavailableReplicas ?? 0;
    lastObservedGen = observedGeneration;
    lastUpdatedReplicas = updatedReplicas;
    lastUnavailable = unavailableReplicas;
    // Guard against replicas=0: an archive downtime run (archive.ts
    // patchDeploymentReplicas(0)) or a DR scale-down can leave the
    // Deployment at 0 replicas. A naive `updatedReplicas==replicas`
    // check is then trivially satisfied (0==0), so the rollout waiter
    // would return immediately and let the caller proceed before the
    // old pod is actually gone. Refuse to flip in that state — the
    // operator must wait for the concurrent op to finish, then retry.
    if (replicas === 0) {
      throw new ApiError(
        'MAIL_DEPLOYMENT_SCALED_TO_ZERO',
        'Stalwart Deployment has replicas=0 — another operation (archive downtime / DR failover) is in progress. Wait for it to complete before flipping port-exposure mode.',
        409,
      );
    }
    if (
      observedGeneration >= generation
      && updatedReplicas === replicas
      && readyReplicas === replicas
      && unavailableReplicas === 0
    ) {
      return;
    }
    await sleepMs(2_000);
  }
  throw new ApiError(
    'MAIL_DEPLOYMENT_ROLLOUT_TIMEOUT',
    `Stalwart Deployment rollout did not complete within ${Math.floor(timeoutMs / 1000)}s `
    + `(observedGen=${lastObservedGen}, updatedReplicas=${lastUpdatedReplicas}, unavailable=${lastUnavailable})`,
    504,
  );
}

interface DeploymentRolloutShape {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    unavailableReplicas?: number;
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the haproxy DaemonSet if it doesn't exist; do nothing if it
 * already does. Idempotent — safe to call from a retry loop.
 *
 * The spec comes from buildHaproxyDaemonSet() so this function and
 * `getMailPortExposure`'s status read agree on the object's name +
 * namespace.
 */
async function ensureHaproxyDaemonSetExists(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.readNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
    });
    // Already present — do not overwrite. Operator can `kubectl delete`
    // to force a re-create from the latest builder output.
    return;
  } catch (err) {
    if (!isNotFound(err)) {
      throw new ApiError(
        'MAIL_HAPROXY_DS_READ_FAILED',
        `Failed to read haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    // 404 — fall through to create.
  }

  const body = buildHaproxyDaemonSet();
  try {
    await apps.createNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      body: body as unknown as Parameters<typeof apps.createNamespacedDaemonSet>[0]['body'],
    });
  } catch (err) {
    // Race: someone else created it between our read + create. Treat
    // as success since the desired state is "DS exists".
    if (isConflict(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_CREATE_FAILED',
      `Failed to create haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}

/**
 * Delete the haproxy DaemonSet. Idempotent — 404 is treated as success.
 *
 * Uses propagationPolicy=Foreground so the apiserver blocks the
 * delete-call until child pods are gone. Without this, the default
 * Background GC returns immediately and haproxy pods can keep binding
 * hostPorts 25/465/587/143/993/4190 for their grace period (~10s
 * normally; can be longer). If the symmetric flip to thisNodeOnly
 * then patches the Stalwart Deployment to RE-ADD hostPorts, the new
 * Stalwart pod lands on a node where haproxy is still alive and
 * fails to bind those ports.
 *
 * Foreground GC is exactly what `kubectl delete ds --wait=true`
 * does, and what the symmetric streamline-fix path needs.
 *
 * After the delete returns we poll once to confirm pods are truly
 * gone (Foreground guarantees this, but the SDK won't throw on
 * timeout — we set a 60s cap and surface MAIL_HAPROXY_DS_DELETE_TIMEOUT).
 */
async function ensureHaproxyDaemonSetAbsent(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  try {
    await apps.deleteNamespacedDaemonSet({
      namespace: HAPROXY_DS_NAMESPACE,
      name: HAPROXY_DS_NAME,
      propagationPolicy: 'Foreground',
    });
  } catch (err) {
    if (isNotFound(err)) return;
    throw new ApiError(
      'MAIL_HAPROXY_DS_DELETE_FAILED',
      `Failed to delete haproxy DaemonSet: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
  // Belt-and-suspenders: poll until the DaemonSet is fully gone.
  // Foreground propagation makes the delete-call wait for child pods,
  // but client-side cancellation or apiserver hiccups could short-cut
  // that. Verify empirically.
  await waitForHaproxyDaemonSetGone(apps, 60_000);
}

async function waitForHaproxyDaemonSetGone(
  apps: import('@kubernetes/client-node').AppsV1Api,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await apps.readNamespacedDaemonSet({
        namespace: HAPROXY_DS_NAMESPACE,
        name: HAPROXY_DS_NAME,
      });
      // Still present — wait and retry.
      await sleepMs(2_000);
      continue;
    } catch (err) {
      if (isNotFound(err)) return; // gone — success
      throw new ApiError(
        'MAIL_HAPROXY_DS_DELETE_VERIFY_FAILED',
        `Could not verify haproxy DaemonSet deletion: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
  }
  throw new ApiError(
    'MAIL_HAPROXY_DS_DELETE_TIMEOUT',
    `haproxy DaemonSet did not finish deleting within ${Math.floor(timeoutMs / 1000)}s — some pods may still be binding hostPorts`,
    504,
  );
}

function isConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  const code = e.code ?? e.statusCode ?? e.body?.code;
  return code === 409;
}
