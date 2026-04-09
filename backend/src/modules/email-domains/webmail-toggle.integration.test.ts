import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  isDbAvailable,
  runMigrations,
  cleanTables,
  closeTestDb,
  getTestDb,
} from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedClient, seedDomain } from '../../test-helpers/fixtures.js';
import { emailDomains, dnsRecords } from '../../db/schema.js';
import { enableEmailForDomain, updateEmailDomain } from './service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Email domain webmail DNS toggle (integration)', () => {
  let clientId: string;

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const client = await seedClient(db, region.id, plan.id);
    clientId = client.id;
  });

  it('enableEmailForDomain publishes a webmail.<domain> A record by default', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, { domainName: 'webmail-test.example.com' });
    await enableEmailForDomain(
      db as never,
      clientId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const webmailRecord = records.find(
      (r) => r.recordType === 'A' && r.recordName === 'webmail.webmail-test.example.com',
    );
    expect(webmailRecord).toBeDefined();
    expect(webmailRecord?.recordValue).toBeTruthy();
  });

  it('updateEmailDomain with webmail_enabled=false removes the webmail DNS record', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, { domainName: 'toggle-test.example.com' });
    await enableEmailForDomain(
      db as never,
      clientId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    // Pre-condition: webmail record exists
    const before = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));
    expect(
      before.some((r) => r.recordType === 'A' && r.recordName === 'webmail.toggle-test.example.com'),
    ).toBe(true);

    // Toggle webmail off
    await updateEmailDomain(db as never, clientId, domain.id, { webmail_enabled: false });

    const after = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));
    expect(
      after.some((r) => r.recordType === 'A' && r.recordName === 'webmail.toggle-test.example.com'),
    ).toBe(false);

    // Verify the email_domains row also reflects the change
    const [updatedEd] = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.domainId, domain.id));
    expect(updatedEd.webmailEnabled).toBe(0);
  });

  it('updateEmailDomain with webmail_enabled=true re-publishes the webmail DNS record', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, { domainName: 'republish-test.example.com' });
    await enableEmailForDomain(
      db as never,
      clientId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    // Toggle off and then back on
    await updateEmailDomain(db as never, clientId, domain.id, { webmail_enabled: false });
    await updateEmailDomain(db as never, clientId, domain.id, { webmail_enabled: true });

    const records = await db
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const webmailRecord = records.find(
      (r) => r.recordType === 'A' && r.recordName === 'webmail.republish-test.example.com',
    );
    expect(webmailRecord).toBeDefined();

    const [ed] = await db
      .select()
      .from(emailDomains)
      .where(eq(emailDomains.domainId, domain.id));
    expect(ed.webmailEnabled).toBe(1);
  });
});
