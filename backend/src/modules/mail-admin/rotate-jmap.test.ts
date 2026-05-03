/**
 * Unit tests for mail-admin/rotate-jmap.ts
 *
 * All dependencies are injected via RotateJmapDeps so no k8s or
 * Stalwart connectivity is required.
 */
import { describe, it, expect, vi } from 'vitest';

// @kubernetes/client-node is now lazily loaded inside defaultDeps() only.
// Since tests use rotateAdminPasswordViaJmapImpl with injected deps,
// the k8s package is never imported — no mock needed.

vi.mock('../stalwart-jmap/client.js', () => ({
  getJmapSession: vi.fn(),
  principalGet: vi.fn(),
  updatePrincipal: vi.fn(),
}));

import { rotateAdminPasswordViaJmapImpl, type RotateJmapDeps, type RotateJmapOptions } from './rotate-jmap.js';

const BASE_OPTS: RotateJmapOptions = {
  kubeconfigPath: undefined,
  stalwartNamespace: 'mail',
  secretName: 'stalwart-admin-creds',
  username: 'admin',
  verifyTimeoutMs: 100,
};

function makeDeps(overrides: Partial<RotateJmapDeps> = {}): RotateJmapDeps {
  // Simulated clock. The first call (deadline = now + timeout) and the second
  // call (first while-check) return the same timestamp so the loop body runs
  // at least once. Subsequent calls advance by 1 s each, so the loop exits
  // after at most `verifyTimeoutMs / 1000` extra iterations (≤1 for 100ms).
  // This prevents the infinite loop that occurs when `now` always returns the
  // exact same value AND `verifyNewPassword` always returns `false`.
  const BASE_MS = new Date('2026-05-01T12:00:00Z').getTime();
  let callCount = 0;
  const now = vi.fn().mockImplementation(() => {
    // calls 0+1 → same base time (allows deadline computation + one loop pass)
    // calls 2+ → advance by 1 s per call (exits the verify loop)
    const offset = callCount <= 1 ? 0 : (callCount - 1) * 1_000;
    callCount++;
    return new Date(BASE_MS + offset);
  });

  return {
    generatePassword: () => 'new-secret-password',
    getJmapAccountId: vi.fn().mockResolvedValue('account-123'),
    findAdminPrincipalId: vi.fn().mockResolvedValue('principal-admin-1'),
    updateAdminPassword: vi.fn().mockResolvedValue(undefined),
    patchK8sSecret: vi.fn().mockResolvedValue(undefined),
    verifyNewPassword: vi.fn().mockResolvedValue(true),
    sleep: vi.fn().mockResolvedValue(undefined),
    now,
    ...overrides,
  };
}

describe('rotateAdminPasswordViaJmapImpl', () => {
  it('returns the new credentials on success', async () => {
    const deps = makeDeps();
    const result = await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);

    expect(result.username).toBe('admin');
    expect(result.password).toBe('new-secret-password');
    // rotatedAt is the timestamp of the final `now()` call (after the
    // verify loop). With the do/while ordering, verify() succeeds on
    // the first attempt so only two now() calls happen — one for the
    // deadline at BASE+0, and the final toISOString also at BASE+0.
    expect(result.rotatedAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('calls JMAP Principal/set with new password', async () => {
    const deps = makeDeps();
    await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);

    expect(deps.updateAdminPassword).toHaveBeenCalledWith(
      'account-123',
      'principal-admin-1',
      'new-secret-password',
    );
  });

  it('patches the k8s Secret with cleartext', async () => {
    const deps = makeDeps();
    await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);

    expect(deps.patchK8sSecret).toHaveBeenCalledWith({
      namespace: 'mail',
      name: 'stalwart-admin-creds',
      stringData: expect.objectContaining({
        adminPassword: 'new-secret-password',
      }),
    });
  });

  it('throws when admin principal not found', async () => {
    const deps = makeDeps({ findAdminPrincipalId: vi.fn().mockResolvedValue(null) });

    await expect(rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps)).rejects.toThrow(
      /admin principal.*not found/i,
    );
    expect(deps.updateAdminPassword).not.toHaveBeenCalled();
  });

  it('throws when JMAP session fails', async () => {
    const deps = makeDeps({
      getJmapAccountId: vi.fn().mockRejectedValue(new Error('JMAP unreachable')),
    });

    await expect(rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps)).rejects.toThrow('JMAP unreachable');
  });

  it('throws with helpful message when k8s Secret patch fails after JMAP update succeeds', async () => {
    const deps = makeDeps({
      patchK8sSecret: vi.fn().mockRejectedValue(new Error('RBAC denied')),
    });

    await expect(rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps)).rejects.toThrow(
      /JMAP rotation succeeded but k8s Secret patch failed/,
    );
    // JMAP was still called
    expect(deps.updateAdminPassword).toHaveBeenCalled();
  });

  it('throws when credential verification times out', async () => {
    const deps = makeDeps({ verifyNewPassword: vi.fn().mockResolvedValue(false) });

    await expect(
      rotateAdminPasswordViaJmapImpl({ ...BASE_OPTS, verifyTimeoutMs: 50 }, deps),
    ).rejects.toThrow(/credential verification timed out/i);
  });
});
