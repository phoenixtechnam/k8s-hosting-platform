import type { FastifyInstance } from 'fastify';
import { desc, eq, and, like, gte, lte, lt, sql } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditLogs } from '../../db/schema.js';
import { parsePaginationParams, encodeCursor, decodeCursor } from '../../shared/pagination.js';
import { paginated } from '../../shared/response.js';

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/audit-logs — filterable audit log entries
  app.get('/admin/audit-logs', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const { limit, cursor } = parsePaginationParams(query);

    const conditions = [];
    if (query.client_id) conditions.push(eq(auditLogs.clientId, query.client_id));
    if (query.action_type) conditions.push(eq(auditLogs.actionType, query.action_type));
    if (query.resource_type) conditions.push(eq(auditLogs.resourceType, query.resource_type));
    if (query.actor_id) conditions.push(eq(auditLogs.actorId, query.actor_id));
    if (query.http_method) conditions.push(eq(auditLogs.httpMethod, query.http_method));
    if (query.search) conditions.push(like(auditLogs.httpPath, `%${query.search}%`));
    if (query.from) conditions.push(gte(auditLogs.createdAt, new Date(query.from)));
    if (query.to) conditions.push(lte(auditLogs.createdAt, new Date(query.to)));

    if (cursor) {
      const decoded = decodeCursor(cursor);
      conditions.push(lt(auditLogs.createdAt, new Date(decoded.sort)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await app.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const last = data[data.length - 1];
      nextCursor = encodeCursor({
        resource: 'audit_log',
        sort: last.createdAt.toISOString(),
        id: last.id,
      });
    }

    const [countResult] = await app.db
      .select({ count: sql<number>`count(*)` })
      .from(auditLogs)
      .where(where);

    return paginated(data, {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    });
  });
}
