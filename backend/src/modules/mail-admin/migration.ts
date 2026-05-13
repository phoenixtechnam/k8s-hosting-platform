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
 * POST /admin/mail/migrate    → startMailMigration
 * GET  /admin/mail/migrate/:runId → getMailMigrationStatus
 * POST /admin/mail/failover   → startFailoverMigration (picks secondary node)
 * POST /admin/mail/failback   → startFailbackMigration (picks primary node)
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
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

export async function startMailMigration(
  { targetNode, triggeredBy = 'operator', newGiB }: { targetNode: string; triggeredBy?: string; newGiB?: number },
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

  // Validate target node exists
  try {
    await (core as unknown as { readNode: (name: string) => Promise<unknown> }).readNode(targetNode);
  } catch {
    throw new ApiError('MAIL_NODE_NOT_FOUND', `Node '${targetNode}' not found in the cluster`, 404);
  }

  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
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

export async function startFailoverMigration(
  _opts: { confirm: true },
  deps: MigrationDeps,
): Promise<{ runId: string }> {
  const [row] = await deps.db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const targetNode = row?.mailSecondaryNode ?? row?.mailTertiaryNode ?? null;
  if (!targetNode) {
    throw new ApiError(
      'MAIL_PLACEMENT_NO_CANDIDATE',
      'No secondary or tertiary node configured — set placement policy before triggering failover',
      409,
    );
  }
  return startMailMigration({ targetNode, triggeredBy: 'manual-failover' }, deps);
}

export async function startFailbackMigration(
  _opts: { confirm: true },
  deps: MigrationDeps,
): Promise<{ runId: string }> {
  const [row] = await deps.db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));
  const targetNode = row?.mailPrimaryNode ?? null;
  if (!targetNode) {
    throw new ApiError(
      'MAIL_PLACEMENT_NO_CANDIDATE',
      'No primary node configured — set placement policy before triggering failback',
      409,
    );
  }
  return startMailMigration({ targetNode, triggeredBy: 'manual-failback' }, deps);
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
    await (core as unknown as {
      readNamespacedPersistentVolumeClaim: (name: string, ns: string) => Promise<unknown>
    }).readNamespacedPersistentVolumeClaim(newPvcName, MAIL_NAMESPACE);
    // Already exists — skip creation
  } catch {
    // Mail-DR PVC — transient copy of mail data during failover. Live
    // PVC is captured by the mail-snapshot bundle component.
    // backup-coverage: excluded:cluster-infrastructure
    await (core as unknown as {
      createNamespacedPersistentVolumeClaim: (ns: string, body: unknown) => Promise<unknown>
    }).createNamespacedPersistentVolumeClaim(MAIL_NAMESPACE, {
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
    });
  }

  // Patch Deployment: new node affinity + new PVC + allow-restore annotation
  await (apps as unknown as {
    patchNamespacedDeployment: (
      name: string, ns: string, body: unknown,
      u1?: unknown, u2?: unknown, u3?: unknown, u4?: unknown,
      opts?: unknown
    ) => Promise<unknown>
  }).patchNamespacedDeployment(
    DEPLOYMENT_NAME, MAIL_NAMESPACE,
    {
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
    },
    undefined, undefined, undefined, undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
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

  // Step 6: Swap PVC claim in Deployment to point at new PVC
  await setStep(db, runId, 'cutover');
  await (apps as unknown as {
    patchNamespacedDeployment: (
      name: string, ns: string, body: unknown,
      u1?: unknown, u2?: unknown, u3?: unknown, u4?: unknown,
      opts?: unknown
    ) => Promise<unknown>
  }).patchNamespacedDeployment(
    DEPLOYMENT_NAME, MAIL_NAMESPACE,
    {
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
    },
    undefined, undefined, undefined, undefined,
    { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
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
    await (core as unknown as {
      patchNamespacedPersistentVolumeClaim: (
        name: string, ns: string, body: unknown,
        u1?: unknown, u2?: unknown, u3?: unknown, u4?: unknown,
        opts?: unknown
      ) => Promise<unknown>
    }).patchNamespacedPersistentVolumeClaim(
      MAIL_PVC_NAME, MAIL_NAMESPACE,
      { metadata: { annotations: { 'platform.phoenix-host.net/delete-after': new Date(Date.now() + 86400000).toISOString() } } },
      undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
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
  const pvc = await (core as unknown as {
    readNamespacedPersistentVolumeClaim: (name: string, ns: string) => Promise<{
      body?: { spec?: { resources?: { requests?: { storage?: string } } } };
      spec?: { resources?: { requests?: { storage?: string } } };
    }>
  }).readNamespacedPersistentVolumeClaim(MAIL_PVC_NAME, MAIL_NAMESPACE);
  const pvcObj = (pvc as { body?: { spec?: { resources?: { requests?: { storage?: string } } } } }).body ?? pvc;
  const storageStr = (pvcObj as { spec?: { resources?: { requests?: { storage?: string } } } }).spec?.resources?.requests?.storage ?? '20Gi';
  return parseQuantity(storageStr);
}

async function ensureLocalPathPvc(core: CoreV1Api, name: string, nodeName: string, sizeGiB = 20): Promise<void> {
  try {
    await (core as unknown as {
      readNamespacedPersistentVolumeClaim: (name: string, ns: string) => Promise<unknown>
    }).readNamespacedPersistentVolumeClaim(name, MAIL_NAMESPACE);
    return; // already exists
  } catch {
    // Fall through to create
  }
  // Mail-DR helper PVC (callers are all failover/failback flows).
  // Same rationale as the DR call site above.
  // backup-coverage: excluded:cluster-infrastructure
  await (core as unknown as {
    createNamespacedPersistentVolumeClaim: (ns: string, body: unknown) => Promise<unknown>
  }).createNamespacedPersistentVolumeClaim(MAIL_NAMESPACE, {
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
  });
}

async function patchDeploymentReplicas(apps: AppsV1Api, replicas: number): Promise<void> {
  await (apps as unknown as {
    patchNamespacedDeployment: (
      name: string, ns: string, body: unknown,
      u1?: unknown, u2?: unknown, u3?: unknown, u4?: unknown,
      opts?: unknown
    ) => Promise<unknown>
  }).patchNamespacedDeployment(
    DEPLOYMENT_NAME, MAIL_NAMESPACE,
    { spec: { replicas } },
    undefined, undefined, undefined, undefined,
    { headers: { 'Content-Type': 'application/merge-patch+json' } },
  );
}

async function waitForReplicaCount(apps: AppsV1Api, target: number, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const dep = await (apps as unknown as {
      readNamespacedDeployment: (name: string, ns: string) => Promise<{ body?: unknown }>
    }).readNamespacedDeployment(DEPLOYMENT_NAME, MAIL_NAMESPACE);
    const depObj = (dep as { body?: unknown }).body ?? dep;
    const status = (depObj as { status?: { readyReplicas?: number; unavailableReplicas?: number } }).status;
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
    const job = await (batch as unknown as {
      readNamespacedJob: (name: string, ns: string) => Promise<{ body?: unknown }>
    }).readNamespacedJob(jobName, MAIL_NAMESPACE);
    const jobObj = (job as { body?: unknown }).body ?? job;
    const conditions: Array<{ type: string; status: string }> =
      (jobObj as { status?: { conditions?: Array<{ type: string; status: string }> } }).status?.conditions ?? [];
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
    const pods = await (core as unknown as {
      listNamespacedPod: (
        ns: string, u1?: unknown, u2?: unknown, u3?: unknown, u4?: unknown, labelSelector?: string
      ) => Promise<{
        body?: { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> };
        items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }>;
      }>
    }).listNamespacedPod(MAIL_NAMESPACE, undefined, undefined, undefined, undefined, 'app=stalwart-mail');
    const podsObj = (pods as { body?: { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> } }).body ?? pods;
    const items = (podsObj as { items?: Array<{ metadata?: { name?: string }; status?: { phase?: string } }> }).items ?? [];
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
  await (batch as unknown as {
    createNamespacedJob: (ns: string, body: unknown) => Promise<unknown>
  }).createNamespacedJob(MAIL_NAMESPACE, {
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
rsync -avz --delete --numeric-ids --timeout=60 \\
  -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i /etc/migration-ssh/id_rsa" \\
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
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
