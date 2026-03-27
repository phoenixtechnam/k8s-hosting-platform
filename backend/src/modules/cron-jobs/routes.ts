import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createCronJobSchema, updateCronJobSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function cronJobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/admin/cron-jobs — list all cron jobs across all clients
  app.get('/admin/cron-jobs', async (request) => {
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePaginationParams(query);
    const result = await service.listAllCronJobs(app.db, { limit, cursor });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:id/cron-jobs
  app.get('/clients/:id/cron-jobs', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const { limit, cursor } = parsePaginationParams(query);
    const result = await service.listCronJobs(app.db, id, { limit, cursor });
    return paginated(result.data, result.pagination);
  });

  // POST /api/v1/clients/:id/cron-jobs
  app.post('/clients/:id/cron-jobs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createCronJobSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const job = await service.createCronJob(app.db, id, parsed.data);
    reply.status(201).send(success(job));
  });

  // GET /api/v1/clients/:id/cron-jobs/:cronJobId
  app.get('/clients/:id/cron-jobs/:cronJobId', async (request) => {
    const { id, cronJobId } = request.params as { id: string; cronJobId: string };
    const job = await service.getCronJobById(app.db, id, cronJobId);
    return success(job);
  });

  // PATCH /api/v1/clients/:id/cron-jobs/:cronJobId
  app.patch('/clients/:id/cron-jobs/:cronJobId', async (request) => {
    const { id, cronJobId } = request.params as { id: string; cronJobId: string };
    const parsed = updateCronJobSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const updated = await service.updateCronJob(app.db, id, cronJobId, parsed.data);
    return success(updated);
  });

  // POST /api/v1/clients/:id/cron-jobs/:cronJobId/run
  app.post('/clients/:id/cron-jobs/:cronJobId/run', async (request) => {
    const { id, cronJobId } = request.params as { id: string; cronJobId: string };
    const job = await service.runCronJobNow(app.db, id, cronJobId);
    return success(job);
  });

  // DELETE /api/v1/clients/:id/cron-jobs/:cronJobId
  app.delete('/clients/:id/cron-jobs/:cronJobId', async (request, reply) => {
    const { id, cronJobId } = request.params as { id: string; cronJobId: string };
    await service.deleteCronJob(app.db, id, cronJobId);
    reply.status(204).send();
  });
}
