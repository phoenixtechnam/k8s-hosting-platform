import type { FastifyInstance } from 'fastify';
import { eq, and, inArray, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { users } from '../../db/schema.js';
import { createAdminUserSchema, updateAdminUserSchema } from '@k8s-hosting/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/users — list all admin panel users
  app.get('/admin/users', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async () => {
    const adminUsers = await app.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        roleName: users.roleName,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.panel, 'admin'));

    return success(adminUsers);
  });

  // POST /api/v1/admin/users — create admin user
  app.post('/admin/users', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const parsed = createAdminUserSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'VALIDATION_ERROR',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const { email, full_name, password, role_name } = parsed.data;

    // Check for duplicate email
    const [existing] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));

    if (existing) {
      throw new ApiError('DUPLICATE_ENTRY', 'A user with this email already exists', 409, { email });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();

    await app.db.insert(users).values({
      id,
      email,
      passwordHash,
      fullName: full_name,
      roleName: role_name,
      panel: 'admin',
      status: 'active',
      emailVerifiedAt: new Date(),
    });

    const [created] = await app.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        roleName: users.roleName,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, id));

    reply.status(201).send(success(created));
  });

  // PATCH /api/v1/admin/users/:id — update admin user
  app.patch('/admin/users/:id', {
    onRequest: [requireRole('super_admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };

    const parsed = updateAdminUserSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'VALIDATION_ERROR',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const [existing] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.panel, 'admin')));

    if (!existing) {
      throw new ApiError('USER_NOT_FOUND', `Admin user '${id}' not found`, 404, { user_id: id });
    }

    const updateValues: Record<string, unknown> = {};
    if (parsed.data.full_name !== undefined) updateValues.fullName = parsed.data.full_name;
    if (parsed.data.role_name !== undefined) updateValues.roleName = parsed.data.role_name;
    if (parsed.data.status !== undefined) updateValues.status = parsed.data.status;
    if (parsed.data.password !== undefined) {
      updateValues.passwordHash = await bcrypt.hash(parsed.data.password, 12);
    }

    if (Object.keys(updateValues).length > 0) {
      await app.db.update(users).set(updateValues).where(eq(users.id, id));
    }

    const [updated] = await app.db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        roleName: users.roleName,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, id));

    return success(updated);
  });

  // DELETE /api/v1/admin/users/bulk — bulk delete admin users
  app.delete('/admin/users/bulk', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const body = request.body as { user_ids?: string[] };
    const userIds = body?.user_ids;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'user_ids must be a non-empty array', 400);
    }

    // Prevent self-deletion
    const callerId = ((request as unknown as Record<string, unknown>).user as { sub: string }).sub;
    if (userIds.includes(callerId)) {
      throw new ApiError('OPERATION_NOT_ALLOWED', 'Cannot delete your own account', 403);
    }

    // Verify all targets are admin-panel users
    const targets = await app.db
      .select({ id: users.id, roleName: users.roleName })
      .from(users)
      .where(and(eq(users.panel, 'admin'), inArray(users.id, userIds)));

    const targetIds = new Set(targets.map((t) => t.id));
    const superAdminTargetCount = targets.filter((t) => t.roleName === 'super_admin').length;

    // Count current super_admins to ensure at least one remains
    if (superAdminTargetCount > 0) {
      const [{ count: totalSuperAdmins }] = await app.db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.panel, 'admin'), eq(users.roleName, 'super_admin')));

      if (Number(totalSuperAdmins) - superAdminTargetCount < 1) {
        throw new ApiError(
          'OPERATION_NOT_ALLOWED',
          'Bulk delete would remove all super_admin users',
          403,
        );
      }
    }

    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const id of userIds) {
      if (!targetIds.has(id)) {
        failed.push({ id, error: 'Admin user not found' });
        continue;
      }
      try {
        await app.db.delete(users).where(eq(users.id, id));
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    return reply.send(success({ succeeded, failed }));
  });

  // DELETE /api/v1/admin/users/:id — delete admin user
  app.delete('/admin/users/:id', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // Prevent self-deletion
    if (request.user.sub === id) {
      throw new ApiError('OPERATION_NOT_ALLOWED', 'Cannot delete your own account', 403);
    }

    const [existing] = await app.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.panel, 'admin')));

    if (!existing) {
      throw new ApiError('USER_NOT_FOUND', `Admin user '${id}' not found`, 404, { user_id: id });
    }

    // Prevent deletion of last super_admin
    if (existing.roleName === 'super_admin') {
      const superAdmins = await app.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.panel, 'admin'), eq(users.roleName, 'super_admin')));

      if (superAdmins.length <= 1) {
        throw new ApiError('OPERATION_NOT_ALLOWED', 'Cannot delete the last super_admin user', 403);
      }
    }

    await app.db.delete(users).where(eq(users.id, id));
    reply.status(204).send();
  });
}
