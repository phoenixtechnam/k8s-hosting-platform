import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess, requireClientRoleByMethod } from '../../middleware/auth.js';
import { createSshKeySchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sshKeyRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read for all client roles,
  // writes only for client_admin + staff.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/clients/:clientId/ssh-keys
  app.get('/clients/:clientId/ssh-keys', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const keys = await service.listSshKeys(app.db, clientId);
    return success(keys);
  });

  // POST /api/v1/clients/:clientId/ssh-keys
  app.post('/clients/:clientId/ssh-keys', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createSshKeySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.errors[0].message}`, 400);
    }
    const key = await service.createSshKey(app.db, clientId, parsed.data);
    reply.status(201).send(success(key));
  });

  // DELETE /api/v1/clients/:clientId/ssh-keys/:keyId
  app.delete('/clients/:clientId/ssh-keys/:keyId', async (request, reply) => {
    const { clientId, keyId } = request.params as { clientId: string; keyId: string };
    await service.deleteSshKey(app.db, clientId, keyId);
    reply.status(204).send();
  });
}
