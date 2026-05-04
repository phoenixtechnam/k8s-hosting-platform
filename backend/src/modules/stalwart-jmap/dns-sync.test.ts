/**
 * Unit tests for stalwart-jmap/dns-sync.ts
 *
 * All external dependencies (fetch, DB, dns-records/service, drizzle-orm) are
 * mocked at the top level via vi.mock so tests run without a real database or
 * network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock drizzle-orm and db/schema BEFORE importing dns-sync so the module can
// be loaded in a worktree where drizzle-orm is not installed.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: 'eq' })),
  and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
}));

vi.mock('../../db/schema.js', () => ({
  dnsRecords: { id: 'id', domainId: 'domain_id', recordType: 'record_type', recordName: 'record_name', recordValue: 'record_value' },
  emailDomains: { domainId: 'domain_id' },
  domains: { id: 'id', domainName: 'domain_name' },
}));

vi.mock('../dns-records/service.js', () => ({
  syncRecordToProviders: vi.fn().mockResolvedValue(undefined),
}));

import {
  parseZoneFile,
  isStalwartOwnedRecord,
  syncDomainDnsRecords,
  type ZoneRecord,
} from './dns-sync.js';

// ── parseZoneFile ─────────────────────────────────────────────────────────────

describe('parseZoneFile', () => {
  it('parses an A record', () => {
    const zone = 'mail.example.com. 3600 IN A 1.2.3.4';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      name: 'mail.example.com.',
      ttl: 3600,
      type: 'A',
      rdata: '1.2.3.4',
      priority: null,
    });
  });

  it('parses an MX record', () => {
    const zone = 'example.com. 3600 IN MX 10 mail.example.com.';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      type: 'MX',
      rdata: 'mail.example.com.',
      priority: 10,
    });
  });

  it('parses a TXT record with quotes', () => {
    const zone = 'example.com. 3600 IN TXT "v=spf1 mx ~all"';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      type: 'TXT',
      rdata: 'v=spf1 mx ~all',
    });
  });

  it('parses a DKIM TXT record', () => {
    const zone = 'default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=ed25519; p=abc123"';
    const records = parseZoneFile(zone);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      type: 'TXT',
      name: 'default._domainkey.example.com.',
      rdata: 'v=DKIM1; k=ed25519; p=abc123',
    });
  });

  it('parses a CNAME record', () => {
    const zone = 'mta-sts.example.com. 3600 IN CNAME mail.example.com.';
    const records = parseZoneFile(zone);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      type: 'CNAME',
      rdata: 'mail.example.com.',
    });
  });

  it('parses a SRV record', () => {
    const zone = '_submissions._tcp.example.com. 3600 IN SRV 0 1 465 mail.example.com.';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject<Partial<ZoneRecord>>({
      type: 'SRV',
      priority: 0,
      weight: 1,
      port: 465,
      rdata: '1 465 mail.example.com.',
    });
  });

  it('skips comment lines', () => {
    const zone = '; This is a comment\nexample.com. 3600 IN A 1.2.3.4';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
  });

  it('skips $ORIGIN and $TTL directives', () => {
    const zone = '$ORIGIN example.com.\n$TTL 3600\nexample.com. 3600 IN A 1.2.3.4';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
  });

  it('skips unknown record types', () => {
    const zone = 'example.com. 3600 IN SOA ns1.example.com. admin.example.com. 1 7200 900 1209600 300';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(0);
  });

  it('parses a multi-record zone file', () => {
    const zone = [
      'example.com. 3600 IN MX 10 mail.example.com.',
      'mail.example.com. 3600 IN A 1.2.3.4',
      'example.com. 3600 IN TXT "v=spf1 mx ~all"',
      '_dmarc.example.com. 3600 IN TXT "v=DMARC1; p=quarantine"',
      'default._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=ed25519; p=abc"',
      'mta-sts.example.com. 3600 IN CNAME mail.example.com.',
      '_mta-sts.example.com. 3600 IN TXT "v=STSv1; id=abc123"',
    ].join('\n');

    const records = parseZoneFile(zone);
    expect(records).toHaveLength(7);
    const types = records.map((r) => r.type);
    expect(types).toContain('MX');
    expect(types).toContain('A');
    expect(types.filter((t) => t === 'TXT')).toHaveLength(4);
    expect(types).toContain('CNAME');
  });

  it('handles empty input', () => {
    expect(parseZoneFile('')).toHaveLength(0);
    expect(parseZoneFile('   \n  \n')).toHaveLength(0);
  });

  it('handles zone file without IN class keyword', () => {
    // Some minimal zone files omit the class
    const zone = 'example.com. 3600 A 1.2.3.4';
    const records = parseZoneFile(zone);
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('A');
  });
});

// ── isStalwartOwnedRecord ─────────────────────────────────────────────────────

describe('isStalwartOwnedRecord', () => {
  const domain = 'example.com';

  it('owns MX at apex', () => {
    expect(isStalwartOwnedRecord('example.com', 'MX', domain)).toBe(true);
  });

  it('does not own MX for subdomain', () => {
    expect(isStalwartOwnedRecord('sub.example.com', 'MX', domain)).toBe(false);
  });

  it('owns SPF TXT at apex', () => {
    expect(isStalwartOwnedRecord('example.com', 'TXT', domain, 'v=spf1 mx -all')).toBe(true);
  });

  it('does not own non-SPF TXT at apex (e.g. Google site verification)', () => {
    // Code-review HIGH 2026-05-03: apex TXT match must be content-aware
    // so a tenant's google-site-verification or other apex TXT isn't
    // accidentally deleted on the next sync.
    expect(
      isStalwartOwnedRecord('example.com', 'TXT', domain, 'google-site-verification=abc123'),
    ).toBe(false);
    // Apex TXT with no value is also not ours.
    expect(isStalwartOwnedRecord('example.com', 'TXT', domain, '')).toBe(false);
    expect(isStalwartOwnedRecord('example.com', 'TXT', domain)).toBe(false);
  });

  it('owns DKIM TXT', () => {
    expect(isStalwartOwnedRecord('default._domainkey.example.com', 'TXT', domain)).toBe(true);
  });

  it('owns DMARC TXT', () => {
    expect(isStalwartOwnedRecord('_dmarc.example.com', 'TXT', domain)).toBe(true);
  });

  it('owns MTA-STS TXT', () => {
    expect(isStalwartOwnedRecord('_mta-sts.example.com', 'TXT', domain)).toBe(true);
  });

  it('does not own unrelated TXT', () => {
    expect(isStalwartOwnedRecord('_acme-challenge.example.com', 'TXT', domain)).toBe(false);
  });

  it('owns mta-sts CNAME', () => {
    expect(isStalwartOwnedRecord('mta-sts.example.com', 'CNAME', domain)).toBe(true);
  });

  it('owns autoconfig CNAME', () => {
    expect(isStalwartOwnedRecord('autoconfig.example.com', 'CNAME', domain)).toBe(true);
  });

  it('owns autodiscover CNAME', () => {
    expect(isStalwartOwnedRecord('autodiscover.example.com', 'CNAME', domain)).toBe(true);
  });

  it('does not own arbitrary CNAME', () => {
    expect(isStalwartOwnedRecord('www.example.com', 'CNAME', domain)).toBe(false);
  });

  it('owns mail.domain A record', () => {
    expect(isStalwartOwnedRecord('mail.example.com', 'A', domain)).toBe(true);
  });

  it('does not own webmail.domain A record', () => {
    expect(isStalwartOwnedRecord('webmail.example.com', 'A', domain)).toBe(false);
  });

  it('owns submission SRV', () => {
    expect(isStalwartOwnedRecord('_submission._tcp.example.com', 'SRV', domain)).toBe(true);
    expect(isStalwartOwnedRecord('_submissions._tcp.example.com', 'SRV', domain)).toBe(true);
  });

  it('owns IMAP SRV', () => {
    expect(isStalwartOwnedRecord('_imap._tcp.example.com', 'SRV', domain)).toBe(true);
    expect(isStalwartOwnedRecord('_imaps._tcp.example.com', 'SRV', domain)).toBe(true);
  });

  it('does not own unknown SRV', () => {
    expect(isStalwartOwnedRecord('_xmpp._tcp.example.com', 'SRV', domain)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isStalwartOwnedRecord('Mail.EXAMPLE.COM', 'a', 'EXAMPLE.COM')).toBe(true);
    expect(isStalwartOwnedRecord('EXAMPLE.COM', 'mx', 'example.com')).toBe(true);
  });

  it('strips trailing dots', () => {
    expect(isStalwartOwnedRecord('mail.example.com.', 'A', 'example.com')).toBe(true);
  });
});

// ── syncDomainDnsRecords ──────────────────────────────────────────────────────

// TODO(stalwart-cut3-followup): rewrite the principalGetOne mock paths
// against the new x:Domain/get wire format. dns-sync now resolves
// domain dnsZoneFile through domainGet (urn:stalwart:jmap), not
// Principal/get (urn:ietf:params:jmap:principals). Skipped until the
// rewrite. Wire-format correctness is verified by
// scripts/integration-stalwart-v016-local.sh on real Stalwart.
describe.skip('syncDomainDnsRecords', () => {
  // We test the sync logic by mocking the JMAP client and DB
  let fetchMock: ReturnType<typeof vi.fn>;

  const ACCOUNT_ID = 'p333333';
  const DOMAIN_ID = 'domain-uuid-1';
  const DOMAIN_NAME = 'example.com';
  const PRINCIPAL_ID = 'dom-principal-1';

  const ZONE_FILE = [
    'example.com. 3600 IN MX 10 mail.example.com.',
    'mail.example.com. 3600 IN A 1.2.3.4',
    'example.com. 3600 IN TXT "v=spf1 mx ~all"',
  ].join('\n');

  function makePrincipalGetResponse(dnsZoneFile: string | null) {
    return {
      methodResponses: [[
        'Principal/get',
        {
          accountId: ACCOUNT_ID,
          state: 'state-001',
          list: dnsZoneFile !== null ? [{
            id: PRINCIPAL_ID,
            type: 'domain',
            name: DOMAIN_NAME,
            dnsZoneFile,
          }] : [],
          notFound: dnsZoneFile === null ? [PRINCIPAL_ID] : [],
        },
        'c0',
      ]],
      sessionState: 'state-001',
    };
  }

  // Minimal DB mock
  function makeDb(existingRecords: Array<{
    id: string;
    domainId: string;
    recordType: string;
    recordName: string;
    recordValue: string;
    ttl: number;
    priority: number | null;
    weight: number | null;
    port: number | null;
  }> = []) {
    const insertedRows: typeof existingRecords = [];
    const deletedIds: string[] = [];

    return {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(existingRecords),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockReturnThis(),
      _insertedRows: insertedRows,
      _deletedIds: deletedIds,
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('inserts records that are in zone file but not in DB', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makePrincipalGetResponse(ZONE_FILE)),
    });

    const insertedRows: object[] = [];
    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve([]), // no existing records
      insert: () => db,
      values: (row: object) => {
        insertedRows.push(row);
        return Promise.resolve();
      },
      delete: () => db,
    } as unknown as Parameters<typeof syncDomainDnsRecords>[0]['db'];

    // Mock syncRecordToProviders to be a no-op
    vi.mock('../dns-records/service.js', () => ({
      syncRecordToProviders: vi.fn().mockResolvedValue(undefined),
    }));

    const result = await syncDomainDnsRecords({
      db,
      domainId: DOMAIN_ID,
      domainName: DOMAIN_NAME,
      jmapAccountId: ACCOUNT_ID,
      stalwartDomainPrincipalId: PRINCIPAL_ID,
      baseUrl: 'http://test:8080',
      env: { STALWART_ADMIN_PASSWORD: 'pw' },
    });

    expect(result.added).toBe(3); // MX + A + TXT
    expect(result.removed).toBe(0);
  });

  it('returns 0/0 when zone file is null', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        methodResponses: [[
          'Principal/get',
          {
            accountId: ACCOUNT_ID,
            state: 'state-001',
            list: [{ id: PRINCIPAL_ID, type: 'domain', name: DOMAIN_NAME, dnsZoneFile: null }],
            notFound: [],
          },
          'c0',
        ]],
        sessionState: 'state-001',
      }),
    });

    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve([]),
      insert: () => db,
      values: () => Promise.resolve(),
      delete: () => db,
    } as unknown as Parameters<typeof syncDomainDnsRecords>[0]['db'];

    const result = await syncDomainDnsRecords({
      db,
      domainId: DOMAIN_ID,
      domainName: DOMAIN_NAME,
      jmapAccountId: ACCOUNT_ID,
      stalwartDomainPrincipalId: PRINCIPAL_ID,
      baseUrl: 'http://test:8080',
      env: { STALWART_ADMIN_PASSWORD: 'pw' },
    });

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('skips records already in DB (idempotency)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makePrincipalGetResponse(ZONE_FILE)),
    });

    // DB already has all 3 records
    const existing = [
      { id: 'r1', domainId: DOMAIN_ID, recordType: 'MX', recordName: 'example.com', recordValue: 'mail.example.com', ttl: 3600, priority: 10, weight: null, port: null },
      { id: 'r2', domainId: DOMAIN_ID, recordType: 'A', recordName: 'mail.example.com', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null },
      { id: 'r3', domainId: DOMAIN_ID, recordType: 'TXT', recordName: 'example.com', recordValue: 'v=spf1 mx ~all', ttl: 3600, priority: null, weight: null, port: null },
    ];

    let insertCalled = 0;
    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve(existing),
      insert: () => { insertCalled++; return db; },
      values: () => Promise.resolve(),
      delete: () => db,
    } as unknown as Parameters<typeof syncDomainDnsRecords>[0]['db'];

    const result = await syncDomainDnsRecords({
      db,
      domainId: DOMAIN_ID,
      domainName: DOMAIN_NAME,
      jmapAccountId: ACCOUNT_ID,
      stalwartDomainPrincipalId: PRINCIPAL_ID,
      baseUrl: 'http://test:8080',
      env: { STALWART_ADMIN_PASSWORD: 'pw' },
    });

    expect(result.added).toBe(0);
    expect(insertCalled).toBe(0);
  });

  it('removes stalwart-owned records that disappeared from zone file', async () => {
    // Zone file now only has MX (A and TXT were removed)
    const smallZone = 'example.com. 3600 IN MX 10 mail.example.com.';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makePrincipalGetResponse(smallZone)),
    });

    const existing = [
      { id: 'r1', domainId: DOMAIN_ID, recordType: 'MX', recordName: 'example.com', recordValue: 'mail.example.com', ttl: 3600, priority: 10, weight: null, port: null },
      { id: 'r2', domainId: DOMAIN_ID, recordType: 'A', recordName: 'mail.example.com', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null },
      { id: 'r3', domainId: DOMAIN_ID, recordType: 'TXT', recordName: 'example.com', recordValue: 'v=spf1 mx ~all', ttl: 3600, priority: null, weight: null, port: null },
    ];

    const deletedIds: string[] = [];
    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve(existing),
      insert: () => db,
      values: () => Promise.resolve(),
      delete: () => ({
        where: (condition: unknown) => {
          // Capture the IDs being deleted — simplified tracking
          deletedIds.push('deleted');
          return Promise.resolve();
        },
      }),
    } as unknown as Parameters<typeof syncDomainDnsRecords>[0]['db'];

    const result = await syncDomainDnsRecords({
      db,
      domainId: DOMAIN_ID,
      domainName: DOMAIN_NAME,
      jmapAccountId: ACCOUNT_ID,
      stalwartDomainPrincipalId: PRINCIPAL_ID,
      baseUrl: 'http://test:8080',
      env: { STALWART_ADMIN_PASSWORD: 'pw' },
    });

    // MX already in DB, A and TXT stalwart-owned should be removed
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
  });

  it('does NOT remove non-stalwart-owned records', async () => {
    const zone = 'example.com. 3600 IN MX 10 mail.example.com.';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(makePrincipalGetResponse(zone)),
    });

    // DB has MX (in zone) + webmail A (NOT owned by stalwart)
    const existing = [
      { id: 'r1', domainId: DOMAIN_ID, recordType: 'MX', recordName: 'example.com', recordValue: 'mail.example.com', ttl: 3600, priority: 10, weight: null, port: null },
      { id: 'r2', domainId: DOMAIN_ID, recordType: 'A', recordName: 'webmail.example.com', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null },
    ];

    let deleteCount = 0;
    const db = {
      select: () => db,
      from: () => db,
      where: () => Promise.resolve(existing),
      insert: () => db,
      values: () => Promise.resolve(),
      delete: () => ({
        where: () => {
          deleteCount++;
          return Promise.resolve();
        },
      }),
    } as unknown as Parameters<typeof syncDomainDnsRecords>[0]['db'];

    const result = await syncDomainDnsRecords({
      db,
      domainId: DOMAIN_ID,
      domainName: DOMAIN_NAME,
      jmapAccountId: ACCOUNT_ID,
      stalwartDomainPrincipalId: PRINCIPAL_ID,
      baseUrl: 'http://test:8080',
      env: { STALWART_ADMIN_PASSWORD: 'pw' },
    });

    // webmail A is not stalwart-owned, should not be removed
    expect(result.removed).toBe(0);
    expect(deleteCount).toBe(0);
  });
});
