import { describe, it, expect, vi, beforeEach } from 'vitest';
import { suspendExpiredClients } from './expiry-checker.js';

/**
 * After the grace-period removal + cascades refactor, suspendExpiredClients:
 *   1. SELECTs candidate clients (status=active, expired)
 *   2. For each candidate, calls applySuspended() which runs ingress +
 *      mailbox + domain + cronJob cascades plus the status update.
 *
 * The unit test here exercises the candidate-selection + per-candidate
 * dispatch. `applySuspended` itself is covered in the
 * lifecycle.integration.test.ts against a real DB + k8s.
 */

function createMockDb(candidates: Array<{ id: string; namespace: string }>) {
  const whereFn = vi.fn().mockResolvedValue(candidates);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  // The `applySuspended` cascade is mocked at module boundary below, so
  // we don't need update/delete stubs — but leaving the shape minimal
  // matches the real Drizzle interface for future cascades.
  return {
    select: selectFn,
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    _whereFn: whereFn,
    _selectFn: selectFn,
  } as unknown as Parameters<typeof suspendExpiredClients>[0] & {
    _whereFn: ReturnType<typeof vi.fn>;
    _selectFn: ReturnType<typeof vi.fn>;
  };
}

// Mock the cross-namespace cascade module so the test stays unit-level.
vi.mock('../client-lifecycle/cascades.js', () => ({
  applySuspended: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({}),
}));

describe('suspendExpiredClients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns count of candidates when expired clients exist', async () => {
    const db = createMockDb([
      { id: '1', namespace: 'ns-1' },
      { id: '2', namespace: 'ns-2' },
      { id: '3', namespace: 'ns-3' },
    ]);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(3);
  });

  it('returns 0 when no expired clients exist', async () => {
    const db = createMockDb([]);
    const count = await suspendExpiredClients(db);
    expect(count).toBe(0);
  });

  it('invokes applySuspended for each candidate', async () => {
    const db = createMockDb([
      { id: 'c-1', namespace: 'ns-1' },
      { id: 'c-2', namespace: 'ns-2' },
    ]);
    const cascades = await import('../client-lifecycle/cascades.js');
    await suspendExpiredClients(db);
    expect(cascades.applySuspended).toHaveBeenCalledTimes(2);
    expect(cascades.applySuspended).toHaveBeenCalledWith(expect.any(Object), 'c-1', 'ns-1');
    expect(cascades.applySuspended).toHaveBeenCalledWith(expect.any(Object), 'c-2', 'ns-2');
  });

  it('continues past a failing cascade so one bad client does not stall the cron', async () => {
    const db = createMockDb([
      { id: 'fail', namespace: 'ns-fail' },
      { id: 'ok', namespace: 'ns-ok' },
    ]);
    const cascades = await import('../client-lifecycle/cascades.js');
    (cascades.applySuspended as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => { throw new Error('cascade down'); })
      .mockResolvedValueOnce(undefined);
    const count = await suspendExpiredClients(db);
    // Count reflects candidates picked up; the fatal cascade for `fail`
    // is logged but doesn't abort the loop.
    expect(count).toBe(2);
    expect(cascades.applySuspended).toHaveBeenCalledTimes(2);
  });
});
