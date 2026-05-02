import { describe, it, expect, vi } from 'vitest';
import { getDomainById, updateDomain, deleteDomain, setDomainVerificationStatus } from './service.js';
import { ApiError } from '../../shared/errors.js';

// service.ts imports drizzle-orm at top level — mock so tests can run without the package
vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({ _tag: 'eq' }),
  and: vi.fn((...args: unknown[]) => ({ _tag: 'and', args })),
  like: vi.fn().mockReturnValue({ _tag: 'like' }),
  desc: vi.fn().mockReturnValue({ _tag: 'desc' }),
  asc: vi.fn().mockReturnValue({ _tag: 'asc' }),
  lt: vi.fn().mockReturnValue({ _tag: 'lt' }),
  gt: vi.fn().mockReturnValue({ _tag: 'gt' }),
  sql: vi.fn().mockReturnValue({ _tag: 'sql' }),
  inArray: vi.fn().mockReturnValue({ _tag: 'inArray' }),
  isNull: vi.fn().mockReturnValue({ _tag: 'isNull' }),
  not: vi.fn().mockReturnValue({ _tag: 'not' }),
  or: vi.fn().mockReturnValue({ _tag: 'or' }),
}));

vi.mock('../../db/schema.js', () => ({
  domains: {
    id: 'id', status: 'status', verifiedAt: 'verifiedAt', clientId: 'clientId',
    domainName: 'domainName', dnsMode: 'dnsMode', verificationCacheAt: 'verificationCacheAt',
    createdAt: 'createdAt',
  },
  dnsRecords: { id: 'id', domainId: 'domainId', recordType: 'recordType', recordName: 'recordName' },
  emailDomains: { id: 'id', domainId: 'domainId', webmailEnabled: 'webmailEnabled' },
  mailboxes: { id: 'id', emailDomainId: 'emailDomainId', fullAddress: 'fullAddress' },
  emailAliases: { id: 'id', emailDomainId: 'emailDomainId', sourceAddress: 'sourceAddress' },
  ingressRoutes: { id: 'id', domainId: 'domainId', hostname: 'hostname' },
  sslCertificates: { domainId: 'domainId', issuer: 'issuer', subject: 'subject', expiresAt: 'expiresAt' },
}));

vi.mock('./k8s-ingress.js', () => ({ reconcileIngress: vi.fn() }));
vi.mock('../certificates/service.js', () => ({ deleteDomainCertificate: vi.fn(), ensureDomainCertificate: vi.fn() }));
vi.mock('../ingress-routes/service.js', () => ({ createRoute: vi.fn(), getIngressSettings: vi.fn() }));
vi.mock('../email-domains/service.js', () => ({ removeWebmailIngress: vi.fn() }));
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: vi.fn().mockResolvedValue([]),
  getProviderForServer: vi.fn(),
  getDefaultGroup: vi.fn().mockResolvedValue(null),
  getPrimaryServersForGroup: vi.fn().mockResolvedValue([]),
  getActiveServers: vi.fn().mockResolvedValue([]),
  getProviderGroupById: vi.fn().mockResolvedValue({ id: 'g1', nsHostnames: [] }),
}));

// We need to mock getClientById which is imported by domains/service
vi.mock('../clients/service.js', () => ({
  getClientById: vi.fn().mockResolvedValue({ id: 'c1', companyName: 'Acme' }),
}));

function createMockDb(selectResult: unknown[] = []) {
  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof getDomainById>[0];
}

describe('getDomainById', () => {
  it('should return domain when found', async () => {
    const domain = { id: 'd1', clientId: 'c1', domainName: 'example.com' };
    const db = createMockDb([domain]);

    const result = await getDomainById(db, 'c1', 'd1');
    expect(result).toEqual(domain);
  });

  it('should throw DOMAIN_NOT_FOUND when not found', async () => {
    const db = createMockDb([]);

    await expect(getDomainById(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(getDomainById(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateDomain', () => {
  it('should update and return the domain', async () => {
    const domain = { id: 'd1', clientId: 'c1', domainName: 'example.com' };

    const whereFn = vi.fn().mockResolvedValue([domain]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateDomain>[0];

    const result = await updateDomain(db, 'c1', 'd1', { dns_mode: 'primary' });
    expect(result).toEqual(domain);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should skip update when no fields provided', async () => {
    const domain = { id: 'd1', clientId: 'c1', domainName: 'example.com' };

    const whereFn = vi.fn().mockResolvedValue([domain]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn();

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateDomain>[0];

    const result = await updateDomain(db, 'c1', 'd1', {});
    expect(result).toEqual(domain);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it('should convert ssl_auto_renew boolean to number', async () => {
    const domain = { id: 'd1', clientId: 'c1', domainName: 'example.com' };

    const whereFn = vi.fn().mockResolvedValue([domain]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateDomain>[0];

    await updateDomain(db, 'c1', 'd1', { ssl_auto_renew: true });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ sslAutoRenew: 1 }));

    await updateDomain(db, 'c1', 'd1', { ssl_auto_renew: false });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ sslAutoRenew: 0 }));
  });
});

describe('deleteDomain', () => {
  it('should delete when domain exists', async () => {
    const domain = { id: 'd1', clientId: 'c1' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([domain]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteDomain>[0];

    await deleteDomain(db, 'c1', 'd1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw DOMAIN_NOT_FOUND when domain missing', async () => {
    const db = createMockDb([]);

    await expect(deleteDomain(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
    });
  });
});

// ─── setDomainVerificationStatus ─────────────────────────────────────────────

function createVerifyDb(domainRow: {
  status: string;
  verifiedAt: Date | null;
} | null) {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  // First select call returns the domain row; further calls (inside update) just return row
  const whereFn = vi.fn().mockResolvedValue(domainRow ? [domainRow] : []);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return {
    db: { select: selectFn, update: updateFn } as unknown as Parameters<typeof setDomainVerificationStatus>[0],
    updateSet,
  };
}

const passResult = { verified: true, checks: [] };
const failResult = { verified: false, checks: [{ type: 'cname_to_ingress', status: 'fail' as const, detail: 'no match' }] };

describe('setDomainVerificationStatus', () => {
  it('first_pass: unverified → verified, verifiedAt was null', async () => {
    const { db, updateSet } = createVerifyDb({ status: 'unverified', verifiedAt: null });
    const result = await setDomainVerificationStatus(db, 'd1', passResult);
    expect(result.transition).toBe('first_pass');
    expect(result.newStatus).toBe('verified');
    expect(result.previousStatus).toBe('unverified');
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ verifiedAt: expect.any(Date) }));
  });

  it('first_pass: pending → verified, verifiedAt was null', async () => {
    const { db } = createVerifyDb({ status: 'pending', verifiedAt: null });
    const result = await setDomainVerificationStatus(db, 'd1', passResult);
    expect(result.transition).toBe('first_pass');
  });

  it('recovery: unverified → verified, verifiedAt already set', async () => {
    const { db, updateSet } = createVerifyDb({ status: 'unverified', verifiedAt: new Date('2026-01-01') });
    const result = await setDomainVerificationStatus(db, 'd1', passResult);
    expect(result.transition).toBe('recovery');
    expect(result.newStatus).toBe('verified');
    // verifiedAt should NOT be overwritten on recovery
    expect(updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ verifiedAt: expect.anything() }));
  });

  it('regression: verified → unverified', async () => {
    const { db } = createVerifyDb({ status: 'verified', verifiedAt: new Date('2026-01-01') });
    const result = await setDomainVerificationStatus(db, 'd1', failResult);
    expect(result.transition).toBe('regression');
    expect(result.newStatus).toBe('unverified');
    expect(result.previousStatus).toBe('verified');
  });

  it('first_fail: unverified → unverified, verifiedAt was null', async () => {
    const { db } = createVerifyDb({ status: 'unverified', verifiedAt: null });
    const result = await setDomainVerificationStatus(db, 'd1', failResult);
    expect(result.transition).toBe('first_fail');
    expect(result.newStatus).toBe('unverified');
  });

  it('no_change: verified → verified', async () => {
    const { db } = createVerifyDb({ status: 'verified', verifiedAt: new Date('2026-01-01') });
    const result = await setDomainVerificationStatus(db, 'd1', passResult);
    expect(result.transition).toBe('no_change');
    expect(result.newStatus).toBe('verified');
  });

  it('no_change: unverified → unverified, verifiedAt already set (silent re-fail)', async () => {
    const { db } = createVerifyDb({ status: 'unverified', verifiedAt: new Date('2026-01-01') });
    const result = await setDomainVerificationStatus(db, 'd1', failResult);
    expect(result.transition).toBe('no_change');
  });

  it('throws DOMAIN_NOT_FOUND when domain missing', async () => {
    const { db } = createVerifyDb(null);
    await expect(setDomainVerificationStatus(db, 'missing', passResult)).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
    });
  });
});
