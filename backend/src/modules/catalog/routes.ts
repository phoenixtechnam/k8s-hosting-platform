import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createCatalogRepoSchema, updateCatalogRepoSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // ─── Public: Catalog browsing (any authenticated user) ────────────────────

  // GET /api/v1/catalog — browse all catalog entries (filterable)
  app.get('/catalog', {
    onRequest: [authenticate],
    schema: {
      tags: ['Catalog'],
      summary: 'List catalog entries (public, filterable by type/category/search)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);

    const type = typeof query.type === 'string' ? query.type : undefined;
    const category = typeof query.category === 'string' ? query.category : undefined;
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listCatalogEntries(app.db, {
      ...paginationParams,
      type,
      category,
      search,
    });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/catalog/:id — single entry detail
  app.get('/catalog/:id', {
    onRequest: [authenticate],
    schema: {
      tags: ['Catalog'],
      summary: 'Get a single catalog entry by ID',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const entry = await service.getCatalogEntryById(app.db, id);
    return success(entry);
  });

  // GET /api/v1/catalog/:id/icon — proxy the catalog entry's icon.png
  app.get('/catalog/:id/icon', {
    schema: {
      tags: ['Catalog'],
      summary: 'Get catalog entry icon',
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await service.getCatalogEntryById(app.db, id);

    if (!entry.manifestUrl) {
      reply.status(404).send();
      return;
    }

    const iconUrl = entry.manifestUrl.replace(/manifest\.json$/, 'icon.png');

    try {
      const response = await fetch(iconUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        reply.status(404).send();
        return;
      }
      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'public, max-age=86400');
      const buffer = Buffer.from(await response.arrayBuffer());
      reply.send(buffer);
    } catch {
      reply.status(404).send();
    }
  });

  // ─── Admin: Repository management ────────────────────────────────────────

  // GET /api/v1/admin/catalog-repos
  app.get('/admin/catalog-repos', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'List all catalog repositories',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const repos = await service.listCatalogRepos(app.db);
    return success(repos);
  });

  // POST /api/v1/admin/catalog-repos
  app.post('/admin/catalog-repos', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'Add a catalog repository',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = createCatalogRepoSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const repo = await service.createCatalogRepo(app.db, parsed.data);
    reply.status(201).send(success(repo));
  });

  // PATCH /api/v1/admin/catalog-repos/:id
  app.patch('/admin/catalog-repos/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'Update a catalog repository',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateCatalogRepoSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const repo = await service.updateCatalogRepo(app.db, id, parsed.data);
    return success(repo);
  });

  // DELETE /api/v1/admin/catalog-repos/:id
  app.delete('/admin/catalog-repos/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'Delete a catalog repository and its entries',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteCatalogRepo(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/catalog-repos/:id/sync
  app.post('/admin/catalog-repos/:id/sync', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'Trigger manual sync of a catalog repository',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.syncCatalogRepo(app.db, id);
    return success(result);
  });

  // POST /api/v1/admin/catalog-repos/restore-default
  app.post('/admin/catalog-repos/restore-default', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Catalog Repos'],
      summary: 'Restore the default catalog repository',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const repo = await service.restoreDefaultRepo(app.db);
    return success(repo);
  });
}
