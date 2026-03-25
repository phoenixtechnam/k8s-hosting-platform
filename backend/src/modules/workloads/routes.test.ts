import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockWorkload = {
  id: 'w1',
  clientId: 'c1',
  name: 'my-app',
  containerImageId: 'img-1',
  replicaCount: 1,
  cpuRequest: '0.25',
  memoryRequest: '256Mi',
  status: 'pending',
};

vi.mock('./service.js', () => ({
  createWorkload: vi.fn().mockResolvedValue(mockWorkload),
  getWorkloadById: vi.fn().mockResolvedValue(mockWorkload),
  listWorkloads: vi.fn().mockResolvedValue({
    data: [mockWorkload],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateWorkload: vi.fn().mockResolvedValue({ ...mockWorkload, replicaCount: 3 }),
  deleteWorkload: vi.fn().mockResolvedValue(undefined),
}));

const { workloadRoutes } = await import('./routes.js');

describe('workload routes', () => {
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
    await app.register(workloadRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
    supportToken = app.jwt.sign({ sub: 'support-1', role: 'support', iat: Math.floor(Date.now() / 1000) });
    readOnlyToken = app.jwt.sign({ sub: 'reader-1', role: 'read-only', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth for GET list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/workloads' });
    expect(res.statusCode).toBe(401);
  });

  it('should reject read-only role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('should allow admin to list workloads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
  });

  it('should allow support to list workloads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /:workloadId should return workload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/workloads/w1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe('w1');
  });

  it('POST should create workload with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'my-app', image_id: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toBeDefined();
  });

  it('POST should reject missing name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { image_id: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject missing image_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'my-app' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject invalid image_id format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'my-app', image_id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject replica_count out of range', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/workloads',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'my-app', image_id: '550e8400-e29b-41d4-a716-446655440000', replica_count: 11 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/workloads/w1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { replica_count: 3 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH should reject invalid status value', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/workloads/w1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/workloads/w1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
