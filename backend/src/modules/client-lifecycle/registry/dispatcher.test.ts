import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock drizzle-orm's `eq` so the fake DB can recover (column, value)
// from the WHERE clause without parsing real drizzle internals (which
// embed circular references that JSON.stringify can't handle).
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

import { runTransition } from './dispatcher.js';
import {
  clientLifecycleTransitions,
  clientLifecycleHookRuns,
} from '../../../db/schema.js';
import type { LifecycleHook } from './types.js';

/**
 * Test fake that routes drizzle-style chained calls by **table reference
 * identity**, not by inspecting drizzle internals. Rejects unknown
 * tables with an explicit error so accidental schema-shape drift trips
 * a test rather than silently doing the wrong thing.
 */
function makeFakeDb() {
  const transitions: Array<Record<string, unknown>> = [];
  const hookRuns: Array<Record<string, unknown>> = [];

  const tableOf = (table: unknown): 'transitions' | 'hookRuns' => {
    if (table === clientLifecycleTransitions) return 'transitions';
    if (table === clientLifecycleHookRuns) return 'hookRuns';
    throw new Error('fake-db: unknown table reference');
  };

  // Chained .update().set().where(): the mocked eq() returns
  // `{ __testEq, col, val }` so the fake can recover the id literal
  // and apply the patch in place.
  const updateChain = (kind: 'transitions' | 'hookRuns') => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (cond: { __testEq?: true; val?: unknown }) => {
        const rows = kind === 'transitions' ? transitions : hookRuns;
        const id = cond?.__testEq ? String(cond.val) : null;
        const row = id ? rows.find((r) => r.id === id) : rows[rows.length - 1];
        if (row) Object.assign(row, patch);
        return [];
      },
    }),
  });

  const db = {
    insert: (table: unknown) => ({
      values: async (row: Record<string, unknown>) => {
        const kind = tableOf(table);
        (kind === 'transitions' ? transitions : hookRuns).push({ ...row });
        return [];
      },
    }),
    update: (table: unknown) => updateChain(tableOf(table)),
    select: () => ({
      from: (table: unknown) => ({
        where: async (_cond: unknown) => {
          const kind = tableOf(table);
          return kind === 'transitions' ? transitions.slice() : hookRuns.slice();
        },
      }),
    }),
  };
  return { db, transitions, hookRuns };
}

function hook(over: Partial<LifecycleHook> & Pick<LifecycleHook, 'name' | 'run'>): LifecycleHook {
  return {
    transitions: ['deleted'],
    order: 100,
    blocking: 'continue',
    ...over,
  };
}

describe('dispatcher.runTransition', () => {
  let fake: ReturnType<typeof makeFakeDb>;
  beforeEach(() => { fake = makeFakeDb(); });

  it('writes a transitions row and marks completed when no hooks registered', async () => {
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'active', toStatus: 'active',
      hooksOverride: [],
    });
    expect(result.state).toBe('completed');
    expect(result.hooksAttempted).toBe(0);
    expect(fake.transitions).toHaveLength(1);
    expect(fake.transitions[0]).toMatchObject({ transitionKind: 'active', state: 'completed' });
  });

  it('runs hooks in topo order and marks completed on full success', async () => {
    const calls: string[] = [];
    const a = hook({ name: 'a', order: 100, run: async () => { calls.push('a'); return { status: 'ok' }; } });
    const b = hook({ name: 'b', order: 200, run: async () => { calls.push('b'); return { status: 'ok' }; } });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a, b],
    });
    expect(calls).toEqual(['a', 'b']);
    expect(result.state).toBe('completed');
    expect(result.hooksOk).toBe(2);
  });

  it('records `failed_partial` when a `continue`-blocking hook fails', async () => {
    const a = hook({
      name: 'a', blocking: 'continue', order: 100,
      run: async () => ({ status: 'failed', envelope: { title: 'boom' } }),
    });
    const b = hook({ name: 'b', order: 200, run: async () => ({ status: 'ok' }) });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a, b],
    });
    expect(result.state).toBe('failed_partial');
    expect(result.hooksFailed).toBe(1);
    expect(result.hooksOk).toBe(1);
    const aRun = fake.hookRuns.find((r) => r.hookName === 'a')!;
    expect(aRun.lastError).toMatchObject({ title: 'boom' });
  });

  it('halts and records `failed_blocking` when a `abort`-blocking hook fails', async () => {
    const calls: string[] = [];
    const a = hook({
      name: 'a', blocking: 'abort', order: 100,
      run: async () => { calls.push('a'); return { status: 'failed', envelope: { title: 'fatal' } }; },
    });
    const b = hook({
      name: 'b', order: 200,
      run: async () => { calls.push('b'); return { status: 'ok' }; },
    });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a, b],
    });
    expect(calls).toEqual(['a']);
    expect(result.state).toBe('failed_blocking');
    const bRun = fake.hookRuns.find((r) => r.hookName === 'b')!;
    expect(bRun.state).toBe('pending');
  });

  it('captures synchronous-throw inside hook.run as a failed result with envelope', async () => {
    const a = hook({
      name: 'a', blocking: 'abort',
      run: async () => { throw new Error('kaboom'); },
    });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a],
    });
    expect(result.state).toBe('failed_blocking');
    const run = fake.hookRuns.find((r) => r.hookName === 'a')!;
    expect((run.lastError as { detail: string }).detail).toContain('kaboom');
  });

  it('schedules `next_attempt_at` on `retry` if attempts < max', async () => {
    const a = hook({
      name: 'a',
      maxAttempts: 3,
      run: async () => ({ status: 'retry' as const }),
    });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a],
    });
    expect(result.state).toBe('failed_partial');
    const run = fake.hookRuns.find((r) => r.hookName === 'a')!;
    expect(run.nextAttemptAt).toBeInstanceOf(Date);
    expect(run.attempts).toBe(1);
  });

  it('does NOT schedule retry when attempts have already reached max', async () => {
    const a = hook({
      name: 'a',
      maxAttempts: 1,
      run: async () => ({ status: 'retry' as const }),
    });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a],
    });
    expect(result.state).toBe('failed_partial');
    const run = fake.hookRuns.find((r) => r.hookName === 'a')!;
    // The reset to null happens explicitly on success/non-retry — for a
    // failed retry-exhausted hook we leave nextAttemptAt undefined here
    // (the field stays at its default null in real Postgres).
    expect(run.nextAttemptAt == null).toBe(true);
  });

  it('treats `noop` as success', async () => {
    const a = hook({ name: 'a', run: async () => ({ status: 'noop' as const }) });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a],
    });
    expect(result.state).toBe('completed');
    expect(result.hooksOk).toBe(1);
  });

  it('skipExecution leaves rows pending for inspection', async () => {
    const a = hook({ name: 'a', run: async () => ({ status: 'ok' }) });
    const result = await runTransition(fake.db as never, {} as never, {
      clientId: 'c1', namespace: 'ns', transition: 'deleted', toStatus: 'deleted',
      hooksOverride: [a],
      skipExecution: true,
    });
    expect(result.state).toBe('running');
    expect(fake.hookRuns[0].state).toBe('pending');
  });
});
