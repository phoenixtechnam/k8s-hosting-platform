import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the underlying ingress-suspend module so we test the hook
// wrapping (transition-branching, error → envelope) without coupling
// to the K8s implementation. vi.hoisted is required because vi.mock()
// factories run BEFORE module-level test code, so plain `const` spies
// would be in the temporal dead zone when the factory runs.
const { suspendSpy, resumeSpy, reconcileSpy } = vi.hoisted(() => ({
  suspendSpy: vi.fn(async () => undefined),
  resumeSpy: vi.fn(async () => undefined),
  reconcileSpy: vi.fn(async () => undefined),
}));
vi.mock('../ingress-suspend.js', () => ({
  suspendNamespaceIngresses: suspendSpy,
  resumeNamespaceIngresses: resumeSpy,
}));
vi.mock('../../domains/k8s-ingress.js', () => ({
  reconcileIngress: reconcileSpy,
}));

import {
  ingressSuspendHook,
  ingressResumeHook,
  ingressReconcileHook,
} from './k8s-ingress.js';
import type { HookCtx, Transition } from '../registry/index.js';

function ctx(transition: Transition): HookCtx {
  return {
    db: {} as never,
    k8s: { core: {} } as never,
    clientId: 'c1',
    namespace: 'client-test',
    transitionId: 't1',
    transition,
    attempt: 1,
  };
}

describe('ingress-suspend hook', () => {
  beforeEach(() => suspendSpy.mockClear());

  it('calls suspendNamespaceIngresses on suspended transition', async () => {
    const r = await ingressSuspendHook.run(ctx('suspended'));
    expect(r.status).toBe('ok');
    expect(suspendSpy).toHaveBeenCalledWith({ core: {} }, 'client-test');
  });

  it('noop on other transitions', async () => {
    const r = await ingressSuspendHook.run(ctx('active'));
    expect(r.status).toBe('noop');
    expect(suspendSpy).not.toHaveBeenCalled();
  });

  it('returns failed envelope on K8s error', async () => {
    suspendSpy.mockRejectedValueOnce(new Error('apiserver down'));
    const r = await ingressSuspendHook.run(ctx('suspended'));
    expect(r.status).toBe('failed');
    expect(r.envelope?.title).toBe('Ingress suspend failed');
    expect(r.envelope?.detail).toContain('apiserver down');
  });
});

describe('ingress-resume hook', () => {
  beforeEach(() => resumeSpy.mockClear());

  it('calls resumeNamespaceIngresses on active', async () => {
    const r = await ingressResumeHook.run(ctx('active'));
    expect(r.status).toBe('ok');
    expect(resumeSpy).toHaveBeenCalled();
  });

  it('runs on restored too', async () => {
    const r = await ingressResumeHook.run(ctx('restored'));
    expect(r.status).toBe('ok');
  });

  it('noop on other transitions', async () => {
    const r = await ingressResumeHook.run(ctx('suspended'));
    expect(r.status).toBe('noop');
  });

  it('returns failed envelope on error', async () => {
    resumeSpy.mockRejectedValueOnce(new Error('boom'));
    const r = await ingressResumeHook.run(ctx('active'));
    expect(r.status).toBe('failed');
    expect(r.envelope?.title).toBe('Ingress resume failed');
  });
});

describe('ingress-reconcile hook', () => {
  beforeEach(() => reconcileSpy.mockClear());

  it('calls reconcileIngress on active/restored', async () => {
    for (const t of ['active', 'restored'] as const) {
      reconcileSpy.mockClear();
      const r = await ingressReconcileHook.run(ctx(t));
      expect(r.status).toBe('ok');
      expect(reconcileSpy).toHaveBeenCalled();
    }
  });

  it('noop on other transitions', async () => {
    const r = await ingressReconcileHook.run(ctx('archived'));
    expect(r.status).toBe('noop');
  });

  it('returns failed envelope on error', async () => {
    reconcileSpy.mockRejectedValueOnce(new Error('reconcile boom'));
    const r = await ingressReconcileHook.run(ctx('active'));
    expect(r.status).toBe('failed');
    expect(r.envelope?.title).toBe('Ingress reconcile failed');
  });
});
