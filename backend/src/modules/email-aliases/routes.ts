import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { createEmailAliasSchema, updateEmailAliasSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function emailAliasRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin'));
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/clients/:clientId/email/aliases
  app.get('/clients/:clientId/email/aliases', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const emailDomainId = typeof query.email_domain_id === 'string' ? query.email_domain_id : undefined;

    const aliases = await service.listAliases(app.db, clientId, emailDomainId);
    return success(aliases);
  });

  // POST /api/v1/clients/:clientId/email/domains/:emailDomainId/aliases
  app.post('/clients/:clientId/email/domains/:emailDomainId/aliases', async (request, reply) => {
    const { clientId, emailDomainId } = request.params as { clientId: string; emailDomainId: string };
    const parsed = createEmailAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const alias = await service.createAlias(app.db, clientId, emailDomainId, parsed.data);
    reply.status(201).send(success(alias));
  });

  // PATCH /api/v1/clients/:clientId/email/aliases/:id
  app.patch('/clients/:clientId/email/aliases/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const parsed = updateEmailAliasSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateAlias(app.db, clientId, id, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/email/aliases/:id
  app.delete('/clients/:clientId/email/aliases/:id', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    await service.deleteAlias(app.db, clientId, id);
    reply.status(204).send();
  });
}
