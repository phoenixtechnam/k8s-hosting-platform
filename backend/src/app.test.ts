import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';

describe('health check endpoint', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });

    app.get('/api/v1/admin/status', async () => ({
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
      },
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return healthy status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.data.status).toBe('healthy');
    expect(body.data.version).toBe('0.1.0');
    expect(body.data.timestamp).toBeDefined();
  });
});
