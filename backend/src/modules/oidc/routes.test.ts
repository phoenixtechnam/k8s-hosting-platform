import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

vi.mock('./service.js', () => ({
  getAuthStatus: vi.fn().mockResolvedValue({ providers: [], localEnabled: true }),
  generatePkce: vi.fn().mockReturnValue({ codeVerifier: 'cv', codeChallenge: 'cc' }),
  buildAuthorizationUrl: vi.fn().mockResolvedValue('https://idp.example.com/auth'),
  exchangeCodeForTokens: vi.fn().mockResolvedValue({
    idToken: { sub: 'ext-1', email: 'a@b.com', name: 'User' },
    provider: { panelScope: 'admin' },
  }),
  findOrCreateOidcUser: vi.fn().mockResolvedValue({
    id: 'u1', email: 'a@b.com', fullName: 'User', roleName: 'admin', panel: 'admin', clientId: null,
  }),
  handleBackchannelLogout: vi.fn().mockResolvedValue({ loggedOutUsers: 1 }),
  breakGlassLogin: vi.fn().mockResolvedValue({ id: 'u1', role: 'admin' }),
  listProviders: vi.fn().mockResolvedValue([]),
  createProvider: vi.fn().mockResolvedValue({ id: 'p1', display_name: 'Test' }),
  updateProvider: vi.fn().mockResolvedValue({ id: 'p1' }),
  deleteProvider: vi.fn().mockResolvedValue(undefined),
  testProviderConnection: vi.fn().mockResolvedValue({ status: 'ok' }),
  getGlobalSettings: vi.fn().mockResolvedValue({ enforceOidc: false }),
  saveGlobalSettings: vi.fn().mockResolvedValue({ enforceOidc: false }),
}));

const { oidcRoutes } = await import('./routes.js');

describe('oidc routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    app.decorate('config', { OIDC_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(oidcRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({
      sub: 'admin-1', role: 'super_admin', panel: 'admin',
      iat: Math.floor(Date.now() / 1000),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Public routes ──────────────────────────────────────────────────────

  it('GET /auth/oidc/status returns 200 (public, no auth)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/status',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.providers).toEqual([]);
    expect(body.data.localEnabled).toBe(true);
  });

  it('POST /auth/oidc/backchannel-logout without logout_token returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/backchannel-logout',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeDefined();
  });

  it('POST /auth/break-glass without required fields returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/break-glass',
      payload: { email: 'admin@example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /auth/break-glass with all fields returns 200 with token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/break-glass',
      payload: {
        email: 'admin@example.com',
        password: 'secret123',
        break_glass_secret: 'emergency-key',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.token).toBeDefined();
    expect(body.data.breakGlass).toBe(true);
    expect(body.data.user).toBeDefined();
  });

  // ─── Admin routes: Auth enforcement ─────────────────────────────────────

  it('GET /admin/oidc/providers without auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/oidc/providers',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/oidc/providers with admin token returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/oidc/providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
  });

  it('POST /admin/oidc/providers missing fields returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/oidc/providers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { display_name: 'Incomplete' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /admin/oidc/providers/:id returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/oidc/providers/p1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('GET /admin/oidc/settings returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/oidc/settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.enforceOidc).toBe(false);
  });
});
