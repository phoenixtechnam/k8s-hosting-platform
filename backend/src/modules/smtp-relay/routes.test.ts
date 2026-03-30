import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockRelay = {
  id: 'sr-1',
  name: 'Mailgun EU',
  providerType: 'mailgun',
  isDefault: 1,
  enabled: 1,
  smtpHost: 'smtp.mailgun.org',
  smtpPort: 587,
  authUsername: 'postmaster@example.com',
  region: 'eu',
  lastTestedAt: null,
  lastTestStatus: null,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listRelayConfigs: vi.fn().mockResolvedValue([mockRelay]),
  createRelayConfig: vi.fn().mockResolvedValue(mockRelay),
  updateRelayConfig: vi.fn().mockResolvedValue({ ...mockRelay, name: 'Updated' }),
  deleteRelayConfig: vi.fn().mockResolvedValue(undefined),
  testRelayConnection: vi.fn().mockResolvedValue({ success: true, message: 'Connection OK' }),
}));

const { smtpRelayRoutes } = await import('./routes.js');

describe('smtp-relay routes', () => {
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
    await app.register(smtpRelayRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // Auth
  it('GET /admin/email/smtp-relays should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/email/smtp-relays' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/email/smtp-relays should reject read_only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /admin/email/smtp-relays should reject support', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // List
  it('GET /admin/email/smtp-relays should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  // Create
  it('POST should reject missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST should create mailgun relay with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider_type: 'mailgun',
        name: 'Mailgun EU',
        auth_username: 'postmaster@example.com',
        auth_password: 'secret-key',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST should create direct relay with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/email/smtp-relays',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        provider_type: 'direct',
        name: 'Direct Delivery',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // Update
  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/email/smtp-relays/sr-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Renamed Relay' },
    });
    expect(res.statusCode).toBe(200);
  });

  // Delete
  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/email/smtp-relays/sr-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // Test connection
  it('POST /test should return result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/email/smtp-relays/sr-1/test',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
  });
});
