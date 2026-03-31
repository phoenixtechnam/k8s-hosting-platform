import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockSettings = {
  id: 'tls-1',
  clusterIssuerName: 'letsencrypt-prod',
  autoTlsEnabled: true,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  getTlsSettings: vi.fn().mockResolvedValue(mockSettings),
  updateTlsSettings: vi.fn().mockResolvedValue({ ...mockSettings, clusterIssuerName: 'letsencrypt-staging' }),
}));

const { tlsSettingsRoutes } = await import('./routes.js');

describe('tls-settings routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(tlsSettingsRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('GET tls-settings should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/tls-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET tls-settings should reject non-admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tls-settings',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- GET ---

  it('GET tls-settings should return settings for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/tls-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // --- PATCH ---

  it('PATCH tls-settings should update with valid body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tls-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        clusterIssuerName: 'letsencrypt-staging',
        autoTlsEnabled: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('PATCH tls-settings should require auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tls-settings',
      payload: { autoTlsEnabled: false },
    });
    expect(res.statusCode).toBe(401);
  });
});
