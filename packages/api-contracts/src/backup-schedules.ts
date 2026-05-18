import { z } from 'zod';

/**
 * Phase A.1 of the backup UI consolidation — uniform schedule shape
 * across all subsystems. The /admin/backups/schedules CRUD owns the
 * strict-gate: `enabled=true` is refused until the snapshot class
 * for this subsystem has at least one target assigned.
 *
 *   GET   /admin/backups/schedules
 *   GET   /admin/backups/schedules/:subsystem
 *   PATCH /admin/backups/schedules/:subsystem
 */

// ─── Subsystem enum ────────────────────────────────────────────────────
//
// Seeded by migration 0011. Free-form on the DB side so new
// subsystems can land without a schema migration, but the API contract
// pins the four known producers so frontends + tests get an enum.

export const backupScheduleSubsystemEnum = z.enum([
  'mail',                // restic upload — gates on system_mail target
  'tenant_bundle',       // nightly Plesk-style bundles — gates on tenant_bundle target
  'system_pitr',         // postgres base-backup cron — gates on system_backup target
  'longhorn_recurring',  // platform-wide Longhorn RecurringJob default
]);
export type BackupScheduleSubsystem = z.infer<typeof backupScheduleSubsystemEnum>;

// ─── Row shape ─────────────────────────────────────────────────────────

export const backupScheduleSchema = z.object({
  subsystem: z.string().min(1).max(64),
  enabled: z.boolean(),
  /** 5-field cron expression. Optional for subsystems with no cron. */
  cronExpression: z.string().min(1).max(128).nullable(),
  /** Days to keep, or null when not applicable. */
  retentionDays: z.number().int().nonnegative().nullable(),
  /** Count-based retention (e.g. restic --keep-last). */
  retentionCount: z.number().int().nonnegative().nullable(),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().nullable(),
  /** When enabled=false, which class needs a target before enable is allowed. */
  gatedByClass: z.string().nullable(),
  /** Convenience: true when the gated class already has ≥1 assignment. */
  gateSatisfied: z.boolean(),
});
export type BackupScheduleRow = z.infer<typeof backupScheduleSchema>;

// ─── List response ─────────────────────────────────────────────────────

// NB: tenant-bundles.ts already exports `listBackupSchedulesResponseSchema`
// for a different concept (per-tenant bundle schedule). Use a distinct
// name here to avoid the re-export collision in index.ts.
export const listSubsystemBackupSchedulesResponseSchema = z.object({
  schedules: z.array(backupScheduleSchema),
});
export type ListSubsystemBackupSchedulesResponse = z.infer<typeof listSubsystemBackupSchedulesResponseSchema>;

// ─── PATCH input ───────────────────────────────────────────────────────

export const updateBackupScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  cronExpression: z.string().min(1).max(128).nullable().optional(),
  retentionDays: z.number().int().nonnegative().nullable().optional(),
  retentionCount: z.number().int().nonnegative().nullable().optional(),
});
export type UpdateBackupScheduleInput = z.infer<typeof updateBackupScheduleSchema>;
