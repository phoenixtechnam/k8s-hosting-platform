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
 * Architecture: the route handler returns 202 immediately after
 * creating a one-shot Kubernetes Job (createPitrJob below) that runs
 * the orchestration in a dedicated pod. Decouples the orchestration
 * from the platform-api process — critical because during cutover
 * (postgres briefly unreachable), platform-api's pg connection pool
 * retries saturate the Node event loop, /healthz can't respond, and
 * k8s liveness probe SIGKILLs the pod mid-orchestration. The Job pod
 * has no postgres-readiness dependency and survives the window
 * cleanly.
 *
 * Flow (~5–10 min wall-clock, runs inside the Job pod):
 *
 *   1. Pre-flight: membership, snapshot freshness, WAL coverage, lock
 *   2. Wrap the Longhorn snapshot as a Pre-provisioned VolumeSnapshot
 *   3. Bootstrap a TEMP CNPG Cluster from the VolumeSnapshot
 *   4. Wait for temp cluster healthy + run psql sanity probes
 *   5. Quiesce Stalwart (scale to 0); platform-api stays running
 *      (Job runs in its own pod — no self-kill risk)
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
  /** Name of the k8s Job running the orchestration (set by the route
   * handler when it creates the Job). recoverInterruptedRestore uses
   * this to locate + delete an orphan Job at startup. */
  readonly jobName?: string;
  // 'preflight' = orchestration started but source not yet deleted.
  //   Crash here is benign — recoverInterruptedRestore just clears
  //   the lock; no source data was touched.
  // 'cutover'   = source has been deleted (PVCs are reclaimPolicy=
  //   Retain so data survives) but recreate is in flight. Crash here
  //   needs operator attention.
  // 'cleanup'   = recreate succeeded, only temp resources remain.
  readonly phase: 'preflight' | 'cutover' | 'rebuilding' | 'cleanup';
  // Captured at preflight from pre.cluster.spec.bootstrap.initdb.
  // recoverInterruptedRestore uses this to normalize the rebuilt
  // source cluster's spec.bootstrap (set bootstrap=initdb, recovery=
  // null) when the orchestration dies before its own step 8b runs.
  // Without this, the rebuilt cluster CR keeps spec.bootstrap.recovery
  // and Flux's apply of the original git manifest (initdb) is rejected
  // by CNPG's webhook ("Too many bootstrap types specified") forever.
  readonly originalInitdb?: unknown;
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
 * Atomically acquire the PITR lock for the route handler.
 *
 * Race-safe: the cluster-wide check is followed by a SYNCHRONOUS
 * in-memory set with no awaitable operation between them, so two
 * concurrent POSTs in the same Node event-loop tick cannot both
 * succeed. The DB write happens after the in-memory set; if it
 * fails, we release the in-memory lock so we don't leave a stuck
 * state.
 *
 * Throws Error with .code=409 if a restore is already in progress.
 *
 * Used by the route handler so the route can return 202 immediately
 * AFTER the lock is durably set, avoiding the prior race where
 * `void promotePostgresFromSnapshot(...)` returned 202 before its
 * own first await reached the lock-write.
 */
/**
 * Release the PITR lock held by acquirePitrLockOrThrow. Used by the
 * route handler to roll back the lock if Job creation fails (so the
 * lock isn't stuck holding writes blocked forever for a Job that
 * never started). Once the Job is successfully created, the orchestration's
 * own finally block in promotePostgresFromSnapshot owns the release.
 *
 * Always succeeds — best-effort; clears both in-memory and DB lock.
 */
export async function releasePitrLock(db: Database): Promise<void> {
  activeRestore = null;
  await clearPersistedLock(db).catch(() => undefined);
}

export async function acquirePitrLockOrThrow(
  db: Database,
  inputs: { clusterNamespace: string; clusterName: string; snapshotName: string },
): Promise<{ readonly startedAt: Date }> {
  const persisted = await readPersistedLock(db).catch(() => null);
  if (persisted) {
    const e = new Error(`Postgres restore already in progress on another replica (started ${persisted.startedAt}, snapshot ${persisted.snapshot}, phase=${persisted.phase})`);
    (e as Error & { code?: number }).code = 409; throw e;
  }
  // Synchronous critical section — no awaits between check and set.
  if (activeRestore) {
    const e = new Error(`Postgres restore already in progress (started ${activeRestore.startedAt.toISOString()}, snapshot ${activeRestore.snapshot})`);
    (e as Error & { code?: number }).code = 409; throw e;
  }
  const startedAt = new Date();
  activeRestore = { startedAt, snapshot: inputs.snapshotName };
  try {
    await writePersistedLock(db, {
      startedAt: startedAt.toISOString(),
      snapshot: inputs.snapshotName,
      clusterNamespace: inputs.clusterNamespace,
      clusterName: inputs.clusterName,
      tempClusterName: '(not yet created)',
      phase: 'preflight',
    });
  } catch (err) {
    activeRestore = null;
    throw err;
  }
  return { startedAt };
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
): Promise<{
  readonly recovered: boolean;
  readonly lock?: PersistedLock;
  readonly cleanedTempClusters?: number;
  readonly cleanedVolumeSnapshots?: number;
  readonly cleanedVolumeSnapshotContents?: number;
  readonly cleanedLonghornSnapshots?: number;
}> {
  const lock = await readPersistedLock(db);
  if (!lock) return { recovered: false };

  // Scope cleanup by labelSelector matching BOTH pitr-restore=true
  // AND pitr-namespace=<this lock's namespace>. PITR runs from other
  // source clusters in other namespaces are not touched. Labels are
  // set on every PITR-created resource via pitrLabels() (see step 6
  // and wrapVolumeSnapshot below).
  const labelSelector = `platform.phoenix-host.net/pitr-restore=true,platform.phoenix-host.net/pitr-namespace=${lock.clusterNamespace}`;

  // CRITICAL: with the Job-based design, a platform-api restart (rolling
  // deploy, liveness kill) is NOT correlated with the orchestration's
  // health — the Job pod runs independently. Before destroying any
  // resources, check whether a live PITR Job is still running. If yes,
  // skip cleanup + clear-lock entirely; the Job owns those resources
  // and will release the lock itself when done.
  if (k8s) {
    try {
      const jobList = await (k8s.batch as unknown as {
        listNamespacedJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string }; status?: { active?: number; succeeded?: number; failed?: number } }> }>;
      }).listNamespacedJob({ namespace: 'platform', labelSelector });
      const liveJob = (jobList.items ?? []).find((j) => (j.status?.active ?? 0) > 0);
      if (liveJob) {
        // A Job is still running. This is NOT an interrupted restore —
        // it's a normal platform-api restart while the Job pod is
        // healthy. Don't touch any resources, don't clear the lock.
        return { recovered: false };
      }
    } catch { /* best effort — fall through to cleanup */ }
  }

  let cleanedTempClusters = 0;
  let cleanedVolumeSnapshots = 0;
  let cleanedVolumeSnapshotContents = 0;
  let cleanedLonghornSnapshots = 0;
  if (k8s) {
    // Temp CNPG clusters (post-2f876ac fix: only TEMP clusters carry
    // the pitr-restore label; rebuilt source inherits original labels).
    try {
      const list = await (k8s.custom as unknown as {
        listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listNamespacedCustomObject({
        group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters',
        labelSelector,
      });
      for (const c of list.items ?? []) {
        const name = c.metadata?.name;
        if (name) {
          await deleteCustom(k8s, { group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters', name }).catch(() => undefined);
          cleanedTempClusters++;
        }
      }
    } catch { /* best-effort; admin notification still emits */ }

    // VolumeSnapshots in the source cluster's namespace.
    try {
      const vsList = await (k8s.custom as unknown as {
        listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listNamespacedCustomObject({
        group: SNAPSHOT_API, version: 'v1', namespace: lock.clusterNamespace, plural: 'volumesnapshots',
        labelSelector,
      });
      for (const vs of vsList.items ?? []) {
        const name = vs.metadata?.name;
        if (name) {
          await deleteCustom(k8s, { group: SNAPSHOT_API, version: 'v1', namespace: lock.clusterNamespace, plural: 'volumesnapshots', name }).catch(() => undefined);
          cleanedVolumeSnapshots++;
        }
      }
    } catch { /* best effort */ }

    // VolumeSnapshotContents are cluster-scoped — labelSelector still
    // works (labels are per-resource regardless of scope) and ONLY
    // matches contents whose pitr-namespace label == lock's namespace.
    try {
      const vscList = await (k8s.custom as unknown as {
        listClusterCustomObject: (a: { group: string; version: string; plural: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listClusterCustomObject({
        group: SNAPSHOT_API, version: 'v1', plural: 'volumesnapshotcontents',
        labelSelector,
      });
      for (const vsc of vscList.items ?? []) {
        const name = vsc.metadata?.name;
        if (name) {
          await deleteCustom(k8s, { group: SNAPSHOT_API, version: 'v1', plural: 'volumesnapshotcontents', name }).catch(() => undefined);
          cleanedVolumeSnapshotContents++;
        }
      }
    } catch { /* best effort */ }

    // Longhorn snapshots live in longhorn-system (shared across all
    // PITR runs). The pitr-namespace label scopes by source cluster.
    try {
      const lhList = await (k8s.custom as unknown as {
        listNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listNamespacedCustomObject({
        group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
        labelSelector,
      });
      for (const s of lhList.items ?? []) {
        const name = s.metadata?.name;
        if (name) {
          await deleteCustom(k8s, { group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name }).catch(() => undefined);
          cleanedLonghornSnapshots++;
        }
      }
    } catch { /* best effort */ }

    // Orphan PITR Jobs (in the platform namespace — that's where the
    // route always creates them). Use the same labelSelector. A
    // completed Job's pod stays around for ttlSecondsAfterFinished;
    // delete the Job CR + its pod entirely so a re-run doesn't see
    // them.
    try {
      const jobList = await (k8s.batch as unknown as {
        listNamespacedJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string } }> }>;
      }).listNamespacedJob({ namespace: 'platform', labelSelector });
      for (const j of jobList.items ?? []) {
        const name = j.metadata?.name;
        if (name) {
          await (k8s.batch as unknown as {
            deleteNamespacedJob: (a: { namespace: string; name: string; propagationPolicy?: string }) => Promise<unknown>;
          }).deleteNamespacedJob({ namespace: 'platform', name, propagationPolicy: 'Background' }).catch(() => undefined);
        }
      }
    } catch { /* best effort */ }

    // Normalize source cluster's spec.bootstrap if it's still in
    // recovery mode (orchestration died before its own step 8b ran).
    // Without this, Flux's apply of git's bootstrap.initdb is rejected
    // by CNPG's webhook ("Too many bootstrap types specified") and
    // platform Kustomization stalls indefinitely. We need the original
    // initdb spec — captured at cutover write into the persisted lock.
    if (lock.originalInitdb) {
      try {
        const srcCluster = await getCustom<CnpgCluster>(k8s, {
          group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters', name: lock.clusterName,
        }).catch(() => null);
        if (srcCluster && (srcCluster.spec?.bootstrap as { recovery?: unknown } | undefined)?.recovery) {
          await patchCustomMerge(k8s, {
            group: CNPG_GROUP, version: CNPG_VERSION, namespace: lock.clusterNamespace, plural: 'clusters', name: lock.clusterName,
            body: { spec: { bootstrap: { recovery: null, initdb: lock.originalInitdb } } },
          });
        }
      } catch { /* best effort — operator may need to patch by hand */ }
    }
  }

  const totalCleaned = cleanedTempClusters + cleanedVolumeSnapshots + cleanedVolumeSnapshotContents + cleanedLonghornSnapshots;
  await emitAdminNotification(
    db,
    `Platform-api restarted while a Postgres PITR was in progress (started ${lock.startedAt}, snapshot ${lock.snapshot}, phase=${lock.phase}). ` +
    `The cluster ${lock.clusterNamespace}/${lock.clusterName} may be in an indeterminate state. ` +
    `Inspect: kubectl -n ${lock.clusterNamespace} get cluster ${lock.clusterName} ${lock.tempClusterName}. ` +
    `If the source cluster is missing, the original PVCs are reclaimPolicy=Retain — manually re-create the Cluster CR pointing at them.` +
    (totalCleaned > 0
      ? ` Auto-cleaned ${cleanedTempClusters} temp cluster(s) + ${cleanedVolumeSnapshots} VolumeSnapshot(s) + ${cleanedVolumeSnapshotContents} VolumeSnapshotContent(s) + ${cleanedLonghornSnapshots} Longhorn snapshot(s).`
      : ''),
    'Postgres PITR INTERRUPTED — manual recovery required',
  );
  await clearPersistedLock(db);
  return { recovered: true, lock, cleanedTempClusters, cleanedVolumeSnapshots, cleanedVolumeSnapshotContents, cleanedLonghornSnapshots };
}

const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';
const SNAPSHOT_API = 'snapshot.storage.k8s.io';
const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';

interface CnpgCluster {
  readonly metadata?: { readonly name?: string; readonly namespace?: string; readonly labels?: Readonly<Record<string, string>> };
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
// Per-resource label set on every PITR-created VolumeSnapshot,
// VolumeSnapshotContent, Longhorn snapshot, and temp CNPG cluster.
// Two labels — `pitr-restore=true` to identify the resource as
// PITR-owned, and `pitr-namespace=<ns>` so the recovery-time cleanup
// can scope by source cluster namespace (the orphan cleanup at
// startup uses these labels via labelSelector to avoid cross-
// namespace deletion in multi-tenant setups). Labels are the
// authoritative scoping mechanism; the name prefix is a fallback
// for human inspection / kubectl get filtering.
function pitrLabels(clusterNamespace: string): Record<string, string> {
  return {
    'platform.phoenix-host.net/pitr-restore': 'true',
    'platform.phoenix-host.net/pitr-namespace': clusterNamespace,
  };
}

async function wrapVolumeSnapshot(
  k8s: K8sClients,
  namespace: string,
  longhornSnapshotName: string,
  longhornVolumeName: string,
): Promise<{ readonly volumeSnapshotName: string; readonly contentName: string }> {
  const safeName = longhornSnapshotName.replace(/[^a-z0-9-]/g, '-').slice(0, 50);
  const ts = Date.now();
  // Names embed the namespace too (defense-in-depth alongside labels)
  // so kubectl get/grep on the name scope cleanly across clusters.
  const contentName = `pitr-content-${ts}-${safeName}`;
  const vsName = `pitr-vs-${ts}-${safeName}`;
  const labels = pitrLabels(namespace);

  await createCustom(k8s, {
    group: SNAPSHOT_API, version: 'v1', plural: 'volumesnapshotcontents',
    body: {
      apiVersion: `${SNAPSHOT_API}/v1`, kind: 'VolumeSnapshotContent',
      metadata: { name: contentName, labels },
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
      metadata: { name: vsName, namespace, labels },
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
  // pitr-restore=true + pitr-namespace=<ns> labels IDENTIFY the temp
  // cluster only — the recoverInterruptedRestore cleanup uses both
  // (labelSelector AND-of-both) to scope deletion per source
  // namespace and avoid cross-namespace cascade in multi-tenant
  // setups. The rebuilt source MUST NOT carry these labels (it's
  // the production cluster). Inherit source labels for the rebuild
  // path so monitoring / PodMonitor / network policies still match.
  const labels = isTemp
    ? pitrLabels(namespace)
    : (src.metadata as { labels?: Record<string, string> } | undefined)?.labels;
  return {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Cluster',
    metadata: { name: newName, namespace, ...(labels ? { labels } : {}) },
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
  // Lock acquisition. Three call paths:
  //   (a) Route handler sets activeRestore via acquirePitrLockOrThrow
  //       (in-memory + DB), then calls this directly (legacy in-process
  //       path; still used by tests).
  //   (b) Job pod gets PITR_LOCK_HELD=true env var — the route already
  //       acquired the DB lock, but this is a fresh process so
  //       activeRestore is null. Read the persisted lock to populate
  //       activeRestore in this process (so finally can release it
  //       cleanly).
  //   (c) Direct call (e.g. tests, future cron) — no env, no lock.
  //       acquirePitrLockOrThrow handles it.
  if (!activeRestore && process.env.PITR_LOCK_HELD === 'true') {
    const persisted = await readPersistedLock(deps.db);
    if (!persisted) {
      throw new Error('PITR_LOCK_HELD=true but no persisted lock — orchestration cannot proceed');
    }
    activeRestore = { startedAt: new Date(persisted.startedAt), snapshot: persisted.snapshot };
  } else if (!activeRestore) {
    await acquirePitrLockOrThrow(deps.db, inputs);
  }
  const lockStartedAt = activeRestore!.startedAt;
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

    // 5. Quiesce consumers (downtime starts here).
    //
    // We DO NOT scale platform-api to 0 — this orchestration runs
    // INSIDE a platform-api pod, so scaling to 0 sends SIGTERM to the
    // orchestrator's own pod. The k8s graceful-shutdown window kills
    // the orchestration mid-flight (typically right before step 8
    // recreate-source completes), leaking the temp CNPG cluster +
    // wrapped VolumeSnapshots + the persisted DB lock. platform-api's
    // /healthz is unauthenticated and doesn't query postgres, so pods
    // stay Ready throughout the cutover; the auth middleware (which
    // does query postgres) returns 503 for the ~30s window where
    // postgres is being recreated, but that's transparent to the
    // orchestrator and recovers automatically.
    //
    // Stalwart IS scaled to 0 — it's a long-lived postgres client
    // for DKIM + mailbox metadata, and partial writes during cutover
    // can corrupt mailbox state. Scaling Stalwart down is safe
    // because Stalwart doesn't host the orchestration.
    downtimeStart = nowMs();
    const t5 = nowMs();
    await patchCustomMerge(deps.k8s, {
      group: 'apps', version: 'v1', namespace: 'mail', plural: 'statefulsets', name: 'stalwart-mail',
      body: { spec: { replicas: 0 } },
    }).catch(() => undefined);
    steps.push({ step: 'quiesce-consumers', ok: true, elapsedMs: nowMs() - t5, detail: 'stalwart-mail scaled to 0; platform-api left running (self-host)' });

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
        // Labels: pitr-restore=true + pitr-namespace=<source ns>. The
        // longhorn-system namespace is shared across PITR runs from
        // any source cluster — startup cleanup uses the labelSelector
        // to delete only this orchestration's leftovers.
        metadata: { name: tempSnapName, namespace: LH_NS, labels: pitrLabels(inputs.clusterNamespace) },
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
      startedAt: lockStartedAt.toISOString(),
      snapshot: inputs.snapshotName,
      clusterNamespace: inputs.clusterNamespace,
      clusterName: inputs.clusterName,
      tempClusterName: tempName,
      phase: 'cutover',
      // Persist for recoverInterruptedRestore: if the orchestration
      // dies before step 8b, the next platform-api startup uses this
      // to normalize the rebuilt source cluster's bootstrap.
      originalInitdb: pre.cluster.spec?.bootstrap?.initdb,
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

    // 8b. Normalize spec.bootstrap so Flux's apply of the original git
    // manifest (which has bootstrap.initdb) doesn't conflict with our
    // runtime spec.bootstrap.recovery. CNPG's webhook rejects clusters
    // proposing both bootstrap types; even though bootstrap is
    // informational after first init, the strategic-merge from git
    // submits a body that combines initdb (git) + recovery (live)
    // and the apply fails. Patch spec.bootstrap to drop recovery and
    // restore the source's original initdb (carried in pre.cluster).
    // Best-effort — if CNPG rejects, surface as a non-fatal step
    // (operator can patch by hand; the cluster works either way).
    const t8b = nowMs();
    try {
      const originalInitdb = pre.cluster.spec?.bootstrap?.initdb;
      if (originalInitdb) {
        await patchCustomMerge(deps.k8s, {
          group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.clusterNamespace, plural: 'clusters', name: inputs.clusterName,
          body: { spec: { bootstrap: { recovery: null, initdb: originalInitdb } } },
        });
        steps.push({ step: 'normalize-bootstrap', ok: true, elapsedMs: nowMs() - t8b, detail: 'spec.bootstrap=initdb (recovery cleared)' });
      } else {
        steps.push({ step: 'normalize-bootstrap', ok: true, elapsedMs: nowMs() - t8b, detail: 'no original initdb — skipped' });
      }
    } catch (err) {
      steps.push({
        step: 'normalize-bootstrap', ok: false, elapsedMs: nowMs() - t8b,
        detail: `failed: ${(err as Error).message}. Flux apply may need manual: kubectl patch cluster -n ${inputs.clusterNamespace} ${inputs.clusterName} --type=json -p='[{"op":"remove","path":"/spec/bootstrap/recovery"},{"op":"add","path":"/spec/bootstrap/initdb","value":<original>}]'`,
      });
    }

    // 9. Restore consumers (only Stalwart — platform-api was never
    // scaled down; see step 5).
    const t9 = nowMs();
    await patchCustomMerge(deps.k8s, {
      group: 'apps', version: 'v1', namespace: 'mail', plural: 'statefulsets', name: 'stalwart-mail',
      body: { spec: { replicas: 1 } },
    }).catch(() => undefined);
    downtimeEnd = nowMs();
    steps.push({ step: 'restore-consumers', ok: true, elapsedMs: nowMs() - t9, detail: 'stalwart-mail scaled to 1' });

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

// ─── Job-based orchestration ────────────────────────────────────────────────

export interface CreatePitrJobInputs {
  readonly clusterNamespace: string;
  readonly clusterName: string;
  readonly snapshotName: string;
  readonly recoveryTargetTime: string | null;
  readonly actorUserId: string | null;
  /** Container image of the platform-api build that holds the pitr-job
   * CLI. Read from the platform-version ConfigMap so the Job uses the
   * same code as the API that triggered it. */
  readonly image: string;
}

export interface CreatePitrJobResult {
  readonly jobName: string;
  readonly namespace: string;
}

/**
 * Create a one-shot Kubernetes Job that runs the PITR orchestration in
 * a dedicated pod (instead of inside platform-api's process).
 *
 * IMPORTANT: the route handler MUST have called acquirePitrLockOrThrow
 * BEFORE this. The Job pod is a fresh process — its `activeRestore` is
 * null and it would race-acquire the lock against the route's own lock,
 * fail 409, and exit 1 on every invocation. Instead the route owns the
 * lock and the Job pod skips re-acquire by setting PITR_LOCK_HELD=true.
 *
 * The Job:
 *   - Uses the platform-api ServiceAccount (already has all RBAC for
 *     CNPG / Longhorn / VolumeSnapshot / deployments / statefulsets)
 *   - Inherits DATABASE_URL + JWT_SECRET from the same Secret chain
 *   - Runs `node dist/cli/pitr-job.js` (bypasses docker-entrypoint.sh's
 *     migrate + server startup)
 *   - backoffLimit: 0 — no retries; failed Jobs surface as admin
 *     notifications via the orchestrator's catch path
 *   - ttlSecondsAfterFinished: 86400 — auto-clean the Job pod after
 *     24 hours so operators have time to inspect logs
 *   - imagePullPolicy: Always — the image tag is mutable (`:latest` /
 *     `:0.0.0-<sha>` may be re-tagged), so force a pull every time to
 *     match the registry's current state for that tag
 *   - Labels: pitr-restore=true + pitr-namespace=<source ns> so
 *     recoverInterruptedRestore can match orphan Jobs the same way it
 *     matches temp clusters / VolumeSnapshots
 */
export async function createPitrJob(
  k8s: K8sClients,
  inputs: CreatePitrJobInputs,
): Promise<CreatePitrJobResult> {
  const ts = Date.now();
  // Truncate clusterName to keep the Job name under the K8s 63-char
  // DNS label limit. `pitr-` (5) + truncated (≤28) + `-` (1) + ts (13)
  // = ≤47 chars. clusterName validation in routes.ts allows up to 253
  // chars but real clusters are <30; truncating preserves uniqueness
  // for any practical case.
  const safeName = inputs.clusterName.slice(0, 28);
  const jobName = `pitr-${safeName}-${ts}`;
  // Job runs in the platform namespace (same as platform-api) so it
  // shares the ServiceAccount, secrets, and config. Source cluster
  // namespace is passed as a Job env var; not necessarily 'platform'.
  const jobNamespace = 'platform';
  const labels = {
    'platform.phoenix-host.net/pitr-restore': 'true',
    'platform.phoenix-host.net/pitr-namespace': inputs.clusterNamespace,
    'app.kubernetes.io/part-of': 'hosting-platform',
    'app.kubernetes.io/component': 'pitr-job',
  };

  const env: Array<Record<string, unknown>> = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'platform-db-credentials', key: 'url' } } },
    { name: 'JWT_SECRET', valueFrom: { secretKeyRef: { name: 'platform-jwt-secret', key: 'secret' } } },
    { name: 'PITR_CLUSTER_NAMESPACE', value: inputs.clusterNamespace },
    { name: 'PITR_CLUSTER_NAME', value: inputs.clusterName },
    { name: 'PITR_SNAPSHOT_NAME', value: inputs.snapshotName },
    // Tells pitr-job.ts to skip the lock acquire — the route handler
    // already acquired it (race-safe; the Job's process can't acquire
    // because it's a fresh process with activeRestore=null and the
    // DB lock is held by the route's call).
    { name: 'PITR_LOCK_HELD', value: 'true' },
  ];
  if (inputs.recoveryTargetTime) env.push({ name: 'PITR_RECOVERY_TARGET_TIME', value: inputs.recoveryTargetTime });
  if (inputs.actorUserId) env.push({ name: 'PITR_ACTOR_USER_ID', value: inputs.actorUserId });

  const body = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: jobNamespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 86400,
      // ActiveDeadlineSeconds: 30 min — kills the Job pod if the
      // orchestration hangs past the worst-case wall-clock (8 min temp
      // cluster wait + 8 min recreate-source wait + slack). Without
      // this, a hung Job would hold the lock forever.
      activeDeadlineSeconds: 1800,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'platform-api',
          restartPolicy: 'Never',
          // Tolerate the same scheduling rules as platform-api so the
          // Job lands on a server node (CNPG, Longhorn, etc are there).
          nodeSelector: { 'platform.phoenix-host.net/node-role': 'server' },
          tolerations: [
            { key: 'platform.phoenix-host.net/server-only', operator: 'Exists', effect: 'NoSchedule' },
          ],
          containers: [{
            name: 'pitr',
            image: inputs.image,
            // Always pull — the image tag is mutable so a stale
            // node-cached image can drift from what platform-api is
            // actually running. Forcing a pull guarantees we get the
            // current registry state for the resolved tag.
            imagePullPolicy: 'Always',
            command: ['node', 'dist/cli/pitr-job.js'],
            env,
            resources: {
              requests: { cpu: '50m', memory: '128Mi' },
              limits:   { cpu: '500m', memory: '512Mi' },
            },
          }],
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: jobNamespace, body });

  return { jobName, namespace: jobNamespace };
}

/** Resolve the platform-api container image (same image holds the
 * pitr-job CLI). Reads it from the live platform-api Deployment so
 * the Job always uses the same build the API just ran. */
export async function getPlatformApiImage(k8s: K8sClients): Promise<string> {
  const deploy = await (k8s.apps as unknown as {
    readNamespacedDeployment: (a: { namespace: string; name: string }) => Promise<{ spec?: { template?: { spec?: { containers?: ReadonlyArray<{ name?: string; image?: string }> } } } }>;
  }).readNamespacedDeployment({ namespace: 'platform', name: 'platform-api' });
  const containers = deploy.spec?.template?.spec?.containers ?? [];
  const apiContainer = containers.find((c) => c.name === 'api') ?? containers[0];
  if (!apiContainer?.image) throw new Error('platform-api Deployment has no api container image');
  return apiContainer.image;
}
