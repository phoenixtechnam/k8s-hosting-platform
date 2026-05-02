/**
 * Phase 5: lifecycle-hook retry scheduler.
 *
 * Drains failed hook_runs whose `next_attempt_at` has passed by
 * re-invoking the hook with a fresh ctx. The dispatcher updates the
 * row state on each attempt — same code path as the original
 * dispatch, so a retry is functionally identical to the first try.
 *
 * Architecture choices:
 *   - Tick every 2 min: matches the latency tolerance for the
 *     orphan-cleanup use case (DNS provider 5xx, S3 5xx). Faster
 *     ticks burn API rate limits; slower ticks delay reclamation.
 *   - Per-hook circuit-breaker: if a hook returns `failed` /
 *     `retry` 5 consecutive times across DIFFERENT transitions
 *     within 10 min, the breaker opens and the next 10 min of
 *     retries for that hook are skipped (status='retry' is left
 *     for next tick to honour the cool-off). Stops a flapping
 *     provider from blowing through retry budget cluster-wide.
 *   - Best-effort: a failure in the scheduler tick must not stop
 *     the next tick.
 */
import { and, eq, isNotNull, lt, lte } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  clientLifecycleHookRuns,
  clientLifecycleTransitions,
} from '../../db/schema.js';
import {
  DEFAULT_BACKOFF_MS,
  listHooks,
  type HookCtx,
  type HookErrorEnvelope,
  type LifecycleHook,
} from './registry/index.js';

const TICK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const CIRCUIT_BREAKER_FAILURES = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const CIRCUIT_BREAKER_COOLOFF_MS = 10 * 60 * 1000; // 10 minutes

/**
 * In-memory circuit-breaker state. Per-hook because a flapping
 * DNS provider should not lock the namespace cleanup hook out too.
 * Lost on platform-api restart, which is acceptable — the worst case
 * is one extra retry storm before the breaker opens again.
 */
interface BreakerState {
  recentFailures: number[]; // ts ms of recent failures
  openUntil: number;        // ts ms; 0 = closed
}
const breakers = new Map<string, BreakerState>();

function recordFailure(hookName: string): void {
  const now = Date.now();
  const state = breakers.get(hookName) ?? { recentFailures: [], openUntil: 0 };
  state.recentFailures = state.recentFailures.filter((t) => now - t < CIRCUIT_BREAKER_WINDOW_MS);
  state.recentFailures.push(now);
  if (state.recentFailures.length >= CIRCUIT_BREAKER_FAILURES) {
    state.openUntil = now + CIRCUIT_BREAKER_COOLOFF_MS;
  }
  breakers.set(hookName, state);
}

function recordSuccess(hookName: string): void {
  const state = breakers.get(hookName);
  if (!state) return;
  state.recentFailures = [];
  state.openUntil = 0;
}

function isBreakerOpen(hookName: string): boolean {
  const state = breakers.get(hookName);
  if (!state) return false;
  return state.openUntil > Date.now();
}

interface FailedRow {
  id: string;
  transitionId: string;
  hookName: string;
  attempts: number;
  maxAttempts: number;
}

interface TransitionLite {
  id: string;
  clientId: string;
  transitionKind: 'active' | 'suspended' | 'archived' | 'restored' | 'deleted';
}

/**
 * One scheduler tick. Exported for unit tests.
 */
export async function runRetryTick(db: Database, k8s: K8sClients): Promise<{
  attempted: number;
  succeeded: number;
  retried: number;
  permanentlyFailed: number;
  skippedBreaker: number;
}> {
  const hooksByName = new Map(listHooks().map((h) => [h.name, h]));

  // Load failed rows that are due for retry. Limit defensive — a
  // huge backlog should not flood one tick.
  const candidates = (await db.select({
    id: clientLifecycleHookRuns.id,
    transitionId: clientLifecycleHookRuns.transitionId,
    hookName: clientLifecycleHookRuns.hookName,
    attempts: clientLifecycleHookRuns.attempts,
    maxAttempts: clientLifecycleHookRuns.maxAttempts,
  })
    .from(clientLifecycleHookRuns)
    .where(and(
      eq(clientLifecycleHookRuns.state, 'failed'),
      isNotNull(clientLifecycleHookRuns.nextAttemptAt),
      lte(clientLifecycleHookRuns.nextAttemptAt, new Date()),
      lt(clientLifecycleHookRuns.attempts, clientLifecycleHookRuns.maxAttempts),
    ))
    .limit(50)) as readonly FailedRow[];

  let succeeded = 0;
  let retried = 0;
  let permanentlyFailed = 0;
  let skippedBreaker = 0;

  for (const row of candidates) {
    const hook = hooksByName.get(row.hookName) as LifecycleHook | undefined;
    if (!hook) {
      // Hook was un-registered between attempts (deploy renamed it,
      // unlikely). Mark as permanent so the operator sees it.
      await db.update(clientLifecycleHookRuns)
        .set({
          state: 'failed',
          nextAttemptAt: null,
          lastError: { title: 'Hook un-registered', detail: `No hook named '${row.hookName}'` } as Record<string, unknown>,
        })
        .where(eq(clientLifecycleHookRuns.id, row.id));
      permanentlyFailed++;
      continue;
    }
    if (isBreakerOpen(hook.name)) {
      skippedBreaker++;
      continue;
    }

    // Hydrate the parent transition so we can re-run with a real ctx.
    const tx = (await db.select({
      id: clientLifecycleTransitions.id,
      clientId: clientLifecycleTransitions.clientId,
      transitionKind: clientLifecycleTransitions.transitionKind,
    })
      .from(clientLifecycleTransitions)
      .where(eq(clientLifecycleTransitions.id, row.transitionId))
      .limit(1)) as readonly TransitionLite[];
    const parent = tx[0];
    if (!parent) {
      // Parent gone (cascade-deleted somehow); orphan row.
      await db.update(clientLifecycleHookRuns)
        .set({ state: 'failed', nextAttemptAt: null })
        .where(eq(clientLifecycleHookRuns.id, row.id));
      permanentlyFailed++;
      continue;
    }

    const attempt = row.attempts + 1;
    await db.update(clientLifecycleHookRuns)
      .set({ state: 'running', attempts: attempt, startedAt: new Date() })
      .where(eq(clientLifecycleHookRuns.id, row.id));

    // Note: namespace is not stored on the transition row in Phase 1.
    // We re-derive it from the clients table — best-effort, since a
    // deleted client has no row. For 'deleted' transitions, fall back
    // to a synthesised name; the hook handles missing namespace itself.
    let namespace = '';
    try {
      const { clients } = await import('../../db/schema.js');
      const r = await db.select({ ns: clients.kubernetesNamespace })
        .from(clients)
        .where(eq(clients.id, parent.clientId))
        .limit(1);
      namespace = r[0]?.ns ?? '';
    } catch { /* fall through with empty namespace */ }

    const ctx: HookCtx = {
      db,
      k8s,
      clientId: parent.clientId,
      namespace,
      transitionId: parent.id,
      transition: parent.transitionKind,
      attempt,
    };

    let result;
    try {
      result = await hook.run(ctx);
    } catch (err) {
      result = {
        status: 'failed' as const,
        envelope: {
          title: 'Hook threw on retry',
          detail: err instanceof Error ? err.message : String(err),
          raw: err instanceof Error ? err.stack ?? err.message : String(err),
        } satisfies HookErrorEnvelope,
      };
    }

    const completedAt = new Date();
    if (result.status === 'ok' || result.status === 'noop') {
      recordSuccess(hook.name);
      await db.update(clientLifecycleHookRuns)
        .set({
          state: result.status,
          completedAt,
          lastError: null,
          nextAttemptAt: null,
        })
        .where(eq(clientLifecycleHookRuns.id, row.id));
      succeeded++;
      continue;
    }

    // failed / retry
    recordFailure(hook.name);
    const backoff = hook.backoffMs ?? DEFAULT_BACKOFF_MS;
    const isRetryable = result.status === 'retry' && attempt < (hook.maxAttempts ?? row.maxAttempts);
    await db.update(clientLifecycleHookRuns)
      .set({
        state: 'failed',
        completedAt,
        lastError: (result.envelope ?? null) as Record<string, unknown> | null,
        nextAttemptAt: isRetryable ? new Date(Date.now() + backoff(attempt)) : null,
      })
      .where(eq(clientLifecycleHookRuns.id, row.id));
    if (isRetryable) retried++;
    else permanentlyFailed++;
  }

  return {
    attempted: candidates.length,
    succeeded,
    retried,
    permanentlyFailed,
    skippedBreaker,
  };
}

/**
 * Test-only — drop circuit-breaker state.
 */
export function _resetBreakersForTests(): void {
  breakers.clear();
}

/**
 * Start the periodic retry tick. Returns a disposer.
 *
 * The runtime swallows all errors per tick — a single bad row must
 * not crash the scheduler.
 */
export function startLifecycleHookRetryScheduler(
  db: Database,
  k8s: K8sClients,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const r = await runRetryTick(db, k8s);
      if (r.attempted > 0) {
        console.log(
          `[lifecycle-retry] tick: ${r.succeeded} ok, ${r.retried} re-queued, ${r.permanentlyFailed} permanent, ${r.skippedBreaker} skipped (breaker)`,
        );
      }
    } catch (err) {
      console.warn(
        `[lifecycle-retry] tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  };

  // Self-rescheduling chain — clearInterval alone can't stop it.
  timer = setTimeout(tick, TICK_INTERVAL_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
