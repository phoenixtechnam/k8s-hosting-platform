import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireClientAccess } from '../../middleware/auth.js';
import {
  createProtectedDirectorySchema,
  updateProtectedDirectorySchema,
  createProtectedDirectoryUserSchema,
  changeProtectedDirectoryUserPasswordSchema,
} from './schema.js';
import * as service from './service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function protectedDirectoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support', 'client_admin', 'client_user'));
  app.addHook('onRequest', requireClientAccess());

  const base = '/clients/:clientId/domains/:domainId/protected-directories';

  // GET — list directories
  app.get(base, async (request) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const dirs = await service.listDirectories(app.db, clientId, domainId);
    return success(dirs);
  });

  // POST — create directory
  app.post(base, async (request, reply) => {
    const { clientId, domainId } = request.params as { clientId: string; domainId: string };
    const parsed = createProtectedDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.errors[0].message}`, 400);
    }
    const dir = await service.createDirectory(app.db, clientId, domainId, parsed.data);
    reply.status(201).send(success(dir));
  });

  // GET — get single directory
  app.get(`${base}/:dirId`, async (request) => {
    const { clientId, domainId, dirId } = request.params as { clientId: string; domainId: string; dirId: string };
    const dir = await service.getDirectory(app.db, clientId, domainId, dirId);
    return success(dir);
  });

  // PATCH — update directory
  app.patch(`${base}/:dirId`, async (request) => {
    const { clientId, domainId, dirId } = request.params as { clientId: string; domainId: string; dirId: string };
    const parsed = updateProtectedDirectorySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${parsed.error.errors[0].message}`, 400);
    }
    const updated = await service.updateDirectory(app.db, clientId, domainId, dirId, parsed.data);
    return success(updated);
  });

  // DELETE — delete directory
  app.delete(`${base}/:dirId`, async (request, reply) => {
    const { clientId, domainId, dirId } = request.params as { clientId: string; domainId: string; dirId: string };
    await service.deleteDirectory(app.db, clientId, domainId, dirId);
    reply.status(204).send();
  });

  // ─── Directory Users ─────────────────────────────────────────────────────

  // GET — list directory users
  app.get(`${base}/:dirId/users`, async (request) => {
    const { clientId, domainId, dirId } = request.params as { clientId: string; domainId: string; dirId: string };
    const users = await service.listDirectoryUsers(app.db, clientId, domainId, dirId);
    return success(users);
  });

  // POST — create directory user
  app.post(`${base}/:dirId/users`, async (request, reply) => {
    const { clientId, domainId, dirId } = request.params as { clientId: string; domainId: string; dirId: string };
    const parsed = createProtectedDirectoryUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('MISSING_REQUIRED_FIELD', `Validation error: ${parsed.error.errors[0].message}`, 400);
    }
    const user = await service.createDirectoryUser(app.db, clientId, domainId, dirId, parsed.data);
    reply.status(201).send(success(user));
  });

  // POST — change directory user password
  app.post(`${base}/:dirId/users/:userId/change-password`, async (request) => {
    const { clientId, domainId, dirId, userId } = request.params as {
      clientId: string; domainId: string; dirId: string; userId: string;
    };
    const parsed = changeProtectedDirectoryUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${parsed.error.errors[0].message}`, 400);
    }
    await service.changeDirectoryUserPassword(app.db, clientId, domainId, dirId, userId, parsed.data.password);
    return success({ message: 'Password updated' });
  });

  // POST — disable directory user
  app.post(`${base}/:dirId/users/:userId/disable`, async (request) => {
    const { clientId, domainId, dirId, userId } = request.params as {
      clientId: string; domainId: string; dirId: string; userId: string;
    };
    await service.toggleDirectoryUser(app.db, clientId, domainId, dirId, userId, false);
    return success({ message: 'User disabled' });
  });

  // DELETE — delete directory user
  app.delete(`${base}/:dirId/users/:userId`, async (request, reply) => {
    const { clientId, domainId, dirId, userId } = request.params as {
      clientId: string; domainId: string; dirId: string; userId: string;
    };
    await service.deleteDirectoryUser(app.db, clientId, domainId, dirId, userId);
    reply.status(204).send();
  });
}
