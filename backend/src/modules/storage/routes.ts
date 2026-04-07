import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { purgeImagesInputSchema } from '@k8s-hosting/api-contracts';
import { getStorageOverview, getImageInventory, purgeUnusedImages } from './service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function storageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/storage/overview — system + client storage usage
  app.get('/admin/storage/overview', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const overview = await getStorageOverview(app.db, k8s, kubeconfigPath);
    return success(overview);
  });

  // GET /api/v1/admin/storage/images — image inventory with in-use and protected flags
  app.get('/admin/storage/images', {
    preHandler: [requireRole('admin', 'super_admin', 'read_only')],
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const inventory = await getImageInventory(k8s);
    return success(inventory);
  });

  // POST /api/v1/admin/storage/purge — purge unused, non-protected images
  app.post('/admin/storage/purge', {
    preHandler: [requireRole('admin', 'super_admin')],
  }, async (request) => {
    const parsed = purgeImagesInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('INVALID_INPUT', 'Invalid purge input', 400, { errors: parsed.error.errors });
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await purgeUnusedImages(k8s, parsed.data.dryRun);
    return success(result);
  });
}
