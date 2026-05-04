/**
 * Cluster-storage capacity reconciler.
 *
 * Every 5 min reads each Longhorn node's storageScheduled vs effective
 * capacity (storageMaximum − operator-set storageReserved). Computes a
 * per-node commit% AND a cluster-wide commit%. Emits admin
 * notifications on transitions:
 *
 *   normal → warning      (any node ≥ 80% OR cluster ≥ 80%)
 *   warning → critical    (any node ≥ 95% OR cluster ≥ 95%)
 *   critical → critical   (suppressed; throttled to 1× per 24 h)
 *   any → normal          (recovery)
 *
 * The state-transition memory lives in `platform_settings` so a
 * platform-api restart doesn't re-spam admins on the next tick. Single
 * row, key=`platform_capacity_state`.
 *
 * This sits next to the storage-policy advisor (which patches
 * Longhorn / CNPG / Deployments to match policy). The advisor
 * REACTS to drift; this reconciler WARNS the operator before drift
 * becomes "scaling silently fails because precheck couldn't fit a
 * 10 GiB replica" (the postgres-2 case observed 2026-05-04).
 */

import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { notifications, users, platformSettings } from '../../db/schema.js';

const TICK_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 90_000;
const STATE_KEY = 'platform_capacity_state';

const WARNING_PCT = 80;
const CRITICAL_PCT = 95;

type Severity = 'normal' | 'warning' | 'critical';

interface PersistedState {
  readonly severity: Severity;
  readonly clusterCommitPct: number;
  readonly worstNode: string | null;
  readonly worstNodePct: number;
  readonly lastNotifiedAt: string;
}

interface LonghornNode {
  metadata?: { name?: string };
  spec?: {
    allowScheduling?: boolean;
    disks?: Record<string, { allowScheduling?: boolean; storageReserved?: number }>;
    tags?: string[];
  };
  status?: {
    diskStatus?: Record<string, { storageMaximum?: number; storageScheduled?: number }>;
  };
}

function severityFor(pct: number): Severity {
  if (pct >= CRITICAL_PCT) return 'critical';
  if (pct >= WARNING_PCT) return 'warning';
  return 'normal';
}

async function readState(db: Database): Promise<PersistedState | null> {
  const rows = await db.select().from(platformSettings).where(eq(platformSettings.key, STATE_KEY)).limit(1);
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value) as PersistedState; } catch { return null; }
}

async function writeState(db: Database, state: PersistedState): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: STATE_KEY, value: JSON.stringify(state) })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: JSON.stringify(state) } });
}

interface NodeFact {
  readonly name: string;
  readonly commitPct: number;
  readonly capacityBytes: number;
  readonly scheduledBytes: number;
  readonly freeBytes: number;
}

export interface ClusterCapacitySnapshot {
  readonly nodes: ReadonlyArray<NodeFact>;
  readonly clusterCommitPct: number;
  readonly clusterCapacityBytes: number;
  readonly clusterScheduledBytes: number;
  readonly clusterFreeBytes: number;
}

/** Public — also used by the storage-policy advisor's drift check. */
export async function readClusterCapacity(k8s: K8sClients): Promise<ClusterCapacitySnapshot> {
  const lhResp = await k8s.custom.listNamespacedCustomObject({
    group: 'longhorn.io', version: 'v1beta2',
    namespace: 'longhorn-system', plural: 'nodes',
  } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LonghornNode[] };

  const nodes: NodeFact[] = [];
  let clusterCapacityBytes = 0;
  let clusterScheduledBytes = 0;
  for (const n of lhResp.items ?? []) {
    const name = n.metadata?.name;
    if (!name) continue;
    if (n.spec?.allowScheduling === false) continue;
    let capacityBytes = 0;
    let scheduledBytes = 0;
    for (const [diskKey, diskSpec] of Object.entries(n.spec?.disks ?? {})) {
      if (diskSpec.allowScheduling === false) continue;
      const stat = n.status?.diskStatus?.[diskKey] ?? {};
      const max = stat.storageMaximum ?? 0;
      const sched = stat.storageScheduled ?? 0;
      const reserved = diskSpec.storageReserved ?? 0;
      capacityBytes += Math.max(0, max - reserved);
      scheduledBytes += sched;
    }
    if (capacityBytes === 0) continue;
    const commitPct = Math.round((scheduledBytes / capacityBytes) * 1000) / 10;
    nodes.push({ name, commitPct, capacityBytes, scheduledBytes, freeBytes: Math.max(0, capacityBytes - scheduledBytes) });
    clusterCapacityBytes += capacityBytes;
    clusterScheduledBytes += scheduledBytes;
  }
  const clusterCommitPct = clusterCapacityBytes > 0
    ? Math.round((clusterScheduledBytes / clusterCapacityBytes) * 1000) / 10
    : 0;
  return {
    nodes,
    clusterCommitPct,
    clusterCapacityBytes,
    clusterScheduledBytes,
    clusterFreeBytes: Math.max(0, clusterCapacityBytes - clusterScheduledBytes),
  };
}

/** Start the 5-min capacity reconciler. Caller passes the platform-api
 * `app.db` and a `K8sClients`. Returns a `stop()` for graceful shutdown. */
export function startCapacityReconciler(db: Database, k8s: K8sClients): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[capacity-reconciler] starting (5min cadence)');

  const tick = async () => {
    if (stopped) return;
    try {
      const snap = await readClusterCapacity(k8s);
      const worst = snap.nodes.reduce<NodeFact | null>(
        (a, b) => (a === null || b.commitPct > a.commitPct ? b : a),
        null,
      );
      const newSeverity: Severity = severityFor(Math.max(snap.clusterCommitPct, worst?.commitPct ?? 0));
      const prev = await readState(db);
      const prevSeverity: Severity = prev?.severity ?? 'normal';
      const now = new Date();
      const lastNotifiedAt = prev?.lastNotifiedAt ? new Date(prev.lastNotifiedAt) : null;
      const sinceLastMs = lastNotifiedAt ? now.getTime() - lastNotifiedAt.getTime() : Infinity;
      const dailyThrottleMs = 24 * 60 * 60 * 1000;

      const shouldNotify =
        // Severity transition (up OR down) always emits.
        newSeverity !== prevSeverity
        // Same critical level — emit at most once per 24 h.
        || (newSeverity === 'critical' && sinceLastMs >= dailyThrottleMs)
        || (newSeverity === 'warning' && sinceLastMs >= dailyThrottleMs);

      if (shouldNotify) {
        await fanoutNotification(db, snap, worst, newSeverity);
      }

      await writeState(db, {
        severity: newSeverity,
        clusterCommitPct: snap.clusterCommitPct,
        worstNode: worst?.name ?? null,
        worstNodePct: worst?.commitPct ?? 0,
        lastNotifiedAt: shouldNotify ? now.toISOString() : (prev?.lastNotifiedAt ?? now.toISOString()),
      });
    } catch (err) {
      console.error('[capacity-reconciler] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

async function fanoutNotification(
  db: Database,
  snap: ClusterCapacitySnapshot,
  worst: NodeFact | null,
  severity: Severity,
): Promise<void> {
  const adminRows = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
  const titleByLevel: Record<Severity, string> = {
    normal: 'Storage capacity recovered to normal',
    warning: `Storage capacity at ${snap.clusterCommitPct}% — approaching limit`,
    critical: `Storage capacity at ${snap.clusterCommitPct}% — provisioning may fail`,
  };
  const title = titleByLevel[severity];
  const lines: string[] = [];
  lines.push(`Cluster ${snap.clusterCommitPct}% committed (${(snap.clusterScheduledBytes / 1024 / 1024 / 1024).toFixed(1)} of ${(snap.clusterCapacityBytes / 1024 / 1024 / 1024).toFixed(1)} GiB).`);
  if (worst) {
    lines.push(`Worst node: ${worst.name} at ${worst.commitPct}% (${(worst.scheduledBytes / 1024 / 1024 / 1024).toFixed(1)} of ${(worst.capacityBytes / 1024 / 1024 / 1024).toFixed(1)} GiB).`);
  }
  if (severity === 'critical') {
    lines.push('Action: free space (delete unused tenants / orphan PVs / unused snapshots) OR add a server node.');
  } else if (severity === 'warning') {
    lines.push('Heads-up: new client provisioning + Apply HA scale-up will start failing soon. Plan to free space or add capacity.');
  }
  const message = lines.join(' ');
  const type = severity === 'critical' ? 'error' : (severity === 'warning' ? 'warning' : 'info');
  for (const a of adminRows) {
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: a.id,
      type,
      title,
      message,
      resourceType: 'cluster_capacity',
      resourceId: 'singleton',
    }).catch((err) => console.error('[capacity-reconciler] notification insert failed:', (err as Error).message));
  }
  console.log(`[capacity-reconciler] ${severity}: cluster=${snap.clusterCommitPct}% worst=${worst?.name ?? '(none)'}@${worst?.commitPct ?? 0}% — notified ${adminRows.length} admin(s)`);
}
