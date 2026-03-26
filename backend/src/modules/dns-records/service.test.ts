import { describe, it, expect, vi } from 'vitest';
import { listDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from './service.js';
import { ApiError } from '../../shared/errors.js';

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
  } as unknown as Parameters<typeof listDnsRecords>[0];
}

const DOMAIN = { id: 'd1', clientId: 'c1', domainName: 'example.com' };
const RECORD = { id: 'r1', domainId: 'd1', recordType: 'A', recordName: '@', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null, updatedAt: new Date() };

describe('listDnsRecords', () => {
  it('should return records for a valid domain', async () => {
    const db = createMockDb([DOMAIN]);
    const result = await listDnsRecords(db, 'c1', 'd1');
    expect(result).toBeDefined();
  });

  it('should throw DOMAIN_NOT_FOUND for invalid domain', async () => {
    const db = createMockDb([]);
    await expect(listDnsRecords(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createDnsRecord', () => {
  it('should create and return a DNS record', async () => {
    // First call: verifyDomainOwnership returns domain
    // Second call: insert (returns void)
    // Third call: select created record
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([RECORD]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = { select: selectFn, insert: insertFn } as unknown as Parameters<typeof createDnsRecord>[0];

    const result = await createDnsRecord(db, 'c1', 'd1', {
      record_type: 'A',
      record_value: '1.2.3.4',
      ttl: 3600,
    });
    expect(result).toEqual(RECORD);
    expect(insertFn).toHaveBeenCalled();
  });

  it('should throw for invalid domain', async () => {
    const db = createMockDb([]);
    await expect(createDnsRecord(db, 'c1', 'missing', {
      record_type: 'A',
      record_value: '1.2.3.4',
    })).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });
});

describe('updateDnsRecord', () => {
  it('should throw DNS_RECORD_NOT_FOUND for missing record', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof updateDnsRecord>[0];

    await expect(updateDnsRecord(db, 'c1', 'd1', 'missing', { ttl: 7200 })).rejects.toMatchObject({
      code: 'DNS_RECORD_NOT_FOUND',
      status: 404,
    });
  });
});

describe('deleteDnsRecord', () => {
  it('should delete when record exists', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([RECORD]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const db = { select: selectFn, delete: deleteFn } as unknown as Parameters<typeof deleteDnsRecord>[0];
    await deleteDnsRecord(db, 'c1', 'd1', 'r1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw DNS_RECORD_NOT_FOUND for missing record', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof deleteDnsRecord>[0];

    await expect(deleteDnsRecord(db, 'c1', 'd1', 'missing')).rejects.toMatchObject({
      code: 'DNS_RECORD_NOT_FOUND',
    });
  });
});
