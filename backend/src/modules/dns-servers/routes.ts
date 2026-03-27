import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function dnsServerRoutes(app: FastifyInstance): Promise<void> {
  const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/dns-servers
  app.get('/admin/dns-servers', async () => {
    return success(await service.listDnsServers(app.db));
  });

  // POST /api/v1/admin/dns-servers
  app.post('/admin/dns-servers', async (request, reply) => {
    const input = request.body as any;
    if (!input.display_name || !input.provider_type || !input.connection_config) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'display_name, provider_type, and connection_config are required', 400);
    }
    const server = await service.createDnsServer(app.db, input, encryptionKey);
    reply.status(201).send(success(server));
  });

  // PATCH /api/v1/admin/dns-servers/:id
  app.patch('/admin/dns-servers/:id', async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as any;
    const updated = await service.updateDnsServer(app.db, id, input, encryptionKey);
    return success(updated);
  });

  // DELETE /api/v1/admin/dns-servers/:id
  app.delete('/admin/dns-servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteDnsServer(app.db, id);
    reply.status(204).send();
  });

  // POST /api/v1/admin/dns-servers/:id/test
  app.post('/admin/dns-servers/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.testDnsServerConnection(app.db, id, encryptionKey);
    return success(result);
  });

  // GET /api/v1/admin/dns-servers/:id/zones
  app.get('/admin/dns-servers/:id/zones', async (request) => {
    const { id } = request.params as { id: string };
    const server = await service.getDnsServerById(app.db, id);
    const provider = service.getProviderForServer(server, encryptionKey);
    const zones = await provider.listZones();
    return success(zones);
  });
}
