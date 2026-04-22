import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { updateSettingsSchema } from './schema.js';
import * as service from './service.js';
import { getImageInventory } from './image-inventory.js';
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
                imageUpdateStrategy: { type: 'string', enum: ['auto', 'manual'] },
                pendingVersion: { type: 'string', nullable: true },
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
      const firstError = parsed.error.issues[0];
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

  // GET /api/v1/admin/platform/images — enumerate platform-owned images
  app.get('/admin/platform/images', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'List container images currently running on the cluster for platform components',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const inventory = await getImageInventory();
    return success(inventory);
  });

  // POST /api/v1/admin/platform/capacity-check
  app.post('/admin/platform/capacity-check', {
    schema: {
      tags: ['Platform Updates'],
      summary: 'Check if the cluster has enough resources for an application',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['cpu', 'memory', 'storage'],
        properties: {
          cpu: { type: 'string' },
          memory: { type: 'string' },
          storage: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                totalCpu: { type: 'number' },
                totalMemory: { type: 'number' },
                totalStorage: { type: 'number' },
                allocatedCpu: { type: 'number' },
                allocatedMemory: { type: 'number' },
                allocatedStorage: { type: 'number' },
                requestedCpu: { type: 'number' },
                requestedMemory: { type: 'number' },
                requestedStorage: { type: 'number' },
                fits: { type: 'boolean' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { cpu, memory, storage } = request.body as { cpu: string; memory: string; storage: string };
    const result = await service.getCapacityCheck(app.db, cpu, memory, storage);
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
