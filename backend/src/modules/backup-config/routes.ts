import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import type { CreateBackupConfigInput, UpdateBackupConfigInput } from '@k8s-hosting/api-contracts';

export async function backupConfigRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/backup-configs
  app.get('/admin/backup-configs', async () => {
    return success(await service.listBackupConfigs(app.db));
  });

  // POST /api/v1/admin/backup-configs
  app.post('/admin/backup-configs', async (request, reply) => {
    const input = request.body as unknown as CreateBackupConfigInput;
    if (!input.name || !input.storage_type) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'name and storage_type are required', 400);
    }
    const config = await service.createBackupConfig(app.db, input, encryptionKey);
    reply.status(201).send(success(config));
  });

  // PATCH /api/v1/admin/backup-configs/:id
  app.patch('/admin/backup-configs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as unknown as UpdateBackupConfigInput;
    const updated = await service.updateBackupConfig(app.db, id, input, encryptionKey);
    return success(updated);
  });

  // DELETE /api/v1/admin/backup-configs/:id
  app.delete('/admin/backup-configs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteBackupConfig(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/backup-configs/:id/test
  app.post('/admin/backup-configs/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testConnection(app.db, id, encryptionKey);
    return success(result);
  });
}
