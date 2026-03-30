import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockRecord = {
  id: 'rec-1',
  domainId: 'd1',
  recordType: 'A',
  recordName: 'www',
  recordValue: '1.2.3.4',
  ttl: 3600,
  priority: null,
  weight: null,
  port: null,
  updatedAt: new Date('2026-01-01').toISOString(),
};

vi.mock('./service.js', () => ({
  listDnsRecords: vi.fn().mockResolvedValue([mockRecord]),
  createDnsRecord: vi.fn().mockResolvedValue({ ...mockRecord, id: 'rec-new' }),
  updateDnsRecord: vi.fn().mockResolvedValue({ ...mockRecord, recordValue: '5.6.7.8' }),
  deleteDnsRecord: vi.fn().mockResolvedValue(undefined),
}));

// Mock the db query used by assertNotSecondaryDns inside routes.ts
vi.mock('../../db/schema.js', () => ({
  domains: {
    id: 'id',
    clientId: 'clientId',
    dnsMode: 'dnsMode',
  },
}));

const { dnsRecordRoutes } = await import('./routes.js');

describe('dns-record routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Stub db with mock select chain for assertNotSecondaryDns
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'd1', clientId: 'c1', dnsMode: 'cname' }]),
        }),
      }),
    };
    app.decorate('db', mockDb);
    await app.register(dnsRecordRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/domains/d1/dns-records' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read_only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/dns-records',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET should list records for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/domains/d1/dns-records',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('POST should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains/d1/dns-records',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { record_type: 'INVALID' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_REQUIRED_FIELD');
  });

  it('POST should create record with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/domains/d1/dns-records',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        record_type: 'A',
        record_name: 'www',
        record_value: '1.2.3.4',
        ttl: 3600,
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH should reject invalid ttl', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1/dns-records/rec-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { ttl: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/domains/d1/dns-records/rec-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { record_value: '5.6.7.8' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/domains/d1/dns-records/rec-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
