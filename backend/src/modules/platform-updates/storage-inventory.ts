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
    readonly capacityBytes: number;
    readonly allocatedBytes: number;
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
  spec?: { allowScheduling?: boolean };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
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

export async function getStorageInventory(): Promise<StorageInventory> {
  const empty: StorageInventory = {
    available: false,
    message: 'Longhorn not reachable',
    nodes: { total: 0, ready: 0, schedulable: 0 },
    volumes: { total: 0, attached: 0, degraded: 0, capacityBytes: 0, allocatedBytes: 0 },
    backupTarget: { url: '', available: false, message: 'unknown' },
  };

  let clients: ReturnType<typeof createK8sClients>;
  try {
    clients = createK8sClients(process.env.KUBECONFIG_PATH);
  } catch (err) {
    return { ...empty, message: err instanceof Error ? err.message : 'k8s client unavailable' };
  }

  try {
    const [nodesResp, volumesResp, targetResp] = await Promise.allSettled([
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
    ]);

    const nodes = nodesResp.status === 'fulfilled'
      ? summariseNodes((nodesResp.value as LonghornListResponse<LonghornNode>).items ?? [])
      : empty.nodes;

    const volumes = volumesResp.status === 'fulfilled'
      ? summariseVolumes((volumesResp.value as LonghornListResponse<LonghornVolume>).items ?? [])
      : empty.volumes;

    const backupTarget = targetResp.status === 'fulfilled'
      ? summariseBackupTarget(targetResp.value as LonghornBackupTarget)
      : empty.backupTarget;

    return {
      available: true,
      nodes,
      volumes,
      backupTarget,
    };
  } catch (err) {
    return { ...empty, message: err instanceof Error ? err.message : 'k8s API failed' };
  }
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
