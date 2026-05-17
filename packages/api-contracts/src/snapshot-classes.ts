import { z } from 'zod';
import { snapshotClassEnum, type SnapshotClass } from './snapshot-accounting.js';

// ─── Snapshot Class Assignments (Phase 2 of snapshot-storage overhaul) ──
//
// Per-class routing: each snapshot class can be assigned to one or
// more backup targets (priority-ordered). The strict-primary resolver
// picks priority=lowest-number; failover requires operator action,
// not automatic.
//
// Mail and Longhorn snapshots are NOT assigned here — they keep their
// own native target configuration (per the mail-arch lock).

export { snapshotClassEnum };
export type { SnapshotClass };

// ─── Single assignment row ──────────────────────────────────────────────

export const assignmentRowSchema = z.object({
  snapshotClass: snapshotClassEnum,
  targetId: z.string().uuid(),
  targetName: z.string().min(1),
  // Pull-through fields from the joined target for the admin UI
  // (avoids a second roundtrip per row).
  targetStorageType: z.string().min(1).max(64),
  priority: z.number().int().min(0).max(10000),
  createdAt: z.string().datetime(),
});
export type AssignmentRow = z.infer<typeof assignmentRowSchema>;

// ─── Per-class view (list endpoint response) ────────────────────────────

export const classViewSchema = z.object({
  snapshotClass: snapshotClassEnum,
  // Sorted by priority ASC. Empty array means "no target assigned —
  // snapshots of this class are disabled and the resolver fails loud."
  assignments: z.array(assignmentRowSchema),
});
export type ClassView = z.infer<typeof classViewSchema>;

export const listClassesResponseSchema = z.object({
  classes: z.array(classViewSchema),
});
export type ListClassesResponse = z.infer<typeof listClassesResponseSchema>;

// ─── PUT input: replace the assignment set for one class ────────────────

export const assignmentInputSchema = z.object({
  targetId: z.string().uuid(),
  priority: z.number().int().min(0).max(10000),
});
export type AssignmentInput = z.infer<typeof assignmentInputSchema>;

export const setAssignmentsInputSchema = z.object({
  // Replace-set semantics: whatever is here is what the class will
  // have. Pass [] to remove all assignments (snapshots of this class
  // will then fail loud until reassigned).
  assignments: z.array(assignmentInputSchema).max(10),
});
export type SetAssignmentsInput = z.infer<typeof setAssignmentsInputSchema>;

export const setAssignmentsResponseSchema = z.object({
  snapshotClass: snapshotClassEnum,
  assignments: z.array(assignmentRowSchema),
});
export type SetAssignmentsResponse = z.infer<typeof setAssignmentsResponseSchema>;

// ─── POST test endpoint ────────────────────────────────────────────────
//
// Resolves the per-class primary target, performs a small upload-
// probe (~1 KiB), and returns the result. Lets the operator validate
// "is this target reachable AND assigned to this class?" with one
// click.

export const testClassResponseSchema = z.object({
  snapshotClass: snapshotClassEnum,
  targetId: z.string().uuid().nullable(),
  targetName: z.string().nullable(),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).nullable(),
});
export type TestClassResponse = z.infer<typeof testClassResponseSchema>;

// ─── Used-by-classes pill for BackupSettings ────────────────────────────
//
// Reverse view: "which classes route to this target?" Drives the
// per-target pill on the backup-settings page so the operator can see
// at a glance "this target is the primary for tenant_snapshot +
// system_etcd."

export const targetAssignmentsSummarySchema = z.object({
  targetId: z.string().uuid(),
  classes: z.array(z.object({
    snapshotClass: snapshotClassEnum,
    priority: z.number().int().min(0).max(10000),
  })),
});
export type TargetAssignmentsSummary = z.infer<typeof targetAssignmentsSummarySchema>;

export const targetSummariesResponseSchema = z.object({
  summaries: z.array(targetAssignmentsSummarySchema),
});
export type TargetSummariesResponse = z.infer<typeof targetSummariesResponseSchema>;
