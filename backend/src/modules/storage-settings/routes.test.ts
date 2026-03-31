import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockSettings = {
  id: 'ss-1',
  defaultStorageClass: 'hcloud-volumes',
  defaultStorageLimitMb: 10240,
  maxStorageLimitMb: 102400,
  enablePersistentVolumes: true,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  getStorageSettings: vi.fn().mockResolvedValue(mockSettings),
  updateStorageSettings: vi.fn().mockResolvedValue({ ...mockSettings, defaultStorageLimitMb: 20480 }),
}));

const { storageSettingsRoutes } = await import('./routes.js');

describe('storage-settings routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(storageSettingsRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('GET storage-settings should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/storage-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET storage-settings should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage-settings',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- GET ---

  it('GET storage-settings should return settings for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/storage-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- PATCH ---

  it('PATCH storage-settings should update with valid body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/storage-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { defaultStorageLimitMb: 20480 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('PATCH storage-settings should work with empty body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/storage-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
