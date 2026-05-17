import { describe, it, expect, vi } from 'vitest';
import { bulwarkSettingsPurgeHook } from './bulwark-settings-purge.js';
import type { HookCtx } from '../registry/index.js';

function makeCtx(transition: HookCtx['transition']): HookCtx {
  return {
    db: {} as never,
    k8s: {} as never,
    tenantId: 'c1',
    namespace: 'tenant-c1',
    transitionId: 't1',
    transition,
    attempt: 1,
    log: vi.fn(),
  } as HookCtx;
}

describe('bulwark-settings-purge (retired)', () => {
  it('returns noop for archived transition (sidecar removed upstream)', async () => {
    const result = await bulwarkSettingsPurgeHook.run(makeCtx('archived'));
    expect(result.status).toBe('noop');
    expect(result.detail).toContain('retired');
  });

  it('returns noop for non-archived transitions', async () => {
    const result = await bulwarkSettingsPurgeHook.run(makeCtx('active'));
    expect(result.status).toBe('noop');
  });

  it('hook metadata records transitions and ordering preserved', () => {
    expect(bulwarkSettingsPurgeHook.name).toBe('bulwark-settings-purge');
    expect(bulwarkSettingsPurgeHook.transitions).toEqual(['archived']);
    expect(bulwarkSettingsPurgeHook.order).toBe(210);
    expect(bulwarkSettingsPurgeHook.blocking).toBe('continue');
  });
});
