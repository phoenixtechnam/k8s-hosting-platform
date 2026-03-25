import type { FastifyInstance } from 'fastify';
import { hostingPlans } from '../../db/schema.js';

export async function planRoutes(app: FastifyInstance) {
  app.get('/plans', async () => {
    const rows = await app.db.select().from(hostingPlans);
    return { data: rows };
  });
}
