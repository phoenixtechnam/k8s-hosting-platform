// Phase 6 of the snapshot-storage overhaul: per-tenant snapshot quota
// enforcement.
//
// Called by the snapshot orchestrator BEFORE quiescing or launching the
// Job, so a tenant over-quota gets a clean 409 STORAGE_QUOTA_EXCEEDED
// instead of partial progress. Cheap (one indexed query against
// storage_snapshots).
//
// Quota dimensions:
//   - bytes: sum of `size_bytes` across all status='ready' rows for
//     the tenant. status='creating' is excluded so a single in-flight
//     snapshot doesn't double-count. status='failed' is excluded since
//     those rows have size_bytes=0 anyway.
//   - count: distinct rows in status='ready' OR 'creating'. Counting
//     'creating' here prevents an operator hammering the snapshot
//     button from running over count cap.
//
// System-initiated snapshots (pre-resize, pre-archive) bypass the
// tenant quota because they're not operator-discretionary and refusing
// them would block the resize/archive flow mid-execution. They count
// toward the platform-wide system_snapshot quota instead (deferred to
// a follow-up — Phase 6 ships per-tenant only).

import { sql, eq, and, inArray } from 'drizzle-orm';
import { hostingPlans, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';

export interface SnapshotQuotaUsage {
  readonly tenantId: string;
  readonly currentBytes: number;
  readonly currentCount: number;
  readonly maxBytes: number;
  readonly maxCount: number;
  readonly bytesUtilization: number; // 0-1
  readonly countUtilization: number; // 0-1
}

/**
 * Compute current usage + caps for a tenant. Returns null if the
 * tenant doesn't exist (caller should surface CLIENT_NOT_FOUND first).
 */
export async function getSnapshotQuotaUsage(
  db: Database,
  tenantId: string,
): Promise<SnapshotQuotaUsage | null> {
  const rows = await db
    .select({
      planId: tenants.planId,
      maxBytes: hostingPlans.maxSnapshotSizeBytes,
      maxCount: hostingPlans.maxSnapshotCount,
    })
    .from(tenants)
    .innerJoin(hostingPlans, eq(hostingPlans.id, tenants.planId))
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (rows.length === 0) return null;
  const { maxBytes, maxCount } = rows[0];

  // Aggregate sum + count in one query so we avoid race windows
  // between separate selects. The CASE WHEN handles the bytes-only
  // exclusion for non-ready rows.
  const usageRows = (await db
    .select({
      currentBytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
      currentCount: sql<number>`COUNT(*) FILTER (WHERE ${storageSnapshots.status} IN ('ready', 'creating'))::int`,
    })
    .from(storageSnapshots)
    .where(and(
      eq(storageSnapshots.tenantId, tenantId),
      // Only tenant_snapshot class counts against the tenant's quota.
      // tenant_bundle has its own backup-bundle quota; system_* classes
      // count against the platform quota (Phase 6.5).
      eq(storageSnapshots.snapshotClass, 'tenant_snapshot'),
    ))) as Array<{ currentBytes: string; currentCount: number }>;

  const usage = usageRows[0] ?? { currentBytes: '0', currentCount: 0 };
  const currentBytes = Number(usage.currentBytes);
  const currentCount = usage.currentCount;

  return {
    tenantId,
    currentBytes,
    currentCount,
    maxBytes,
    maxCount,
    bytesUtilization: maxBytes > 0 ? Math.min(currentBytes / maxBytes, 999) : 0,
    countUtilization: maxCount > 0 ? Math.min(currentCount / maxCount, 999) : 0,
  };
}

/**
 * Pre-flight check before triggering a snapshot. Throws
 * STORAGE_QUOTA_EXCEEDED if the tenant is at-or-over either cap.
 *
 * `skip` lets system-initiated snapshots (pre-resize, pre-archive)
 * bypass the cap — refusing them would break the resize/archive flow
 * mid-execution.
 */
export async function enforceSnapshotQuota(
  db: Database,
  tenantId: string,
  opts: { skip?: boolean } = {},
): Promise<SnapshotQuotaUsage | null> {
  if (opts.skip) return null;
  const usage = await getSnapshotQuotaUsage(db, tenantId);
  if (!usage) return null;
  if (usage.currentCount >= usage.maxCount) {
    throw new ApiError(
      'STORAGE_QUOTA_EXCEEDED',
      `Tenant has ${usage.currentCount} snapshots, plan cap is ${usage.maxCount}. ` +
      `Delete an existing snapshot before creating another.`,
      409,
      { kind: 'count', currentCount: usage.currentCount, maxCount: usage.maxCount },
    );
  }
  if (usage.currentBytes >= usage.maxBytes) {
    throw new ApiError(
      'STORAGE_QUOTA_EXCEEDED',
      `Tenant snapshots consume ${(usage.currentBytes / (1024 ** 3)).toFixed(1)} GiB, ` +
      `plan cap is ${(usage.maxBytes / (1024 ** 3)).toFixed(1)} GiB. ` +
      `Delete older snapshots or upgrade the plan.`,
      409,
      { kind: 'bytes', currentBytes: usage.currentBytes, maxBytes: usage.maxBytes },
    );
  }
  return usage;
}

/**
 * Cluster-wide system snapshot byte total — sum across all
 * `system_*` classes. Used by the admin UI tile + the system-initiated
 * snapshot path's optional quota check (Phase 6.5).
 */
export async function getSystemSnapshotUsage(db: Database): Promise<{
  readonly currentBytes: number;
  readonly currentCount: number;
}> {
  const rows = (await db
    .select({
      currentBytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
      currentCount: sql<number>`COUNT(*) FILTER (WHERE ${storageSnapshots.status} IN ('ready', 'creating'))::int`,
    })
    .from(storageSnapshots)
    .where(inArray(storageSnapshots.snapshotClass, [
      'system_snapshot',
      'system_etcd',
      'system_secrets',
    ]))) as Array<{ currentBytes: string; currentCount: number }>;
  const row = rows[0] ?? { currentBytes: '0', currentCount: 0 };
  return {
    currentBytes: Number(row.currentBytes),
    currentCount: row.currentCount,
  };
}
