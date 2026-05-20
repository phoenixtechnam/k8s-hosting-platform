// Backup-rclone-shim assignment API (R-X5+).
//
// The shim is the universal mediator between every platform backup
// callsite and its upstream storage. It exposes one ClusterIP serving
// three buckets ('system', 'tenant', 'mail') — one per backup-class.
// Operators bind each class to a `backup_configurations` row through
// this endpoint; the shim reconciler picks up the change and rolls.
//
// The legacy 4-class admin surface in `snapshot-classes` continues to
// drive the storage-lifecycle path. This contract is exclusively for
// the 3-class shim taxonomy introduced in migration 0016.

import { z } from 'zod';

// ─── Class taxonomy ──────────────────────────────────────────────────────

/** The three shim classes — source of truth for routing keys.
 *  Mirrors `SHIM_CLASSES` in backend/src/modules/backup-rclone-shim/service.ts.
 */
export const backupShimClassEnum = z.enum(['system', 'tenant', 'mail']);
export type BackupShimClass = z.infer<typeof backupShimClassEnum>;

// ─── Drain timeout bounds ───────────────────────────────────────────────
//
// 30 s minimum — anything lower would cause a force-restart cascade on
// any cluster running even one ongoing backup. 1 800 s (30 min) ceiling
// — long enough for a multi-GiB tenant bundle to upload to slow SFTP
// without forcing, short enough that operators can't accidentally lock
// themselves out of changing targets.

export const DRAIN_TIMEOUT_SECONDS_MIN = 30;
export const DRAIN_TIMEOUT_SECONDS_MAX = 1800;
export const DRAIN_TIMEOUT_SECONDS_DEFAULT = 300;

export const drainTimeoutSecondsSchema = z
  .number()
  .int()
  .min(DRAIN_TIMEOUT_SECONDS_MIN)
  .max(DRAIN_TIMEOUT_SECONDS_MAX);

// ─── Assignment write ───────────────────────────────────────────────────

/**
 * Body for `PUT /api/v1/admin/backup-rclone-shim/assignments/:className`.
 *
 * Replace-set: the assignment for the class is set to exactly the rows
 * in this request. `targetId: null` clears the class (shim sleeps for
 * that bucket).
 *
 * `force` (default false) skips the in-flight drain wait. Operators
 * should only set this when an existing backup is genuinely stuck and
 * they accept the consequence that the new shim config will roll over
 * mid-upload.
 */
export const putShimAssignmentRequestSchema = z.object({
  /** Target id to bind to the class. `null` → unassign (shim sleeps for the class). */
  targetId: z.string().min(1).max(36).nullable(),
  /** Skip the drain wait. Defaults to false. */
  force: z.boolean().default(false),
  /** Per-operation override of the assigned target's drain_timeout_seconds.
   *  When omitted, the target's stored value is used (or the global
   *  default when both are absent). Bound-checked. */
  drainTimeoutSecondsOverride: drainTimeoutSecondsSchema.optional(),
});
export type PutShimAssignmentRequest = z.infer<
  typeof putShimAssignmentRequestSchema
>;

export const shimAssignmentRowSchema = z.object({
  className: backupShimClassEnum,
  targetId: z.string().min(1).max(36).nullable(),
  targetName: z.string().nullable(),
  /** Storage type of the bound target (or null when unassigned). */
  targetStorageType: z
    .enum(['s3', 'ssh', 'cifs', 'nfs'])
    .nullable(),
  /** Per-target drain timeout used for ops on this class. Already
   *  defaulted server-side. */
  drainTimeoutSeconds: drainTimeoutSecondsSchema,
});
export type ShimAssignmentRow = z.infer<typeof shimAssignmentRowSchema>;

export const listShimAssignmentsResponseSchema = z.object({
  data: z.object({
    assignments: z.array(shimAssignmentRowSchema),
  }),
});
export type ListShimAssignmentsResponse = z.infer<
  typeof listShimAssignmentsResponseSchema
>;

// ─── Drain status ───────────────────────────────────────────────────────

/**
 * Snapshot of the drain phase emitted into `tasks.progressText` /
 * `tasks.details` so the progress modal can render a real-time view.
 */
export const drainPhaseEnum = z.enum([
  /** No in-flight shim consumers detected; drain completed immediately. */
  'drain_immediate',
  /** Polling for in-flight tasks to finish. */
  'drain_waiting',
  /** Drain timeout reached; force-applying new config. */
  'drain_timeout_forced',
  /** Drain skipped via `force=true`. */
  'drain_skipped',
  /** Writing assignment to DB. */
  'db_write',
  /** Calling the shim reconciler. */
  'reconcile',
  /** Waiting for shim DaemonSet pods to come ready. */
  'verify_ready',
  /** All done — assignment + shim materialised. */
  'done',
]);
export type DrainPhase = z.infer<typeof drainPhaseEnum>;

export const drainStatusSchema = z.object({
  phase: drainPhaseEnum,
  inFlightAtStart: z.number().int().min(0),
  inFlightAtEnd: z.number().int().min(0),
  drained: z.boolean(),
  /** Wall time of the drain phase (ms). */
  elapsedMs: z.number().int().min(0),
  /** Configured timeout (ms). */
  timeoutMs: z.number().int().min(0),
  /** Inflight task kinds observed during the drain wait — for operator
   *  diagnostics ("4 tenant.bundle, 1 backup.run still running"). Up
   *  to 20 entries to keep the JSON small. */
  inflightSampleKinds: z.array(z.string().max(64)).max(20).default([]),
});
export type DrainStatus = z.infer<typeof drainStatusSchema>;

// ─── Apply-assignment response envelope ─────────────────────────────────

export const putShimAssignmentResponseSchema = z.object({
  data: shimAssignmentRowSchema,
  /** Task-center id so the frontend can open the progress modal. */
  taskId: z.string().uuid(),
});
export type PutShimAssignmentResponse = z.infer<
  typeof putShimAssignmentResponseSchema
>;

// ─── Drain-now (operator escape hatch) ──────────────────────────────────
//
// Wait for in-flight shim consumers across ALL classes to drain — no
// assignment change. Used by operators investigating a "stuck backup"
// alert or before manual maintenance on the upstream target.

export const drainNowRequestSchema = z.object({
  /** Optional per-class filter — empty array means "any class". */
  classes: z.array(backupShimClassEnum).max(3).default([]),
  drainTimeoutSecondsOverride: drainTimeoutSecondsSchema.optional(),
});
export type DrainNowRequest = z.infer<typeof drainNowRequestSchema>;

export const drainNowResponseSchema = z.object({
  data: drainStatusSchema,
  taskId: z.string().uuid(),
});
export type DrainNowResponse = z.infer<typeof drainNowResponseSchema>;

// ─── Status / observability ─────────────────────────────────────────────
//
// Mirrors the on-cluster `backup-rclone-shim-status` ConfigMap so the
// admin UI can render the operator-visible state without a separate
// k8s API call.

export const shimStateEnum = z.enum([
  'STATE_OK',
  'STATE_MISSING_KEY',
  'STATE_NO_ASSIGNMENTS',
  'STATE_ERROR',
]);
export type ShimState = z.infer<typeof shimStateEnum>;

export const shimStatusResponseSchema = z.object({
  data: z.object({
    state: shimStateEnum,
    reconciledAt: z.string(),
    keyFingerprint: z.string(),
    inputHash: z.string(),
    assignedClasses: z.array(backupShimClassEnum),
    errorMessage: z.string(),
    /** Number of currently in-flight shim-consumer tasks across all
     *  classes — for the dashboard tile. */
    inflightConsumerCount: z.number().int().min(0),
  }),
});
export type ShimStatusResponse = z.infer<typeof shimStatusResponseSchema>;
