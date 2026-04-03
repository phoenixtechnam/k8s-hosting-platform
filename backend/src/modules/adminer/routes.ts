import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { clients } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  ensureAdminerRunning,
  getAdminerStatus,
  stopAdminer,
  proxyToAdminer,
  createLoginToken,
  consumeLoginToken,
  buildAutoLoginHtml,
} from './service.js';
import * as dbManager from '../deployments/db-manager.js';
import * as deploymentService from '../deployments/service.js';
import { catalogEntries } from '../../db/schema.js';

const ADMINER_IMAGE = 'adminer:4';

// ─── Track last access for idle-timeout cleanup ─────────────────────────────

const lastAccessMap = new Map<string, number>();

/**
 * Get the last access time for a namespace's Adminer pod.
 */
export function getAdminerLastAccess(namespace: string): number | undefined {
  return lastAccessMap.get(namespace);
}

/**
 * Set the last access time for a namespace's Adminer pod.
 */
function touchAdminerAccess(namespace: string): void {
  lastAccessMap.set(namespace, Date.now());
}

/**
 * Remove access tracking for a namespace.
 */
export function clearAdminerAccess(namespace: string): void {
  lastAccessMap.delete(namespace);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveNamespace(app: FastifyInstance, clientId: string): Promise<string> {
  const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  if (client.provisioningStatus !== 'provisioned') {
    throw new ApiError('NOT_PROVISIONED', 'Client must be provisioned before using Adminer', 409);
  }
  return client.kubernetesNamespace;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function adminerRoutes(app: FastifyInstance): Promise<void> {
  // Auth hooks applied per-route (auto-login and proxy routes do NOT require JWT)
  const authHooks = [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'), requireClientAccess()];

  const getK8s = () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    return { k8sClients: createK8sClients(kubeconfigPath), kubeconfigPath };
  };

  // GET /api/v1/clients/:clientId/adminer/status
  app.get('/clients/:clientId/adminer/status', {
    onRequest: authHooks,
    schema: { tags: ['Adminer'], summary: 'Get Adminer pod status', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    const status = await getAdminerStatus(k8sClients, namespace);
    return success(status);
  });

  // POST /api/v1/clients/:clientId/adminer/start
  app.post('/clients/:clientId/adminer/start', {
    onRequest: authHooks,
    schema: { tags: ['Adminer'], summary: 'Start Adminer pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    await ensureAdminerRunning(k8sClients, namespace, ADMINER_IMAGE);
    touchAdminerAccess(namespace);
    const status = await getAdminerStatus(k8sClients, namespace);
    return success(status);
  });

  // POST /api/v1/clients/:clientId/adminer/stop
  app.post('/clients/:clientId/adminer/stop', {
    onRequest: authHooks,
    schema: { tags: ['Adminer'], summary: 'Stop Adminer pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients } = getK8s();
    await stopAdminer(k8sClients, namespace);
    clearAdminerAccess(namespace);
    return success({ stopped: true });
  });

  // POST /api/v1/clients/:clientId/adminer/login
  // Body: { deploymentId, username }
  // Returns: { loginUrl }
  app.post('/clients/:clientId/adminer/login', {
    onRequest: authHooks,
    schema: { tags: ['Adminer'], summary: 'Generate Adminer auto-login URL', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const body = (request.body ?? {}) as { deploymentId?: string; username?: string };

    if (!body.deploymentId) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'deploymentId is required', 400, { field: 'deploymentId' });
    }
    if (!body.username) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'username is required', 400, { field: 'username' });
    }

    const namespace = await resolveNamespace(app, clientId);
    const { k8sClients, kubeconfigPath } = getK8s();

    // Ensure Adminer is running
    await ensureAdminerRunning(k8sClients, namespace, ADMINER_IMAGE);
    touchAdminerAccess(namespace);

    // Resolve the database deployment to get the connection details
    const deployment = await deploymentService.getDeploymentById(app.db, clientId, body.deploymentId);
    const [entry] = await app.db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.id, deployment.catalogEntryId));

    if (!entry) {
      throw new ApiError('CATALOG_ENTRY_NOT_FOUND', 'Catalog entry not found', 404);
    }
    if (entry.type !== 'database') {
      throw new ApiError('NOT_A_DATABASE', 'This deployment is not a database instance', 400);
    }

    const config = deploymentService.parseJsonField<Record<string, unknown>>(deployment.configuration) ?? {};
    const baseName = `${deployment.name}-${deployment.resourceSuffix}`;
    const ctx = await dbManager.buildDbContext(k8sClients, kubeconfigPath, namespace, baseName, entry, config);

    // The DB server address is the K8s service DNS name
    const server = `${baseName}.${namespace}.svc.cluster.local`;

    // Get the password — for root, use the root password from credentials;
    // for others, we can't retrieve the password (user must have set it)
    const credentials = await deploymentService.getDeploymentCredentials(app.db, clientId, body.deploymentId);
    let password = '';

    if (body.username === 'root') {
      // Look for root password in credentials
      const rootPasswordKey = Object.keys(credentials.credentials).find(
        k => k.toLowerCase().includes('root_password') || k.toLowerCase().includes('root-password'),
      );
      password = rootPasswordKey ? credentials.credentials[rootPasswordKey] : '';
    } else {
      // For non-root users, we cannot retrieve the password — user must enter it
      // We'll still generate the auto-login URL but with an empty password
      // so the user can fill it in via Adminer's form
      password = '';
    }

    const token = createLoginToken(clientId, server, body.username, password);
    const loginUrl = `/api/v1/clients/${clientId}/adminer/auto-login?token=${token}`;

    return success({ loginUrl });
  });

  // GET /api/v1/clients/:clientId/adminer/auto-login?token=xxx
  // Serves HTML that auto-submits credentials to Adminer proxy
  // No JWT auth — the one-time token in the URL IS the authentication
  app.get('/clients/:clientId/adminer/auto-login', {
    schema: { tags: ['Adminer'], summary: 'Auto-login to Adminer (HTML redirect)' },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as { token?: string };

    if (!query.token) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'token query parameter required', 400);
    }

    const loginData = consumeLoginToken(query.token, clientId);
    if (!loginData) {
      throw new ApiError('INVALID_TOKEN', 'Login token is invalid or expired', 401);
    }

    const proxyBaseUrl = `/api/v1/clients/${clientId}/adminer/proxy/`;
    const html = buildAutoLoginHtml(proxyBaseUrl, loginData.server, loginData.username, loginData.password);

    touchAdminerAccess(await resolveNamespace(app, clientId));

    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return reply.send(html);
  });

  // ALL /api/v1/clients/:clientId/adminer/proxy/* — proxy all requests to Adminer
  // No JWT auth — once user has auto-logged in, Adminer requests flow through unauthenticated
  app.all('/clients/:clientId/adminer/proxy/*', {
    schema: { tags: ['Adminer'], summary: 'Proxy request to Adminer pod' },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const namespace = await resolveNamespace(app, clientId);
    const { kubeconfigPath } = getK8s();

    touchAdminerAccess(namespace);

    // Extract the path after /proxy
    const fullUrl = request.url;
    const proxyPrefix = `/clients/${clientId}/adminer/proxy`;
    const adminerPath = fullUrl.slice(fullUrl.indexOf(proxyPrefix) + proxyPrefix.length) || '/';

    // Split path from query string
    const [pathOnly, queryString] = adminerPath.split('?');
    const queryParams: Record<string, string> = {};
    if (queryString) {
      const params = new URLSearchParams(queryString);
      for (const [k, v] of params) {
        queryParams[k] = v;
      }
    }

    // Collect request body
    let bodyContent: string | Buffer | undefined;
    const contentType = request.headers['content-type'] ?? '';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const raw = request.body;
      if (Buffer.isBuffer(raw)) {
        bodyContent = raw;
      } else if (typeof raw === 'string') {
        bodyContent = raw;
      } else if (raw != null) {
        bodyContent = JSON.stringify(raw);
      }
    }

    const result = await proxyToAdminer(kubeconfigPath, namespace, pathOnly, {
      method: request.method,
      body: bodyContent,
      contentType: contentType || undefined,
      query: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    });

    // Forward response headers (selectively)
    if (result.headers['content-type']) {
      reply.header('Content-Type', result.headers['content-type']);
    }
    if (result.headers['location']) {
      // Rewrite location header to go through proxy
      const location = result.headers['location'];
      reply.header('Location', `/api/v1/clients/${clientId}/adminer/proxy${location.startsWith('/') ? location : '/' + location}`);
    }
    if (result.headers['set-cookie']) {
      reply.header('Set-Cookie', result.headers['set-cookie']);
    }

    reply.status(result.status);
    return reply.send(result.bodyBuffer);
  });
}
