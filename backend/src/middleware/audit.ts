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
  const segments = path.replace(/^\/api\/v1\//, '').split('/').filter(Boolean);

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
    const user = (request as any).user;

    // Fire-and-forget — don't block the response
    db.insert(auditLogs)
      .values({
        id: crypto.randomUUID(),
        clientId: clientId ?? null,
        actionType: methodToAction(request.method),
        resourceType,
        resourceId: resourceId ?? null,
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
