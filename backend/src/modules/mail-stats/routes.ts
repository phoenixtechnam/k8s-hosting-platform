import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { getMailStats, reconcileMailboxUsage } from './service.js';

export async function mailStatsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/admin/mail/stats
  //
  // Phase 3.D.1 — lightweight mail metrics for the admin panel.
  // Proxies Stalwart's /metrics endpoint + adds a platform-DB
  // mailbox summary. Non-blocking on Stalwart unreachability.
  app.get('/admin/mail/stats', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support')],
    schema: {
      tags: ['Mail Stats'],
      summary: 'Current mail server statistics (counters + mailbox summary)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const stats = await getMailStats(app.db);
    return success(stats);
  });

  // POST /api/v1/admin/mail/stats/reconcile-usage
  //
  // Phase 3.D.2 — manual trigger for the mailbox usage reconciler.
  // Also called periodically by a backend cron.
  app.post('/admin/mail/stats/reconcile-usage', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Mail Stats'],
      summary: 'Trigger a one-off mailbox used_mb reconciliation from Stalwart',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const result = await reconcileMailboxUsage(app.db, app.log);
    return success(result);
  });
}
