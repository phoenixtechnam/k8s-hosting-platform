import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { loginSchema, changePasswordSchema, updateProfileSchema } from './schema.js';
import { authenticateUser, verifyPassword, hashNewPassword } from './service.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { users } from '../../db/schema.js';
import { extractPlatformSessionCookie, PLATFORM_SESSION_COOKIE, type JwtPayload } from '../../middleware/auth.js';

// Session cookie lifetime matches the JWT exp (60 min). The cookie lets
// nginx auth_request gate subdomains like mail-admin.k8s-platform.test
// without the browser needing to inject a Bearer header.
const SESSION_MAX_AGE_SECONDS = 3600;

function buildSessionCookie(token: string, maxAge: number): string {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  // Secure is always on — dev uses self-signed TLS on :2011 and prod is
  // TLS everywhere. Browsers accept Secure cookies on https://*.test.
  const parts = [
    `${PLATFORM_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header('Set-Cookie', buildSessionCookie(token, SESSION_MAX_AGE_SECONDS));
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', buildSessionCookie('', 0));
}

// In-memory token denylist (Phase 1). Replace with Redis in production.
// Map stores token → expiry timestamp for TTL-based eviction.
const tokenDenylist = new Map<string, number>();

// Prune expired entries every 10 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [token, exp] of tokenDenylist) {
    if (exp < now) tokenDenylist.delete(token);
  }
}, 600_000);

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
      exp: Math.floor(Date.now() / 1000) + 3600, // 60 min — auto-refreshed by frontend on activity
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };
    if (user.clientId) jwtPayload.clientId = user.clientId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token = app.jwt.sign(jwtPayload as any);

    setSessionCookie(reply, token);

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

    // For client-panel users, include the owning client's lifecycle
    // state so the UI can render a banner / block destructive pages
    // when the client is suspended or being operated on. Admin users
    // have no clientId and skip this lookup entirely.
    let clientStatus: string | null = null;
    let storageLifecycleState: string | null = null;
    if (user.clientId) {
      const { clients } = await import('../../db/schema.js');
      const [c] = await app.db
        .select({ status: clients.status, state: clients.storageLifecycleState })
        .from(clients)
        .where(eq(clients.id, user.clientId))
        .limit(1);
      if (c) {
        clientStatus = c.status;
        storageLifecycleState = c.state;
      }
    }

    return {
      data: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.roleName,
        panel: user.panel ?? 'admin',
        clientId: user.clientId ?? null,
        timezone: user.timezone ?? null,
        clientStatus,
        storageLifecycleState,
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
    if (parsed.data.timezone !== undefined) updateValues.timezone = parsed.data.timezone;

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
        timezone: updated.timezone ?? null,
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
    const decoded = request.user as { exp?: number };
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      tokenDenylist.set(authHeader.slice(7), decoded.exp ?? Math.floor(Date.now() / 1000) + 3600);
    }
    clearSessionCookie(reply);
    return reply.send({ data: { message: 'Logged out successfully' } });
  });

  // GET /auth/verify-admin-session — nginx auth_request gate for admin-only
  // subdomains (mail-admin.k8s-platform.test etc).
  //
  // COOKIE-ONLY on purpose. auth_request forwards every header from the
  // browser's request, including any Authorization header the gated app
  // (Stalwart's web-admin) sets itself on its XHR calls. If we accepted
  // Bearer here, Stalwart's own OAuth token would hit our JWT verifier,
  // fail, and the whole iframe would be redirected to /login cross-origin
  // (→ CORS "Failed to fetch" in the browser). The platform_session
  // cookie is always the authoritative signal for this gate.
  //
  // Returns:
  //   204 — authenticated admin-panel staff with a non-read-only role
  //   401 — no cookie, invalid cookie, or expired session
  //   403 — authenticated but not allowed on admin-only subdomains
  //         (client-panel session, or admin-panel read_only role)
  // No body — nginx only inspects status.
  app.get('/auth/verify-admin-session', async (request, reply) => {
    const token = extractPlatformSessionCookie(request.headers.cookie);
    if (!token) {
      return reply.code(401).send();
    }
    if (isTokenDenied(token)) {
      return reply.code(401).send();
    }
    let user: JwtPayload;
    try {
      user = request.server.jwt.verify<JwtPayload>(token);
    } catch {
      return reply.code(401).send();
    }
    if (user.panel !== 'admin') {
      return reply.code(403).send();
    }
    // read_only is an admin-panel role, but it's a reporting role (dashboard
    // reads only). The Stalwart web-admin is a write UI, so we exclude
    // read_only from the gate. super_admin / admin / billing / support pass.
    const allowed: ReadonlyArray<JwtPayload['role']> = ['super_admin', 'admin', 'billing', 'support'];
    if (!allowed.includes(user.role)) {
      return reply.code(403).send();
    }
    return reply.code(204).send();
  });

  // GET /auth/verify-admin-email — nginx auth_request gate for admin-only
  // subdomains when oauth2-proxy is the front door.
  //
  // oauth2-proxy (configured with --set-xauthrequest=true) authenticates
  // the user against Dex and then populates X-Auth-Request-Email on the
  // subrequest that nginx forwards here. We look up that email in our
  // users table and enforce the same role allow-list as the cookie gate.
  //
  // This is the companion to /auth/verify-admin-session — overlays choose
  // one gate via the admin-auth-gate Kustomize component:
  //   - admin-auth-gate-oauth2 → this endpoint
  //   - admin-auth-gate-cookie → verify-admin-session
  //
  // Status codes mirror the cookie gate so nginx rules stay identical:
  //   204 — active user with allowed role
  //   401 — header missing or empty (upstream oauth2-proxy misconfigured)
  //   403 — email unknown, user disabled, or role not in allow-list
  const allowedAdminRoles: ReadonlySet<string> = new Set([
    'super_admin', 'admin', 'billing', 'support',
  ]);
  // Redact email for audit logs: keep the domain, redact the local part.
  // Prevents leaking user identities into logs while still giving enough
  // signal to diagnose "which tenant got blocked" incidents.
  function redactEmail(email: string): string {
    const at = email.lastIndexOf('@');
    return at > 0 ? `***@${email.slice(at + 1)}` : '***';
  }
  app.get('/auth/verify-admin-email', async (request, reply) => {
    const rawHeader = request.headers['x-auth-request-email'];
    const email = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!email) {
      request.log.warn({ gate: 'admin-email', reason: 'HEADER_MISSING' }, 'auth gate denied');
      return reply.code(401).send();
    }
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      request.log.warn({ gate: 'admin-email', reason: 'HEADER_EMPTY' }, 'auth gate denied');
      return reply.code(401).send();
    }
    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.email, trimmed))
      .limit(1);
    if (!user) {
      request.log.warn({ gate: 'admin-email', reason: 'UNKNOWN_USER', email: redactEmail(trimmed) }, 'auth gate denied');
      return reply.code(403).send();
    }
    if (user.status !== 'active') {
      request.log.warn({ gate: 'admin-email', reason: 'INACTIVE', email: redactEmail(trimmed) }, 'auth gate denied');
      return reply.code(403).send();
    }
    if (!allowedAdminRoles.has(user.roleName)) {
      request.log.warn({ gate: 'admin-email', reason: 'INSUFFICIENT_ROLE', role: user.roleName, email: redactEmail(trimmed) }, 'auth gate denied');
      return reply.code(403).send();
    }
    return reply.code(204).send();
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
    const decoded = request.user as { exp?: number };
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      tokenDenylist.set(authHeader.slice(7), decoded.exp ?? Math.floor(Date.now() / 1000) + 3600);
    }

    // Issue new token
    const refreshPayload: Record<string, unknown> = {
      sub: user.id,
      role: user.roleName,
      panel: user.panel ?? 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600, // 60 min — auto-refreshed by frontend on activity
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    };
    if (user.clientId) refreshPayload.clientId = user.clientId;
    // Preserve impersonation claim on refresh
    const originalPayload = request.user as unknown as Record<string, unknown>;
    if (originalPayload.impersonatedBy) refreshPayload.impersonatedBy = originalPayload.impersonatedBy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newToken = app.jwt.sign(refreshPayload as any);

    setSessionCookie(reply, newToken);

    return reply.send({
      data: {
        token: newToken,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.roleName,
          panel: user.panel ?? 'admin',
          clientId: user.clientId ?? null,
        },
      },
    });
  });

}
