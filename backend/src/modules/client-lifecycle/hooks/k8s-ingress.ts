import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import {
  suspendNamespaceIngresses,
  resumeNamespaceIngresses,
} from '../ingress-suspend.js';

/**
 * ingress-suspend hook.
 *
 * Calls the same `suspendNamespaceIngresses` that cascades.applySuspended
 * already invokes. Identical semantics, but observable through
 * client_lifecycle_hook_runs.
 *
 * blocking=continue: an ingress patch failure should not abort the
 * suspend — the client row already reflects the new state and the
 * domains hook has marked DNS suspended; the ingress can be retried.
 */
async function runIngressSuspend(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'suspended') {
    return { status: 'noop', detail: 'transition is not suspended' };
  }
  try {
    await suspendNamespaceIngresses(ctx.k8s, ctx.namespace);
    return { status: 'ok', detail: 'patched tenant ingresses to platform-suspended' };
  } catch (err) {
    return {
      status: 'failed',
      envelope: {
        title: 'Ingress suspend failed',
        detail: err instanceof Error ? err.message : String(err),
        remediation: [
          'Check the namespace ingress objects for the tenant',
          'Re-run via the lifecycle scheduler retry tick',
        ],
        raw: err instanceof Error ? err.stack ?? err.message : String(err),
      },
    };
  }
}

export const ingressSuspendHook: LifecycleHook = {
  name: 'ingress-suspend',
  transitions: ['suspended'],
  order: 300,
  blocking: 'continue',
  run: runIngressSuspend,
};

/**
 * ingress-resume hook — pairs with ingress-suspend.
 *
 * Calls `resumeNamespaceIngresses`. Then `ingress-reconcile` (separate
 * hook) rebuilds the Ingress objects from `ingress_routes` so the
 * resume picks up any route changes that happened while suspended.
 */
async function runIngressResume(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'active' && ctx.transition !== 'restored') {
    return { status: 'noop', detail: 'transition is not active/restored' };
  }
  try {
    await resumeNamespaceIngresses(ctx.k8s, ctx.namespace);
    return { status: 'ok', detail: 'unpatched tenant ingresses' };
  } catch (err) {
    return {
      status: 'failed',
      envelope: {
        title: 'Ingress resume failed',
        detail: err instanceof Error ? err.message : String(err),
        remediation: [
          'Check the namespace ingress objects for the tenant',
          'Re-run via the lifecycle scheduler retry tick',
        ],
        raw: err instanceof Error ? err.stack ?? err.message : String(err),
      },
    };
  }
}

export const ingressResumeHook: LifecycleHook = {
  name: 'ingress-resume',
  transitions: ['active', 'restored'],
  order: 300,
  blocking: 'continue',
  run: runIngressResume,
};

/**
 * ingress-reconcile hook — runs after ingress-resume.
 *
 * Triggers domains/k8s-ingress.ts:reconcileIngress to rebuild from
 * ingress_routes (handles both the redirect-annotation suspend (new)
 * AND any historical ingress swap if resuming a client that was
 * suspended under an older code path).
 */
async function runIngressReconcile(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'active' && ctx.transition !== 'restored') {
    return { status: 'noop', detail: 'transition is not active/restored' };
  }
  try {
    const { reconcileIngress } = await import('../../domains/k8s-ingress.js');
    await reconcileIngress(ctx.db, ctx.k8s, ctx.clientId, ctx.namespace);
    return { status: 'ok', detail: 'reconciled tenant ingresses from ingress_routes' };
  } catch (err) {
    return {
      status: 'failed',
      envelope: {
        title: 'Ingress reconcile failed',
        detail: err instanceof Error ? err.message : String(err),
        remediation: [
          'Verify ingress_routes for this client',
          'Re-run via the lifecycle scheduler retry tick',
        ],
        raw: err instanceof Error ? err.stack ?? err.message : String(err),
      },
    };
  }
}

export const ingressReconcileHook: LifecycleHook = {
  name: 'ingress-reconcile',
  transitions: ['active', 'restored'],
  order: 310,
  blocking: 'continue',
  // ingress-resume must complete before reconcile rewrites the spec
  // (otherwise the reconciled spec gets immediately swapped back).
  after: ['ingress-resume'],
  run: runIngressReconcile,
};

let _registered = false;
export function registerIngressHooks(): void {
  if (_registered) return;
  registerLifecycleHook(ingressSuspendHook);
  registerLifecycleHook(ingressResumeHook);
  registerLifecycleHook(ingressReconcileHook);
  _registered = true;
}
