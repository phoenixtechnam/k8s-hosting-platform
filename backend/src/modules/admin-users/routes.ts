import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, inArray, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditLogs, refreshTokens, users, userPasskeys } from '../../db/schema.js';
import { createAdminUserSchema, updateAdminUserSchema } from '@k8s-hosting/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  findSessionIdByHash,
  hashRefreshToken,
  listActiveSessionsForUser,
  revokeAllUserRefreshTokens,
  revokeRefreshTokenById,
} from '../auth/refresh-token-service.js';

// Tightened UUID regex — the loose [0-9a-f-]{36} would accept e.g.
// `------------------------------------`. Real v4/v8 UUIDs have a
// strict structure: 8-4-4-4-12 hex groups. Used for ID-shape gating
// in the session-revoke routes below.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Audit-log helper for the session-revoke + bulk-revoke routes.
 *
 * The stolen-laptop / admin-on-admin scenarios are exactly what these
 * routes exist to handle, so the audit trail MUST capture: who did
 * the revoke (actor), against whom (target_user_id), and which
 * session ID (or 'bulk'). Without this, Operator-2 has no way to see
 * that Operator-1 killed their sessions.
 *
 * Mirrors the pattern in auth/step-up-routes.ts (recordStepUpAudit).
 */
async function recordSessionRevokeAudit(
  app: FastifyInstance,
  request: FastifyRequest,
  actorId: string,
  targetUserId: string,
  sessionId: string | 'bulk',
  changes?: Record<string, unknown>,
): Promise<void> {
  try {
    await app.db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType: sessionId === 'bulk'
        ? 'admin.session.bulk_revoke'
        : 'admin.session.revoke',
      resourceType: 'admin_session',
      resourceId: sessionId === 'bulk' ? targetUserId : sessionId,
      actorId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: 204,
      changes: { targetUserId, ...changes },
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn({ err }, 'admin session-revoke audit write failed');
  }
}

// Local cookie helper — mirrors the auth/routes.ts pickRefreshToken
// pattern but standalone because the auth helper isn't exported.
const REFRESH_COOKIE_NAME = 'platform_refresh';
function pickRefreshTokenFromRequest(request: FastifyRequest): string | undefined {
  const body = request.body as { refreshToken?: unknown } | undefined;
  if (body && typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
    return body.refreshToken;
  }
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return undefined;
  for (const pair of cookieHeader.split(';')) {
    const [k, ...rest] = pair.trim().split('=');
    if (k === REFRESH_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/users — list all admin panel users
  //
  // 2026-05-21 — augmented with `passkeyCount` and `lastLoginIp` so the
  // Security Hub Identity page can show MFA-enrolment status and the
  // last-seen IP at a glance. passkeyCount is a left-joined aggregate
  // from user_passkeys (denormalising it would mean syncing on every
  // passkey CRUD; the aggregate is cheap at <100 admin rows).
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
        // lastLoginIp is derived from the most-recent refresh_tokens row.
        // The platform `users` table has no lastLoginIp column (only
        // SFTP users do); refresh_tokens.ip_address is captured per
        // issued session, so the freshest one is effectively the
        // operator's most-recent login IP. Sub-select keeps the route
        // single-query (no N+1).
        lastLoginIp: sql<string | null>`(
          SELECT ${refreshTokens.ipAddress}
          FROM ${refreshTokens}
          WHERE ${refreshTokens.userId} = ${users.id}
          ORDER BY ${refreshTokens.issuedAt} DESC
          LIMIT 1
        )`,
        createdAt: users.createdAt,
        passkeyCount: sql<number>`(SELECT COUNT(*)::int FROM ${userPasskeys} WHERE ${userPasskeys.userId} = ${users.id})`,
      })
      .from(users)
      .where(eq(users.panel, 'admin'));

    return success(adminUsers);
  });

  // ─── Active Sessions (refresh tokens) — 2026-05-21 ────────────────
  // GET /api/v1/admin/users/:userId/sessions — list active sessions
  // for one admin user. super_admin OR admin role can read.
  app.get('/admin/users/:userId/sessions', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { userId } = request.params as { userId: string };
    if (!UUID_RE.test(userId)) {
      throw new ApiError('INVALID_USER_ID', 'userId must be a UUID', 400);
    }
    // Confirm the target is an admin-panel user — never expose tenant
    // user sessions via this route (those have their own surface).
    const [target] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.panel, 'admin')));
    if (!target) {
      throw new ApiError('USER_NOT_FOUND', `Admin user '${userId}' not found`, 404);
    }
    const sessions = await listActiveSessionsForUser(app.db, userId);
    return success({ sessions });
  });

  // DELETE /api/v1/admin/users/:userId/sessions/:sessionId — revoke one.
  // super_admin only — revoking an admin's session is a sensitive op.
  // The route refuses to revoke the caller's OWN current session — that
  // would lock them out of the same browser tab. The frontend identifies
  // the current session via GET /me/sessions (in auth/routes.ts).
  app.delete('/admin/users/:userId/sessions/:sessionId', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const { userId, sessionId } = request.params as { userId: string; sessionId: string };
    if (!UUID_RE.test(userId) || !UUID_RE.test(sessionId)) {
      throw new ApiError('INVALID_ID', 'userId and sessionId must be UUIDs', 400);
    }
    // Sanity: confirm the session actually belongs to this user before
    // revoking — otherwise the route becomes a "revoke any session id"
    // primitive that bypasses the role-based path-prefix guard.
    const sessions = await listActiveSessionsForUser(app.db, userId);
    const owns = sessions.some((s) => s.id === sessionId);
    if (!owns) {
      throw new ApiError('SESSION_NOT_FOUND', `Active session ${sessionId} not found for user ${userId}`, 404);
    }
    await revokeRefreshTokenById(app.db, sessionId, 'admin_revoke');
    await recordSessionRevokeAudit(
      app, request, request.user.sub, userId, sessionId,
    );
    reply.status(204).send();
  });

  // DELETE /api/v1/admin/users/:userId/sessions — bulk revoke active
  // sessions for a user. super_admin only. When the target is the
  // caller themselves, the caller's CURRENT session (identified by
  // the refresh-token cookie/body hash) is EXCLUDED so the operator
  // doesn't kill the browser tab they're operating from. Pass through
  // to revokeAllUserRefreshTokens with options.exceptSessionId. The
  // legacy password-change + admin-disable callers don't pass this
  // option, so their full-revoke semantics are unchanged.
  app.delete('/admin/users/:userId/sessions', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    if (!UUID_RE.test(userId)) {
      throw new ApiError('INVALID_USER_ID', 'userId must be a UUID', 400);
    }
    const [target] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.panel, 'admin')));
    if (!target) {
      throw new ApiError('USER_NOT_FOUND', `Admin user '${userId}' not found`, 404);
    }
    // Self-lockout protection: if the caller is bulk-revoking their
    // OWN sessions, look up the current refresh-token's session ID and
    // pass it as the exception so revokeAllUserRefreshTokens skips it.
    // For other targets (or when no current refresh token is presented),
    // the exception is undefined and all rows revoke as before.
    let exceptSessionId: string | undefined;
    if (request.user.sub === userId) {
      const presented = pickRefreshTokenFromRequest(request);
      if (presented) {
        const id = await findSessionIdByHash(app.db, hashRefreshToken(presented));
        if (id) exceptSessionId = id;
      }
    }
    await revokeAllUserRefreshTokens(app.db, userId, 'admin_revoke', { exceptSessionId });
    await recordSessionRevokeAudit(
      app, request, request.user.sub, userId, 'bulk', { exceptSessionId },
    );
    reply.status(204).send();
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

    // Phase 3: a disable / password change MUST kill every active
    // refresh token for the user. The access JWT is short-lived
    // (30 min) so it expires on its own; revoking refresh tokens
    // here ensures /auth/refresh stops working immediately.
    if (
      (parsed.data.status !== undefined && parsed.data.status === 'disabled') ||
      parsed.data.password !== undefined
    ) {
      const reason = parsed.data.password !== undefined ? 'password_change' : 'admin_revoke';
      await revokeAllUserRefreshTokens(app.db, id, reason);
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
