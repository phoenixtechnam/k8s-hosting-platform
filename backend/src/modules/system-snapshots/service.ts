import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

/**
 * Inventory of platform/system PVCs and their Longhorn snapshot state.
 *
 * "System" namespaces (platform/mail/longhorn-system/...) are platform-
 * managed, distinct from tenant client-* namespaces. Snapshots for those
 * client volumes are surfaced via the existing storage-lifecycle module.
 *
 * Each row carries:
 *  - the PVC name + namespace
 *  - the underlying Longhorn volume name
 *  - snapshot count + total bytes
 *  - currently-applied recurring-job retention (frequency + retain count)
 *
 * The Longhorn frequency for a volume is the union of all
 * recurring-jobs that apply to it via either `recurring-job.longhorn.io/<name>: enabled`
 * (direct) or `recurring-job-group.longhorn.io/<group>: enabled` (group).
 */

export const SYSTEM_NAMESPACES = Object.freeze([
  'platform',
  'platform-system',
  'mail',
  'longhorn-system',
  'cnpg-system',
  'monitoring',
] as const);

export type SnapshotTask = 'snapshot' | 'backup';

export interface SystemPvcSnapshotSummary {
  readonly namespace: string;
  readonly pvcName: string;
  readonly longhornVolumeName: string;
  readonly volumeSizeBytes: number;
  readonly snapshotCount: number;
  readonly snapshotBytesTotal: number;
  readonly oldestSnapshotAt: string | null;
  readonly newestSnapshotAt: string | null;
  /** Names of RecurringJobs currently applying to the volume. */
  readonly recurringJobs: readonly string[];
  /** True when status.robustness == 'degraded'. */
  readonly degraded: boolean;
  /**
   * CNPG cluster owner. Set from PVC label `cnpg.io/cluster=<name>`.
   * Frontend collapses every PVC with the same `{namespace, name}`
   * into one row keyed by cluster. Stalwart and other plain
   * StatefulSets carry null.
   */
  readonly cnpgCluster: { readonly namespace: string; readonly name: string } | null;
  /** Pod role per CNPG: 'primary', 'replica', or null when unknown. */
  readonly cnpgRole: 'primary' | 'replica' | null;
}

export interface SystemSnapshotEntry {
  readonly snapshotName: string;
  readonly volumeName: string;
  readonly createdAt: string | null;
  readonly sizeBytes: number;
  /** True when at least one replica reports the snapshot as present. */
  readonly usable: boolean;
  /** Optional human label set on creation; null for recurring snapshots. */
  readonly userLabel: string | null;
  /** Indicates whether the snapshot has been removed (marked for cleanup). */
  readonly markedForRemoval: boolean;
}

export interface RecurringJobPolicy {
  readonly jobName: string;
  readonly task: SnapshotTask;
  readonly cron: string;
  readonly retain: number;
  readonly groups: readonly string[];
}

interface RawPvc {
  readonly metadata?: { readonly name?: string; readonly namespace?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly volumeName?: string };
  readonly status?: { readonly capacity?: { readonly storage?: string | number } };
}

interface RawCnpgCluster {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly status?: { readonly currentPrimary?: string };
}

interface RawLhVolume {
  readonly metadata?: { readonly name?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly size?: string | number };
  readonly status?: {
    readonly kubernetesStatus?: { readonly pvName?: string; readonly namespace?: string; readonly pvcName?: string };
    readonly robustness?: string;
  };
}

interface RawLhSnapshot {
  readonly metadata?: { readonly name?: string; readonly creationTimestamp?: string; readonly labels?: Record<string, string> };
  readonly spec?: { readonly volume?: string };
  readonly status?: {
    readonly creationTime?: string;
    readonly size?: string | number;
    readonly readyToUse?: boolean;
    readonly markRemoved?: boolean;
    readonly userCreated?: boolean;
  };
}

interface RawLhRecurringJob {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly task?: string; readonly cron?: string; readonly retain?: number; readonly groups?: readonly string[] };
}

function parseQuantityBytes(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  // Longhorn sometimes returns sizes as raw numbers (e.g. snapshot.status.size)
  // and sometimes as quantity strings (e.g. pvc.status.capacity.storage = "10Gi").
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const s = String(value);
  if (!s) return 0;
  const m = s.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const mul: Record<string, number> = {
    '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return Math.round(num * (mul[unit] ?? 1));
}

const LH_GROUP = 'longhorn.io';
const LH_VERSION = 'v1beta2';
const LH_NS = 'longhorn-system';

/**
 * Determine which Longhorn RecurringJob names apply to a Longhorn volume,
 * by matching its labels against `recurring-job.longhorn.io/<name>` (direct)
 * or `recurring-job-group.longhorn.io/<group>` (group membership) and
 * resolving group → jobs through the RecurringJob.spec.groups field.
 */
function resolveRecurringJobsForVolume(
  volumeLabels: Record<string, string>,
  jobs: readonly RawLhRecurringJob[],
): readonly string[] {
  const direct = new Set<string>();
  const groups = new Set<string>();
  for (const [k, v] of Object.entries(volumeLabels ?? {})) {
    if (v !== 'enabled') continue;
    if (k.startsWith('recurring-job.longhorn.io/')) direct.add(k.split('/')[1]);
    else if (k.startsWith('recurring-job-group.longhorn.io/')) groups.add(k.split('/')[1]);
  }
  const applied = new Set<string>();
  for (const j of jobs) {
    const name = j.metadata?.name;
    if (!name) continue;
    if (direct.has(name)) {
      applied.add(name);
      continue;
    }
    for (const g of j.spec?.groups ?? []) {
      if (groups.has(g)) {
        applied.add(name);
        break;
      }
    }
  }
  return Array.from(applied).sort();
}

export async function listSystemPvcSnapshots(k8s: K8sClients): Promise<readonly SystemPvcSnapshotSummary[]> {
  // Fan out the K8s LIST calls in parallel — same pattern as the
  // orphan classifier. PVC list is per-namespace; volumes/snapshots/
  // recurring-jobs all live in longhorn-system. CNPG clusters are
  // listed cluster-wide for currentPrimary lookup.
  const [pvcResults, volResp, snapResp, jobResp, cnpgResp] = await Promise.all([
    Promise.all(SYSTEM_NAMESPACES.map((ns) =>
      k8s.core.listNamespacedPersistentVolumeClaim({ namespace: ns })
        .catch(() => ({ items: [] }))
        .then((r) => ({ ns, items: (r as { items?: readonly RawPvc[] }).items ?? [] })),
    )),
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhVolume[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhSnapshot[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhRecurringJob[] }>,
    k8s.custom.listClusterCustomObject({
      group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters',
    } as unknown as Parameters<typeof k8s.custom.listClusterCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawCnpgCluster[] }>,
  ]);

  // (namespace, cluster) → currentPrimary pod name
  const cnpgPrimary = new Map<string, string>();
  for (const c of cnpgResp.items ?? []) {
    const ns = c.metadata?.namespace; const name = c.metadata?.name;
    if (!ns || !name) continue;
    const primary = c.status?.currentPrimary;
    if (primary) cnpgPrimary.set(`${ns}/${name}`, primary);
  }

  const volByName = new Map<string, RawLhVolume>();
  for (const v of volResp.items ?? []) {
    if (v.metadata?.name) volByName.set(v.metadata.name, v);
  }
  const snapsByVolume = new Map<string, RawLhSnapshot[]>();
  for (const s of snapResp.items ?? []) {
    const v = s.spec?.volume;
    if (!v) continue;
    const arr = snapsByVolume.get(v) ?? [];
    arr.push(s);
    snapsByVolume.set(v, arr);
  }
  const jobs = jobResp.items ?? [];

  const result: SystemPvcSnapshotSummary[] = [];
  for (const { ns, items } of pvcResults) {
    for (const pvc of items) {
      const pvcName = pvc.metadata?.name ?? '';
      const volName = pvc.spec?.volumeName ?? '';
      if (!pvcName || !volName) continue;
      const vol = volByName.get(volName);
      const volSize = parseQuantityBytes(pvc.status?.capacity?.storage)
        || parseQuantityBytes(vol?.spec?.size);
      const volSnaps = snapsByVolume.get(volName) ?? [];
      const usable = volSnaps.filter((s) => !s.status?.markRemoved);
      const snapshotCount = usable.length;
      let snapshotBytesTotal = 0;
      let oldestSnap: string | null = null;
      let newestSnap: string | null = null;
      for (const s of usable) {
        snapshotBytesTotal += parseQuantityBytes(s.status?.size);
        const t = s.status?.creationTime ?? s.metadata?.creationTimestamp ?? null;
        if (t) {
          if (!oldestSnap || t < oldestSnap) oldestSnap = t;
          if (!newestSnap || t > newestSnap) newestSnap = t;
        }
      }
      const labels = vol?.metadata?.labels ?? pvc.metadata?.labels ?? {};
      const recurringJobs = resolveRecurringJobsForVolume(labels, jobs);
      const cnpgClusterName = pvc.metadata?.labels?.['cnpg.io/cluster'] ?? null;
      const cnpgCluster = cnpgClusterName ? { namespace: ns, name: cnpgClusterName } : null;
      let cnpgRole: 'primary' | 'replica' | null = null;
      if (cnpgCluster) {
        const primary = cnpgPrimary.get(`${ns}/${cnpgClusterName}`);
        // CNPG: one PVC per instance, named identically to the pod.
        // status.currentPrimary holds the primary pod name; PVC equality
        // against that name is the canonical role check.
        cnpgRole = primary && primary === pvcName ? 'primary' : 'replica';
      }
      result.push({
        namespace: ns,
        pvcName,
        longhornVolumeName: volName,
        volumeSizeBytes: volSize,
        snapshotCount,
        snapshotBytesTotal,
        oldestSnapshotAt: oldestSnap,
        newestSnapshotAt: newestSnap,
        recurringJobs,
        degraded: vol?.status?.robustness === 'degraded',
        cnpgCluster,
        cnpgRole,
      });
    }
  }
  result.sort((a, b) => b.snapshotBytesTotal - a.snapshotBytesTotal);
  return result;
}

export async function listSnapshotsForVolume(
  k8s: K8sClients,
  volumeName: string,
): Promise<readonly SystemSnapshotEntry[]> {
  const resp = await k8s.custom.listNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
  } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: readonly RawLhSnapshot[] };
  const out: SystemSnapshotEntry[] = [];
  for (const s of resp.items ?? []) {
    if (s.spec?.volume !== volumeName) continue;
    out.push({
      snapshotName: s.metadata?.name ?? '',
      volumeName,
      createdAt: s.status?.creationTime ?? s.metadata?.creationTimestamp ?? null,
      sizeBytes: parseQuantityBytes(s.status?.size),
      usable: s.status?.readyToUse === true,
      userLabel: s.metadata?.labels?.['platform.phoenix-host.net/user-label'] ?? null,
      markedForRemoval: s.status?.markRemoved === true,
    });
  }
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return out;
}

/**
 * Delete one Longhorn snapshot, asserting it belongs to `expectedVolume`
 * before issuing the destructive call. This prevents an admin from
 * deleting a tenant snapshot via the system-snapshots route by guessing
 * the snapshot name — every Longhorn snapshot CR shares the same
 * `longhorn-system` namespace regardless of which volume owns it.
 */
export async function deleteSnapshot(
  k8s: K8sClients,
  expectedVolume: string,
  snapshotName: string,
): Promise<void> {
  let snap: { spec?: { volume?: string } } | null = null;
  try {
    snap = await k8s.custom.getNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
      name: snapshotName,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { spec?: { volume?: string } };
  } catch (err) {
    const status = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) {
      const e = new Error(`Snapshot '${snapshotName}' not found`);
      (e as Error & { code?: number }).code = 404;
      throw e;
    }
    throw err;
  }
  if (snap.spec?.volume !== expectedVolume) {
    const e = new Error(`Snapshot '${snapshotName}' belongs to volume '${snap.spec?.volume}', not '${expectedVolume}'`);
    (e as Error & { code?: number }).code = 409;
    throw e;
  }
  await k8s.custom.deleteNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    name: snapshotName,
  } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
}

/**
 * Mass-prune: delete every snapshot for one volume EXCEPT the N most
 * recent (configurable; default 1 = keep most recent only). The keep
 * count avoids the user accidentally pruning to zero recovery points.
 *
 * Returns the list of deleted snapshot names.
 */
export async function pruneVolumeSnapshots(
  k8s: K8sClients,
  volumeName: string,
  keepNewest: number = 1,
): Promise<{ readonly deleted: readonly string[]; readonly kept: readonly string[] }> {
  const snaps = await listSnapshotsForVolume(k8s, volumeName);
  const sorted = [...snaps].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const kept = sorted.slice(0, Math.max(0, keepNewest)).map((s) => s.snapshotName);
  const toDelete = sorted.slice(Math.max(0, keepNewest));
  const deleted: string[] = [];
  for (const s of toDelete) {
    try {
      // listSnapshotsForVolume already filtered to volumeName, so the
      // ownership check inside deleteSnapshot is redundant here but
      // costs one extra GET — acceptable for a manual prune action.
      await deleteSnapshot(k8s, volumeName, s.snapshotName);
      deleted.push(s.snapshotName);
    } catch (err) {
      console.warn(`[system-snapshots] delete ${s.snapshotName} failed:`, (err as Error).message);
    }
  }
  return { deleted, kept };
}

export async function takeSnapshot(
  k8s: K8sClients,
  volumeName: string,
  userLabel: string | undefined,
): Promise<{ readonly snapshotName: string }> {
  const snapshotName = `manual-${Date.now()}-${volumeName.slice(0, 24)}`;
  const labels: Record<string, string> = {};
  if (userLabel && userLabel.length <= 63) {
    labels['platform.phoenix-host.net/user-label'] = userLabel.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 63);
  }
  await k8s.custom.createNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots',
    body: {
      apiVersion: `${LH_GROUP}/${LH_VERSION}`,
      kind: 'Snapshot',
      metadata: { name: snapshotName, namespace: LH_NS, labels },
      spec: { volume: volumeName, createSnapshot: true },
    },
  } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
  return { snapshotName };
}

// ─── Restore (in-place snapshot revert) ──────────────────────────────────────

const DEFAULT_LONGHORN_API_BASE = 'http://longhorn-backend.longhorn-system:9500';

interface ConsumerRef {
  readonly kind: 'CnpgCluster' | 'StatefulSet' | 'Deployment';
  readonly namespace: string;
  readonly name: string;
  readonly replicaField: 'instances' | 'replicas';
  readonly originalCount: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the workload that mounts pvcName so the restore orchestrator
 * can scale it to 0 and back. Order: CNPG (label) → StatefulSet
 * (PVC name pattern) → Deployment (pod owner walk).
 */
async function resolveConsumer(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<ConsumerRef | null> {
  type PvcShape = { metadata?: { labels?: Record<string, string> } };
  let pvc: PvcShape | null = null;
  try {
    pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ namespace, name: pvcName }) as PvcShape;
  } catch {
    return null;
  }
  const cnpgCluster = pvc?.metadata?.labels?.['cnpg.io/cluster'];
  if (cnpgCluster) {
    try {
      const cl = await k8s.custom.getNamespacedCustomObject({
        group: 'postgresql.cnpg.io', version: 'v1',
        namespace, plural: 'clusters', name: cnpgCluster,
      } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { spec?: { instances?: number } };
      const instances = cl.spec?.instances ?? 0;
      return { kind: 'CnpgCluster', namespace, name: cnpgCluster, replicaField: 'instances', originalCount: instances };
    } catch {
      return null;
    }
  }

  try {
    const stsList = await k8s.apps.listNamespacedStatefulSet({ namespace }) as { items?: ReadonlyArray<{
      metadata?: { name?: string };
      spec?: { replicas?: number; volumeClaimTemplates?: ReadonlyArray<{ metadata?: { name?: string } }> };
    }> };
    for (const sts of stsList.items ?? []) {
      const stsName = sts.metadata?.name;
      if (!stsName) continue;
      for (const vct of sts.spec?.volumeClaimTemplates ?? []) {
        const vctName = vct.metadata?.name;
        if (!vctName) continue;
        // PVC name pattern is `<vctName>-<stsName>-<ordinal>`. Escape
        // each segment so weird (but valid) chart names with regex
        // metacharacters can't construct an arbitrary pattern.
        const re = new RegExp(`^${escapeRegex(vctName)}-${escapeRegex(stsName)}-\\d+$`);
        if (re.test(pvcName)) {
          return { kind: 'StatefulSet', namespace, name: stsName, replicaField: 'replicas', originalCount: sts.spec?.replicas ?? 1 };
        }
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const pods = await k8s.core.listNamespacedPod({ namespace }) as { items?: ReadonlyArray<{
      metadata?: { ownerReferences?: ReadonlyArray<{ kind?: string; name?: string }> };
      spec?: { volumes?: ReadonlyArray<{ persistentVolumeClaim?: { claimName?: string } }> };
    }> };
    for (const p of pods.items ?? []) {
      if (!p.spec?.volumes?.some((v) => v.persistentVolumeClaim?.claimName === pvcName)) continue;
      const owner = p.metadata?.ownerReferences?.[0];
      if (owner?.kind === 'ReplicaSet' && owner.name) {
        const rs = await k8s.apps.readNamespacedReplicaSet({ namespace, name: owner.name }) as { metadata?: { ownerReferences?: ReadonlyArray<{ kind?: string; name?: string }> } };
        const rsOwner = rs.metadata?.ownerReferences?.[0];
        if (rsOwner?.kind === 'Deployment' && rsOwner.name) {
          const dep = await k8s.apps.readNamespacedDeployment({ namespace, name: rsOwner.name }) as { spec?: { replicas?: number } };
          return { kind: 'Deployment', namespace, name: rsOwner.name, replicaField: 'replicas', originalCount: dep.spec?.replicas ?? 1 };
        }
      }
    }
  } catch {
    /* give up */
  }
  return null;
}

async function scaleConsumer(k8s: K8sClients, c: ConsumerRef, count: number): Promise<void> {
  if (c.kind === 'CnpgCluster') {
    await (k8s.custom as unknown as {
      patchNamespacedCustomObject: (a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown }, mw: typeof MERGE_PATCH) => Promise<unknown>;
    }).patchNamespacedCustomObject(
      { group: 'postgresql.cnpg.io', version: 'v1', namespace: c.namespace, plural: 'clusters', name: c.name, body: { spec: { instances: count } } },
      MERGE_PATCH,
    );
  } else if (c.kind === 'StatefulSet') {
    await (k8s.apps as unknown as {
      patchNamespacedStatefulSetScale: (a: { namespace: string; name: string; body: unknown }, mw: typeof MERGE_PATCH) => Promise<unknown>;
    }).patchNamespacedStatefulSetScale(
      { namespace: c.namespace, name: c.name, body: { spec: { replicas: count } } },
      MERGE_PATCH,
    );
  } else {
    await (k8s.apps as unknown as {
      patchNamespacedDeploymentScale: (a: { namespace: string; name: string; body: unknown }, mw: typeof MERGE_PATCH) => Promise<unknown>;
    }).patchNamespacedDeploymentScale(
      { namespace: c.namespace, name: c.name, body: { spec: { replicas: count } } },
      MERGE_PATCH,
    );
  }
}

async function pollVolumeState(
  k8s: K8sClients,
  volumeName: string,
  expected: 'detached' | 'attached',
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly state: string | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    try {
      const v = await k8s.custom.getNamespacedCustomObject({
        group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'volumes', name: volumeName,
      } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { status?: { state?: string } };
      last = v.status?.state;
      if (last === expected) return { ok: true, state: last };
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { ok: false, state: last };
}

export interface RevertOpts {
  readonly apiBase?: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly detachTimeoutMs?: number;
  readonly revertTimeoutMs?: number;
  readonly attachTimeoutMs?: number;
}

export interface RevertResult {
  readonly volumeName: string;
  readonly snapshotName: string;
  readonly consumer: ConsumerRef;
  readonly steps: ReadonlyArray<{ readonly step: string; readonly ok: boolean; readonly detail?: string }>;
}

/**
 * Full snapshot-revert lifecycle:
 *   1. Resolve consumer (CNPG / StatefulSet / Deployment)
 *   2. Scale to 0; wait for Longhorn volume to detach (90s)
 *   3. POST /v1/volumes/<vol>?action=snapshotRevert via longhorn-backend
 *   4. Scale back to original count; wait for reattach (120s)
 * On any step failure we try to scale back to original to avoid
 * leaving the workload at 0 replicas.
 */
export async function revertSnapshot(
  k8s: K8sClients,
  pvcNamespace: string,
  pvcName: string,
  volumeName: string,
  snapshotName: string,
  opts: RevertOpts = {},
): Promise<RevertResult> {
  const apiBase = opts.apiBase ?? process.env.LONGHORN_API_BASE ?? DEFAULT_LONGHORN_API_BASE;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const detachTimeoutMs = opts.detachTimeoutMs ?? 90_000;
  const revertTimeoutMs = opts.revertTimeoutMs ?? 60_000;
  const attachTimeoutMs = opts.attachTimeoutMs ?? 120_000;
  const steps: { step: string; ok: boolean; detail?: string }[] = [];

  type SnapShape = { spec?: { volume?: string }; status?: { readyToUse?: boolean } };
  let snap: SnapShape | null = null;
  try {
    snap = await k8s.custom.getNamespacedCustomObject({
      group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'snapshots', name: snapshotName,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as SnapShape;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      const e = new Error(`Snapshot '${snapshotName}' not found`);
      (e as Error & { code?: number }).code = 404; throw e;
    }
    throw err;
  }
  if (snap?.spec?.volume !== volumeName) {
    const e = new Error(`Snapshot '${snapshotName}' does not belong to volume '${volumeName}'`);
    (e as Error & { code?: number }).code = 409; throw e;
  }
  if (snap.status?.readyToUse !== true) {
    const e = new Error(`Snapshot '${snapshotName}' is not ready to use`);
    (e as Error & { code?: number }).code = 409; throw e;
  }

  const consumer = await resolveConsumer(k8s, pvcNamespace, pvcName);
  if (!consumer) {
    const e = new Error(`Cannot resolve workload mounting ${pvcNamespace}/${pvcName} — manual restore required`);
    (e as Error & { code?: number }).code = 422; throw e;
  }
  // CNPG validates spec.instances >= 1, so the orchestrator can't scale
  // the cluster to 0 to detach the primary's PVC. CNPG has its own
  // restore path (barman-cloud PITR / `kubectl cnpg restore`) that
  // operates at the WAL layer instead of block-level snapshot revert.
  // Refuse here with a clear remediation rather than fail mid-flight
  // with the admission-webhook error.
  if (consumer.kind === 'CnpgCluster') {
    const e = new Error(
      `In-place snapshot revert is not supported for CNPG-managed PVCs. `
      + `CNPG validates spec.instances >= 1 so the primary's PVC cannot be detached. `
      + `Use CNPG barman-cloud PITR or kubectl cnpg restore — see `
      + `https://cloudnative-pg.io/documentation/current/recovery/.`,
    );
    (e as Error & { code?: number }).code = 422; throw e;
  }
  steps.push({ step: 'resolve-consumer', ok: true, detail: `${consumer.kind}/${consumer.name} (count=${consumer.originalCount})` });

  let restored = false;
  try {
    await scaleConsumer(k8s, consumer, 0);
    steps.push({ step: 'scale-down', ok: true });

    const detach = await pollVolumeState(k8s, volumeName, 'detached', detachTimeoutMs);
    steps.push({ step: 'wait-detach', ok: detach.ok, detail: `final=${detach.state ?? 'unknown'}` });
    if (!detach.ok) throw new Error(`Volume did not detach within ${detachTimeoutMs / 1000}s (last=${detach.state ?? 'unknown'})`);

    const url = `${apiBase.replace(/\/$/, '')}/v1/volumes/${encodeURIComponent(volumeName)}?action=snapshotRevert`;
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: snapshotName }),
      signal: AbortSignal.timeout(revertTimeoutMs),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<no body>');
      throw new Error(`Longhorn snapshotRevert failed: HTTP ${resp.status} ${body.slice(0, 240)}`);
    }
    steps.push({ step: 'longhorn-revert', ok: true });

    await scaleConsumer(k8s, consumer, consumer.originalCount);
    restored = true;
    steps.push({ step: 'scale-up', ok: true, detail: `to=${consumer.originalCount}` });

    const attach = await pollVolumeState(k8s, volumeName, 'attached', attachTimeoutMs);
    steps.push({ step: 'wait-attach', ok: attach.ok, detail: `final=${attach.state ?? 'unknown'}` });
    if (!attach.ok) throw new Error(`Volume did not reattach within ${attachTimeoutMs / 1000}s (last=${attach.state ?? 'unknown'})`);

    return { volumeName, snapshotName, consumer, steps };
  } catch (err) {
    if (!restored) {
      try {
        await scaleConsumer(k8s, consumer, consumer.originalCount);
        steps.push({ step: 'recovery-scale-up', ok: true, detail: `to=${consumer.originalCount}` });
      } catch (e2) {
        steps.push({ step: 'recovery-scale-up', ok: false, detail: (e2 as Error).message });
      }
    }
    const e = err instanceof Error ? err : new Error(String(err));
    (e as Error & { steps?: typeof steps }).steps = steps;
    throw e;
  }
}

// ─── Recurring job retention policy ──────────────────────────────────

export async function listRecurringJobs(k8s: K8sClients): Promise<readonly RecurringJobPolicy[]> {
  const resp = await k8s.custom.listNamespacedCustomObject({
    group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs',
  } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: readonly RawLhRecurringJob[] };
  const out: RecurringJobPolicy[] = [];
  for (const j of resp.items ?? []) {
    const task = j.spec?.task === 'backup' ? 'backup' : 'snapshot';
    out.push({
      jobName: j.metadata?.name ?? '',
      task,
      cron: j.spec?.cron ?? '',
      retain: j.spec?.retain ?? 0,
      groups: j.spec?.groups ?? [],
    });
  }
  return out;
}

export async function patchRecurringJob(
  k8s: K8sClients,
  jobName: string,
  patch: { readonly cron?: string; readonly retain?: number },
): Promise<void> {
  const body: Record<string, unknown> = { spec: {} };
  if (patch.cron !== undefined) (body.spec as Record<string, unknown>).cron = patch.cron;
  if (patch.retain !== undefined) (body.spec as Record<string, unknown>).retain = patch.retain;
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (
      a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
      mw: typeof MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedCustomObject(
    { group: LH_GROUP, version: LH_VERSION, namespace: LH_NS, plural: 'recurringjobs', name: jobName, body },
    MERGE_PATCH,
  );
}
