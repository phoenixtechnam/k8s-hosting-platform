// Snapshot accountability aggregates (Phase 1 of snapshot-storage overhaul).
//
// Read-only — sums per-tenant + per-class + per-subsystem rows out of
// storage_snapshots so the admin UI can show "who wrote what, when,
// how much". Phase 6 will add a quota-fill column once
// hosting_plans.max_snapshot_size_bytes lands.
//
// One transactional snapshot of the DB per call (3 aggregate queries
// at most). Cached at the route layer (TanStack Query) — no need for
// an in-memory cache here.

import { sql, eq, desc, inArray } from 'drizzle-orm';
import { storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type {
  SnapshotAccountingResponse,
  SnapshotClassAggregate,
  TenantSnapshotAggregate,
} from '@k8s-hosting/api-contracts';

const TOP_TENANTS_LIMIT = 100;

// Raw SQL aggregations via Drizzle return timestamp columns as ISO
// strings (node-postgres typecast for unbound `sql<...>` projections),
// not Date instances. Keep that explicit so we don't accidentally call
// .toISOString() on a string and 500 the route.
type TimestampLike = string | Date | null;

interface ClassRow {
  snapshotClass: string;
  subsystem: string;
  totalCount: number;
  totalBytes: string; // numeric → string from pg driver
  lastSnapshotAt: TimestampLike;
  lastReadyAt: TimestampLike;
}

interface TenantRow {
  tenantId: string;
  tenantName: string;
  totalCount: number;
  totalBytes: string;
  lastSnapshotAt: TimestampLike;
}

interface TenantClassBreakdownRow {
  tenantId: string;
  snapshotClass: string;
  count: number;
  bytes: string;
}

function toIso(value: TimestampLike): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // node-postgres serialises timestamps as 'YYYY-MM-DD HH:MM:SS.SSS' —
  // round-trip through Date so the response always emits proper ISO-8601.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Sum every snapshot row, grouped by (snapshot_class, subsystem), with
 * count, total bytes, and most-recent timestamps. Excludes status='failed'
 * from the byte total — failed snapshots stop short of a final size and
 * would distort accounting.
 */
async function loadClassAggregates(db: Database): Promise<SnapshotClassAggregate[]> {
  const rows = (await db
    .select({
      snapshotClass: storageSnapshots.snapshotClass,
      subsystem: storageSnapshots.subsystem,
      totalCount: sql<number>`COUNT(*)::int`,
      totalBytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
      lastSnapshotAt: sql<TimestampLike>`MAX(${storageSnapshots.createdAt})`,
      lastReadyAt: sql<TimestampLike>`MAX(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.createdAt} END)`,
    })
    .from(storageSnapshots)
    .groupBy(storageSnapshots.snapshotClass, storageSnapshots.subsystem)) as ClassRow[];

  return rows.map((r) => ({
    snapshotClass: r.snapshotClass,
    subsystem: r.subsystem,
    totalCount: r.totalCount,
    totalBytes: Number(r.totalBytes),
    lastSnapshotAt: toIso(r.lastSnapshotAt),
    lastReadyAt: toIso(r.lastReadyAt),
  }));
}

/**
 * Top-N tenants by total snapshot bytes (status='ready' only). Joined
 * against `tenants.name` so the UI doesn't need a second roundtrip per
 * row. Pulls a second query for the per-class breakdown — Drizzle can't
 * express jsonb_agg cleanly without raw SQL, and two small queries are
 * easier to reason about than one with a CTE.
 */
async function loadTopTenants(db: Database): Promise<TenantSnapshotAggregate[]> {
  const tenantRows = (await db
    .select({
      tenantId: storageSnapshots.tenantId,
      tenantName: tenants.name,
      totalCount: sql<number>`COUNT(*)::int`,
      totalBytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
      lastSnapshotAt: sql<TimestampLike>`MAX(${storageSnapshots.createdAt})`,
    })
    .from(storageSnapshots)
    .innerJoin(tenants, eq(storageSnapshots.tenantId, tenants.id))
    .groupBy(storageSnapshots.tenantId, tenants.name)
    .orderBy(desc(sql`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)`))
    .limit(TOP_TENANTS_LIMIT)) as TenantRow[];

  if (tenantRows.length === 0) return [];

  const tenantIds = tenantRows.map((r) => r.tenantId);
  const breakdownRows = (await db
    .select({
      tenantId: storageSnapshots.tenantId,
      snapshotClass: storageSnapshots.snapshotClass,
      count: sql<number>`COUNT(*)::int`,
      bytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
    })
    .from(storageSnapshots)
    .where(inArray(storageSnapshots.tenantId, tenantIds))
    .groupBy(storageSnapshots.tenantId, storageSnapshots.snapshotClass)) as TenantClassBreakdownRow[];

  const breakdownByTenant = new Map<string, TenantSnapshotAggregate['byClass']>();
  for (const row of breakdownRows) {
    const list = breakdownByTenant.get(row.tenantId) ?? [];
    list.push({
      snapshotClass: row.snapshotClass,
      count: row.count,
      bytes: Number(row.bytes),
    });
    breakdownByTenant.set(row.tenantId, list);
  }

  return tenantRows.map((r) => ({
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    totalCount: r.totalCount,
    totalBytes: Number(r.totalBytes),
    lastSnapshotAt: toIso(r.lastSnapshotAt),
    byClass: breakdownByTenant.get(r.tenantId) ?? [],
  }));
}

/**
 * Sum every ready snapshot to a single row. Cheap (one COUNT/SUM).
 */
async function loadGrandTotal(db: Database): Promise<{ count: number; bytes: number }> {
  const rows = (await db
    .select({
      count: sql<number>`COUNT(*)::int`,
      bytes: sql<string>`COALESCE(SUM(CASE WHEN ${storageSnapshots.status} = 'ready' THEN ${storageSnapshots.sizeBytes} ELSE 0 END), 0)::text`,
    })
    .from(storageSnapshots)) as Array<{ count: number; bytes: string }>;

  const row = rows[0] ?? { count: 0, bytes: '0' };
  return { count: row.count, bytes: Number(row.bytes) };
}

export async function loadSnapshotAccounting(db: Database): Promise<SnapshotAccountingResponse> {
  const [byClass, topTenants, total] = await Promise.all([
    loadClassAggregates(db),
    loadTopTenants(db),
    loadGrandTotal(db),
  ]);

  return {
    total,
    byClass,
    topTenants,
    generatedAt: new Date().toISOString(),
  };
}
