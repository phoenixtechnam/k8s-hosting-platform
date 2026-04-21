import type { FastifyInstance } from 'fastify';
import { authenticate, requireClientRoleByMethod, requireClientAccess } from '../../middleware/auth.js';
import { createSftpUserSchema, updateSftpUserSchema, rotateSftpPasswordSchema } from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function sftpUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  // GET /api/v1/clients/:clientId/sftp-users
  app.get('/clients/:clientId/sftp-users', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const users = await service.listSftpUsers(app.db, clientId);
    return success(users);
  });

  // POST /api/v1/clients/:clientId/sftp-users
  app.post('/clients/:clientId/sftp-users', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createSftpUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const user = await service.createSftpUser(app.db, clientId, parsed.data);
    reply.status(201).send(success(user));
  });

  // GET /api/v1/clients/:clientId/sftp-users/connection-info
  app.get('/clients/:clientId/sftp-users/connection-info', async () => {
    const info = await service.getSftpConnectionInfo(app.db);
    return success(info);
  });

  // GET /api/v1/clients/:clientId/sftp-users/:userId
  app.get('/clients/:clientId/sftp-users/:userId', async (request) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };
    const user = await service.getSftpUser(app.db, clientId, userId);
    return success(user);
  });

  // PATCH /api/v1/clients/:clientId/sftp-users/:userId
  app.patch('/clients/:clientId/sftp-users/:userId', async (request) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };
    const parsed = updateSftpUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const user = await service.updateSftpUser(app.db, clientId, userId, parsed.data);
    return success(user);
  });

  // DELETE /api/v1/clients/:clientId/sftp-users/:userId
  app.delete('/clients/:clientId/sftp-users/:userId', async (request, reply) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };
    await service.deleteSftpUser(app.db, clientId, userId);
    reply.status(204).send();
  });

  // POST /api/v1/clients/:clientId/sftp-users/:userId/rotate-password
  app.post('/clients/:clientId/sftp-users/:userId/rotate-password', async (request) => {
    const { clientId, userId } = request.params as { clientId: string; userId: string };
    const parsed = rotateSftpPasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${parsed.error.issues[0].message}`,
        400,
      );
    }
    const result = await service.rotateSftpPassword(
      app.db,
      clientId,
      userId,
      parsed.data.custom_password,
    );
    return success(result);
  });

  // GET /api/v1/clients/:clientId/sftp-audit
  app.get('/clients/:clientId/sftp-audit', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const { items, total } = await service.listSftpAuditLog(app.db, clientId, limit, offset);
    return { data: items, pagination: { total, limit, offset } };
  });
}
