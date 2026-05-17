// Per-class snapshot target assignments (Phase 2 of snapshot-storage
// overhaul).
//
// The admin-facing surface: list / replace / probe the assignment of
// each snapshot class to backup targets. Phase 3 wires the per-class
// resolver against this same `backup_target_assignments` table.
//
// Writes are replace-set (PUT semantics) so the admin UI doesn't need
// to compute deltas — operator picks the full list of targets+priorities
// for a class, the service syncs the table to match in one transaction.

import { sql, eq, and, inArray } from 'drizzle-orm';
import { backupTargetAssignments, backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import {
  type SnapshotClass,
  type ClassView,
  type ListClassesResponse,
  type SetAssignmentsInput,
  type AssignmentRow,
  type TargetAssignmentsSummary,
  snapshotClassEnum,
} from '@k8s-hosting/api-contracts';

const ALL_CLASSES: readonly SnapshotClass[] = snapshotClassEnum.options;

interface JoinedRow {
  snapshotClass: string;
  targetId: string;
  targetName: string;
  targetStorageType: string;
  priority: number;
  createdAt: Date | string;
}

function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return value;
  }
  return new Date().toISOString();
}

function rowToAssignment(r: JoinedRow): AssignmentRow {
  return {
    snapshotClass: r.snapshotClass as SnapshotClass,
    targetId: r.targetId,
    targetName: r.targetName,
    targetStorageType: r.targetStorageType,
    priority: r.priority,
    createdAt: toIso(r.createdAt),
  };
}

/**
 * List every snapshot class with its current assignment set. Classes
 * with no assignment appear with `assignments: []` — the admin UI uses
 * that to render the red "no target — snapshots disabled" banner.
 */
export async function listClasses(db: Database): Promise<ListClassesResponse> {
  const rows = (await db
    .select({
      snapshotClass: backupTargetAssignments.snapshotClass,
      targetId: backupTargetAssignments.targetId,
      targetName: backupConfigurations.name,
      targetStorageType: backupConfigurations.storageType,
      priority: backupTargetAssignments.priority,
      createdAt: backupTargetAssignments.createdAt,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .orderBy(backupTargetAssignments.snapshotClass, backupTargetAssignments.priority)) as JoinedRow[];

  const byClass = new Map<SnapshotClass, AssignmentRow[]>();
  for (const cls of ALL_CLASSES) byClass.set(cls, []);
  for (const row of rows) {
    const cls = row.snapshotClass as SnapshotClass;
    const list = byClass.get(cls);
    if (!list) continue; // ignore rows for classes not in the locked enum
    list.push(rowToAssignment(row));
  }

  const classes: ClassView[] = ALL_CLASSES.map((cls) => ({
    snapshotClass: cls,
    assignments: byClass.get(cls) ?? [],
  }));

  return { classes };
}

/**
 * Replace the assignment set for one class. Validates that every
 * target_id exists, no duplicate target_ids, and at most one row per
 * priority (operator can pick non-strict priorities, but two targets
 * at the same priority would make failover ordering ambiguous).
 *
 * Transactional: deletes the old set, inserts the new set, returns
 * the refreshed view. If validation or insert fails, the transaction
 * rolls back and the class keeps its prior assignments.
 */
export async function setAssignments(
  db: Database,
  snapshotClass: SnapshotClass,
  input: SetAssignmentsInput,
): Promise<{ snapshotClass: SnapshotClass; assignments: AssignmentRow[] }> {
  // Reject duplicate target_ids in one PUT — the user picked the same
  // target twice, which is meaningless and would break the PK.
  const seenTargets = new Set<string>();
  for (const a of input.assignments) {
    if (seenTargets.has(a.targetId)) {
      throw new ApiError(
        'DUPLICATE_TARGET',
        `Target ${a.targetId} appears multiple times in the assignment list`,
        400,
      );
    }
    seenTargets.add(a.targetId);
  }

  // Reject duplicate priorities — ambiguous failover order.
  const seenPriorities = new Set<number>();
  for (const a of input.assignments) {
    if (seenPriorities.has(a.priority)) {
      throw new ApiError(
        'DUPLICATE_PRIORITY',
        `Two targets share priority ${a.priority} — pick distinct priorities`,
        400,
      );
    }
    seenPriorities.add(a.priority);
  }

  // Validate target existence + enabled status INSIDE the transaction
  // so a concurrent delete or disable can't slip past the check before
  // the insert fires. Without this guard the FK constraint catches the
  // race but the caller sees an opaque 500 instead of a 400. Also
  // refuses disabled targets (enabled=0) so the operator can't assign
  // a target that the Phase 3 resolver would later refuse to use.
  await db.transaction(async (tx) => {
    if (input.assignments.length > 0) {
      const targetIds = input.assignments.map((a) => a.targetId);
      const existing = await tx
        .select({ id: backupConfigurations.id, enabled: backupConfigurations.enabled })
        .from(backupConfigurations)
        .where(inArray(backupConfigurations.id, targetIds));
      const enabledIds = new Set(existing.filter((r) => r.enabled === 1).map((r) => r.id));
      const existingIds = new Set(existing.map((r) => r.id));
      for (const a of input.assignments) {
        if (!existingIds.has(a.targetId)) {
          throw new ApiError(
            'TARGET_NOT_FOUND',
            `backup_configurations row ${a.targetId} not found`,
            400,
          );
        }
        if (!enabledIds.has(a.targetId)) {
          throw new ApiError(
            'TARGET_DISABLED',
            `backup_configurations row ${a.targetId} is disabled — enable it before assigning to a class`,
            400,
          );
        }
      }
    }

    await tx
      .delete(backupTargetAssignments)
      .where(eq(backupTargetAssignments.snapshotClass, snapshotClass));

    if (input.assignments.length > 0) {
      await tx.insert(backupTargetAssignments).values(
        input.assignments.map((a) => ({
          snapshotClass,
          targetId: a.targetId,
          priority: a.priority,
        })),
      );
    }
  });

  // Read back the refreshed set (one query, joined for the response).
  const rows = (await db
    .select({
      snapshotClass: backupTargetAssignments.snapshotClass,
      targetId: backupTargetAssignments.targetId,
      targetName: backupConfigurations.name,
      targetStorageType: backupConfigurations.storageType,
      priority: backupTargetAssignments.priority,
      createdAt: backupTargetAssignments.createdAt,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(eq(backupTargetAssignments.snapshotClass, snapshotClass))
    .orderBy(backupTargetAssignments.priority)) as JoinedRow[];

  return {
    snapshotClass,
    assignments: rows.map(rowToAssignment),
  };
}

/**
 * Resolve the primary target for a snapshot class. Strict-primary:
 * picks the assignment with the lowest priority. Returns null when no
 * assignment exists — callers must surface a `NO_SNAPSHOT_TARGET`
 * error and refuse to proceed.
 *
 * Exposed here so the Phase 3 resolver can wrap it; the admin UI's
 * "test" endpoint uses it too.
 */
export async function resolvePrimaryTarget(
  db: Database,
  snapshotClass: SnapshotClass,
): Promise<{ targetId: string; targetName: string; targetStorageType: string; targetEnabled: number } | null> {
  // We include `enabled` in the projection so the caller (target-resolver)
  // can refuse to use a disabled target with a TARGET_DISABLED error —
  // strict-primary semantics (no silent failover to the next-priority
  // assignment). Without this projection the caller couldn't tell.
  const [row] = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      targetName: backupConfigurations.name,
      targetStorageType: backupConfigurations.storageType,
      targetEnabled: backupConfigurations.enabled,
    })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(eq(backupTargetAssignments.snapshotClass, snapshotClass))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);

  return row ?? null;
}

/**
 * Reverse view: list every class that routes to the given target
 * (with priority). Drives the "Used by classes" pill on the backup-
 * settings page.
 */
export async function getTargetAssignmentsSummary(
  db: Database,
  targetId: string,
): Promise<TargetAssignmentsSummary> {
  const rows = await db
    .select({
      snapshotClass: backupTargetAssignments.snapshotClass,
      priority: backupTargetAssignments.priority,
    })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.targetId, targetId))
    .orderBy(backupTargetAssignments.snapshotClass);

  return {
    targetId,
    classes: rows
      .filter((r): r is { snapshotClass: SnapshotClass; priority: number } =>
        ALL_CLASSES.includes(r.snapshotClass as SnapshotClass))
      .map((r) => ({
        snapshotClass: r.snapshotClass as SnapshotClass,
        priority: r.priority,
      })),
  };
}

/**
 * Bulk summary for all targets — admin UI fetches this once and
 * renders the per-row pill on the backup-settings page. Single
 * GROUP BY query so the table render is one roundtrip even with 50
 * targets.
 */
export async function getAllTargetAssignmentsSummaries(
  db: Database,
): Promise<TargetAssignmentsSummary[]> {
  const rows = await db
    .select({
      targetId: backupTargetAssignments.targetId,
      snapshotClass: backupTargetAssignments.snapshotClass,
      priority: backupTargetAssignments.priority,
    })
    .from(backupTargetAssignments)
    .orderBy(backupTargetAssignments.targetId, backupTargetAssignments.priority);

  const byTarget = new Map<string, TargetAssignmentsSummary>();
  for (const row of rows) {
    if (!ALL_CLASSES.includes(row.snapshotClass as SnapshotClass)) continue;
    const summary = byTarget.get(row.targetId) ?? { targetId: row.targetId, classes: [] };
    summary.classes.push({
      snapshotClass: row.snapshotClass as SnapshotClass,
      priority: row.priority,
    });
    byTarget.set(row.targetId, summary);
  }
  return Array.from(byTarget.values());
}

// Re-export the where helpers so the routes module can use them
// without importing drizzle-orm directly.
export { sql, eq, and };
