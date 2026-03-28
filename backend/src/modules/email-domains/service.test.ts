import { describe, it, expect, vi } from 'vitest';
import { enableEmailForDomain, disableEmailForDomain, getEmailDomain, listEmailDomains, updateEmailDomain } from './service.js';

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
  maxMailboxes: 50,
  maxQuotaMb: 10240,
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
    const result = await enableEmailForDomain(db, 'c1', 'd1', { max_mailboxes: 50, max_quota_mb: 10240 }, '0'.repeat(64));

    expect(result).toBeDefined();
    expect((db as any)._mocks.insertFn).toHaveBeenCalled();
  });

  it('should return existing record when already enabled (idempotent)', async () => {
    const db = createMockDb({ emailDomainResult: [EMAIL_DOMAIN] });
    const result = await enableEmailForDomain(db, 'c1', 'd1', { max_mailboxes: 50, max_quota_mb: 10240 }, '0'.repeat(64));

    expect(result).toBeDefined();
    expect(result.domainName).toBe('example.com');
    // insert should not be called for idempotent case
  });

  it('should throw DOMAIN_NOT_FOUND for non-existent domain', async () => {
    const db = createMockDb({ domainResult: [] });
    await expect(
      enableEmailForDomain(db, 'c1', 'missing', { max_mailboxes: 50, max_quota_mb: 10240 }, '0'.repeat(64)),
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
      return Promise.resolve([{ ...EMAIL_DOMAIN, maxMailboxes: 100 }]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof updateEmailDomain>[0];
    const result = await updateEmailDomain(db, 'c1', 'd1', { max_mailboxes: 100 });

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
    await expect(updateEmailDomain(db, 'c1', 'd1', { max_mailboxes: 100 })).rejects.toMatchObject({
      code: 'EMAIL_DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});
