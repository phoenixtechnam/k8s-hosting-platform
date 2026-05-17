// Phase 7 of the snapshot-storage overhaul: one-shot backfill of
// existing hostpath archives to the assigned `tenant_snapshot` target.
//
// Pre-Phase-3 snapshots were written to `/var/lib/platform/snapshots/
// <tenant>/<snap>.tar.gz` via the legacy LocalHostPathStore. With
// Phase 4 streaming live, new snapshots go straight to the assigned
// remote target. Legacy archives still on hostpath need a one-time
// migration so:
//   1. Restore continues to work after the hostpath store is fully
//      retired (Phase 5 still falls back to ctx.store for target_id
//      IS NULL rows; once the local file is gone, restore breaks).
//   2. Operators can reclaim node disk.
//
// Backfill flow (per snapshot row):
//   - find matching local archive at /var/lib/platform/snapshots/...
//   - resolve the tenant_snapshot class store via Phase 3 resolver
//   - upload the archive bytes through that store's S3 SDK (NOT the
//     streaming pipeline — we already have a local file, this is the
//     one place where the legacy "PUT a file" pattern is the right
//     tool)
//   - update storage_snapshots: stamp target_id, rewrite archive_path
//     to the new pathPrefix layout
//   - delete the local file
//
// Operator-driven: runs as a Job spawned by a script, NOT a cron.
// Per-tenant batch with explicit confirmation. Idempotent — re-running
// after partial completion picks up where the previous run left off.

import { sql, eq, and, isNull } from 'drizzle-orm';
import { storageSnapshots, tenants, backupTargetAssignments, backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export interface BackfillRow {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly archivePath: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

export interface BackfillInventory {
  readonly totalRows: number;
  readonly needsBackfill: BackfillRow[]; // target_id IS NULL AND status='ready'
  readonly alreadyMigrated: number; // target_id IS NOT NULL
  readonly failedRows: number; // status='failed' — skip
}

/**
 * Inventory pass: enumerate every `storage_snapshots` row + classify.
 * Read-only. Operator inspects the output before running the actual
 * backfill.
 */
export async function buildBackfillInventory(db: Database): Promise<BackfillInventory> {
  const rows = await db
    .select({
      id: storageSnapshots.id,
      tenantId: storageSnapshots.tenantId,
      archivePath: storageSnapshots.archivePath,
      sizeBytes: storageSnapshots.sizeBytes,
      sha256: storageSnapshots.sha256,
      status: storageSnapshots.status,
      targetId: storageSnapshots.targetId,
    })
    .from(storageSnapshots);

  let alreadyMigrated = 0;
  let failedRows = 0;
  const needsBackfill: BackfillRow[] = [];
  for (const row of rows) {
    if (row.status === 'failed') {
      failedRows += 1;
      continue;
    }
    if (row.targetId !== null) {
      alreadyMigrated += 1;
      continue;
    }
    if (row.status !== 'ready') continue;
    needsBackfill.push({
      snapshotId: row.id,
      tenantId: row.tenantId,
      archivePath: row.archivePath,
      sizeBytes: Number(row.sizeBytes),
      sha256: row.sha256,
    });
  }

  return {
    totalRows: rows.length,
    needsBackfill,
    alreadyMigrated,
    failedRows,
  };
}

/**
 * Sanity-check: does a valid tenant_snapshot assignment exist? If not,
 * backfill cannot proceed — operator must configure /settings/snapshot-classes
 * first.
 */
export async function checkBackfillPreconditions(db: Database): Promise<{ ok: boolean; reason?: string }> {
  const assigned = await db
    .select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(and(
      eq(backupTargetAssignments.snapshotClass, 'tenant_snapshot'),
      eq(backupConfigurations.enabled, 1),
    ))
    .limit(1);
  if (assigned.length === 0) {
    return {
      ok: false,
      reason: 'tenant_snapshot has no enabled target assignment. ' +
              'Configure one at /settings/snapshot-classes before backfilling.',
    };
  }
  return { ok: true };
}

/**
 * Stamp a single snapshot row with its now-uploaded target. Called
 * after the operator's backfill Job uploads the file to the resolved
 * S3 target and verifies the sha256. Inside a transaction so a crash
 * mid-update leaves the row coherent.
 */
export async function markRowBackfilled(
  db: Database,
  snapshotId: string,
  newArchivePath: string,
  newTargetId: string,
): Promise<void> {
  await db.update(storageSnapshots)
    .set({
      archivePath: newArchivePath,
      targetId: newTargetId,
      updatedAt: new Date(),
    })
    .where(eq(storageSnapshots.id, snapshotId));
}

/**
 * Cluster-wide view for the admin UI: how many rows need backfill,
 * total bytes to upload, per-tenant breakdown.
 */
export async function getBackfillSummary(db: Database): Promise<{
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly tenantsAffected: number;
}> {
  const rows = (await db
    .select({
      pendingCount: sql<number>`COUNT(*)::int`,
      pendingBytes: sql<string>`COALESCE(SUM(${storageSnapshots.sizeBytes}), 0)::text`,
      tenantsAffected: sql<number>`COUNT(DISTINCT ${storageSnapshots.tenantId})::int`,
    })
    .from(storageSnapshots)
    .where(and(
      isNull(storageSnapshots.targetId),
      eq(storageSnapshots.status, 'ready'),
      // Only tenant-PVC snapshots are subject to Phase 7 backfill —
      // mail/system rows take a different migration path.
      eq(storageSnapshots.subsystem, 'tenant-pvc'),
    ))) as Array<{ pendingCount: number; pendingBytes: string; tenantsAffected: number }>;

  const row = rows[0] ?? { pendingCount: 0, pendingBytes: '0', tenantsAffected: 0 };
  return {
    pendingCount: row.pendingCount,
    pendingBytes: Number(row.pendingBytes),
    tenantsAffected: row.tenantsAffected,
  };
}

// Re-export the schema imports so test fixtures can use them without
// duplicating drizzle imports.
export { tenants };
