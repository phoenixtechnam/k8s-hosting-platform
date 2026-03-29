import type { FastifyInstance } from 'fastify';
import { containerImages } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';

export async function containerImageRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/container-images — public catalog, no auth required
  app.get('/container-images', { preHandler: createCacheMiddleware(300_000) }, async () => {
    const rows = await app.db.select().from(containerImages);
    return { data: rows };
  });
}
