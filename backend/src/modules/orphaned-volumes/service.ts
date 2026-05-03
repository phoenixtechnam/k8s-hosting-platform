import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients } from '../../db/schema.js';

/**
 * Reasons a Persistent Volume / Longhorn volume is classified as orphaned.
 * Each enum value maps to a UI badge + a defensible deletion rationale.
 *
 *  - namespace_deleted     The PV's claimRef.namespace no longer exists.
 *                          Either the namespace was hand-deleted (test
 *                          cleanup, manual `kubectl delete ns ...`) or
 *                          the lifecycle deprovision step left a Released
 *                          PV behind because the operator deleted the ns
 *                          before the cascade ran.
 *
 *  - client_record_deleted The namespace looks like a tenant
 *                          (`client-*`) but no row exists in the platform
 *                          `clients` table — the client was deleted from
 *                          the admin panel but its PV survived because
 *                          reclaimPolicy=Retain.
 *
 *  - pv_released_stale     Phase=Released for longer than the configured
 *                          stale threshold (default 7 days). Catches PVs
 *                          where the PVC was cleaned up properly but the
 *                          Retain policy left the volume behind and no
 *                          operator restored from it within the grace
 *                          period.
 *
 *  - longhorn_volume_unbound  A Longhorn volume CR exists but no PV
 *                          references it (PV deleted / never created /
 *                          orphaned by a failed provisioning).
 *
 *  - namespace_orphaned    A `client-*` namespace still exists with no
 *                          matching client row in the platform DB and no
 *                          PV that already triggered a more specific
 *                          reason. Typically a deprovision left the
 *                          namespace stranded after volumes were already
 *                          cleaned up, or admin DELETE finished without
 *                          the cascade running.
 */
export type OrphanReason =
  | 'namespace_deleted'
  | 'client_record_deleted'
  | 'pv_released_stale'
  | 'longhorn_volume_unbound'
  | 'namespace_orphaned';

export interface OrphanedVolumeEntry {
  readonly pvName: string | null;
  /**
   * Longhorn volume name when the PV is backed by a Longhorn CR. Null
   * when the PV uses a different provisioner or has no backing volume —
   * snapshot/delete-via-Longhorn paths must check for null and skip.
   */
  readonly longhornVolumeName: string | null;
  readonly namespace: string | null;
  readonly pvcName: string | null;
  readonly sizeBytes: number;
  readonly nodes: readonly string[];
  readonly reason: OrphanReason;
  readonly ageDays: number | null;
  readonly ownerLabel: string;
}

export interface OrphanedVolumesReport {
  readonly orphans: readonly OrphanedVolumeEntry[];
  readonly totalCount: number;
  readonly totalBytes: number;
  readonly stalePvThresholdDays: number;
}

const DEFAULT_STALE_PV_DAYS = 7;

interface RawPv {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly claimRef?: { readonly namespace?: string; readonly name?: string };
    readonly capacity?: { readonly storage?: string };
    readonly persistentVolumeReclaimPolicy?: string;
    readonly storageClassName?: string;
  };
  readonly status?: {
    readonly phase?: string;
    readonly lastTransitionTime?: string;
  };
}

interface RawLhVolume {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly size?: string; readonly numberOfReplicas?: number };
  readonly status?: {
    readonly kubernetesStatus?: { readonly pvName?: string; readonly namespace?: string; readonly pvcName?: string };
  };
}

interface RawLhReplica {
  readonly spec?: { readonly volumeName?: string; readonly nodeID?: string };
  readonly status?: { readonly currentState?: string };
}

interface RawNamespace {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
  };
  readonly status?: { readonly phase?: string };
}

/** Parse the K8s `<n>Gi` quantity strings Longhorn returns. */
function parseQuantityBytes(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] ?? '';
  const mul: Record<string, number> = {
    '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return Math.round(num * (mul[unit] ?? 1));
}

function ageDaysFromIso(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86400_000));
}

/**
 * Detect orphaned Longhorn volumes / Persistent Volumes cluster-wide.
 *
 * Joins three K8s sources:
 *   1. PersistentVolumes (cluster-wide)
 *   2. Namespaces (existence check)
 *   3. Longhorn volumes + replicas (size + node placement)
 *
 * Plus the platform `clients` table to distinguish tenant orphans from
 * platform-system orphans.
 */
export async function detectOrphans(
  db: Database,
  k8s: K8sClients,
  options: { readonly stalePvThresholdDays?: number } = {},
): Promise<OrphanedVolumesReport> {
  const stalePvThresholdDays = options.stalePvThresholdDays ?? DEFAULT_STALE_PV_DAYS;

  // 1) Pull all data sources in parallel.
  const [pvList, nsList, volList, replicaList, clientRows] = await Promise.all([
    k8s.core.listPersistentVolume({}) as Promise<{ items?: readonly RawPv[] }>,
    k8s.core.listNamespace({}) as Promise<{ items?: readonly RawNamespace[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhVolume[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'replicas',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]).catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhReplica[] }>,
    db.select({ ns: clients.kubernetesNamespace, name: clients.companyName }).from(clients),
  ]);

  // 2) Index lookup tables.
  const namespacesAlive = new Set<string>();
  // Track namespace metadata for the namespace-orphan pass below. A
  // namespace is "alive" once it has a name; we still log it even if its
  // status.phase is Terminating because Terminating namespaces still
  // count against quotas + still hold finalised resources.
  const namespaceMeta = new Map<string, RawNamespace>();
  for (const ns of nsList.items ?? []) {
    const name = ns.metadata?.name;
    if (!name) continue;
    namespacesAlive.add(name);
    namespaceMeta.set(name, ns);
  }
  const clientByNs = new Map<string, { name: string }>();
  for (const c of clientRows) {
    if (c.ns) clientByNs.set(c.ns, { name: c.name });
  }
  const replicaNodesByVolume = new Map<string, string[]>();
  for (const r of replicaList.items ?? []) {
    const v = r.spec?.volumeName;
    const n = r.spec?.nodeID;
    if (!v || !n) continue;
    if (r.status?.currentState !== 'running') continue;
    const arr = replicaNodesByVolume.get(v) ?? [];
    arr.push(n);
    replicaNodesByVolume.set(v, arr);
  }
  const lhVolByName = new Map<string, RawLhVolume>();
  const lhVolNamesByPv = new Map<string, string>(); // pvName → longhorn volume name
  for (const v of volList.items ?? []) {
    const volName = v.metadata?.name;
    if (!volName) continue;
    lhVolByName.set(volName, v);
    const pvName = v.status?.kubernetesStatus?.pvName;
    if (pvName) lhVolNamesByPv.set(pvName, volName);
  }
  const pvByName = new Map<string, RawPv>();
  for (const pv of pvList.items ?? []) {
    if (pv.metadata?.name) pvByName.set(pv.metadata.name, pv);
  }

  // 3) Walk PVs and classify each one.
  const orphans: OrphanedVolumeEntry[] = [];
  const seenLonghornVols = new Set<string>();

  for (const pv of pvList.items ?? []) {
    const pvName = pv.metadata?.name;
    if (!pvName) continue;
    const ns = pv.spec?.claimRef?.namespace ?? null;
    const pvcName = pv.spec?.claimRef?.name ?? null;
    const phase = pv.status?.phase ?? '';
    const lhVolName = lhVolNamesByPv.get(pvName);
    const lhVol = lhVolName ? lhVolByName.get(lhVolName) : undefined;
    const sizeBytes = parseQuantityBytes(pv.spec?.capacity?.storage)
      || parseQuantityBytes(lhVol?.spec?.size);
    const nodes = lhVolName ? (replicaNodesByVolume.get(lhVolName) ?? []) : [];
    const ageDays = ageDaysFromIso(pv.status?.lastTransitionTime);

    let reason: OrphanReason | null = null;

    if (ns && !namespacesAlive.has(ns)) {
      reason = 'namespace_deleted';
    } else if (ns && ns.startsWith('client-') && !clientByNs.has(ns)) {
      // Namespace exists but the client row was deleted — extremely rare
      // (lifecycle deletes the namespace too) but possible after a manual
      // DB row delete or a half-failed deprovision.
      reason = 'client_record_deleted';
    } else if (phase === 'Released'
      && ageDays !== null
      && ageDays >= stalePvThresholdDays) {
      reason = 'pv_released_stale';
    }

    if (reason && lhVolName) seenLonghornVols.add(lhVolName);
    if (!reason) continue;

    const owner = ns ? clientByNs.get(ns)?.name : undefined;
    const ownerLabel = owner ?? (ns ? `Platform System (${ns})` : 'Unknown');

    orphans.push({
      pvName,
      // Null when the PV has no Longhorn backing — caller must skip
      // Longhorn-targeted operations (snapshot, longhorn-volume delete).
      longhornVolumeName: lhVolName ?? null,
      namespace: ns,
      pvcName,
      sizeBytes,
      nodes,
      reason,
      ageDays,
      ownerLabel,
    });
  }

  // 4) Longhorn volumes with no matching PV.
  for (const v of volList.items ?? []) {
    const volName = v.metadata?.name;
    if (!volName || seenLonghornVols.has(volName)) continue;
    const rawPvName = v.status?.kubernetesStatus?.pvName ?? null;
    const pvName = rawPvName && rawPvName.length > 0 ? rawPvName : null;
    if (pvName && pvByName.has(pvName)) continue; // already reported above
    const rawNs = v.status?.kubernetesStatus?.namespace ?? null;
    const ns = rawNs && rawNs.length > 0 ? rawNs : null;
    const rawPvcName = v.status?.kubernetesStatus?.pvcName ?? null;
    const pvcName = rawPvcName && rawPvcName.length > 0 ? rawPvcName : null;
    const sizeBytes = parseQuantityBytes(v.spec?.size);
    const nodes = replicaNodesByVolume.get(volName) ?? [];
    const owner = ns ? clientByNs.get(ns)?.name : undefined;
    const ownerLabel = owner ?? (ns ? `Platform System (${ns})` : 'Unknown');
    orphans.push({
      pvName,
      longhornVolumeName: volName,
      namespace: ns,
      pvcName,
      sizeBytes,
      nodes,
      reason: 'longhorn_volume_unbound',
      ageDays: null,
      ownerLabel,
    });
  }

  // 5) Namespace orphans: tenant-shaped namespaces (`client-*`) with no
  // matching client row AND no PV that already triggered a row in pass 3.
  // Catches the case where deprovision deleted volumes/PVs but left the
  // namespace standing, or where an admin hand-deletes a client row but
  // not its namespace.
  //
  // De-dup against namespaces already represented above: if any orphan
  // entry already references this namespace, skip it — the operator can
  // delete the PV (or namespace via cluster tooling) from that row.
  const namespacesAlreadyReported = new Set<string>();
  for (const o of orphans) {
    if (o.namespace) namespacesAlreadyReported.add(o.namespace);
  }
  for (const [nsName, ns] of namespaceMeta) {
    if (!nsName.startsWith('client-')) continue;
    if (clientByNs.has(nsName)) continue;
    if (namespacesAlreadyReported.has(nsName)) continue;
    const created = ns.metadata?.creationTimestamp;
    const ageDays = ageDaysFromIso(created);
    orphans.push({
      pvName: null,
      longhornVolumeName: null,
      namespace: nsName,
      pvcName: null,
      sizeBytes: 0,
      nodes: [],
      reason: 'namespace_orphaned',
      ageDays,
      ownerLabel: `Platform System (${nsName})`,
    });
  }

  // Stable sort: largest first so the UI surfaces high-impact orphans
  // at the top of the list. Namespace-only orphans (sizeBytes=0) sink to
  // the bottom which matches operator priority — volumes first.
  orphans.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    orphans,
    totalCount: orphans.length,
    totalBytes: orphans.reduce((sum, o) => sum + o.sizeBytes, 0),
    stalePvThresholdDays,
  };
}

/**
 * Resolve an orphan entry by its action key (`longhornVolumeName` for the
 * Longhorn-backed case, `pvName` for the unbound case, `namespace` for the
 * `namespace_orphaned` case). Returns null when nothing matches — callers
 * MUST refuse to act on a missing entry. This is the server-side guard
 * that prevents an authenticated admin from snapshotting / deleting /
 * cascading an arbitrary live resource by guessing its name.
 */
export async function findOrphan(
  db: Database,
  k8s: K8sClients,
  key: {
    readonly volumeName?: string;
    readonly pvName?: string;
    readonly namespace?: string;
  },
): Promise<OrphanedVolumeEntry | null> {
  const report = await detectOrphans(db, k8s);
  for (const o of report.orphans) {
    if (key.volumeName && o.longhornVolumeName === key.volumeName) return o;
    if (key.pvName && o.pvName === key.pvName) return o;
    if (key.namespace
      && o.reason === 'namespace_orphaned'
      && o.namespace === key.namespace) return o;
  }
  return null;
}

/**
 * Take a Longhorn snapshot before delete so the operator has a recovery
 * point. Idempotent: returns the existing snapshot if one with the same
 * generated name already exists (rare in practice).
 */
export async function snapshotOrphan(
  k8s: K8sClients,
  longhornVolumeName: string,
): Promise<{ snapshotName: string }> {
  const snapshotName = `orphan-presnap-${Date.now()}-${longhornVolumeName.slice(0, 20)}`;
  await k8s.custom.createNamespacedCustomObject({
    group: 'longhorn.io', version: 'v1beta2',
    namespace: 'longhorn-system', plural: 'snapshots',
    body: {
      apiVersion: 'longhorn.io/v1beta2',
      kind: 'Snapshot',
      metadata: { name: snapshotName, namespace: 'longhorn-system' },
      spec: { volume: longhornVolumeName, createSnapshot: true },
    },
  } as unknown as Parameters<typeof k8s.custom.createNamespacedCustomObject>[0]);
  return { snapshotName };
}

/**
 * Cascade delete an orphan entry: PV → Longhorn Volume CR → Namespace.
 * The PV alone won't reclaim the Longhorn volume because reclaimPolicy=
 * Retain on every platform/system StorageClass. Pattern matches
 * deprovisionRunCleanup in k8s-provisioner/service.ts:803-820.
 *
 * For `namespace_orphaned` rows there is no PV / Longhorn volume — only
 * a namespace name to delete. The kube-apiserver's namespace cascade
 * reaps any remaining resources inside it.
 */
export async function deleteOrphan(
  k8s: K8sClients,
  target: {
    readonly pvName: string | null;
    readonly longhornVolumeName: string | null;
    readonly namespace?: string | null;
    readonly cascadeNamespace?: boolean;
  },
): Promise<{ deletedPv: boolean; deletedLonghornVolume: boolean; deletedNamespace: boolean }> {
  let deletedPv = false;
  let deletedLonghornVolume = false;
  let deletedNamespace = false;

  if (target.pvName) {
    try {
      await k8s.core.deletePersistentVolume({ name: target.pvName });
      deletedPv = true;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
  }

  if (target.longhornVolumeName) {
    try {
      await k8s.custom.deleteNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
        name: target.longhornVolumeName,
      } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
      deletedLonghornVolume = true;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
  }

  if (target.cascadeNamespace && target.namespace) {
    // Defense-in-depth: refuse to cascade anything that doesn't look
    // like a tenant namespace, even if a caller bypassed findOrphan.
    // detectOrphans already enforces this for the namespace_orphaned
    // pass, but a future code path that calls deleteOrphan directly
    // would otherwise be a footgun.
    if (!target.namespace.startsWith('client-')) {
      throw new Error(
        `BUG: refusing to cascade non-tenant namespace '${target.namespace}'`,
      );
    }
    try {
      await k8s.core.deleteNamespace({ name: target.namespace });
      deletedNamespace = true;
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
  }

  return { deletedPv, deletedLonghornVolume, deletedNamespace };
}

/**
 * Purge every currently-orphaned entry in one pass. Iterates the latest
 * scan, attempts the same cascade `deleteOrphan` would run for each row,
 * and aggregates per-row failures so the operator sees exactly which
 * entries didn't drain. Re-scanning after the call is the caller's job
 * (the modal already invalidates `['orphaned-volumes']` on success).
 */
export async function purgeAllOrphans(
  db: Database,
  k8s: K8sClients,
  options: { readonly stalePvThresholdDays?: number } = {},
): Promise<{
  attempted: number;
  deleted: number;
  bytesReclaimed: number;
  failures: Array<{ key: string; reason: OrphanReason; error: string }>;
}> {
  const report = await detectOrphans(db, k8s, options);
  let deleted = 0;
  let bytesReclaimed = 0;
  const failures: Array<{ key: string; reason: OrphanReason; error: string }> = [];

  for (const entry of report.orphans) {
    const key = entry.longhornVolumeName ?? entry.pvName ?? entry.namespace ?? '';
    if (!key) {
      failures.push({ key: '(unknown)', reason: entry.reason, error: 'orphan has no actionable key' });
      continue;
    }
    try {
      await deleteOrphan(k8s, {
        pvName: entry.pvName,
        longhornVolumeName: entry.longhornVolumeName,
        namespace: entry.namespace,
        cascadeNamespace: entry.reason === 'namespace_orphaned',
      });
      deleted++;
      bytesReclaimed += entry.sizeBytes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ key, reason: entry.reason, error: message });
    }
  }

  return {
    attempted: report.orphans.length,
    deleted,
    bytesReclaimed,
    failures,
  };
}

// Re-export for tests
export { eq };
