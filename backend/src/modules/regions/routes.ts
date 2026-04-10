import type { FastifyInstance } from 'fastify';
import { regions } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';
import { success } from '../../shared/response.js';

export async function regionRoutes(app: FastifyInstance) {
  app.get('/regions', { preHandler: createCacheMiddleware(300_000) }, async () => {
    const rows = await app.db.select().from(regions);
    return success(rows);
  });
}
