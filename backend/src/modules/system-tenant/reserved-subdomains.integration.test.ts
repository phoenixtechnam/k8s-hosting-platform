import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { systemSettings, platformSettings, domains } from '../../db/schema.js';
import {
  getReservedPlatformHostnames,
  isReservedPlatformHostname,
  _resetReservedHostnamesCache,
} from './reserved-subdomains.js';
import { createDomain } from '../domains/service.js';
import { createDnsRecord, updateDnsRecord } from '../dns-records/service.js';
import { ensureSystemTenant } from './service.js';

const dbAvailable = await isDbAvailable();
const TEST_APEX = 'reserved-test.example';

describe.skipIf(!dbAvailable)('reserved-subdomains (integration)', () => {
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
    await db.execute(sql.raw('TRUNCATE TABLE platform_settings CASCADE'));
    _resetReservedHostnamesCache();
    // Seed apex via system_settings so the resolver picks it up.
    await db.insert(systemSettings).values({
      id: 'system',
      platformName: 'Reserved Test',
      apiRateLimit: 100,
      ingressBaseDomain: TEST_APEX,
    });
  });

  describe('getReservedPlatformHostnames', () => {
    it('includes the static config-derived platform hostnames', async () => {
      const r = await getReservedPlatformHostnames(getTestDb());
      expect(r.apex).toBe(TEST_APEX);
      // From config/domains.ts: admin, tenant, mail, stalwart, dex, webmail.
      expect(r.fqdns.has(`admin.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`tenant.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`mail.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`stalwart.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`dex.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`webmail.${TEST_APEX}`)).toBe(true);
    });

    it('includes the static deny-list labels expanded against the apex', async () => {
      const r = await getReservedPlatformHostnames(getTestDb());
      // Sampling the deny list — bulwark, traefik, master, etc.
      expect(r.fqdns.has(`bulwark.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`traefik.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`master.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`tunnels.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`suspended.${TEST_APEX}`)).toBe(true);
      expect(r.fqdns.has(`longhorn.${TEST_APEX}`)).toBe(true);
    });

    it('includes the apex itself', async () => {
      const r = await getReservedPlatformHostnames(getTestDb());
      expect(r.fqdns.has(TEST_APEX)).toBe(true);
    });

    it('reflects operator-edited platform_settings (longhorn URL re-mapped)', async () => {
      const db = getTestDb();
      // Operator points longhorn at a custom subdomain via platform_settings.
      await db.insert(platformSettings).values({
        key: 'longhorn_url',
        value: `https://lh.${TEST_APEX}/`,
      });
      _resetReservedHostnamesCache();

      const r = await getReservedPlatformHostnames(db);
      expect(r.fqdns.has(`lh.${TEST_APEX}`)).toBe(true);
      // The static `longhorn.<apex>` from the deny list is still there too —
      // both labels are reserved, defensive against operator re-renaming.
      expect(r.fqdns.has(`longhorn.${TEST_APEX}`)).toBe(true);
    });

    it('IGNORES platform_settings URLs that point outside the apex', async () => {
      const db = getTestDb();
      await db.insert(platformSettings).values({
        key: 'longhorn_url',
        value: 'https://lh.external-vendor.com/', // not under <apex>
      });
      _resetReservedHostnamesCache();

      const r = await getReservedPlatformHostnames(db);
      expect(r.fqdns.has('lh.external-vendor.com')).toBe(false);
    });

    it('caches results for 5s', async () => {
      const db = getTestDb();
      const r1 = await getReservedPlatformHostnames(db);
      // Add a new operator URL; without cache-reset the result should NOT
      // include it because the 5s TTL hasn't elapsed.
      await db.insert(platformSettings).values({
        key: 'default_webmail_url',
        value: `https://mail-ui.${TEST_APEX}/`,
      });
      const r2 = await getReservedPlatformHostnames(db);
      expect(r2.fqdns.has(`mail-ui.${TEST_APEX}`)).toBe(r1.fqdns.has(`mail-ui.${TEST_APEX}`));

      // After explicit cache reset, the new value is picked up.
      _resetReservedHostnamesCache();
      const r3 = await getReservedPlatformHostnames(db);
      expect(r3.fqdns.has(`mail-ui.${TEST_APEX}`)).toBe(true);
    });
  });

  describe('isReservedPlatformHostname helper', () => {
    it('returns true for a static-derived hostname', async () => {
      expect(await isReservedPlatformHostname(getTestDb(), `admin.${TEST_APEX}`)).toBe(true);
    });

    it('case-insensitive + trailing-dot tolerant', async () => {
      expect(await isReservedPlatformHostname(getTestDb(), `ADMIN.${TEST_APEX.toUpperCase()}.`)).toBe(true);
    });

    it('returns false for an arbitrary tenant hostname', async () => {
      expect(await isReservedPlatformHostname(getTestDb(), `my-customer.example.com`)).toBe(false);
    });

    it('returns true for the apex itself', async () => {
      expect(await isReservedPlatformHostname(getTestDb(), TEST_APEX)).toBe(true);
    });
  });

  describe('createDomain enforcement', () => {
    it('rejects a reserved hostname with RESERVED_PLATFORM_HOSTNAME', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);

      await expect(
        createDomain(db, tenant.id, {
          domain_name: `admin.${TEST_APEX}`,
          dns_mode: 'cname',
        } as never),
      ).rejects.toMatchObject({
        code: 'RESERVED_PLATFORM_HOSTNAME',
        status: 409,
      });
    });

    it('rejects the apex itself for a regular tenant', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);

      await expect(
        createDomain(db, tenant.id, {
          domain_name: TEST_APEX,
          dns_mode: 'cname',
        } as never),
      ).rejects.toMatchObject({ code: 'RESERVED_PLATFORM_HOSTNAME' });
    });

    it('allows the SYSTEM apex insert via ensureSystemApexDomain (bypasses createDomain)', async () => {
      const db = getTestDb();
      await seedRegion(db);
      await seedPlan(db);
      // ensureSystemTenant uses a direct DB insert, not createDomain —
      // so the apex registration bypasses the reserved-hostname check.
      const result = await ensureSystemTenant(db, TEST_APEX);
      expect(result.apexDomainCreated).toBe(true);
    });

    it('allows a hostname OUTSIDE the platform apex', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);

      // 'admin.acme.com' is a customer's own admin site, not the platform.
      await expect(
        createDomain(db, tenant.id, {
          domain_name: 'admin.acme.com',
          dns_mode: 'cname',
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe('createDnsRecord enforcement', () => {
    it('rejects a CNAME pointing at a platform-reserved hostname', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);
      const domain = await seedDomain(db, tenant.id, { domainName: 'acme.com' });

      await expect(
        createDnsRecord(db, tenant.id, domain.id, {
          record_type: 'CNAME',
          record_name: 'admin',
          record_value: `admin.${TEST_APEX}`,
          ttl: 3600,
        } as never),
      ).rejects.toMatchObject({ code: 'RESERVED_PLATFORM_HOSTNAME' });
    });

    it('rejects an A record pointing at a reserved hostname value', async () => {
      // Real A records take IPs not hostnames; the platform-reserved
      // hostname-as-record-value path is mostly there for CNAMEs but
      // we cover the case defensively. Use AAAA which has the same
      // pattern.
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);
      const domain = await seedDomain(db, tenant.id, { domainName: 'acme.com' });

      await expect(
        createDnsRecord(db, tenant.id, domain.id, {
          record_type: 'AAAA',
          record_name: 'www',
          record_value: `bulwark.${TEST_APEX}`,
          ttl: 3600,
        } as never),
      ).rejects.toMatchObject({ code: 'RESERVED_PLATFORM_HOSTNAME' });
    });

    it('allows a benign TXT record', async () => {
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);
      const domain = await seedDomain(db, tenant.id, { domainName: 'acme.com' });

      await expect(
        createDnsRecord(db, tenant.id, domain.id, {
          record_type: 'TXT',
          record_name: '_dmarc',
          record_value: 'v=DMARC1; p=none',
          ttl: 3600,
        } as never),
      ).resolves.toBeDefined();
    });

    it('rejects an MX record pointing at a reserved hostname (review MEDIUM #6)', async () => {
      // The original Phase 5 check only covered CNAME/A/AAAA; MX/NS/SRV
      // are added defensively so future audits can't find a record
      // type that points at a reserved hostname unchecked.
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);
      const domain = await seedDomain(db, tenant.id, { domainName: 'acme.com' });

      await expect(
        createDnsRecord(db, tenant.id, domain.id, {
          record_type: 'MX',
          record_name: '@',
          record_value: `mail.${TEST_APEX}`,
          ttl: 3600,
          priority: 10,
        } as never),
      ).rejects.toMatchObject({ code: 'RESERVED_PLATFORM_HOSTNAME' });
    });

    it('updateDnsRecord re-applies the reserved check on record_value PATCH (review MEDIUM #4)', async () => {
      // Without this check, a tenant could create a benign record and
      // PATCH the value to a reserved hostname later — bypassing
      // create-time enforcement.
      const db = getTestDb();
      const region = await seedRegion(db);
      const plan = await seedPlan(db);
      const tenant = await seedTenant(db, region.id, plan.id);
      const domain = await seedDomain(db, tenant.id, { domainName: 'acme.com' });

      const benign = await createDnsRecord(db, tenant.id, domain.id, {
        record_type: 'CNAME',
        record_name: 'www',
        record_value: 'shop.example.com',
        ttl: 3600,
      } as never);

      await expect(
        updateDnsRecord(db, tenant.id, domain.id, benign.id, {
          record_value: `admin.${TEST_APEX}`,
        } as never),
      ).rejects.toMatchObject({ code: 'RESERVED_PLATFORM_HOSTNAME' });
    });
  });
});
