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

    const result = await service.listDeployments(app.db, clientId, paginationParams);
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

    await restartDeployment(k8s, namespace, deployment.name, components);

    return success({ message: 'Rolling restart initiated' });
  });

  // DELETE /api/v1/clients/:clientId/deployments/:id
  app.delete('/clients/:clientId/deployments/:id', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    await service.deleteDeployment(app.db, clientId, id, getK8s());
    reply.status(204).send();
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
