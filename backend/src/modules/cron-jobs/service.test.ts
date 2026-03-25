import { describe, it, expect, vi } from 'vitest';
import { getCronJobById, updateCronJob, deleteCronJob } from './service.js';
import { ApiError } from '../../shared/errors.js';

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
  } as unknown as Parameters<typeof getCronJobById>[0];
}

describe('getCronJobById', () => {
  it('should return cron job when found', async () => {
    const job = { id: 'j1', clientId: 'c1', name: 'cleanup' };
    const db = createMockDb([job]);

    const result = await getCronJobById(db, 'c1', 'j1');
    expect(result).toEqual(job);
  });

  it('should throw CRON_JOB_NOT_FOUND when not found', async () => {
    const db = createMockDb([]);

    await expect(getCronJobById(db, 'c1', 'missing')).rejects.toThrow(ApiError);
    await expect(getCronJobById(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'CRON_JOB_NOT_FOUND',
      status: 404,
    });
  });
});

describe('updateCronJob', () => {
  it('should update and return cron job', async () => {
    const job = { id: 'j1', clientId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    const result = await updateCronJob(db, 'c1', 'j1', { name: 'new-name' });
    expect(result).toEqual(job);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should convert enabled boolean to number', async () => {
    const job = { id: 'j1', clientId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    await updateCronJob(db, 'c1', 'j1', { enabled: false });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));

    await updateCronJob(db, 'c1', 'j1', { enabled: true });
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ enabled: 1 }));
  });

  it('should skip update when no fields provided', async () => {
    const job = { id: 'j1', clientId: 'c1', name: 'cleanup' };

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn();

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateCronJob>[0];

    const result = await updateCronJob(db, 'c1', 'j1', {});
    expect(result).toEqual(job);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe('deleteCronJob', () => {
  it('should delete when cron job exists', async () => {
    const job = { id: 'j1', clientId: 'c1' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([job]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteCronJob>[0];

    await deleteCronJob(db, 'c1', 'j1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw CRON_JOB_NOT_FOUND when cron job does not exist', async () => {
    const db = createMockDb([]);

    await expect(deleteCronJob(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'CRON_JOB_NOT_FOUND',
    });
  });
});
