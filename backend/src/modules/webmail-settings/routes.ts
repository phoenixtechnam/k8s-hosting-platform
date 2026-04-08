import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { getWebmailSettings, updateWebmailSettings } from './service.js';
import { updateWebmailSettingsSchema } from '@k8s-hosting/api-contracts';

export async function webmailSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/webmail-settings
  app.get('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Get platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getWebmailSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/webmail-settings
  app.patch('/admin/webmail-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Webmail Settings'],
      summary: 'Update platform webmail settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = updateWebmailSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const settings = await updateWebmailSettings(app.db, parsed.data);
    return success(settings);
  });
}
