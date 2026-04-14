import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import * as service from './service.js';
import { z } from 'zod';

const updateSchema = z.object({
  platformName: z.string().min(1).max(255).optional(),
  adminPanelUrl: z.string().url().max(500).optional().nullable(),
  clientPanelUrl: z.string().url().max(500).optional().nullable(),
  supportEmail: z.string().email().max(255).optional().nullable(),
  supportUrl: z.string().url().max(500).optional().nullable(),
  ingressBaseDomain: z.string().max(255).optional().nullable(),
  mailHostname: z.string().max(255).optional().nullable(),
  webmailUrl: z.string().url().max(500).optional().nullable(),
  apiRateLimit: z.number().int().min(1).max(10000).optional(),
});

export async function systemSettingsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/system-settings
  app.get('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Get platform system settings', security: [{ bearerAuth: [] }] },
  }, async () => {
    const settings = await service.getSettings(app.db);
    return success(settings);
  });

  // PATCH /api/v1/admin/system-settings
  app.patch('/admin/system-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['System Settings'], summary: 'Update platform system settings', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', parsed.error.errors[0].message, 400);
    }

    const updated = await service.updateSettings(app.db, parsed.data);
    return success(updated);
  });
}
