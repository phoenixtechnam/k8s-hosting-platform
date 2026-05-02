import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle-orm eq/and/lt/lte/isNotNull so the fake db can read
// the predicates without parsing real drizzle internals.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __pred: 'eq', col, val }),
    and: (...preds: unknown[]) => ({ __pred: 'and', preds }),
    lt: (col: unknown, val: unknown) => ({ __pred: 'lt', col, val }),
    lte: (col: unknown, val: unknown) => ({ __pred: 'lte', col, val }),
    isNotNull: (col: unknown) => ({ __pred: 'isNotNull', col }),
  };
});

import {
  runRetryTick,
  _resetBreakersForTests,
} from './scheduler.js';
import {
  registerLifecycleHook,
  _resetRegistryForTests,
  type HookResult,
} from './registry/index.js';
import {
  clientLifecycleHookRuns,
  clientLifecycleTransitions,
} from '../../db/schema.js';

interface FakeRun {
  id: string;
  transitionId: string;
  hookName: string;
  state: 'pending' | 'running' | 'ok' | 'noop' | 'failed';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  lastError?: Record<string, unknown> | null;
}
interface FakeTransition {
  id: string;
  clientId: string;
  transitionKind: 'active' | 'suspended' | 'archived' | 'restored' | 'deleted';
}

function makeFakeDb(opts: {
  runs: FakeRun[];
  transitions: FakeTransition[];
  clientNamespace?: string;
}) {
  const db = {
    select: (_cols?: unknown) => ({
      from: (table: unknown) => ({
        where: (_pred: unknown) => ({
          limit: async (_n: number) => {
            if (table === clientLifecycleHookRuns) {
              return opts.runs.filter((r) => r.state === 'failed' && r.nextAttemptAt && r.attempts < r.maxAttempts);
            }
            if (table === clientLifecycleTransitions) {
              return opts.transitions;
            }
            // clients table fallback for namespace lookup
            return [{ ns: opts.clientNamespace ?? 'client-test' }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (pred: { val?: string }) => {
          const id = pred?.val;
          if (table === clientLifecycleHookRuns) {
            const r = opts.runs.find((x) => x.id === id);
            if (r) Object.assign(r, patch);
          }
          return [];
        },
      }),
    }),
    delete: () => ({ where: async () => [] }),
    insert: () => ({ values: async () => [] }),
  };
  // Workaround: when the SELECT path is `.from(...).where(...).limit(...)`
  // (no .limit chain ending), our fake's where().limit() works. The
  // scheduler's main SELECT does .from().where().limit(50) — handled.
  return db;
}

describe('runRetryTick', () => {
  beforeEach(() => {
    _resetRegistryForTests();
    _resetBreakersForTests();
  });

  it('promotes a failed retry to ok when the hook returns ok', async () => {
    let called = 0;
    registerLifecycleHook({
      name: 'retry-good',
      transitions: ['deleted'],
      order: 100,
      blocking: 'continue',
      run: async () => { called++; return { status: 'ok', detail: 'recovered' }; },
    });
    const runs: FakeRun[] = [{
      id: 'r1', transitionId: 't1', hookName: 'retry-good',
      state: 'failed', attempts: 1, maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
    }];
    const transitions: FakeTransition[] = [{
      id: 't1', clientId: 'c1', transitionKind: 'deleted',
    }];
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    expect(called).toBe(1);
    expect(r.succeeded).toBe(1);
    expect(runs[0].state).toBe('ok');
    expect(runs[0].nextAttemptAt).toBeNull();
  });

  it('keeps row failed but reschedules when hook returns retry', async () => {
    registerLifecycleHook({
      name: 'flaky',
      transitions: ['deleted'],
      order: 100,
      blocking: 'continue',
      run: async () => ({ status: 'retry' as const, envelope: { title: 'still flaky' } }),
    });
    const runs: FakeRun[] = [{
      id: 'r1', transitionId: 't1', hookName: 'flaky',
      state: 'failed', attempts: 1, maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
    }];
    const transitions: FakeTransition[] = [{
      id: 't1', clientId: 'c1', transitionKind: 'deleted',
    }];
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    expect(r.retried).toBe(1);
    expect(runs[0].state).toBe('failed');
    expect(runs[0].nextAttemptAt).toBeInstanceOf(Date);
    expect(runs[0].attempts).toBe(2);
  });

  it('marks permanently failed when retry exhausts maxAttempts', async () => {
    registerLifecycleHook({
      name: 'doomed',
      transitions: ['deleted'],
      order: 100,
      blocking: 'continue',
      run: async () => ({ status: 'retry' as const, envelope: { title: 'still flaky' } }),
    });
    const runs: FakeRun[] = [{
      id: 'r1', transitionId: 't1', hookName: 'doomed',
      state: 'failed', attempts: 2, maxAttempts: 3, // attempt+1=3 reaches max
      nextAttemptAt: new Date(Date.now() - 1000),
    }];
    const transitions: FakeTransition[] = [{
      id: 't1', clientId: 'c1', transitionKind: 'deleted',
    }];
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    expect(r.permanentlyFailed).toBe(1);
    expect(runs[0].nextAttemptAt).toBeNull();
  });

  it('marks unknown hook as permanent failure', async () => {
    // No hook registered.
    const runs: FakeRun[] = [{
      id: 'r1', transitionId: 't1', hookName: 'ghost-hook',
      state: 'failed', attempts: 1, maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
    }];
    const transitions: FakeTransition[] = [{
      id: 't1', clientId: 'c1', transitionKind: 'deleted',
    }];
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    expect(r.permanentlyFailed).toBe(1);
    expect(runs[0].lastError).toMatchObject({ title: 'Hook un-registered' });
  });

  it('captures synchronous-throw inside hook.run as failed result', async () => {
    registerLifecycleHook({
      name: 'thrower',
      transitions: ['deleted'],
      order: 100,
      blocking: 'continue',
      run: async () => { throw new Error('boom-on-retry'); },
    });
    const runs: FakeRun[] = [{
      id: 'r1', transitionId: 't1', hookName: 'thrower',
      state: 'failed', attempts: 2, maxAttempts: 3, // exhausted on this attempt
      nextAttemptAt: new Date(Date.now() - 1000),
    }];
    const transitions: FakeTransition[] = [{
      id: 't1', clientId: 'c1', transitionKind: 'deleted',
    }];
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    expect(r.permanentlyFailed).toBe(1);
    expect((runs[0].lastError as { detail: string }).detail).toContain('boom-on-retry');
  });

  it('skips rows once the per-hook circuit-breaker is open', async () => {
    registerLifecycleHook({
      name: 'breaker-test',
      transitions: ['deleted'],
      order: 100,
      blocking: 'continue',
      run: async (): Promise<HookResult> => ({ status: 'failed', envelope: { title: 'flap' } }),
    });
    // Pre-load 5 failed rows so the breaker opens by row 5.
    const runs: FakeRun[] = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`, transitionId: `t${i}`, hookName: 'breaker-test',
      state: 'failed' as const, attempts: 0, maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1000),
    }));
    const transitions: FakeTransition[] = runs.map((r) => ({
      id: r.transitionId, clientId: 'c1', transitionKind: 'deleted' as const,
    }));
    const db = makeFakeDb({ runs, transitions });
    const r = await runRetryTick(db as never, {} as never);
    // First 5 attempts contribute to the breaker; row 6 (and later)
    // gets skipped on this same tick because the breaker opens
    // mid-tick on the 5th failure.
    expect(r.skippedBreaker).toBeGreaterThanOrEqual(1);
  });
});
