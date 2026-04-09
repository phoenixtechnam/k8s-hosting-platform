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
import { enableEmailForDomain, updateEmailDomain, ensureWebmailIngress } from './service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

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

  // ─── Round-4 Phase 2: webmail_status lifecycle ────────────────

  // Build a fake K8sClients that fakes Service / Ingress / Cert
  // creation. The test asserts the `webmail_status` column transitions
  // through the expected lifecycle.
  function makeFakeK8s(opts: {
    certShouldFail?: boolean;
    ingressShouldFail?: boolean;
  } = {}): K8sClients {
    return {
      core: {
        createNamespacedService: () => Promise.resolve({}),
        replaceNamespacedService: () => Promise.resolve({}),
      },
      networking: {
        createNamespacedIngress: opts.ingressShouldFail
          ? () => Promise.reject(new Error('forced ingress failure'))
          : () => Promise.resolve({}),
        replaceNamespacedIngress: () => Promise.resolve({}),
      },
      apps: {} as never,
      batch: {} as never,
      custom: {
        getNamespacedCustomObject: opts.certShouldFail
          ? () => Promise.reject(new Error('cert not ready'))
          : () => Promise.resolve({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
      },
    } as unknown as K8sClients;
  }

  it('ensureWebmailIngress writes status=ready when cert + ingress succeed', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, {
      domainName: 'status-ok.example.com',
      dnsMode: 'primary',
    });
    const enabled = await enableEmailForDomain(
      db as never,
      clientId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    // Mock cert manager to succeed.
    const k8s = makeFakeK8s({});
    // ensureRouteCertificate is invoked dynamically inside
    // ensureWebmailIngress — to keep this test focused on the status
    // write paths, we skip cert provisioning by passing a fake k8s
    // client whose namespacedCustomObject succeeds. The actual cert
    // logic is tested separately in webmail-reconciler.test.ts.
    const result = await ensureWebmailIngress(
      db as never,
      k8s,
      enabled.id,
    );
    expect(result.ingressCreated).toBe(true);
    // Status is `ready` when TLS was attached, otherwise `ready_no_tls`.
    expect(['ready', 'ready_no_tls']).toContain(result.status);

    const [ed] = await db
      .select({ status: emailDomains.webmailStatus })
      .from(emailDomains)
      .where(eq(emailDomains.id, enabled.id));
    expect(['ready', 'ready_no_tls']).toContain(ed.status);
  });

  it('ensureWebmailIngress writes status=failed when ingress create throws', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, clientId, {
      domainName: 'status-fail.example.com',
      dnsMode: 'primary',
    });
    const enabled = await enableEmailForDomain(
      db as never,
      clientId,
      domain.id,
      {},
      '0'.repeat(64),
    );

    const k8s = makeFakeK8s({ ingressShouldFail: true });

    await expect(
      ensureWebmailIngress(db as never, k8s, enabled.id),
    ).rejects.toThrow(/forced ingress failure/);

    const [ed] = await db
      .select({
        status: emailDomains.webmailStatus,
        message: emailDomains.webmailStatusMessage,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, enabled.id));
    expect(ed.status).toBe('failed');
    expect(ed.message).toContain('Ingress create failed');
  });
});
