import { describe, it, expect, vi } from 'vitest';
import { createBackup, listBackups, deleteBackup } from './service.js';
import { ApiError } from '../../shared/errors.js';

vi.mock('../clients/service.js', () => ({
  getClientById: vi.fn().mockResolvedValue({ id: 'c1', companyName: 'Acme' }),
}));

function createMockDb(selectResult: unknown[] = []) {
  const limitFn = vi.fn().mockResolvedValue(selectResult);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof createBackup>[0];
}

describe('createBackup', () => {
  it('should insert and return created backup', async () => {
    const created = { id: 'b1', clientId: 'c1', backupType: 'manual', status: 'pending' };

    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const whereFn = vi.fn().mockResolvedValue([created]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      insert: insertFn,
    } as unknown as Parameters<typeof createBackup>[0];

    const result = await createBackup(db, 'c1', {
      backup_type: 'manual',
      resource_type: 'full',
    });
    expect(result).toEqual(created);
    expect(insertFn).toHaveBeenCalled();
  });
});

describe('deleteBackup', () => {
  it('should throw BACKUP_NOT_FOUND when backup does not exist', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
    } as unknown as Parameters<typeof deleteBackup>[0];

    await expect(deleteBackup(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(deleteBackup(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
      status: 404,
    });
  });

  it('should delete when backup exists', async () => {
    const backup = { id: 'b1', clientId: 'c1' };
    const whereFn = vi.fn().mockResolvedValue([backup]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteBackup>[0];

    await deleteBackup(db, 'c1', 'b1');
    expect(deleteFn).toHaveBeenCalled();
  });
});
