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
    recyclePods: vi.fn().mockResolvedValue({ deletedCount: 0 }),
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

  it('falls through to Secret-only rotation when admin principal not found', async () => {
    // Cut 3 follow-up (2026-05-04): Stalwart 0.16 supports a recovery-
    // admin path where no x:Account row exists in the DB. Rotation now
    // skips the JMAP-update step cleanly in that case and patches the
    // Secret only — Reloader rolls the Stalwart pod which picks up the
    // new STALWART_RECOVERY_ADMIN env-var value. Verified live on
    // staging via 3 successive rotations (memory finding #7).
    const deps = makeDeps({ findAdminPrincipalId: vi.fn().mockResolvedValue(null) });

    const result = await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);

    expect(deps.updateAdminPassword).not.toHaveBeenCalled();
    expect(deps.patchK8sSecret).toHaveBeenCalled();
    expect(result.password).toBe('new-secret-password');
  });

  it('throws when JMAP session fails with non-401 error (network / 5xx)', async () => {
    // Non-401 errors (network unreachable, 503, etc.) surface to the
    // operator — there's nothing safe to fall back to. 401 is the
    // ONLY case where we proceed to the Secret-patch path.
    const deps = makeDeps({
      getJmapAccountId: vi.fn().mockRejectedValue(new Error('JMAP unreachable')),
    });

    await expect(rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps)).rejects.toThrow('JMAP unreachable');
  });

  it('falls back to Secret-patch path when JMAP /session fails with a network error', async () => {
    // Stalwart pod CrashLoopBackOff or mid-restart produces undici
    // errors like `TypeError: fetch failed: other side closed`. There's
    // no `details.status` because no HTTP response ever arrived. The
    // Secret-patch path is still the right move — when Stalwart comes
    // back, it'll boot with the new env var.
    const netErr = new TypeError('fetch failed');
    (netErr as Error & { cause?: { message?: string } }).cause = { message: 'other side closed' };
    netErr.message = 'fetch failed: other side closed';
    const deps = makeDeps({ getJmapAccountId: vi.fn().mockRejectedValue(netErr) });

    const result = await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);
    expect(result.password).toBe('new-secret-password');
    expect(deps.patchK8sSecret).toHaveBeenCalled();
    expect(deps.updateAdminPassword).not.toHaveBeenCalled();
  });

  it('falls back to Secret-patch path when JMAP /session returns 429 (rate-limited)', async () => {
    // After several failed 401s (e.g. operator hit "rotate" repeatedly
    // during a half-finished rollout), Stalwart's auth-attempt rate
    // limiter kicks in and returns 429. Same downstream story as 401:
    // patching the Secret doesn't touch Stalwart's auth surface.
    const jmapErr: Error & { details?: { status: number } } = new Error('JMAP session fetch failed: HTTP 429');
    jmapErr.details = { status: 429 };
    const deps = makeDeps({
      getJmapAccountId: vi.fn().mockRejectedValue(jmapErr),
    });

    const result = await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);
    expect(result.password).toBe('new-secret-password');
    expect(deps.patchK8sSecret).toHaveBeenCalled();
    expect(deps.updateAdminPassword).not.toHaveBeenCalled();
  });

  it('falls back to Secret-patch path when JMAP /session returns 401', async () => {
    // 401 from /session means either:
    //   (a) recovery-admin-only mode — no Account exists, so JMAP write
    //       is impossible. Patching the Secret + Reloader rollout is the
    //       only mechanism to rotate.
    //   (b) drift — a prior rotation patched the Secret but Stalwart's
    //       pod hasn't picked up the new env var yet. platform-api's
    //       Secret-mount view is ahead of Stalwart, so JMAP auth 401s.
    //       Patching the Secret again (to a third value) doesn't make
    //       things worse: Reloader will eventually catch up.
    // Without this fallback every operator rotation request fails 401
    // when there's any drift at all.
    const jmapErr: Error & { details?: { status: number } } = new Error('JMAP session fetch failed: HTTP 401');
    jmapErr.details = { status: 401 };
    const deps = makeDeps({
      getJmapAccountId: vi.fn().mockRejectedValue(jmapErr),
    });

    const result = await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);
    expect(result.password).toBe('new-secret-password');
    expect(deps.patchK8sSecret).toHaveBeenCalled();
    // No JMAP write call — we couldn't authenticate.
    expect(deps.updateAdminPassword).not.toHaveBeenCalled();
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

  it('recyclePodsBeforeVerify=true calls recyclePods between Secret patch and verify', async () => {
    // 2026-05-06 hardening: drift between mounted-Secret view and pod-env
    // view causes verify failures. Eliminating that drift requires the
    // pods to be recycled AFTER the Secret patch and BEFORE the verify
    // probes them. This test asserts the call ordering.
    const callOrder: string[] = [];
    const deps = makeDeps({
      patchK8sSecret: vi.fn().mockImplementation(async () => {
        callOrder.push('patchK8sSecret');
      }),
      recyclePods: vi.fn().mockImplementation(async () => {
        callOrder.push('recyclePods');
        return { deletedCount: 3 };
      }),
      verifyNewPassword: vi.fn().mockImplementation(async () => {
        callOrder.push('verifyNewPassword');
        return true;
      }),
    });

    await rotateAdminPasswordViaJmapImpl(
      { ...BASE_OPTS, recyclePodsBeforeVerify: true },
      deps,
    );

    expect(deps.recyclePods).toHaveBeenCalledOnce();
    // Strict ordering: patch → recycle → verify
    const patchIdx = callOrder.indexOf('patchK8sSecret');
    const recycleIdx = callOrder.indexOf('recyclePods');
    const verifyIdx = callOrder.indexOf('verifyNewPassword');
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(recycleIdx).toBeGreaterThan(patchIdx);
    expect(verifyIdx).toBeGreaterThan(recycleIdx);
  });

  it('recyclePodsBeforeVerify omitted (default) → recyclePods is NOT called', async () => {
    // Webmail-master rotation goes through this same code path with
    // recyclePodsBeforeVerify left undefined (its target is a DB account,
    // not an env var; Roundcube is rolled separately by the caller).
    const deps = makeDeps();
    await rotateAdminPasswordViaJmapImpl(BASE_OPTS, deps);
    expect(deps.recyclePods).not.toHaveBeenCalled();
  });

  it('recyclePodsBeforeVerify=true tolerates recyclePods failure (best-effort)', async () => {
    // A recycle failure (e.g. RBAC denies pods/delete) MUST NOT fail the
    // rotation. The Secret has already been patched; Reloader will
    // eventually catch up even without our explicit delete. The verify
    // step then probes whatever pods are alive at the time.
    const deps = makeDeps({
      recyclePods: vi.fn().mockRejectedValue(new Error('RBAC: cannot delete pods')),
    });

    const result = await rotateAdminPasswordViaJmapImpl(
      { ...BASE_OPTS, recyclePodsBeforeVerify: true },
      deps,
    );
    expect(result.password).toBe('new-secret-password');
    expect(deps.verifyNewPassword).toHaveBeenCalled();
  });

  it('returns success on verify timeout — Secret was rotated, Stalwart pod is rolling', async () => {
    // Reloader-driven Stalwart pod restart can take 30-120s after a
    // Secret patch. Treating a verify timeout as a 500 makes the
    // operator click "rotate" again, double-rotating and worsening
    // the drift. The Secret IS rotated; the rotate handler returns
    // the new cleartext for the operator to capture.
    const deps = makeDeps({ verifyNewPassword: vi.fn().mockResolvedValue(false) });

    const result = await rotateAdminPasswordViaJmapImpl(
      { ...BASE_OPTS, verifyTimeoutMs: 50 },
      deps,
    );
    expect(result.password).toBe('new-secret-password');
    expect(result.username).toBe('admin');
    // The new cleartext is returned so the operator can copy + paste
    // even when verify timed out — Stalwart will pick it up shortly.
    expect(deps.patchK8sSecret).toHaveBeenCalled();
  });
});
