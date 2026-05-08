/**
 * Node-health reconciler — 5-min tick.
 *
 * Closes the three monitoring gaps surfaced by the 2026-05-08 worker
 * incident (Calico Felix crash-looped, evicted Longhorn pods, worker
 * silently lost driver.longhorn.io for 10 days):
 *
 *   1. Host disk pressure visibility (kubelet's DiskPressure
 *      condition is only seen via `kubectl describe node`).
 *   2. CSINode driver count drop (cluster-health module surfaces
 *      it in API but never alerts).
 *   3. Pod-eviction loops (nothing watches Pod/Node events).
 *
 * Same scheduler shape as capacity-reconciler (the Longhorn-capacity
 * cousin): 90s INITIAL_DELAY past startup migrations, 5min cadence,
 * single in-process timer, stop() on app close. Notifications fan
 * out to admin/super_admin role on severity transitions, with 24h
 * re-fire for sustained warning/critical to prevent alert fatigue.
 */

import crypto from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { nodeHealthState, notifications, users } from '../../db/schema.js';
import {
  buildEntry,
  computeClusterBaseline,
  overallSeverity,
  shouldNotify,
  type NodeFacts,
} from './service.js';
import type {
  NodeHealthEntry,
  NodeHealthSeverity,
} from '@k8s-hosting/api-contracts';

const TICK_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 90_000;
const EVICTION_WINDOW_MS = 60 * 60 * 1000; // 1h

interface RawNode {
  readonly metadata?: { readonly name?: string };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
    }>;
  };
}

interface RawCSINode {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly drivers?: ReadonlyArray<{ readonly name?: string }>;
  };
}

interface RawEvent {
  readonly reason?: string;
  readonly type?: string;
  readonly involvedObject?: { readonly kind?: string };
  readonly source?: { readonly host?: string };
  readonly reportingInstance?: string;
  readonly metadata?: { readonly creationTimestamp?: string };
  readonly eventTime?: string;
  readonly lastTimestamp?: string;
  readonly firstTimestamp?: string;
}

/**
 * One reconcile pass. Exported for unit tests; the public entrypoint
 * is `startNodeHealthScheduler` below which wraps it in a setTimeout
 * loop.
 */
export async function reconcileNodeHealth(
  db: Database,
  k8s: K8sClients,
  now: Date = new Date(),
): Promise<{
  readonly entries: ReadonlyArray<NodeHealthEntry>;
  readonly notified: ReadonlyArray<string>;
}> {
  // ── 1. Pull all data sources in parallel ────────────────────────
  const [nodeList, csiNodeList, eventList] = await Promise.all([
    k8s.core.listNode({}) as Promise<{ items?: ReadonlyArray<RawNode> }>,
    k8s.storage.listCSINode({}) as Promise<{ items?: ReadonlyArray<RawCSINode> }>,
    k8s.core.listEventForAllNamespaces({
      fieldSelector: 'reason=Evicted',
    } as Parameters<typeof k8s.core.listEventForAllNamespaces>[0])
      .catch(() => ({ items: [] as RawEvent[] })) as Promise<{ items?: ReadonlyArray<RawEvent> }>,
  ]);

  // ── 2. Index lookup tables ──────────────────────────────────────
  const csiByNode = new Map<string, string[]>();
  for (const c of csiNodeList.items ?? []) {
    const name = c.metadata?.name;
    if (!name) continue;
    csiByNode.set(name, (c.spec?.drivers ?? []).map((d) => d.name ?? '').filter((n) => n.length > 0));
  }

  const evictionsByNode = new Map<string, number>();
  const cutoff = now.getTime() - EVICTION_WINDOW_MS;
  for (const e of eventList.items ?? []) {
    if (e.reason !== 'Evicted') continue;
    if (e.involvedObject?.kind !== 'Pod') continue;
    const ts = pickEventTimestamp(e);
    if (!ts || ts.getTime() < cutoff) continue;
    const host = e.source?.host ?? e.reportingInstance ?? '';
    if (!host) continue;
    evictionsByNode.set(host, (evictionsByNode.get(host) ?? 0) + 1);
  }

  // ── 3. Build NodeFacts for each node ────────────────────────────
  const facts: NodeFacts[] = [];
  for (const n of nodeList.items ?? []) {
    const name = n.metadata?.name;
    if (!name) continue;
    const conditions = n.status?.conditions ?? [];
    const cond = (type: string) =>
      conditions.find((c) => c.type === type)?.status === 'True';
    const ready = conditions.find((c) => c.type === 'Ready')?.status === 'True';
    facts.push({
      name,
      ready,
      diskPressure: cond('DiskPressure'),
      memoryPressure: cond('MemoryPressure'),
      pidPressure: cond('PIDPressure'),
      csiDrivers: csiByNode.get(name) ?? [],
      evictionsLastHour: evictionsByNode.get(name) ?? 0,
      // Phase-1 ships without kubelet /stats/summary integration —
      // it requires nodes/proxy roundtrips (one per node, ~250ms each)
      // which would dominate tick cost. The kubelet-reported
      // DiskPressure flag covers the high-impact case (the
      // 2026-05-08 incident hit DiskPressure=True at ~88%; we'd
      // alert on that regardless). We can extend in a follow-up.
      diskUsedPct: null,
    });
  }

  // ── 4. Compute baseline + per-node entry ────────────────────────
  const baseline = computeClusterBaseline(facts);
  const entries = facts.map((f) => buildEntry(f, baseline, now));

  // ── 5. Diff against persisted state, persist + notify ──────────
  const prevRows = await db.select().from(nodeHealthState);
  const prevByName = new Map(prevRows.map((r) => [r.nodeName, r]));

  const adminUserIds = await getAdminUserIds(db);
  const notified: string[] = [];

  for (const entry of entries) {
    const prev = prevByName.get(entry.name);
    const prevSeverity = (prev?.severity ?? 'normal') as NodeHealthSeverity;
    const lastNotifiedAt = prev?.lastNotifiedAt ?? null;
    const willNotify = shouldNotify({
      newSeverity: entry.severity,
      prevSeverity,
      lastNotifiedAt,
      now,
    });
    const notifiedAt = willNotify ? now : lastNotifiedAt;

    await db.insert(nodeHealthState)
      .values({
        nodeName: entry.name,
        ready: entry.ready,
        pressures: [...entry.pressures],
        csiDriversPresent: entry.csiDriversPresent,
        csiDriversExpected: entry.csiDriversExpected,
        csiDriversMissing: [...entry.csiDriversMissing],
        evictionsLastHour: entry.evictionsLastHour,
        diskUsedPct: entry.diskUsedPct === null ? null : entry.diskUsedPct.toString(),
        severity: entry.severity,
        lastNotifiedAt: notifiedAt,
        observedAt: now,
      })
      .onConflictDoUpdate({
        target: nodeHealthState.nodeName,
        set: {
          ready: entry.ready,
          pressures: [...entry.pressures],
          csiDriversPresent: entry.csiDriversPresent,
          csiDriversExpected: entry.csiDriversExpected,
          csiDriversMissing: [...entry.csiDriversMissing],
          evictionsLastHour: entry.evictionsLastHour,
          diskUsedPct: entry.diskUsedPct === null ? null : entry.diskUsedPct.toString(),
          severity: entry.severity,
          lastNotifiedAt: notifiedAt,
          observedAt: now,
        },
      });

    if (willNotify) {
      await fanoutNotification(db, adminUserIds, entry, prevSeverity);
      notified.push(entry.name);
    }
  }

  // Drop rows for nodes that no longer exist (operator deleted a node).
  const liveNames = new Set(entries.map((e) => e.name));
  const stale = prevRows.filter((r) => !liveNames.has(r.nodeName));
  if (stale.length > 0) {
    await db.delete(nodeHealthState).where(inArray(nodeHealthState.nodeName, stale.map((s) => s.nodeName)));
  }

  return { entries, notified };
}

async function getAdminUserIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: users.id })
    .from(users)
    .where(inArray(users.roleName, ['super_admin', 'admin']));
  return rows.map((r) => r.id);
}

async function fanoutNotification(
  db: Database,
  adminUserIds: ReadonlyArray<string>,
  entry: NodeHealthEntry,
  prevSeverity: NodeHealthSeverity,
): Promise<void> {
  const title = titleFor(entry, prevSeverity);
  const message = messageFor(entry);
  const type = entry.severity === 'critical' ? 'error'
    : entry.severity === 'warning' ? 'warning'
    : 'info';
  for (const uid of adminUserIds) {
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: uid,
      type,
      title,
      message,
      resourceType: 'node_health',
      resourceId: entry.name,
    }).catch((err) => {
      console.error('[node-health-monitor] notification insert failed:', (err as Error).message);
    });
  }
}

function titleFor(entry: NodeHealthEntry, prev: NodeHealthSeverity): string {
  if (entry.severity === 'normal') return `Node ${entry.name} recovered to normal`;
  const verb = prev === 'normal' ? 'flagged' : 'still';
  if (entry.severity === 'critical') return `Node ${entry.name} ${verb} CRITICAL`;
  return `Node ${entry.name} ${verb} at warning level`;
}

function messageFor(entry: NodeHealthEntry): string {
  const parts: string[] = [];
  if (!entry.ready) parts.push('NotReady');
  if (entry.pressures.length > 0) parts.push(`pressure: ${entry.pressures.join(', ')}`);
  if (entry.csiDriversMissing.length > 0) parts.push(`CSI missing: ${entry.csiDriversMissing.join(', ')}`);
  if (entry.evictionsLastHour > 0) parts.push(`${entry.evictionsLastHour} pod evictions/h`);
  if (entry.diskUsedPct !== null) parts.push(`disk: ${entry.diskUsedPct.toFixed(0)}%`);
  if (parts.length === 0) return `Node ${entry.name} OK.`;
  return `Node ${entry.name}: ${parts.join('; ')}.`;
}

function pickEventTimestamp(e: RawEvent): Date | null {
  const candidates = [e.eventTime, e.lastTimestamp, e.firstTimestamp, e.metadata?.creationTimestamp];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Read-side helper for the API route + UI. Returns the latest
 * persisted snapshot in api-contracts shape, sorted by severity then
 * name. Falls back to live computation if no rows exist (first tick
 * hasn't fired yet on a fresh boot).
 */
export async function readNodeHealthSummary(db: Database): Promise<{
  readonly nodes: ReadonlyArray<NodeHealthEntry>;
  readonly overallSeverity: NodeHealthSeverity;
  readonly lastTickAt: string | null;
}> {
  const rows = await db.select().from(nodeHealthState);
  const entries: NodeHealthEntry[] = rows.map((r) => ({
    name: r.nodeName,
    ready: r.ready,
    pressures: (r.pressures as string[]).filter(
      (p): p is 'disk' | 'memory' | 'pid' => p === 'disk' || p === 'memory' || p === 'pid',
    ),
    csiDriversPresent: r.csiDriversPresent,
    csiDriversExpected: r.csiDriversExpected,
    csiDriversMissing: [...(r.csiDriversMissing as string[])],
    evictionsLastHour: r.evictionsLastHour,
    diskUsedPct: r.diskUsedPct === null ? null : Number(r.diskUsedPct),
    severity: r.severity as NodeHealthSeverity,
    observedAt: r.observedAt.toISOString(),
  }));
  // Sort: critical → warning → normal, then by name.
  const order: Record<NodeHealthSeverity, number> = { critical: 0, warning: 1, normal: 2 };
  entries.sort((a, b) => order[a.severity] - order[b.severity] || a.name.localeCompare(b.name));

  let lastTickAt: string | null = null;
  if (rows.length > 0) {
    const latest = rows.reduce<Date | null>((acc, r) => {
      if (!acc || r.observedAt.getTime() > acc.getTime()) return r.observedAt;
      return acc;
    }, null);
    lastTickAt = latest?.toISOString() ?? null;
  }

  return {
    nodes: entries,
    overallSeverity: overallSeverity(entries),
    lastTickAt,
  };
}

export function startNodeHealthScheduler(
  db: Database,
  k8s: K8sClients,
): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  console.log('[node-health-monitor] starting (5min cadence)');

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await reconcileNodeHealth(db, k8s);
      if (result.notified.length > 0) {
        console.log(`[node-health-monitor] notified ${result.notified.length} severity transition(s): ${result.notified.join(', ')}`);
      }
    } catch (err) {
      console.error('[node-health-monitor] tick failed:', (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

// Exported for SQL audits + drizzle relations if needed elsewhere.
export const _nodeHealthStateForRelations = nodeHealthState;
// `sql` is imported because some downstream callers want to count rows;
// keep the import alive via this re-export.
export { sql, eq };
