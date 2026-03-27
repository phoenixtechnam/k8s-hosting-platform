import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { addRepoInputSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function workloadRepoRoutes(app: FastifyInstance): Promise<void> {
  // All workload-repo routes require admin auth
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/workload-repos
  app.get('/admin/workload-repos', {
    schema: {
      tags: ['Workload Repos'],
      summary: 'List all workload catalog repositories',
      security: [{ bearerAuth: [] }],
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
                  name: { type: 'string' },
                  url: { type: 'string' },
                  branch: { type: 'string' },
                  syncIntervalMinutes: { type: 'number' },
                  lastSyncedAt: { type: 'string', nullable: true },
                  status: { type: 'string' },
                  lastError: { type: 'string', nullable: true },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const repos = await service.listRepos(app.db);
    return success(repos);
  });

  // POST /api/v1/admin/workload-repos
  app.post('/admin/workload-repos', {
    schema: {
      tags: ['Workload Repos'],
      summary: 'Add a workload catalog repository',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          url: { type: 'string', format: 'uri' },
          branch: { type: 'string', default: 'main' },
          auth_token: { type: 'string' },
          sync_interval_minutes: { type: 'integer', minimum: 1, maximum: 1440, default: 60 },
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
                name: { type: 'string' },
                url: { type: 'string' },
                branch: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = addRepoInputSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const repo = await service.addRepo(app.db, parsed.data);
    reply.status(201).send(success(repo));
  });

  // POST /api/v1/admin/workload-repos/restore-default
  app.post('/admin/workload-repos/restore-default', {
    schema: {
      tags: ['Workload Repos'],
      summary: 'Restore the official default workload catalog repository',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                url: { type: 'string' },
                branch: { type: 'string' },
                syncIntervalMinutes: { type: 'number' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const repo = await service.restoreDefaultRepo(app.db);
    return success(repo);
  });

  // DELETE /api/v1/admin/workload-repos/:id
  app.delete('/admin/workload-repos/:id', {
    schema: {
      tags: ['Workload Repos'],
      summary: 'Remove a workload catalog repository',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        204: { type: 'null', description: 'Successfully deleted' },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteRepo(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/workload-repos/:id/sync
  app.post('/admin/workload-repos/:id/sync', {
    schema: {
      tags: ['Workload Repos'],
      summary: 'Trigger manual sync of a workload catalog repository',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    await service.syncRepo(app.db, id);
    return success({ message: 'Sync completed successfully' });
  });
}
