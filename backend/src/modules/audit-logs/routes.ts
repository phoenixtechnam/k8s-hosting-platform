import type { FastifyInstance } from 'fastify';
import { desc, eq, and, like, gte, lte } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditLogs } from '../../db/schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/audit-logs — filterable audit log entries
  app.get('/admin/audit-logs', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const rawLimit = Number(query.limit) || DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

    const conditions = [];
    if (query.client_id) conditions.push(eq(auditLogs.clientId, query.client_id));
    if (query.action_type) conditions.push(eq(auditLogs.actionType, query.action_type));
    if (query.resource_type) conditions.push(eq(auditLogs.resourceType, query.resource_type));
    if (query.actor_id) conditions.push(eq(auditLogs.actorId, query.actor_id));
    if (query.http_method) conditions.push(eq(auditLogs.httpMethod, query.http_method));
    if (query.search) conditions.push(like(auditLogs.httpPath, `%${query.search}%`));
    if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await app.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    return { data: rows };
  });
}
