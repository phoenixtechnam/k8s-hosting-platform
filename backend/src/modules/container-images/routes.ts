import type { FastifyInstance } from 'fastify';
import { containerImages } from '../../db/schema.js';

export async function containerImageRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/container-images — public catalog, no auth required
  app.get('/container-images', async () => {
    const rows = await app.db.select().from(containerImages);
    return { data: rows };
  });
}
