import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  isDbAvailable,
  runMigrations,
  cleanTables,
  closeTestDb,
  getTestDb,
} from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedClient, seedDomain } from '../../test-helpers/fixtures.js';
import {
  emailDomains,
  mailboxes,
  emailAliases,
  dnsRecords,
  ingressRoutes,
} from '../../db/schema.js';
import { deleteDomain, getDomainDeletePreview } from './service.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/index.js';

const dbAvailable = await isDbAvailable();

// Helpers to seed the child tree. These would fit in fixtures.ts but
// are local because they're only used here.
async function seedEmailDomain(db: Database, clientId: string, domainId: string, id: string) {
  await db.insert(emailDomains).values({
    id,
    domainId,
    clientId,
    enabled: 1,
    webmailEnabled: 1,
    dkimSelector: 'default',
  });
}

async function seedMailbox(
  db: Database,
  clientId: string,
  emailDomainId: string,
  localPart: string,
  fullAddress: string,
) {
  const id = crypto.randomUUID();
  await db.insert(mailboxes).values({
    id,
    emailDomainId,
    clientId,
    localPart,
    fullAddress,
    passwordHash: 'x',
    status: 'active',
  });
  return id;
}

async function seedAlias(
  db: Database,
  clientId: string,
  emailDomainId: string,
  sourceAddress: string,
) {
  const id = crypto.randomUUID();
  await db.insert(emailAliases).values({
    id,
    emailDomainId,
    clientId,
    sourceAddress,
    destinationAddresses: ['target@example.com'],
    enabled: 1,
  });
  return id;
}

async function seedDnsRecord(db: Database, domainId: string, type: string = 'A') {
  const id = crypto.randomUUID();
  await db.insert(dnsRecords).values({
    id,
    domainId,
    recordType: type as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS',
    recordName: 'www',
    recordValue: '1.2.3.4',
    ttl: 3600,
  });
  return id;
}

async function seedIngressRoute(db: Database, domainId: string, hostname: string) {
  const id = crypto.randomUUID();
  await db.insert(ingressRoutes).values({
    id,
    domainId,
    hostname,
    ingressCname: 'ingress.platform.test',
    status: 'active',
  });
  return id;
}

describe.skipIf(!dbAvailable)('Domain delete cascade (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let clientId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
  });

  afterAll(async () => {
    await app.close();
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

  it('CASCADE: deleting a domain removes its email_domain, mailboxes, aliases, dns_records, ingress_routes', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId);
    const edId = crypto.randomUUID();
    await seedEmailDomain(db, clientId, domain.id, edId);
    await seedMailbox(db, clientId, edId, 'alice', `alice@${domain.domainName}`);
    await seedMailbox(db, clientId, edId, 'bob', `bob@${domain.domainName}`);
    await seedAlias(db, clientId, edId, `alias@${domain.domainName}`);
    await seedDnsRecord(db, domain.id);
    await seedDnsRecord(db, domain.id, 'MX');
    await seedIngressRoute(db, domain.id, domain.domainName);

    // Confirm the tree exists
    const preCounts = await db.execute<{ table: string; n: number }>(sql`
      SELECT 'email_domains' AS table, COUNT(*) AS n FROM email_domains WHERE domain_id = ${domain.id}
      UNION ALL SELECT 'mailboxes', COUNT(*) FROM mailboxes WHERE email_domain_id = ${edId}
      UNION ALL SELECT 'email_aliases', COUNT(*) FROM email_aliases WHERE email_domain_id = ${edId}
      UNION ALL SELECT 'dns_records', COUNT(*) FROM dns_records WHERE domain_id = ${domain.id}
      UNION ALL SELECT 'ingress_routes', COUNT(*) FROM ingress_routes WHERE domain_id = ${domain.id}
    `);
    const pre = Object.fromEntries((preCounts.rows ?? []).map((r) => [r.table, Number(r.n)]));
    expect(pre.email_domains).toBe(1);
    expect(pre.mailboxes).toBe(2);
    expect(pre.email_aliases).toBe(1);
    expect(pre.dns_records).toBe(2);
    expect(pre.ingress_routes).toBe(1);

    // Delete the domain via the service (no k8s client — we're only
    // testing the DB cascade behaviour, the k8s path is tested with
    // mocks in unit tests).
    const result = await deleteDomain(db as never, clientId, domain.id);

    // Assert the cascade counts are accurate
    expect(result.deleted.emailDomains).toBe(1);
    expect(result.deleted.mailboxes).toBe(2);
    expect(result.deleted.aliases).toBe(1);
    expect(result.deleted.dnsRecords).toBe(2);
    expect(result.deleted.ingressRoutes).toBe(1);

    // Confirm the tree is gone
    const postCounts = await db.execute<{ table: string; n: number }>(sql`
      SELECT 'email_domains' AS table, COUNT(*) AS n FROM email_domains WHERE domain_id = ${domain.id}
      UNION ALL SELECT 'mailboxes', COUNT(*) FROM mailboxes WHERE email_domain_id = ${edId}
      UNION ALL SELECT 'email_aliases', COUNT(*) FROM email_aliases WHERE email_domain_id = ${edId}
      UNION ALL SELECT 'dns_records', COUNT(*) FROM dns_records WHERE domain_id = ${domain.id}
      UNION ALL SELECT 'ingress_routes', COUNT(*) FROM ingress_routes WHERE domain_id = ${domain.id}
    `);
    const post = Object.fromEntries((postCounts.rows ?? []).map((r) => [r.table, Number(r.n)]));
    expect(post.email_domains).toBe(0);
    expect(post.mailboxes).toBe(0);
    expect(post.email_aliases).toBe(0);
    expect(post.dns_records).toBe(0);
    expect(post.ingress_routes).toBe(0);
  });

  it('CASCADE: deleting a domain with no email config still removes DNS records and ingress routes', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId);
    await seedDnsRecord(db, domain.id);
    await seedIngressRoute(db, domain.id, domain.domainName);

    const result = await deleteDomain(db as never, clientId, domain.id);

    expect(result.deleted.emailDomains).toBe(0);
    expect(result.deleted.mailboxes).toBe(0);
    expect(result.deleted.aliases).toBe(0);
    expect(result.deleted.dnsRecords).toBe(1);
    expect(result.deleted.ingressRoutes).toBe(1);
  });

  it('preview: enumerates every resource that will be removed', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, { domainName: 'cascade.example.com' });
    const edId = crypto.randomUUID();
    await seedEmailDomain(db, clientId, domain.id, edId);
    await seedMailbox(db, clientId, edId, 'alice', 'alice@cascade.example.com');
    await seedAlias(db, clientId, edId, 'bot@cascade.example.com');
    await seedDnsRecord(db, domain.id, 'TXT');
    await seedIngressRoute(db, domain.id, 'cascade.example.com');

    const preview = await getDomainDeletePreview(db as never, clientId, domain.id);

    expect(preview.domainName).toBe('cascade.example.com');
    expect(preview.dnsRecords.length).toBe(1);
    expect(preview.dnsRecords[0].type).toBe('TXT');
    expect(preview.emailDomain).not.toBeNull();
    expect(preview.emailDomain?.id).toBe(edId);
    expect(preview.emailDomain?.webmailEnabled).toBe(true);
    expect(preview.emailDomain?.mailboxes.length).toBe(1);
    expect(preview.emailDomain?.mailboxes[0].fullAddress).toBe('alice@cascade.example.com');
    expect(preview.emailDomain?.aliases.length).toBe(1);
    expect(preview.emailDomain?.aliases[0].sourceAddress).toBe('bot@cascade.example.com');
    expect(preview.ingressRoutes.length).toBe(1);
    expect(preview.webmailIngressHostname).toBe('webmail.cascade.example.com');
  });

  it('preview: returns null emailDomain when no email config exists', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId);
    await seedDnsRecord(db, domain.id);

    const preview = await getDomainDeletePreview(db as never, clientId, domain.id);

    expect(preview.emailDomain).toBeNull();
    expect(preview.webmailIngressHostname).toBeNull();
    expect(preview.dnsRecords.length).toBe(1);
  });

  it('route: GET delete-preview returns the full cascade list', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, { domainName: 'api-preview.example.com' });
    const edId = crypto.randomUUID();
    await seedEmailDomain(db, clientId, domain.id, edId);
    await seedMailbox(db, clientId, edId, 'x', 'x@api-preview.example.com');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/clients/${clientId}/domains/${domain.id}/delete-preview`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.domainName).toBe('api-preview.example.com');
    expect(body.data.emailDomain).not.toBeNull();
    expect(body.data.emailDomain.mailboxes.length).toBe(1);
    expect(body.data.webmailIngressHostname).toBe('webmail.api-preview.example.com');
  });
});
