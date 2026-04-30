import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { auditLogs, users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  loadPasskeyConfig,
  beginRegistration,
  completeRegistration,
  beginAuthentication,
  completeAuthentication,
  listPasskeys,
  deletePasskey,
  setPasskeyMode,
  verifyAndConsumePreAuthToken,
  type PasskeyMode,
  type PasskeyPanel,
} from './passkey-service.js';
import {
  issueRefreshToken,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './refresh-token-service.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { PLATFORM_SESSION_COOKIE } from '../../middleware/auth.js';
import type { Database } from '../../db/index.js';

const REFRESH_COOKIE = 'platform_refresh';

function buildSessionCookie(name: string, token: string, maxAge: number): string {
  const domain = process.env.SESSION_COOKIE_DOMAIN;
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

function pickUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers['user-agent'];
  if (typeof ua === 'string') return ua;
  if (Array.isArray(ua)) return ua[0];
  return undefined;
}

interface AccessTokenPayload {
  sub: string;
  role: string;
  panel: 'admin' | 'client';
  clientId?: string | null;
}

function signAccessToken(app: FastifyInstance, p: AccessTokenPayload): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: p.sub,
    role: p.role,
    panel: p.panel,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    iat: now,
    jti: randomUUID(),
  };
  if (p.clientId) payload.clientId = p.clientId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.jwt.sign(payload as any);
}

/**
 * Resolve the panel for a request:
 *   • Unauthenticated endpoints: from body.panel (matches /auth/login).
 *   • Authenticated endpoints: from the JWT panel claim.
 */
function panelFromBody(request: FastifyRequest): PasskeyPanel {
  const body = (request.body ?? {}) as { panel?: unknown };
  return body.panel === 'client' ? 'client' : 'admin';
}

async function recordAudit(
  db: Database,
  actorId: string,
  actionType: string,
  resourceId: string | null,
  request: FastifyRequest,
  changes?: Record<string, unknown>,
) {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      clientId: null,
      actionType,
      resourceType: 'passkey',
      resourceId: resourceId ?? actorId,
      actorId,
      actorType: 'user',
      httpMethod: request.method,
      httpPath: request.url.slice(0, 500),
      httpStatus: 200,
      changes: changes ?? null,
      ipAddress: request.ip,
    });
  } catch (err) {
    request.log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      `[passkey-routes] audit log insert failed for ${actionType}`,
    );
  }
}

export async function passkeyRoutes(app: FastifyInstance) {
  const config = loadPasskeyConfig();

  /**
   * Begin registration. Authenticated — caller must be the user
   * adding a passkey to their own account. CSRF defense: requires
   * Authorization: Bearer header (cookie auth alone is rejected) so
   * a cross-site form submission can't enroll an attacker's passkey.
   */
  app.post('/auth/passkey/registration/options', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'client' };
    const options = await beginRegistration(app.db, config, payload.sub, payload.panel);
    return reply.send({ data: options });
  });

  /**
   * Complete registration. Verifies the attestation and persists the
   * credential. nickname is required so the UI can show "iPhone",
   * "YubiKey 5C", etc. on the manage page.
   */
  app.post('/auth/passkey/registration/verify', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'client' };
    const body = (request.body ?? {}) as { response?: unknown; nickname?: unknown };
    if (!body.response || typeof body.nickname !== 'string' || body.nickname.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'response and nickname are required', 400);
    }
    const result = await completeRegistration(app.db, config, {
      userId: payload.sub,
      panel: payload.panel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      nickname: body.nickname,
    });
    await recordAudit(app.db, payload.sub, 'passkey_registered', result.id, request, {
      nickname: result.nickname,
    });
    return reply.send({ data: result });
  });

  /**
   * Begin login. Two flavors:
   *   • No pre_auth_token   → userless / discoverable creds.
   *                            Browser shows passkeys for this RP.
   *   • { pre_auth_token }  → 2FA step 2. Server scopes
   *                            allowCredentials to that user.
   */
  app.post('/auth/passkey/login/options', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const panel = panelFromBody(request);
    if (await isLocalAuthDisabled(app.db, panel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled for this panel', 403);
    }
    const body = (request.body ?? {}) as { pre_auth_token?: string };
    let userId: string | null = null;
    if (body.pre_auth_token) {
      const claims = await verifyPreAuthClaims(app, body.pre_auth_token, panel);
      userId = claims.sub;
    }
    const options = await beginAuthentication(app.db, config, panel, userId);
    return reply.send({ data: options });
  });

  /**
   * Complete login. Same two flavors. On success, issues the same
   * access+refresh tokens as /auth/login.
   */
  app.post('/auth/passkey/login/verify', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const panel = panelFromBody(request);
    if (await isLocalAuthDisabled(app.db, panel)) {
      throw new ApiError('LOCAL_AUTH_DISABLED', 'Local authentication is disabled for this panel', 403);
    }
    const body = (request.body ?? {}) as { response?: unknown; pre_auth_token?: string };
    if (!body.response) {
      throw new ApiError('VALIDATION_ERROR', 'response is required', 400);
    }

    let expectedUserId: string | undefined;
    if (body.pre_auth_token) {
      const claims = await verifyPreAuthClaims(app, body.pre_auth_token, panel);
      // Atomic single-use mark BEFORE the assertion is verified. This
      // means a failed WebAuthn ceremony (wrong PIN, dismissed prompt,
      // bad signature) still consumes the pre-auth token — the
      // operator must restart at /auth/login. The alternative
      // (consume only on success) would give an attacker an unlimited
      // replay window during the 5-min TTL, which is the worse
      // trade-off. The frontend renders the AUTHENTICATION_FAILED
      // error with a "go back to login" affordance.
      await verifyAndConsumePreAuthToken(app.db, claims.jti, claims.sub, panel);
      expectedUserId = claims.sub;
    }

    const result = await completeAuthentication(app.db, config, {
      panel,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
      expectedUserId,
    });

    const user = result.user;
    const accessToken = signAccessToken(app, {
      sub: user.id,
      role: user.roleName,
      panel: (user.panel ?? 'admin') as 'admin' | 'client',
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

    await recordAudit(
      app.db,
      user.id,
      expectedUserId ? 'passkey_login_2fa' : 'passkey_login_userless',
      result.passkeyId,
      request,
    );

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
          panel: user.panel,
          clientId: user.clientId,
        },
      },
    });
  });

  /** List the caller's passkeys + current mode. */
  app.get('/auth/passkey', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'client' };
    const list = await listPasskeys(app.db, payload.sub);
    const [user] = await app.db.select({ mode: users.passkeyMode }).from(users).where(eq(users.id, payload.sub)).limit(1);
    return reply.send({ data: { passkeys: list, mode: user?.mode ?? null } });
  });

  /** Delete a passkey. Service refuses last-passkey delete in 2FA mode. */
  app.delete('/auth/passkey/:id', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'client' };
    const passkeyId = (request.params as { id: string }).id;
    await deletePasskey(app.db, payload.sub, passkeyId);
    await recordAudit(app.db, payload.sub, 'passkey_deleted', passkeyId, request);
    return reply.code(204).send();
  });

  /** Set passkey mode for the current user. */
  app.patch('/auth/passkey-mode', async (request, reply) => {
    await assertBearerAuth(request);
    const payload = request.user as { sub: string; panel: 'admin' | 'client' };
    const body = (request.body ?? {}) as { mode?: unknown };
    const mode = body.mode;
    if (mode !== null && mode !== 'alternative' && mode !== 'second_factor') {
      throw new ApiError('VALIDATION_ERROR',
        "mode must be 'alternative', 'second_factor', or null", 400);
    }
    await setPasskeyMode(app.db, payload.sub, mode as PasskeyMode);
    await recordAudit(app.db, payload.sub, 'passkey_mode_changed', payload.sub, request, {
      mode: mode ?? null,
    });
    return reply.send({ data: { mode } });
  });
}

/**
 * Authenticated endpoints require the request to carry a Bearer JWT
 * in the Authorization header. The cookie alone (platform_session) is
 * NOT enough — defense-in-depth against CSRF: an attacker page can
 * fire a fetch with the user's cookies but cannot forge a Bearer
 * header from another origin without a token leak.
 */
async function assertBearerAuth(request: FastifyRequest): Promise<void> {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
    throw invalidToken();
  }
  await request.jwtVerify();
  const payload = request.user as { step?: string };
  // Pre-auth tokens carry step:'passkey_2fa' — they're not access tokens.
  if (payload.step) {
    throw invalidToken();
  }
}

interface PreAuthClaims { sub: string; panel: 'admin' | 'client'; jti: string; }

async function verifyPreAuthClaims(
  app: FastifyInstance,
  token: string,
  panel: PasskeyPanel,
): Promise<PreAuthClaims> {
  let decoded: { sub?: string; panel?: string; step?: string; jti?: string; exp?: number };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    decoded = app.jwt.verify(token) as any;
  } catch {
    throw new ApiError('PRE_AUTH_TOKEN_INVALID', 'Pre-auth token invalid or expired', 401);
  }
  if (decoded.step !== 'passkey_2fa' || !decoded.sub || !decoded.jti) {
    throw new ApiError('PRE_AUTH_TOKEN_INVALID', 'Pre-auth token has wrong shape', 401);
  }
  if (decoded.panel !== panel) {
    throw new ApiError('PRE_AUTH_TOKEN_PANEL_MISMATCH',
      `Pre-auth token panel ${decoded.panel} does not match request panel ${panel}`, 401);
  }
  return { sub: decoded.sub, panel, jti: decoded.jti };
}
