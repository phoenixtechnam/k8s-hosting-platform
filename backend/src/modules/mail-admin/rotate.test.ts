import { describe, expect, it, vi } from 'vitest';
import {
  generateUrlSafePassword,
  rotateStalwartPasswordImpl,
  type RotateDeps,
  type RotateOptions,
} from './rotate.js';

function stubDeps(overrides: Partial<RotateDeps> = {}): RotateDeps {
  return {
    generatePassword: vi.fn(() => 'new-random-password'),
    hashPassword: vi.fn(async (pw: string) => `bcrypt(${pw})`),
    patchSecret: vi.fn(async () => {}),
    restartStatefulSet: vi.fn(async () => {}),
    waitForStatefulSetReady: vi.fn(async () => {}),
    restartDeployment: vi.fn(async () => {}),
    waitForDeploymentReady: vi.fn(async () => {}),
    verifyCredentials: vi.fn(async () => true),
    sleep: vi.fn(async () => {}),
    now: () => new Date('2026-04-17T20:00:00.000Z'),
    ...overrides,
  };
}

function stubOpts(): RotateOptions {
  return {
    kubeconfigPath: undefined,
    stalwartNamespace: 'mail',
    platformNamespace: 'platform',
    secretName: 'stalwart-secrets',
    platformMirrorSecretName: 'platform-stalwart-creds',
    stalwartStatefulSetName: 'stalwart-mail',
    platformDeploymentName: 'platform-api',
    stalwartMgmtHost: 'stalwart-mail-mgmt.mail.svc.cluster.local',
    stalwartMgmtPort: 8080,
    username: 'admin',
    verifyTimeoutMs: 60_000,
  };
}

describe('rotateStalwartPasswordImpl', () => {
  it('patches Secret with new cleartext + hash, restarts both workloads, returns new creds', async () => {
    const deps = stubDeps();
    const result = await rotateStalwartPasswordImpl(stubOpts(), deps);

    expect(result).toEqual({
      username: 'admin',
      password: 'new-random-password',
      rotatedAt: '2026-04-17T20:00:00.000Z',
    });
    expect(deps.hashPassword).toHaveBeenCalledWith('new-random-password');
    expect(deps.patchSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mail',
        name: 'stalwart-secrets',
        stringData: {
          ADMIN_SECRET: 'bcrypt(new-random-password)',
          ADMIN_SECRET_PLAIN: 'new-random-password',
        },
      }),
    );
    expect(deps.patchSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'platform',
        name: 'platform-stalwart-creds',
        stringData: { ADMIN_SECRET_PLAIN: 'new-random-password' },
      }),
    );
    expect(deps.restartStatefulSet).toHaveBeenCalledWith({
      namespace: 'mail',
      name: 'stalwart-mail',
    });
    expect(deps.restartDeployment).not.toHaveBeenCalled();
  });

  it('restarts Stalwart but NOT platform-api (platform-api reads from a mounted Secret volume)', async () => {
    const calls: string[] = [];
    const deps = stubDeps({
      restartStatefulSet: vi.fn(async () => { calls.push('stalwart'); }),
      waitForStatefulSetReady: vi.fn(async () => { calls.push('stalwart-ready'); }),
      restartDeployment: vi.fn(async () => { calls.push('platform'); }),
      waitForDeploymentReady: vi.fn(async () => { calls.push('platform-ready'); }),
      verifyCredentials: vi.fn(async () => { calls.push('verify'); return true; }),
    });
    await rotateStalwartPasswordImpl(stubOpts(), deps);
    expect(calls).toEqual(['stalwart', 'stalwart-ready', 'verify']);
    expect(deps.restartDeployment).not.toHaveBeenCalled();
    expect(deps.waitForDeploymentReady).not.toHaveBeenCalled();
  });

  it('polls verifyCredentials after restart and succeeds once creds are accepted', async () => {
    let attempts = 0;
    const deps = stubDeps({
      verifyCredentials: vi.fn(async () => {
        attempts += 1;
        return attempts >= 3;
      }),
    });
    await rotateStalwartPasswordImpl(stubOpts(), deps);
    expect(attempts).toBe(3);
    expect(deps.sleep).toHaveBeenCalled();
  });

  it('throws if verifyCredentials never succeeds before the deadline', async () => {
    const deps = stubDeps({
      verifyCredentials: vi.fn(async () => false),
      // Make the sleep bump the clock so the deadline is reached quickly.
      sleep: vi.fn(async () => {}),
      now: (() => {
        let t = 0;
        return () => new Date(t++ * 30_000); // 30s per call
      })(),
    });
    await expect(rotateStalwartPasswordImpl(stubOpts(), deps)).rejects.toThrow(
      /could not be verified/i,
    );
  });

  it('aborts if Stalwart readiness fails (the Secret is already patched — caller must recover)', async () => {
    const deps = stubDeps({
      waitForStatefulSetReady: vi.fn(async () => { throw new Error('stalwart did not become Ready'); }),
    });
    await expect(rotateStalwartPasswordImpl(stubOpts(), deps)).rejects.toThrow(/stalwart/i);
    expect(deps.restartDeployment).not.toHaveBeenCalled();
    expect(deps.verifyCredentials).not.toHaveBeenCalled();
  });

  it('generates a password at least 24 chars long and uses URL-safe characters', () => {
    // Sanity check on the helper's length + alphabet. Not a crypto proof.
    for (let i = 0; i < 10; i += 1) {
      const pw = generateUrlSafePassword(32);
      expect(pw.length).toBeGreaterThanOrEqual(24);
      expect(pw).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });
});
