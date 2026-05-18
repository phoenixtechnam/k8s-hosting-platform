import { describe, it, expect, vi } from 'vitest';
import { systemTenantGuardHook } from './system-tenant-guard.js';
import type { HookCtx, Transition } from '../registry/index.js';

function makeCtx(opts: {
  isSystem: boolean | null | 'no-row';
  transition: Transition;
}): HookCtx {
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            opts.isSystem === 'no-row'
              ? []
              : [{ isSystem: opts.isSystem }],
          ),
        }),
      }),
    }),
  };
  return {
    db: db as never,
    k8s: {} as never,
    tenantId: 'tenant-uuid-1',
    namespace: 'tenant-system',
    transitionId: 'tx-uuid-1',
    transition: opts.transition,
    attempt: 1,
  };
}

describe('system-tenant-guard hook', () => {
  it('is registered for the destructive transitions only', () => {
    expect([...systemTenantGuardHook.transitions].sort()).toEqual(['archived', 'deleted', 'suspended']);
  });

  it('runs first (order=1)', () => {
    expect(systemTenantGuardHook.order).toBe(1);
  });

  it('blocks the transition on failure (blocking=abort)', () => {
    expect(systemTenantGuardHook.blocking).toBe('abort');
  });

  it('does not retry (maxAttempts=1)', () => {
    expect(systemTenantGuardHook.maxAttempts).toBe(1);
  });

  it('returns noop when the tenant is NOT a SYSTEM row', async () => {
    const ctx = makeCtx({ isSystem: false, transition: 'deleted' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('noop');
  });

  it('returns noop when the tenant row no longer exists (FK cascade case)', async () => {
    const ctx = makeCtx({ isSystem: 'no-row', transition: 'deleted' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('noop');
  });

  it('returns failed with operator-friendly envelope when target is SYSTEM (suspended)', async () => {
    const ctx = makeCtx({ isSystem: true, transition: 'suspended' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('failed');
    expect(result.envelope?.title).toMatch(/SYSTEM tenant is protected/i);
    expect(result.envelope?.detail).toMatch(/cannot suspend/i);
    expect(result.envelope?.remediation?.length).toBeGreaterThan(0);
  });

  it('returns failed when target is SYSTEM (archived)', async () => {
    const ctx = makeCtx({ isSystem: true, transition: 'archived' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('failed');
    expect(result.envelope?.detail).toMatch(/cannot archive/i);
  });

  it('returns failed when target is SYSTEM (deleted)', async () => {
    const ctx = makeCtx({ isSystem: true, transition: 'deleted' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('failed');
    expect(result.envelope?.detail).toMatch(/cannot delete/i);
  });

  it('treats isSystem=null defensively as not-SYSTEM (column nullable in pre-migration schema)', async () => {
    const ctx = makeCtx({ isSystem: null, transition: 'deleted' });
    const result = await systemTenantGuardHook.run(ctx);
    expect(result.status).toBe('noop');
  });
});
