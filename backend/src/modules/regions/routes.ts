import type { FastifyInstance } from 'fastify';
import { regions } from '../../db/schema.js';

export async function regionRoutes(app: FastifyInstance) {
  app.get('/regions', async () => {
    const rows = await app.db.select().from(regions);
    return { data: rows };
  });
}
