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
  app.post('/clients', {
    schema: {
      tags: ['Clients'],
      summary: 'Create a new client',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['company_name', 'company_email', 'plan_id', 'region_id'],
        properties: {
          company_name: { type: 'string', minLength: 1, maxLength: 255 },
          company_email: { type: 'string', format: 'email' },
          contact_email: { type: 'string', format: 'email' },
          plan_id: { type: 'string', format: 'uuid' },
          region_id: { type: 'string', format: 'uuid' },
          subscription_expires_at: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                companyName: { type: 'string' },
                companyEmail: { type: 'string' },
                status: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
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
  app.get('/clients', {
    schema: {
      tags: ['Clients'],
      summary: 'List clients with cursor-based pagination',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'Opaque pagination cursor' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string', description: 'Search by company name or email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  companyName: { type: 'string' },
                  companyEmail: { type: 'string' },
                  contactEmail: { type: ['string', 'null'] },
                  kubernetesNamespace: { type: 'string' },
                  planId: { type: 'string' },
                  regionId: { type: 'string' },
                  status: { type: 'string' },
                  createdBy: { type: ['string', 'null'] },
                  subscriptionExpiresAt: { type: ['string', 'null'] },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                total_count: { type: 'integer' },
                cursor: { type: ['string', 'null'] },
                has_more: { type: 'boolean' },
                page_size: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
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
    return reply.status(204).send();
  });
}
