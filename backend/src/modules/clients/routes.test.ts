import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockClient = {
  id: 'c1',
  companyName: 'Acme Corp',
  companyEmail: 'admin@acme.com',
  status: 'active',
  createdAt: new Date('2026-01-01').toISOString(),
};

// Mock the service module before importing routes
vi.mock('./service.js', () => ({
  createClient: vi.fn().mockResolvedValue({ ...mockClient, id: 'new-id' }),
  getClientById: vi.fn().mockResolvedValue(mockClient),
  listClients: vi.fn().mockResolvedValue({
    data: [mockClient],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateClient: vi.fn().mockResolvedValue({ ...mockClient, companyName: 'Updated' }),
  deleteClient: vi.fn().mockResolvedValue(undefined),
}));

// Import routes AFTER mocking
const { clientRoutes } = await import('./routes.js');

describe('client routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let readOnlyToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    // Decorate with a stub db (service is mocked, so db won't be used)
    app.decorate('db', {});
    await app.register(clientRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read_only', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/clients should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/clients should require admin role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/v1/clients should return paginated results for admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.pagination).toBeDefined();
  });

  it('GET /api/v1/clients/:id should return client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/v1/clients should reject invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { company_name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(['MISSING_REQUIRED_FIELD', 'VALIDATION_ERROR']).toContain(res.json().error.code);
  });

  it('POST /api/v1/clients should create client with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        company_name: 'New Corp',
        company_email: 'admin@newcorp.com',
        plan_id: '550e8400-e29b-41d4-a716-446655440000',
        region_id: '550e8400-e29b-41d4-a716-446655440001',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH /api/v1/clients/:id should reject invalid field values', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid-status' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH /api/v1/clients/:id should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { company_name: 'Updated Corp' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE /api/v1/clients/:id should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
