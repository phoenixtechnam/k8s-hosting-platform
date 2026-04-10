import { describe, it, expect, vi } from 'vitest';
import { suspendExpiredClients } from './expiry-checker.js';

function createMockDb(returnedRows: Array<{ id: string }>) {
  const returningFn = vi.fn().mockResolvedValue(returnedRows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });

  return {
    update: updateFn,
    _setFn: setFn,
    _whereFn: whereFn,
    _returningFn: returningFn,
  } as unknown as Parameters<typeof suspendExpiredClients>[0] & {
    _setFn: ReturnType<typeof vi.fn>;
    _whereFn: ReturnType<typeof vi.fn>;
    _returningFn: ReturnType<typeof vi.fn>;
  };
}

describe('suspendExpiredClients', () => {
  it('should return count of suspended clients when expired clients exist', async () => {
    const db = createMockDb([{ id: '1' }, { id: '2' }, { id: '3' }]);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(3);
  });

  it('should return 0 when no expired clients exist', async () => {
    const db = createMockDb([]);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });

  it('should call update with status suspended and updatedAt', async () => {
    const db = createMockDb([{ id: '1' }]);
    await suspendExpiredClients(db);
    const setArg = db._setFn.mock.calls[0][0];
    expect(setArg.status).toBe('suspended');
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it('should return 0 when returning gives empty array', async () => {
    const returningFn = vi.fn().mockResolvedValue([]);
    const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    const updateFn = vi.fn().mockReturnValue({ set: setFn });

    const db = { update: updateFn } as unknown as Parameters<typeof suspendExpiredClients>[0];
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });
});
