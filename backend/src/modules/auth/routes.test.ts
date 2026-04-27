import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { hashNewPassword } from './service.js';

const mockUser = {
  id: 'u1',
  email: 'admin@example.com',
  passwordHash: await hashNewPassword('correct-password'),
  fullName: 'Admin User',
  roleName: 'admin',
  status: 'active',
};

const mockSet = vi.fn().mockReturnThis();
const mockWhere = vi.fn().mockResolvedValue([]);
const mockSelectWhere = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) });
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockWhere });

// Phase 3: refresh-token-service issues a row on every login + refresh
// and revokes on logout / password change. Mock both insert / update /
// delete so the in-memory test stack doesn't crash on these calls.
const mockInsertValues = vi.fn().mockResolvedValue([]);
const mockDeleteWhere = vi.fn().mockResolvedValue({ rowCount: 0 });

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: mockSelectWhere,
    }),
  }),
  update: vi.fn().mockReturnValue({
    set: mockUpdateSet,
  }),
  insert: vi.fn().mockReturnValue({
    values: mockInsertValues,
  }),
  delete: vi.fn().mockReturnValue({
    where: mockDeleteWhere,
  }),
};

vi.mock('./service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./service.js')>();
  return {
    ...original,
    authenticateUser: vi.fn().mockResolvedValue({
      id: 'u1',
      email: 'admin@example.com',
      fullName: 'Admin User',
      role: 'admin',
    }),
  };
});

vi.mock('../oidc/service.js', () => ({
  isLocalAuthDisabled: vi.fn().mockResolvedValue(false),
}));

const { authRoutes } = await import('./routes.js');

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    app.setErrorHandler(errorHandler);

    app.decorate('db', mockDb);
    await app.register(authRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/v1/auth/login should return token on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.com', password: 'correct-password' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.token).toBeDefined();
    expect(body.data.user.email).toBe('admin@example.com');
    expect(body.data.user.role).toBe('admin');
  });

  it('POST /api/v1/auth/login should reject invalid email format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'not-valid', password: 'anything' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/auth/login should reject missing password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.com' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/auth/me should return user info with valid token', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.id).toBe('u1');
    expect(body.data.role).toBe('admin');
  });

  it('GET /api/v1/auth/me should reject without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    // jwtVerify throws a Fastify error which gets caught by the error handler
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  // ─── PATCH /api/v1/auth/password ───

  it('PATCH /api/v1/auth/password should return 401 without auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      payload: { current_password: 'old', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('PATCH /api/v1/auth/password should return 400 with missing fields', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/v1/auth/password should return 400 when new_password is too short', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'correct-password', new_password: 'ab' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/v1/auth/password should return 401 with wrong current password', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'wrong-password', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('PATCH /api/v1/auth/password should return 200 on successful password change', async () => {
    const token = app.jwt.sign({ sub: 'u1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/auth/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'correct-password', new_password: 'newpass123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.message).toBe('Password updated successfully');
  });

  // ─── Session cookie (Phase 7: subdomain auth_request) ───

  describe('platform_session cookie', () => {
    it('POST /auth/login sets platform_session cookie with SameSite=Lax when no SESSION_COOKIE_DOMAIN (dev)', async () => {
      const prev = process.env.SESSION_COOKIE_DOMAIN;
      delete process.env.SESSION_COOKIE_DOMAIN;
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'admin@example.com', password: 'correct-password' },
        });
        expect(res.statusCode).toBe(200);
        const setCookie = res.headers['set-cookie'];
        const header = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
        expect(header).toMatch(/platform_session=/);
        expect(header).toMatch(/platform_refresh=/);
        expect(header).toMatch(/HttpOnly/i);
        expect(header).toMatch(/SameSite=Lax/i);
        expect(header).toMatch(/Secure/i);
        expect(header).toMatch(/Path=\//);
        // Phase 3: access cookie 1800s (30min), refresh cookie 86400s (24h).
        expect(header).toMatch(/Max-Age=1800/);
        expect(header).toMatch(/Max-Age=86400/);
        expect(header).not.toMatch(/Domain=/i);
      } finally {
        if (prev !== undefined) process.env.SESSION_COOKIE_DOMAIN = prev;
      }
    });

    it('POST /auth/login upgrades to SameSite=None when SESSION_COOKIE_DOMAIN is set (staging/prod)', async () => {
      // Cross-subdomain iframes (admin.<apex> embedding longhorn.<apex>)
      // require SameSite=None so the cookie is sent on subresource
      // loads. Browsers also require Secure for SameSite=None, which
      // the cookie builder already includes unconditionally.
      const prev = process.env.SESSION_COOKIE_DOMAIN;
      process.env.SESSION_COOKIE_DOMAIN = '.staging.phoenix-host.net';
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'admin@example.com', password: 'correct-password' },
        });
        expect(res.statusCode).toBe(200);
        const setCookie = res.headers['set-cookie'];
        const header = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
        expect(header).toMatch(/SameSite=None/i);
        expect(header).not.toMatch(/SameSite=Lax/i);
        expect(header).toMatch(/Secure/i);
        expect(header).toMatch(/Domain=\.staging\.phoenix-host\.net/);
      } finally {
        if (prev === undefined) delete process.env.SESSION_COOKIE_DOMAIN;
        else process.env.SESSION_COOKIE_DOMAIN = prev;
      }
    });

    it('POST /auth/logout clears platform_session cookie (Max-Age=0)', async () => {
      const token = app.jwt.sign({
        sub: 'u1', role: 'admin', panel: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie.join('\n') : setCookie;
      expect(header).toMatch(/platform_session=/);
      expect(header).toMatch(/Max-Age=0/);
    });
  });

  // ─── GET /auth/verify-admin-session (Phase 7: auth_request gate) ───

  describe('GET /auth/verify-admin-session', () => {
    it('returns 204 with a valid admin-panel cookie', async () => {
      // Use jti to avoid colliding with tokens the logout test added to the
      // in-memory denylist — they share sub/role/panel and are signed in the
      // same second, so without a differentiator the payloads are identical.
      const token = app.jwt.sign({
        sub: 'verify-cookie', role: 'admin', panel: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
        jti: 'verify-cookie-jti',
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-session',
        headers: { cookie: `platform_session=${token}` },
      });
      expect(res.statusCode).toBe(204);
    });

    it('ignores Authorization Bearer (cookie-only gate — prevents Stalwart OAuth contamination)', async () => {
      // The gated UI (Stalwart web-admin) sends its own Authorization
      // Bearer on XHR calls. auth_request forwards headers, so Bearer
      // MUST NOT be consulted here — otherwise Stalwart's OAuth token
      // lands at our JWT verifier, fails, and the iframe redirects
      // cross-origin to /login (→ CORS "Failed to fetch" in browser).
      const token = app.jwt.sign({
        sub: 'u1', role: 'super_admin', panel: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-session',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 without any credential', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/verify-admin-session' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 with an invalid cookie token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-session',
        headers: { cookie: 'platform_session=garbage.not.jwt' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for a client-panel session (admin gate only)', async () => {
      const token = app.jwt.sign({
        sub: 'cu', role: 'client_user', panel: 'client', clientId: 'c1',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-session',
        headers: { cookie: `platform_session=${token}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for an admin-panel read_only role (write gate for Stalwart UI)', async () => {
      const token = app.jwt.sign({
        sub: 'ro', role: 'read_only', panel: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-session',
        headers: { cookie: `platform_session=${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ─── GET /auth/verify-admin-email (oauth2-proxy gate) ───
  //
  // When oauth2-proxy sits in front of admin-only subdomains with
  // --set-xauthrequest=true, it sets X-Auth-Request-Email. Nginx passes that
  // header to this endpoint via auth_request, and we resolve it against our
  // users table + role allow-list.
  //
  // This endpoint is the OAuth2-proxy-mode equivalent of
  // /auth/verify-admin-session (cookie-mode). Overlays pick one gate or the
  // other via Kustomize components.

  describe('GET /auth/verify-admin-email', () => {
    const adminRow = { email: 'admin@example.com', roleName: 'admin', status: 'active' };
    const billingRow = { email: 'billing@example.com', roleName: 'billing', status: 'active' };
    const supportRow = { email: 'support@example.com', roleName: 'support', status: 'active' };
    const superRow = { email: 'root@example.com', roleName: 'super_admin', status: 'active' };
    const readOnlyRow = { email: 'ro@example.com', roleName: 'read_only', status: 'active' };
    const inactiveRow = { email: 'old@example.com', roleName: 'admin', status: 'disabled' };

    // mockReturnValueOnce accumulates across tests that don't consume the
    // mock (e.g. 401-header-missing never touches the DB). Use the sticky
    // mockReturnValue instead; each test sets what its own call will see,
    // and subsequent tests overwrite it cleanly.
    function mockDbLookup(rows: Array<{ email: string }>) {
      mockSelectWhere.mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      });
    }

    it('returns 401 when X-Auth-Request-Email header is missing', async () => {
      mockDbLookup([]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when X-Auth-Request-Email header is empty', async () => {
      mockDbLookup([]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': '' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when the header is whitespace only (trim empties it)', async () => {
      mockDbLookup([]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': '   ' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when the email does not match any user', async () => {
      mockDbLookup([]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': 'nobody@example.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for a client_user role (structurally different from read_only)', async () => {
      mockDbLookup([{ email: 'cu@example.com', roleName: 'client_user', status: 'active' }]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': 'cu@example.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for a read_only user (matches session gate behaviour)', async () => {
      mockDbLookup([readOnlyRow]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': readOnlyRow.email },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 for a disabled user even with an allowed role', async () => {
      mockDbLookup([inactiveRow]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': inactiveRow.email },
      });
      expect(res.statusCode).toBe(403);
    });

    it.each([
      ['super_admin', superRow],
      ['admin', adminRow],
      ['billing', billingRow],
      ['support', supportRow],
    ])('returns 204 for an active %s user', async (_label, row) => {
      mockDbLookup([row]);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/verify-admin-email',
        headers: { 'x-auth-request-email': row.email },
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
