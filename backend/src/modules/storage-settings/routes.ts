import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { updateStorageSettingsSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';

export async function storageSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/storage-settings
  app.get('/admin/storage-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Storage Settings'],
      summary: 'Get platform storage configuration',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await service.getStorageSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/storage-settings
  app.patch('/admin/storage-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Storage Settings'],
      summary: 'Update platform storage configuration',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = updateStorageSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);
    }

    const updated = await service.updateStorageSettings(app.db, parsed.data);
    return success(updated);
  });
}
