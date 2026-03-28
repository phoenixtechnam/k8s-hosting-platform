import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { addAppRepoInputSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function applicationRepoRoutes(app: FastifyInstance): Promise<void> {
  // All application-repo routes require admin auth
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/application-repos
  app.get('/admin/application-repos', {
    schema: {
      tags: ['Application Repos'],
      summary: 'List all application catalog repositories',
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

  // POST /api/v1/admin/application-repos
  app.post('/admin/application-repos', {
    schema: {
      tags: ['Application Repos'],
      summary: 'Add an application catalog repository',
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
    const parsed = addAppRepoInputSchema.safeParse(request.body);
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

  // POST /api/v1/admin/application-repos/restore-default
  app.post('/admin/application-repos/restore-default', {
    schema: {
      tags: ['Application Repos'],
      summary: 'Restore the official default application catalog repository',
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

  // DELETE /api/v1/admin/application-repos/:id
  app.delete('/admin/application-repos/:id', {
    schema: {
      tags: ['Application Repos'],
      summary: 'Remove an application catalog repository',
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

  // POST /api/v1/admin/application-repos/:id/sync
  app.post('/admin/application-repos/:id/sync', {
    schema: {
      tags: ['Application Repos'],
      summary: 'Trigger manual sync of an application catalog repository',
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

  // GET /api/v1/admin/application-catalog
  app.get('/admin/application-catalog', {
    schema: {
      tags: ['Application Catalog'],
      summary: 'List all application catalog entries',
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
                  code: { type: 'string' },
                  name: { type: 'string' },
                  version: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                  category: { type: 'string', nullable: true },
                  minPlan: { type: 'string', nullable: true },
                  tenancy: { type: 'object', nullable: true },
                  components: { type: 'object', nullable: true },
                  networking: { type: 'object', nullable: true },
                  volumes: { type: 'object', nullable: true },
                  resources: { type: 'object', nullable: true },
                  healthCheck: { type: 'object', nullable: true },
                  parameters: { type: 'object', nullable: true },
                  tags: { type: 'array', nullable: true, items: { type: 'string' } },
                  status: { type: 'string' },
                  sourceRepoId: { type: 'string', nullable: true },
                  manifestUrl: { type: 'string', nullable: true },
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
    const entries = await service.listCatalogEntries(app.db);
    return success(entries);
  });
}
