/**
 * Summarise the cluster storage posture for the Admin Panel's Storage
 * Configuration page. Reads Longhorn nodes, volumes, and backup-target
 * state via the k8s API. Returns aggregate counts + health — the
 * operator sees the dashboard-worthy numbers without opening the
 * Longhorn UI.
 *
 * Falls back to an "unavailable" response if Longhorn isn't installed
 * or the k8s API can't be reached, so the UI still renders the card
 * with a clear status instead of erroring out.
 */

import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { detectOrphans } from '../orphaned-volumes/service.js';
import type { Database } from '../../db/index.js';

const LONGHORN_GROUP = 'longhorn.io';
const LONGHORN_VERSION = 'v1beta2';
const LONGHORN_NS = 'longhorn-system';

export interface StorageInventory {
  readonly available: boolean;
  readonly message?: string;
  readonly nodes: {
    readonly total: number;
    readonly ready: number;
    readonly schedulable: number;
  };
  readonly volumes: {
    readonly total: number;
    readonly attached: number;
    readonly degraded: number;
    /** Sum of every volume's spec.size — logical capacity. Includes
     * orphans / detached volumes still pinning Longhorn replicas. */
    readonly capacityBytes: number;
    /** Sum of every volume's status.actualSize — bytes actually written
     * to disk. ALWAYS smaller than what Longhorn's scheduler reserves. */
    readonly allocatedBytes: number;
  };
  /**
   * Cluster-wide capacity from Longhorn's scheduler perspective. This
   * is the source of truth for "is there room to provision a new
   * volume" — the older `volumes.allocatedBytes` (actual bytes written)
   * is misleading because Longhorn reserves the FULL volume size as
   * `scheduledBytes` when a replica is created, regardless of how
   * much data is actually in it. The 5 GB-allocated vs 220 GB-scheduled
   * discrepancy on 2026-05-04 staging was exactly this confusion.
   *
   * Each field is a sum across all schedulable disks on every Longhorn
   * node (workers AND servers — UI may further split by node-role).
   */
  readonly scheduler: {
    /** Sum of disk.storageMaximum minus operator-set storageReserved. */
    readonly capacityBytes: number;
    /** What Longhorn has reserved for live replicas (incl. orphan / detached). */
    readonly scheduledBytes: number;
    /** capacityBytes - scheduledBytes. New replicas can fit if their
     * size is ≤ this (and at least one node has the space contiguously). */
    readonly freeToScheduleBytes: number;
    /** scheduledBytes / capacityBytes as a percentage 0..100. */
    readonly commitPct: number;
  };
  /**
   * Orphaned volume summary — surfaces the count + total bytes that would
   * be freed if every orphan were deleted. Drives the "Orphaned" tile on
   * the Storage Inventory card. Falls back to {count:0, totalBytes:0} when
   * the orphan classifier fails (e.g. Longhorn unreachable) so the rest of
   * the inventory still renders.
   */
  readonly orphaned: {
    readonly count: number;
    readonly totalBytes: number;
  };
  readonly backupTarget: {
    readonly url: string;
    readonly available: boolean;
    readonly message: string;
  };
}

interface LonghornListResponse<T> {
  items?: T[];
}

interface LonghornNode {
  metadata?: { name?: string };
  spec?: {
    allowScheduling?: boolean;
    disks?: Record<string, { allowScheduling?: boolean; storageReserved?: number }>;
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
    diskStatus?: Record<string, { storageAvailable?: number; storageMaximum?: number; storageScheduled?: number }>;
  };
}

interface LonghornVolume {
  spec?: { size?: string };
  status?: {
    actualSize?: string;
    state?: string;
    robustness?: string;
  };
}

interface LonghornBackupTarget {
  spec?: { backupTargetURL?: string };
  status?: {
    available?: boolean;
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
  };
}

export async function getStorageInventory(db?: Database): Promise<StorageInventory> {
  const empty: StorageInventory = {
    available: false,
    message: 'Longhorn not reachable',
    nodes: { total: 0, ready: 0, schedulable: 0 },
    volumes: { total: 0, attached: 0, degraded: 0, capacityBytes: 0, allocatedBytes: 0 },
    scheduler: { capacityBytes: 0, scheduledBytes: 0, freeToScheduleBytes: 0, commitPct: 0 },
    orphaned: { count: 0, totalBytes: 0 },
    backupTarget: { url: '', available: false, message: 'unknown' },
  };

  let clients: ReturnType<typeof createK8sClients>;
  try {
    clients = createK8sClients(process.env.KUBECONFIG_PATH);
  } catch (err) {
    return { ...empty, message: err instanceof Error ? err.message : 'k8s client unavailable' };
  }

  try {
    const [nodesResp, volumesResp, targetResp, orphansResp] = await Promise.allSettled([
      clients.custom.listNamespacedCustomObject({
        group: LONGHORN_GROUP,
        version: LONGHORN_VERSION,
        namespace: LONGHORN_NS,
        plural: 'nodes',
      } as Parameters<typeof clients.custom.listNamespacedCustomObject>[0]),
      clients.custom.listNamespacedCustomObject({
        group: LONGHORN_GROUP,
        version: LONGHORN_VERSION,
        namespace: LONGHORN_NS,
        plural: 'volumes',
      } as Parameters<typeof clients.custom.listNamespacedCustomObject>[0]),
      clients.custom.getNamespacedCustomObject({
        group: LONGHORN_GROUP,
        version: LONGHORN_VERSION,
        namespace: LONGHORN_NS,
        plural: 'backuptargets',
        name: 'default',
      } as Parameters<typeof clients.custom.getNamespacedCustomObject>[0]),
      // Orphan classifier needs db for client-row lookup; skip when caller
      // didn't pass it (older code paths). Result tile shows 0/0 in that
      // case rather than failing the whole inventory.
      db ? detectOrphans(db, clients) : Promise.resolve(null),
    ]);

    const nodeItems = nodesResp.status === 'fulfilled'
      ? (nodesResp.value as LonghornListResponse<LonghornNode>).items ?? []
      : [];
    const nodes = summariseNodes(nodeItems);
    const scheduler = summariseScheduler(nodeItems);

    const volumes = volumesResp.status === 'fulfilled'
      ? summariseVolumes((volumesResp.value as LonghornListResponse<LonghornVolume>).items ?? [])
      : empty.volumes;

    const backupTarget = targetResp.status === 'fulfilled'
      ? summariseBackupTarget(targetResp.value as LonghornBackupTarget)
      : empty.backupTarget;

    const orphaned = orphansResp.status === 'fulfilled' && orphansResp.value
      ? { count: orphansResp.value.totalCount, totalBytes: orphansResp.value.totalBytes }
      : empty.orphaned;

    return {
      available: true,
      nodes,
      volumes,
      scheduler,
      orphaned,
      backupTarget,
    };
  } catch (err) {
    return { ...empty, message: err instanceof Error ? err.message : 'k8s API failed' };
  }
}

function summariseScheduler(items: LonghornNode[]): StorageInventory['scheduler'] {
  let capacityBytes = 0;
  let scheduledBytes = 0;
  for (const n of items) {
    if (n.spec?.allowScheduling === false) continue;
    for (const [diskKey, diskSpec] of Object.entries(n.spec?.disks ?? {})) {
      if (diskSpec.allowScheduling === false) continue;
      const stat = n.status?.diskStatus?.[diskKey] ?? {};
      const max = stat.storageMaximum ?? 0;
      const sched = stat.storageScheduled ?? 0;
      const reserved = diskSpec.storageReserved ?? 0;
      // Effective capacity = total disk minus operator reserve. Each
      // node's "available for new replicas" budget is this minus the
      // already-scheduled bytes; sum across nodes for the cluster view.
      capacityBytes += Math.max(0, max - reserved);
      scheduledBytes += sched;
    }
  }
  const freeToScheduleBytes = Math.max(0, capacityBytes - scheduledBytes);
  const commitPct = capacityBytes > 0 ? Math.round((scheduledBytes / capacityBytes) * 1000) / 10 : 0;
  return { capacityBytes, scheduledBytes, freeToScheduleBytes, commitPct };
}

function summariseNodes(items: LonghornNode[]): StorageInventory['nodes'] {
  let ready = 0;
  let schedulable = 0;
  for (const n of items) {
    // A Longhorn node is "Ready" when its "Ready" condition is "True".
    const condReady = n.status?.conditions?.find(c => c.type === 'Ready');
    if (condReady?.status === 'True') ready++;
    if (n.spec?.allowScheduling === true) schedulable++;
  }
  return { total: items.length, ready, schedulable };
}

function summariseVolumes(items: LonghornVolume[]): StorageInventory['volumes'] {
  let attached = 0;
  let degraded = 0;
  let capacityBytes = 0;
  let allocatedBytes = 0;
  for (const v of items) {
    if (v.status?.state === 'attached') attached++;
    if (v.status?.robustness === 'degraded') degraded++;
    capacityBytes += parseBytes(v.spec?.size);
    allocatedBytes += parseBytes(v.status?.actualSize);
  }
  return { total: items.length, attached, degraded, capacityBytes, allocatedBytes };
}

function summariseBackupTarget(target: LonghornBackupTarget): StorageInventory['backupTarget'] {
  const url = target.spec?.backupTargetURL ?? '';
  const available = target.status?.available === true;
  const unavailableCondition = target.status?.conditions?.find(c => c.type === 'Unavailable' && c.status === 'True');
  const message = available
    ? 'available'
    : (unavailableCondition?.message ?? (url ? 'not yet ready' : 'no backup target configured'));
  return { url, available, message };
}

function parseBytes(raw: string | undefined): number {
  if (!raw) return 0;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : 0;
}
