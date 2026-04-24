import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { upsertNodeFromK8s, NODE_ROLE_LABEL, HOST_CLIENT_WORKLOADS_LABEL, type ObservedNode } from './service.js';
import type { NodeRole } from '@k8s-hosting/api-contracts';

/**
 * Pull every Node from the API server, project it into the ObservedNode
 * shape expected by the service, and upsert into cluster_nodes.
 *
 * The reconciler treats the k8s label as the source of truth for
 * `role` + `canHostClientWorkloads`. A missing label defaults to
 * worker/true — matching the migration default and the legacy
 * pre-M1 behavior (every node hosted everything).
 */
export async function syncNodesOnce(db: Database, k8s: K8sClients): Promise<number> {
  const res = await k8s.core.listNode();
  const items = res.items ?? [];
  for (const node of items) {
    const observed = projectNode(node);
    await upsertNodeFromK8s(db, observed);
  }
  return items.length;
}

interface K8sNode {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  status?: {
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
    };
    addresses?: Array<{ type?: string; address?: string }>;
    allocatable?: Record<string, string>;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
  spec?: {
    taints?: Array<{ key?: string; value?: string; effect?: string }>;
  };
}

export function projectNode(node: K8sNode): ObservedNode {
  const name = node.metadata?.name ?? '<unknown>';
  const labels = node.metadata?.labels ?? {};

  const roleLabel = labels[NODE_ROLE_LABEL];
  const role: NodeRole = roleLabel === 'server' ? 'server' : 'worker';

  // Absent label → default matches migration: workers true, servers false.
  const hostLabelRaw = labels[HOST_CLIENT_WORKLOADS_LABEL];
  const canHostClientWorkloads = hostLabelRaw === undefined
    ? (role === 'worker')
    : hostLabelRaw === 'true';

  const addresses = node.status?.addresses ?? [];
  const publicIp = addresses.find((a) => a.type === 'ExternalIP')?.address
    ?? addresses.find((a) => a.type === 'InternalIP')?.address
    ?? null;

  const kubeletVersion = node.status?.nodeInfo?.kubeletVersion ?? null;

  // k3s version lives in osImage ("K3s v1.31.4+k3s1") — regex out the
  // k3s-specific suffix so we can track minor drift across nodes.
  const osImage = node.status?.nodeInfo?.osImage ?? '';
  const k3sMatch = /K3s (v\d+\.\d+\.\d+\+k3s\d+)/.exec(osImage);
  const k3sVersion = k3sMatch ? k3sMatch[1] : null;

  const allocatable = node.status?.allocatable ?? {};
  const cpuMillicores = parseCpuMillicores(allocatable.cpu);
  const memoryBytes = parseMemoryBytes(allocatable.memory);
  const storageBytes = parseMemoryBytes(allocatable['ephemeral-storage']);

  const conditions = (node.status?.conditions ?? []).map((c) => ({
    type: c.type ?? '',
    status: c.status ?? '',
    reason: c.reason,
    message: c.message,
  }));

  const taints = (node.spec?.taints ?? []).map((t) => ({
    key: t.key ?? '',
    value: t.value,
    effect: t.effect ?? '',
  }));

  return {
    name,
    role,
    canHostClientWorkloads,
    publicIp,
    kubeletVersion,
    k3sVersion,
    cpuMillicores,
    memoryBytes,
    storageBytes,
    statusConditions: conditions,
    labels,
    taints,
  };
}

/**
 * k8s CPU strings come in two flavors: plain cores ("4") and millicore
 * suffix ("3500m"). Convert both to millicores; return null if we
 * can't parse (unexpected kubelet format, don't guess).
 */
export function parseCpuMillicores(raw: string | undefined): number | null {
  if (!raw) return null;
  if (raw.endsWith('m')) {
    const n = Number(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

/**
 * k8s memory/storage strings use binary SI suffixes (Ki/Mi/Gi/Ti) or
 * decimal (K/M/G/T) or plain bytes. Convert to bytes.
 */
export function parseMemoryBytes(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d+)(\w*)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2];
  const multipliers: Record<string, number> = {
    '': 1,
    K: 1000, Ki: 1024,
    M: 1000 ** 2, Mi: 1024 ** 2,
    G: 1000 ** 3, Gi: 1024 ** 3,
    T: 1000 ** 4, Ti: 1024 ** 4,
    P: 1000 ** 5, Pi: 1024 ** 5,
  };
  const mult = multipliers[suffix];
  return mult === undefined ? null : n * mult;
}
