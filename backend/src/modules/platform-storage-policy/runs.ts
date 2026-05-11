/**
 * Apply HA / Apply Local run tracking.
 *
 * Each PATCH /admin/platform-storage-policy invocation INSERTs a row,
 * the synchronous applyPolicy() finishes within ~5 s and updates the
 * row with `patch_outcome_json`, then a background convergence watcher
 * polls the cluster every 5 s for up to 10 min and updates
 * `convergence_json` with the % of resources that have reached the
 * desired state. Final status is one of:
 *
 *   succeeded         — every resource patched + every volume/cluster
 *                        observed at desired count within the watch
 *                        window
 *   partial           — patches succeeded but at least one volume
 *                        currentReplicas != desiredReplicas after
 *                        10 min (Longhorn rebuild slow, CNPG join
 *                        stuck, etc.)
 *   failed            — at least one synchronous patch errored
 *   capacity_blocked  — patchCnpgClusters hit INSUFFICIENT_STORAGE
 *
 * The frontend ApplyHaProgressModal polls `/runs/:id` every 2 s while
 * status === 'running' and renders the patch list + convergence bar.
 */

import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { platformStorageApplyRuns } from '../../db/schema.js';
import { readClusterState } from './service.js';
import * as tasks from '../tasks/service.js';
import { toSafeText } from '@k8s-hosting/api-contracts';
import type { ApplyPolicyOutcome } from './service.js';

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'capacity_blocked';

export interface ConvergenceSnapshot {
  readonly volumesConverged: number;
  readonly volumesTotal: number;
  readonly volumesOffSystem: number;
  readonly cnpgConverged: number;
  readonly cnpgTotal: number;
  readonly deploymentsConverged: number;
  readonly deploymentsTotal: number;
  readonly lastObservedAt: string;
  readonly elapsedMs: number;
  readonly stuckResources: ReadonlyArray<{ kind: 'volume' | 'cnpg' | 'deployment'; name: string; observed: number; desired: number; reason?: string }>;
}

export async function startRun(
  db: Database,
  tier: 'local' | 'ha',
  actorUserId: string | null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(platformStorageApplyRuns).values({
    id,
    tier,
    actorUserId,
    status: 'running',
    startedAt: new Date(),
  });
  return id;
}

export async function recordPatchOutcome(
  db: Database,
  runId: string,
  outcome: ApplyPolicyOutcome,
): Promise<void> {
  await db.update(platformStorageApplyRuns)
    .set({ patchOutcomeJson: outcome as unknown as Record<string, unknown> })
    .where(eq(platformStorageApplyRuns.id, runId));
}

export async function finishRun(
  db: Database,
  runId: string,
  status: RunStatus,
  convergence: ConvergenceSnapshot | null,
): Promise<void> {
  await db.update(platformStorageApplyRuns)
    .set({
      status,
      finishedAt: new Date(),
      ...(convergence ? { convergenceJson: convergence as unknown as Record<string, unknown> } : {}),
    })
    .where(eq(platformStorageApplyRuns.id, runId));

  // Mirror the terminal state onto the task-center entry registered in
  // routes.ts. Done here (rather than at each call site) so every run
  // closure path — the early-return for failed patches, the
  // all-converged exit, and the timeout fallthrough — flips the chip
  // entry consistently. Non-fatal on error; the run row is the source
  // of truth.
  //
  // Mapping:
  //   succeeded         → task succeeded (progress 100%)
  //   partial           → task succeeded with note (operator can re-open
  //                       the modal to see what's still rebuilding)
  //   failed            → task failed with generic message; per-resource
  //                       errors live in the run's patch_outcome_json
  //   capacity_blocked  → task failed with capacity message
  const taskFinish: {
    status: 'succeeded' | 'failed';
    error?: string;
    text?: ReturnType<typeof toSafeText>;
  } =
      status === 'succeeded'
        ? { status: 'succeeded', text: toSafeText('All resources at desired state.') }
        : status === 'partial'
          ? { status: 'succeeded', text: toSafeText('Apply succeeded — some resources still rebuilding in background.') }
          : status === 'capacity_blocked'
            ? { status: 'failed', error: 'Insufficient storage capacity — see modal for details.' }
            : { status: 'failed', error: 'Apply failed — see modal for per-resource errors.' };

  await tasks.finishByRef(db, 'storage.tier-flip', runId, taskFinish)
    .catch(() => { /* non-fatal; run row is authoritative */ });
}

export async function updateConvergence(
  db: Database,
  runId: string,
  convergence: ConvergenceSnapshot,
): Promise<void> {
  await db.update(platformStorageApplyRuns)
    .set({ convergenceJson: convergence as unknown as Record<string, unknown> })
    .where(eq(platformStorageApplyRuns.id, runId));
}

/**
 * Compute the current convergence snapshot. Reads cluster state
 * (volumes from readClusterState which already does the diff), CNPG
 * cluster instance status, and deployment readyReplicas. Returns a
 * snapshot the watcher can write to convergence_json.
 */
export async function computeConvergence(
  k8s: K8sClients,
  db: Database,
  startedAtMs: number,
): Promise<ConvergenceSnapshot> {
  const state = await readClusterState(k8s, db);
  const stuckResources: Array<ConvergenceSnapshot['stuckResources'][number]> = [];

  let volumesConverged = 0;
  let volumesOffSystem = 0;
  for (const v of state.volumes) {
    if (v.currentReplicas === v.desiredReplicas && !v.hasOffSystemReplica && v.healthy) {
      volumesConverged++;
    } else {
      stuckResources.push({
        kind: 'volume',
        name: `${v.namespace}/${v.pvcName}`,
        observed: v.currentReplicas,
        desired: v.desiredReplicas,
        reason: v.hasOffSystemReplica ? 'replica on non-system node' : (v.phase ?? 'unknown'),
      });
    }
    if (v.hasOffSystemReplica) volumesOffSystem++;
  }

  // CNPG instance convergence: spec.instances must equal status.readyInstances
  // (CNPG sets readyInstances on .status). For each CNPG cluster, fetch
  // and compare. If status.readyInstances < spec.instances, that's a
  // join still in flight.
  let cnpgConverged = 0;
  let cnpgTotal = 0;
  try {
    const cnpgList = await (k8s.custom as unknown as {
      listClusterCustomObject: (a: { group: string; version: string; plural: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string; namespace?: string }; spec?: { instances?: number }; status?: { instances?: number; readyInstances?: number; phase?: string } }> }>;
    }).listClusterCustomObject({
      group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters',
    });
    for (const c of cnpgList.items ?? []) {
      // Only count platform/system-db + mail/mail-db (the system clusters,
      // renamed 2026-05-07 from postgres + mail-pg). See CNPG_CLUSTERS in
      // ./service.ts — keep this filter in sync with that list.
      const ns = c.metadata?.namespace;
      const name = c.metadata?.name;
      if (!ns || !name) continue;
      if (!((ns === 'platform' && name === 'system-db') || (ns === 'mail' && name === 'mail-db'))) continue;
      cnpgTotal++;
      const desired = c.spec?.instances ?? 0;
      const ready = c.status?.readyInstances ?? 0;
      if (ready === desired && c.status?.phase === 'Cluster in healthy state') {
        cnpgConverged++;
      } else {
        stuckResources.push({
          kind: 'cnpg',
          name: `${ns}/${name}`,
          observed: ready,
          desired,
          reason: c.status?.phase ?? 'unknown',
        });
      }
    }
  } catch { /* best effort */ }

  let deploymentsConverged = 0;
  let deploymentsTotal = 0;
  try {
    const deps = await (k8s.apps as unknown as {
      listNamespacedDeployment: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string; namespace?: string }; spec?: { replicas?: number }; status?: { readyReplicas?: number } }> }>;
    }).listNamespacedDeployment({ namespace: 'platform' });
    const tracked = new Set(['admin-panel', 'client-panel', 'platform-api', 'oauth2-proxy', 'dex']);
    for (const d of deps.items ?? []) {
      const name = d.metadata?.name ?? '';
      if (!tracked.has(name)) continue;
      deploymentsTotal++;
      const desired = d.spec?.replicas ?? 0;
      const ready = d.status?.readyReplicas ?? 0;
      if (ready === desired && desired > 0) {
        deploymentsConverged++;
      } else {
        stuckResources.push({
          kind: 'deployment',
          name: `platform/${name}`,
          observed: ready,
          desired,
        });
      }
    }
  } catch { /* best effort */ }

  return {
    volumesConverged,
    volumesTotal: state.volumes.length,
    volumesOffSystem,
    cnpgConverged,
    cnpgTotal,
    deploymentsConverged,
    deploymentsTotal,
    lastObservedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    stuckResources: stuckResources.slice(0, 20),
  };
}

/**
 * Minimal logger interface — receives whatever has at least the
 * pino-shaped `error` + `info` methods (Fastify's `app.log` qualifies).
 * Lets the route handler pass its scoped logger so `[apply-run <id>]`
 * lines flow through the JSON-log pipeline instead of bypassing via
 * console.error.
 */
export interface WatchLogger {
  error(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
}

/**
 * Background convergence watcher. Fired by the PATCH route AFTER the
 * synchronous patch outcome is recorded. Polls every 5 s for up to
 * 10 min, updating convergence_json. Final status: succeeded if all
 * resources converged, partial if any are still stuck at timeout.
 *
 * Crash-safe: the run row's status stays 'running' if the watcher's
 * process dies. A startup hook can re-claim runs older than 1 h and
 * mark them 'partial' (TODO when we have multi-replica concerns).
 */
export async function watchConvergence(
  k8s: K8sClients,
  db: Database,
  runId: string,
  startedAtMs: number,
  initialStatus: RunStatus,
  log?: WatchLogger,
): Promise<void> {
  const POLL_MS = 5_000;
  const TIMEOUT_MS = 10 * 60_000;

  // If the patch phase already failed (capacity_blocked / failed),
  // record the failure and skip convergence polling — there's
  // nothing to converge to.
  if (initialStatus !== 'running') {
    const conv = await computeConvergence(k8s, db, startedAtMs).catch(() => null);
    await finishRun(db, runId, initialStatus, conv);
    return;
  }

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    let conv: ConvergenceSnapshot;
    try {
      conv = await computeConvergence(k8s, db, startedAtMs);
    } catch (err) {
      log?.error({ runId, err: (err as Error).message }, 'apply-run convergence poll failed');
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    await updateConvergence(db, runId, conv).catch(() => undefined);

    const allConverged =
      conv.volumesConverged === conv.volumesTotal &&
      conv.cnpgConverged === conv.cnpgTotal &&
      conv.deploymentsConverged === conv.deploymentsTotal;
    if (allConverged) {
      await finishRun(db, runId, 'succeeded', conv);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Timed out — final snapshot then mark partial.
  const final = await computeConvergence(k8s, db, startedAtMs).catch(() => null);
  await finishRun(db, runId, 'partial', final);
}
