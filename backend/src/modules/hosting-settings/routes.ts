import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { updateHostingSettingsSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function hostingSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/clients/:clientId/domains/:domainId/hosting-settings
  app.get('/clients/:clientId/domains/:domainId/hosting-settings', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const settings = await service.getHostingSettings(app.db, clientId, domainId);
    return success(settings);
  });

  // PATCH /api/v1/clients/:clientId/domains/:domainId/hosting-settings
  app.patch('/clients/:clientId/domains/:domainId/hosting-settings', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = updateHostingSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateHostingSettings(app.db, clientId, domainId, parsed.data);
    return success(updated);
  });
}
