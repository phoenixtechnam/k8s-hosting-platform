import { z } from 'zod';

// ─── Postgres PITR Restore ───────────────────────────────────────────────────
//
// Snapshot-only point-in-time-recovery for CNPG-managed Postgres.
// Operator picks a Longhorn snapshot in the System Snapshots modal,
// optionally a sub-hour PITR target, and the orchestrator auto-promotes
// the restored cluster (replaces the source). Sync HTTP (~5–10 min).

export const pitrStepSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  elapsedMs: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
});
export type PitrStep = z.infer<typeof pitrStepSchema>;

export const pitrResultSchema = z.object({
  clusterName: z.string(),
  snapshotName: z.string(),
  recoveryTargetTime: z.string().nullable(),
  steps: z.array(pitrStepSchema),
  downtimeMs: z.number().int().nonnegative(),
  tempClusterName: z.string(),
});
export type PitrResult = z.infer<typeof pitrResultSchema>;

export const pitrStatusSchema = z.object({
  inProgress: z.boolean(),
  startedAt: z.string().optional(),
  snapshot: z.string().optional(),
});
export type PitrStatus = z.infer<typeof pitrStatusSchema>;

export const pitrRequestSchema = z.object({
  clusterNamespace: z.string().min(1).max(253),
  clusterName: z.string().min(1).max(253),
  snapshotName: z.string().min(1).max(253),
  recoveryTargetTime: z.string().datetime().optional(),
});
export type PitrRequest = z.infer<typeof pitrRequestSchema>;
