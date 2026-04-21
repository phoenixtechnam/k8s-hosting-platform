import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { uploadSslCertSchema } from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sslCertRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientAccess());

  // POST /api/v1/clients/:clientId/domains/:domainId/ssl-cert
  app.post('/clients/:clientId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };

    const parsed = uploadSslCertSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const cert = await service.uploadCert(app.db, clientId, domainId, parsed.data, encryptionKey);
    reply.status(201).send(success(cert));
  });

  // GET /api/v1/clients/:clientId/domains/:domainId/ssl-cert
  app.get('/clients/:clientId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'support', 'client_admin')],
  }, async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };

    const cert = await service.getCert(app.db, clientId, domainId);
    return success(cert);
  });

  // DELETE /api/v1/clients/:clientId/domains/:domainId/ssl-cert
  app.delete('/clients/:clientId/domains/:domainId/ssl-cert', {
    onRequest: [requireRole('super_admin', 'admin', 'client_admin')],
  }, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };

    await service.deleteCert(app.db, clientId, domainId);
    reply.status(204).send();
  });
}
