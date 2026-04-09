import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

vi.mock('./service.js', () => ({
  getSubscription: vi.fn().mockResolvedValue({
    client_id: 'c1',
    plan: { id: 'p1', name: 'Basic' },
    status: 'active',
    subscription_expires_at: '2027-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  }),
  updateSubscription: vi.fn().mockResolvedValue({
    client_id: 'c1',
    plan: { id: 'p1', name: 'Basic' },
    status: 'suspended',
    subscription_expires_at: '2027-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  }),
}));

const { subscriptionRoutes } = await import('./routes.js');

describe('subscription routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let billingToken: string;
  let readOnlyToken: string;
  let clientAdminToken: string;
  let otherClientToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(subscriptionRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    billingToken = app.jwt.sign({ sub: 'billing-1', role: 'billing', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    // Round-4 Phase C: client_admin / client_user can now view their
    // own subscription via the GET endpoint.
    clientAdminToken = app.jwt.sign({
      sub: 'cu-1',
      role: 'client_admin',
      panel: 'client',
      clientId: 'c1',
      iat: Math.floor(Date.now() / 1000),
    });
    otherClientToken = app.jwt.sign({
      sub: 'cu-2',
      role: 'client_admin',
      panel: 'client',
      clientId: 'c2',
      iat: Math.floor(Date.now() / 1000),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/subscription' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read-only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // Round-4 Phase C: client_admin for its own client can read the
  // subscription but cannot modify it via PATCH.
  it('GET should allow client_admin for its own client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${clientAdminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.client_id).toBe('c1');
  });

  it('GET should reject client_admin trying to read a different client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${otherClientToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH should reject client_admin (admin/billing only)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${clientAdminToken}` },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET should return subscription for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.client_id).toBe('c1');
  });

  it('GET should allow billing role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${billingToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH should reject invalid status', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid-status' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update subscription', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/subscription',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
  });
});
