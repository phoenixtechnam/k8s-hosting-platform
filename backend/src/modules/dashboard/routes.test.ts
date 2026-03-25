import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { dashboardRoutes } from './routes.js';

describe('dashboard routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Stub db: each select().from() call returns a single-element array with a count
    const mockDb = {
      select: (fields: Record<string, unknown>) => ({
        from: () => {
          const keys = Object.keys(fields);
          const result: Record<string, number> = {};
          for (const key of keys) {
            if (key === 'active_clients') {
              result[key] = 8;
            } else if (key === 'total_clients') {
              result[key] = 12;
            } else if (key === 'total_domains') {
              result[key] = 25;
            } else if (key === 'total_databases') {
              result[key] = 18;
            } else if (key === 'total_backups') {
              result[key] = 42;
            } else {
              result[key] = 0;
            }
          }
          return Promise.resolve([result]);
        },
      }),
    };
    app.decorate('db', mockDb);

    await app.register(dashboardRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read-only', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/admin/dashboard should return 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('should return 403 for unsupported roles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should return 200 with valid admin JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should return 200 for read-only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should return expected dashboard fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dashboard',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.total_clients).toBe(12);
    expect(body.data.active_clients).toBe(8);
    expect(body.data.total_domains).toBe(25);
    expect(body.data.total_databases).toBe(18);
    expect(body.data.total_backups).toBe(42);
    expect(body.data.platform_version).toBe('0.1.0');
  });
});
