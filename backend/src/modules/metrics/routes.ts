import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { metricsQuerySchema } from './schema.js';
import * as service from './service.js';
import { getCachedMetrics, getAllCachedMetrics, collectClientMetrics } from './resource-metrics.js';
import { getClientById } from '../clients/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients, hostingPlans } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

/**
 * Resolve effective plan limits for a client, applying per-client overrides.
 */
async function resolvePlanLimits(
  db: Parameters<typeof service.getMetrics>[0],
  client: Awaited<ReturnType<typeof getClientById>>,
): Promise<{ cpuLimit: number; memoryLimitGi: number; storageLimitGi: number }> {
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId));

  return {
    cpuLimit: Number(client.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
    memoryLimitGi: Number(client.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
    storageLimitGi: Number(client.storageLimitOverride ?? plan?.storageLimit ?? 50),
  };
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // ─── Historical metrics (existing) ──────────────────────────────────────────

  // GET /api/v1/clients/:id/metrics
  app.get('/clients/:id/metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const parsed = metricsQuerySchema.parse(query);
    const metrics = await service.getMetrics(app.db, id, parsed);
    return success(metrics);
  });

  // ─── Real-time resource metrics (new, Redis-cached) ─────────────────────────

  // GET /api/v1/clients/:id/resource-metrics — get cached or collect on-demand
  app.get('/clients/:id/resource-metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only', 'client_admin', 'client_user'), requireClientAccess()],
  }, async (request) => {
    const { id } = request.params as { id: string };

    // Try cache first
    const cached = await getCachedMetrics(id);
    if (cached) return success(cached);

    // Cache miss — collect on-demand
    const client = await getClientById(app.db, id);
    if (client.provisioningStatus !== 'provisioned') {
      throw new ApiError('CLIENT_NOT_PROVISIONED', 'Client is not provisioned yet', 409);
    }

    let k8s: ReturnType<typeof createK8sClients>;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not reachable', 503);
    }

    const planLimits = await resolvePlanLimits(app.db, client);
    const metrics = await collectClientMetrics(app.db, k8s, id, client.kubernetesNamespace, planLimits);
    return success(metrics);
  });

  // POST /api/v1/clients/:id/resource-metrics/refresh — force refresh
  app.post('/clients/:id/resource-metrics/refresh', {
    preHandler: [requireRole('admin', 'super_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const client = await getClientById(app.db, id);

    if (client.provisioningStatus !== 'provisioned') {
      throw new ApiError('CLIENT_NOT_PROVISIONED', 'Client is not provisioned yet', 409);
    }

    let k8s: ReturnType<typeof createK8sClients>;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not reachable', 503);
    }

    const planLimits = await resolvePlanLimits(app.db, client);
    const metrics = await collectClientMetrics(app.db, k8s, id, client.kubernetesNamespace, planLimits);
    return success(metrics);
  });

  // GET /api/v1/admin/clients/resource-metrics — bulk get metrics for all clients
  app.get('/admin/clients/resource-metrics', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const allClients = await app.db.select({ id: clients.id }).from(clients);
    const clientIds = allClients.map(c => c.id);
    const metricsMap = await getAllCachedMetrics(clientIds);
    return success(metricsMap);
  });
}
