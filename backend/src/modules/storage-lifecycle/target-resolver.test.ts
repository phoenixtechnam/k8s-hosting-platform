import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { resolveTargetFor, maybeResolveTargetFor } from './target-resolver.js';
import { setAssignments } from '../snapshot-classes/service.js';

const db = getTestDb();
const dbAvailable = await isDbAvailable();

async function insertTarget(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO backup_configurations (id, name, "storageType", retention_days, schedule_expression, enabled, active, created_at, updated_at)
    VALUES (${id}, ${name}, 's3', 30, '0 2 * * *', 1, false, NOW(), NOW())
  `);
  return id;
}

describe.skipIf(!dbAvailable)('target-resolver', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM backup_target_assignments`);
    await db.execute(sql`DELETE FROM backup_configurations WHERE name LIKE 'tr-test-%'`);
  });

  it('resolveTargetFor returns assigned primary', async () => {
    const t1 = await insertTarget('tr-test-a');
    await setAssignments(db, 'tenant_snapshot', {
      assignments: [{ targetId: t1, priority: 100 }],
    });

    const resolved = await resolveTargetFor(db, 'tenant_snapshot');
    expect(resolved.targetId).toBe(t1);
    expect(resolved.targetName).toBe('tr-test-a');
    expect(resolved.targetStorageType).toBe('s3');
    expect(resolved.snapshotClass).toBe('tenant_snapshot');
  });

  it('resolveTargetFor throws NO_SNAPSHOT_TARGET when unassigned', async () => {
    await expect(resolveTargetFor(db, 'tenant_snapshot')).rejects.toMatchObject({
      code: 'NO_SNAPSHOT_TARGET',
      status: 409,
    });
  });

  it('resolveTargetFor picks lowest priority when multiple targets', async () => {
    const tA = await insertTarget('tr-test-a');
    const tB = await insertTarget('tr-test-b');
    const tC = await insertTarget('tr-test-c');
    await setAssignments(db, 'system_etcd', {
      assignments: [
        { targetId: tA, priority: 300 },
        { targetId: tB, priority: 50 },
        { targetId: tC, priority: 200 },
      ],
    });

    const resolved = await resolveTargetFor(db, 'system_etcd');
    expect(resolved.targetId).toBe(tB);
    expect(resolved.targetName).toBe('tr-test-b');
  });

  it('maybeResolveTargetFor returns null instead of throwing when unassigned', async () => {
    const result = await maybeResolveTargetFor(db, 'tenant_bundle');
    expect(result).toBeNull();
  });

  it('maybeResolveTargetFor returns target when assigned', async () => {
    const t1 = await insertTarget('tr-test-maybe');
    await setAssignments(db, 'system_secrets', {
      assignments: [{ targetId: t1, priority: 100 }],
    });

    const result = await maybeResolveTargetFor(db, 'system_secrets');
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe(t1);
  });

  it('each class resolves independently', async () => {
    const tA = await insertTarget('tr-test-x');
    const tB = await insertTarget('tr-test-y');
    await setAssignments(db, 'tenant_snapshot', { assignments: [{ targetId: tA, priority: 100 }] });
    await setAssignments(db, 'system_etcd', { assignments: [{ targetId: tB, priority: 100 }] });

    const r1 = await resolveTargetFor(db, 'tenant_snapshot');
    const r2 = await resolveTargetFor(db, 'system_etcd');
    expect(r1.targetId).toBe(tA);
    expect(r2.targetId).toBe(tB);
  });
});
