import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { regionRoutes } from './routes.js';

const mockRegions = [
  { id: 'r1', name: 'eu-central', location: 'Falkenstein, Germany' },
  { id: 'r2', name: 'eu-west', location: 'Helsinki, Finland' },
];

describe('region routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();

    const fromFn = () => Promise.resolve(mockRegions);
    const selectFn = () => ({ from: fromFn });

    app.decorate('db', { select: selectFn });
    app.register(regionRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/regions should return region list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/regions',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toEqual(mockRegions);
  });
});
