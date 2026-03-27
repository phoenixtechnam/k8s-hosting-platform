import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { loginSchema, changePasswordSchema, updateProfileSchema } from './schema.js';
import { authenticateUser, verifyPassword, hashNewPassword } from './service.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { users } from '../../db/schema.js';

// In-memory token denylist (Phase 1). Replace with Redis in production.
const tokenDenylist = new Set<string>();

export function isTokenDenied(token: string): boolean {
  return tokenDenylist.has(token);
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
      },
    },
    schema: {
      tags: ['Auth'],
      summary: 'Login with email and password',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                token: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    fullName: { type: 'string' },
                    role: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    // Check if local auth is disabled for the requested panel
    const loginBody = request.body as Record<string, unknown>;
    const loginPanel = (loginBody?.panel === 'client' ? 'client' : 'admin') as 'admin' | 'client';
    if (await isLocalAuthDisabled(app.db, loginPanel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled. Please use SSO to sign in.', 403);
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }

    const { email, password } = parsed.data;
    const user = await authenticateUser(app.db, email, password);

    const jwtPayload: Record<string, unknown> = {
      sub: user.id,
      role: user.role,
      panel: user.panel ?? 'admin',
      exp: Math.floor(Date.now() / 1000) + 86400,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };
    if (user.clientId) jwtPayload.clientId = user.clientId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = app.jwt.sign(jwtPayload as any);

    return reply.send({
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          panel: user.panel,
          clientId: user.clientId,
        },
      },
    });
  });

  app.get('/auth/me', async (request) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string; role: string };

    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) {
      throw invalidToken();
    }

    return {
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.roleName,
      },
    };
  });

  app.patch('/auth/profile', async (request, reply) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string; role: string };

    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }

    const updateValues: Record<string, unknown> = {};
    if (parsed.data.full_name !== undefined) updateValues.fullName = parsed.data.full_name;
    if (parsed.data.email !== undefined) updateValues.email = parsed.data.email;

    if (Object.keys(updateValues).length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'No fields provided to update', 400);
    }

    await app.db
      .update(users)
      .set(updateValues)
      .where(eq(users.id, payload.sub));

    const [updated] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    return reply.send({
      data: {
        id: updated.id,
        email: updated.email,
        fullName: updated.fullName,
        role: updated.roleName,
      },
    });
  });

  app.patch('/auth/password', async (request, reply) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string; role: string };

    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
        400,
      );
    }

    const { current_password, new_password } = parsed.data;

    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw invalidToken();
    }

    if (!await verifyPassword(current_password, user.passwordHash)) {
      throw invalidToken();
    }

    const newHash = await hashNewPassword(new_password);

    await app.db
      .update(users)
      .set({ passwordHash: newHash })
      .where(eq(users.id, payload.sub));

    return reply.send({
      data: { message: 'Password updated successfully' },
    });
  });

  // POST /auth/logout — revoke current token
  app.post('/auth/logout', async (request, reply) => {
    await request.jwtVerify();
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      tokenDenylist.add(authHeader.slice(7));
    }
    return reply.send({ data: { message: 'Logged out successfully' } });
  });

  // POST /auth/refresh — issue a new token and revoke the old one
  app.post('/auth/refresh', async (request, reply) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string; role: string };

    // Verify user still exists and is active
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);

    if (!user) {
      throw invalidToken();
    }

    // Revoke old token
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      tokenDenylist.add(authHeader.slice(7));
    }

    // Issue new token
    const refreshPayload: Record<string, unknown> = {
      sub: user.id,
      role: user.roleName,
      panel: user.panel ?? 'admin',
      exp: Math.floor(Date.now() / 1000) + 86400,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };
    if (user.clientId) refreshPayload.clientId = user.clientId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newToken = app.jwt.sign(refreshPayload as any);

    return reply.send({
      data: {
        token: newToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.roleName,
        },
      },
    });
  });
}
