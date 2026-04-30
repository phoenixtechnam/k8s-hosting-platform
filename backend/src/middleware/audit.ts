import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { auditLogs } from '../db/schema.js';
import type { Database } from '../db/index.js';

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SKIP_PATHS = ['/api/v1/admin/status'];

export function shouldAudit(method: string, path: string): boolean {
  if (SKIP_METHODS.has(method)) return false;
  if (SKIP_PATHS.some((p) => path.startsWith(p))) return false;
  return true;
}

export function extractResourceInfo(path: string): {
  resourceType: string;
  resourceId?: string;
  clientId?: string;
} {
  // /api/v1/clients/:clientId/:subResource/:subId
  // Strip the query string before splitting — without this the third
  // segment becomes e.g. "upload-raw?path=%2Fbench.bin" which then
  // overflows the audit_logs.resource_id varchar(36) column and aborts
  // the audit insert (and, when audits run in onResponse, can mask the
  // outer 200 with a 500 if the surrounding handler awaits the insert).
  const cleanPath = path.split('?')[0];
  const segments = cleanPath.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);

  if (segments.length === 0) return { resourceType: 'unknown' };

  // /clients
  if (segments.length === 1) {
    return { resourceType: segments[0].replace(/s$/, '') };
  }

  // /clients/:id
  if (segments.length === 2) {
    return { resourceType: segments[0].replace(/s$/, ''), resourceId: segments[1] };
  }

  // /clients/:clientId/:subResource
  if (segments.length === 3) {
    return {
      resourceType: segments[2].replace(/s$/, ''),
      clientId: segments[1],
    };
  }

  // /clients/:clientId/:subResource/:subId
  if (segments.length >= 4) {
    return {
      resourceType: segments[2].replace(/s$/, ''),
      resourceId: segments[3],
      clientId: segments[1],
    };
  }

  return { resourceType: 'unknown' };
}

function methodToAction(method: string): string {
  switch (method) {
    case 'POST': return 'create';
    case 'PATCH': case 'PUT': return 'update';
    case 'DELETE': return 'delete';
    default: return method.toLowerCase();
  }
}

export function registerAuditHook(app: FastifyInstance, db: Database): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!shouldAudit(request.method, request.url)) return;

    const { resourceType, resourceId, clientId } = extractResourceInfo(request.url);
    const user = (request as unknown as { user?: { sub: string; role: string } }).user;

    // Fire-and-forget — don't block the response
    // Defensive truncation: resource_id column is varchar(36). A path
    // segment that legitimately exceeds 36 chars (e.g. encoded slug)
    // shouldn't crash the audit insert.
    const safeResourceId = resourceId ? resourceId.slice(0, 36) : null;
    db.insert(auditLogs)
      .values({
        id: crypto.randomUUID(),
        clientId: clientId ?? null,
        actionType: methodToAction(request.method),
        resourceType: resourceType.slice(0, 50),
        resourceId: safeResourceId,
        actorId: user?.sub ?? 'anonymous',
        actorType: 'user',
        httpMethod: request.method,
        httpPath: request.url,
        httpStatus: reply.statusCode,
        ipAddress: request.ip,
      })
      .catch((err) => {
        request.log.error({ err }, 'Failed to write audit log');
      });
  });
}
