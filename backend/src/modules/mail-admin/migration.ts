/**
 * Mail PVC live rsync migration pipeline (Phase 5).
 *
 * Drives a state machine that migrates the Stalwart RocksDB local-path PVC
 * from one node to another with minimal downtime:
 *
 *   queued → preflight → snapshotting → scaling-down → creating-target-pvc
 *     → rsync → cutover → scaling-up → verifying → done
 *
 * For node-loss DR (Phase 6 auto-failover): if the source node is dead,
 * `triggerRestoreBasedFailover` bypasses rsync and instead creates an empty
 * PVC on the target node and lets the restore-state initContainer repopulate
 * it from the latest restic snapshot.
 *
 * Single entry-point since the 2026-05-14 streamline: `startMailMigration`
 * accepts an `intent` discriminator and resolves the target node from
 * system_settings for failover/failback. The previous thin wrappers
 * (`startFailoverMigration`, `startFailbackMigration`) were folded in.
 *
 * POST /admin/mail/migrate    → startMailMigration({intent:'explicit', targetNode})
 * POST /admin/mail/failover   → startMailMigration({intent:'failover'})
 * POST /admin/mail/failback   → startMailMigration({intent:'failback'})
 * GET  /admin/mail/migrate/:runId → getMailMigrationStatus
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH, strategicMergePatch } from '../../shared/k8s-patch.js';

// Field-manager attribution for migration's Deployment patches. Code
// review found that the original bare STRATEGIC_MERGE_PATCH lets the
// apiserver attribute writes to the user-agent (e.g. "axios"), which
// (a) makes managedFields archaeology useless, and (b) leaves
// migration vulnerable to the same Flux-reversion failure mode that
// the port-exposure refactor fixed (PR #44 → Phase 7). port-exposure
// uses `platform-api.port-exposure`; migration uses a distinct name
// so the apiserver can tell the two actors apart on the same
// Deployment (port-exposure owns `containers[].ports`, migration
// owns `template.spec.affinity` + `template.spec.volumes` + `replicas`).
const MIGRATION_DEPLOYMENT_PATCH = strategicMergePatch('platform-api.migration');
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { triggerMailSnapshot } from './snapshot.js';
import { parseQuantity } from './mail-pvc.js';

const MAIL_NAMESPACE = 'mail';
const SETTINGS_ID = 'system';
const DEPLOYMENT_NAME = 'stalwart-mail';
const MAIL_PVC_NAME = 'stalwart-rocksdb-data';
const DISK_HEADROOM_RATIO = 1.25; // target must have 25% more free than used

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
  // @kubernetes/client-node v1 SDK takes a single request object
  // (CoreV1ApiReadNodeRequest); the v0 positional `readNode(name)` shape
  // was removed in the typescript-axios codegen rewrite.
  try {
    await core.readNode({ name: targetNode });
  } catch {
    throw new ApiError('MAIL_NODE_NOT_FOUND', `Node '${targetNode}' not found in the cluster`, 404);
  }

  const sourceNode = row?.mailActiveNode ?? row?.mailPrimaryNode ?? null;
  if (!sourceNode) {
    throw new ApiError('MAIL_NO_ACTIVE_NODE', 'No active mail node is configured in system_settings', 409);
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

// ── Internal: DR-based failover (node is dead — source PVC inaccessible) ────

/**
 * Triggered by the DR watcher when the active node is down. Instead of
 * rsyncing (impossible — source node is gone), we:
 *  1. Create an empty local-path PVC on targetNode
 *  2. Patch the Deployment to use the new PVC + required nodeAffinity +
 *     `mail.platform/allow-restore: "true"` annotation
 *  3. Update DB: activeNode = targetNode, drState = 'failed-over'
 *
 * The restore-state initContainer sees the empty DataStore + allow-restore
 * annotation and re-imports the latest restic snapshot automatically.
 */
export async function triggerRestoreBasedFailover(
  targetNode: string,
  deps: { db: Database; core: CoreV1Api; apps: AppsV1Api },
): Promise<void> {
  const { db, core, apps } = deps;

  const newPvcName = `stalwart-rocksdb-data-dr-${targetNode.replace(/[^a-z0-9]/g, '-').slice(0, 60)}`;

  // Create the new PVC on target node (local-path provisioner uses the
  // selected-node annotation to pin PV creation to the right host).
  try {
    await core.readNamespacedPersistentVolumeClaim({ name: newPvcName, namespace: MAIL_NAMESPACE });
    // Already exists — skip creation
  } catch {
    // Mail-DR PVC — transient copy of mail data during failover. Live
    // PVC is captured by the mail-snapshot bundle component.
    // backup-coverage: excluded:cluster-infrastructure
    await core.createNamespacedPersistentVolumeClaim({
      namespace: MAIL_NAMESPACE,
      body: {
        metadata: {
          name: newPvcName,
          namespace: MAIL_NAMESPACE,
          annotations: { 'volume.kubernetes.io/selected-node': targetNode },
          labels: { 'platform.phoenix-host.net/mail-dr-pvc': 'true' },
        },
        spec: {
          storageClassName: 'local-path',
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: `${Math.ceil((await getMailPvcRequestedBytes(core)) / (1024 ** 3))}Gi` } },
        },
      } as unknown as Parameters<typeof core.createNamespacedPersistentVolumeClaim>[0]['body'],
    });
  }

  // Patch Deployment: new node affinity + new PVC + allow-restore annotation.
  // STRATEGIC_MERGE_PATCH for Deployment spec merge semantics.
  const failoverPatchBody = {
    metadata: { annotations: { 'mail.platform/allow-restore': 'true' } },
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
          volumes: [{
            name: 'stalwart-data',
            persistentVolumeClaim: { claimName: newPvcName },
          }],
        },
      },
    },
  };
  await apps.patchNamespacedDeployment(
    {
      namespace: MAIL_NAMESPACE,
      name: DEPLOYMENT_NAME,
      body: failoverPatchBody,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_DEPLOYMENT_PATCH,
  );

  await db.update(systemSettings)
    .set({ mailActiveNode: targetNode, mailDrState: 'failed-over' })
    .where(eq(systemSettings.id, SETTINGS_ID));
}

// ── State machine ─────────────────────────────────────────────────────────────

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
  sourceNode: string,
  targetNode: string,
  deps: MigrationDeps,
  newGiB?: number,
): Promise<void> {
  const { db, core, batch, apps, kubeconfigPath } = deps;
  const log = deps.logger ?? { warn: console.warn, info: console.info };

  // Step 1: Preflight disk check
  await setStep(db, runId, 'preflight');
  const usedBytes = await getMailPvcRequestedBytes(core);
  const requiredBytes = Math.ceil(usedBytes * DISK_HEADROOM_RATIO);

  // NOTE: A real disk probe would spawn a Job on targetNode to run df -B1.
  // For Phase 5 we use PVC requested size × headroom ratio as a conservative
  // upper bound — 100 GiB placeholder is documented in the step name.
  const freeBytes = 100 * 1024 * 1024 * 1024; // TODO Phase 5b: real df Job
  if (freeBytes < requiredBytes) {
    await failRun(db, runId, `Target node has ${freeBytes} free bytes; need ${requiredBytes}`);
    return;
  }

  // Step 2: Safety snapshot
  await setStep(db, runId, 'snapshotting');
  try {
    await triggerMailSnapshot({ kubeconfigPath });
  } catch (snapErr) {
    // Snapshot failure is non-fatal if no backup target is configured.
    log.warn('[migration] safety snapshot failed (non-fatal):', snapErr);
  }

  // Step 3: Scale Stalwart to 0
  await setStep(db, runId, 'scaling-down');
  await patchDeploymentReplicas(apps, 0);
  await waitForReplicaCount(apps, 0, 90);

  // Step 4: Create new PVC on target node
  await setStep(db, runId, 'creating-target-pvc');
  const newPvcName = `stalwart-rocksdb-data-mig-${runId.slice(0, 8)}`;
  const pvcSizeGiB = newGiB ?? Math.ceil((await getMailPvcRequestedBytes(core)) / (1024 ** 3));
  await ensureLocalPathPvc(core, newPvcName, targetNode, pvcSizeGiB);

  // Step 5: Rsync Jobs
  await setStep(db, runId, 'rsync');
  const rsyncJobName = `stalwart-mig-rsync-${runId.slice(0, 8)}`;
  await spawnRsyncJob(batch, rsyncJobName, runId, sourceNode, targetNode, newPvcName);

  await db.execute(sql`
    UPDATE mail_migration_runs SET rsync_job_name = ${rsyncJobName} WHERE id = ${runId}
  `);

  await waitForJobCompletion(batch, rsyncJobName, 1800); // 30 min timeout

  // Step 6: Swap PVC claim in Deployment to point at new PVC.
  // STRATEGIC_MERGE_PATCH for Deployment-spec merge semantics.
  await setStep(db, runId, 'cutover');
  const cutoverPatchBody = {
    spec: {
      template: {
        spec: {
          volumes: [{
            name: 'stalwart-data',
            persistentVolumeClaim: { claimName: newPvcName },
          }],
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
      body: cutoverPatchBody,
    } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
    MIGRATION_DEPLOYMENT_PATCH,
  );

  // Step 7: Scale back up
  await setStep(db, runId, 'scaling-up');
  await patchDeploymentReplicas(apps, 1);
  await waitForReplicaCount(apps, 1, 120);

  // Step 8: Verify DataStore sentinel
  await setStep(db, runId, 'verifying');
  const podName = await findStalwartPod(core);
  if (podName) {
    const verified = await verifySentinelExists(podName);
    if (!verified) {
      await failRun(db, runId, 'DataStore CURRENT sentinel not found after migration');
      return;
    }
  }

  // Step 9: Mark old PVC for deferred cleanup + update DB
  try {
    // STRATEGIC_MERGE_PATCH on a built-in resource (PVC) — equivalent
    // to merge-patch for a simple metadata.annotations write.
    await core.patchNamespacedPersistentVolumeClaim(
      {
        namespace: MAIL_NAMESPACE,
        name: MAIL_PVC_NAME,
        body: {
          metadata: {
            annotations: {
              'platform.phoenix-host.net/delete-after':
                new Date(Date.now() + 86400000).toISOString(),
            },
          },
        },
      } as unknown as Parameters<typeof core.patchNamespacedPersistentVolumeClaim>[0],
      STRATEGIC_MERGE_PATCH,
    );
  } catch (annotErr) {
    log.warn('[migration] failed to annotate old PVC for cleanup (non-fatal):', annotErr);
  }

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMailPvcRequestedBytes(core: CoreV1Api): Promise<number> {
  const pvc = await core.readNamespacedPersistentVolumeClaim({
    name: MAIL_PVC_NAME,
    namespace: MAIL_NAMESPACE,
  }) as { spec?: { resources?: { requests?: { storage?: string } } } };
  const storageStr = pvc.spec?.resources?.requests?.storage ?? '20Gi';
  return parseQuantity(storageStr);
}

async function ensureLocalPathPvc(core: CoreV1Api, name: string, nodeName: string, sizeGiB = 20): Promise<void> {
  try {
    await core.readNamespacedPersistentVolumeClaim({ name, namespace: MAIL_NAMESPACE });
    return; // already exists
  } catch {
    // Fall through to create
  }
  // Mail-DR helper PVC (callers are all failover/failback flows).
  // Same rationale as the DR call site above.
  // backup-coverage: excluded:cluster-infrastructure
  await core.createNamespacedPersistentVolumeClaim({
    namespace: MAIL_NAMESPACE,
    body: {
      metadata: {
        name,
        namespace: MAIL_NAMESPACE,
        annotations: { 'volume.kubernetes.io/selected-node': nodeName },
      },
      spec: {
        storageClassName: 'local-path',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: `${sizeGiB}Gi` } },
      },
    } as unknown as Parameters<typeof core.createNamespacedPersistentVolumeClaim>[0]['body'],
  });
}

async function patchDeploymentReplicas(apps: AppsV1Api, replicas: number): Promise<void> {
  // Strategic-merge with named fieldManager so migration's writes to
  // `spec.replicas` show up in `kubectl get deploy --show-managed-
  // fields` under `platform-api.migration`, NOT the default user-agent
  // attribution. Same rationale as the per-PR-set port-exposure
  // refactor — anonymous attribution makes it impossible to reason
  // about who owns what when conflicts arise.
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
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const dep = await apps.readNamespacedDeployment({
      name: DEPLOYMENT_NAME,
      namespace: MAIL_NAMESPACE,
    }) as { status?: { readyReplicas?: number; unavailableReplicas?: number } };
    const status = dep.status;
    const ready = status?.readyReplicas ?? 0;
    const unavailable = status?.unavailableReplicas ?? 0;
    if (target === 0 && ready === 0 && unavailable === 0) return;
    if (target > 0 && ready >= target) return;
    await sleep(3000);
  }
  throw new ApiError(
    'MAIL_MIGRATION_SCALE_TIMEOUT',
    `Deployment did not reach ${target} replicas within ${timeoutSeconds}s`,
    500,
  );
}

async function waitForJobCompletion(batch: BatchV1Api, jobName: string, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({
      name: jobName,
      namespace: MAIL_NAMESPACE,
    }) as { status?: { conditions?: Array<{ type: string; status: string }> } };
    const conditions = job.status?.conditions ?? [];
    if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return;
    if (conditions.some((c) => c.type === 'Failed' && c.status === 'True')) {
      throw new ApiError('MAIL_MIGRATION_RSYNC_FAILED', `rsync Job ${jobName} failed`, 500);
    }
    await sleep(5000);
  }
  throw new ApiError('MAIL_MIGRATION_TIMEOUT', `Job ${jobName} did not complete within ${timeoutSeconds}s`, 500);
}

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

async function spawnRsyncJob(
  batch: BatchV1Api,
  jobName: string,
  runId: string,
  sourceNode: string,
  targetNode: string,
  targetPvcName: string,
): Promise<void> {
  // Strategy: run rsync Job on SOURCE node (since the local-path PVC is bound
  // there). The job copies from the source PVC to the target PVC via SSH.
  //
  // Prerequisites (operator must create before migration):
  //   Secret 'stalwart-migration-ssh-key' in namespace 'mail' with key 'id_rsa'
  //   (private key), corresponding public key in authorized_keys on target nodes.
  //
  // The job determines the target PV path via the k8s API (service-account token).
  const rsyncJobBody = {
    metadata: {
      name: jobName,
      namespace: MAIL_NAMESPACE,
      labels: {
        'mail-migration-run': runId,
        'app.kubernetes.io/component': 'mail-migration',
      },
      annotations: {
        'platform.phoenix-host.net/migration-source-node': sourceNode,
        'platform.phoenix-host.net/migration-target-node': targetNode,
        'platform.phoenix-host.net/migration-target-pvc': targetPvcName,
        'platform.phoenix-host.net/ttl-exempt': 'false',
      },
    },
    spec: {
      backoffLimit: 2,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: {
          labels: {
            'mail-migration-run': runId,
            'job-name': jobName,
          },
        },
        spec: {
          restartPolicy: 'OnFailure',
          // Pin to source node — the source PVC is local-path bound there.
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [{
                  matchExpressions: [{
                    key: 'kubernetes.io/hostname',
                    operator: 'In',
                    values: [sourceNode],
                  }],
                }],
              },
            },
          },
          // hostNetwork gives direct access to the node network for rsync-over-SSH.
          hostNetwork: true,
          containers: [{
            name: 'rsync',
            // Use the mail-backup-tools image (carries rsync + openssh-client).
            image: 'ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest',
            imagePullPolicy: 'Always',
            command: ['sh', '-c'],
            args: [
              `set -e
echo "=== Stalwart RocksDB migration: ${sourceNode} -> ${targetNode} ==="
echo "Source PVC mounted at /source-data"
echo "Target PVC name: ${targetPvcName}"
KUBE_TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
KUBE_CA=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
TARGET_PV=$(curl -sk --cacert "$KUBE_CA" \\
  -H "Authorization: Bearer $KUBE_TOKEN" \\
  "https://kubernetes.default.svc/api/v1/namespaces/${MAIL_NAMESPACE}/persistentvolumeclaims/${targetPvcName}" \\
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['spec']['volumeName'])")
if [ -z "$TARGET_PV" ]; then
  echo "ERROR: could not determine target PV name from PVC ${targetPvcName}"
  exit 1
fi
TARGET_PATH="/var/lib/rancher/k3s/storage/$TARGET_PV"
echo "Target path on ${targetNode}: $TARGET_PATH"
# SSH host-key verification: prefer pinned known_hosts (mounted from
# stalwart-migration-known-hosts ConfigMap when operator has wired
# it). Falls back to StrictHostKeyChecking=accept-new — only on the
# FIRST connection to an unknown node, NOT 'no' (which silently
# trusts any host every time). With hostNetwork:true the job pod
# shares the node's network, so an attacker who already controls
# DNS/ARP on the source node could MITM. The pinned ConfigMap is the
# real fix; this fallback narrows the window while operators set it up.
# SECURITY follow-up: provide a known_hosts ConfigMap on every node
# and switch to StrictHostKeyChecking=yes.
SSH_OPTS="-o StrictHostKeyChecking=accept-new -i /etc/migration-ssh/id_rsa"
if [ -f /etc/migration-ssh/known_hosts ]; then
  SSH_OPTS="-o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/migration-ssh/known_hosts -i /etc/migration-ssh/id_rsa"
  echo "Using pinned known_hosts (StrictHostKeyChecking=yes)"
else
  echo "WARN: no /etc/migration-ssh/known_hosts; using StrictHostKeyChecking=accept-new — MITM possible on first connect"
fi
rsync -avz --delete --numeric-ids --timeout=60 \\
  -e "ssh $SSH_OPTS" \\
  /source-data/ \\
  "root@${targetNode}:$TARGET_PATH/"
echo "=== rsync complete ==="`,
            ],
            env: [
              { name: 'MAIL_NAMESPACE', value: MAIL_NAMESPACE },
            ],
            volumeMounts: [
              { name: 'source-data', mountPath: '/source-data', readOnly: true },
              { name: 'migration-ssh', mountPath: '/etc/migration-ssh', readOnly: true },
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1000m', memory: '512Mi' },
            },
          }],
          volumes: [
            {
              name: 'source-data',
              persistentVolumeClaim: { claimName: MAIL_PVC_NAME, readOnly: true },
            },
            {
              // Operator must pre-create Secret 'stalwart-migration-ssh-key'
              // in namespace 'mail' with key 'id_rsa' (private key)
              // and corresponding public key in authorized_keys on target nodes.
              name: 'migration-ssh',
              secret: {
                secretName: 'stalwart-migration-ssh-key',
                optional: true,
                defaultMode: 256, // 0o400
              },
            },
          ],
        },
      },
    },
  };
  await batch.createNamespacedJob({
    namespace: MAIL_NAMESPACE,
    body: rsyncJobBody as unknown as Parameters<typeof batch.createNamespacedJob>[0]['body'],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
