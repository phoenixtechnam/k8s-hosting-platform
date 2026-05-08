import { z } from 'zod';

// ─── Node health monitoring ──────────────────────────────────────────────────
//
// 5-min reconciler that surfaces:
//   1. Kubelet-reported pressures (disk / memory / pid) — the canonical
//      "node is unhappy" signal. Pre-platform the only way to see this
//      was `kubectl describe node`.
//   2. CSINode driver count vs cluster baseline — catches the case where
//      a Longhorn pod was evicted and the worker silently lost
//      `driver.longhorn.io` registration. The 2026-05-08 worker incident
//      went 10 days unnoticed because nothing watched this.
//   3. Recent pod evictions (last hour) — when present indicates the
//      node has been under pressure recently even if it's now recovered.
//
// Severity:
//   - critical: any pressure=True OR not Ready OR CSI drivers missing
//                vs cluster baseline
//   - warning : recent evictions (>= EVICTION_WARNING_THRESHOLD/hour)
//   - normal  : everything green
//
// Notifications fire on severity transitions only (same throttling
// pattern as capacity-reconciler) — operators don't get spammed on
// every 5-min tick when a critical state persists.

export const nodeHealthSeveritySchema = z.enum(['normal', 'warning', 'critical']);
export type NodeHealthSeverity = z.infer<typeof nodeHealthSeveritySchema>;

export const nodePressureKindSchema = z.enum(['disk', 'memory', 'pid']);
export type NodePressureKind = z.infer<typeof nodePressureKindSchema>;

/**
 * Per-node health snapshot returned by GET /admin/node-health/summary.
 *
 * `csiDriversExpected` is the cluster-wide MODE — most common driver
 * count across all nodes. Catches "this node lost a driver" without
 * hardcoding what the expected baseline is for the operator's cluster
 * shape (which varies: control-plane-only nodes, worker-only nodes,
 * etc.). The `csiDriversMissing` array surfaces the names that aren't
 * registered on this node but exist on the baseline majority.
 */
export const nodeHealthEntrySchema = z.object({
  name: z.string(),
  ready: z.boolean(),
  /** True when the kubelet has set this condition; nodes reporting
   *  False or unknown are good. */
  pressures: z.array(nodePressureKindSchema),
  csiDriversPresent: z.number().int().nonnegative(),
  csiDriversExpected: z.number().int().nonnegative(),
  csiDriversMissing: z.array(z.string()),
  /** Count of `Evicted` Pod events on this node in the last 60 minutes. */
  evictionsLastHour: z.number().int().nonnegative(),
  /** Disk-fill percentage from kubelet `/stats/summary` rootfs +
   *  imagefs. null when the kubelet endpoint is unreachable. */
  diskUsedPct: z.number().min(0).max(100).nullable(),
  severity: nodeHealthSeveritySchema,
  /** ISO timestamp this row was last computed. */
  observedAt: z.string().datetime(),
});
export type NodeHealthEntry = z.infer<typeof nodeHealthEntrySchema>;

export const nodeHealthSummaryResponseSchema = z.object({
  data: z.object({
    nodes: z.array(nodeHealthEntrySchema),
    /** Highest severity across all nodes. UI surfaces this as a header
     *  badge so an operator on an unrelated page sees a critical
     *  banner without navigating to Monitoring first. */
    overallSeverity: nodeHealthSeveritySchema,
    /** When the reconciler last completed a tick (any node). */
    lastTickAt: z.string().datetime().nullable(),
  }),
});
export type NodeHealthSummaryResponse = z.infer<typeof nodeHealthSummaryResponseSchema>;
