/**
 * Pulls the most recent N audit-log rows whose resource_type or
 * action_type matches a security-relevant category. Used by the
 * "Recent Security Events" tab on the admin page.
 *
 * "Security-relevant" is intentionally narrow for Phase 1:
 *   - cluster_trusted_range
 *   - cluster_pending_peer
 *   - node_exposure
 *   - reserved_platform_hostname (Phase 2.5)
 *   - admin_session
 *
 * Anything else (tenant CRUD, mailbox changes, etc.) would drown
 * the actual security signal and is excluded.
 */

import { inArray, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { auditLogs } from '../../db/schema.js';
import { type SecurityEvent } from '@k8s-hosting/api-contracts';

const SECURITY_RESOURCE_TYPES = [
  'cluster_trusted_range',
  'cluster_pending_peer',
  'node_exposure',
  'reserved_platform_hostname',
  'admin_session',
] as const;

export async function fetchRecentSecurityEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  limit = 50,
): Promise<SecurityEvent[]> {
  const rows = await db
    .select({
      createdAt: auditLogs.createdAt,
      resourceType: auditLogs.resourceType,
      actionType: auditLogs.actionType,
      resourceId: auditLogs.resourceId,
      actorId: auditLogs.actorId,
      httpStatus: auditLogs.httpStatus,
    })
    .from(auditLogs)
    .where(inArray(auditLogs.resourceType, [...SECURITY_RESOURCE_TYPES]))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    occurredAt: toIso(r.createdAt),
    resourceType: r.resourceType,
    action: r.actionType,
    resourceName: r.resourceId,
    userId: r.actorId,
    outcome: classifyOutcome(r.httpStatus),
  }));
}

function classifyOutcome(status: number | null): 'success' | 'failure' | 'unknown' {
  if (status === null) return 'unknown';
  if (status >= 200 && status < 400) return 'success';
  if (status >= 400) return 'failure';
  return 'unknown';
}

function toIso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  // node-pg returns timestamp columns as strings under some configs.
  return new Date(d).toISOString();
}
