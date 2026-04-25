import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { checkClientNamespaceIntegrity, sweepFleetIntegrity } from './service.js';

export async function namespaceIntegrityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/clients/:id/namespace-integrity
  // Read-only audit. UI shows findings; the operator triggers repair via POST.
  app.get('/admin/clients/:id/namespace-integrity', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Audit a client namespace for missing platform resources',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new ApiError('INVALID_FIELD_VALUE', 'Invalid client id', 400, { field: 'id' });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const report = await checkClientNamespaceIntegrity(app.db, k8s, id, false);
    return success(report);
  });

  // POST /api/v1/admin/clients/:id/namespace-integrity/repair
  // Re-runs the inspect + repair against k8s and writes a notification
  // row for every admin user when something was repaired or errored.
  app.post('/admin/clients/:id/namespace-integrity/repair', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Run the namespace-integrity reconciler for a single client',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new ApiError('INVALID_FIELD_VALUE', 'Invalid client id', 400, { field: 'id' });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const report = await checkClientNamespaceIntegrity(app.db, k8s, id, true);
    return success(report);
  });

  // POST /api/v1/admin/namespace-integrity/sweep
  // Fleet-wide repair pass (the same code that the cron sweep runs).
  app.post('/admin/namespace-integrity/sweep', {
    schema: {
      tags: ['NamespaceIntegrity'],
      summary: 'Run the namespace-integrity reconciler across all provisioned clients',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await sweepFleetIntegrity(app.db, k8s);
    return success(result);
  });
}
