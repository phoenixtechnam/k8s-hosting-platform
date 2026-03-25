import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { auditLogRoutes } from './routes.js';

const MOCK_AUDIT_ROWS = [
  {
    id: 'log-1',
    clientId: null,
    actionType: 'create',
    resourceType: 'client',
    resourceId: 'c-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'POST',
    httpPath: '/api/v1/clients',
    httpStatus: 201,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date('2026-03-25T10:00:00Z'),
  },
  {
    id: 'log-2',
    clientId: 'c-1',
    actionType: 'update',
    resourceType: 'domain',
    resourceId: 'd-1',
    actorId: 'admin-1',
    actorType: 'user',
    httpMethod: 'PATCH',
    httpPath: '/api/v1/clients/c-1/domains/d-1',
    httpStatus: 200,
    changes: null,
    ipAddress: '127.0.0.1',
    createdAt: new Date('2026-03-25T09:00:00Z'),
  },
];

function createMockDb(rows: readonly Record<string, unknown>[] = MOCK_AUDIT_ROWS) {
  return {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([...rows]),
        }),
      }),
    }),
  };
}

describe('audit-logs routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', createMockDb());

    await app.register(auditLogRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read-only', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/admin/audit-logs should return 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs' });
    expect(res.statusCode).toBe(401);
  });

  it('should return 403 for non-admin roles', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should return 200 with valid admin JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('should return data array with audit log entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].actionType).toBe('create');
    expect(body.data[0].resourceType).toBe('client');
  });

  it('should accept a limit query parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
