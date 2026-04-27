import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { loginSchema, changePasswordSchema, updateProfileSchema } from './schema.js';
import { authenticateUser, verifyPassword, hashNewPassword } from './service.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { users } from '../../db/schema.js';
import { extractPlatformSessionCookie, PLATFORM_SESSION_COOKIE, type JwtPayload } from '../../middleware/auth.js';
import {
  issueRefreshToken,
  validateRefreshToken,
  revokeRefreshTokenById,
  revokeAllUserRefreshTokens,
  touchLastUsed,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './refresh-token-service.js';

// Phase 3: split-token auth.
//   - Access JWT: 30 min (ACCESS_TOKEN_TTL_SECONDS), stateless verify.
//   - Refresh token: 24 h (REFRESH_TOKEN_TTL_SECONDS), DB-backed, rotated.
//
// The platform_session cookie holds the access JWT (for nginx
// auth_request gates that can't carry a Bearer header). It expires when
// the access JWT expires; the frontend silently refreshes via
// /auth/refresh up to the refresh-token TTL.
const REFRESH_COOKIE = 'platform_refresh';

function buildSessionCookie(name: string, token: string, maxAge: number): string {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
  // SameSite=None (with Secure) when SESSION_COOKIE_DOMAIN is set so the
  // cookie crosses subdomains for iframe-hosted admin tools (Longhorn,
  // Stalwart, etc). Otherwise Lax — same-origin only, safer default.
  const sameSite = domain ? 'None' : 'Lax';
  const parts = [
    `${name}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  reply.header('Set-Cookie', [
    buildSessionCookie(PLATFORM_SESSION_COOKIE, accessToken, ACCESS_TOKEN_TTL_SECONDS),
    buildSessionCookie(REFRESH_COOKIE, refreshToken, REFRESH_TOKEN_TTL_SECONDS),
  ]);
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.header('Set-Cookie', [
    buildSessionCookie(PLATFORM_SESSION_COOKIE, '', 0),
    buildSessionCookie(REFRESH_COOKIE, '', 0),
  ]);
}

function extractRefreshTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== REFRESH_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

interface AccessTokenInput {
  readonly userId: string;
  readonly role: string;
  readonly panel: 'admin' | 'client';
  readonly clientId?: string | null;
  readonly impersonatedBy?: string;
}

function signAccessToken(app: FastifyInstance, input: AccessTokenInput): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: input.userId,
    role: input.role,
    panel: input.panel,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    iat: now,
    jti: crypto.randomUUID(),
  };
  if (input.clientId) payload.clientId = input.clientId;
  if (input.impersonatedBy) payload.impersonatedBy = input.impersonatedBy;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.jwt.sign(payload as any);
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
                refreshToken: { type: 'string' },
                expiresIn: { type: 'integer' },
                refreshExpiresIn: { type: 'integer' },
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

    const accessToken = signAccessToken(app, {
      userId: user.id,
      role: user.role,
      panel: user.panel ?? 'admin',
      clientId: user.clientId,
    });

    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: (user.panel ?? 'admin') as 'admin' | 'client',
      clientId: user.clientId ?? null,
      userAgent: pickUserAgent(request),
      ipAddress: request.ip,
    });

    setSessionCookies(reply, accessToken, issued.token);

    return reply.send({
      data: {
        token: accessToken,
        refreshToken: issued.token,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
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

    // Phase 3: a password change MUST invalidate every refresh token —
    // any leaked token from before the change must stop working
    // immediately. The current request's access JWT is left alone (it
    // expires within 30 min). The user gets a fresh refresh token in
    // the response so the active session continues uninterrupted.
    await revokeAllUserRefreshTokens(app.db, payload.sub, 'password_change');
    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: (user.panel ?? 'admin') as 'admin' | 'client',
      clientId: user.clientId ?? null,
      userAgent: pickUserAgent(request),
      ipAddress: request.ip,
    });
    // Refresh the session cookie so the browser also picks up the new
    // refresh token. Access cookie is left in place until expiry.
    reply.header('Set-Cookie', buildSessionCookie(REFRESH_COOKIE, issued.token, REFRESH_TOKEN_TTL_SECONDS));

    return reply.send({
      data: {
        message: 'Password updated successfully',
        refreshToken: issued.token,
        refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      },
    });
  });

  // POST /auth/logout — revoke the refresh token + clear cookies.
  // Intentionally accepts requests even without a Bearer access token,
  // so a UI with an expired access token can still log out cleanly.
  app.post('/auth/logout', async (request, reply) => {
    const presented = pickRefreshToken(request);
    if (presented) {
      const validation = await validateRefreshToken(app.db, presented);
      if (validation.ok) {
        await revokeRefreshTokenById(app.db, validation.id, 'logout');
      }
      // not_found / expired / revoked / reuse_detected — no-op, the
      // client is already logged out from the server's POV.
    }
    clearSessionCookies(reply);
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

  // POST /auth/refresh — rotate the refresh token and issue a new access JWT.
  //
  // Accepts the refresh token from either:
  //   - body: { refreshToken: "..." }
  //   - cookie: platform_refresh
  //
  // Returns: { token, refreshToken, expiresIn, refreshExpiresIn, user }
  //
  // Invariants:
  //   - The presented refresh token MUST be unused. If it was already
  //     rotated, we treat that as a reuse attack and revoke the family.
  //   - Successful rotation revokes the old token (rotated reason) and
  //     issues a new one with the same family_id.
  //   - Access JWT is freshly signed (30 min TTL).
  //   - Impersonation claim is preserved across rotation.
  app.post('/auth/refresh', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const presented = pickRefreshToken(request);
    if (!presented) {
      throw new ApiError('REFRESH_TOKEN_MISSING', 'Refresh token required', 401);
    }

    const validation = await validateRefreshToken(app.db, presented);
    if (!validation.ok) {
      // reuse_detected is special — log it for incident review.
      if (validation.reason === 'reuse_detected') {
        request.log.warn({ event: 'refresh_token_reuse' }, 'Refresh token reuse detected — family revoked');
      }
      throw new ApiError('REFRESH_TOKEN_INVALID', `Refresh token ${validation.reason}`, 401);
    }

    const [user] = await app.db
      .select()
      .from(users)
      .where(eq(users.id, validation.userId))
      .limit(1);

    if (!user || user.status !== 'active') {
      // Revoke the otherwise-valid token so the deactivated user can't
      // continue rotating.
      await revokeRefreshTokenById(app.db, validation.id, 'admin_revoke');
      throw invalidToken();
    }

    // Rotate: revoke the presented token (rotated), issue a new one.
    await revokeRefreshTokenById(app.db, validation.id, 'rotated');
    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: validation.panel,
      clientId: validation.clientId,
      familyId: validation.familyId,
      userAgent: pickUserAgent(request),
      ipAddress: request.ip,
    });
    await touchLastUsed(app.db, validation.id);

    // Preserve impersonation claim if present on the access JWT.
    let impersonatedBy: string | undefined;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = request.server.jwt.verify<JwtPayload>(authHeader.slice(7));
        if (decoded.impersonatedBy) impersonatedBy = decoded.impersonatedBy;
      } catch {
        // Access token may be expired by now (that's why we're refreshing).
        // Accept the refresh anyway — impersonation claim is non-critical.
      }
    }

    const accessToken = signAccessToken(app, {
      userId: user.id,
      role: user.roleName,
      panel: (user.panel ?? 'admin') as 'admin' | 'client',
      clientId: user.clientId,
      impersonatedBy,
    });

    setSessionCookies(reply, accessToken, issued.token);

    return reply.send({
      data: {
        token: accessToken,
        refreshToken: issued.token,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
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

function pickRefreshToken(request: FastifyRequest): string | undefined {
  const body = request.body as { refreshToken?: unknown } | undefined;
  if (body && typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
    return body.refreshToken;
  }
  return extractRefreshTokenFromCookie(request.headers.cookie);
}

function pickUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string') return ua;
  if (Array.isArray(ua)) return ua[0];
  return undefined;
}
