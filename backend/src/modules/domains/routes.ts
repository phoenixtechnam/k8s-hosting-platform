import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { domains } from '../../db/schema.js';
import { createDomainSchema, updateDomainSchema } from './schema.js';
import * as service from './service.js';
import { verifyDomain, getPlatformConfig } from './verification.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/admin/domains — list all domains across all clients
  app.get('/admin/domains', async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listAllDomains(app.db, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // POST /api/v1/clients/:clientId/domains
  app.post('/clients/:clientId/domains', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const domain = await service.createDomain(app.db, clientId, parsed.data);
    reply.status(201).send(success(domain));
  });

  // GET /api/v1/clients/:clientId/domains
  app.get('/clients/:clientId/domains', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listDomains(app.db, clientId, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/clients/:clientId/domains/:domainId
  app.get('/clients/:clientId/domains/:domainId', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const domain = await service.getDomainById(app.db, clientId, domainId);
    return success(domain);
  });

  // PATCH /api/v1/clients/:clientId/domains/:domainId
  app.patch('/clients/:clientId/domains/:domainId', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = updateDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDomain(app.db, clientId, domainId, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/domains/:domainId
  app.delete('/clients/:clientId/domains/:domainId', async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    await service.deleteDomain(app.db, clientId, domainId);
    reply.status(204).send();
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/verify
  app.post('/clients/:clientId/domains/:domainId/verify', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const domain = await service.getDomainById(app.db, clientId, domainId);

    const platformConfig = getPlatformConfig();
    const dnsMode = domain.dnsMode as 'primary' | 'cname' | 'secondary';
    const result = await verifyDomain(domain.domainName, dnsMode, platformConfig, app.db);

    // Update verification timestamps
    const now = new Date();
    const updateValues: Record<string, unknown> = { lastVerifiedAt: now };
    if (result.verified && !domain.verifiedAt) {
      updateValues.verifiedAt = now;
    }
    await app.db.update(domains).set(updateValues).where(eq(domains.id, domainId));

    return success({ ...result, domainId, domainName: domain.domainName });
  });
}
