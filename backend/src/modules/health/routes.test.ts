import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockHealthResult = {
  overall: 'healthy',
  services: [
    { name: 'database', status: 'ok', latencyMs: 5 },
    { name: 'dns', status: 'ok', latencyMs: 12 },
  ],
  checkedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  runAllChecks: vi.fn().mockResolvedValue(mockHealthResult),
}));

const { healthRoutes } = await import('./routes.js');

describe('health routes', () => {
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
    app.decorate('config', { OIDC_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(healthRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/health' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject support role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should allow read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should return health check result for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/health',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.overall).toBe('healthy');
    expect(body.data.services).toHaveLength(2);
  });
});
