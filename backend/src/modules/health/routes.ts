import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { runAllChecks } from './service.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/health — run all health checks
  app.get('/admin/health', {
    onRequest: [requireRole('super_admin', 'admin', 'read_only')],
  }, async () => {
    const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
    const result = await runAllChecks(app.db, encryptionKey);
    return success(result);
  });
}
