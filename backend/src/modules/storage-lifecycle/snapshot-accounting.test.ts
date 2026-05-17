import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { loadSnapshotAccounting } from './snapshot-accounting.js';

const db = getTestDb();
const dbAvailable = await isDbAvailable();

// Migration 0003 added subsystem + snapshot_class columns. Tests below
// exercise the aggregation paths (per-class, per-tenant, totals) using
// the column defaults plus explicit overrides for new subsystems.

async function insertTenant(tenantId: string, name: string): Promise<void> {
  // Plan + region rows are FK targets — reuse whatever the migrations
  // seeded. If they're missing we synthesise minimal rows.
  await db.execute(sql`
    INSERT INTO regions (id, code, name, created_at)
    VALUES ('region-test', 'test', 'Test', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO hosting_plans (id, code, name, cpu_limit, memory_limit, storage_limit, monthly_price_usd, max_sub_users, status, created_at)
    VALUES ('plan-test', 'test', 'Test', 1, 1, 1, 0, 1, 'active', NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO tenants (id, region_id, name, primary_email, status, kubernetes_namespace, plan_id, created_at, updated_at)
    VALUES (${tenantId}, 'region-test', ${name}, ${`${name}@test`}, 'active', ${`ns-${tenantId.slice(0, 8)}`}, 'plan-test', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertSnapshot(opts: {
  tenantId: string;
  status: string;
  sizeBytes: number;
  snapshotClass?: string;
  subsystem?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO storage_snapshots (
      id, tenant_id, kind, status, archive_path, size_bytes, sha256,
      subsystem, snapshot_class, created_at, updated_at
    ) VALUES (
      ${id}, ${opts.tenantId}, 'manual', ${opts.status}, ${`${opts.tenantId}/${id}.tar.gz`},
      ${String(opts.sizeBytes)}, NULL,
      ${opts.subsystem ?? 'tenant-pvc'},
      ${opts.snapshotClass ?? 'tenant_snapshot'},
      NOW(), NOW()
    )
  `);
  return id;
}

describe.skipIf(!dbAvailable)('loadSnapshotAccounting', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM storage_snapshots`);
    await db.execute(sql`DELETE FROM tenants WHERE id LIKE 'tnt-%'`);
  });

  it('returns empty aggregates when no snapshots exist', async () => {
    const result = await loadSnapshotAccounting(db);
    expect(result.total).toEqual({ count: 0, bytes: 0 });
    expect(result.byClass).toEqual([]);
    expect(result.topTenants).toEqual([]);
    expect(typeof result.generatedAt).toBe('string');
  });

  it('sums ready snapshots only — failed rows contribute count but not bytes', async () => {
    await insertTenant('tnt-acme', 'Acme');
    await insertSnapshot({ tenantId: 'tnt-acme', status: 'ready', sizeBytes: 1000 });
    await insertSnapshot({ tenantId: 'tnt-acme', status: 'ready', sizeBytes: 2000 });
    await insertSnapshot({ tenantId: 'tnt-acme', status: 'failed', sizeBytes: 5000 });

    const result = await loadSnapshotAccounting(db);
    // count is total rows; bytes excludes non-ready (sums to 3000 not 8000)
    expect(result.total).toEqual({ count: 3, bytes: 3000 });
    expect(result.byClass).toHaveLength(1);
    expect(result.byClass[0]).toMatchObject({
      snapshotClass: 'tenant_snapshot',
      subsystem: 'tenant-pvc',
      totalCount: 3,
      totalBytes: 3000,
    });
  });

  it('groups rows by (snapshot_class, subsystem)', async () => {
    await insertTenant('tnt-acme', 'Acme');
    await insertSnapshot({ tenantId: 'tnt-acme', status: 'ready', sizeBytes: 100 });
    await insertSnapshot({
      tenantId: 'tnt-acme',
      status: 'ready',
      sizeBytes: 200,
      snapshotClass: 'system_snapshot',
      subsystem: 'system-etcd',
    });
    await insertSnapshot({
      tenantId: 'tnt-acme',
      status: 'ready',
      sizeBytes: 400,
      snapshotClass: 'system_snapshot',
      subsystem: 'system-etcd',
    });

    const result = await loadSnapshotAccounting(db);
    expect(result.byClass).toHaveLength(2);
    const tenant = result.byClass.find((r) => r.snapshotClass === 'tenant_snapshot');
    const system = result.byClass.find((r) => r.snapshotClass === 'system_snapshot');
    expect(tenant).toMatchObject({ subsystem: 'tenant-pvc', totalCount: 1, totalBytes: 100 });
    expect(system).toMatchObject({ subsystem: 'system-etcd', totalCount: 2, totalBytes: 600 });
  });

  it('orders top tenants by total ready bytes DESC', async () => {
    await insertTenant('tnt-aaa', 'AAA');
    await insertTenant('tnt-bbb', 'BBB');
    await insertTenant('tnt-ccc', 'CCC');
    await insertSnapshot({ tenantId: 'tnt-aaa', status: 'ready', sizeBytes: 1000 });
    await insertSnapshot({ tenantId: 'tnt-bbb', status: 'ready', sizeBytes: 5000 });
    await insertSnapshot({ tenantId: 'tnt-ccc', status: 'ready', sizeBytes: 3000 });

    const result = await loadSnapshotAccounting(db);
    expect(result.topTenants).toHaveLength(3);
    expect(result.topTenants[0].tenantName).toBe('BBB');
    expect(result.topTenants[1].tenantName).toBe('CCC');
    expect(result.topTenants[2].tenantName).toBe('AAA');
  });

  it('breaks down a tenant by class', async () => {
    await insertTenant('tnt-multi', 'Multi-class');
    await insertSnapshot({ tenantId: 'tnt-multi', status: 'ready', sizeBytes: 100 });
    await insertSnapshot({
      tenantId: 'tnt-multi',
      status: 'ready',
      sizeBytes: 200,
      snapshotClass: 'tenant_bundle',
      subsystem: 'mail-rocksdb',
    });

    const result = await loadSnapshotAccounting(db);
    expect(result.topTenants).toHaveLength(1);
    const breakdown = result.topTenants[0].byClass;
    expect(breakdown).toHaveLength(2);
    const tenantSnap = breakdown.find((b) => b.snapshotClass === 'tenant_snapshot');
    const tenantBundle = breakdown.find((b) => b.snapshotClass === 'tenant_bundle');
    expect(tenantSnap).toEqual({ snapshotClass: 'tenant_snapshot', count: 1, bytes: 100 });
    expect(tenantBundle).toEqual({ snapshotClass: 'tenant_bundle', count: 1, bytes: 200 });
  });

  it('reports lastReadyAt distinct from lastSnapshotAt when only failed rows are recent', async () => {
    await insertTenant('tnt-recent', 'Recent');
    // Older ready row
    const oldReadyId = await insertSnapshot({ tenantId: 'tnt-recent', status: 'ready', sizeBytes: 100 });
    await db.execute(sql`UPDATE storage_snapshots SET created_at = NOW() - INTERVAL '1 day' WHERE id = ${oldReadyId}`);
    // Newer failed row
    await insertSnapshot({ tenantId: 'tnt-recent', status: 'failed', sizeBytes: 0 });

    const result = await loadSnapshotAccounting(db);
    const row = result.byClass[0];
    expect(row.lastSnapshotAt).not.toBeNull();
    expect(row.lastReadyAt).not.toBeNull();
    // lastSnapshotAt (failed row) > lastReadyAt (older ready row)
    expect(new Date(row.lastSnapshotAt!).getTime()).toBeGreaterThan(new Date(row.lastReadyAt!).getTime());
  });
});
