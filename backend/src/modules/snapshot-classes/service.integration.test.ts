import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import {
  listClasses,
  setAssignments,
  resolvePrimaryTarget,
  getTargetAssignmentsSummary,
  getAllTargetAssignmentsSummaries,
} from './service.js';

const db = getTestDb();
const dbAvailable = await isDbAvailable();

async function insertTarget(name: string, storageType: 's3' | 'ssh' = 's3'): Promise<string> {
  const id = crypto.randomUUID();
  // The column is quoted "storageType" in the migration (camelCase
  // emitted by drizzle-kit from the Drizzle schema's `storageType:`
  // declaration without an explicit column name). Wrap in double
  // quotes here so Postgres treats it as a case-sensitive identifier
  // matching the actual column name.
  await db.execute(sql`
    INSERT INTO backup_configurations (id, name, "storageType", retention_days, schedule_expression, enabled, active, created_at, updated_at)
    VALUES (${id}, ${name}, ${storageType}, 30, '0 2 * * *', 1, false, NOW(), NOW())
  `);
  return id;
}

describe.skipIf(!dbAvailable)('snapshot-classes service', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM backup_target_assignments`);
    await db.execute(sql`DELETE FROM backup_configurations WHERE name LIKE 'test-%'`);
  });

  it('listClasses returns all 5 classes with empty assignments by default', async () => {
    const result = await listClasses(db);
    expect(result.classes).toHaveLength(5);
    const names = result.classes.map((c) => c.snapshotClass).sort();
    expect(names).toEqual([
      'system_etcd',
      'system_secrets',
      'system_snapshot',
      'tenant_bundle',
      'tenant_snapshot',
    ]);
    for (const c of result.classes) {
      expect(c.assignments).toEqual([]);
    }
  });

  it('setAssignments replaces the set for a class', async () => {
    const t1 = await insertTarget('test-s3-a');
    const t2 = await insertTarget('test-s3-b');

    const r1 = await setAssignments(db, 'tenant_snapshot', {
      assignments: [
        { targetId: t1, priority: 100 },
        { targetId: t2, priority: 200 },
      ],
    });
    expect(r1.snapshotClass).toBe('tenant_snapshot');
    expect(r1.assignments).toHaveLength(2);
    expect(r1.assignments[0].priority).toBe(100);
    expect(r1.assignments[0].targetName).toBe('test-s3-a');
    expect(r1.assignments[1].priority).toBe(200);

    // Replace with just t2 — t1 must vanish.
    const r2 = await setAssignments(db, 'tenant_snapshot', {
      assignments: [{ targetId: t2, priority: 100 }],
    });
    expect(r2.assignments).toHaveLength(1);
    expect(r2.assignments[0].targetId).toBe(t2);
  });

  it('setAssignments rejects duplicate target_ids', async () => {
    const t1 = await insertTarget('test-dup');
    // ApiError carries the symbolic code on `.code`, not the message.
    // Earlier version of this test grepped the message for the code
    // string, which was never present — message is operator-friendly.
    await expect(
      setAssignments(db, 'tenant_snapshot', {
        assignments: [
          { targetId: t1, priority: 100 },
          { targetId: t1, priority: 200 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_TARGET' });
  });

  it('setAssignments rejects duplicate priorities', async () => {
    const t1 = await insertTarget('test-a');
    const t2 = await insertTarget('test-b');
    await expect(
      setAssignments(db, 'tenant_snapshot', {
        assignments: [
          { targetId: t1, priority: 100 },
          { targetId: t2, priority: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_PRIORITY' });
  });

  it('setAssignments rejects non-existent target_id', async () => {
    const fake = crypto.randomUUID();
    await expect(
      setAssignments(db, 'tenant_snapshot', {
        assignments: [{ targetId: fake, priority: 100 }],
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
  });

  it('setAssignments with empty array clears the class', async () => {
    const t1 = await insertTarget('test-clear');
    await setAssignments(db, 'system_etcd', {
      assignments: [{ targetId: t1, priority: 100 }],
    });
    const cleared = await setAssignments(db, 'system_etcd', { assignments: [] });
    expect(cleared.assignments).toEqual([]);
  });

  it('resolvePrimaryTarget picks the lowest-priority assignment', async () => {
    const tA = await insertTarget('test-prio-a');
    const tB = await insertTarget('test-prio-b');
    const tC = await insertTarget('test-prio-c');

    await setAssignments(db, 'tenant_bundle', {
      assignments: [
        { targetId: tA, priority: 200 },
        { targetId: tB, priority: 50 },
        { targetId: tC, priority: 300 },
      ],
    });

    const primary = await resolvePrimaryTarget(db, 'tenant_bundle');
    expect(primary).not.toBeNull();
    expect(primary!.targetId).toBe(tB);
    expect(primary!.targetName).toBe('test-prio-b');
  });

  it('resolvePrimaryTarget returns null when no assignment exists', async () => {
    const primary = await resolvePrimaryTarget(db, 'system_secrets');
    expect(primary).toBeNull();
  });

  it('getTargetAssignmentsSummary lists classes routed to a target', async () => {
    const t1 = await insertTarget('test-summary');
    await setAssignments(db, 'tenant_snapshot', { assignments: [{ targetId: t1, priority: 100 }] });
    await setAssignments(db, 'system_etcd', { assignments: [{ targetId: t1, priority: 200 }] });

    const summary = await getTargetAssignmentsSummary(db, t1);
    expect(summary.targetId).toBe(t1);
    expect(summary.classes).toHaveLength(2);
    const classes = summary.classes.map((c) => c.snapshotClass).sort();
    expect(classes).toEqual(['system_etcd', 'tenant_snapshot']);
  });

  it('getAllTargetAssignmentsSummaries groups by target', async () => {
    const t1 = await insertTarget('test-bulk-a');
    const t2 = await insertTarget('test-bulk-b');
    await setAssignments(db, 'tenant_snapshot', { assignments: [{ targetId: t1, priority: 100 }] });
    await setAssignments(db, 'tenant_bundle', { assignments: [{ targetId: t2, priority: 100 }] });

    const summaries = await getAllTargetAssignmentsSummaries(db);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
    const byId = new Map(summaries.map((s) => [s.targetId, s]));
    expect(byId.get(t1)!.classes).toEqual([{ snapshotClass: 'tenant_snapshot', priority: 100 }]);
    expect(byId.get(t2)!.classes).toEqual([{ snapshotClass: 'tenant_bundle', priority: 100 }]);
  });

  it('ON DELETE RESTRICT prevents deleting a target that is still assigned', async () => {
    const t1 = await insertTarget('test-restrict');
    await setAssignments(db, 'tenant_snapshot', { assignments: [{ targetId: t1, priority: 100 }] });

    await expect(
      db.execute(sql`DELETE FROM backup_configurations WHERE id = ${t1}`),
    ).rejects.toThrow();

    // After reassigning, the delete should succeed.
    await setAssignments(db, 'tenant_snapshot', { assignments: [] });
    await db.execute(sql`DELETE FROM backup_configurations WHERE id = ${t1}`);
  });
});
