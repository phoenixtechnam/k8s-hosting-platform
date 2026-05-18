/**
 * Backup-schedule CRUD with the strict-gate.
 *
 * Each subsystem (mail, tenant_bundle, system_pitr, longhorn_recurring)
 * gates `enabled=true` on having at least one target assigned to the
 * subsystem's snapshot_class. The mapping is:
 *
 *   mail               → system_mail
 *   tenant_bundle      → tenant_bundle
 *   system_pitr        → system_backup
 *   longhorn_recurring → (no gate — Longhorn lives on local storage,
 *                        not in backup_target_assignments)
 *
 * "Strict" means the API refuses the PATCH with 409 SCHEDULE_GATE_BLOCKED
 * when an operator tries to enable a subsystem before its target is
 * assigned. The UI surfaces this with a banner pointing to
 * /settings/backup-infrastructure → Classes tab.
 */

import { eq, and, sql } from 'drizzle-orm';
import { backupSchedules, backupTargetAssignments } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import type {
  BackupScheduleRow,
  BackupScheduleSubsystem,
  UpdateBackupScheduleInput,
} from '@k8s-hosting/api-contracts';

// ─── Gate map ─────────────────────────────────────────────────────────

/**
 * Maps each subsystem to the snapshot_class that must have at least
 * one target assigned before the schedule can be enabled. Null means
 * the subsystem is ungated (e.g. Longhorn RecurringJob writes to
 * local node disk; no external target).
 */
const GATE_MAP: Record<string, string | null> = {
  mail: 'system_mail',
  tenant_bundle: 'tenant_bundle',
  system_pitr: 'system_backup',
  longhorn_recurring: null,
};

function gatedClassFor(subsystem: string): string | null {
  return GATE_MAP[subsystem] ?? null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function isGateSatisfied(db: Database, subsystem: string): Promise<boolean> {
  const cls = gatedClassFor(subsystem);
  if (!cls) return true; // ungated
  const rows = await db
    .select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.snapshotClass, cls))
    .limit(1);
  return rows.length > 0;
}

function toRow(
  row: typeof backupSchedules.$inferSelect,
  gateSatisfied: boolean,
): BackupScheduleRow {
  return {
    subsystem: row.subsystem,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    retentionDays: row.retentionDays,
    retentionCount: row.retentionCount,
    updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt)).toISOString(),
    updatedBy: row.updatedBy,
    gatedByClass: gatedClassFor(row.subsystem),
    gateSatisfied,
  };
}

// ─── Public service ──────────────────────────────────────────────────

export async function listSchedules(db: Database): Promise<BackupScheduleRow[]> {
  const rows = await db.select().from(backupSchedules);

  // Batch-fetch every gated class assignment in one query so we don't
  // do N+1 SELECTs per subsystem on the list view.
  const gatedClasses = Array.from(
    new Set(rows.map((r) => gatedClassFor(r.subsystem)).filter((c): c is string => !!c)),
  );
  const satisfied = new Set<string>();
  if (gatedClasses.length > 0) {
    const assignments = await db
      .select({ snapshotClass: backupTargetAssignments.snapshotClass })
      .from(backupTargetAssignments)
      .where(sql`${backupTargetAssignments.snapshotClass} IN ${gatedClasses}`);
    for (const a of assignments) satisfied.add(a.snapshotClass);
  }

  return rows.map((r) => {
    const cls = gatedClassFor(r.subsystem);
    const gateOk = cls ? satisfied.has(cls) : true;
    return toRow(r, gateOk);
  });
}

export async function getSchedule(
  db: Database,
  subsystem: BackupScheduleSubsystem | string,
): Promise<BackupScheduleRow | null> {
  const [row] = await db.select().from(backupSchedules)
    .where(eq(backupSchedules.subsystem, subsystem));
  if (!row) return null;
  const gateOk = await isGateSatisfied(db, subsystem);
  return toRow(row, gateOk);
}

export async function updateSchedule(
  db: Database,
  subsystem: BackupScheduleSubsystem | string,
  input: UpdateBackupScheduleInput,
  actorId: string | null,
): Promise<BackupScheduleRow> {
  // Strict-gate: refuse enabled=true unless the class is assigned.
  if (input.enabled === true) {
    const ok = await isGateSatisfied(db, subsystem);
    if (!ok) {
      const cls = gatedClassFor(subsystem);
      throw new ApiError(
        'SCHEDULE_GATE_BLOCKED',
        `Cannot enable ${subsystem} schedule until at least one target is assigned to the '${cls}' class. ` +
        `Configure it at /settings/backup-infrastructure → Classes.`,
        409,
        { subsystem, gatedByClass: cls },
      );
    }
  }

  // Build the SET clause from the optional fields the caller supplied.
  const patch: Record<string, unknown> = {
    updatedAt: new Date(),
    updatedBy: actorId,
  };
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.cronExpression !== undefined) patch.cronExpression = input.cronExpression;
  if (input.retentionDays !== undefined) patch.retentionDays = input.retentionDays;
  if (input.retentionCount !== undefined) patch.retentionCount = input.retentionCount;

  const updated = await db.update(backupSchedules)
    .set(patch)
    .where(eq(backupSchedules.subsystem, subsystem))
    .returning();
  if (updated.length === 0) {
    throw new ApiError(
      'SUBSYSTEM_NOT_FOUND',
      `No backup_schedules row for subsystem '${subsystem}'. Run migration 0011.`,
      404,
    );
  }
  const gateOk = await isGateSatisfied(db, subsystem);
  return toRow(updated[0], gateOk);
}

// ─── Internal helper for the schedulers ──────────────────────────────
//
// The tenant-bundle scheduler etc. need to read just `enabled` + cron
// quickly without the gate check; export a thin getter.

export async function getScheduleEnabledAndCron(
  db: Database,
  subsystem: string,
): Promise<{ enabled: boolean; cron: string | null } | null> {
  const [row] = await db.select({
    enabled: backupSchedules.enabled,
    cronExpression: backupSchedules.cronExpression,
  }).from(backupSchedules).where(eq(backupSchedules.subsystem, subsystem));
  if (!row) return null;
  return { enabled: row.enabled, cron: row.cronExpression };
}

// Silence unused-import warning when `and` isn't needed yet.
export const __unused = and;
