import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { tenants } from '../../db/schema.js';
import { updateTenant, deleteTenant } from '../tenants/service.js';
import { bulkUpdateTenantStatus, bulkDeleteTenants } from '../tenants/bulk.js';
import { suspendExpiredTenants } from '../subscriptions/expiry-checker.js';
import { ensureSystemTenant } from './service.js';

const dbAvailable = await isDbAvailable();
const TEST_APEX = 'guard-platform.example';

describe.skipIf(!dbAvailable)('SYSTEM tenant guards (integration)', () => {
  let systemTenantId: string;
  let normalTenantId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    await db.execute(sql.raw('TRUNCATE TABLE system_settings CASCADE'));
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const sys = await ensureSystemTenant(db, TEST_APEX);
    systemTenantId = sys.tenantId;
    const normal = await seedTenant(db, region.id, plan.id);
    normalTenantId = normal.id;
  });

  describe('updateTenant', () => {
    it('rejects status=suspended on SYSTEM with SYSTEM_TENANT_PROTECTED', async () => {
      const db = getTestDb();
      await expect(
        updateTenant(db, systemTenantId, { status: 'suspended' }),
      ).rejects.toMatchObject({ code: 'SYSTEM_TENANT_PROTECTED', status: 409 });
    });

    it('rejects status=archived on SYSTEM with SYSTEM_TENANT_PROTECTED', async () => {
      const db = getTestDb();
      await expect(
        updateTenant(db, systemTenantId, { status: 'archived' }),
      ).rejects.toMatchObject({ code: 'SYSTEM_TENANT_PROTECTED', status: 409 });
    });

    it('rejects subscription_expires_at writes on SYSTEM', async () => {
      const db = getTestDb();
      await expect(
        updateTenant(db, systemTenantId, {
          subscription_expires_at: new Date(Date.now() - 1000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'SYSTEM_TENANT_PROTECTED', status: 409 });
    });

    it('rejects status=pending on SYSTEM (review HIGH #2 — catch-all guard)', async () => {
      const db = getTestDb();
      // 'pending' is a valid tenantStatusEnum value but the lifecycle
      // hook only blocks suspended/archived/deleted. Without the
      // catch-all `input.status !== 'active'` guard, a PATCH to
      // 'pending' would silently move SYSTEM out of 'active' and the
      // lifecycle cron's status-driven cleanups would never undo it.
      await expect(
        updateTenant(db, systemTenantId, { status: 'pending' as never }),
      ).rejects.toMatchObject({ code: 'SYSTEM_TENANT_PROTECTED', status: 409 });
    });

    it('allows redundant status=active PATCH on SYSTEM (no-op)', async () => {
      const db = getTestDb();
      // status:active is the only non-undefined status that should NOT
      // trip the guard — it's a no-op since SYSTEM is already active.
      const result = await updateTenant(db, systemTenantId, { status: 'active' });
      expect(result.status).toBe('active');
    });

    it('allows benign edits on SYSTEM (max_mailboxes_override)', async () => {
      const db = getTestDb();
      const result = await updateTenant(db, systemTenantId, {
        max_mailboxes_override: 20,
      });
      expect(result.maxMailboxesOverride).toBe(20);
    });

    it('allows status=suspended / archived on a normal tenant', async () => {
      const db = getTestDb();
      // updateTenant routes suspend through the lifecycle orchestrator
      // — but with no k8s in the test path it returns early when the
      // orchestrator is unavailable. We assert the guard does NOT fire
      // by checking that the call doesn't throw SYSTEM_TENANT_PROTECTED.
      try {
        await updateTenant(db, normalTenantId, { status: 'suspended' });
      } catch (err) {
        const apiErr = err as { code?: string };
        // Only verify the guard didn't trip; other errors (k8s missing) are fine.
        expect(apiErr.code).not.toBe('SYSTEM_TENANT_PROTECTED');
      }
    });
  });

  describe('deleteTenant', () => {
    it('rejects deletion of SYSTEM with SYSTEM_TENANT_PROTECTED', async () => {
      const db = getTestDb();
      await expect(
        deleteTenant(db, systemTenantId),
      ).rejects.toMatchObject({ code: 'SYSTEM_TENANT_PROTECTED', status: 409 });
    });

    it('allows deletion of a normal tenant', async () => {
      const db = getTestDb();
      const result = await deleteTenant(db, normalTenantId);
      // With no k8s the unit-test path issues a DB-only delete.
      expect(result.transitionId).toBeNull();
      const remaining = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, normalTenantId));
      expect(remaining).toHaveLength(0);
    });
  });

  describe('bulk operations', () => {
    it('bulk suspend pushes SYSTEM into failed with operator-friendly reason', async () => {
      const db = getTestDb();
      const result = await bulkUpdateTenantStatus(
        db,
        [systemTenantId, normalTenantId],
        'suspend',
        undefined,
        null,
      );
      const blocked = result.failed.find((r) => r.id === systemTenantId);
      expect(blocked).toBeDefined();
      expect(blocked!.error).toMatch(/SYSTEM.*platform-protected/i);
      // Normal tenant should NOT be in failed for the SYSTEM-guard reason
      // (it may still fail for other reasons like missing k8s; we just
      // assert the guard didn't apply to it).
      const normal = result.failed.find((r) => r.id === normalTenantId);
      if (normal) {
        expect(normal.error).not.toMatch(/SYSTEM.*platform-protected/i);
      }
    });

    it('bulk delete pushes SYSTEM into failed with operator-friendly reason', async () => {
      const db = getTestDb();
      const result = await bulkDeleteTenants(
        db,
        [systemTenantId, normalTenantId],
        undefined,
        null,
      );
      const blocked = result.failed.find((r) => r.id === systemTenantId);
      expect(blocked).toBeDefined();
      expect(blocked!.error).toMatch(/SYSTEM.*platform-protected/i);
      // Normal tenant was deleted (DB-only path) — it should NOT be in failed.
      const normal = result.failed.find((r) => r.id === normalTenantId);
      expect(normal).toBeUndefined();
    });
  });

  describe('lifecycle dispatcher integration (system-tenant-guard hook)', () => {
    it('aborts a deleted transition on SYSTEM with failed_blocking state', async () => {
      const db = getTestDb();
      const { _resetRegistryForTests, registerLifecycleHook, runTransition } =
        await import('../tenant-lifecycle/registry/index.js');
      const { systemTenantGuardHook } =
        await import('../tenant-lifecycle/hooks/system-tenant-guard.js');
      // Bypass the module-local _registered flag in the hook file by
      // calling registerLifecycleHook directly — this lets each test
      // register the hook against a freshly-reset registry without
      // tripping the idempotency short-circuit.
      _resetRegistryForTests();
      registerLifecycleHook(systemTenantGuardHook);

      const result = await runTransition(db, {} as never, {
        tenantId: systemTenantId,
        namespace: 'tenant-system',
        transition: 'deleted',
        toStatus: 'deleted',
      });
      expect(result.state).toBe('failed_blocking');
      expect(result.hooksFailed).toBeGreaterThanOrEqual(1);

      // SYSTEM row must still be intact.
      const [row] = await db.select().from(tenants).where(eq(tenants.id, systemTenantId));
      expect(row).toBeDefined();
      expect(row!.isSystem).toBe(true);
      expect(row!.status).toBe('active');
    });

    it('aborts a suspended transition on SYSTEM with failed_blocking state', async () => {
      const db = getTestDb();
      const { _resetRegistryForTests, registerLifecycleHook, runTransition } =
        await import('../tenant-lifecycle/registry/index.js');
      const { systemTenantGuardHook } =
        await import('../tenant-lifecycle/hooks/system-tenant-guard.js');
      // Bypass the module-local _registered flag in the hook file by
      // calling registerLifecycleHook directly — this lets each test
      // register the hook against a freshly-reset registry without
      // tripping the idempotency short-circuit.
      _resetRegistryForTests();
      registerLifecycleHook(systemTenantGuardHook);

      const result = await runTransition(db, {} as never, {
        tenantId: systemTenantId,
        namespace: 'tenant-system',
        transition: 'suspended',
        toStatus: 'suspended',
      });
      expect(result.state).toBe('failed_blocking');
    });

    it('passes through a deleted transition on a normal tenant (noop)', async () => {
      const db = getTestDb();
      const { _resetRegistryForTests, registerLifecycleHook, runTransition } =
        await import('../tenant-lifecycle/registry/index.js');
      const { systemTenantGuardHook } =
        await import('../tenant-lifecycle/hooks/system-tenant-guard.js');
      // Bypass the module-local _registered flag in the hook file by
      // calling registerLifecycleHook directly — this lets each test
      // register the hook against a freshly-reset registry without
      // tripping the idempotency short-circuit.
      _resetRegistryForTests();
      registerLifecycleHook(systemTenantGuardHook);

      const result = await runTransition(db, {} as never, {
        tenantId: normalTenantId,
        namespace: 'tenant-test',
        transition: 'deleted',
        toStatus: 'deleted',
      });
      // Only the guard runs (no other hooks registered); on non-SYSTEM
      // it returns noop, so the transition completes cleanly.
      expect(result.state).toBe('completed');
      expect(result.hooksFailed).toBe(0);
    });
  });

  describe('subscriptions/expiry-checker', () => {
    it('never picks up SYSTEM even with an expired subscriptionExpiresAt', async () => {
      const db = getTestDb();
      // Direct-SQL write: bypass updateTenant guards to simulate
      // operator hand-editing the column. The expiry-checker SQL
      // filter must still exclude SYSTEM.
      await db.update(tenants)
        .set({ subscriptionExpiresAt: new Date(Date.now() - 86_400_000) })
        .where(eq(tenants.id, systemTenantId));

      // Set a process.env.KUBECONFIG_PATH stub so createK8sClients
      // doesn't blow up — the function early-returns 0 when no
      // candidates match (the SYSTEM filter excludes our row), so
      // k8s isn't actually called.
      const count = await suspendExpiredTenants(db).catch(() => 0);
      // Either 0 candidates found, or the function blew up on k8s
      // (acceptable — what we care about is the SYSTEM row's status
      // didn't change to suspended).
      void count;

      const [after] = await db.select({ status: tenants.status })
        .from(tenants).where(eq(tenants.id, systemTenantId));
      expect(after!.status).toBe('active');
    });
  });
});
