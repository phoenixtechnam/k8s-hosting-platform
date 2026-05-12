import { describe, it, expect } from 'vitest';
import {
  allocateResources,
  InsufficientResourceBudgetError,
  type AllocatorComponentInput,
} from './resource-allocator.js';

describe('allocateResources', () => {
  it('single component gets the full budget regardless of shares', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [{ name: 'web' }]);
    expect(out.get('web')).toEqual({ cpu: '1000m', memory: '1024Mi' });
  });

  it('single component with weights still gets the full budget', () => {
    const out = allocateResources(
      { cpu: '500m', memory: '512Mi' },
      [{ name: 'web', resourceShare: { weight: 1 } }],
    );
    expect(out.get('web')).toEqual({ cpu: '500m', memory: '512Mi' });
  });

  it('multi-component without shares — even split (Nextcloud failure-mode fix)', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web' },
      { name: 'db' },
      { name: 'cache' },
      { name: 'cron' },
    ]);
    expect(out.size).toBe(4);
    const cpus = [...out.values()].map((v) => parseInt(v.cpu, 10));
    const mems = [...out.values()].map((v) => parseInt(v.memory, 10));
    expect(cpus.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(mems.reduce((a, b) => a + b, 0)).toBe(1024);
    // Each component within ~1 of even split (250/256) — rounding remainder
    // goes to first-named component due to weight-tie tiebreak.
    for (const c of cpus) expect(c).toBeGreaterThanOrEqual(250);
    for (const m of mems) expect(m).toBeGreaterThanOrEqual(256);
  });

  it('weighted split: weights distribute the budget above per-component minimums', () => {
    // Default min is 50m/64Mi per component. With 4 components:
    //   CPU min sum = 200m, remaining 800m distributed by weight
    //   Mem min sum = 256Mi, remaining 768Mi distributed by weight
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web', resourceShare: { weight: 50 } },
      { name: 'db', resourceShare: { weight: 35 } },
      { name: 'cache', resourceShare: { weight: 10 } },
      { name: 'cron', resourceShare: { weight: 5 } },
    ]);
    // CPU: 50 + (800 * weight / 100)
    expect(out.get('web')!.cpu).toBe('450m');
    expect(out.get('db')!.cpu).toBe('330m');
    expect(out.get('cache')!.cpu).toBe('130m');
    expect(out.get('cron')!.cpu).toBe('90m');
    // Mem: 64 + (768 * weight / 100), remainder 2 → web
    expect(out.get('web')!.memory).toBe('450Mi');
    expect(out.get('db')!.memory).toBe('332Mi');
    expect(out.get('cache')!.memory).toBe('140Mi');
    expect(out.get('cron')!.memory).toBe('102Mi');
    // Totals sum exactly to the budget.
    const sumCpu = [...out.values()].reduce((a, v) => a + parseInt(v.cpu, 10), 0);
    const sumMem = [...out.values()].reduce((a, v) => a + parseInt(v.memory, 10), 0);
    expect(sumCpu).toBe(1000);
    expect(sumMem).toBe(1024);
  });

  it('weighted split with explicit zero minimums lets weights be exact proportions', () => {
    // Bypass the default 50m/64Mi minimum by declaring 0 explicitly.
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web', resourceShare: { weight: 50, minCpu: '0', minMemory: '0' } },
      { name: 'db', resourceShare: { weight: 35, minCpu: '0', minMemory: '0' } },
      { name: 'cache', resourceShare: { weight: 10, minCpu: '0', minMemory: '0' } },
      { name: 'cron', resourceShare: { weight: 5, minCpu: '0', minMemory: '0' } },
    ]);
    expect(out.get('web')!.cpu).toBe('500m');
    expect(out.get('db')!.cpu).toBe('350m');
    expect(out.get('cache')!.cpu).toBe('100m');
    expect(out.get('cron')!.cpu).toBe('50m');
  });

  it('sum of allocations always equals the budget', () => {
    // Awkward ratios that produce floor remainders.
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'a', resourceShare: { weight: 3 } },
      { name: 'b', resourceShare: { weight: 3 } },
      { name: 'c', resourceShare: { weight: 3 } },
    ]);
    const sumCpu = [...out.values()].reduce((a, v) => a + parseInt(v.cpu, 10), 0);
    const sumMem = [...out.values()].reduce((a, v) => a + parseInt(v.memory, 10), 0);
    expect(sumCpu).toBe(1000);
    expect(sumMem).toBe(1024);
  });

  it('remainder goes to the highest-weight component (deterministic)', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'a', resourceShare: { weight: 1 } },
      { name: 'b', resourceShare: { weight: 2 } },
      { name: 'c', resourceShare: { weight: 1 } },
    ]);
    const aCpu = parseInt(out.get('a')!.cpu, 10);
    const bCpu = parseInt(out.get('b')!.cpu, 10);
    const cCpu = parseInt(out.get('c')!.cpu, 10);
    // b has the highest weight so it gets the largest allocation.
    expect(bCpu).toBeGreaterThan(aCpu);
    expect(bCpu).toBeGreaterThan(cCpu);
    // Sum must be exact.
    expect(aCpu + bCpu + cCpu).toBe(1000);
    // a and c get the same allocation (same weight, same name-sort tiebreak
    // means remainder never lands on them).
    expect(aCpu).toBe(cCpu);
  });

  it('minimum floor enforces per-component minimums', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web', resourceShare: { weight: 90 } },
      { name: 'tiny', resourceShare: { weight: 1, minCpu: '100m', minMemory: '128Mi' } },
    ]);
    expect(parseInt(out.get('tiny')!.cpu, 10)).toBeGreaterThanOrEqual(100);
    expect(parseInt(out.get('tiny')!.memory, 10)).toBeGreaterThanOrEqual(128);
  });

  it('throws INSUFFICIENT_BUDGET when sum of minimums exceeds the budget', () => {
    expect(() =>
      allocateResources({ cpu: '100m', memory: '128Mi' }, [
        { name: 'a', resourceShare: { weight: 1, minCpu: '100m', minMemory: '128Mi' } },
        { name: 'b', resourceShare: { weight: 1, minCpu: '100m', minMemory: '128Mi' } },
      ]),
    ).toThrow(InsufficientResourceBudgetError);

    try {
      allocateResources({ cpu: '100m', memory: '128Mi' }, [
        { name: 'a', resourceShare: { weight: 1, minCpu: '100m', minMemory: '128Mi' } },
        { name: 'b', resourceShare: { weight: 1, minCpu: '100m', minMemory: '128Mi' } },
      ]);
    } catch (e) {
      const err = e as InsufficientResourceBudgetError;
      expect(err.code).toBe('INSUFFICIENT_RESOURCE_BUDGET');
      expect(err.perComponentMinimums).toHaveLength(2);
      expect(err.required.cpu).toBe('200m');
      expect(err.required.memory).toBe('256Mi');
    }
  });

  it('throws INSUFFICIENT_BUDGET with default 50m/64Mi minimums when total too small', () => {
    expect(() =>
      allocateResources({ cpu: '100m', memory: '128Mi' }, [
        { name: 'a' },
        { name: 'b' },
        { name: 'c' },
      ]),
    ).toThrow(InsufficientResourceBudgetError);
  });

  it('Job-type components are excluded from the budget', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web' },
      { name: 'wp-install', type: 'job' },
    ] satisfies AllocatorComponentInput[]);
    // Only `web` should appear — wp-install keeps its hard-pinned resources.
    expect(out.size).toBe(1);
    expect(out.get('web')).toEqual({ cpu: '1000m', memory: '1024Mi' });
  });

  it('hard-pinned components are excluded from the budget', () => {
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'web' },
      { name: 'helper', resources: { cpu: '50m', memory: '64Mi' } },
    ] satisfies AllocatorComponentInput[]);
    expect(out.size).toBe(1);
    expect(out.has('web')).toBe(true);
    expect(out.has('helper')).toBe(false);
  });

  it('partial weight declarations fall back to even split (defence-in-depth)', () => {
    // Sync-time validator rejects this, but the runtime allocator must
    // not crash or produce silly allocations if a bad manifest slips through.
    const out = allocateResources({ cpu: '1', memory: '1Gi' }, [
      { name: 'a', resourceShare: { weight: 100 } },
      { name: 'b' },
      { name: 'c' },
    ]);
    const cpus = [...out.values()].map((v) => parseInt(v.cpu, 10));
    // All ~equal (within rounding), not 1 dominating.
    for (const c of cpus) expect(c).toBeGreaterThanOrEqual(330);
  });

  it('input formats: millicores, cores, Mi, Gi all accepted', () => {
    const fromCores = allocateResources({ cpu: '1', memory: '1Gi' }, [{ name: 'a' }]);
    const fromMilli = allocateResources({ cpu: '1000m', memory: '1024Mi' }, [{ name: 'a' }]);
    expect(fromCores.get('a')).toEqual(fromMilli.get('a'));
  });

  it('output is always normalised millicores + Mi regardless of input units', () => {
    const out = allocateResources({ cpu: '2', memory: '4Gi' }, [{ name: 'a' }]);
    expect(out.get('a')).toEqual({ cpu: '2000m', memory: '4096Mi' });
  });
});
