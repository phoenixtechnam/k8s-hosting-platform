import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockQuota = {
  id: 'q-1',
  clientId: 'c1',
  cpuCoresLimit: '2.00',
  memoryGbLimit: 4,
  storageGbLimit: 50,
  bandwidthGbLimit: 100,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  getResourceQuota: vi.fn().mockResolvedValue(mockQuota),
  updateResourceQuota: vi.fn().mockResolvedValue({ ...mockQuota, cpuCoresLimit: '4.00' }),
}));

const { resourceQuotaRoutes } = await import('./routes.js');

describe('resource-quota routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(resourceQuotaRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET resource-quota should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/resource-quota' });
    expect(res.statusCode).toBe(401);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET resource-quota should return quota for any authenticated user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/resource-quota',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── PATCH ───────────────────────────────────────────────────────────────

  it('PATCH resource-quota should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/resource-quota',
      headers: { authorization: `Bearer ${supportToken}` },
      payload: { cpu_cores_limit: 4 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH resource-quota should update for admin', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/resource-quota',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { cpu_cores_limit: 4 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
