import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockServer = {
  id: 'dns-1',
  displayName: 'Primary DNS',
  providerType: 'powerdns',
  zoneDefaultKind: 'Native',
  isDefault: true,
  enabled: true,
  lastHealthCheck: null,
  lastHealthStatus: null,
  createdAt: new Date('2026-01-01').toISOString(),
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listDnsServers: vi.fn().mockResolvedValue([mockServer]),
  getDnsServerById: vi.fn().mockResolvedValue(mockServer),
  createDnsServer: vi.fn().mockResolvedValue({ ...mockServer, id: 'dns-new' }),
  updateDnsServer: vi.fn().mockResolvedValue({ ...mockServer, displayName: 'Updated' }),
  deleteDnsServer: vi.fn().mockResolvedValue(undefined),
  testDnsServerConnection: vi.fn().mockResolvedValue({ success: true, latencyMs: 42 }),
  getProviderForServer: vi.fn().mockReturnValue({
    listZones: vi.fn().mockResolvedValue([{ name: 'example.com', kind: 'Native' }]),
  }),
}));

const { dnsServerRoutes } = await import('./routes.js');

describe('dns-server routes', () => {
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
    await app.register(dnsServerRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  // Auth
  it('GET /admin/dns-servers should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/dns-servers' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/dns-servers should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dns-servers',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /admin/dns-servers should reject support role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dns-servers',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // List
  it('GET /admin/dns-servers should return list for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dns-servers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  // Create
  it('POST /admin/dns-servers should reject missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/dns-servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { display_name: 'Test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST /admin/dns-servers should create with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/dns-servers',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        display_name: 'New DNS',
        provider_type: 'powerdns',
        connection_config: { api_url: 'http://dns:8081', api_key: 'secret' },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  // Update
  it('PATCH /admin/dns-servers/:id should update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/dns-servers/dns-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { display_name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
  });

  // Delete
  it('DELETE /admin/dns-servers/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/admin/dns-servers/dns-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  // Test connection
  it('POST /admin/dns-servers/:id/test should return result', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/dns-servers/dns-1/test',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.success).toBe(true);
  });

  // List zones
  it('GET /admin/dns-servers/:id/zones should return zones', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dns-servers/dns-1/zones',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });
});
