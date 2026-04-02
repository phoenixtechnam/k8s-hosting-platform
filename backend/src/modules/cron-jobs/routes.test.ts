import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockJob = {
  id: 'j1',
  clientId: 'c1',
  name: 'cleanup',
  type: 'webcron',
  schedule: '0 * * * *',
  command: null,
  url: 'https://example.com/cron',
  httpMethod: 'GET',
  deploymentId: null,
  enabled: 1,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunDurationMs: null,
  lastRunResponseCode: null,
  lastRunOutput: null,
};

vi.mock('./service.js', () => ({
  createCronJob: vi.fn().mockResolvedValue(mockJob),
  getCronJobById: vi.fn().mockResolvedValue(mockJob),
  listCronJobs: vi.fn().mockResolvedValue({
    data: [mockJob],
    pagination: { cursor: null, has_more: false, page_size: 1, total_count: 1 },
  }),
  updateCronJob: vi.fn().mockResolvedValue({ ...mockJob, name: 'updated' }),
  deleteCronJob: vi.fn().mockResolvedValue(undefined),
  runCronJobNow: vi.fn().mockResolvedValue({ ...mockJob, lastRunStatus: 'success' }),
}));

const { cronJobRoutes } = await import('./routes.js');

describe('cron-job routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);

    app.decorate('db', {});
    await app.register(cronJobRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should require auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients/c1/cron-jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('GET should list cron jobs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST should reject missing type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test', schedule: '0 * * * *', url: 'https://example.com/cron' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject invalid cron expression', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test', type: 'webcron', schedule: 'invalid', url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should create webcron job with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'test',
        type: 'webcron',
        schedule: '0 * * * *',
        url: 'https://example.com/cron',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST should create deployment cron job with valid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'deploy-cron',
        type: 'deployment',
        schedule: '0 * * * *',
        command: 'echo hi',
        deployment_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST should reject webcron without url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test', type: 'webcron', schedule: '0 * * * *' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST should reject deployment without command', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/clients/c1/cron-jobs',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'test',
        type: 'deployment',
        schedule: '0 * * * *',
        deployment_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /:cronJobId should return cron job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/clients/c1/cron-jobs/j1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH should reject invalid schedule', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/cron-jobs/j1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { schedule: 'bad-cron' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FIELD_VALUE');
  });

  it('PATCH should update with valid data', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/clients/c1/cron-jobs/j1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'updated-name' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('DELETE should return 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/clients/c1/cron-jobs/j1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });
});
