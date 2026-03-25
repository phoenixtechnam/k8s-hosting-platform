import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createDatabaseSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'support'));

  // POST /api/v1/clients/:clientId/databases
  app.post('/clients/:clientId/databases', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDatabaseSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const actorId = (request.user as { sub: string }).sub;
    const result = await service.createDatabase(app.db, clientId, parsed.data, actorId);
    reply.status(201).send(success({ ...result.record, password: result.password }));
  });

  // GET /api/v1/clients/:clientId/databases
  app.get('/clients/:clientId/databases', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);

    const result = await service.listDatabases(app.db, clientId, paginationParams);
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:clientId/databases/:databaseId
  app.get('/clients/:clientId/databases/:databaseId', async (request) => {
    const { clientId, databaseId } = request.params as { clientId: string; databaseId: string };
    const record = await service.getDatabaseById(app.db, clientId, databaseId);
    return success(record);
  });

  // DELETE /api/v1/clients/:clientId/databases/:databaseId
  app.delete('/clients/:clientId/databases/:databaseId', async (request, reply) => {
    const { clientId, databaseId } = request.params as { clientId: string; databaseId: string };
    await service.deleteDatabase(app.db, clientId, databaseId);
    reply.status(204).send();
  });

  // PATCH /api/v1/clients/:clientId/databases/:databaseId/credentials
  app.patch('/clients/:clientId/databases/:databaseId/credentials', async (request) => {
    const { clientId, databaseId } = request.params as { clientId: string; databaseId: string };
    const result = await service.rotateCredentials(app.db, clientId, databaseId);
    return success({ ...result.record, password: result.password });
  });
}
