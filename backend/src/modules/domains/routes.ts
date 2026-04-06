import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import { domains } from '../../db/schema.js';
import { createDomainSchema, updateDomainSchema } from './schema.js';
import * as service from './service.js';
import { bulkVerifyDomains, bulkDeleteDomains } from './bulk.js';
import { verifyDomain, getPlatformConfig } from './verification.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

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

    const domain = await service.createDomain(app.db, clientId, parsed.data, getK8s());
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

    const updated = await service.updateDomain(app.db, clientId, domainId, parsed.data, getK8s());
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/domains/:domainId
  app.delete('/clients/:clientId/domains/:domainId', async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    await service.deleteDomain(app.db, clientId, domainId, getK8s());
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

  // POST /api/v1/clients/:clientId/domains/:domainId/migrate-dns
  app.post('/clients/:clientId/domains/:domainId/migrate-dns', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const body = request.body as { target_group_id?: string };

    if (!body.target_group_id) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'target_group_id is required', 400, { field: 'target_group_id' });
    }

    const updated = await service.migrateDomainDns(app.db, clientId, domainId, body.target_group_id);
    return success(updated);
  });

  // ─── Bulk Operations ────────────────────────────────────────────────────────

  // POST /api/v1/admin/domains/bulk
  app.post('/admin/domains/bulk', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const body = request.body as { domain_ids?: string[]; action?: string };

    if (!Array.isArray(body.domain_ids) || body.domain_ids.length === 0 || !body.action) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'domain_ids (non-empty array) and action are required', 400);
    }

    if (body.action !== 'verify' && body.action !== 'delete') {
      throw new ApiError('INVALID_FIELD_VALUE', "action must be 'verify' or 'delete'", 400, { field: 'action' });
    }

    if (body.action === 'verify') {
      const result = await bulkVerifyDomains(app.db, body.domain_ids);
      return success(result);
    }

    const result = await bulkDeleteDomains(app.db, body.domain_ids, getK8s());
    return success(result);
  });
}
