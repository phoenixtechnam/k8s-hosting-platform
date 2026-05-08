import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { readNodeHealthSummary, reconcileNodeHealth } from './scheduler.js';
import {
  recyclePod,
  cleanStalePodsOnNode,
  restartCsiPluginOnNode,
} from './recovery.js';

export async function nodeHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  /**
   * GET /api/v1/admin/node-health/summary
   *
   * Last persisted snapshot from the 5-min reconciler — per-node
   * pressure, CSI driver count vs cluster baseline, recent
   * evictions, severity. Read from `node_health_state`; the
   * scheduler is the only writer.
   *
   * The Monitoring page hits this every 30s via TanStack Query;
   * the Nodes & Storage page joins on `nodeName` to render the
   * health badge. Cheap (one indexed table read).
   */
  app.get('/admin/node-health/summary', {
    schema: {
      tags: ['NodeHealth'],
      summary: 'Per-node health (pressure, CSI drivers, evictions, severity)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await readNodeHealthSummary(app.db));
  });

  /**
   * POST /api/v1/admin/node-health/reconcile
   *
   * Run a tick now (skip the 5-min wait). Surfaces immediately on
   * the Monitoring page after a fresh deploy or after the operator
   * has explicitly fixed something. Same logic as the scheduler;
   * doesn't bypass notification throttling.
   */
  app.post('/admin/node-health/reconcile', {
    schema: {
      tags: ['NodeHealth'],
      summary: 'Run the node-health reconciler now (no-wait override)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await reconcileNodeHealth(app.db, k8s);
    return success({
      reconciled: result.entries.length,
      notified: result.notified,
    });
  });

  // ─── Recovery actions (semi-automated remediation) ────────────────────
  //
  // Each endpoint:
  //   - super_admin/admin only (gated above)
  //   - allow-listed system namespaces only; refuses tenant + CNPG instances
  //   - audit-logs every action with the operator's user id + reason
  //   - idempotent (running twice on a recovered node returns recovered=0)

  /**
   * POST /api/v1/admin/node-health/recovery/recycle-pod
   * Body: { node, namespace, podName, reason }
   *
   * Delete a system pod on a node — controlling DaemonSet/Deployment
   * reschedules; containerd GCs the pod's writable layer (the recovery
   * mechanism that fixed the 2026-05-08 worker incident).
   */
  app.post('/admin/node-health/recovery/recycle-pod', {
    schema: {
      tags: ['NodeHealth'],
      summary: 'Delete a system pod on a node to free its writable layer',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['node', 'namespace', 'podName', 'reason'],
        properties: {
          node: { type: 'string', minLength: 1 },
          namespace: { type: 'string', minLength: 1 },
          podName: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 3, maxLength: 500 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { node: string; namespace: string; podName: string; reason: string };
    const userId = request.user?.sub;
    if (!userId) throw new ApiError('AUTH_REQUIRED', 'No actor in request', 401);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await recyclePod({ k8s, db: app.db, actorUserId: userId, ...body }));
  });

  /**
   * POST /api/v1/admin/node-health/recovery/clean-stale-pods
   * Body: { node, reason }
   *
   * Bulk-delete every Failed/Evicted/ContainerStatusUnknown pod on
   * the node. Refuses tenant namespaces + CNPG instances even when
   * Failed.
   */
  app.post('/admin/node-health/recovery/clean-stale-pods', {
    schema: {
      tags: ['NodeHealth'],
      summary: 'Delete stale (Failed/Evicted/Unknown) system pods on a node',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['node', 'reason'],
        properties: {
          node: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 3, maxLength: 500 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { node: string; reason: string };
    const userId = request.user?.sub;
    if (!userId) throw new ApiError('AUTH_REQUIRED', 'No actor in request', 401);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await cleanStalePodsOnNode({ k8s, db: app.db, actorUserId: userId, ...body }));
  });

  /**
   * POST /api/v1/admin/node-health/recovery/restart-csi-plugin
   * Body: { node, reason }
   *
   * Delete the longhorn-csi-plugin pod on this node — DaemonSet
   * replaces it; new pod re-registers driver.longhorn.io with the
   * kubelet (CSINode). Use when csiDriversMissing includes
   * driver.longhorn.io.
   */
  app.post('/admin/node-health/recovery/restart-csi-plugin', {
    schema: {
      tags: ['NodeHealth'],
      summary: 'Restart longhorn-csi-plugin on a node to re-register the CSI driver',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['node', 'reason'],
        properties: {
          node: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 3, maxLength: 500 },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { node: string; reason: string };
    const userId = request.user?.sub;
    if (!userId) throw new ApiError('AUTH_REQUIRED', 'No actor in request', 401);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await restartCsiPluginOnNode({ k8s, db: app.db, actorUserId: userId, ...body }));
  });
}
