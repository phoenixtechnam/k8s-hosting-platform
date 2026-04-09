import { describe, it, expect, vi } from 'vitest';
import { enableEmailForDomain, disableEmailForDomain, getEmailDomain, listEmailDomains, updateEmailDomain, getEmailDomainDisablePreview } from './service.js';

// Mock DKIM generation
vi.mock('./dkim.js', () => ({
  generateDkimKeyPair: () => ({
    privateKey: '-----BEGIN PRIVATE KEY-----\nMOCK_PRIVATE\n-----END PRIVATE KEY-----',
    publicKey: '-----BEGIN PUBLIC KEY-----\nMOCK_PUBLIC\n-----END PUBLIC KEY-----',
  }),
  formatDkimDnsValue: (pub: string) => 'v=DKIM1; k=rsa; p=MOCK_PUBLIC',
}));

// Mock encrypt
vi.mock('../oidc/crypto.js', () => ({
  encrypt: (plaintext: string, _key: string) => `encrypted:${plaintext.slice(0, 10)}`,
}));

// Mock DNS provisioning
vi.mock('./dns-provisioning.js', () => ({
  provisionEmailDns: vi.fn().mockResolvedValue(undefined),
  deprovisionEmailDns: vi.fn().mockResolvedValue(undefined),
}));

const DOMAIN = { id: 'd1', clientId: 'c1', domainName: 'example.com' };
const EMAIL_DOMAIN = {
  id: 'ed1',
  domainId: 'd1',
  clientId: 'c1',
  enabled: 1,
  dkimSelector: 'default',
  dkimPrivateKeyEncrypted: 'encrypted:test',
  dkimPublicKey: '-----BEGIN PUBLIC KEY-----\nMOCK_PUBLIC\n-----END PUBLIC KEY-----',
  catchAllAddress: null,
  mxProvisioned: 1,
  spfProvisioned: 1,
  dkimProvisioned: 1,
  dmarcProvisioned: 1,
  spamThresholdJunk: '5.0',
  spamThresholdReject: '10.0',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createMockDb(options: {
  domainResult?: unknown[];
  emailDomainResult?: unknown[];
  insertResult?: unknown;
  mailboxCountResult?: unknown[];
} = {}) {
  const { domainResult = [DOMAIN], emailDomainResult = [], mailboxCountResult = [{ count: 0 }] } = options;

  let selectCallCount = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    selectCallCount++;
    // First select is always domain ownership check
    if (selectCallCount === 1) return Promise.resolve(domainResult);
    // Second select is email domain lookup
    if (selectCallCount === 2) return Promise.resolve(emailDomainResult);
    // Third select is re-fetch after insert
    return Promise.resolve(emailDomainResult.length > 0 ? emailDomainResult : [EMAIL_DOMAIN]);
  });

  const innerJoinWhere = vi.fn().mockImplementation(() => {
    return Promise.resolve(emailDomainResult);
  });
  const innerJoinFn = vi.fn().mockReturnValue({ where: innerJoinWhere });
  const fromFn = vi.fn().mockImplementation(() => ({
    where: whereFn,
    innerJoin: innerJoinFn,
  }));
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _mocks: { selectFn, insertFn, updateFn, deleteFn, whereFn },
  } as unknown as Parameters<typeof enableEmailForDomain>[0] & { _mocks: Record<string, ReturnType<typeof vi.fn>> };
}

describe('enableEmailForDomain', () => {
  it('should generate DKIM keys and create email domain record', async () => {
    const db = createMockDb();
    const result = await enableEmailForDomain(db, 'c1', 'd1', {}, '0'.repeat(64));

    expect(result).toBeDefined();
    expect((db as any)._mocks.insertFn).toHaveBeenCalled();
  });

  it('should return existing record when already enabled (idempotent)', async () => {
    const db = createMockDb({ emailDomainResult: [EMAIL_DOMAIN] });
    const result = await enableEmailForDomain(db, 'c1', 'd1', {}, '0'.repeat(64));

    expect(result).toBeDefined();
    expect(result.domainName).toBe('example.com');
    // insert should not be called for idempotent case
  });

  it('should throw DOMAIN_NOT_FOUND for non-existent domain', async () => {
    const db = createMockDb({ domainResult: [] });
    await expect(
      enableEmailForDomain(db, 'c1', 'missing', {}, '0'.repeat(64)),
    ).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('disableEmailForDomain', () => {
  it('should delete email domain record', async () => {
    const db = createMockDb({ emailDomainResult: [EMAIL_DOMAIN] });
    await disableEmailForDomain(db, 'c1', 'd1');
    expect((db as any)._mocks.deleteFn).toHaveBeenCalled();
  });

  it('should throw EMAIL_DOMAIN_NOT_FOUND when not enabled', async () => {
    const db = createMockDb({ emailDomainResult: [] });
    await expect(disableEmailForDomain(db, 'c1', 'd1')).rejects.toMatchObject({
      code: 'EMAIL_DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('getEmailDomain', () => {
  it('should throw DOMAIN_NOT_FOUND for invalid domain', async () => {
    const db = createMockDb({ domainResult: [] });
    await expect(getEmailDomain(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('listEmailDomains', () => {
  it('should return email domains for client', async () => {
    const emailDomainWithJoin = { ...EMAIL_DOMAIN, domainName: 'example.com', mailboxCount: 0 };
    const innerJoinWhere = vi.fn().mockResolvedValue([emailDomainWithJoin]);
    const innerJoinFn = vi.fn().mockReturnValue({ where: innerJoinWhere });
    const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Parameters<typeof listEmailDomains>[0];
    const results = await listEmailDomains(db, 'c1');

    expect(results).toHaveLength(1);
    expect(results[0].domainName).toBe('example.com');
  });
});

describe('updateEmailDomain', () => {
  it('should update email domain settings', async () => {
    let selectCallCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return Promise.resolve([DOMAIN]);
      if (selectCallCount === 2) return Promise.resolve([EMAIL_DOMAIN]);
      return Promise.resolve([{ ...EMAIL_DOMAIN, catchAllAddress: 'postmaster@example.com' }]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateEmailDomain>[0];
    const result = await updateEmailDomain(db, 'c1', 'd1', {
      catch_all_address: 'postmaster@example.com',
    });

    expect(result).toBeDefined();
    expect(updateFn).toHaveBeenCalled();
  });

  it('should throw EMAIL_DOMAIN_NOT_FOUND when not enabled', async () => {
    let selectCallCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Parameters<typeof updateEmailDomain>[0];
    await expect(
      updateEmailDomain(db, 'c1', 'd1', { catch_all_address: 'postmaster@example.com' }),
    ).rejects.toMatchObject({
      code: 'EMAIL_DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

// ─── Round-4 Phase 1: getEmailDomainDisablePreview ─────────────────

describe('getEmailDomainDisablePreview', () => {
  function buildPreviewDb(rows: {
    domain?: unknown[];
    emailDomain?: unknown[];
    mailboxes?: unknown[];
    aliases?: unknown[];
    dkimKeys?: unknown[];
    dnsRecords?: unknown[];
  }) {
    let n = 0;
    const seq = [
      rows.domain ?? [DOMAIN], // verifyDomainOwnership
      rows.emailDomain ?? [], // join select for ed
      rows.mailboxes ?? [],
      rows.aliases ?? [],
      rows.dkimKeys ?? [],
      rows.dnsRecords ?? [],
    ];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve(seq[n++] ?? []));
    const innerJoinWhere = vi.fn().mockImplementation(() => Promise.resolve(seq[n++] ?? []));
    const innerJoinFn = vi.fn().mockReturnValue({ where: innerJoinWhere });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn, innerJoin: innerJoinFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return { select: selectFn } as unknown as Parameters<typeof getEmailDomainDisablePreview>[0];
  }

  it('returns the full enumeration of resources to be deleted when webmail is enabled', async () => {
    const db = buildPreviewDb({
      domain: [DOMAIN],
      emailDomain: [{ id: 'ed1', webmailEnabled: 1, domainName: 'example.com' }],
      mailboxes: [
        { id: 'mb1', fullAddress: 'alice@example.com' },
        { id: 'mb2', fullAddress: 'bob@example.com' },
      ],
      aliases: [{ id: 'a1', sourceAddress: 'info@example.com' }],
      dkimKeys: [{ id: 'k1', selector: 'default', status: 'active' }],
      dnsRecords: [
        { id: 'r1', type: 'MX', name: 'example.com', value: 'mail.example.com' },
        { id: 'r2', type: 'A', name: 'mail.example.com', value: '1.2.3.4' },
        { id: 'r3', type: 'A', name: 'webmail.example.com', value: '1.2.3.4' },
        { id: 'r4', type: 'TXT', name: 'example.com', value: 'v=spf1 mx ~all' },
        { id: 'r5', type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=quarantine' },
        { id: 'r6', type: 'TXT', name: 'default._domainkey.example.com', value: 'v=DKIM1; p=...' },
        { id: 'r7', type: 'TXT', name: '_mta-sts.example.com', value: 'v=STSv1; id=abc' },
        // Non-email rows that must be FILTERED OUT
        { id: 'r8', type: 'A', name: 'www.example.com', value: '1.2.3.4' },
        { id: 'r9', type: 'CNAME', name: 'mta-sts.example.com', value: 'host' },
        { id: 'r10', type: 'SRV', name: '_imaps._tcp.example.com', value: '0 1 993 host' },
      ],
    });

    const preview = await getEmailDomainDisablePreview(db, 'c1', 'd1');

    expect(preview.emailDomainId).toBe('ed1');
    expect(preview.domainName).toBe('example.com');
    expect(preview.mailboxes).toHaveLength(2);
    expect(preview.mailboxes[0].fullAddress).toBe('alice@example.com');
    expect(preview.aliases).toHaveLength(1);
    expect(preview.dkimKeys).toHaveLength(1);
    expect(preview.dkimKeys[0].selector).toBe('default');
    // 7 email records (MX, A mail, A webmail, SPF, DMARC, DKIM, MTA-STS); www, CNAME, SRV filtered out
    expect(preview.dnsRecords).toHaveLength(7);
    // Purpose mapping
    expect(preview.dnsRecords.find((r) => r.type === 'MX')?.purpose).toBe('mx');
    expect(preview.dnsRecords.find((r) => r.name === 'mail.example.com')?.purpose).toBe('mail_host');
    expect(preview.dnsRecords.find((r) => r.name === 'webmail.example.com')?.purpose).toBe('webmail');
    expect(preview.dnsRecords.find((r) => r.name === 'example.com' && r.type === 'TXT')?.purpose).toBe('spf');
    expect(preview.dnsRecords.find((r) => r.name === '_dmarc.example.com')?.purpose).toBe('dmarc');
    expect(preview.dnsRecords.find((r) => r.name === 'default._domainkey.example.com')?.purpose).toBe('dkim');
    expect(preview.dnsRecords.find((r) => r.name === '_mta-sts.example.com')?.purpose).toBe('mta_sts');

    expect(preview.webmailHostname).toBe('webmail.example.com');
  });

  it('returns null webmailHostname when webmail is disabled', async () => {
    const db = buildPreviewDb({
      domain: [DOMAIN],
      emailDomain: [{ id: 'ed1', webmailEnabled: 0, domainName: 'example.com' }],
      mailboxes: [],
      aliases: [],
      dkimKeys: [],
      dnsRecords: [],
    });

    const preview = await getEmailDomainDisablePreview(db, 'c1', 'd1');
    expect(preview.webmailHostname).toBeNull();
  });

  it('throws EMAIL_DOMAIN_NOT_FOUND when no email_domain row exists', async () => {
    const db = buildPreviewDb({
      domain: [DOMAIN],
      emailDomain: [],
    });

    await expect(getEmailDomainDisablePreview(db, 'c1', 'd1'))
      .rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_FOUND', status: 404 });
  });
});
