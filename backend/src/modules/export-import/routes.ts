import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { exportAll, importData } from './service.js';

export async function exportImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin'));

  // GET /api/v1/admin/export — export all data as JSON
  app.get('/admin/export', async () => {
    const data = await exportAll(app.db);
    return success(data);
  });

  // POST /api/v1/admin/import — import JSON data
  app.post('/admin/import', async (request) => {
    const query = request.query as Record<string, unknown>;
    const dryRun = query.dry_run === 'true';
    const body = request.body as Record<string, unknown>;
    const result = await importData(app.db, body, { dryRun });
    return success(result);
  });
}
