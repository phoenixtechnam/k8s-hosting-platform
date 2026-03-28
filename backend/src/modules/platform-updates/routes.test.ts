import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockVersionInfo = {
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  updateAvailable: true,
  environment: 'production',
  autoUpdate: false,
  lastCheckedAt: '2026-03-28T00:00:00.000Z',
};

const mockUpdateSettings = {
  autoUpdate: true,
};

const mockTriggerResponse = {
  message: 'Update initiated',
  targetVersion: '0.2.0',
};

// Mock the service module before importing routes
vi.mock('./service.js', () => ({
  getVersionInfo: vi.fn().mockResolvedValue(mockVersionInfo),
  updateSettings: vi.fn().mockResolvedValue(mockUpdateSettings),
  triggerUpdate: vi.fn().mockResolvedValue(mockTriggerResponse),
}));

// Import routes AFTER mocking
const { platformUpdateRoutes } = await import('./routes.js');

describe('platform-updates routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Decorate with a stub db (service is mocked, so db won't be used)
    app.decorate('db', {});
    await app.register(platformUpdateRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // GET /api/v1/admin/platform/version

  it('GET /api/v1/admin/platform/version should return 200 with version info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/platform/version',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.currentVersion).toBe('0.1.0');
    expect(body.data.latestVersion).toBe('0.2.0');
    expect(body.data.updateAvailable).toBe(true);
    expect(body.data.environment).toBe('production');
    expect(typeof body.data.autoUpdate).toBe('boolean');
    expect(body.data.lastCheckedAt).toBeDefined();
  });

  it('GET /api/v1/admin/platform/version without auth should return 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/platform/version',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/admin/platform/version with read_only role should return 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/platform/version',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // PUT /api/v1/admin/platform/update-settings

  it('PUT /api/v1/admin/platform/update-settings should return 200 with updated settings', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/platform/update-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { autoUpdate: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.autoUpdate).toBe(true);
  });

  it('PUT /api/v1/admin/platform/update-settings with invalid body should return 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/platform/update-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { autoUpdate: 'not-a-boolean' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/v1/admin/platform/update-settings without auth should return 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/platform/update-settings',
      payload: { autoUpdate: true },
    });
    expect(res.statusCode).toBe(401);
  });

  // POST /api/v1/admin/platform/update

  it('POST /api/v1/admin/platform/update should return 200 with trigger response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/platform/update',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.message).toBe('Update initiated');
    expect(body.data.targetVersion).toBe('0.2.0');
  });

  it('POST /api/v1/admin/platform/update without auth should return 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/platform/update',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/v1/admin/platform/update with read_only role should return 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/platform/update',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
