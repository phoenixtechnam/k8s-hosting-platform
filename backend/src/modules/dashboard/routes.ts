import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { clients, domains, backups } from '../../db/schema.js';
import { createCacheMiddleware } from '../../middleware/cache.js';

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('admin', 'super_admin', 'read_only'));

  // GET /api/v1/admin/dashboard — aggregated platform metrics
  app.get('/admin/dashboard', { preHandler: createCacheMiddleware(30_000) }, async () => {
    const [clientStats] = await app.db
      .select({
        total_clients: sql<number>`count(*)`,
        active_clients: sql<number>`sum(case when ${clients.status} = 'active' then 1 else 0 end)`,
      })
      .from(clients);

    const [domainStats] = await app.db
      .select({ total_domains: sql<number>`count(*)` })
      .from(domains);

    const [backupStats] = await app.db
      .select({ total_backups: sql<number>`count(*)` })
      .from(backups);

    return {
      data: {
        total_clients: Number(clientStats.total_clients),
        active_clients: Number(clientStats.active_clients ?? 0),
        total_domains: Number(domainStats.total_domains),
        total_backups: Number(backupStats.total_backups),
        platform_version: process.env.PLATFORM_VERSION ?? '0.1.0',
      },
    };
  });
}
