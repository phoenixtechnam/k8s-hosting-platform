import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createWorkloadSchema, updateWorkloadSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileWorkloadStatuses } from './status-reconciler.js';

export async function workloadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  // Lazy-init K8s clients (null if no kubeconfig available)
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  // POST /api/v1/clients/:clientId/workloads
  app.post('/clients/:clientId/workloads', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createWorkloadSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const workload = await service.createWorkload(app.db, clientId, parsed.data, request.user.sub, getK8s());
    reply.status(201).send(success(workload));
  });

  // GET /api/v1/clients/:clientId/workloads
  app.get('/clients/:clientId/workloads', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);

    const result = await service.listWorkloads(app.db, clientId, paginationParams);
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:clientId/workloads/:workloadId
  app.get('/clients/:clientId/workloads/:workloadId', async (request) => {
    const { clientId, workloadId } = request.params as { clientId: string; workloadId: string };
    const workload = await service.getWorkloadById(app.db, clientId, workloadId);
    return success(workload);
  });

  // PATCH /api/v1/clients/:clientId/workloads/:workloadId
  app.patch('/clients/:clientId/workloads/:workloadId', async (request) => {
    const { clientId, workloadId } = request.params as { clientId: string; workloadId: string };
    const parsed = updateWorkloadSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateWorkload(app.db, clientId, workloadId, parsed.data, getK8s());
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/workloads/:workloadId
  app.delete('/clients/:clientId/workloads/:workloadId', async (request, reply) => {
    const { clientId, workloadId } = request.params as { clientId: string; workloadId: string };
    await service.deleteWorkload(app.db, clientId, workloadId, getK8s());
    reply.status(204).send();
  });

  // POST /api/v1/admin/workloads/reconcile — admin-only, reconcile all workload statuses
  app.post('/admin/workloads/reconcile', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Workloads'],
      summary: 'Reconcile all workload statuses from k8s cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const k8s = getK8s();
    if (!k8s) {
      return success({ checked: 0, updated: 0, errors: ['K8s cluster not available'] });
    }
    const result = await reconcileWorkloadStatuses(app.db, k8s);
    return success(result);
  });
}
