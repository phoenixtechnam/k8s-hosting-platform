import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { enableEmailDomainSchema, updateEmailDomainSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

const encryptionKey = () => process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

export async function emailDomainRoutes(app: FastifyInstance): Promise<void> {
  // ── Admin routes ──
  app.get('/admin/email/domains', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => {
    const results = await service.listAllEmailDomains(app.db);
    return success(results);
  });

  // ── Client-scoped routes ──

  // POST /api/v1/clients/:clientId/email/domains/:domainId/enable
  app.post('/clients/:clientId/email/domains/:domainId/enable', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = enableEmailDomainSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const result = await service.enableEmailForDomain(app.db, clientId, domainId, parsed.data, encryptionKey());
    reply.status(201).send(success(result));
  });

  // DELETE /api/v1/clients/:clientId/email/domains/:domainId/disable
  app.delete('/clients/:clientId/email/domains/:domainId/disable', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    await service.disableEmailForDomain(app.db, clientId, domainId);
    reply.status(204).send();
  });

  // GET /api/v1/clients/:clientId/email/domains
  app.get('/clients/:clientId/email/domains', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const results = await service.listEmailDomains(app.db, clientId);
    return success(results);
  });

  // GET /api/v1/clients/:clientId/email/domains/:domainId
  app.get('/clients/:clientId/email/domains/:domainId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const result = await service.getEmailDomain(app.db, clientId, domainId);
    return success(result);
  });

  // PATCH /api/v1/clients/:clientId/email/domains/:domainId
  app.patch('/clients/:clientId/email/domains/:domainId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'client_admin'), requireClientAccess()],
  }, async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = updateEmailDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const result = await service.updateEmailDomain(app.db, clientId, domainId, parsed.data);
    return success(result);
  });
}
