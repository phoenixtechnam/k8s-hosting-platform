import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { updateSettingsSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function platformUpdateRoutes(app: FastifyInstance): Promise<void> {
  // All platform-update routes require admin auth
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform/version
  app.get('/admin/platform/version', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Get current platform version and update availability',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                currentVersion: { type: 'string' },
                latestVersion: { type: 'string', nullable: true },
                updateAvailable: { type: 'boolean' },
                environment: { type: 'string' },
                autoUpdate: { type: 'boolean' },
                lastCheckedAt: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const info = await service.getVersionInfo(app.db);
    return success(info);
  });

  // PUT /api/v1/admin/platform/update-settings
  app.put('/admin/platform/update-settings', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Update auto-update preference',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['autoUpdate'],
        properties: {
          autoUpdate: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                autoUpdate: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'VALIDATION_ERROR',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const result = await service.updateSettings(app.db, parsed.data.autoUpdate);
    return success(result);
  });

  // POST /api/v1/admin/platform/update
  app.post('/admin/platform/update', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Trigger a manual platform update',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                targetVersion: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const result = await service.triggerUpdate(app.db);
    return success(result);
  });
}
