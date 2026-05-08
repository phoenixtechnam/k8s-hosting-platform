import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { readNodeHealthSummary, reconcileNodeHealth } from './scheduler.js';

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
}
