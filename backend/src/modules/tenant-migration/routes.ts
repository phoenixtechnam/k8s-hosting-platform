import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { migrateClientToWorker } from './service.js';

export async function tenantMigrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/clients/:id/migrate-to-worker
  //
  // Body: { worker_node_name: string }
  //
  // Re-pins the client to a new worker and triggers a rollout-restart
  // on every tenant Deployment. PVC data stays on its original node
  // — Longhorn handles cross-node access. Large tenants or HA-tier
  // PVCs should be migrated via the (future) snapshot-restore flow.
  app.post('/admin/clients/:id/migrate-to-worker', {
    schema: {
      tags: ['TenantMigration'],
      summary: 'Re-pin a client to a different worker node',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { worker_node_name?: unknown };
    if (typeof body.worker_node_name !== 'string' || body.worker_node_name.trim() === '') {
      throw new ApiError('INVALID_FIELD_VALUE', 'worker_node_name is required', 400, { field: 'worker_node_name' });
    }

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await migrateClientToWorker(app.db, k8s, id, {
      workerNodeName: body.worker_node_name,
    });
    return success(result);
  });
}
