import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockCert = {
  id: 'cert-1',
  domainId: 'd1',
  clientId: 'c1',
  issuer: 'CN=Test CA',
  subject: 'CN=example.com',
  expiresAt: new Date('2027-01-01').toISOString(),
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  uploadCert: vi.fn().mockResolvedValue(mockCert),
  getCert: vi.fn().mockResolvedValue(mockCert),
  deleteCert: vi.fn().mockResolvedValue(undefined),
}));

const { sslCertRoutes } = await import('./routes.js');

describe('ssl-cert routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    app.decorate('config', { OIDC_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(sslCertRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ────────────────────────────────────────────────────────────────

  it('GET ssl-cert should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/domains/d1/ssl-cert' });
    expect(res.statusCode).toBe(401);
  });

  it('GET ssl-cert should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/ssl-cert',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── GET ─────────────────────────────────────────────────────────────────

  it('GET ssl-cert should return cert for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/ssl-cert',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toBeDefined();
  });

  // ─── POST ────────────────────────────────────────────────────────────────

  it('POST ssl-cert should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains/d1/ssl-cert',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST ssl-cert should upload with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains/d1/ssl-cert',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  // ─── DELETE ──────────────────────────────────────────────────────────────

  it('DELETE ssl-cert should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/domains/d1/ssl-cert',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
