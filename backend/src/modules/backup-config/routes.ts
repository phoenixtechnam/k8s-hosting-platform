import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  createBackupConfigSchema,
  updateBackupConfigSchema,
  type CreateBackupConfigInput,
} from '@k8s-hosting/api-contracts';
import type { ZodError } from 'zod';

// Turn a Zod issue list into a single human-readable message that's safe
// to surface to an operator via the admin panel. We preserve the field
// path (e.g. "s3_bucket") so the frontend can highlight the specific
// input that failed — response.ts envelope puts the string in `error`.
function zodMessage(err: ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
      return `${path}${i.message}`;
    })
    .join('; ');
}

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
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const config = await service.createBackupConfig(app.db, parsed.data, encryptionKey);
    reply.status(201).send(success(config));
  });

  // POST /api/v1/admin/backup-configs/test-draft — test BEFORE save.
  //
  // Accepts the same payload shape as POST create but never persists
  // anything. Enables the "Test Connection" button inside the create/
  // edit form so operators don't commit a config that can't talk to S3.
  // NOTE: this route is declared BEFORE the `:id/test` route so Fastify
  // doesn't try to interpret "test-draft" as an id path parameter.
  app.post('/admin/backup-configs/test-draft', async (request) => {
    const parsed = createBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const result = await service.testDraft(parsed.data as CreateBackupConfigInput);
    return success(result);
  });

  // PATCH /api/v1/admin/backup-configs/:id
  app.patch('/admin/backup-configs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateBackupConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', zodMessage(parsed.error), 400);
    }
    const updated = await service.updateBackupConfig(app.db, id, parsed.data, encryptionKey);
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
