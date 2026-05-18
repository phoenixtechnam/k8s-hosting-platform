import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { domains, dnsProviderGroups } from '../../db/schema.js';
import { fetchVerifyCandidates } from './verification-cron.js';
import { ensureSystemTenant } from '../system-tenant/service.js';

const dbAvailable = await isDbAvailable();
const TEST_APEX = 'verify-cron-test.example';

describe.skipIf(!dbAvailable)('verify-cron SYSTEM conditional-skip (integration)', () => {
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
    await db.execute(sql.raw('TRUNCATE TABLE dns_provider_groups CASCADE'));
  });

  it('excludes SYSTEM apex with NO dns_group_id (default bootstrap state)', async () => {
    const db = getTestDb();
    await seedRegion(db);
    await seedPlan(db);
    await ensureSystemTenant(db, TEST_APEX);

    const candidates = await fetchVerifyCandidates(db, new Date());
    const apexInCandidates = candidates.some((c) => c.domainName === TEST_APEX);
    expect(apexInCandidates).toBe(false);
  });

  it('INCLUDES SYSTEM apex when dns_group_id IS NOT NULL (operator migrated to platform DNS)', async () => {
    const db = getTestDb();
    await seedRegion(db);
    await seedPlan(db);
    await ensureSystemTenant(db, TEST_APEX);

    // Operator wires a DNS provider + group, then binds the SYSTEM
    // apex domain to that group (simulates the "migrate apex to
    // platform-managed DNS" admin action).
    const groupId = crypto.randomUUID();
    await db.insert(dnsProviderGroups).values({
      id: groupId,
      name: 'platform-dns',
      nsHostnames: ['ns1.example', 'ns2.example'],
      isDefault: 0,
    });
    await db.update(domains)
      .set({
        dnsGroupId: groupId,
        // Clear the pre-verified state so the cron will re-evaluate.
        verificationCacheAt: null,
      })
      .where(eq(domains.domainName, TEST_APEX));

    const candidates = await fetchVerifyCandidates(db, new Date());
    const apexInCandidates = candidates.some((c) => c.domainName === TEST_APEX);
    expect(apexInCandidates).toBe(true);
  });

  it('always includes customer-tenant domains (filter only narrows SYSTEM)', async () => {
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const tenant = await seedTenant(db, region.id, plan.id);
    await db.insert(domains).values({
      id: crypto.randomUUID(),
      tenantId: tenant.id,
      domainName: 'acme.example',
      status: 'unverified',
      dnsMode: 'cname',
    });

    const candidates = await fetchVerifyCandidates(db, new Date());
    expect(candidates.some((c) => c.domainName === 'acme.example')).toBe(true);
  });

  it('excludes suspended/deleted regardless of tenant type', async () => {
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const tenant = await seedTenant(db, region.id, plan.id);
    await db.insert(domains).values([
      {
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        domainName: 'sus.example',
        status: 'suspended',
        dnsMode: 'cname',
      },
      {
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        domainName: 'del.example',
        status: 'deleted',
        dnsMode: 'cname',
      },
    ]);

    const candidates = await fetchVerifyCandidates(db, new Date());
    expect(candidates.some((c) => c.domainName === 'sus.example')).toBe(false);
    expect(candidates.some((c) => c.domainName === 'del.example')).toBe(false);
  });
});
