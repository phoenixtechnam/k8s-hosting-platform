import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bulkUpdateClientStatus } from './bulk.js';

const mockClients = new Map([
  ['c1', { id: 'c1', status: 'active' }],
  ['c2', { id: 'c2', status: 'active' }],
  ['c3', { id: 'c3', status: 'suspended' }],
]);

function createMockDb() {
  const setWhereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: setWhereFn });

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((..._args: unknown[]) => {
          // Simple mock: return based on the fact that we iterate through ids
          // We'll handle this by tracking call count
          return Promise.resolve([]);
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: setFn,
    }),
    _selectResults: [] as Array<Record<string, unknown>[]>,
    _callIndex: 0,
  };
}

describe('bulkUpdateClientStatus', () => {
  it('bulk suspend multiple clients', async () => {
    const selectWhereFn = vi.fn()
      .mockResolvedValueOnce([{ id: 'c1', status: 'active' }])
      .mockResolvedValueOnce([{ id: 'c2', status: 'active' }]);

    const updateSetWhereFn = vi.fn().mockResolvedValue(undefined);
    const updateSetFn = vi.fn().mockReturnValue({ where: updateSetWhereFn });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: selectWhereFn,
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: updateSetFn,
      }),
    } as any;

    const result = await bulkUpdateClientStatus(db, ['c1', 'c2'], 'suspend');

    expect(result.succeeded).toEqual(['c1', 'c2']);
    expect(result.failed).toHaveLength(0);
  });

  it('bulk reactivate multiple clients', async () => {
    const selectWhereFn = vi.fn()
      .mockResolvedValueOnce([{ id: 'c3', status: 'suspended' }])
      .mockResolvedValueOnce([{ id: 'c1', status: 'suspended' }]);

    const updateSetWhereFn = vi.fn().mockResolvedValue(undefined);
    const updateSetFn = vi.fn().mockReturnValue({ where: updateSetWhereFn });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: selectWhereFn,
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: updateSetFn,
      }),
    } as any;

    const result = await bulkUpdateClientStatus(db, ['c3', 'c1'], 'reactivate');

    expect(result.succeeded).toEqual(['c3', 'c1']);
    expect(result.failed).toHaveLength(0);
  });

  it('partial failure handling — not-found clients reported as failed', async () => {
    const selectWhereFn = vi.fn()
      .mockResolvedValueOnce([{ id: 'c1', status: 'active' }])
      .mockResolvedValueOnce([]) // not found
      .mockResolvedValueOnce([{ id: 'c3', status: 'active' }]);

    const updateSetWhereFn = vi.fn().mockResolvedValue(undefined);
    const updateSetFn = vi.fn().mockReturnValue({ where: updateSetWhereFn });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: selectWhereFn,
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: updateSetFn,
      }),
    } as any;

    const result = await bulkUpdateClientStatus(db, ['c1', 'missing-id', 'c3'], 'suspend');

    expect(result.succeeded).toEqual(['c1', 'c3']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe('missing-id');
    expect(result.failed[0].error).toContain('not found');
  });

  it('empty array returns empty results', async () => {
    const db = {} as any;
    const result = await bulkUpdateClientStatus(db, [], 'suspend');

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
