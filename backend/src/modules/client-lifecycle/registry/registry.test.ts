import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerLifecycleHook,
  topoSortForTransition,
  listHooks,
  _resetRegistryForTests,
  LifecycleRegistryError,
} from './registry.js';
import type { LifecycleHook } from './types.js';

function makeHook(over: Partial<LifecycleHook> & Pick<LifecycleHook, 'name'>): LifecycleHook {
  return {
    transitions: ['deleted'],
    order: 100,
    blocking: 'continue',
    run: async () => ({ status: 'noop' }),
    ...over,
  };
}

describe('lifecycle registry', () => {
  beforeEach(() => _resetRegistryForTests());

  it('registers a hook and lists it back', () => {
    const h = makeHook({ name: 'pv-cleanup' });
    registerLifecycleHook(h);
    expect(listHooks()).toEqual([h]);
  });

  it('rejects duplicate-name registration with a different definition', () => {
    registerLifecycleHook(makeHook({ name: 'dup' }));
    expect(() => registerLifecycleHook(makeHook({ name: 'dup', order: 200 })))
      .toThrowError(LifecycleRegistryError);
  });

  it('is idempotent on the same hook reference (catches double-import)', () => {
    const h = makeHook({ name: 'pv-cleanup' });
    registerLifecycleHook(h);
    registerLifecycleHook(h);
    expect(listHooks()).toHaveLength(1);
  });

  it('rejects invalid hooks', () => {
    expect(() => registerLifecycleHook(makeHook({ name: '', }))).toThrow();
    expect(() => registerLifecycleHook(makeHook({ name: 'bad', transitions: [] }))).toThrow();
    expect(() => registerLifecycleHook(makeHook({
      name: 'bad', blocking: 'wrong' as unknown as 'abort' })))
      .toThrow();
  });

  describe('topoSortForTransition', () => {
    it('returns hooks in `order` ascending', () => {
      registerLifecycleHook(makeHook({ name: 'late', order: 300 }));
      registerLifecycleHook(makeHook({ name: 'early', order: 100 }));
      registerLifecycleHook(makeHook({ name: 'mid', order: 200 }));
      const sorted = topoSortForTransition('deleted');
      expect(sorted.map((h) => h.name)).toEqual(['early', 'mid', 'late']);
    });

    it('filters by transition', () => {
      registerLifecycleHook(makeHook({ name: 'a', transitions: ['deleted'], order: 100 }));
      registerLifecycleHook(makeHook({ name: 'b', transitions: ['suspended'], order: 100 }));
      registerLifecycleHook(makeHook({ name: 'c', transitions: ['deleted', 'suspended'], order: 200 }));
      expect(topoSortForTransition('deleted').map((h) => h.name)).toEqual(['a', 'c']);
      expect(topoSortForTransition('suspended').map((h) => h.name)).toEqual(['b', 'c']);
    });

    it('honours `after` constraints', () => {
      // Even though `b` has a lower `order` than `a`, the `after` edge
      // forces `a` to come first.
      registerLifecycleHook(makeHook({ name: 'a', order: 200 }));
      registerLifecycleHook(makeHook({ name: 'b', order: 100, after: ['a'] }));
      const sorted = topoSortForTransition('deleted');
      expect(sorted.map((h) => h.name)).toEqual(['a', 'b']);
    });

    it('throws on cyclic `after`', () => {
      registerLifecycleHook(makeHook({ name: 'a', order: 100, after: ['b'] }));
      registerLifecycleHook(makeHook({ name: 'b', order: 200, after: ['a'] }));
      expect(() => topoSortForTransition('deleted')).toThrowError(/cycle/);
    });

    it('throws on `after` referencing an unregistered hook', () => {
      registerLifecycleHook(makeHook({ name: 'a', after: ['ghost'] }));
      expect(() => topoSortForTransition('deleted')).toThrowError(/ghost/);
    });

    it('throws if `after` references a hook registered for a different transition', () => {
      // `a` is in 'deleted', `b` in 'suspended'. Sorting 'deleted' should
      // not see `b` and must reject the dependency.
      registerLifecycleHook(makeHook({ name: 'a', transitions: ['deleted'], after: ['b'] }));
      registerLifecycleHook(makeHook({ name: 'b', transitions: ['suspended'] }));
      expect(() => topoSortForTransition('deleted')).toThrowError(/b/);
    });

    it('returns empty when nothing is registered for the transition', () => {
      expect(topoSortForTransition('archived')).toEqual([]);
    });

    it('produces a stable order across re-runs (deterministic tiebreak by name)', () => {
      registerLifecycleHook(makeHook({ name: 'beta', order: 100 }));
      registerLifecycleHook(makeHook({ name: 'alpha', order: 100 }));
      const a = topoSortForTransition('deleted').map((h) => h.name);
      const b = topoSortForTransition('deleted').map((h) => h.name);
      expect(a).toEqual(b);
      expect(a).toEqual(['alpha', 'beta']); // alphabetical tiebreak
    });
  });
});
