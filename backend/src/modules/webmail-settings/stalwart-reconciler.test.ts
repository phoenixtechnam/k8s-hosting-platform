import { describe, it, expect, vi } from 'vitest';
import { reconcileStalwartHostname } from './stalwart-reconciler.js';
import type { StalwartHostnameReconcileDeps } from './stalwart-reconciler.js';

function mockDeps(currentHostname: string | null): StalwartHostnameReconcileDeps {
  return {
    readSecretHostname: vi.fn().mockResolvedValue(currentHostname),
    patchSecret: vi.fn().mockResolvedValue(undefined),
    restartStatefulSet: vi.fn().mockResolvedValue(undefined),
  };
}

describe('reconcileStalwartHostname', () => {
  it('returns false and does nothing when the hostname already matches', async () => {
    const deps = mockDeps('mail.example.com');
    const restarted = await reconcileStalwartHostname('mail.example.com', {}, deps);
    expect(restarted).toBe(false);
    expect(deps.patchSecret).not.toHaveBeenCalled();
    expect(deps.restartStatefulSet).not.toHaveBeenCalled();
  });

  it('patches secret + restarts StatefulSet on change', async () => {
    const deps = mockDeps('mail.old.local');
    const restarted = await reconcileStalwartHostname('mail.new.example.com', {}, deps);
    expect(restarted).toBe(true);
    expect(deps.patchSecret).toHaveBeenCalledWith({
      namespace: 'mail',
      name: 'stalwart-secrets',
      stringData: { STALWART_HOSTNAME: 'mail.new.example.com' },
    });
    expect(deps.restartStatefulSet).toHaveBeenCalledWith({
      namespace: 'mail',
      name: 'stalwart-mail',
    });
  });

  it('still reconciles when the current secret has no hostname entry', async () => {
    // readSecretHostname returns null (key missing) — we should treat this
    // as "different" and write the new value.
    const deps = mockDeps(null);
    const restarted = await reconcileStalwartHostname('mail.fresh.example.com', {}, deps);
    expect(restarted).toBe(true);
    expect(deps.patchSecret).toHaveBeenCalledTimes(1);
    expect(deps.restartStatefulSet).toHaveBeenCalledTimes(1);
  });

  it('respects non-default namespace / secretName / statefulSetName', async () => {
    const deps = mockDeps('old.com');
    await reconcileStalwartHostname(
      'new.com',
      { namespace: 'mail-staging', secretName: 'stalwart-staging-secrets', statefulSetName: 'stalwart-staging' },
      deps,
    );
    expect(deps.patchSecret).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'mail-staging',
      name: 'stalwart-staging-secrets',
    }));
    expect(deps.restartStatefulSet).toHaveBeenCalledWith({
      namespace: 'mail-staging',
      name: 'stalwart-staging',
    });
  });
});
