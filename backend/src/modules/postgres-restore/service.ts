import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { execInPod, type ExecResult } from '../../shared/k8s-exec.js';
import { notifications, users, platformSettings } from '../../db/schema.js';
import { inArray, eq } from 'drizzle-orm';

/**
 * Snapshot-only Postgres PITR — restore a CNPG cluster from a Longhorn
 * snapshot, optionally with WAL replay forward to a sub-hour target,
 * then auto-promote (replace the source cluster).
 *
 * Flow (sync HTTP, ~5–10 min wall-clock):
 *
 *   1. Pre-flight: membership, snapshot freshness, WAL coverage, lock
 *   2. Wrap the Longhorn snapshot as a Pre-provisioned VolumeSnapshot
 *   3. Bootstrap a TEMP CNPG Cluster from the VolumeSnapshot
 *   4. Wait for temp cluster healthy + run psql sanity probes
 *   5. Quiesce platform-api (scale to 0) and Stalwart consumers
 *   6. Snapshot the temp cluster's primary PVC
 *   7. Delete source Cluster (PVCs survive: reclaimPolicy=Retain)
 *   8. Re-create source Cluster CR with the same name, bootstrap from
 *      the temp's snapshot (so all downstream connection strings keep
 *      working). Original source PVCs stay around as fallback.
 *   9. Wait healthy; restore consumer scale
 *  10. Cleanup: delete temp cluster, VolumeSnapshot, wrapper content
 *  11. Audit log + admin notification
 *
 * If step 8 fails after step 7 deleted the source, automatic recovery
 * re-creates the original Cluster CR pointing at the source PVCs that
 * Retain kept around — net effect: no data loss, just downtime.
 *
 * The whole flow holds an in-process lock so concurrent PITR operations
 * AND general writes touching postgres are blocked. Released via
 * onFinally.
 */

export const PG_RESTORE_LOCK = Symbol('postgres-restore-lock');

// Two-tier lock:
//   - In-memory `activeRestore` is the fast-path checked by the write-lock
//     middleware (zero DB round-trip on every request).
//   - DB-backed `pg_pitr_in_progress` row is the crash-safe marker. Set
//     just before the destructive cutover (delete-source) and cleared on
//     successful unwind. On platform-api startup, recoverInterruptedRestore
//     reads it and emits a high-severity admin notification — the cluster
//     is in an indeterminate state and needs human inspection.
let activeRestore: { readonly startedAt: Date; readonly snapshot: string } | null = null;

const PITR_LOCK_KEY = 'pg_pitr_in_progress';

interface PersistedLock {
  readonly startedAt: string;
  readonly snapshot: string;
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly tempClusterName: string;
  // 'preflight' = orchestration started but source not yet deleted.
  //   Crash here is benign — recoverInterruptedRestore just clears
  //   the lock; no source data was touched.
  // 'cutover'   = source has been deleted (PVCs are reclaimPolicy=
  //   Retain so data survives) but recreate is in flight. Crash here
  //   needs operator attention.
  // 'cleanup'   = recreate succeeded, only temp resources remain.
  readonly phase: 'preflight' | 'cutover' | 'rebuilding' | 'cleanup';
}

async function writePersistedLock(db: Database, payload: PersistedLock): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key: PITR_LOCK_KEY, value: JSON.stringify(payload) })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: JSON.stringify(payload) } });
}

async function clearPersistedLock(db: Database): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, PITR_LOCK_KEY)).catch(() => undefined);
}

async function readPersistedLock(db: Database): Promise<PersistedLock | null> {
  const rows = await db.select().from(platformSettings).where(eq(platformSettings.key, PITR_LOCK_KEY)).limit(1);
  if (rows.length === 0) return null;
  try { return JSON.parse(rows[0].value) as PersistedLock; } catch { return null; }
}

export function isPostgresRestoreInProgress(): { readonly inProgress: boolean; readonly startedAt?: Date; readonly snapshot?: string } {
  if (!activeRestore) return { inProgress: false };
  return { inProgress: true, startedAt: activeRestore.startedAt, snapshot: activeRestore.snapshot };
}

/**
 * Cluster-wide lock check used by the write-lock middleware. Combines
 * the in-memory lock (this replica's) AND the DB-backed lock (any
 * replica's, set during the destructive cutover). With multiple
 * platform-api replicas, only the replica running the orchestration
 * has the in-memory lock — but every replica must reject writes once
 * any replica has reached the cutover. The DB lock is the single
 * source of truth across replicas during the dangerous phase.
 */
export async function isPostgresRestoreInProgressClusterWide(
  db: Database,
): Promise<{ readonly inProgress: boolean; readonly startedAt?: Date; readonly snapshot?: string; readonly source: 'in-memory' | 'db' | 'none' }> {
  if (activeRestore) {
    return { inProgress: true, startedAt: activeRestore.startedAt, snapshot: activeRestore.snapshot, source: 'in-memory' };
  }
  const persisted = await readPersistedLock(db).catch(() => null);
  if (persisted) {
    return { inProgress: true, startedAt: new Date(persisted.startedAt), snapshot: persisted.snapshot, source: 'db' };
  }
  return { inProgress: false, source: 'none' };
}

/**
 * Called once at platform-api startup. If we find a persisted lock from
 * a previous process that crashed mid-PITR, surface it loudly: the
 * source cluster may be in an indeterminate state.
 *
 * We do NOT auto-resume the orchestration — recovery requires human
 * judgement (the source cluster CR may already be re-created by CNPG
 * from the snapshot, the temp cluster may need cleanup, etc.). We DO:
 *   - Emit a sticky admin notification with full lock context
 *   - Clear the persisted lock so writes are not blocked forever
 *   - Best-effort delete any leftover temp PITR cluster (identified by
 *     the platform.phoenix-host.net/pitr-restore=true label) so they
 *     don't pin Longhorn volumes indefinitely. Requires a K8sClients
 *     argument; called with null at startup, the cleanup is skipped.
 */
export async function recoverInterruptedRestore(
  db: Database,
  k8s?: K8sClients,
): Promise<{ readonly recovered: boolean; readonly lock?: PersistedLock; readonly cleanedTempClusters?: number }> {
  const lock = await readPersistedLock(db);
  if (!lock) return { recovered: false };

  let cleanedTempClusters = 0;
  if (k8s) {
    try {
      // List all CNPG clusters in the source namespace and delete any
      // carrying the pitr-restore label. Safe even across multiple
      // failed runs — each leftover gets cleaned.
      const list = await (k8s.custom as unknown as {
        listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listNamespacedCustomObject({
        group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters',
        labelSelector: 'platform.phoenix-host.net/pitr-restore=true',
      });
      for (const c of list.items ?? []) {
        const name = c.metadata?.name;
        if (name) {
          await deleteCustom(k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters', name }).catch(() => undefined);
          cleanedTempClusters++;
        }
      }
    } catch {
      // best-effort; the admin notification still goes out
    }
  }

  await emitAdminNotification(
    db,
    `Platform-api restarted while a Postgres PITR was in progress (started ${lock.startedAt}, snapshot ${lock.snapshot}, phase=${lock.phase}). ` +
    `The cluster ${lock.clusterNamespace}/${lock.clusterName} may be in an indeterminate state. ` +
    `Inspect: kubectl -n ${lock.clusterNamespace} get cluster ${lock.clusterName} ${lock.tempClusterName}. ` +
    `If the source cluster is missing, the original PVCs are reclaimPolicy=Retain — manually re-create the Cluster CR pointing at them.` +
    (cleanedTempClusters > 0 ? ` Auto-cleaned ${cleanedTempClusters} leftover temp PITR cluster(s).` : ''),
    'Postgres PITR INTERRUPTED — manual recovery required',
  );
  await clearPersistedLock(db);
  return { recovered: true, lock, cleanedTempClusters };
}

const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';
const SNAPSHOT_API = 'snapshot.storage.k8s.io';
const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';

interface CnpgCluster {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: {
    readonly instances?: number;
    readonly imageName?: string;
    readonly storage?: { readonly size?: string; readonly storageClass?: string };
    readonly bootstrap?: {
      readonly initdb?: {
        readonly database?: string;
        readonly owner?: string;
        readonly secret?: { readonly name?: string };
        readonly postInitApplicationSQL?: readonly string[];
      };
    };
    readonly affinity?: unknown;
    readonly inheritedMetadata?: unknown;
    readonly resources?: unknown;
    readonly postgresql?: unknown;
    readonly enableSuperuserAccess?: boolean;
    readonly monitoring?: unknown;
  };
  readonly status?: { readonly currentPrimary?: string; readonly phase?: string };
}

interface RawSnap {
  readonly metadata?: { readonly creationTimestamp?: string };
  readonly status?: { readonly creationTime?: string; readonly readyToUse?: boolean };
  readonly spec?: { readonly volume?: string };
}

export interface PitrStep {
  readonly step: string;
  readonly ok: boolean;
  readonly elapsedMs?: number;
  readonly detail?: string;
}

export interface PitrResult {
  readonly clusterName: string;
  readonly snapshotName: string;
  readonly recoveryTargetTime: string | null;
  readonly steps: readonly PitrStep[];
  readonly downtimeMs: number;
  readonly tempClusterName: string;
}

interface PitrInputs {
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly snapshotName: string;
  readonly recoveryTargetTime: string | null;
  readonly actorUserId: string | null;
}

interface PitrDeps {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly kubeconfigPath?: string;
}

function nowMs(): number { return Date.now(); }

async function getCustom<T>(
  k8s: K8sClients,
  args: { group: string; version: string; namespace?: string; plural: string; name: string },
): Promise<T> {
  const r = args.namespace
    ? await k8s.custom.getNamespacedCustomObject({
        group: args.group, version: args.version, namespace: args.namespace, plural: args.plural, name: args.name,
      } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0])
    : await k8s.custom.getClusterCustomObject({
        group: args.group, version: args.version, plural: args.plural, name: args.name,
      } as unknown as Parameters<typeof k8s.custom.getClusterCustomObject>[0]);
  return r as T;
}

async function createCustom(
  k8s: K8sClients,
  args: { group: string; version: string; namespace?: string; plural: string; body: unknown },
): Promise<void> {
  if (args.namespace) {
    await k8s.custom.createNamespacedCustomObject({
      group: args.group, version: args.version, namespace: args.namespace, plural: args.plural, body: args.body,
    } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
  } else {
    await k8s.custom.createClusterCustomObject({
      group: args.group, version: args.version, plural: args.plural, body: args.body,
    } as unknown as Parameters<typeof k8s.custom.createClusterCustomObject>[0]);
  }
}

async function deleteCustom(
  k8s: K8sClients,
  args: { group: string; version: string; namespace?: string; plural: string; name: string },
): Promise<void> {
  try {
    if (args.namespace) {
      await k8s.custom.deleteNamespacedCustomObject({
        group: args.group, version: args.version, namespace: args.namespace, plural: args.plural, name: args.name,
      } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
    } else {
      await k8s.custom.deleteClusterCustomObject({
        group: args.group, version: args.version, plural: args.plural, name: args.name,
      } as unknown as Parameters<typeof k8s.custom.deleteClusterCustomObject>[0]);
    }
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
  }
}

async function patchCustomMerge(
  k8s: K8sClients,
  args: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
): Promise<void> {
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(args, MERGE_PATCH);
}

async function inspectWalCoverage(
  kubeconfigPath: string | undefined,
  clusterNamespace: string,
  primaryPodName: string,
  targetTime: Date,
): Promise<{ readonly ok: boolean; readonly oldestWalAt: Date | null; readonly walCount: number; readonly reason?: string }> {
  // Exec into the live primary's pg_wal/ to enumerate WAL segments and
  // their mtimes. Postgres rotates WAL on checkpoint; the oldest mtime
  // is the lower bound of replayable history INSIDE this volume.
  // Snapshot-frozen WAL has the same physical layout as live WAL, so
  // listing the live primary's pg_wal gives us the same coverage the
  // snapshot will have once we restore.
  try {
    const exec = await execPodCommand(kubeconfigPath, clusterNamespace, primaryPodName, 'postgres', [
      '/bin/sh', '-c',
      "ls -la --time-style=+%s /var/lib/postgresql/data/pgdata/pg_wal/ 2>/dev/null | awk '{print $6, $7}' | grep -E '^[0-9]+ [0-9A-F]{24}$'",
    ]);
    const lines = exec.stdout.trim().split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { ok: false, oldestWalAt: null, walCount: 0, reason: 'no WAL files visible in pg_wal' };
    }
    const epochs = lines.map((l) => parseInt(l.split(' ')[0], 10)).filter((n) => Number.isFinite(n));
    const oldestEpoch = Math.min(...epochs);
    const oldest = new Date(oldestEpoch * 1000);
    const ok = targetTime.getTime() >= oldest.getTime();
    return {
      ok,
      oldestWalAt: oldest,
      walCount: lines.length,
      reason: ok ? undefined : `requested target ${targetTime.toISOString()} is older than the oldest WAL ${oldest.toISOString()}`,
    };
  } catch (err) {
    return { ok: false, oldestWalAt: null, walCount: 0, reason: `pg_wal probe failed: ${(err as Error).message}` };
  }
}

async function execPodCommand(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  containerName: string,
  command: readonly string[],
): Promise<ExecResult> {
  return execInPod(kubeconfigPath, namespace, podName, containerName, command);
}

async function probePsql(
  kubeconfigPath: string | undefined,
  namespace: string,
  podName: string,
  database: string,
  query: string,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  // Pass database + query directly as argv to psql (no shell), so
  // metacharacters in either value are inert. CNPG's bootstrap.initdb
  // accepts arbitrary identifiers and the same psql -tAc form is used
  // by other shared helpers — argv quoting is the authoritative
  // injection-safe pattern.
  const cmd = ['psql', '-tA', '-d', database, '-c', query];
  try {
    const r = await execPodCommand(kubeconfigPath, namespace, podName, 'postgres', cmd);
    return { ok: r.exitCode === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  } catch (err) {
    return { ok: false, stdout: '', stderr: (err as Error).message };
  }
}

async function waitClusterHealthy(
  k8s: K8sClients,
  namespace: string,
  clusterName: string,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly phase?: string; readonly primary?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastPhase: string | undefined;
  let lastPrimary: string | undefined;
  while (Date.now() < deadline) {
    try {
      const c = await getCustom<CnpgCluster>(k8s, {
        group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'clusters', name: clusterName,
      });
      lastPhase = c.status?.phase; lastPrimary = c.status?.currentPrimary;
      if (lastPhase === 'Cluster in healthy state' && lastPrimary) {
        return { ok: true, phase: lastPhase, primary: lastPrimary };
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return { ok: false, phase: lastPhase, primary: lastPrimary };
}

async function emitAdminNotification(
  db: Database,
  message: string,
  title: string,
): Promise<void> {
  const adminRows = await db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
  for (const a of adminRows) {
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: a.id,
      type: 'info',
      title,
      message,
      resourceType: 'postgres_pitr',
      resourceId: 'singleton',
    }).catch(() => undefined);
  }
}

/**
 * Validate that a Longhorn snapshot belongs to a CNPG cluster's PVC,
 * the snapshot is ready, and (if recoveryTargetTime is set) the WAL
 * inside the live primary covers the target time. Returns the
 * resolved primary PVC name + cluster snapshot for the caller.
 */
async function preflight(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  inputs: PitrInputs,
  steps: PitrStep[],
): Promise<{
  readonly snap: RawSnap;
  readonly cluster: CnpgCluster;
  readonly primaryPvc: string;
}> {
  const t0 = nowMs();
  const cluster = await getCustom<CnpgCluster>(k8s, {
    group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: inputs.clusterName,
  });
  if (!cluster.spec?.bootstrap?.initdb?.database || !cluster.spec.bootstrap.initdb.owner) {
    const e = new Error(`Cluster ${inputs.clusterNamespace}/${inputs.clusterName} missing bootstrap.initdb.database/owner — cannot reproduce`);
    (e as Error & { code?: number }).code = 422; throw e;
  }
  const primaryPvc = cluster.status?.currentPrimary;
  if (!primaryPvc) {
    const e = new Error(`Cluster ${inputs.clusterNamespace}/${inputs.clusterName} has no currentPrimary`);
    (e as Error & { code?: number }).code = 409; throw e;
  }

  const snap = await getCustom<RawSnap>(k8s, {
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name: inputs.snapshotName,
  });
  if (snap.status?.readyToUse !== true) {
    const e = new Error(`Snapshot ${inputs.snapshotName} not ready`);
    (e as Error & { code?: number }).code = 409; throw e;
  }

  // Membership: snap.spec.volume must equal a PVC in this cluster
  // (we read CNPG-managed PVCs via the cnpg.io/cluster label)
  const pvcs = await k8s.core.listNamespacedPersistentVolumeClaim({
    namespace: inputs.clusterNamespace,
    labelSelector: `cnpg.io/cluster=${inputs.clusterName}`,
  } as unknown as Parameters<typeof k8s.core.listNamespacedPersistentVolumeClaim>[0]) as { items?: ReadonlyArray<{ metadata?: { name?: string }; spec?: { volumeName?: string } }> };
  const matchingPvcName = pvcs.items?.find((p) => p.spec?.volumeName === snap.spec?.volume)?.metadata?.name;
  if (!matchingPvcName) {
    const e = new Error(`Snapshot ${inputs.snapshotName} does not belong to any PVC in cluster ${inputs.clusterNamespace}/${inputs.clusterName}`);
    (e as Error & { code?: number }).code = 409; throw e;
  }

  if (inputs.recoveryTargetTime) {
    const target = new Date(inputs.recoveryTargetTime);
    const snapTime = new Date(snap.status?.creationTime ?? snap.metadata?.creationTimestamp ?? '');
    if (target.getTime() < snapTime.getTime()) {
      const e = new Error(`recoveryTargetTime ${target.toISOString()} is before snapshot time ${snapTime.toISOString()}; PITR can only roll FORWARD from the snapshot`);
      (e as Error & { code?: number }).code = 422; throw e;
    }
    const wal = await inspectWalCoverage(kubeconfigPath, inputs.clusterNamespace, primaryPvc, target);
    if (!wal.ok) {
      const e = new Error(`PITR target unreachable from snapshot's WAL: ${wal.reason}`);
      (e as Error & { code?: number }).code = 422; throw e;
    }
    steps.push({ step: 'preflight-wal-coverage', ok: true, elapsedMs: nowMs() - t0, detail: `walCount=${wal.walCount} oldest=${wal.oldestWalAt?.toISOString()}` });
  } else {
    steps.push({ step: 'preflight-wal-coverage', ok: true, elapsedMs: nowMs() - t0, detail: 'no PITR target — restoring to snapshot LSN' });
  }

  return { snap, cluster, primaryPvc: matchingPvcName };
}

/**
 * Wrap an existing Longhorn snapshot as a Pre-provisioned Kubernetes
 * VolumeSnapshot CR so CNPG bootstrap.recovery.volumeSnapshots can
 * consume it without re-snapshotting the data.
 */
async function wrapVolumeSnapshot(
  k8s: K8sClients,
  namespace: string,
  longhornSnapshotName: string,
  longhornVolumeName: string,
): Promise<{ readonly volumeSnapshotName: string; readonly contentName: string }> {
  const safeName = longhornSnapshotName.replace(/[^a-z0-9-]/g, '-').slice(0, 50);
  const ts = Date.now();
  const contentName = `pitr-content-${ts}-${safeName}`;
  const vsName = `pitr-vs-${ts}-${safeName}`;

  await createCustom(k8s, {
    group: SNAPSHOT_API, version: 'v1', plural: 'volumesnapshotcontents',
    body: {
      apiVersion: `${SNAPSHOT_API}/v1`, kind: 'VolumeSnapshotContent',
      metadata: { name: contentName },
      spec: {
        deletionPolicy: 'Delete',
        driver: 'driver.longhorn.io',
        source: {
          // Longhorn 1.11 CSI driver snapshotHandle format for in-volume
          // snapshots is `snap://<volume-name>/<snapshot-name>` (the
          // legacy `<volume>/<snapshot>` form is also accepted but the
          // prefixed form is what longhorn-manager emits and what its
          // CreateVolume parser prefers). Backups use `bs://`. Without
          // the volume-name segment, the CSI driver fails to look up
          // the source snapshot and the resulting PVC binds to an
          // empty volume — CNPG then sits at "Setting up primary"
          // forever because pg_data is empty.
          snapshotHandle: `snap://${longhornVolumeName}/${longhornSnapshotName}`,
        },
        volumeSnapshotClassName: 'longhorn',
        volumeSnapshotRef: {
          apiVersion: `${SNAPSHOT_API}/v1`, kind: 'VolumeSnapshot',
          name: vsName, namespace,
        },
        sourceVolumeMode: 'Filesystem',
      },
    },
  });

  await createCustom(k8s, {
    group: SNAPSHOT_API, version: 'v1', namespace, plural: 'volumesnapshots',
    body: {
      apiVersion: `${SNAPSHOT_API}/v1`, kind: 'VolumeSnapshot',
      metadata: { name: vsName, namespace },
      spec: {
        source: { volumeSnapshotContentName: contentName },
        volumeSnapshotClassName: 'longhorn',
      },
    },
  });

  return { volumeSnapshotName: vsName, contentName };
}

async function deleteVolumeSnapshot(
  k8s: K8sClients,
  namespace: string,
  volumeSnapshotName: string,
  contentName: string,
): Promise<void> {
  await deleteCustom(k8s, { group: SNAPSHOT_API, version: 'v1', namespace, plural: 'volumesnapshots', name: volumeSnapshotName });
  await deleteCustom(k8s, { group: SNAPSHOT_API, version: 'v1', plural: 'volumesnapshotcontents', name: contentName });
}

/**
 * Build a CNPG Cluster body that bootstraps from a VolumeSnapshot,
 * carrying over the source cluster's identity (database, owner, secret,
 * imageName, storage size + class, affinity).
 */
// Tight resource overrides for the TEMP PITR cluster — its only job is
// bootstrap-from-snapshot → snapshot itself → get deleted (~5-10 min).
// Sized for 4 GB-RAM cluster servers where the source cluster's
// production resources (1 Gi limit per instance) would unnecessarily
// pin memory during the cutover. 512 Mi covers postgres init + WAL
// replay during snapshot recovery.
const TEMP_CLUSTER_RESOURCES = {
  requests: { cpu: '50m', memory: '256Mi' },
  limits:   { cpu: '500m', memory: '512Mi' },
} as const;

function buildRecoveryCluster(
  src: CnpgCluster,
  newName: string,
  namespace: string,
  volumeSnapshotName: string,
  recoveryTargetTime: string | null,
  instances: number,
  isTemp: boolean,
): unknown {
  const recoveryTarget = recoveryTargetTime
    ? { targetTime: recoveryTargetTime, targetInclusive: true }
    : undefined;
  // Temp cluster: small fixed resources (transient, runs ~5-10 min).
  // Source rebuild: inherit production-sized resources from the
  // source's spec.resources (1 Gi limit, etc.) so the recreated
  // cluster matches the original sizing.
  const resources = isTemp ? TEMP_CLUSTER_RESOURCES : src.spec?.resources;
  return {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Cluster',
    metadata: { name: newName, namespace, labels: { 'platform.phoenix-host.net/pitr-restore': 'true' } },
    spec: {
      instances,
      imageName: src.spec?.imageName,
      inheritedMetadata: src.spec?.inheritedMetadata,
      storage: src.spec?.storage,
      affinity: src.spec?.affinity,
      // Propagate resources so CNPG injects them into all spawned pods
      // (postgres instance + bootstrap-controller + snapshot-recovery
      // Job). The platform namespace has a ResourceQuota that requires
      // limits.cpu/memory + requests.cpu/memory on every pod; without
      // these the snapshot-recovery Job is rejected with "must specify
      // limits.cpu for: bootstrap-controller,snapshot-recovery" and
      // the temp cluster sits at "Setting up primary" forever.
      resources,
      postgresql: src.spec?.postgresql,
      enableSuperuserAccess: src.spec?.enableSuperuserAccess,
      monitoring: src.spec?.monitoring,
      bootstrap: {
        recovery: {
          volumeSnapshots: {
            storage: {
              apiGroup: SNAPSHOT_API,
              kind: 'VolumeSnapshot',
              name: volumeSnapshotName,
            },
          },
          ...(recoveryTarget ? { recoveryTarget } : {}),
        },
      },
    },
  };
}

/**
 * Main orchestrator. Holds the in-process lock for the duration.
 * Throws on unrecoverable error AFTER attempting auto-recovery of the
 * source cluster.
 */
export async function promotePostgresFromSnapshot(
  deps: PitrDeps,
  inputs: PitrInputs,
): Promise<PitrResult> {
  // Cluster-wide pre-check: if another replica has the DB lock set
  // (from a prior cutover-phase orchestration), refuse early.
  const existing = await readPersistedLock(deps.db).catch(() => null);
  if (existing) {
    const e = new Error(`Postgres restore already in progress on another replica (started ${existing.startedAt}, snapshot ${existing.snapshot}, phase=${existing.phase})`);
    (e as Error & { code?: number }).code = 409; throw e;
  }
  if (activeRestore) {
    const e = new Error(`Postgres restore already in progress (started ${activeRestore.startedAt.toISOString()}, snapshot ${activeRestore.snapshot})`);
    (e as Error & { code?: number }).code = 409; throw e;
  }
  activeRestore = { startedAt: new Date(), snapshot: inputs.snapshotName };
  // Write a "preflight" DB-lock IMMEDIATELY so other replicas reject
  // writes from the very first moment of the orchestration. The phase
  // gets bumped to 'cutover' just before delete-source.
  await writePersistedLock(deps.db, {
    startedAt: activeRestore.startedAt.toISOString(),
    snapshot: inputs.snapshotName,
    clusterNamespace: inputs.clusterNamespace,
    clusterName: inputs.clusterName,
    tempClusterName: '(not yet created)',
    phase: 'preflight',
  }).catch(() => undefined);
  const startMs = nowMs();
  let downtimeStart: number | null = null;
  let downtimeEnd: number | null = null;
  const steps: PitrStep[] = [];
  const tempName = `${inputs.clusterName}-pitr-${Date.now()}`;
  let wrapped: { volumeSnapshotName: string; contentName: string } | null = null;
  let tempSnap: { volumeSnapshotName: string; contentName: string } | null = null;
  let tempSnapName: string | null = null;
  let sourceDeleted = false;
  // Hoisted so the catch block can reference the original cluster spec
  // (database/owner/secret/imageName/storage size) for auto-recovery.
  let pre: { snap: RawSnap; cluster: CnpgCluster; primaryPvc: string } | null = null;

  try {
    // 1. Pre-flight
    const t0 = nowMs();
    pre = await preflight(deps.k8s, deps.kubeconfigPath, inputs, steps);
    steps.push({ step: 'preflight', ok: true, elapsedMs: nowMs() - t0, detail: `primary=${pre.primaryPvc}` });

    // 2. Wrap snapshot. The Longhorn volume name == the PV name backing
    // the source PVC; preflight already resolved this via the snap CR's
    // .spec.volume field (and verified it matches a CNPG-managed PVC).
    const t1 = nowMs();
    const sourceLonghornVolume = pre.snap.spec?.volume;
    if (!sourceLonghornVolume) throw new Error('snapshot has no spec.volume — cannot wrap');
    wrapped = await wrapVolumeSnapshot(deps.k8s, inputs.clusterNamespace, inputs.snapshotName, sourceLonghornVolume);
    steps.push({ step: 'wrap-volume-snapshot', ok: true, elapsedMs: nowMs() - t1, detail: wrapped.volumeSnapshotName });

    // 3. Bootstrap temp cluster
    const t2 = nowMs();
    const tempBody = buildRecoveryCluster(pre.cluster, tempName, inputs.clusterNamespace, wrapped.volumeSnapshotName, inputs.recoveryTargetTime, 1, true /* isTemp */);
    await createCustom(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', body: tempBody });
    steps.push({ step: 'create-temp-cluster', ok: true, elapsedMs: nowMs() - t2, detail: tempName });

    // 4. Wait + sanity probe
    const t3 = nowMs();
    const tempHealth = await waitClusterHealthy(deps.k8s, inputs.clusterNamespace, tempName, 8 * 60_000);
    steps.push({ step: 'temp-healthy', ok: tempHealth.ok, elapsedMs: nowMs() - t3, detail: `phase=${tempHealth.phase ?? '?'} primary=${tempHealth.primary ?? '?'}` });
    if (!tempHealth.ok || !tempHealth.primary) throw new Error(`Temp cluster did not become healthy: phase=${tempHealth.phase}`);
    const probeDb = pre.cluster.spec!.bootstrap!.initdb!.database!;
    const probe = await probePsql(deps.kubeconfigPath, inputs.clusterNamespace, tempHealth.primary, probeDb, 'SELECT 1');
    steps.push({ step: 'temp-probe', ok: probe.ok, detail: probe.stdout || probe.stderr });
    if (!probe.ok) throw new Error(`Temp cluster psql probe failed: ${probe.stderr}`);

    // 5. Quiesce consumers (downtime starts here)
    downtimeStart = nowMs();
    const t5 = nowMs();
    await deps.k8s.apps.patchNamespacedDeploymentScale({
      namespace: 'platform', name: 'platform-api',
      body: { spec: { replicas: 0 } },
    } as unknown as Parameters<typeof deps.k8s.apps.patchNamespacedDeploymentScale>[0]).catch(() => undefined);
    // Stalwart depends on postgres for DKIM and mailbox metadata
    await patchCustomMerge(deps.k8s, {
      group: 'apps', version: 'v1', namespace: 'mail', plural: 'statefulsets', name: 'stalwart-mail',
      body: { spec: { replicas: 0 } },
    }).catch(() => undefined);
    steps.push({ step: 'quiesce-consumers', ok: true, elapsedMs: nowMs() - t5 });

    // 6. Snapshot the temp cluster's primary PVC so we can re-bootstrap
    //    the source Cluster name from the same point-in-time data.
    //    Longhorn snapshot CRs reference volumes by their Longhorn name
    //    (== PV name backing the PVC), not the PVC name. Look it up.
    const t6 = nowMs();
    const tempPrimaryPvc = tempHealth.primary;
    const tempPvcObj = await deps.k8s.core.readNamespacedPersistentVolumeClaim({
      namespace: inputs.clusterNamespace, name: tempPrimaryPvc,
    } as unknown as Parameters<typeof deps.k8s.core.readNamespacedPersistentVolumeClaim>[0]) as { spec?: { volumeName?: string } };
    const tempLonghornVolume = tempPvcObj.spec?.volumeName;
    if (!tempLonghornVolume) throw new Error(`Temp primary PVC ${tempPrimaryPvc} has no .spec.volumeName — cannot snapshot`);
    tempSnapName = `pitr-handoff-${Date.now()}`;
    await createCustom(deps.k8s, {
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
      body: {
        apiVersion: `${LH_GROUP}/${LH_VERSION}`, kind: 'Snapshot',
        metadata: { name: tempSnapName, namespace: LH_NS },
        spec: { volume: tempLonghornVolume, createSnapshot: true },
      },
    });
    // Wait for ready
    let tempSnapReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const s = await getCustom<RawSnap>(deps.k8s, { group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name: tempSnapName });
        if (s.status?.readyToUse === true) { tempSnapReady = true; break; }
      } catch { /* keep */ }
    }
    if (!tempSnapReady) throw new Error('Temp cluster handoff snapshot did not become ready');
    tempSnap = await wrapVolumeSnapshot(deps.k8s, inputs.clusterNamespace, tempSnapName, tempLonghornVolume);
    steps.push({ step: 'snapshot-temp-primary', ok: true, elapsedMs: nowMs() - t6, detail: tempSnap.volumeSnapshotName });

    // Persist crash-safe marker BEFORE the destructive cutover. If
    // platform-api dies between here and the successful unwind below,
    // the next startup's recoverInterruptedRestore will surface a
    // sticky admin notification with enough context to recover by hand.
    await writePersistedLock(deps.db, {
      startedAt: activeRestore.startedAt.toISOString(),
      snapshot: inputs.snapshotName,
      clusterNamespace: inputs.clusterNamespace,
      clusterName: inputs.clusterName,
      tempClusterName: tempName,
      phase: 'cutover',
    });

    // 7. Delete source (PVCs survive: Retain reclaim)
    const t7 = nowMs();
    await deleteCustom(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: inputs.clusterName });
    sourceDeleted = true;
    // CNPG finalizer cleanup takes 30-60s
    for (let i = 0; i < 90; i++) {
      try {
        await getCustom<CnpgCluster>(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: inputs.clusterName });
        await new Promise((r) => setTimeout(r, 2_000));
      } catch { break; }
    }
    steps.push({ step: 'delete-source', ok: true, elapsedMs: nowMs() - t7 });

    // 8. Re-create source Cluster from temp's snapshot
    const t8 = nowMs();
    const newSrcBody = buildRecoveryCluster(
      pre.cluster, inputs.clusterName, inputs.clusterNamespace,
      tempSnap.volumeSnapshotName, null /* no PITR — temp already replayed */,
      pre.cluster.spec?.instances ?? 1,
      false /* isTemp: rebuilding the production source */,
    );
    await createCustom(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', body: newSrcBody });
    const srcHealth = await waitClusterHealthy(deps.k8s, inputs.clusterNamespace, inputs.clusterName, 8 * 60_000);
    steps.push({ step: 'recreate-source', ok: srcHealth.ok, elapsedMs: nowMs() - t8, detail: `phase=${srcHealth.phase ?? '?'}` });
    if (!srcHealth.ok) throw new Error(`Recreated source cluster did not become healthy: phase=${srcHealth.phase}`);

    // 9. Restore consumers
    const t9 = nowMs();
    await deps.k8s.apps.patchNamespacedDeploymentScale({
      namespace: 'platform', name: 'platform-api',
      body: { spec: { replicas: 3 } },
    } as unknown as Parameters<typeof deps.k8s.apps.patchNamespacedDeploymentScale>[0]).catch(() => undefined);
    await patchCustomMerge(deps.k8s, {
      group: 'apps', version: 'v1', namespace: 'mail', plural: 'statefulsets', name: 'stalwart-mail',
      body: { spec: { replicas: 1 } },
    }).catch(() => undefined);
    downtimeEnd = nowMs();
    steps.push({ step: 'restore-consumers', ok: true, elapsedMs: nowMs() - t9 });

    // 10. Cleanup
    const t10 = nowMs();
    await deleteCustom(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: tempName }).catch(() => undefined);
    await deleteVolumeSnapshot(deps.k8s, inputs.clusterNamespace, wrapped.volumeSnapshotName, wrapped.contentName).catch(() => undefined);
    await deleteVolumeSnapshot(deps.k8s, inputs.clusterNamespace, tempSnap.volumeSnapshotName, tempSnap.contentName).catch(() => undefined);
    if (tempSnapName) {
      await deleteCustom(deps.k8s, { group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name: tempSnapName }).catch(() => undefined);
    }
    steps.push({ step: 'cleanup', ok: true, elapsedMs: nowMs() - t10 });

    // 11. Notify
    const downtimeMs = (downtimeEnd ?? nowMs()) - (downtimeStart ?? startMs);
    await emitAdminNotification(
      deps.db,
      `PITR restore of ${inputs.clusterNamespace}/${inputs.clusterName} from snapshot ${inputs.snapshotName} ` +
      `(target=${inputs.recoveryTargetTime ?? 'snapshot LSN'}) completed in ${Math.round((nowMs() - startMs) / 1000)}s. ` +
      `Cluster downtime: ${Math.round(downtimeMs / 1000)}s. Initiated by user ${inputs.actorUserId ?? '(unknown)'}.`,
      'Postgres PITR completed',
    );

    return {
      clusterName: inputs.clusterName,
      snapshotName: inputs.snapshotName,
      recoveryTargetTime: inputs.recoveryTargetTime,
      steps,
      downtimeMs,
      tempClusterName: tempName,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    steps.push({ step: 'orchestration-failed', ok: false, detail: errMsg });

    // Auto-recovery: if we already deleted the source, try to recreate
    // it from the ORIGINAL snapshot (which still exists). Source PVCs
    // are Retain-policy so they survived; CNPG bootstraps fresh from
    // the snapshot for cleanliness. Carry over the ORIGINAL cluster's
    // identity (database/owner/secret/imageName/storage size/instances)
    // — without these, CNPG would create a blank cluster that comes up
    // "healthy" but has no application data.
    if (sourceDeleted && pre && wrapped) {
      try {
        const recoveryBody = buildRecoveryCluster(
          pre.cluster,
          inputs.clusterName, inputs.clusterNamespace,
          wrapped.volumeSnapshotName,
          null, pre.cluster.spec?.instances ?? 1,
          false /* isTemp: rebuilding production source */,
        );
        await createCustom(deps.k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', body: recoveryBody });
        steps.push({ step: 'auto-recovery', ok: true, detail: 'recreated source cluster from original snapshot' });
      } catch (rerr) {
        steps.push({ step: 'auto-recovery', ok: false, detail: (rerr as Error).message });
      }
    } else if (sourceDeleted) {
      steps.push({ step: 'auto-recovery', ok: false, detail: 'cannot auto-recover: missing pre-flight cluster ref or wrapped snapshot' });
    }

    // Cleanup whatever we can — including the temp cluster (otherwise
    // it pins the snapshot-derived PVC and accumulates orphaned
    // Longhorn volumes across repeated failed restores).
    await deleteCustom(deps.k8s, {
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: tempName,
    }).catch(() => undefined);
    if (tempSnap) await deleteVolumeSnapshot(deps.k8s, inputs.clusterNamespace, tempSnap.volumeSnapshotName, tempSnap.contentName).catch(() => undefined);
    if (wrapped) await deleteVolumeSnapshot(deps.k8s, inputs.clusterNamespace, wrapped.volumeSnapshotName, wrapped.contentName).catch(() => undefined);
    if (tempSnapName) {
      await deleteCustom(deps.k8s, {
        group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name: tempSnapName,
      }).catch(() => undefined);
    }

    await emitAdminNotification(
      deps.db,
      `PITR restore of ${inputs.clusterNamespace}/${inputs.clusterName} FAILED at step "${steps.at(-1)?.step}": ${errMsg}. ` +
      `Inspect platform-api logs and the postgres Cluster CR. Source PVCs were Retain-policy so the underlying data still exists.`,
      'Postgres PITR FAILED',
    );

    const e = err instanceof Error ? err : new Error(String(err));
    (e as Error & { steps?: PitrStep[] }).steps = steps;
    throw e;
  } finally {
    // Always release both locks, even on success path.
    activeRestore = null;
    await clearPersistedLock(deps.db).catch(() => undefined);
  }
}
