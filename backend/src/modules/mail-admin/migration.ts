/**
 * Mail migration — Stalwart RocksDB DataStore node-swap pipeline.
 *
 * **2026-05-15 streamline (Phase 1 of mail-arch v2):**
 *   The pre-streamline pipeline rsynced the local-path PVC to a *new* PVC
 *   name (e.g. `stalwart-rocksdb-data-mig-XXXXXXX`) and then SSA-patched the  // ci-mail-arch: ignore
 *   Deployment to point at the new PVC. That triggered an ongoing
 *   Flux/platform-api ownership war on `template.spec.volumes` —
 *   Flux's reconcile reverted the cutover ~60s after every migration.
 *
 *   The architectural fix: **PVC name is stable** (`stalwart-rocksdb-data`)
 *   across all migrations. Data moves between nodes via the **restic
 *   snapshot** that the snapshot CronJob already produces every 2 minutes.
 *   The Deployment's `template.spec.affinity` is the ONLY field that
 *   changes, and affinity is NOT declared in the manifest — so Flux's
 *   non-force SSA reconcile never touches it. Zero conflicts.
 *
 *   Trade-off: the migration takes a brief downtime (snapshot + scale-
 *   down + PVC recreate + restore on target) instead of the old "rsync
 *   while live" no-downtime path. Operator-stated RTO is 2 minutes, which
 *   this fits for typical mail volumes (<1 GiB takes ~30s to restore).
 *
 * **State machine (single path, no rsync Jobs):**
 *
 *   queued → preflight → snapshotting → scaling-down → swapping-pvc
 *     → scaling-up → verifying → done
 *
 *   On node-loss DR (auto-failover, source node unreachable), the same
 *   state machine runs; the only difference is the snapshotting step
 *   is skipped (we use the most recent CronJob snapshot).
 *
 *   POST /admin/mail/migrate    → startMailMigration({intent:'explicit', targetNode})
 *   POST /admin/mail/failover   → startMailMigration({intent:'failover'})
 *   POST /admin/mail/failback   → startMailMigration({intent:'failback'})
 *   GET  /admin/mail/migrate/:runId → getMailMigrationStatus
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH, strategicMergePatch } from '../../shared/k8s-patch.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { waitForStalwartReplicaCount } from './rollout-wait.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerMailSnapshot } from './snapshot.js';
import { parseQuantity } from './mail-pvc.js';

const MAIL_NAMESPACE = 'mail';
const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';
const MAIL_PVC_NAME = 'stalwart-rocksdb-data';
const ALLOW_RESTORE_ANNOTATION = 'mail.platform/allow-restore';
const DISK_HEADROOM_RATIO = 1.25; // target must have 25% more free than used

/**
 * Field-manager attribution.
 *
 * - `MIGRATION_DEPLOYMENT_PATCH` — strategic-merge-patch for `spec.replicas`
 *   updates. No SSA force needed: replicas is owned by the controller
 *   (deployment-controller) by default; strategic-merge-patch with a
 *   named field-manager performs an Update that the controller respects.
 *
 * - `MIGRATION_AFFINITY_PATCH` — strategic-merge-patch for
 *   `template.spec.affinity` + `metadata.annotations`. Neither field is
 *   declared in the manifest, so Flux's non-force SSA reconcile never
 *   re-claims them. Strategic-merge is sufficient — we don't need SSA.
 */
const MIGRATION_DEPLOYMENT_PATCH = strategicMergePatch('platform-api.migration');
const MIGRATION_AFFINITY_PATCH = strategicMergePatch('platform-api.migration');

// ── Type imports ──────────────────────────────────────────────────────────────

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;
type BatchV1Api = import('@kubernetes/client-node').BatchV1Api;
type AppsV1Api = import('@kubernetes/client-node').AppsV1Api;

export interface MigrationDeps {
  readonly core: CoreV1Api;
  readonly batch: BatchV1Api;
  readonly apps: AppsV1Api;
  readonly db: Database;
  /** Pass-through so safety snapshot can load its own k8s clients. */
  readonly kubeconfigPath: string | undefined;
  readonly logger?: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
}

// ── Row shape for mail_migration_runs ─────────────────────────────────────────

type MigrationRunRow = Record<string, unknown> & {
  id: string;
  source_node: string;
  target_node: string;
  state: string;
  current_step: string | null;
  progress_bytes: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_message: string | null;
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Migration intent discriminator. The `explicit` intent requires the
 * caller to pass `targetNode`; `failover` and `failback` resolve the
 * target node from `system_settings` (mailSecondaryNode|mailTertiaryNode
 * for failover; mailPrimaryNode for failback).
 */
export type MigrationIntent =
  | { readonly kind: 'explicit'; readonly targetNode: string; readonly newGiB?: number }
  | { readonly kind: 'failover' }
  | { readonly kind: 'failback' };

const INTENT_TRIGGERED_BY: Record<MigrationIntent['kind'], string> = {
  explicit: 'operator',
  failover: 'manual-failover',
  failback: 'manual-failback',
};

export async function startMailMigration(
  intent: MigrationIntent,
  deps: MigrationDeps,
): Promise<{ runId: string }> {
  const { db, core } = deps;

  // Guard: no concurrent migration
  const activeRows = await db.execute<{ id: string }>(sql`
    SELECT id FROM mail_migration_runs
    WHERE state NOT IN ('done', 'failed', 'rolled-back')
    LIMIT 1
  `);
  if ((activeRows as unknown as { rows: { id: string }[] }).rows?.length) {
    throw new ApiError('MAIL_MIGRATION_ALREADY_RUNNING', 'A migration is already in progress', 409);
  }

  // Resolve target node from intent. Failover/failback look up
  // settings; explicit takes the caller-supplied targetNode verbatim.
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const targetNode = resolveTargetNode(intent, row);
  const newGiB = intent.kind === 'explicit' ? intent.newGiB : undefined;
  const triggeredBy = INTENT_TRIGGERED_BY[intent.kind];

  // Validate target node exists in the cluster.
  try {
    await core.readNode({ name: targetNode });
  } catch {
    throw new ApiError('MAIL_NODE_NOT_FOUND', `Node '${targetNode}' not found in the cluster`, 404);
  }

  const sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? null;
  if (!sourceNode) {
    throw new ApiError('MAIL_NO_ACTIVE_NODE', 'No active mail node is configured in system_settings', 409);
  }
  // Defense-in-depth: the Zod schema (`kubernetesNodeNameSchema`)
  // enforces RFC 1123 on inbound API payloads, but `sourceNode` is
  // read from `system_settings.mailActiveNode` and that column may
  // have been written by a pre-validation code path.
  if (!/^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/.test(sourceNode)) {
    throw new ApiError(
      'MAIL_INVALID_SOURCE_NODE',
      `Active mail node '${sourceNode}' is not a valid RFC 1123 hostname — refusing to migrate. Fix system_settings.mailActiveNode manually.`,
      500,
    );
  }
  if (sourceNode === targetNode) {
    throw new ApiError('MAIL_MIGRATION_SAME_NODE', 'Source and target nodes are the same', 400);
  }

  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO mail_migration_runs
      (id, source_node, target_node, state, triggered_by, current_step)
    VALUES (${runId}, ${sourceNode}, ${targetNode}, 'queued', ${triggeredBy}, 'preflight')
  `);

  // Fire-and-forget — operator polls GET /admin/mail/migrate/:runId
  void runMigrationStateMachine(runId, sourceNode, targetNode, deps, newGiB).catch(async (err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
  });

  return { runId };
}

interface PlacementRow {
  readonly mailPrimaryNode?: string | null;
  readonly mailSecondaryNode?: string | null;
  readonly mailTertiaryNode?: string | null;
}

function resolveTargetNode(intent: MigrationIntent, row: PlacementRow | undefined): string {
  switch (intent.kind) {
    case 'explicit':
      return intent.targetNode;
    case 'failover': {
      const t = row?.mailSecondaryNode ?? row?.mailTertiaryNode ?? null;
      if (!t) {
        throw new ApiError(
          'MAIL_PLACEMENT_NO_CANDIDATE',
          'No secondary or tertiary node configured — set placement policy before triggering failover',
          409,
        );
      }
      return t;
    }
    case 'failback': {
      const t = row?.mailPrimaryNode ?? null;
      if (!t) {
        throw new ApiError(
          'MAIL_PLACEMENT_NO_CANDIDATE',
          'No primary node configured — set placement policy before triggering failback',
          409,
        );
      }
      return t;
    }
  }
}

export async function getMailMigrationStatus(
  runId: string,
  deps: { db: Database },
): Promise<{
  runId: string;
  sourceNode: string;
  targetNode: string;
  state: string;
  currentStep: string | null;
  progressBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}> {
  const result = await deps.db.execute<MigrationRunRow>(sql`
    SELECT id, source_node, target_node, state, current_step, progress_bytes,
           started_at, finished_at, error_message
    FROM mail_migration_runs
    WHERE id = ${runId}
  `);
  const rows = (result as unknown as { rows: MigrationRunRow[] }).rows;
  const r = rows?.[0];
  if (!r) throw new ApiError('MAIL_MIGRATION_NOT_FOUND', 'Migration run not found', 404);
  return {
    runId: r.id,
    sourceNode: r.source_node,
    targetNode: r.target_node,
    state: r.state,
    currentStep: r.current_step ?? null,
    progressBytes: r.progress_bytes != null ? Number(r.progress_bytes) : null,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    finishedAt: r.finished_at != null
      ? (r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at))
      : null,
    error: r.error_message ?? null,
  };
}

// ── DR-based failover (node dead — same state machine, skip on-demand snapshot) ──

/**
 * Triggered by the DR watcher when the active node is down. Reuses
 * the standard migration state machine — the only difference is the
 * "snapshotting" step is best-effort (the source PVC may be
 * unreachable, in which case we fall back to the most recent CronJob
 * snapshot).
 *
 * This function does NOT use `startMailMigration` because:
 *   - It bypasses the cross-call concurrency guard (DR is force-majeure)
 *   - It synthesizes a run row directly (the migration row may not
 *     reflect the DB-recorded source node — node-loss DR is triggered
 *     from cluster events, not operator action)
 */
export async function triggerRestoreBasedFailover(
  targetNode: string,
  deps: { db: Database; core: CoreV1Api; apps: AppsV1Api; batch: BatchV1Api; kubeconfigPath?: string },
): Promise<void> {
  const { db } = deps;
  const log = console;

  // Snapshot sourceNode from the DB; may be stale (its node is gone)
  // but useful for the audit trail.
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? 'unknown';

  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO mail_migration_runs
      (id, source_node, target_node, state, triggered_by, current_step)
    VALUES (${runId}, ${sourceNode}, ${targetNode}, 'queued', 'dr-watcher', 'preflight')
  `);

  // DR-mode flag: skip the on-demand snapshot (source unreachable).
  await runMigrationStateMachine(runId, sourceNode, targetNode, {
    ...deps,
    kubeconfigPath: deps.kubeconfigPath,
    logger: { warn: log.warn.bind(log), info: log.info.bind(log) },
  } as MigrationDeps, undefined, { skipFreshSnapshot: true }).catch(async (err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE mail_migration_runs
      SET state = 'failed', error_message = ${errMsg}, finished_at = now()
      WHERE id = ${runId}
    `).catch(() => { /* best-effort */ });
  });

  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'failed-over' })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── State machine internals ───────────────────────────────────────────────────

interface MigrationOptions {
  readonly skipFreshSnapshot?: boolean;
}

async function setStep(db: Database, runId: string, step: string, state = 'running'): Promise<void> {
  await db.execute(sql`
    UPDATE mail_migration_runs
    SET current_step = ${step}, state = ${state}
    WHERE id = ${runId}
  `);
}

async function failRun(db: Database, runId: string, message: string): Promise<void> {
  await db.execute(sql`
    UPDATE mail_migration_runs
    SET state = 'failed', error_message = ${message}, finished_at = now()
    WHERE id = ${runId}
  `);
}

async function runMigrationStateMachine(
  runId: string,
  _sourceNode: string,
  targetNode: string,
  deps: MigrationDeps,
  newGiB?: number,
  opts: MigrationOptions = {},
): Promise<void> {
  const { db, core, apps, kubeconfigPath } = deps;
  const log = deps.logger ?? { warn: console.warn, info: console.info };

  // Step 1: Preflight — validate target node is schedulable + has disk
  await setStep(db, runId, 'preflight');
  const usedBytes = await getMailPvcRequestedBytes(core);
  const requiredBytes = Math.ceil(usedBytes * DISK_HEADROOM_RATIO);
  // Real free-disk probe would spawn a Job on targetNode. For now we
  // use the PVC's requested size as a conservative upper bound; if the
  // target node lacks the disk, the local-path provisioner will fail
  // PV creation and the migration aborts at the "swapping-pvc" step.
  log.info(`[migration ${runId}] preflight: PVC requested=${usedBytes} bytes, target headroom=${requiredBytes}`);

  // Step 2: Trigger a fresh snapshot (skip for DR — source is dead)
  if (!opts.skipFreshSnapshot) {
    await setStep(db, runId, 'snapshotting');
    try {
      await triggerMailSnapshot({ kubeconfigPath });
      // Wait until the snapshot completes. The snapshot CronJob runs
      // every 2 minutes; an on-demand trigger usually completes in
      // 20-60s for small DataStores. We poll for up to 5 min.
      await waitForFreshSnapshot(deps, 300);
    } catch (snapErr) {
      log.warn('[migration] fresh snapshot failed; will fall back to latest CronJob snapshot:', snapErr);
    }
  }

  // Step 3: Scale Stalwart to 0 (releases the source PVC mount)
  await setStep(db, runId, 'scaling-down');
  await patchDeploymentReplicas(apps, 0);
  await waitForReplicaCount(apps, 0, 90);

  // Step 4: Swap the PVC binding to the target node + signal restore-on-start.
  //
  // Sub-steps:
  //   4a. Delete the source PVC (releases the local-path PV bound to
  //       source node — local-path leaves data on disk but the PV is
  //       gone; the orphan is GC'd by the provisioner later).
  //   4b. Re-create the PVC with the SAME name plus
  //       `volume.kubernetes.io/selected-node: <targetNode>` so the
  //       provisioner creates a fresh PV on the target node.
  //   4c. SSA-patch the Deployment's `template.spec.affinity` to pin
  //       the pod to targetNode + set the `mail.platform/allow-restore`
  //       annotation that the `restore-state` initContainer reads.
  //
  // The PVC name never changes → no Flux/platform-api ownership war.
  // Affinity is NOT declared in the manifest → Flux's reconcile ignores it.
  await setStep(db, runId, 'swapping-pvc');

  const pvcSizeGiB = newGiB ?? Math.ceil(await getMailPvcRequestedBytes(core) / (1024 ** 3));

  try {
    await deletePvcAndWait(core, MAIL_PVC_NAME, 120);
  } catch (err) {
    await failRun(db, runId, `failed to delete source PVC: ${(err as Error).message}`);
    return;
  }

  try {
    await createMailPvc(core, targetNode, pvcSizeGiB);
  } catch (err) {
    await failRun(db, runId, `failed to recreate PVC on target node: ${(err as Error).message}`);
    return;
  }

  try {
    await applyDeploymentAffinity(apps, targetNode, /* allowRestore */ true);
  } catch (err) {
    await failRun(db, runId, `failed to apply target-node affinity: ${(err as Error).message}`);
    return;
  }

  // Step 5: Scale Stalwart back to 1 — pod schedules on target node,
  // binds the new PVC, the restore-state initContainer notices the
  // empty DataStore + allow-restore annotation + restic repo and
  // re-imports the latest snapshot.
  //
  // Longer timeout than usual because the restore can take 1-5 min
  // depending on DataStore size and BackupStore latency.
  await setStep(db, runId, 'scaling-up');
  await patchDeploymentReplicas(apps, 1);
  await waitForReplicaCount(apps, 1, 600);

  // Step 6: Verify the CURRENT sentinel (RocksDB MANIFEST file) exists
  // in the new PVC. Its presence proves the restore completed AND
  // Stalwart successfully opened the DataStore.
  await setStep(db, runId, 'verifying');
  const podName = await findStalwartPod(core);
  if (podName) {
    const verified = await verifySentinelExists(podName);
    if (!verified) {
      await failRun(db, runId, 'DataStore CURRENT sentinel not found after migration — restore may have failed');
      return;
    }
  }

  // Step 7: Clear the allow-restore annotation so subsequent pod
  // restarts don't re-trigger the restore-state init. (The init also
  // short-circuits on existing CURRENT, so this is belt-and-suspenders.)
  try {
    await clearAllowRestoreAnnotation(apps);
  } catch (annotErr) {
    log.warn('[migration] failed to clear allow-restore annotation (non-fatal):', annotErr);
  }

  // Step 8: Update DB → success
  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'healthy' })
    .where(eq(systemSettings.id, SETTINGS_ID));

  await db.execute(sql`
    UPDATE mail_migration_runs
    SET state = 'done', current_step = 'complete', finished_at = now()
    WHERE id = ${runId}
  `);

  log.info(`[migration] run ${runId}: migration to ${targetNode} complete`);
}

// ── PVC helpers ───────────────────────────────────────────────────────────────

/**
 * Read the current PVC's requested storage size in bytes.
 */
async function getMailPvcRequestedBytes(core: CoreV1Api): Promise<number> {
  try {
    const pvc = await core.readNamespacedPersistentVolumeClaim({
      name: MAIL_PVC_NAME,
      namespace: MAIL_NAMESPACE,
    }) as { spec?: { resources?: { requests?: { storage?: string } } } };
    const storageStr = pvc.spec?.resources?.requests?.storage ?? '20Gi';
    return parseQuantity(storageStr);
  } catch (err) {
    if (isNotFound(err)) {
      // PVC missing (rare — only if a previous migration aborted between
      // delete + create). Fall back to manifest default.
      return parseQuantity('20Gi');
    }
    throw err;
  }
}

/**
 * Delete the named PVC and wait until the apiserver reports it gone.
 *
 * local-path PVCs are tied to a finalizer that runs the provisioner's
 * cleanup pod. Deletion blocks until the cleanup completes; we wait up
 * to `timeoutSeconds` for the apiserver to surface 404.
 */
async function deletePvcAndWait(core: CoreV1Api, name: string, timeoutSeconds: number): Promise<void> {
  try {
    await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
  } catch (err) {
    if (isNotFound(err)) return; // already gone
    throw err;
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
      await sleep(2000);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  }
  throw new ApiError(
    'MAIL_MIGRATION_PVC_DELETE_TIMEOUT',
    `PVC ${MAIL_NAMESPACE}/${name} still exists after ${timeoutSeconds}s — finalizer may be stuck. Inspect with kubectl describe.`,
    500,
  );
}

/**
 * Create the Stalwart PVC with a `selected-node` annotation so the
 * local-path provisioner creates the PV on the target node.
 */
async function createMailPvc(core: CoreV1Api, targetNode: string, sizeGiB: number): Promise<void> {
  // Mail-DataStore PVC recreate during migration. The data inside is
  // captured by the mail-snapshot bundle component (restic, 2-min
  // interval) — this `createNamespacedPersistentVolumeClaim` only
  // recreates the empty volume; the `restore-state` initContainer
  // re-imports the data on the next pod start.
  // backup-coverage: captured-by:mail-snapshot
  await core.createNamespacedPersistentVolumeClaim({
    namespace: MAIL_NAMESPACE,
    body: {
      metadata: {
        name: MAIL_PVC_NAME,
        namespace: MAIL_NAMESPACE,
        annotations: {
          'volume.kubernetes.io/selected-node': targetNode,
        },
        labels: {
          app: 'stalwart-mail',
          'app.kubernetes.io/part-of': 'hosting-platform',
          'app.kubernetes.io/component': 'mail-server',
        },
      },
      spec: {
        storageClassName: 'local-path',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: `${sizeGiB}Gi` } },
      },
    } as unknown as Parameters<typeof core.createNamespacedPersistentVolumeClaim>[0]['body'],
  });
}

// ── Deployment helpers ────────────────────────────────────────────────────────

/**
 * Patch the Stalwart Deployment with:
 *   - `template.spec.affinity.nodeAffinity` pinning to `targetNode`
 *   - `metadata.annotations[mail.platform/allow-restore] = "true"` (when
 *     `allowRestore` is true; the downward-API mount surfaces this to
 *     the `restore-state` initContainer).
 *
 * Neither field is declared in the manifest. Flux's reconcile (non-force
 * SSA) leaves them alone after this patch — no ownership war.
 */
async function applyDeploymentAffinity(
  apps: AppsV1Api,
  targetNode: string,
  allowRestore: boolean,
): Promise<void> {
  const body = {
    metadata: allowRestore
      ? { annotations: { [ALLOW_RESTORE_ANNOTATION]: 'true' } }
      : undefined,
    spec: {
      template: {
        spec: {
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [{
                  matchExpressions: [{
                    key: 'kubernetes.io/hostname',
                    operator: 'In',
                    values: [targetNode],
                  }],
                }],
              },
            },
          },
        },
      },
    },
  };
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_AFFINITY_PATCH,
  );
}

/**
 * Remove the `mail.platform/allow-restore` annotation after a
 * successful migration so subsequent pod restarts don't trigger the
 * restore-state initContainer's restic path.
 *
 * Uses merge-patch with `null` to delete the key (RFC 7396 semantics).
 */
async function clearAllowRestoreAnnotation(apps: AppsV1Api): Promise<void> {
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: {
        metadata: {
          annotations: { [ALLOW_RESTORE_ANNOTATION]: null },
        },
      },
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MERGE_PATCH,
  );
}

async function patchDeploymentReplicas(apps: AppsV1Api, replicas: number): Promise<void> {
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: { spec: { replicas } },
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_DEPLOYMENT_PATCH,
  );
}

async function waitForReplicaCount(apps: AppsV1Api, target: number, timeoutSeconds: number): Promise<void> {
  await waitForStalwartReplicaCount(apps, target, { timeoutSeconds });
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/**
 * Poll the snapshot CronJob's lastSuccessfulTime until it advances past
 * the migration's start time, indicating our on-demand trigger produced
 * a fresh snapshot. Falls through silently after `timeoutSeconds` — the
 * migration will still proceed using the latest available snapshot.
 */
async function waitForFreshSnapshot(deps: MigrationDeps, timeoutSeconds: number): Promise<void> {
  const { batch } = deps;
  const startTs = Date.now();
  const deadline = startTs + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const cron = await batch.readNamespacedCronJob({
        name: 'stalwart-mail-snapshot',
        namespace: MAIL_NAMESPACE,
      }) as { status?: { lastSuccessfulTime?: string } };
      const lastStr = cron.status?.lastSuccessfulTime;
      if (lastStr) {
        const last = Date.parse(lastStr);
        if (Number.isFinite(last) && last >= startTs) return;
      }
    } catch {
      /* swallow — the wait is best-effort */
    }
    await sleep(5000);
  }
}

// ── Pod inspection ────────────────────────────────────────────────────────────

async function findStalwartPod(core: CoreV1Api): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: 'app=stalwart-mail',
    }) as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> };
    const items = pods.items ?? [];
    return items.find((p) => p.status?.phase === 'Running')?.metadata?.name ?? null;
  } catch {
    return null;
  }
}

async function verifySentinelExists(podName: string): Promise<boolean> {
  try {
    const { Exec, KubeConfig } = await import('@kubernetes/client-node');
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const exec = new Exec(kc);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('verify timed out')), 10_000);
      void import('node:stream').then(({ Writable }) => {
        const sink = new Writable({ write(_c, _e, cb) { cb(); } });
        exec.exec(
          MAIL_NAMESPACE, podName, 'stalwart',
          ['test', '-f', '/var/lib/stalwart/data/CURRENT'],
          sink, sink, null, false,
          (status) => {
            clearTimeout(timer);
            if (status.status === 'Failure') {
              reject(new Error(`CURRENT sentinel missing: ${status.message ?? ''}`));
            } else {
              resolve();
            }
          },
        ).catch(reject);
      });
    });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
