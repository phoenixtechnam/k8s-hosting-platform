import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan } from '../../test-helpers/fixtures.js';
import { tenants, domains, users } from '../../db/schema.js';
import { ensureSystemTenant, findSystemTenant, SYSTEM_TENANT_OVERRIDES } from './service.js';
import { bootstrapSystemTenant } from './bootstrap.js';
import { SYSTEM_TENANT_NAMESPACE, systemTenantEmail } from './slug.js';

const dbAvailable = await isDbAvailable();
const TEST_APEX = 'test-platform.example';

describe.skipIf(!dbAvailable)('system-tenant service (integration)', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    // cleanTables() doesn't include system_settings (single-row config
    // table). Clear it explicitly so tests that exercise the
    // settings-driven base-domain resolution start from a known state.
    const db = getTestDb();
    const { sql } = await import('drizzle-orm');
    await db.execute(sql.raw('TRUNCATE TABLE system_settings CASCADE'));
  });

  describe('ensureSystemTenant', () => {
    it('creates SYSTEM tenant with overrides and apex + admin user on a fresh DB', async () => {
      const db = getTestDb();
      await seedRegion(db);
      // Seed multiple plans so the smallest-by-price selector is exercised.
      const cheap = await seedPlan(db, { code: 'cheap-1', monthlyPriceUsd: '3.00' });
      await seedPlan(db, { code: 'mid-1', monthlyPriceUsd: '10.00' });
      await seedPlan(db, { code: 'high-1', monthlyPriceUsd: '50.00' });

      const result = await ensureSystemTenant(db, TEST_APEX);

      expect(result.created).toBe(true);
      expect(result.alreadyExisted).toBe(false);
      expect(result.apexDomainCreated).toBe(true);
      expect(result.adminUserCreated).toBe(true);

      // Verify the row carries the expected shape.
      const [row] = await db.select().from(tenants).where(eq(tenants.id, result.tenantId));
      expect(row).toBeDefined();
      expect(row!.isSystem).toBe(true);
      expect(row!.name).toBe('SYSTEM');
      expect(row!.kubernetesNamespace).toBe(SYSTEM_TENANT_NAMESPACE);
      expect(row!.planId).toBe(cheap.id);
      expect(row!.maxMailboxesOverride).toBe(SYSTEM_TENANT_OVERRIDES.maxMailboxes);
      expect(row!.maxSubUsersOverride).toBe(SYSTEM_TENANT_OVERRIDES.maxSubUsers);
      expect(Number(row!.storageLimitOverride)).toBe(SYSTEM_TENANT_OVERRIDES.storageLimitGiB);
      expect(row!.status).toBe('active');
      expect(row!.provisioningStatus).toBe('unprovisioned');

      // Apex domain row owned by SYSTEM.
      const [apex] = await db.select().from(domains).where(eq(domains.domainName, TEST_APEX));
      expect(apex).toBeDefined();
      expect(apex!.tenantId).toBe(result.tenantId);
      expect(apex!.dnsMode).toBe('primary');
      // 2026-05-18 fix: apex must be stamped pre-verified so the
      // verification cron doesn't churn it (NS-delegation check
      // fails for operator-managed parent zones with just A records).
      expect(apex!.status).toBe('verified');
      expect(apex!.verifiedAt).not.toBeNull();

      // Admin user owned by SYSTEM.
      const [adminUser] = await db.select().from(users).where(eq(users.email, systemTenantEmail(TEST_APEX)));
      expect(adminUser).toBeDefined();
      expect(adminUser!.tenantId).toBe(result.tenantId);
      expect(adminUser!.roleName).toBe('tenant_admin');
      expect(adminUser!.status).toBe('active');
    });

    it('is idempotent — re-running returns alreadyExisted=true with no duplicate rows', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      const first = await ensureSystemTenant(db, TEST_APEX);
      const second = await ensureSystemTenant(db, TEST_APEX);
      const third = await ensureSystemTenant(db, TEST_APEX);

      expect(first.created).toBe(true);
      expect(second.alreadyExisted).toBe(true);
      expect(second.created).toBe(false);
      expect(third.alreadyExisted).toBe(true);
      expect(second.tenantId).toBe(first.tenantId);
      expect(third.tenantId).toBe(first.tenantId);

      // The partial unique index guarantees no duplicates.
      const systemRows = await db.select().from(tenants).where(eq(tenants.isSystem, true));
      expect(systemRows).toHaveLength(1);
    });

    it('self-heals when the SYSTEM row exists but the apex domain row is missing', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      const first = await ensureSystemTenant(db, TEST_APEX);
      expect(first.apexDomainCreated).toBe(true);

      // Operator accidentally direct-SQL-deletes the apex domain row.
      await db.delete(domains).where(eq(domains.domainName, TEST_APEX));

      const second = await ensureSystemTenant(db, TEST_APEX);
      expect(second.created).toBe(false);
      expect(second.alreadyExisted).toBe(true);
      expect(second.apexDomainCreated).toBe(true); // re-created
      expect(second.tenantId).toBe(first.tenantId);

      const [apex] = await db.select().from(domains).where(eq(domains.domainName, TEST_APEX));
      expect(apex).toBeDefined();
      expect(apex!.tenantId).toBe(first.tenantId);
    });

    it('self-heals when the SYSTEM row exists but the admin user is missing', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      const first = await ensureSystemTenant(db, TEST_APEX);
      // Operator nukes the admin user.
      await db.delete(users).where(eq(users.email, systemTenantEmail(TEST_APEX)));

      const second = await ensureSystemTenant(db, TEST_APEX);
      expect(second.adminUserCreated).toBe(true);
      const [adminUser] = await db.select().from(users).where(eq(users.email, systemTenantEmail(TEST_APEX)));
      expect(adminUser).toBeDefined();
      expect(adminUser!.tenantId).toBe(first.tenantId);
    });

    it('rejects when no hosting plans exist', async () => {
      const db = getTestDb();
      await seedRegion(db);
      // No seedPlan call.
      await expect(ensureSystemTenant(db, TEST_APEX)).rejects.toThrow(/no hosting_plans/i);
    });

    it('rejects when no regions exist', async () => {
      const db = getTestDb();
      await seedPlan(db);
      // No seedRegion call.
      await expect(ensureSystemTenant(db, TEST_APEX)).rejects.toThrow(/no regions/i);
    });

    it('rejects an empty base domain', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);
      await expect(ensureSystemTenant(db, '')).rejects.toThrow(/baseDomain is empty/);
      await expect(ensureSystemTenant(db, '   ')).rejects.toThrow(/baseDomain is empty/);
    });

    it('strips leading dots from the apex domain', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      await ensureSystemTenant(db, '...example.com');

      const [apex] = await db.select().from(domains).where(eq(domains.domainName, 'example.com'));
      expect(apex).toBeDefined();
    });

    it('is concurrency-safe: simultaneous calls resolve cleanly with one winner (review HIGH #1)', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      // Race 5 simultaneous calls — the partial unique index ensures
      // exactly one INSERT wins; the losing replicas hit SQLSTATE 23505
      // and the try/catch falls back to re-reading the SYSTEM row so
      // every caller returns a consistent result (created:true for the
      // winner, alreadyExisted:true for the rest).
      const results = await Promise.all([
        ensureSystemTenant(db, TEST_APEX),
        ensureSystemTenant(db, TEST_APEX),
        ensureSystemTenant(db, TEST_APEX),
        ensureSystemTenant(db, TEST_APEX),
        ensureSystemTenant(db, TEST_APEX),
      ]);

      // All callers got back the same tenantId.
      const ids = new Set(results.map((r) => r.tenantId));
      expect(ids.size).toBe(1);

      // Exactly one caller saw created:true; the rest saw alreadyExisted:true.
      const created = results.filter((r) => r.created);
      const existed = results.filter((r) => r.alreadyExisted);
      expect(created.length).toBe(1);
      expect(existed.length).toBe(4);

      // DB invariant intact.
      const systemRows = await db.select().from(tenants).where(eq(tenants.isSystem, true));
      expect(systemRows).toHaveLength(1);
    });

    it('hardens orphan admin user against pre-creation attack (security HIGH)', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);

      // Simulate an attacker who pre-creates a `_system@<apex>` user
      // with their own panel/role/password BEFORE bootstrap runs.
      const { users } = await import('../../db/schema.js');
      const attackerEmail = systemTenantEmail(TEST_APEX);
      const attackerTenant = crypto.randomUUID();
      await db.insert(tenants).values({
        id: attackerTenant,
        regionId: region.id,
        name: 'Attacker',
        primaryEmail: 'attacker@example.com',
        status: 'active',
        kubernetesNamespace: `tenant-attacker-${crypto.randomUUID().slice(0, 8)}`,
        planId: plan.id,
      });
      await db.insert(users).values({
        id: crypto.randomUUID(),
        email: attackerEmail,
        passwordHash: 'attacker-known-hash',
        fullName: 'Attacker Sub-user',
        roleName: 'tenant_user', // attacker's lower-privilege role
        panel: 'admin',          // attacker also tried to inject admin-panel access
        tenantId: attackerTenant,
        status: 'active',
        emailVerifiedAt: new Date(),
      });

      // Now run bootstrap. It must repoint the user to SYSTEM AND
      // overwrite panel/role/password so the attacker's known password
      // no longer works against the SYSTEM tenant.
      const result = await ensureSystemTenant(db, TEST_APEX);
      expect(result.created).toBe(true);

      const [hardened] = await db.select().from(users).where(eq(users.email, attackerEmail));
      expect(hardened).toBeDefined();
      expect(hardened!.tenantId).toBe(result.tenantId);
      expect(hardened!.panel).toBe('tenant');          // overwritten from 'admin'
      expect(hardened!.roleName).toBe('tenant_admin'); // overwritten from 'tenant_user'
      expect(hardened!.status).toBe('active');
      // Password hash must NOT be the attacker's known value — must
      // have been overwritten to a fresh random bcrypt hash.
      expect(hardened!.passwordHash).not.toBe('attacker-known-hash');
      expect(hardened!.passwordHash.startsWith('$2')).toBe(true); // bcrypt prefix
    });
  });

  describe('findSystemTenant', () => {
    it('returns null when no SYSTEM tenant exists', async () => {
      const result = await findSystemTenant(getTestDb());
      expect(result).toBeNull();
    });

    it('returns the row after ensureSystemTenant', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);
      const ensured = await ensureSystemTenant(db, TEST_APEX);

      const found = await findSystemTenant(db);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(ensured.tenantId);
      expect(found!.isSystem).toBe(true);
    });
  });

  describe('bootstrapSystemTenant', () => {
    it('resolves base domain from system_settings.ingress_base_domain when present', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);

      // Mimic seed.ts's system_settings row.
      const { systemSettings } = await import('../../db/schema.js');
      await db.insert(systemSettings).values({
        id: 'system',
        platformName: 'Test',
        apiRateLimit: 100,
        ingressBaseDomain: 'configured.example',
      });

      const result = await bootstrapSystemTenant(db);
      expect(result.baseDomain).toBe('configured.example');
      expect(result.created).toBe(true);
    });

    it('explicit baseDomain option wins over system_settings', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);
      const { systemSettings } = await import('../../db/schema.js');
      await db.insert(systemSettings).values({
        id: 'system',
        platformName: 'Test',
        apiRateLimit: 100,
        ingressBaseDomain: 'fromsettings.example',
      });

      const result = await bootstrapSystemTenant(db, { baseDomain: 'override.example' });
      expect(result.baseDomain).toBe('override.example');
    });

    it('falls back to env when no system_settings row exists', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);
      const prev = process.env.PLATFORM_BASE_DOMAIN;
      process.env.PLATFORM_BASE_DOMAIN = 'from-env.example';
      try {
        const result = await bootstrapSystemTenant(db);
        expect(result.baseDomain).toBe('from-env.example');
      } finally {
        if (prev === undefined) delete process.env.PLATFORM_BASE_DOMAIN;
        else process.env.PLATFORM_BASE_DOMAIN = prev;
      }
    });
  });

  describe('partial unique index guard', () => {
    it('rejects a second is_system=true insert via direct SQL', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      await ensureSystemTenant(db, TEST_APEX);

      // Try to directly insert another SYSTEM row — DB must refuse.
      // Drizzle wraps pg errors so the constraint name lives on the
      // underlying cause; assert against the cause's code (23505 =
      // unique_violation) and constraint name rather than the surface
      // message which says "Failed query: insert into ...".
      let captured: { cause?: { code?: string; constraint?: string } } | null = null;
      try {
        await db.insert(tenants).values({
          id: crypto.randomUUID(),
          regionId: region.id,
          name: 'ANOTHER SYSTEM',
          primaryEmail: 'another@example.com',
          status: 'active',
          kubernetesNamespace: 'tenant-another-system',
          planId: plan.id,
          isSystem: true,
        });
      } catch (err) {
        captured = err as typeof captured;
      }
      expect(captured).not.toBeNull();
      expect(captured!.cause?.code).toBe('23505');
      expect(captured!.cause?.constraint).toBe('tenants_only_one_system_idx');
    });
  });
});
