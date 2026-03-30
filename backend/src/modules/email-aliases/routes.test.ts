import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockAlias = {
  id: 'al-1',
  emailDomainId: 'ed-1',
  clientId: 'c1',
  sourceAddress: 'sales@example.com',
  destinationAddresses: ['user1@example.com', 'user2@example.com'],
  enabled: 1,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listAliases: vi.fn().mockResolvedValue([mockAlias]),
  createAlias: vi.fn().mockResolvedValue(mockAlias),
  updateAlias: vi.fn().mockResolvedValue({ ...mockAlias, enabled: 0 }),
  deleteAlias: vi.fn().mockResolvedValue(undefined),
}));

const { emailAliasRoutes } = await import('./routes.js');

describe('email-alias routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;
  let clientUserToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(emailAliasRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    clientUserToken = app.jwt.sign({ sub: 'cu-1', role: 'client_user', panel: 'client', clientId: 'c1', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/email/aliases' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/email/aliases',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should reject client_user role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/email/aliases',
      headers: { authorization: `Bearer ${clientUserToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET should list aliases for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/email/aliases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('POST should reject missing source_address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/aliases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { destination_addresses: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST should reject invalid email in source_address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/aliases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        source_address: 'not-an-email',
        destination_addresses: ['user@example.com'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/email/domains/ed-1/aliases',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        source_address: 'sales@example.com',
        destination_addresses: ['user1@example.com'],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH should reject invalid destination_addresses', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/email/aliases/al-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { destination_addresses: ['not-email'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/email/aliases/al-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/email/aliases/al-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
