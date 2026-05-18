/**
 * SYSTEM tenant guards (ADR-040).
 *
 * `assertNotSystem` is the single helper used at every service-layer
 * callsite that may mutate / destroy the SYSTEM tenant. It accepts
 * a minimal row shape so callers can pass either a full tenant row
 * (from `getTenantById`) or just the columns they already selected.
 *
 * The lifecycle hook registry has a separate `system-tenant-guard`
 * hook that runs first on suspended/archived/deleted transitions —
 * the service-layer guards here are belt-and-braces so a future code
 * path that forgets to dispatch through the registry still fails
 * safely.
 *
 * All guards throw `ApiError(SYSTEM_TENANT_PROTECTED, 409)` so the
 * frontend can render a consistent operator-friendly message.
 */

import { ApiError } from '../../shared/errors.js';

export interface MinimalTenantRow {
  id: string;
  isSystem: boolean | null;
}

/** Action labels passed to assertNotSystem — used in the error
 *  message so the operator sees `Cannot suspend SYSTEM tenant`
 *  rather than a generic `protected`. */
export type SystemTenantAction =
  | 'suspend'
  | 'archive'
  | 'delete'
  | 'set subscription expiry on'
  | 'change status of';

/**
 * Throws `SYSTEM_TENANT_PROTECTED` (HTTP 409) if `row.isSystem` is
 * true. No-op for normal tenants.
 *
 * Use at the top of every service-layer function that:
 *   - changes tenants.status to suspended / archived
 *   - calls deleteTenant / applyDeleted
 *   - sets subscription_expires_at (the expiry cron would auto-suspend)
 */
export function assertNotSystem(
  row: MinimalTenantRow | null | undefined,
  action: SystemTenantAction,
): void {
  if (!row || !row.isSystem) return;
  throw new ApiError(
    'SYSTEM_TENANT_PROTECTED',
    `Cannot ${action} SYSTEM tenant — the platform-owned tenant is protected against destructive transitions (ADR-040).`,
    409,
    {
      tenantId: row.id,
      action,
      operatorError: {
        code: 'SYSTEM_TENANT_PROTECTED',
        title: 'SYSTEM tenant is protected',
        detail: `The SYSTEM tenant owns the platform apex domain and the platform's reserved mailbox space. It cannot be suspended, archived, or deleted.`,
        remediation: [
          'No action needed — this tenant is by design indelible.',
          'To stop using a transactional mailbox under SYSTEM, delete the mailbox or alias from Email Management.',
        ],
        retryable: false,
      },
    },
  );
}

/**
 * Partition a list of tenant rows into (allowed, blocked) for bulk
 * operations. The blocked entries surface as per-row failures with
 * the standard SYSTEM_TENANT_PROTECTED reason.
 */
export interface PartitionedTenants<T extends MinimalTenantRow> {
  allowed: T[];
  blocked: Array<{ id: string; reason: string }>;
}

export function filterOutSystem<T extends MinimalTenantRow>(
  rows: T[],
  action: SystemTenantAction,
): PartitionedTenants<T> {
  const allowed: T[] = [];
  const blocked: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    if (row.isSystem) {
      blocked.push({
        id: row.id,
        reason: `Cannot ${action} SYSTEM tenant (platform-protected, ADR-040)`,
      });
    } else {
      allowed.push(row);
    }
  }
  return { allowed, blocked };
}
