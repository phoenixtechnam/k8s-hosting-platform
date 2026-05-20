/**
 * Integration tests for backup-rclone-shim against a real Postgres
 * (R-X5). Skipped when DATABASE_URL is unreachable (local dev w/o DB).
 *
 * Asserted properties:
 *
 *   1. Migration 0017 lands the `drain_timeout_seconds` column with
 *      the 300 default + CHECK [30..1800] guard.
 *   2. `listCurrentShimAssignments` emits one row per shim class,
 *      defaulting to `targetId: null` when nothing is bound.
 *   3. `writeAssignment` (called via `applyShimAssignmentChange` with
 *      mocked k8s) replaces the binding atomically.
 *   4. `snapshotInflightShimConsumers` counts only `queued|running`
 *      tasks with `cleared_at IS NULL`, grouped per kind.
 *
 * The k8s SDK is mocked at the granularity of one fake DaemonSet read
 * — we don't spin up a kind cluster for unit-level coverage; the
 * `scripts/integration-*` shell harness handles real-cluster checks.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import {
  applyShimAssignmentChange,
  runDrainNow,
} from './apply-assignment.js';
import { listCurrentShimAssignments } from './status.js';
import { snapshotInflightShimConsumers } from './drain.js';

const db = getTestDb();
const dbAvailable = await isDbAvailable();

// Skip every test below when no Postgres is reachable.
const D = describe.skipIf(!dbAvailable);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function insertTarget(
  name: string,
  drainTimeoutSeconds: number = 300,
  enabled: boolean = true,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO backup_configurations (
      id, name, "storageType", retention_days, schedule_expression,
      enabled, active, drain_timeout_seconds, created_at, updated_at
    ) VALUES (
      ${id}, ${name}, 's3', 30, '0 2 * * *',
      ${enabled ? 1 : 0}, false, ${drainTimeoutSeconds}, NOW(), NOW()
    )
  `);
  return id;
}

async function insertTask(
  kind: string,
  status: 'queued' | 'running' | 'succeeded' = 'running',
  cleared: boolean = false,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO tasks (
      id, kind, ref_id, scope, user_id, label, status, target,
      started_at, updated_at, cleared_at
    ) VALUES (
      ${id}, ${kind}, ${id}, 'system', NULL, ${`integration-test-${kind}`}, ${status},
      ${'{"type":"modal","modal":"x","modalProps":{}}'}::jsonb,
      NOW(), NOW(), ${cleared ? sql`NOW()` : sql`NULL`}
    )
  `);
  return id;
}

function fakeK8sClients() {
  return {
    core: {
      // The reconciler reads the BACKUP_TARGET_KEY Secret. Return 404
      // so the orchestrator surfaces SHIM_KEY_MISSING — we just want
      // the DB write + drain path validated here.
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
      readNamespacedConfigMap: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedConfigMap: vi.fn(),
      patchNamespacedConfigMap: vi.fn(),
      createNamespacedSecret: vi.fn(),
      patchNamespacedSecret: vi.fn(),
    },
    apps: {
      patchNamespacedDaemonSet: vi.fn().mockResolvedValue({}),
      readNamespacedDaemonSet: vi.fn().mockResolvedValue({
        status: { desiredNumberScheduled: 1, updatedNumberScheduled: 1, numberAvailable: 1 },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

D('backup-rclone-shim integration', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM backup_target_assignments`);
    await db.execute(sql`DELETE FROM backup_configurations WHERE name LIKE 'rx5-test-%'`);
    // Per-test cleanup. SQL `AND` binds tighter than `OR`, so without
    // explicit parens the ref_id arms would delete production rows
    // unrelated to our test fixtures — caught in code review.
    await db.execute(sql`
      DELETE FROM tasks
       WHERE (kind = ANY(ARRAY[
                'backup.run', 'backup.bundle', 'mail.archive',
                'backup.shim.target-switch', 'backup.shim.drain'
              ])
              AND (label LIKE 'integration-test-%'
                   OR ref_id LIKE 'shim:%'
                   OR ref_id LIKE 'drain:%'))
    `);
  });

  // ─── migration 0017 ───────────────────────────────────────────────
  describe('migration 0017', () => {
    it('lands drain_timeout_seconds column with default 300', async () => {
      const tid = await insertTarget('rx5-test-default');
      const [row] = await db.execute<{ drain_timeout_seconds: number }>(sql`
        SELECT drain_timeout_seconds FROM backup_configurations WHERE id = ${tid}
      `).then((r) => r.rows ?? []);
      expect(row?.drain_timeout_seconds).toBe(300);
    });

    it('rejects values below 30 via CHECK constraint', async () => {
      await expect(insertTarget('rx5-test-low', 10)).rejects.toThrow();
    });

    it('rejects values above 1800 via CHECK constraint', async () => {
      await expect(insertTarget('rx5-test-high', 5000)).rejects.toThrow();
    });

    it('accepts boundary values 30 and 1800', async () => {
      await insertTarget('rx5-test-min', 30);
      await insertTarget('rx5-test-max', 1800);
    });
  });

  // ─── listCurrentShimAssignments ──────────────────────────────────
  describe('listCurrentShimAssignments', () => {
    it('emits three rows (one per shim class) with targetId=null when nothing is bound', async () => {
      const rows = await listCurrentShimAssignments(db);
      expect(rows).toHaveLength(3);
      const byClass = new Map(rows.map((r) => [r.className, r]));
      expect(byClass.get('system')?.targetId).toBeNull();
      expect(byClass.get('tenant')?.targetId).toBeNull();
      expect(byClass.get('mail')?.targetId).toBeNull();
    });

    it('reflects an inserted binding via the new assignment table', async () => {
      const targetId = await insertTarget('rx5-test-sys-binding');
      await db.execute(sql`
        INSERT INTO backup_target_assignments (snapshot_class, target_id, priority)
        VALUES ('system', ${targetId}, 0)
      `);
      const rows = await listCurrentShimAssignments(db);
      const system = rows.find((r) => r.className === 'system');
      expect(system?.targetId).toBe(targetId);
      expect(system?.targetStorageType).toBe('s3');
      expect(system?.drainTimeoutSeconds).toBe(300);
    });
  });

  // ─── snapshotInflightShimConsumers (drain query) ──────────────────
  describe('snapshotInflightShimConsumers', () => {
    it('returns 0 when no inflight rows', async () => {
      const snap = await snapshotInflightShimConsumers(db);
      expect(snap.total).toBe(0);
    });

    it('counts queued+running rows; excludes succeeded + cleared', async () => {
      await insertTask('backup.run', 'queued');
      await insertTask('backup.run', 'running');
      await insertTask('backup.run', 'succeeded'); // excluded
      await insertTask('mail.archive', 'running', /* cleared */ true); // excluded
      const snap = await snapshotInflightShimConsumers(db);
      expect(snap.total).toBe(2);
      expect(snap.samples).toEqual([
        { kind: 'backup.run', count: 2 },
      ]);
    });

    it('class filter excludes other-class kinds', async () => {
      await insertTask('backup.run', 'running'); // system
      await insertTask('backup.bundle', 'running'); // tenant
      await insertTask('mail.archive', 'running'); // mail
      const sys = await snapshotInflightShimConsumers(db, ['system']);
      expect(sys.total).toBe(1);
      const mail = await snapshotInflightShimConsumers(db, ['mail']);
      expect(mail.total).toBe(1);
    });
  });

  // ─── applyShimAssignmentChange — DB-side observable effects ──────
  describe('applyShimAssignmentChange', () => {
    it('writes the binding row + finishes the tracked task', async () => {
      const userId = crypto.randomUUID();
      // Insert the user since tasks.user_id has an FK constraint
      // (notifications too). We bypass full auth by inserting directly.
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
        VALUES (${userId}, ${`rx5-${userId}@test`}, '$2a$10$x', 'super_admin', NOW(), NOW())
      `);
      const targetId = await insertTarget('rx5-test-apply');
      const k8s = fakeK8sClients();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const result = await applyShimAssignmentChange(
        {
          db,
          k8s: k8s as never,
          encryptionKey: '0'.repeat(64),
          log,
          // Skip the drain wait by force-bypass (no inflight anyway)
          // — the drain primitive is unit-tested elsewhere.
          drainSleep: async () => {},
          verifySleep: async () => {},
          verifyTimeoutMs: 100,
        },
        {
          className: 'tenant',
          targetId,
          force: false,
          userId,
        },
      );
      expect(result.assignment.className).toBe('tenant');
      expect(result.assignment.targetId).toBe(targetId);
      expect(result.assignment.targetStorageType).toBe('s3');
      // DB row must exist after success.
      const rows = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
          FROM backup_target_assignments
         WHERE snapshot_class = 'tenant' AND target_id = ${targetId}
      `);
      expect(rows.rows?.[0]?.count).toBe('1');
      // Task must be marked succeeded.
      const taskRows = await db.execute<{ status: string }>(sql`
        SELECT status FROM tasks WHERE id = ${result.taskId}
      `);
      expect(taskRows.rows?.[0]?.status).toBe('succeeded');
      // Drain phase was drain_immediate (no inflight).
      expect(result.drain.phase).toBe('drain_immediate');
    });

    it('targetId=null replace-sets to empty (unassign)', async () => {
      const userId = crypto.randomUUID();
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
        VALUES (${userId}, ${`rx5-${userId}@test`}, '$2a$10$x', 'super_admin', NOW(), NOW())
      `);
      const targetId = await insertTarget('rx5-test-unassign');
      await db.execute(sql`
        INSERT INTO backup_target_assignments (snapshot_class, target_id, priority)
        VALUES ('mail', ${targetId}, 0)
      `);
      const result = await applyShimAssignmentChange(
        {
          db,
          k8s: fakeK8sClients() as never,
          encryptionKey: '0'.repeat(64),
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          drainSleep: async () => {},
          verifySleep: async () => {},
          verifyTimeoutMs: 100,
        },
        { className: 'mail', targetId: null, force: false, userId },
      );
      expect(result.assignment.targetId).toBeNull();
      const rows = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count
          FROM backup_target_assignments
         WHERE snapshot_class = 'mail'
      `);
      expect(rows.rows?.[0]?.count).toBe('0');
    });

    it('rejects disabled target with TARGET_DISABLED', async () => {
      const userId = crypto.randomUUID();
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
        VALUES (${userId}, ${`rx5-${userId}@test`}, '$2a$10$x', 'super_admin', NOW(), NOW())
      `);
      const targetId = await insertTarget('rx5-test-disabled', 300, false);
      await expect(
        applyShimAssignmentChange(
          {
            db,
            k8s: fakeK8sClients() as never,
            encryptionKey: '0'.repeat(64),
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          },
          { className: 'system', targetId, force: false, userId },
        ),
      ).rejects.toMatchObject({ code: 'TARGET_DISABLED' });
    });

    it('rejects unknown target with TARGET_NOT_FOUND', async () => {
      const userId = crypto.randomUUID();
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
        VALUES (${userId}, ${`rx5-${userId}@test`}, '$2a$10$x', 'super_admin', NOW(), NOW())
      `);
      await expect(
        applyShimAssignmentChange(
          {
            db,
            k8s: fakeK8sClients() as never,
            encryptionKey: '0'.repeat(64),
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          },
          {
            className: 'system',
            targetId: crypto.randomUUID(),
            force: false,
            userId,
          },
        ),
      ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' });
    });
  });

  // ─── runDrainNow (operator escape hatch) ──────────────────────────
  describe('runDrainNow', () => {
    it('returns immediately with drain_immediate when no inflight', async () => {
      const userId = crypto.randomUUID();
      await db.execute(sql`
        INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
        VALUES (${userId}, ${`rx5-${userId}@test`}, '$2a$10$x', 'super_admin', NOW(), NOW())
      `);
      const out = await runDrainNow(
        {
          db,
          log: { info: vi.fn(), warn: vi.fn() },
        },
        { classes: [], userId },
      );
      expect(out.drain.phase).toBe('drain_immediate');
      expect(out.drain.drained).toBe(true);
      const taskRows = await db.execute<{ status: string }>(sql`
        SELECT status FROM tasks WHERE id = ${out.taskId}
      `);
      expect(taskRows.rows?.[0]?.status).toBe('succeeded');
    });
  });
});
