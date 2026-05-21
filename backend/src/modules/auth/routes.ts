import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { loginSchema, changePasswordSchema, updateProfileSchema } from './schema.js';
import { authenticateUser, verifyPassword, hashNewPassword } from './service.js';
import { deleteAdminSeedSecret } from './seed-cleanup.js';
import { isLocalAuthDisabled } from '../oidc/service.js';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { users } from '../../db/schema.js';
import { extractPlatformSessionCookie, PLATFORM_SESSION_COOKIE, type JwtPayload } from '../../middleware/auth.js';
import {
  findSessionIdByHash,
  hashRefreshToken,
  issueRefreshToken,
  listActiveSessionsForUser,
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
  readonly panel: 'admin' | 'tenant';
  readonly tenantId?: string | null;
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
  if (input.tenantId) payload.tenantId = input.tenantId;
  if (input.impersonatedBy) payload.impersonatedBy = input.impersonatedBy;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.jwt.sign(payload as any);
}

const PRE_AUTH_TOKEN_TTL_SECONDS = 5 * 60;

/**
 * Issue a short-lived JWT that proves "step 1 (password) succeeded
 * for this user; awaiting passkey assertion as step 2".
 *
 * The token is signed with the same JWT secret as the access token —
 * differentiated by the `step: 'passkey_2fa'` claim and the JTI being
 * tracked single-use in auth_consumed_tokens. An attacker who steals
 * a pre-auth token can't use it as an access token because the access
 * verifier rejects payloads with non-empty `step` claims.
 */
function signPreAuthToken(app: FastifyInstance, userId: string, panel: 'admin' | 'tenant', jti: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    panel,
    step: 'passkey_2fa',
    exp: now + PRE_AUTH_TOKEN_TTL_SECONDS,
    iat: now,
    jti,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.jwt.sign(payload as any);
}

// Login rate limit. Production gets the conservative 10 / 15 minutes —
// real users only re-login a few times per day, so this is plenty for
// legitimate traffic and tight enough to throttle credential-stuffing
// botnets. Non-production (dev / staging / testing clusters) gets a
// much higher cap because integration test harnesses login on every
// scenario step and quickly exceed 10/15 min on any meaningful suite,
// which is what triggered the testing.phoenix-host.net 429s on
// 2026-05-01. Operator can also pin AUTH_LOGIN_RATE_LIMIT_MAX env var
// for custom values (e.g. CI runners that need even higher).
const LOGIN_RATE_LIMIT_MAX = (() => {
  const fromEnv = Number(process.env.AUTH_LOGIN_RATE_LIMIT_MAX);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const env = (process.env.PLATFORM_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
  return env === 'production' ? 10 : 200;
})();
const LOGIN_RATE_LIMIT_WINDOW = process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW ?? '15 minutes';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', {
    config: {
      rateLimit: {
        max: LOGIN_RATE_LIMIT_MAX,
        timeWindow: LOGIN_RATE_LIMIT_WINDOW,
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
    const loginPanel = (loginBody?.panel === 'tenant' ? 'tenant' : 'admin') as 'admin' | 'tenant';
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

    // Passkey 2FA branch: when user opted into 'second_factor' mode,
    // step 1 (password) must NOT issue session tokens. Return a
    // pre-auth token; the frontend transitions to a passkey-prompt
    // view and calls /auth/passkey/login/verify with the token.
    if (user.passkeyMode === 'second_factor') {
      const { issuePreAuthToken } = await import('./passkey-service.js');
      const pre = await issuePreAuthToken(
        app.db,
        user.id,
        (user.panel ?? 'admin') as 'admin' | 'tenant',
      );
      const preAuthToken = signPreAuthToken(app, user.id, pre.panel, pre.jti);
      return reply.send({
        data: {
          requires_passkey: true,
          pre_auth_token: preAuthToken,
          expires_in: PRE_AUTH_TOKEN_TTL_SECONDS,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            panel: user.panel,
            tenantId: user.tenantId,
          },
        },
      });
    }

    const accessToken = signAccessToken(app, {
      userId: user.id,
      role: user.role,
      panel: user.panel ?? 'admin',
      tenantId: user.tenantId,
    });

    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: (user.panel ?? 'admin') as 'admin' | 'tenant',
      tenantId: user.tenantId ?? null,
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
          tenantId: user.tenantId,
        },
      },
    });
  });

  /**
   * Runtime-info: surfaces which platform-api pod served the request,
   * the running version, and the build's git branch. Lightweight,
   * cacheable; both admin and tenant panels render it under the
   * sidebar title so operators can tell at a glance which node is
   * answering them and which build is live.
   *
   * Auth: any authenticated user (admin or tenant). Reads NODE_NAME,
   * POD_NAME, PLATFORM_VERSION, PLATFORM_BRANCH from env (downward
   * API + platform-version configmap).
   */
  app.get('/auth/runtime-info', async (request) => {
    await request.jwtVerify();
    return {
      data: {
        version: process.env.PLATFORM_VERSION ?? 'unknown',
        branch: process.env.PLATFORM_BRANCH ?? null,
        node: process.env.NODE_NAME ?? null,
        pod: process.env.POD_NAME ?? null,
        environment: process.env.PLATFORM_ENV ?? null,
      },
    };
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

    // For tenant-panel users, include the owning tenant's lifecycle
    // state so the UI can render a banner / block destructive pages
    // when the tenant is suspended or being operated on. Admin users
    // have no tenantId and skip this lookup entirely.
    let tenantStatus: string | null = null;
    let storageLifecycleState: string | null = null;
    if (user.tenantId) {
      const { tenants } = await import('../../db/schema.js');
      const [c] = await app.db
        .select({ status: tenants.status, state: tenants.storageLifecycleState })
        .from(tenants)
        .where(eq(tenants.id, user.tenantId))
        .limit(1);
      if (c) {
        tenantStatus = c.status;
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
        tenantId: user.tenantId ?? null,
        timezone: user.timezone ?? null,
        tenantStatus,
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

    // platform-admin-seed Secret cleanup: the bootstrap-time admin
    // password lives in `platform-admin-seed` and is what seed.ts
    // would INSERT on first install. After the user has rotated
    // their password through the UI, that Secret is permanently
    // out of sync with `users.password_hash` — keeping it around
    // creates a silent trap (bundle export emits a credential that
    // no longer works; a DB cold-restore that loses the new hash
    // could "resurrect" the seed password unexpectedly).
    //
    // Break-glass remains via scripts/admin-password-reset.sh, which
    // doesn't depend on the Secret existing. Best-effort delete: a
    // failure here MUST NOT bounce a successful password change
    // back to a 5xx. Logged at warn for ops visibility.
    let seedSecretCleared = false;
    try {
      const result = await deleteAdminSeedSecret();
      seedSecretCleared = result.cleared;
      if (result.reason === 'error') {
        app.log.warn(
          { err: result.error, userId: payload.sub },
          'platform-admin-seed cleanup failed after password change (non-fatal — password change itself succeeded)',
        );
      }
    } catch (err) {
      app.log.warn(
        { err, userId: payload.sub },
        'platform-admin-seed cleanup threw unexpectedly after password change (non-fatal)',
      );
    }

    // Phase 3: a password change MUST invalidate every refresh token —
    // any leaked token from before the change must stop working
    // immediately. The current request's access JWT is left alone (it
    // expires within 30 min). The user gets a fresh refresh token in
    // the response so the active session continues uninterrupted.
    await revokeAllUserRefreshTokens(app.db, payload.sub, 'password_change');
    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: (user.panel ?? 'admin') as 'admin' | 'tenant',
      tenantId: user.tenantId ?? null,
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
        // Surfaces to the UI: when true, the bootstrap-seed Secret
        // was deleted as part of this rotation (true on first
        // password change post-bootstrap; false thereafter or when
        // the operator pre-deleted it). UI can use this to show a
        // one-time "bootstrap seed cleared — break-glass via
        // scripts/admin-password-reset.sh" info toast.
        seedSecretCleared,
      },
    });
  });

  // GET /auth/me/sessions — list the caller's own active sessions
  // and mark which one is the CURRENT (i.e. issued by the same
  // refresh token they're presenting). The Security Hub Identity
  // page uses this so the operator can see "this is my laptop"
  // alongside other devices, and so the revoke-row button can be
  // disabled for the current session (revoking it would lock the
  // operator out of the open tab).
  //
  // Returns `{ sessions: ActiveSessionRow[], currentSessionId: string|null }`.
  // currentSessionId is null when the caller authenticated with a
  // Bearer-only flow (no refresh cookie present) — e.g. CI scripts.
  app.get('/auth/me/sessions', async (request) => {
    // Explicit jwtVerify call — consistent with /auth/me, /auth/profile,
    // /auth/password. Don't rely on ambient `request.user` because the
    // authRoutes plugin doesn't register a module-level authenticate
    // hook (a future plugin-registration reorder could leave us
    // unauthenticated, and a missing `request.user` would 401 — safe,
    // but the explicit verify is the documented contract).
    await request.jwtVerify();
    const user = (request as unknown as { user?: { sub?: string } }).user;
    if (!user?.sub) {
      throw new ApiError('AUTH_REQUIRED', 'Sign in required', 401);
    }
    const sessions = await listActiveSessionsForUser(app.db, user.sub);
    const presented = pickRefreshToken(request);
    const currentSessionId = presented
      ? await findSessionIdByHash(app.db, hashRefreshToken(presented))
      : null;
    return success({ sessions, currentSessionId });
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
      // tenant is already logged out from the server's POV.
    }
    clearSessionCookies(reply);
    return reply.send({ data: { message: 'Logged out successfully' } });
  });

  // GET /auth/verify-admin-session — nginx auth_request gate for admin-only
  // subdomains (stalwart.k8s-platform.test etc).
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
  //         (tenant-panel session, or admin-panel read_only role)
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

    // Archived tenant → terminal state, kill the session. Suspended is
    // still allowed so the user can see the suspension banner.
    if (user.tenantId) {
      const { tenants } = await import('../../db/schema.js');
      const [c] = await app.db
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, user.tenantId))
        .limit(1);
      if (c && c.status === 'archived') {
        await revokeRefreshTokenById(app.db, validation.id, 'admin_revoke');
        throw invalidToken();
      }
    }

    // Rotate: revoke the presented token (rotated), issue a new one.
    await revokeRefreshTokenById(app.db, validation.id, 'rotated');
    const issued = await issueRefreshToken(app.db, {
      userId: user.id,
      panel: validation.panel,
      tenantId: validation.tenantId,
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
      panel: (user.panel ?? 'admin') as 'admin' | 'tenant',
      tenantId: user.tenantId,
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
          tenantId: user.tenantId ?? null,
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
