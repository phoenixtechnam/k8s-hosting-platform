/**
 * Backup health observability — API contract.
 *
 * Returned by GET /api/v1/admin/backup-health. Each entry rolls up the
 * recent Job runs of one logical backup (CronJob or one-off Job) into
 * a single state + lastSuccess/lastFailed pair for the UI.
 */
import { z } from 'zod';

export const backupCategorySchema = z.enum(['dr', 'tenant', 'audit', 'custom']);
export type BackupCategory = z.infer<typeof backupCategorySchema>;

export const backupSeveritySchema = z.enum(['critical', 'warning', 'info']);
export type BackupSeverity = z.infer<typeof backupSeveritySchema>;

export const backupHealthStateSchema = z.enum(['healthy', 'failing', 'never_run']);
export type BackupHealthState = z.infer<typeof backupHealthStateSchema>;

export const backupHealthSummarySchema = z.object({
  groupKey: z.string(),
  displayName: z.string(),
  namespace: z.string(),
  category: backupCategorySchema,
  severity: backupSeveritySchema,
  clientId: z.string().nullable(),
  state: backupHealthStateSchema,
  lastSuccessAt: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
  lastFailedReason: z.string().nullable(),
  recentRuns: z.number().int().nonnegative(),
});

export type BackupHealthSummary = z.infer<typeof backupHealthSummarySchema>;

export const backupHealthResponseSchema = z.array(backupHealthSummarySchema);
export type BackupHealthResponse = z.infer<typeof backupHealthResponseSchema>;
