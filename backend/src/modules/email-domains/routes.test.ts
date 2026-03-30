import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockEmailDomain = {
  id: 'ed-1',
  domainId: 'd1',
  clientId: 'c1',
  domainName: 'example.com',
  enabled: 1,
  dkimSelector: 'default',
  dkimPublicKey: 'pk-data',
  maxMailboxes: 50,
  maxQuotaMb: 10240,
  catchAllAddress: null,
  mxProvisioned: 1,
  spfProvisioned: 1,
  dkimProvisioned: 1,
  dmarcProvisioned: 1,
  spamThresholdJunk: '5.0',
  spamThresholdReject: '10.0',
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listAllEmailDomains: vi.fn().mockResolvedValue([mockEmailDomain]),
  enableEmailForDomain: vi.fn().mockResolvedValue(mockEmailDomain),
  disableEmailForDomain: vi.fn().mockResolvedValue(undefined),
  listEmailDomains: vi.fn().mockResolvedValue([mockEmailDomain]),
  getEmailDomain: vi.fn().mockResolvedValue(mockEmailDomain),
  updateEmailDomain: vi.fn().mockResolvedValue({ ...mockEmailDomain, maxMailboxes: 100 }),
}));

const { emailDomainRoutes } = await import('./routes.js');

describe('email-domain routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let supportToken: string;
  let clientUserToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(emailDomainRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    clientUserToken = app.jwt.sign({ sub: 'cu-1', role: 'client_user', panel: 'client', clientId: 'c1', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Admin list ──

  it('GET /admin/email/domains should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/email/domains' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/email/domains should reject read_only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/domains',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /admin/email/domains should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/domains',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  // ── Client-scoped: enable ──

  it('POST enable should require auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/d1/enable',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST enable should reject client_user role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/d1/enable',
      headers: { authorization: `Bearer ${clientUserToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST enable should create with valid/empty body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/d1/enable',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST enable should reject invalid max_mailboxes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/d1/enable',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { max_mailboxes: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  // ── Client-scoped: disable ──

  it('DELETE disable should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/email/domains/d1/disable',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // ── Client-scoped: list ──

  it('GET client email domains should allow support', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/email/domains',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Client-scoped: get ──

  it('GET single email domain should return data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/email/domains/ed-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Client-scoped: update ──

  it('PATCH should reject invalid catch_all_address', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/email/domains/ed-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { catch_all_address: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/email/domains/ed-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { max_mailboxes: 100 },
    });
    expect(res.statusCode).toBe(200);
  });
});
