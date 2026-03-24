import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createClientSchema, updateClientSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  // All client routes require auth + admin role
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin'));

  // POST /api/v1/clients
  app.post('/clients', async (request, reply) => {
    const parsed = createClientSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const client = await service.createClient(app.db, parsed.data, request.user.sub);
    reply.status(201).send(success(client));
  });

  // GET /api/v1/clients
  app.get('/clients', async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listClients(app.db, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:id
  app.get('/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const client = await service.getClientById(app.db, id);
    return success(client);
  });

  // PATCH /api/v1/clients/:id
  app.patch('/clients/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateClientSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateClient(app.db, id, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:id
  app.delete('/clients/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteClient(app.db, id);
    reply.status(204).send();
  });
}
