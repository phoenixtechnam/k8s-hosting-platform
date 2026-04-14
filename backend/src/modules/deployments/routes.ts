import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess, requireClientRoleByMethod } from '../../middleware/auth.js';
import { createDeploymentSchema, updateDeploymentSchema, updateDeploymentResourcesSchema } from './schema.js';
import * as service from './service.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileDeploymentStatuses } from './status-reconciler.js';
import { restartDeployment } from './k8s-deployer.js';
import * as dbManager from './db-manager.js';
import { generateSecurePassword } from './service.js';
import { eq, and, inArray } from 'drizzle-orm';
import { catalogEntries, deployments, clients } from '../../db/schema.js';
import { fileManagerRequest } from '../file-manager/service.js';

const FM_IMAGE = 'file-manager-sidecar:latest';

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read for all client roles,
  // writes only for client_admin + staff.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
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

  // GET /api/v1/clients/:clientId/deployments/storage-folders?type=database&code=mariadb
  app.get('/clients/:clientId/deployments/storage-folders', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const entryType = String(query.type ?? '');
    const entryCode = String(query.code ?? '');

    if (!entryType || !entryCode) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        'Both type and code query parameters are required',
        400,
        { field: 'type, code' },
      );
    }

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const result = await service.listStorageFolders(app.db, clientId, entryType, entryCode, getK8s(), kubeconfigPath);
    return success(result);
  });

  // GET /api/v1/clients/:clientId/deployments/:id
  app.get('/clients/:clientId/deployments/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const deployment = await service.getDeploymentWithVolumePaths(app.db, clientId, id);
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

    // Clear any previous error when deployment transitions to running
    if (parsed.data.status === 'running') {
      await service.clearDeploymentError(app.db, id);
    }

    return success(updated);
  });

  // PATCH /api/v1/clients/:clientId/deployments/:id/resources
  app.patch('/clients/:clientId/deployments/:id/resources', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const parsed = updateDeploymentResourcesSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDeploymentResources(app.db, clientId, id, parsed.data, getK8s());
    return success(updated);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/resource-availability
  app.get('/clients/:clientId/deployments/:id/resource-availability', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const availability = await service.getResourceAvailability(app.db, clientId, id);
    return success(availability);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/credentials
  app.get('/clients/:clientId/deployments/:id/credentials', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const result = await service.getDeploymentCredentials(app.db, clientId, id);
    return success(result);
  });

  // POST /api/v1/clients/:clientId/deployments/:id/regenerate-credentials
  // Deprecated: credential regeneration is no longer supported. Credentials are
  // generated once at deployment time and treated as read-only by the platform.
  app.post('/clients/:clientId/deployments/:id/regenerate-credentials', async (_request, reply) => {
    reply.status(410).send({
      error: 'FEATURE_REMOVED',
      message: 'Credential regeneration is not supported. Credentials are set at deployment time.',
    });
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

    await restartDeployment(k8s, namespace, deployment.name, components);

    // Clear any previous error on successful restart initiation
    if (deployment.lastError) {
      await service.clearDeploymentError(app.db, id);
    }

    return success({ message: 'Rolling restart initiated' });
  });

  // GET /api/v1/clients/:clientId/deployments/:id/logs?lines=100
  app.get('/clients/:clientId/deployments/:id/logs', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const tailLines = Math.min(parseInt(String(query.lines ?? '200'), 10) || 200, 1000);

    const deployment = await service.getDeploymentById(app.db, clientId, id);
    const namespace = await service.getClientNamespace(app.db, clientId);
    const k8s = getK8s();
    if (!k8s) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

    // Find the pod for this deployment
    const podList = await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${deployment.name}`,
    });
    const pods = (podList as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string; containerStatuses?: readonly { lastState?: { terminated?: { reason?: string } } }[] } }[] }).items ?? [];
    const runningPod = pods.find(p => p.status?.phase === 'Running') ?? pods[0];

    if (!runningPod?.metadata?.name) {
      throw new ApiError('POD_NOT_FOUND', 'No pod found for this deployment', 404);
    }

    const podName = runningPod.metadata.name;

    // Detect termination reason from container statuses
    let terminationReason: string | null = null;
    for (const cs of runningPod.status?.containerStatuses ?? []) {
      const reason = cs.lastState?.terminated?.reason;
      if (reason) {
        terminationReason = reason;
        break;
      }
    }

    // Fetch application logs
    const logResult = await k8s.core.readNamespacedPodLog({
      name: podName,
      namespace,
      tailLines,
    });
    const logText = typeof logResult === 'string' ? logResult : String(logResult);

    type LogLine = { source: string; text: string; timestamp: string; level: string };
    const lines: LogLine[] = [];

    // Parse application log lines with level detection
    for (const raw of logText.split('\n')) {
      if (!raw) continue;
      const upper = raw.toUpperCase();
      let level = 'info';
      if (upper.includes('ERROR') || upper.includes('FATAL')) level = 'error';
      else if (upper.includes('WARN')) level = 'warning';

      // Try to extract a leading timestamp (ISO 8601 or common log formats)
      const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)/);
      const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();

      lines.push({ source: 'APP', text: raw, timestamp, level });
    }

    // Fetch K8s events for this pod
    try {
      const eventList = await k8s.core.listNamespacedEvent({
        namespace,
        fieldSelector: `involvedObject.name=${podName}`,
      });
      for (const evt of eventList.items ?? []) {
        const level = evt.type === 'Warning' ? 'error' : 'info';
        const timestamp = evt.lastTimestamp
          ? new Date(evt.lastTimestamp).toISOString()
          : (evt.eventTime ? String(evt.eventTime) : new Date().toISOString());
        lines.push({
          source: 'K8S',
          text: evt.message ?? evt.reason ?? 'Unknown event',
          timestamp,
          level,
        });
      }
    } catch {
      // Events API may not be available — continue with app logs only
    }

    // Sort by timestamp (oldest first, newest last)
    lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return success({
      podName,
      lines,
      terminationReason,
      tailLines,
    });
  });

  // GET /api/v1/clients/:clientId/deployments/:id/live-metrics
  app.get('/clients/:clientId/deployments/:id/live-metrics', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };

    const deployment = await service.getDeploymentById(app.db, clientId, id);
    const namespace = await service.getClientNamespace(app.db, clientId);
    const k8s = getK8s();
    if (!k8s) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

    const { parseResourceValue } = await import('../../shared/resource-parser.js');

    // Get actual usage from Metrics API
    let cpuUsed = 0;
    let memoryUsedMi = 0;
    try {
      const metricsResult = await k8s.custom.listNamespacedCustomObject({
        group: 'metrics.k8s.io',
        version: 'v1beta1',
        namespace,
        plural: 'pods',
      });
      type PodMetric = { metadata?: { labels?: Record<string, string> }; containers?: readonly { usage?: { cpu?: string; memory?: string } }[] };
      const pods = (metricsResult as { items?: readonly PodMetric[] }).items ?? [];
      for (const pod of pods) {
        if (pod.metadata?.labels?.['app'] !== deployment.name) continue;
        for (const c of pod.containers ?? []) {
          if (c.usage?.cpu) cpuUsed += parseResourceValue(c.usage.cpu, 'cpu');
          if (c.usage?.memory) memoryUsedMi += parseResourceValue(c.usage.memory, 'memory') * 1024;
        }
      }
    } catch {
      // Metrics API not available
    }

    // Get per-deployment disk usage via file-manager
    let storageUsedBytes = 0;
    let storageUsedFormatted = '0 B';
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const fmResult = await fileManagerRequest(k8s, kubeconfigPath, namespace, FM_IMAGE, '/folder-size', {
        query: { path: deployment.storagePath ? `/${deployment.storagePath}` : `/databases/${deployment.name}` },
      });
      if (fmResult.status === 200) {
        const parsed = JSON.parse(fmResult.body) as { sizeBytes?: number; sizeFormatted?: string };
        storageUsedBytes = parsed.sizeBytes ?? 0;
        storageUsedFormatted = parsed.sizeFormatted ?? '0 B';
      }
    } catch {
      // File manager not available — return zero storage
    }

    return success({
      cpuUsed: Math.round(cpuUsed * 1000) / 1000,
      cpuRequest: deployment.cpuRequest,
      memoryUsedMi: Math.round(memoryUsedMi),
      memoryRequest: deployment.memoryRequest,
      storageUsedBytes,
      storageUsedFormatted,
    });
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

    // Find the database component — either standalone DB or embedded in a multi-component app
    const components = service.parseJsonField<Array<{ name: string; database?: string }>>(entry.components) ?? [];
    const dbComponent = components.find(c => c.database);

    if (!dbComponent?.database) {
      throw new ApiError(
        'NOT_A_DATABASE',
        'This deployment has no manageable database component',
        400,
        { type: entry.type },
      );
    }

    const namespace = await service.getClientNamespace(app.db, clientId);
    const config = service.parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;

    // For multi-component apps, the DB pod name is {deployment}-{componentName}
    // For single-component, it's just {deployment}
    const dbPodDeploymentName = components.length > 1
      ? `${deployment.name}-${dbComponent.name}`
      : deployment.name;

    const ctx = await dbManager.buildDbContext(
      k8s, kubeconfigPath, namespace, dbPodDeploymentName, entry,
      config, dbComponent.database as dbManager.Engine, dbComponent.name,
    );
    const deploymentSubPath = deployment.storagePath ?? `databases/${deployment.name}`;
    return { ...ctx, deploymentSubPath };
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
  // Returns table names with sizes
  app.get('/clients/:clientId/deployments/:id/tables', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }

    const ctx = await buildDbCtx(clientId, id);
    const tables = await dbManager.listTablesWithSize(ctx, database);
    return success(tables);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/databases-with-size
  // Returns database names with total sizes
  app.get('/clients/:clientId/deployments/:id/databases-with-size', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const ctx = await buildDbCtx(clientId, id);
    const databases = await dbManager.listDatabasesWithSize(ctx);
    return success(databases);
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
    const orderDir = (query.orderDir as string | undefined)?.toLowerCase() === 'desc' ? 'desc' as const : 'asc' as const;

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

  // POST /api/v1/clients/:clientId/deployments/:id/export?database=mydb&output_path=/exports
  // Export database dump to PVC. If output_path is given, writes to PVC and returns path.
  // Otherwise returns the dump as a downloadable file (for small DBs).
  app.post('/clients/:clientId/deployments/:id/export', async (request, _reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const query = request.query as Record<string, unknown>;
    const database = query.database as string | undefined;

    if (!database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'database query parameter is required', 400, { field: 'database' });
    }

    const { deploymentSubPath, ...ctx } = await buildDbCtx(clientId, id);

    // PVC-based export (recommended for large databases)
    const fileName = `${database}-export-${Date.now()}.sql`;
    const result = await dbManager.exportDatabaseToPvc(ctx, database, fileName, deploymentSubPath);

    return success({
      pvcPath: result.pvcPath,
      sizeBytes: result.sizeBytes,
      fileName,
      message: `Exported to ${result.pvcPath} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    });
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

  // POST /api/v1/clients/:clientId/deployments/:id/import-from-file
  // Import SQL from a file on the shared PVC. The file is copied into the
  // database pod's subPath, then piped to the database CLI. Handles files of any size.
  app.post('/clients/:clientId/deployments/:id/import-from-file', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = (request.body ?? {}) as { database?: string; file_path?: string };

    if (!body.database) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'Database name is required', 400, { field: 'database' });
    }
    if (!body.file_path) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'File path is required', 400, { field: 'file_path' });
    }

    if (body.file_path.includes('..')) {
      throw new ApiError('INVALID_PATH', 'File path cannot contain ".." traversal', 400);
    }

    // Strip leading slash — the PVC file picker returns paths relative to /data/ root
    const filePath = body.file_path.replace(/^\/+/, '');

    const { deploymentSubPath, ...ctx } = await buildDbCtx(clientId, id);
    const result = await dbManager.importSqlFromPvcFile(ctx, body.database, '', filePath, deploymentSubPath);
    return success(result);
  });

  // GET /api/v1/clients/:clientId/deployments/:id/delete-preview
  app.get('/clients/:clientId/deployments/:id/delete-preview', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const result = await service.getDeletePreview(app.db, clientId, id);
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
      reply.status(204).send();
    } else {
      const preview = await service.getDeletePreview(app.db, clientId, id);
      await service.deleteDeployment(app.db, clientId, id, getK8s());
      reply.status(200).send(success(preview));
    }
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

  // POST /api/v1/admin/deployments/bulk-restart — restart all running deployments
  // Optional filter: { catalog_entry_id?: string }
  app.post('/admin/deployments/bulk-restart', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Deployments'],
      summary: 'Bulk restart running deployments (pulls latest images)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const k8s = getK8s();
    if (!k8s) {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);
    }

    const body = (request.body ?? {}) as { catalog_entry_id?: string };
    const conditions = [eq(deployments.status, 'running')];
    if (body.catalog_entry_id) {
      conditions.push(eq(deployments.catalogEntryId, body.catalog_entry_id));
    }

    const runningDeployments = await app.db
      .select({
        id: deployments.id,
        name: deployments.name,
        clientId: deployments.clientId,
        catalogEntryId: deployments.catalogEntryId,
      })
      .from(deployments)
      .where(and(...conditions));

    // Group by client for namespace lookup
    const clientIds = [...new Set(runningDeployments.map(d => d.clientId))];
    const clientRows = await app.db
      .select({ id: clients.id, kubernetesNamespace: clients.kubernetesNamespace })
      .from(clients)
      .where(inArray(clients.id, clientIds));

    const nsMap = new Map(clientRows.map(c => [c.id, c.kubernetesNamespace]));

    let restarted = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const dep of runningDeployments) {
      const namespace = nsMap.get(dep.clientId);
      if (!namespace) continue;

      try {
        await restartDeployment(k8s, namespace, dep.name,
          await service.resolveDeploymentComponents(app.db, dep as typeof deployments.$inferSelect));
        restarted++;
      } catch (err) {
        failed++;
        errors.push(`${dep.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return success({ restarted, failed, total: runningDeployments.length, errors });
  });
}
