import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  clientLifecycleTransitions,
  clientLifecycleHookRuns,
} from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { topoSortForTransition } from './registry.js';
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  type HookCtx,
  type HookErrorEnvelope,
  type HookResult,
  type LifecycleHook,
  type Transition,
} from './types.js';

/**
 * Outcome of one dispatcher call. Intentionally narrow — callers should
 * inspect transitionId for the row id (so the UI can poll progress) and
 * `state` for the headline outcome.
 */
export interface DispatchResult {
  readonly transitionId: string;
  readonly state: 'completed' | 'failed_partial' | 'failed_blocking' | 'running';
  readonly hooksAttempted: number;
  readonly hooksOk: number;
  readonly hooksFailed: number;
}

export interface DispatchOptions {
  readonly clientId: string;
  readonly namespace: string;
  readonly transition: Transition;
  readonly fromStatus?: string | null;
  readonly toStatus: string;
  readonly triggeredByUserId?: string | null;
  readonly detail?: Record<string, unknown> | null;
  /**
   * When true (test-only), the dispatcher returns immediately after
   * writing the parent row + pending hook_runs without actually running
   * the hooks. Useful for verifying registry shape without side-effects.
   */
  readonly skipExecution?: boolean;
  /**
   * Override the registry's resolved hook list. Test-only. Production
   * always uses the topo-sorted result of `listHooks()`.
   */
  readonly hooksOverride?: readonly LifecycleHook[];
}

function envelopeFromError(err: unknown): HookErrorEnvelope {
  if (err instanceof Error) {
    return { title: err.name || 'Hook failed', detail: err.message, raw: err.stack ?? err.message };
  }
  return { title: 'Hook failed', detail: String(err), raw: String(err) };
}

/**
 * Run one transition through every registered hook.
 *
 * Phase 1: zero hooks registered → writes a `transitions` row (state=
 * completed, no hook_runs) and returns. This proves the wiring is in
 * place for legacy callers without changing behaviour.
 *
 * Phase 2+: hooks register, dispatcher writes pending hook_runs in topo
 * order, runs them sequentially, persists each result. On `abort`-blocking
 * failure, the dispatcher halts; remaining hooks stay `pending`. On
 * `continue`-blocking failure, the dispatcher carries on; transition ends
 * `failed_partial`. The scheduler retry tick (Phase 5) drains failed
 * rows where now() >= next_attempt_at.
 *
 * Persistence is per-hook (one UPDATE per hook before/after run) so a
 * crash mid-transition leaves an inspectable trail; the scheduler can
 * pick up `running` rows older than a threshold and force them to
 * `failed` on next tick.
 */
export async function runTransition(
  db: Database,
  k8s: K8sClients,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const transitionId = randomUUID();
  const startedAt = new Date();

  // 1. Insert parent row.
  await db.insert(clientLifecycleTransitions).values({
    id: transitionId,
    clientId: opts.clientId,
    transitionKind: opts.transition,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus,
    triggeredByUserId: opts.triggeredByUserId ?? null,
    state: 'running',
    startedAt,
    detail: opts.detail ?? null,
  });

  // 2. Resolve hooks (topo-sorted, deterministic).
  const hooks = opts.hooksOverride ?? topoSortForTransition(opts.transition);

  if (hooks.length === 0) {
    // Phase 1 path: nothing to do; mark completed and return.
    await db.update(clientLifecycleTransitions)
      .set({ state: 'completed', completedAt: new Date() })
      .where(eq(clientLifecycleTransitions.id, transitionId));
    return {
      transitionId,
      state: 'completed',
      hooksAttempted: 0,
      hooksOk: 0,
      hooksFailed: 0,
    };
  }

  // 3. Pre-insert pending rows so an in-flight crash leaves the queue
  //    visible to the operator. UNIQUE(transition_id, hook_name) prevents
  //    accidental duplication.
  for (let i = 0; i < hooks.length; i++) {
    const h = hooks[i];
    await db.insert(clientLifecycleHookRuns).values({
      id: randomUUID(),
      transitionId,
      hookName: h.name,
      hookOrder: i,
      blocking: h.blocking,
      state: 'pending',
      attempts: 0,
      maxAttempts: h.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
  }

  if (opts.skipExecution) {
    return {
      transitionId,
      state: 'running',
      hooksAttempted: 0,
      hooksOk: 0,
      hooksFailed: 0,
    };
  }

  // 4. Run hooks sequentially. We always honour topo order — parallel
  //    hooks would need explicit `parallel: true` opt-in (not in v1).
  let hooksOk = 0;
  let hooksFailed = 0;
  let aborted = false;

  for (const hook of hooks) {
    const runRow = await db.select().from(clientLifecycleHookRuns)
      .where(eq(clientLifecycleHookRuns.transitionId, transitionId))
      .then((rows) => rows.find((r) => r.hookName === hook.name));
    if (!runRow) continue; // shouldn't happen — pre-inserted above

    if (aborted) {
      // Leave remaining rows `pending` so the scheduler can resume after
      // the upstream blocker is fixed.
      continue;
    }

    const attempt = runRow.attempts + 1;
    await db.update(clientLifecycleHookRuns)
      .set({ state: 'running', attempts: attempt, startedAt: new Date() })
      .where(eq(clientLifecycleHookRuns.id, runRow.id));

    let result: HookResult;
    try {
      const ctx: HookCtx = {
        db,
        k8s,
        clientId: opts.clientId,
        namespace: opts.namespace,
        transitionId,
        transition: opts.transition,
        attempt,
      };
      result = await hook.run(ctx);
    } catch (err) {
      result = {
        status: 'failed',
        envelope: envelopeFromError(err),
      };
    }

    const completedAt = new Date();
    if (result.status === 'ok' || result.status === 'noop') {
      await db.update(clientLifecycleHookRuns)
        .set({
          state: result.status,
          completedAt,
          lastError: null,
          nextAttemptAt: null,
        })
        .where(eq(clientLifecycleHookRuns.id, runRow.id));
      hooksOk++;
    } else {
      hooksFailed++;
      const maxAttempts = hook.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const backoff = hook.backoffMs ?? DEFAULT_BACKOFF_MS;
      const isRetryable = result.status === 'retry' && attempt < maxAttempts;
      await db.update(clientLifecycleHookRuns)
        .set({
          state: 'failed',
          completedAt,
          lastError: (result.envelope ?? null) as Record<string, unknown> | null,
          nextAttemptAt: isRetryable ? new Date(Date.now() + backoff(attempt)) : null,
        })
        .where(eq(clientLifecycleHookRuns.id, runRow.id));
      if (hook.blocking === 'abort') {
        aborted = true;
      }
    }
  }

  // 5. Resolve transition state.
  let finalState: DispatchResult['state'];
  if (aborted) {
    finalState = 'failed_blocking';
  } else if (hooksFailed > 0) {
    finalState = 'failed_partial';
  } else {
    finalState = 'completed';
  }

  await db.update(clientLifecycleTransitions)
    .set({
      state: finalState,
      completedAt: new Date(),
    })
    .where(eq(clientLifecycleTransitions.id, transitionId));

  return {
    transitionId,
    state: finalState,
    hooksAttempted: hooksOk + hooksFailed,
    hooksOk,
    hooksFailed,
  };
}
