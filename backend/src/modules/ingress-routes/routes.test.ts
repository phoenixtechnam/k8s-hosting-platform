import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockRoute = {
  id: 'route-1',
  domainId: 'dom-1',
  clientId: 'client-1',
  hostname: 'app.example.com',
  workloadId: 'wl-1',
  tlsMode: 'auto',
  nodeHostname: null,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

const mockIngressSettings = {
  id: 'is-1',
  ingressBaseDomain: 'example.com',
  ingressDefaultIpv4: '1.2.3.4',
  ingressDefaultIpv6: null,
};

vi.mock('./service.js', () => ({
  listRoutesForDomain: vi.fn().mockResolvedValue([mockRoute]),
  createRoute: vi.fn().mockResolvedValue(mockRoute),
  updateRoute: vi.fn().mockResolvedValue({ ...mockRoute, tlsMode: 'strict' }),
  deleteRoute: vi.fn().mockResolvedValue(undefined),
  getIngressSettings: vi.fn().mockResolvedValue(mockIngressSettings),
  updateIngressSettings: vi.fn().mockResolvedValue({ ...mockIngressSettings, ingressBaseDomain: 'new.example.com' }),
}));

const { ingressRouteRoutes } = await import('./routes.js');

describe('ingress-routes routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(ingressRouteRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- Auth ---

  it('GET client routes should require auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/client-1/domains/dom-1/routes',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET admin ingress-settings should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/ingress-settings' });
    expect(res.statusCode).toBe(401);
  });

  // --- GET list routes ---

  it('GET routes should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/client-1/domains/dom-1/routes',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  // --- POST create route ---

  it('POST route should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/client-1/domains/dom-1/routes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        hostname: 'app.example.com',
        workload_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  it('POST route should reject empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/client-1/domains/dom-1/routes',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // --- DELETE route ---

  it('DELETE route should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/client-1/domains/dom-1/routes/route-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // --- Admin ingress settings ---

  it('GET ingress-settings should return settings for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/ingress-settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  it('PATCH ingress-settings should update with valid body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/ingress-settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ingressBaseDomain: 'new.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });
});
