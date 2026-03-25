import { describe, it, expect, vi } from 'vitest';
import { getDomainById, updateDomain, deleteDomain } from './service.js';
import { ApiError } from '../../shared/errors.js';

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
