import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockSettings = {
  id: 'hs-1',
  domainId: 'd1',
  redirectWww: true,
  redirectHttps: true,
  hostingEnabled: true,
  forwardExternal: null,
  webrootPath: '/public_html',
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  getHostingSettings: vi.fn().mockResolvedValue(mockSettings),
  updateHostingSettings: vi.fn().mockResolvedValue({ ...mockSettings, redirectWww: false }),
}));

const { hostingSettingsRoutes } = await import('./routes.js');

describe('hosting-settings routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(hostingSettingsRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET hosting-settings should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/domains/d1/hosting-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET hosting-settings should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/hosting-settings',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET hosting-settings should return settings for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/hosting-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── PATCH ───────────────────────────────────────────────────────────────

  it('PATCH hosting-settings should reject invalid field values', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1/hosting-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { redirect_www: 'not-a-boolean' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH hosting-settings should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1/hosting-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { redirect_www: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
