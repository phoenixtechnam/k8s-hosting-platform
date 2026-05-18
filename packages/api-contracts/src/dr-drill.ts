/**
 * DR drill runs (DR-bundle roadmap, Phase 1).
 *
 * One row per drill execution. CI posts results to platform-api via
 * a service-token-authenticated webhook; the admin DR Drill tab
 * reads the history through `GET /admin/system-backup/dr-drill/runs`.
 *
 * The schema deliberately captures enough to debug a failure without
 * re-running the drill (failure reason + JSON report) and to detect
 * flakiness over time (duration + outcome trend across the last 12
 * runs).
 */

import { z } from 'zod';

export const drDrillStatusSchema = z.enum(['running', 'success', 'failed', 'cancelled']);
export type DrDrillStatus = z.infer<typeof drDrillStatusSchema>;

export const drDrillTriggerSchema = z.enum(['cron', 'workflow_dispatch', 'manual', 'meta_test']);
export type DrDrillTrigger = z.infer<typeof drDrillTriggerSchema>;

export const drDrillRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: drDrillStatusSchema,
  trigger: drDrillTriggerSchema,
  /** SHA256 of the source bundle the drill restored from. */
  sourceBundleSha256: z.string().length(64).nullable(),
  /** Number of Secrets restored, helps spot truncation between bundle versions. */
  secretsRestoredCount: z.number().int().min(0).nullable(),
  /** Bundle size in bytes — drills must stay under a few MB. */
  bundleSizeBytes: z.number().int().min(0).nullable(),
  /** Wall-clock duration; null while running. */
  durationSeconds: z.number().int().min(0).nullable(),
  /** Set on failure; null on success. Short, operator-readable. */
  failureReason: z.string().max(500).nullable(),
  /** Structured per-phase result. The runner writes this; the UI
   *  renders the structured form so a future schema bump doesn't
   *  break older rows. */
  report: z
    .object({
      phases: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['pending', 'success', 'failed', 'skipped']),
          durationSeconds: z.number().min(0).optional(),
          message: z.string().optional(),
        }),
      ),
      smokeAssertions: z.array(
        z.object({
          name: z.string(),
          passed: z.boolean(),
          message: z.string().optional(),
        }),
      ),
    })
    .nullable(),
  /** Where the run ran (e.g. `github-actions/dr-drill@01HXYZ`). */
  runner: z.string().max(200),
});
export type DrDrillRun = z.infer<typeof drDrillRunSchema>;

export const listDrDrillRunsResponseSchema = z.object({
  data: z.array(drDrillRunSchema),
});
export type ListDrDrillRunsResponse = z.infer<typeof listDrDrillRunsResponseSchema>;

export const recordDrDrillRunRequestSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: drDrillStatusSchema,
  trigger: drDrillTriggerSchema,
  sourceBundleSha256: z.string().length(64).nullable(),
  secretsRestoredCount: z.number().int().min(0).nullable(),
  bundleSizeBytes: z.number().int().min(0).nullable(),
  durationSeconds: z.number().int().min(0).nullable(),
  failureReason: z.string().max(500).nullable(),
  report: drDrillRunSchema.shape.report,
  runner: z.string().max(200),
});
export type RecordDrDrillRunRequest = z.infer<typeof recordDrDrillRunRequestSchema>;

/** Aggregate health used by the admin UI. */
export const drDrillSummarySchema = z.object({
  lastSuccessAt: z.string().datetime().nullable(),
  lastFailureAt: z.string().datetime().nullable(),
  consecutiveSuccessCount: z.number().int().min(0),
  consecutiveFailureCount: z.number().int().min(0),
  /** Rolling 12-run pass rate, 0.0-1.0. */
  rollingPassRate: z.number().min(0).max(1),
});
export type DrDrillSummary = z.infer<typeof drDrillSummarySchema>;

export const drDrillSummaryResponseSchema = z.object({ data: drDrillSummarySchema });
export type DrDrillSummaryResponse = z.infer<typeof drDrillSummaryResponseSchema>;
