import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { auditLogs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

// Every action is mirrored into the platform-wide audit_logs table.
// Resource type is fixed so the admin AuditLogs page can filter on it.
const RESOURCE_TYPE = 'node_terminal';

export type NodeTerminalAuditAction =
  | 'node_terminal.session.create.attempt'
  | 'node_terminal.session.create.success'
  | 'node_terminal.session.create.failed'
  | 'node_terminal.session.ws.attached'
  | 'node_terminal.session.ws.rejected'
  | 'node_terminal.session.closed';

export interface NodeTerminalAuditInput {
  readonly actorId: string;
  readonly nodeName: string;
  readonly sessionId?: string;
  readonly action: NodeTerminalAuditAction;
  readonly httpStatus?: number;
  readonly request: FastifyRequest;
  readonly changes?: Record<string, unknown>;
}

/**
 * Best-effort audit. Failure to write must NEVER fail the operation —
 * we surface the error in the platform log and continue. The single
 * load-bearing audit row is the create.attempt — it's written BEFORE
 * the privileged Pod is provisioned so an orphan Pod can always be
 * traced back to a user even if create.success was lost.
 */
export async function recordNodeTerminalAudit(
  db: Database,
  input: NodeTerminalAuditInput,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: null,
      actionType: input.action,
      resourceType: RESOURCE_TYPE,
      // resource_id is varchar(36). sessionId is always a UUID (36).
      // For attempts that fail before the session exists, leave null
      // and surface the node name via `changes` instead.
      resourceId: input.sessionId ?? null,
      actorId: input.actorId,
      actorType: 'user',
      httpMethod: input.request.method,
      httpPath: input.request.url.slice(0, 500),
      // 403 for failure/rejection paths; 200 for success rows.
      // (Previously had a typo of 4_403 — would never show up on a
      // dashboard filtering on "http_status = 403".)
      httpStatus: input.httpStatus ?? (input.action.endsWith('failed') || input.action.endsWith('rejected') ? 403 : 200),
      changes: {
        nodeName: input.nodeName,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...input.changes,
      },
      ipAddress: input.request.ip,
    });
  } catch (err) {
    input.request.log.warn({ err, action: input.action }, 'node-terminal audit write failed');
  }
}
