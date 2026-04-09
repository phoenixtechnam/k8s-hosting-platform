import { eq, and } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess, requireClientRoleByMethod } from '../../middleware/auth.js';
import { domains } from '../../db/schema.js';
import { createDnsRecordSchema, updateDnsRecordSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

async function assertNotSecondaryDns(app: FastifyInstance, clientId: string, domainId: string): Promise<void> {
  const [domain] = await app.db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (domain?.dnsMode === 'secondary') {
    throw new ApiError('DNS_READONLY', 'Secondary DNS zones are read-only', 403);
  }
}

export async function dnsRecordRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Phase 6: method-aware role guard — read open, writes staff+client_admin only
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/clients/:clientId/domains/:domainId/dns-records
  app.get('/clients/:clientId/domains/:domainId/dns-records', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const records = await service.listDnsRecords(app.db, clientId, domainId);
    return success(records);
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/dns-records
  app.post('/clients/:clientId/domains/:domainId/dns-records', async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    await assertNotSecondaryDns(app, clientId, domainId);
    const parsed = createDnsRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const record = await service.createDnsRecord(app.db, clientId, domainId, parsed.data);
    reply.status(201).send(success(record));
  });

  // PATCH /api/v1/clients/:clientId/domains/:domainId/dns-records/:recordId
  app.patch('/clients/:clientId/domains/:domainId/dns-records/:recordId', async (request) => {
    const { clientId, domainId, recordId } = request.params as {
      clientId: string; domainId: string; recordId: string;
    };
    await assertNotSecondaryDns(app, clientId, domainId);
    const parsed = updateDnsRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await service.updateDnsRecord(app.db, clientId, domainId, recordId, parsed.data);
    return success(updated);
  });

  // DELETE /api/v1/clients/:clientId/domains/:domainId/dns-records/:recordId
  app.delete('/clients/:clientId/domains/:domainId/dns-records/:recordId', async (request, reply) => {
    const { clientId, domainId, recordId } = request.params as {
      clientId: string; domainId: string; recordId: string;
    };
    await assertNotSecondaryDns(app, clientId, domainId);
    await service.deleteDnsRecord(app.db, clientId, domainId, recordId);
    reply.status(204).send();
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/dns-records/sync
  app.post('/clients/:clientId/domains/:domainId/dns-records/sync', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const records = await service.syncRecordsFromProvider(app.db, clientId, domainId);
    return success(records);
  });

  // GET /api/v1/clients/:clientId/domains/:domainId/dns-records/diff
  app.get('/clients/:clientId/domains/:domainId/dns-records/diff', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const diff = await service.diffRecordsWithProvider(app.db, clientId, domainId);
    return success(diff);
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/dns-records/pull
  app.post('/clients/:clientId/domains/:domainId/dns-records/pull', async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const body = request.body as { type: string; name: string; value: string; ttl?: number; local_id?: string };

    if (body.local_id) {
      // Update existing local record
      const updated = await service.updateDnsRecord(app.db, clientId, domainId, body.local_id, {
        record_value: body.value,
        ttl: body.ttl,
      });
      return success(updated);
    } else {
      // Create new local record (without syncing to remote — it already exists there)
      const created = await service.createDnsRecordLocalOnly(app.db, clientId, domainId, {
        record_type: body.type as 'A',
        record_name: body.name,
        record_value: body.value,
        ttl: body.ttl ?? 3600,
      });
      reply.status(201);
      return success(created);
    }
  });

  // POST /api/v1/clients/:clientId/domains/:domainId/dns-records/push
  app.post('/clients/:clientId/domains/:domainId/dns-records/push', async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const body = request.body as { type: string; name: string; value: string; ttl?: number };

    const [domain] = await app.db.select().from(domains).where(eq(domains.id, domainId));
    if (!domain) throw new ApiError('DOMAIN_NOT_FOUND', 'Domain not found', 404);

    await service.syncRecordToProviders(app.db, domain.domainName, 'create', {
      type: body.type, name: body.name, content: body.value, ttl: body.ttl ?? 3600,
    }, domainId);

    return success({ message: 'Record pushed to DNS server' });
  });
}
