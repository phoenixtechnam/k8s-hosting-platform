import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';

export async function resourceQuotaRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/clients/:clientId/resource-quota — anyone authenticated can view
  app.get('/clients/:clientId/resource-quota', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const quota = await service.getResourceQuota(app.db, clientId);
    return success(quota);
  });

  // PATCH /api/v1/clients/:clientId/resource-quota — admin only
  app.patch('/clients/:clientId/resource-quota', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const input = request.body as Record<string, unknown>;
    const updated = await service.updateResourceQuota(app.db, clientId, {
      cpu_cores_limit: input.cpu_cores_limit as number | undefined,
      memory_gb_limit: input.memory_gb_limit as number | undefined,
      storage_gb_limit: input.storage_gb_limit as number | undefined,
      bandwidth_gb_limit: input.bandwidth_gb_limit as number | undefined,
    });
    return success(updated);
  });
}
