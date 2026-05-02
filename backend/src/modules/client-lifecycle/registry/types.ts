import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';

/**
 * Five canonical client transitions handled by the unified registry.
 * Matches `client_lifecycle_transition_kind` in migration 0069.
 *
 * Notes:
 *   - `active` covers both pending→active provisioning and suspended→active resume.
 *   - `restored` is archived→active driven by storage-lifecycle restore op.
 *     Distinguished from plain `active` so hooks can run different logic
 *     (e.g. recreate workloads vs. just flip ingress backend).
 *   - `deleted` is the hard-delete cascade.
 */
export type Transition = 'active' | 'suspended' | 'archived' | 'restored' | 'deleted';

/**
 * Hook outcome. The dispatcher persists `state` to client_lifecycle_hook_runs.
 *
 *   - ok     The hook did work and finished.
 *   - noop   The hook had nothing to do (resource already absent / already
 *            in target state). Functionally identical to ok but distinguished
 *            for observability — a constant stream of `ok` from a hook that
 *            should usually be `noop` indicates a bug.
 *   - retry  Transient failure; the dispatcher writes `state=failed` and
 *            schedules `next_attempt_at = now() + backoff(attempt)`.
 *   - failed Permanent failure; the dispatcher honours `blocking` to decide
 *            whether to abort the transition or carry on.
 */
export type HookResultStatus = 'ok' | 'noop' | 'retry' | 'failed';

/**
 * OperatorError envelope (matches `feedback_operator_error_envelope.md`).
 * Subset of the UI <ErrorPanel> contract — title + detail + remediation
 * steps. Hooks SHOULD populate this on `failed`/`retry` so the UI doesn't
 * have to translate raw k8s/longhorn error strings.
 */
export interface HookErrorEnvelope {
  readonly title: string;
  readonly detail?: string;
  readonly remediation?: readonly string[];
  readonly raw?: string;
}

export interface HookResult {
  readonly status: HookResultStatus;
  readonly detail?: string;
  readonly envelope?: HookErrorEnvelope;
}

/**
 * Per-invocation context passed to every hook. Construction is the
 * dispatcher's responsibility — hooks never new() their own clients so
 * tests can inject fakes.
 */
export interface HookCtx {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clientId: string;
  /** Tenant namespace name. Empty string is invalid — caller validates. */
  readonly namespace: string;
  readonly transitionId: string;
  readonly transition: Transition;
  /** Current attempt number, starting at 1 for the first try. */
  readonly attempt: number;
  /**
   * Optional structured logger. Defaults to no-op so unit tests don't
   * need to inject one. Use this for non-fatal diagnostics; for failures
   * return a `failed` HookResult with an envelope instead.
   */
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

export type BlockingPolicy = 'abort' | 'continue';

/**
 * Hook contract.
 *
 *   - `name` must be globally unique across transitions. Same hook can
 *     be registered for multiple transitions; the registry deduplicates
 *     definitions and indexes them by (transition, name).
 *   - `transitions` is the array of transitions this hook participates in.
 *     A single hook entry can declare e.g. ['active', 'restored'] when
 *     the same logic applies; per-transition specialisation goes in
 *     separate hooks.
 *   - `order` is sparse (recommended 100, 200, 300…) so future hooks can
 *     slot between existing ones without renumbering.
 *   - `blocking` decides what happens on failure: `abort` halts the
 *     dispatcher (transition state → failed_blocking; remaining hooks
 *     stay pending until the scheduler retry succeeds). `continue`
 *     records the failure and proceeds (transition ends failed_partial
 *     if any hook failed `continue`).
 *   - `after` declares hard ordering constraints across hooks. The
 *     registry runs a topological sort at boot so order + after must be
 *     consistent (no cycles).
 *   - `maxAttempts` defaults to 5; hooks needing different retry budgets
 *     override.
 *   - `backoffMs(attempt)` returns ms to wait before the next attempt.
 *     Default: exponential 5s, 10s, 20s, 40s, 80s capped at 5min.
 */
export interface LifecycleHook {
  readonly name: string;
  readonly transitions: readonly Transition[];
  readonly order: number;
  readonly blocking: BlockingPolicy;
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  readonly after?: readonly string[];
  run(ctx: HookCtx): Promise<HookResult>;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = (attempt: number): number => {
  // 5s, 10s, 20s, 40s, 80s, capped at 5min
  const base = 5_000 * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, 5 * 60 * 1000);
};
