import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pvCleanupReleasedHook } from './pv-cleanup-released.js';
import type { HookCtx } from '../registry/index.js';

interface PvLite {
  metadata?: { name?: string };
  spec?: { claimRef?: { namespace?: string } };
  status?: { phase?: string };
}

function makeCtx(opts: {
  pvSequence: PvLite[][];
  deletedPvs?: string[];
  deletedLhVolumes?: string[];
  pvDeleteThrows?: Error;
}): HookCtx {
  let pvCallCount = 0;
  const k8s = {
    core: {
      listPersistentVolume: vi.fn().mockImplementation(async () => {
        const idx = Math.min(pvCallCount, opts.pvSequence.length - 1);
        pvCallCount++;
        return { items: opts.pvSequence[idx] };
      }),
      deletePersistentVolume: vi.fn().mockImplementation(async (req: { name: string }) => {
        if (opts.pvDeleteThrows) throw opts.pvDeleteThrows;
        opts.deletedPvs?.push(req.name);
        return {};
      }),
    },
    custom: {
      deleteNamespacedCustomObject: vi.fn().mockImplementation(async (req: { name: string }) => {
        opts.deletedLhVolumes?.push(req.name);
        return {};
      }),
    },
  };
  return {
    db: {} as never,
    k8s: k8s as never,
    clientId: 'c1',
    namespace: 'client-test',
    transitionId: 't1',
    transition: 'deleted',
    attempt: 1,
  };
}

describe('pv-cleanup-released hook', () => {
  beforeEach(() => vi.useRealTimers());

  it('returns noop when no PVs claim the namespace', async () => {
    const ctx = makeCtx({ pvSequence: [[]] });
    const result = await pvCleanupReleasedHook.run(ctx);
    expect(result.status).toBe('noop');
  });

  it('reaps a Released PV + its matching Longhorn volume', async () => {
    const deletedPvs: string[] = [];
    const deletedLh: string[] = [];
    const ctx = makeCtx({
      pvSequence: [[
        {
          metadata: { name: 'pvc-released-1' },
          spec: { claimRef: { namespace: 'client-test' } },
          status: { phase: 'Released' },
        },
      ]],
      deletedPvs,
      deletedLhVolumes: deletedLh,
    });
    const result = await pvCleanupReleasedHook.run(ctx);
    expect(result.status).toBe('ok');
    expect(deletedPvs).toEqual(['pvc-released-1']);
    expect(deletedLh).toEqual(['pvc-released-1']);
  });

  it('discovers a late-binding PV across multiple poll cycles', async () => {
    vi.useFakeTimers();
    const deletedPvs: string[] = [];
    // First scan (pre-snapshot): empty. Subsequent in-loop scans:
    // Bound, Bound, Bound, Released (so the empty-poll grace doesn't
    // exit early — once Bound appears, the grace counter resets).
    const ctx = makeCtx({
      pvSequence: [
        [],
        [{ metadata: { name: 'pvc-late' }, spec: { claimRef: { namespace: 'client-test' } }, status: { phase: 'Bound' } }],
        [{ metadata: { name: 'pvc-late' }, spec: { claimRef: { namespace: 'client-test' } }, status: { phase: 'Bound' } }],
        [{ metadata: { name: 'pvc-late' }, spec: { claimRef: { namespace: 'client-test' } }, status: { phase: 'Released' } }],
      ],
      deletedPvs,
      deletedLhVolumes: [],
    });
    const promise = pvCleanupReleasedHook.run(ctx);
    // Drive past 4 in-loop polls (8 s). pvSequence's last entry sticks
    // (Math.min in makeCtx) so any further polls keep returning Released.
    // 2_000 mirrors POLL_INTERVAL_MS in the hook.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result.status).toBe('ok');
    expect(deletedPvs).toEqual(['pvc-late']);
  });

  it('signals retry when PVs never reach Released within the window', async () => {
    // Mock the time so the poll loop exits quickly.
    vi.useFakeTimers();
    const ctx = makeCtx({
      pvSequence: [[
        {
          metadata: { name: 'pvc-stuck' },
          spec: { claimRef: { namespace: 'client-test' } },
          status: { phase: 'Bound' }, // never transitions
        },
      ]],
      deletedPvs: [],
      deletedLhVolumes: [],
    });

    // Drive timers forward past the 60s window. We advance in chunks so
    // every scheduled `setTimeout(2000)` fires.
    const promise = pvCleanupReleasedHook.run(ctx);
    for (let i = 0; i < 35; i++) {
      await vi.advanceTimersByTimeAsync(2_000);
    }
    const result = await promise;
    expect(result.status).toBe('retry');
    expect(result.envelope?.title).toContain('PV cleanup');
  });

  it('returns failed with envelope when PV delete throws an unexpected error', async () => {
    const ctx = makeCtx({
      pvSequence: [[
        {
          metadata: { name: 'pvc-busted' },
          spec: { claimRef: { namespace: 'client-test' } },
          status: { phase: 'Released' },
        },
      ]],
      pvDeleteThrows: Object.assign(new Error('forbidden'), { statusCode: 403 }),
    });
    const result = await pvCleanupReleasedHook.run(ctx);
    expect(result.status).toBe('failed');
    expect(result.envelope?.title).toBe('PV cleanup failed');
    expect(result.envelope?.detail).toContain('forbidden');
  });

  it('treats a 404 from PV delete as a noop (idempotent)', async () => {
    const deletedLh: string[] = [];
    const ctx = makeCtx({
      pvSequence: [[
        {
          metadata: { name: 'pvc-already-gone' },
          spec: { claimRef: { namespace: 'client-test' } },
          status: { phase: 'Released' },
        },
      ]],
      pvDeleteThrows: Object.assign(new Error('not found'), { statusCode: 404 }),
      deletedLhVolumes: deletedLh,
    });
    const result = await pvCleanupReleasedHook.run(ctx);
    // 404 on PV is harmless; the Longhorn delete still runs.
    expect(result.status).toBe('ok');
    expect(deletedLh).toEqual(['pvc-already-gone']);
  });
});
