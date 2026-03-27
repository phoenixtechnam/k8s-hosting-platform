import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

vi.mock('./service.js', () => ({
  getMetrics: vi.fn().mockResolvedValue({
    client_id: 'c1',
    period: '24h',
    since: new Date().toISOString(),
    metrics: {},
    data_points: 0,
  }),
}));

const { metricsRoutes } = await import('./routes.js');

describe('metrics routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(metricsRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject support role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/metrics',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should allow admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/metrics',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.client_id).toBe('c1');
  });

  it('should allow read-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/metrics',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should accept period query param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/metrics?period=7d',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
