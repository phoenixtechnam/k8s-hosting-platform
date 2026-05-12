/**
 * Mail port exposure mode — toggle between:
 *
 *   thisNodeOnly   — Stalwart pod binds mail ports via hostPort directly;
 *                    only the node the pod is scheduled on receives traffic.
 *
 *   allServerNodes — haproxy DaemonSet binds mail ports on every server node
 *                    and forwards to stalwart-mail.mail.svc.cluster.local with
 *                    PROXY Protocol v2 so Stalwart sees real client IPs.
 *
 * Switching modes is a two-step operation that avoids port conflicts:
 *
 *   thisNodeOnly → allServerNodes:
 *     1. Remove hostPort from Stalwart Deployment (strategic-merge; Deployment rolls).
 *     2. Enable haproxy DaemonSet by patching nodeSelector to server-role label.
 *     3. Persist mode in system_settings.
 *
 *   allServerNodes → thisNodeOnly:
 *     1. Disable haproxy DaemonSet (patch nodeSelector to a non-matching label).
 *     2. Re-add hostPort to Stalwart Deployment (strategic-merge; Deployment rolls).
 *     3. Persist mode in system_settings.
 *
 * GET  /admin/mail/port-exposure  → MailPortExposureResponse
 * PATCH /admin/mail/port-exposure → 204
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPortExposureResponse,
  mailPortExposureResponseSchema,
} from '@k8s-hosting/api-contracts';

const SETTINGS_ID = 'system';
const MAIL_NAMESPACE = 'mail';
const DAEMONSET_NAME = 'stalwart-haproxy';
const DEPLOYMENT_NAME = 'stalwart-mail';

// Mail ports that Stalwart binds via hostPort in 'thisNodeOnly' mode.
const MAIL_HOST_PORTS = [25, 465, 587, 143, 993, 4190] as const;

// nodeSelector labels used to toggle the DaemonSet on/off.
const DS_ENABLED_SELECTOR = { 'platform.phoenix-host.net/node-role': 'server' } as const;
const DS_DISABLED_SELECTOR = { 'platform.phoenix-host.net/mail-haproxy-disabled': 'true' } as const;

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
      namespace: MAIL_NAMESPACE,
      name: DAEMONSET_NAME,
    }) as { status?: { numberReady?: number; desiredNumberScheduled?: number } };
    daemonSetStatus = {
      ready: ds.status?.numberReady ?? 0,
      desired: ds.status?.desiredNumberScheduled ?? 0,
    };
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      // DaemonSet not yet applied by Flux — expected when mode is 'thisNodeOnly'.
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

    // Step 2: Enable haproxy DaemonSet by restoring the server-role nodeSelector.
    await setDaemonSetNodeSelector(apps, DS_ENABLED_SELECTOR, /* enable= */ true);
  } else {
    // thisNodeOnly path — reverse order.

    // Step 1: Disable haproxy DaemonSet first so hostPorts are freed before
    // Stalwart tries to bind them.
    await setDaemonSetNodeSelector(apps, DS_DISABLED_SELECTOR, /* enable= */ false);

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
      namespace: MAIL_NAMESPACE,
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

async function removeHostPortsFromDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  const dep = await readDeployment(apps);
  const containers = dep.spec?.template?.spec?.containers ?? [];

  const patchedContainers = containers.map((c) => ({
    ...c,
    ports: (c.ports ?? []).map(({ hostPort: _removed, ...rest }) => rest),
  }));

  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: {
        spec: { template: { spec: { containers: patchedContainers } } },
      } as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    STRATEGIC_MERGE_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      `Failed to remove hostPorts from Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });
}

async function addHostPortsToDeployment(
  apps: import('@kubernetes/client-node').AppsV1Api,
): Promise<void> {
  const dep = await readDeployment(apps);
  const containers = dep.spec?.template?.spec?.containers ?? [];

  const patchedContainers = containers.map((c) => {
    if (c.name !== 'stalwart') return c;
    const patchedPorts = (c.ports ?? []).map((p) => {
      return (MAIL_HOST_PORTS as readonly number[]).includes(p.containerPort)
        ? { ...p, hostPort: p.containerPort }
        : p;
    });
    return { ...c, ports: patchedPorts };
  });

  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: {
        spec: { template: { spec: { containers: patchedContainers } } },
      } as unknown as object,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    STRATEGIC_MERGE_PATCH,
  ).catch((err) => {
    throw new ApiError(
      'MAIL_DEPLOYMENT_PATCH_FAILED',
      `Failed to re-add hostPorts to Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      500,
    );
  });
}

async function setDaemonSetNodeSelector(
  apps: import('@kubernetes/client-node').AppsV1Api,
  nodeSelector: Record<string, string>,
  enable: boolean,
): Promise<void> {
  try {
    await apps.patchNamespacedDaemonSet(
      {
        namespace: MAIL_NAMESPACE,
        name: DAEMONSET_NAME,
        body: {
          spec: { template: { spec: { nodeSelector } } },
        } as unknown as object,
      } as unknown as Parameters<typeof apps.patchNamespacedDaemonSet>[0],
      MERGE_PATCH,
    );
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      if (enable) {
        // Enabling but DaemonSet doesn't exist — operator must apply the haproxy
        // Kustomize component before switching to allServerNodes mode.
        throw new ApiError(
          'MAIL_HAPROXY_DS_NOT_FOUND',
          'haproxy DaemonSet not found — ensure the haproxy Kustomize component is applied in the overlay before enabling allServerNodes mode',
          503,
        );
      }
      // Disabling but DaemonSet already gone — already in the desired state.
      return;
    }
    throw new ApiError(
      'MAIL_HAPROXY_DS_PATCH_FAILED',
      `Failed to patch haproxy DaemonSet nodeSelector: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }
}
