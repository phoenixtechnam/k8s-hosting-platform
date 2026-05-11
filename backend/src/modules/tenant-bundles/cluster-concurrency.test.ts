/**
 * Unit tests for the cluster-wide tenant-bundle concurrency gate.
 *
 * We mock the `db` shape rather than spin pg-mem because:
 *   - The interesting logic is the cap check + wait loop + heartbeat,
 *     not the SQL semantics (which is one INSERT + one DELETE).
 *   - We want to assert exact call sequences (txact, count, INSERT).
 *
 * The actual SQL paths get end-to-end coverage from the staging
 * integration harness — the schema-shape risk is low (one table,
 * one PK, one index).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireGlobalSlot,
  ClusterGateError,
  reapStaleInFlight,
} from './cluster-concurrency.js';

interface MockDb {
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function makeDb(opts: {
  /** Sequence of counts returned by the count-SELECT in tryAcquireOnce. */
  countSequence: number[];
}): MockDb {
  let countIdx = 0;
  const txExecuteHandler = vi.fn(async (q: { queryChunks: unknown[] }) => {
    // Render an approximation of the SQL so the assertions can route on it.
    // The pg-driver Drizzle uses sticks the literal text in the first
    // chunk's `.value[0]`; the rest are template parameters.
    const text = renderSqlText(q);
    if (/pg_advisory_xact_lock/.test(text)) {
      return { rows: [] };
    }
    if (/SELECT COUNT/.test(text)) {
      const n = opts.countSequence[Math.min(countIdx, opts.countSequence.length - 1)] ?? 0;
      countIdx += 1;
      return { rows: [{ n }] };
    }
    if (/INSERT INTO tenant_bundle_in_flight/.test(text)) {
      return { rows: [] };
    }
    if (/UPDATE tenant_bundle_in_flight/.test(text)) {
      // heartbeat
      return { rows: [] };
    }
    if (/DELETE FROM tenant_bundle_in_flight/.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const transaction = vi.fn(async (cb: (tx: { execute: typeof txExecuteHandler }) => Promise<unknown>) => {
    return cb({ execute: txExecuteHandler });
  });

  const execute = vi.fn(async (q: { queryChunks: unknown[] }) => {
    const text = renderSqlText(q);
    if (/DELETE FROM tenant_bundle_in_flight/.test(text)) {
      return { rows: [] };
    }
    if (/UPDATE tenant_bundle_in_flight/.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { transaction, execute } as unknown as MockDb;
}

function renderSqlText(q: { queryChunks: unknown[] }): string {
  // Drizzle's tagged-template chunks: walk and stringify text-y bits.
  let out = '';
  const walk = (chunks: unknown[]): void => {
    for (const c of chunks) {
      if (c && typeof c === 'object' && 'queryChunks' in c) {
        walk((c as { queryChunks: unknown[] }).queryChunks);
        continue;
      }
      if (c && typeof c === 'object' && 'value' in c) {
        const v = (c as { value: unknown }).value;
        if (Array.isArray(v) && typeof v[0] === 'string') out += v[0];
        else if (typeof v === 'string') out += v;
      }
    }
  };
  walk(q.queryChunks);
  return out;
}

describe('acquireGlobalSlot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when globalMaxInFlight <= 0 (gate disabled)', async () => {
    const db = makeDb({ countSequence: [] });
    const handle = await acquireGlobalSlot(db as never, {
      bundleId: 'bkp-x',
      component: 'files',
      globalMaxInFlight: 0,
    });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    await handle.release();
    // Even after release, no SQL fired.
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('acquires immediately when count < cap', async () => {
    const db = makeDb({ countSequence: [2] }); // 2 < cap=4
    const handle = await acquireGlobalSlot(db as never, {
      bundleId: 'bkp-x',
      component: 'files',
      globalMaxInFlight: 4,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(handle.bundleId).toBe('bkp-x');
    expect(handle.component).toBe('files');
    await handle.release();
  });

  it('release runs DELETE exactly once even when called twice', async () => {
    const db = makeDb({ countSequence: [0] });
    const handle = await acquireGlobalSlot(db as never, {
      bundleId: 'bkp-y',
      component: 'mailboxes',
      globalMaxInFlight: 4,
    });
    const beforeReleaseCalls = db.execute.mock.calls.length;
    await handle.release();
    const afterFirst = db.execute.mock.calls.length;
    await handle.release();
    const afterSecond = db.execute.mock.calls.length;
    expect(afterFirst - beforeReleaseCalls).toBe(1); // one DELETE
    expect(afterSecond - afterFirst).toBe(0);        // second call is no-op
  });

  it('rejects with CLUSTER_GATE_ABORTED when abortSignal fires while queued', async () => {
    // count returns 4 forever — always full
    const db = makeDb({ countSequence: Array(20).fill(4) });
    const ac = new AbortController();
    const promise = acquireGlobalSlot(db as never, {
      bundleId: 'bkp-z',
      component: 'files',
      globalMaxInFlight: 4,
      abortSignal: ac.signal,
    });
    // Settle the promise into a Result before the timers fire — avoids
    // the dual-await pattern that produced an unhandled-rejection warning.
    const settled = promise.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    await vi.advanceTimersByTimeAsync(50);
    ac.abort();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(ClusterGateError);
      expect((result.err as ClusterGateError).code).toBe('CLUSTER_GATE_ABORTED');
    }
  });

  it('rejects with CLUSTER_GATE_TIMEOUT when cap stays full past the deadline', async () => {
    const db = makeDb({ countSequence: Array(20).fill(4) });
    const promise = acquireGlobalSlot(db as never, {
      bundleId: 'bkp-t',
      component: 'files',
      globalMaxInFlight: 4,
      acquireTimeoutMs: 100,
    });
    // Catch the rejection on the next microtask BEFORE running timers,
    // so the fake-timer advance doesn't outrun the deadline check.
    const settled = promise.then(
      () => ({ ok: true }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    // Drive the loop past the deadline.
    await vi.advanceTimersByTimeAsync(2000);
    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(ClusterGateError);
      expect((result.err as ClusterGateError).code).toBe('CLUSTER_GATE_TIMEOUT');
    }
  });
});

describe('reapStaleInFlight', () => {
  it('runs a single DELETE and returns the affected row count', async () => {
    const db = {
      execute: vi.fn(async (q: { queryChunks: unknown[] }) => {
        const text = renderSqlText(q);
        expect(text).toMatch(/DELETE FROM tenant_bundle_in_flight/);
        expect(text).toMatch(/refreshed_at <\s*NOW\(\)/);
        return { rows: [{ bundle_id: 'bkp-a' }, { bundle_id: 'bkp-b' }] };
      }),
    };
    const n = await reapStaleInFlight(db as never);
    expect(n).toBe(2);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});
