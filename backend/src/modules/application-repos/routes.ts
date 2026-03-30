import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { addAppRepoInputSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function applicationRepoRoutes(app: FastifyInstance): Promise<void> {
  // ─── Public: Application catalog (accessible by all authenticated users) ───

  // GET /api/v1/application-catalog — any authenticated user can browse apps
  app.get('/application-catalog', {
    onRequest: [authenticate],
    schema: {
      tags: ['Application Catalog'],
      summary: 'List all application catalog entries (public)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const entries = await service.listCatalogEntries(app.db);
    return success(entries);
  });

  // GET /api/v1/application-catalog/:code — any authenticated user
  app.get('/application-catalog/:code', {
    onRequest: [authenticate],
    schema: {
      tags: ['Application Catalog'],
      summary: 'Get a single application catalog entry by code (public)',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
      },
    },
  }, async (request) => {
    const { code } = request.params as { code: string };
    const entry = await service.getCatalogEntry(app.db, code);
    return success(entry);
  });

  // ─── Admin: Repository management (all require super_admin/admin) ────────

  // GET /api/v1/admin/application-repos
  app.get('/admin/application-repos', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
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
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Catalog'],
      summary: 'List all application catalog entries',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const entries = await service.listCatalogEntries(app.db);
    return success(entries);
  });

  // PATCH /api/v1/admin/application-catalog/:id/badges
  app.patch('/admin/application-catalog/:id/badges', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Catalog'],
      summary: 'Update featured/popular badges on an application',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: {
          featured: { type: 'boolean' },
          popular: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { featured?: boolean; popular?: boolean };
    const updated = await service.updateBadges(app.db, id, body);
    return success(updated);
  });

  // GET /api/v1/admin/application-catalog/:code
  app.get('/admin/application-catalog/:code', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Application Catalog'],
      summary: 'Get a single application catalog entry by code',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          code: { type: 'string' },
        },
        required: ['code'],
      },
    },
  }, async (request) => {
    const { code } = request.params as { code: string };
    const entry = await service.getCatalogEntry(app.db, code);
    return success(entry);
  });
}
