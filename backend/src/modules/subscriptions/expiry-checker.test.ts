import { describe, it, expect, vi } from 'vitest';
import { suspendExpiredClients } from './expiry-checker.js';

function createMockDb(affectedRows: number) {
  const whereFn = vi.fn().mockResolvedValue([{ affectedRows }]);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });

  return {
    update: updateFn,
    _setFn: setFn,
    _whereFn: whereFn,
  } as unknown as Parameters<typeof suspendExpiredClients>[0] & {
    _setFn: ReturnType<typeof vi.fn>;
    _whereFn: ReturnType<typeof vi.fn>;
  };
}

describe('suspendExpiredClients', () => {
  it('should return count of suspended clients when expired clients exist', async () => {
    const db = createMockDb(3);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(3);
  });

  it('should return 0 when no expired clients exist', async () => {
    const db = createMockDb(0);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });

  it('should call update with status suspended', async () => {
    const db = createMockDb(1);
    await suspendExpiredClients(db);
    expect(db._setFn).toHaveBeenCalledWith({ status: 'suspended' });
  });

  it('should handle missing affectedRows gracefully', async () => {
    const whereFn = vi.fn().mockResolvedValue([{}]);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    const updateFn = vi.fn().mockReturnValue({ set: setFn });

    const db = { update: updateFn } as unknown as Parameters<typeof suspendExpiredClients>[0];
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });

  it('should handle empty result array gracefully', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    const updateFn = vi.fn().mockReturnValue({ set: setFn });

    const db = { update: updateFn } as unknown as Parameters<typeof suspendExpiredClients>[0];
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });
});
