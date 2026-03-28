import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createSmtpRelaySchema, updateSmtpRelaySchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function smtpRelayRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/email/smtp-relays
  app.get('/admin/email/smtp-relays', async () => {
    const configs = await service.listRelayConfigs(app.db);
    return success(configs);
  });

  // POST /api/v1/admin/email/smtp-relays
  app.post('/admin/email/smtp-relays', async (request, reply) => {
    const parsed = createSmtpRelaySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const config = await service.createRelayConfig(app.db, parsed.data, encryptionKey);
    reply.status(201).send(success(config));
  });

  // PATCH /api/v1/admin/email/smtp-relays/:id
  app.patch('/admin/email/smtp-relays/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateSmtpRelaySchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateRelayConfig(app.db, id, parsed.data, encryptionKey);
    return success(updated);
  });

  // DELETE /api/v1/admin/email/smtp-relays/:id
  app.delete('/admin/email/smtp-relays/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteRelayConfig(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/email/smtp-relays/:id/test
  app.post('/admin/email/smtp-relays/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testRelayConnection(app.db, id, encryptionKey);
    return success(result);
  });
}
