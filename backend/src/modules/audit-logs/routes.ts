import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditLogs } from '../../db/schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/audit-logs — latest audit log entries
  app.get<{
    Querystring: { limit?: string };
  }>('/admin/audit-logs', async (request) => {
    const rawLimit = Number(request.query.limit) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

    const rows = await app.db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    return { data: rows };
  });
}
