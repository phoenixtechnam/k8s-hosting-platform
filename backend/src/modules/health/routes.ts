import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { runAllChecks } from './service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/health — run all health checks
  app.get('/admin/health', {
    onRequest: [requireRole('super_admin', 'admin', 'read_only')],
  }, async () => {
    const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    let k8sCore;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      k8sCore = k8s.core;
    } catch {
      // kubeconfig missing or invalid — checkKubernetes will report degraded
    }
    const result = await runAllChecks(app.db, encryptionKey, k8sCore);
    return success(result);
  });
}
