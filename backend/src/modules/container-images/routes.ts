import type { FastifyInstance } from 'fastify';
import { containerImages } from '../../db/schema.js';

export async function containerImageRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/container-images — public catalog, no auth required
  app.get('/container-images', async (request) => {
    try {
      const rows = await app.db.select().from(containerImages);
      return { data: rows };
    } catch (err) {
      // If query fails (e.g. migration 0002 columns missing), fall back to core columns only
      request.log.warn({ err }, 'Full container_images query failed, trying core columns');
      const rows = await app.db.select({
        id: containerImages.id,
        code: containerImages.code,
        name: containerImages.name,
        imageType: containerImages.imageType,
        registryUrl: containerImages.registryUrl,
        digest: containerImages.digest,
        supportedVersions: containerImages.supportedVersions,
        status: containerImages.status,
        createdAt: containerImages.createdAt,
      }).from(containerImages);
      return { data: rows };
    }
  });
}
