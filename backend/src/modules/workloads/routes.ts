import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createWorkloadSchema, updateWorkloadSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function workloadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

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

    const workload = await service.createWorkload(app.db, clientId, parsed.data, request.user.sub);
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

    const updated = await service.updateWorkload(app.db, clientId, workloadId, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/workloads/:workloadId
  app.delete('/clients/:clientId/workloads/:workloadId', async (request, reply) => {
    const { clientId, workloadId } = request.params as { clientId: string; workloadId: string };
    await service.deleteWorkload(app.db, clientId, workloadId);
    reply.status(204).send();
  });
}
