import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectClusterHealth } from './service.js';

export async function clusterHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/cluster-health
  // Returns Deployment / DaemonSet readiness for a curated set of
  // infrastructure components (CNPG, cert-manager, ingress-nginx,
  // longhorn-manager, flux). Used by the admin panel's cluster-health
  // card; no Prometheus dependency.
  app.get('/admin/cluster-health', {
    schema: {
      tags: ['ClusterHealth'],
      summary: 'Readiness of key infrastructure Deployments/DaemonSets',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const components = await collectClusterHealth(k8s);
    return success({ components });
  });
}
