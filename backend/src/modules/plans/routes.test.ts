import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { planRoutes } from './routes.js';

const mockPlans = [
  { id: 'p1', name: 'Starter', cpu: '0.5', memory: '512Mi', storage: '5Gi', price_monthly: 9.99 },
  { id: 'p2', name: 'Pro', cpu: '2', memory: '4Gi', storage: '50Gi', price_monthly: 29.99 },
];

describe('plan routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();

    const fromFn = () => Promise.resolve(mockPlans);
    const selectFn = () => ({ from: fromFn });

    app.decorate('db', { select: selectFn });
    app.register(planRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/plans should return plan list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/plans',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toEqual(mockPlans);
  });
});
