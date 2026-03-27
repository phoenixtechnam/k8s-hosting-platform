import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { metricsQuerySchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'super_admin', 'read_only'));

  // GET /api/v1/clients/:id/metrics
  app.get('/clients/:id/metrics', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const parsed = metricsQuerySchema.parse(query);
    const metrics = await service.getMetrics(app.db, id, parsed);
    return success(metrics);
  });
}
