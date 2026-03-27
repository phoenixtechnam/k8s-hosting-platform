import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockDomain = {
  id: 'd1',
  clientId: 'c1',
  domainName: 'example.com',
  dnsMode: 'cname',
  status: 'active',
};

vi.mock('./service.js', () => ({
  createDomain: vi.fn().mockResolvedValue(mockDomain),
  getDomainById: vi.fn().mockResolvedValue(mockDomain),
  listDomains: vi.fn().mockResolvedValue({
    data: [mockDomain],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateDomain: vi.fn().mockResolvedValue({ ...mockDomain, dnsMode: 'primary' }),
  deleteDomain: vi.fn().mockResolvedValue(undefined),
}));

const { domainRoutes } = await import('./routes.js');

describe('domain routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(domainRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/domains' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read-only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should allow admin to list domains', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('should allow support to list domains', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /:domainId should return domain', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST should reject invalid domain body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { domain_name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should create domain with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { domain_name: 'test.example.com' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH should reject invalid dns_mode', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { dns_mode: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { dns_mode: 'primary' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/domains/d1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
