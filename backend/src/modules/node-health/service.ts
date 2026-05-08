/**
 * Node-health reconciler — service layer.
 *
 * Pure (testable) functions for severity computation + cluster-wide
 * baseline calculation. K8s I/O lives in scheduler.ts; this file only
 * deals with already-fetched data.
 *
 * See packages/api-contracts/src/node-health.ts for the wire-format
 * spec and rationale.
 */

import type {
  NodeHealthEntry,
  NodeHealthSeverity,
  NodePressureKind,
} from '@k8s-hosting/api-contracts';

/**
 * Number of evictions/hour at which we flip from `normal` → `warning`.
 * One eviction is normal cluster ops (autoscaling, image-pull retry);
 * sustained evictions indicate the node is under real pressure.
 */
export const EVICTION_WARNING_THRESHOLD = 3;

/**
 * Number of evictions/hour at which we flip directly to `critical`
 * (skip `warning`). Indicates a runaway loop — exactly the pattern
 * the 2026-05-08 worker incident exhibited (Longhorn pods evicted
 * every ~8 minutes for 10 days).
 */
export const EVICTION_CRITICAL_THRESHOLD = 10;

/**
 * Disk-fill percentage for severity transitions when the kubelet's
 * own DiskPressure condition hasn't fired yet. Kubelet eviction-hard
 * is at 85-90% usually; we want to alert sooner so the operator has
 * time to respond before pods get evicted.
 */
export const DISK_USED_PCT_WARNING = 75;
export const DISK_USED_PCT_CRITICAL = 90;

/**
 * Raw subset of v1.Node we read from the K8s API.
 * Decoupled from @kubernetes/client-node types so unit tests don't
 * have to construct full API objects.
 */
export interface NodeFacts {
  readonly name: string;
  readonly ready: boolean;
  readonly diskPressure: boolean;
  readonly memoryPressure: boolean;
  readonly pidPressure: boolean;
  readonly csiDrivers: ReadonlyArray<string>;
  readonly evictionsLastHour: number;
  /** null = kubelet /stats/summary unreachable on this tick. */
  readonly diskUsedPct: number | null;
}

/**
 * Cluster-wide baseline expected by every node. The 'expected CSI
 * driver names' is the set of drivers present on the MAJORITY of
 * nodes — when a node is missing one of those, it's an outlier
 * worth alerting on.
 *
 * Mode-of-cluster is the right shape because the operator's cluster
 * may have heterogeneous nodes (control-plane-only vs worker-only).
 * We don't try to be smart about per-role baselines — Longhorn-csi
 * should be on every node that's a candidate for tenant volumes
 * regardless of role, and it's the only driver we care about for
 * this pattern.
 */
export interface ClusterBaseline {
  readonly expectedDrivers: ReadonlyArray<string>;
}

/**
 * Compute the cluster baseline driver set.
 *
 * Algorithm: a driver is "expected" when it's present on STRICTLY
 * MORE THAN half of the nodes. With 3-of-4 nodes carrying
 * `driver.longhorn.io` and 1 missing it (the 2026-05-08 worker
 * incident), this returns ['driver.longhorn.io'] → the missing
 * worker shows up as missing → severity=critical.
 *
 * Edge cases:
 *   - 1-node cluster: every driver on it is expected.
 *   - 2-node cluster, drivers differ: nothing crosses 50%, expected=[].
 *     Operators on 2-node clusters are responsible for confirming via
 *     the UI; alerting blind would false-positive.
 */
export function computeClusterBaseline(
  nodes: ReadonlyArray<Pick<NodeFacts, 'csiDrivers'>>,
): ClusterBaseline {
  const total = nodes.length;
  if (total === 0) return { expectedDrivers: [] };
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const d of n.csiDrivers) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const expected: string[] = [];
  for (const [driver, count] of counts) {
    if (count * 2 > total) expected.push(driver);
  }
  expected.sort();
  return { expectedDrivers: expected };
}

/**
 * Drivers expected on the cluster baseline that this node is
 * missing. Empty when the node is in line with the majority.
 */
export function missingDriversFor(
  node: Pick<NodeFacts, 'csiDrivers'>,
  baseline: ClusterBaseline,
): string[] {
  const present = new Set(node.csiDrivers);
  return baseline.expectedDrivers.filter((d) => !present.has(d)).sort();
}

/**
 * Severity for one node, given its facts + the cluster baseline.
 *
 * Order of precedence (highest first wins):
 *   1. critical: not Ready
 *   2. critical: any kubelet-reported pressure (kubelet has decided
 *      the node is unhealthy — it's already evicting pods)
 *   3. critical: missing one or more baseline-expected CSI drivers
 *      (== silent partial outage; tenant PVCs can't bind here)
 *   4. critical: evictions/hour >= EVICTION_CRITICAL_THRESHOLD
 *   5. critical: diskUsedPct >= DISK_USED_PCT_CRITICAL (early warning
 *      before kubelet fires DiskPressure)
 *   6. warning : evictions/hour >= EVICTION_WARNING_THRESHOLD
 *   7. warning : diskUsedPct >= DISK_USED_PCT_WARNING
 *   8. normal  : everything green
 */
export function severityFor(
  node: NodeFacts,
  baseline: ClusterBaseline,
): { severity: NodeHealthSeverity; missingDrivers: string[] } {
  const missingDrivers = missingDriversFor(node, baseline);

  if (!node.ready) return { severity: 'critical', missingDrivers };
  if (node.diskPressure || node.memoryPressure || node.pidPressure) {
    return { severity: 'critical', missingDrivers };
  }
  if (missingDrivers.length > 0) return { severity: 'critical', missingDrivers };
  if (node.evictionsLastHour >= EVICTION_CRITICAL_THRESHOLD) {
    return { severity: 'critical', missingDrivers };
  }
  if (
    node.diskUsedPct !== null
    && node.diskUsedPct >= DISK_USED_PCT_CRITICAL
  ) {
    return { severity: 'critical', missingDrivers };
  }
  if (node.evictionsLastHour >= EVICTION_WARNING_THRESHOLD) {
    return { severity: 'warning', missingDrivers };
  }
  if (
    node.diskUsedPct !== null
    && node.diskUsedPct >= DISK_USED_PCT_WARNING
  ) {
    return { severity: 'warning', missingDrivers };
  }
  return { severity: 'normal', missingDrivers };
}

/**
 * Build the per-node entry returned by GET /admin/node-health/summary.
 * Same shape as the `node_health_state` table row + observedAt as ISO.
 */
export function buildEntry(
  node: NodeFacts,
  baseline: ClusterBaseline,
  observedAt: Date,
): NodeHealthEntry {
  const { severity, missingDrivers } = severityFor(node, baseline);
  const pressures: NodePressureKind[] = [];
  if (node.diskPressure) pressures.push('disk');
  if (node.memoryPressure) pressures.push('memory');
  if (node.pidPressure) pressures.push('pid');
  return {
    name: node.name,
    ready: node.ready,
    pressures,
    csiDriversPresent: node.csiDrivers.length,
    csiDriversExpected: baseline.expectedDrivers.length,
    csiDriversMissing: missingDrivers,
    evictionsLastHour: node.evictionsLastHour,
    diskUsedPct: node.diskUsedPct,
    severity,
    observedAt: observedAt.toISOString(),
  };
}

/**
 * Highest severity across all nodes — surfaces in the API response so
 * the admin panel header can show a banner without per-row inspection.
 */
export function overallSeverity(
  entries: ReadonlyArray<NodeHealthEntry>,
): NodeHealthSeverity {
  if (entries.some((e) => e.severity === 'critical')) return 'critical';
  if (entries.some((e) => e.severity === 'warning')) return 'warning';
  return 'normal';
}

/**
 * Whether to fan out a notification for this node now.
 *
 * Three trigger conditions (any one fires):
 *   1. severity transition (any direction) — operator should always
 *      know when state changes.
 *   2. severity is critical AND last notification > 24h ago — re-ping
 *      so the operator doesn't forget about a sustained outage.
 *   3. severity is warning AND last notification > 24h ago — same.
 */
export function shouldNotify(input: {
  newSeverity: NodeHealthSeverity;
  prevSeverity: NodeHealthSeverity;
  lastNotifiedAt: Date | null;
  now: Date;
}): boolean {
  if (input.newSeverity !== input.prevSeverity) return true;
  if (input.newSeverity === 'normal') return false;
  if (!input.lastNotifiedAt) return true;
  const elapsedMs = input.now.getTime() - input.lastNotifiedAt.getTime();
  return elapsedMs >= 24 * 60 * 60 * 1000;
}
