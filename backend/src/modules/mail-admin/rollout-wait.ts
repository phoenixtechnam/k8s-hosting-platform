/**
 * Shared rollout-wait helper for the Stalwart Deployment.
 *
 * Three modules touch the Deployment and need to know when a rollout
 * has settled:
 *   - port-exposure.ts: after the mode-flip SSA-apply
 *   - migration.ts: after scaling replicas up/down during DR / failover
 *   - archive.ts: uses pod-counting instead (waits for LOCK release on
 *     the live PVC, not a Deployment-spec rollout) — does NOT call this
 *
 * Before this consolidation each caller had its own poll loop with
 * subtly different completeness:
 *   - port-exposure checked observedGeneration + updatedReplicas +
 *     readyReplicas + unavailableReplicas (most complete, mirrors
 *     `kubectl rollout status`)
 *   - migration checked readyReplicas only — fine for its use case
 *     (scale-up after PVC swap) but misses the case where the new
 *     generation hasn't been observed yet
 *
 * `waitForStalwartRollout` is the most-complete check; `waitForStalwartReplicaCount`
 * is the narrower variant for "I just want a specific replica count
 * ready" without caring about generation.
 */

import { ApiError } from '../../shared/errors.js';

const MAIL_NS = 'mail';
const DEPLOYMENT_NAME = 'stalwart-mail';

type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;

interface DeploymentRolloutShape {
  metadata?: { generation?: number };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    unavailableReplicas?: number;
  };
}

/**
 * Wait until the Stalwart Deployment's rollout has fully settled.
 *
 * "Settled" means:
 *   - observedGeneration >= metadata.generation (apiserver caught up)
 *   - updatedReplicas == spec.replicas (all pods on new template)
 *   - readyReplicas    == spec.replicas (all pods Ready)
 *   - unavailableReplicas == 0
 *
 * Throws:
 *   MAIL_DEPLOYMENT_SCALED_TO_ZERO (409) — refuses to consider
 *     replicas=0 a "settled" state, because another orchestrator
 *     (archive downtime, DR migration) is scaling down concurrently.
 *     Callers should retry after the concurrent op finishes.
 *   MAIL_DEPLOYMENT_ROLLOUT_READ_FAILED (500) — apiserver unreachable.
 *   MAIL_DEPLOYMENT_ROLLOUT_TIMEOUT (504) — rollout didn't finish.
 *
 * Default timeout: 90s. Covers local-path PVC re-attach + the
 * `restore-state` initContainer cold-start.
 */
export async function waitForStalwartRollout(
  apps: AppsV1Api,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastObservedGen = -1;
  let lastUpdatedReplicas = -1;
  let lastUnavailable = -1;
  while (Date.now() < deadline) {
    let dep: DeploymentRolloutShape;
    try {
      dep = await apps.readNamespacedDeployment({
        namespace: MAIL_NS,
        name: DEPLOYMENT_NAME,
      }) as DeploymentRolloutShape;
    } catch (err) {
      throw new ApiError(
        'MAIL_DEPLOYMENT_ROLLOUT_READ_FAILED',
        `Could not read Stalwart Deployment during rollout wait: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    const generation = dep.metadata?.generation ?? 0;
    const observedGeneration = dep.status?.observedGeneration ?? -1;
    const replicas = dep.spec?.replicas ?? 0;
    const updatedReplicas = dep.status?.updatedReplicas ?? 0;
    const readyReplicas = dep.status?.readyReplicas ?? 0;
    const unavailableReplicas = dep.status?.unavailableReplicas ?? 0;
    lastObservedGen = observedGeneration;
    lastUpdatedReplicas = updatedReplicas;
    lastUnavailable = unavailableReplicas;
    // Refuse to treat replicas=0 as settled — see HIGH-1 in the
    // streamline code review. Caller should retry after concurrent op.
    if (replicas === 0) {
      throw new ApiError(
        'MAIL_DEPLOYMENT_SCALED_TO_ZERO',
        'Stalwart Deployment has replicas=0 — another operation (archive downtime / DR failover) is in progress. Wait for it to complete before flipping port-exposure mode.',
        409,
      );
    }
    if (
      observedGeneration >= generation
      && updatedReplicas === replicas
      && readyReplicas === replicas
      && unavailableReplicas === 0
    ) {
      return;
    }
    await sleepMs(pollIntervalMs);
  }
  throw new ApiError(
    'MAIL_DEPLOYMENT_ROLLOUT_TIMEOUT',
    `Stalwart Deployment rollout did not complete within ${Math.floor(timeoutMs / 1000)}s `
    + `(observedGen=${lastObservedGen}, updatedReplicas=${lastUpdatedReplicas}, unavailable=${lastUnavailable})`,
    504,
  );
}

/**
 * Wait until the Stalwart Deployment has the given replica count
 * Ready. Narrower than `waitForStalwartRollout` — does NOT check
 * generation/template-update. Use this for replica-count-only
 * mutations (DR migration's scale-to-0 + scale-to-1 sequence) where
 * the template is unchanged.
 *
 * Returns when:
 *   target == 0: status.replicas == 0 AND readyReplicas == 0 AND
 *                unavailableReplicas == 0 — the actual pod is gone,
 *                not just unready. Checking `readyReplicas==0` alone
 *                fires too early: a pod that is terminating already
 *                reports `Ready=false` while it still holds the RWO
 *                PVC LOCK, and a downstream rsync would race the
 *                lock release.
 *   target > 0:  readyReplicas >= target.
 *
 * Throws:
 *   MAIL_MIGRATION_SCALE_READ_FAILED (500) — apiserver unreachable.
 *     Without this wrap, the raw SDK error bypasses the structured
 *     ApiError path and surfaces as a generic 500 with an internal
 *     stack trace, which is exactly the kind of leak the ApiError
 *     pattern exists to prevent.
 *   MAIL_MIGRATION_SCALE_TIMEOUT (500) — target not reached in time.
 */
export async function waitForStalwartReplicaCount(
  apps: AppsV1Api,
  target: number,
  opts: { timeoutSeconds?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutSeconds = opts.timeoutSeconds ?? 90;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    let dep: DeploymentRolloutShape;
    try {
      dep = await apps.readNamespacedDeployment({
        name: DEPLOYMENT_NAME,
        namespace: MAIL_NS,
      }) as DeploymentRolloutShape;
    } catch (err) {
      throw new ApiError(
        'MAIL_MIGRATION_SCALE_READ_FAILED',
        `Could not read Stalwart Deployment during replica-count wait: ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
    const status = dep.status;
    const liveReplicas = status?.replicas ?? 0;
    const ready = status?.readyReplicas ?? 0;
    const unavailable = status?.unavailableReplicas ?? 0;
    if (target === 0 && liveReplicas === 0 && ready === 0 && unavailable === 0) return;
    if (target > 0 && ready >= target) return;
    await sleepMs(pollIntervalMs);
  }
  throw new ApiError(
    'MAIL_MIGRATION_SCALE_TIMEOUT',
    `Stalwart Deployment did not reach ${target} ready replica(s) within ${timeoutSeconds}s`,
    500,
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
