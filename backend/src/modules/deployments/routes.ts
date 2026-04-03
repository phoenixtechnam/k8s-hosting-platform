import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createDeploymentSchema, updateDeploymentSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileDeploymentStatuses } from './status-reconciler.js';
import { restartDeployment } from './k8s-deployer.js';
import * as dbManager from './db-manager.js';
import { generateSecurePassword } from './service.js';
import { eq } from 'drizzle-orm';
import { catalogEntries } from '../../db/schema.js';

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  // Lazy-init K8s clients (null if no kubeconfig available)
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  // POST /api/v1/clients/:clientId/deployments
  app.post('/clients/:clientId/deployments', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const deployment = await service.createDeployment(app.db, clientId, parsed.data, request.user.sub, getK8s());
    reply.status(201).send(success(deployment));
  });

  // GET /api/v1/clients/:clientId/deployments
  app.get('/clients/:clientId/deployments', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const includeDeleted = query.include_deleted === 'true' || query.include_deleted === '1';

    const result = await service.listDeployments(app.db, clientId, { ...paginationParams, includeDeleted });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:clientId/deployments/:id
  app.get('/clients/:clientId/deployments/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const deployment = await service.getDeploymentById(app.db, clientId, id);
    return success(deployment);
  });

  // PATCH /api/v1/clients/:clientId/deployments/:id
  app.patch('/clients/:clientId/deployments/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const parsed = updateDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDeployment(app.db, clientId, id, parsed.data, getK8s());
    return success(updated);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/credentials
  app.get('/clients/:clientId/deployments/:id/credentials', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const result = await service.getDeploymentCredentials(app.db, clientId, id);
    return success(result);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/regenerate-credentials
  app.post('/clients/:clientId/deployments/:id/regenerate-credentials', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { keys?: string[] };
    const result = await service.regenerateDeploymentCredentials(app.db, clientId, id, body.keys);
    return success(result);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/restart
  app.post('/clients/:clientId/deployments/:id/restart', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const deployment = await service.getDeploymentById(app.db, clientId, id);

    const k8s = getK8s();
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes cluster is not available',
        503,
        {},
        'Check that kubeconfig is configured',
      );
    }

    const components = await service.resolveDeploymentComponents(app.db, deployment);
    const namespace = await service.getClientNamespace(app.db, clientId);

    await restartDeployment(k8s, namespace, deployment.name, deployment.resourceSuffix, components);

    return success({ message: 'Rolling restart initiated' });
  });

  // POST /api/v1/clients/:clientId/deployments/:id/restore
  app.post('/clients/:clientId/deployments/:id/restore', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const restored = await service.restoreDeployment(app.db, clientId, id, getK8s());
    return success(restored);
  });

  // ─── Database Management Routes ──────────────────────────────────────────

  async function buildDbCtx(clientId: string, deploymentId: string) {
    const k8s = getK8s();
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes cluster is not available',
        503,
        {},
        'Check that kubeconfig is configured',
      );
    }

    const deployment = await service.getDeploymentById(app.db, clientId, deploymentId);
    const [entry] = await app.db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.id, deployment.catalogEntryId));

    if (!entry) {
      throw new ApiError('CATALOG_ENTRY_NOT_FOUND', 'Catalog entry not found', 404);
    }
    if (entry.type !== 'database') {
      throw new ApiError(
        'NOT_A_DATABASE',
        'This deployment is not a database instance',
        400,
        { type: entry.type },
      );
    }

    const namespace = await service.getClientNamespace(app.db, clientId);
    const config = service.parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const baseName = `${deployment.name}-${deployment.resourceSuffix}`;

    const ctx = await dbManager.buildDbContext(k8s, kubeconfigPath, namespace, baseName, entry, config);
    return ctx;
  }

  // GET /api/v1/clients/:clientId/deployments/:id/databases
  app.get('/clients/:clientId/deployments/:id/databases', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const ctx = await buildDbCtx(clientId, id);
    const databases = await dbManager.listDatabases(ctx);
    return success(databases);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/databases
  app.post('/clients/:clientId/deployments/:id/databases', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Database name is required', 400, { field: 'name' });
    }

    const ctx = await buildDbCtx(clientId, id);
    await dbManager.createDatabase(ctx, body.name);
    reply.status(201).send(success({ name: body.name }));
  });

  // DELETE /api/v1/clients/:clientId/deployments/:id/databases/:dbName
  app.delete('/clients/:clientId/deployments/:id/databases/:dbName', async (request, reply) => {
    const { clientId, id, dbName } = request.params as { clientId: string; id: string; dbName: string };
    const ctx = await buildDbCtx(clientId, id);
    await dbManager.dropDatabase(ctx, dbName);
    reply.status(204).send();
  });

  // GET /api/v1/clients/:clientId/deployments/:id/db-users
  app.get('/clients/:clientId/deployments/:id/db-users', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const ctx = await buildDbCtx(clientId, id);
    const users = await dbManager.listUsers(ctx);
    return success(users);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/db-users
  app.post('/clients/:clientId/deployments/:id/db-users', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { username?: string; database?: string };
    if (!body.username) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Username is required', 400, { field: 'username' });
    }

    const password = generateSecurePassword(24);
    const ctx = await buildDbCtx(clientId, id);
    await dbManager.createUser(ctx, body.username, password, body.database);
    reply.status(201).send(success({
      username: body.username,
      password,
      database: body.database ?? null,
    }));
  });

  // DELETE /api/v1/clients/:clientId/deployments/:id/db-users/:username
  app.delete('/clients/:clientId/deployments/:id/db-users/:username', async (request, reply) => {
    const { clientId, id, username } = request.params as { clientId: string; id: string; username: string };
    const ctx = await buildDbCtx(clientId, id);
    await dbManager.dropUser(ctx, username);
    reply.status(204).send();
  });

  // POST /api/v1/clients/:clientId/deployments/:id/db-users/:username/password
  app.post('/clients/:clientId/deployments/:id/db-users/:username/password', async (request) => {
    const { clientId, id, username } = request.params as { clientId: string; id: string; username: string };

    const password = generateSecurePassword(24);
    const ctx = await buildDbCtx(clientId, id);
    await dbManager.setUserPassword(ctx, username, password);
    return success({ username, password });
  });

  // ─── Database Query & Browsing Routes ───────────────────────────────────

  // POST /api/v1/clients/:clientId/deployments/:id/query
  app.post('/clients/:clientId/deployments/:id/query', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { database?: string; query?: string };

    if (!body.database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Database name is required', 400, { field: 'database' });
    }
    if (!body.query) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Query is required', 400, { field: 'query' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const result = await dbManager.executeQuery(ctx, body.database, body.query);
    return success(result);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/tables?database=mydb
  app.get('/clients/:clientId/deployments/:id/tables', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const tables = await dbManager.listTables(ctx, database);
    return success(tables);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/table-structure?database=mydb&table=users
  app.get('/clients/:clientId/deployments/:id/table-structure', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;
    const table = query.table as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const columns = await dbManager.describeTable(ctx, database, table);
    return success(columns);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/table-data?database=mydb&table=users&limit=50&offset=0&orderBy=id&orderDir=desc
  app.get('/clients/:clientId/deployments/:id/table-data', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;
    const table = query.table as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const limit = query.limit ? parseInt(String(query.limit), 10) : undefined;
    const offset = query.offset ? parseInt(String(query.offset), 10) : undefined;
    const orderBy = query.orderBy as string | undefined;
    const orderDir = (query.orderDir as string | undefined) === 'desc' ? 'desc' as const : 'asc' as const;

    const ctx = await buildDbCtx(clientId, id);
    const result = await dbManager.browseTable(ctx, database, table, { limit, offset, orderBy, orderDir });
    return success(result);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/row-count?database=mydb&table=users
  app.get('/clients/:clientId/deployments/:id/row-count', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;
    const table = query.table as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const count = await dbManager.countRows(ctx, database, table);
    return success({ count });
  });

  // POST /api/v1/clients/:clientId/deployments/:id/export?database=mydb
  app.post('/clients/:clientId/deployments/:id/export', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const dump = await dbManager.exportDatabase(ctx, database);

    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${database}-export.sql"`)
      .send(dump);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/import
  app.post('/clients/:clientId/deployments/:id/import', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { database?: string; sql?: string };

    if (!body.database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Database name is required', 400, { field: 'database' });
    }
    if (!body.sql) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'SQL content is required', 400, { field: 'sql' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const result = await dbManager.importSql(ctx, body.database, body.sql);
    return success(result);
  });

  // DELETE /api/v1/clients/:clientId/deployments/:id
  // ?force=true for permanent deletion (skips soft-delete)
  app.delete('/clients/:clientId/deployments/:id', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const force = query.force === 'true' || query.force === '1';

    if (force) {
      await service.hardDeleteDeployment(app.db, clientId, id, getK8s());
    } else {
      await service.deleteDeployment(app.db, clientId, id, getK8s());
    }
    reply.status(204).send();
  });

  // GET /api/v1/clients/:clientId/resource-usage — namespace resource usage from K8s quota
  app.get('/clients/:clientId/resource-usage', {
    schema: {
      tags: ['Deployments'],
      summary: 'Get resource usage from K8s ResourceQuota',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const k8s = getK8s();
    if (!k8s) {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);
    }

    const namespace = await service.getClientNamespace(app.db, clientId);
    const quotaName = `${namespace}-quota`;

    try {
      const quota = await k8s.core.readNamespacedResourceQuota({ name: quotaName, namespace });
      const quotaObj = quota as {
        status?: {
          used?: Record<string, string>;
          hard?: Record<string, string>;
        };
      };

      const used = quotaObj.status?.used ?? {};
      const hard = quotaObj.status?.hard ?? {};

      return success({
        cpu: { used: used['limits.cpu'] ?? '0', limit: hard['limits.cpu'] ?? '0' },
        memory: { used: used['limits.memory'] ?? '0', limit: hard['limits.memory'] ?? '0' },
        storage: { used: used['requests.storage'] ?? '0', limit: hard['requests.storage'] ?? '0' },
      });
    } catch (err: unknown) {
      // If quota doesn't exist yet, return zeroes
      if (err instanceof Error && err.message.includes('HTTP-Code: 404')) {
        return success({
          cpu: { used: '0', limit: '0' },
          memory: { used: '0', limit: '0' },
          storage: { used: '0', limit: '0' },
        });
      }
      throw err;
    }
  });

  // POST /api/v1/admin/deployments/reconcile — admin-only, reconcile all deployment statuses
  app.post('/admin/deployments/reconcile', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Deployments'],
      summary: 'Reconcile all deployment statuses from K8s cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const k8s = getK8s();
    if (!k8s) {
      return success({ checked: 0, updated: 0, errors: ['K8s cluster not available'] });
    }
    const result = await reconcileDeploymentStatuses(app.db, k8s);
    return success(result);
  });
}
