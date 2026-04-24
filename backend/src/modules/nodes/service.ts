import { eq, sql, desc } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clusterNodes, type ClusterNode } from '../../db/schema.js';
import type { NodeRole, UpdateClusterNodeInput } from '@k8s-hosting/api-contracts';
import { ApiError } from '../../shared/errors.js';

// M1: Platform namespaces whose pods block a server→worker demotion
// unless the caller passes `force: true`. Anything here running on the
// node we're about to demote would be evicted when the scheduler
// re-evaluates the new nodeAffinity rules, so we refuse by default.
// Keep this list in sync with the system-node-affinity Kustomize
// component (see k8s/components/system-node-affinity/).
export const SYSTEM_NAMESPACES = Object.freeze([
  'platform',
  'flux-system',
  'cert-manager',
  'ingress-nginx',
  'longhorn-system',
  'mail',
  'dex',
  'oauth2-proxy',
] as const);

export const NODE_ROLE_LABEL = 'platform.phoenix-host.net/node-role';
export const HOST_CLIENT_WORKLOADS_LABEL = 'platform.phoenix-host.net/host-client-workloads';
export const SERVER_ONLY_TAINT_KEY = 'platform.phoenix-host.net/server-only';

export async function listNodes(db: Database): Promise<ClusterNode[]> {
  return db.select().from(clusterNodes).orderBy(desc(clusterNodes.role), clusterNodes.name);
}

export async function getNode(db: Database, name: string): Promise<ClusterNode | null> {
  const [row] = await db.select().from(clusterNodes).where(eq(clusterNodes.name, name)).limit(1);
  return row ?? null;
}

export interface ObservedNode {
  name: string;
  role: NodeRole;
  canHostClientWorkloads: boolean;
  publicIp: string | null;
  kubeletVersion: string | null;
  k3sVersion: string | null;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  storageBytes: number | null;
  statusConditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  labels: Record<string, string>;
  taints: Array<{ key: string; value?: string; effect: string }>;
}

/**
 * Upsert an observation from the k8s-sync reconciler. The k8s label is
 * authoritative for role + canHostClientWorkloads — if an operator
 * `kubectl label`s a node by hand, the next sync tick reflects that
 * into the DB. The reconciler never writes labels on its own; PATCH
 * /api/v1/admin/nodes/:name does, via service.updateNode below.
 */
export async function upsertNodeFromK8s(db: Database, observed: ObservedNode): Promise<void> {
  await db.insert(clusterNodes).values({
    name: observed.name,
    role: observed.role,
    canHostClientWorkloads: observed.canHostClientWorkloads,
    publicIp: observed.publicIp,
    kubeletVersion: observed.kubeletVersion,
    k3sVersion: observed.k3sVersion,
    cpuMillicores: observed.cpuMillicores,
    memoryBytes: observed.memoryBytes,
    storageBytes: observed.storageBytes,
    statusConditions: observed.statusConditions,
    labels: observed.labels,
    taints: observed.taints,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: clusterNodes.name,
    set: {
      role: observed.role,
      canHostClientWorkloads: observed.canHostClientWorkloads,
      publicIp: observed.publicIp,
      kubeletVersion: observed.kubeletVersion,
      k3sVersion: observed.k3sVersion,
      cpuMillicores: observed.cpuMillicores,
      memoryBytes: observed.memoryBytes,
      storageBytes: observed.storageBytes,
      statusConditions: observed.statusConditions,
      labels: observed.labels,
      taints: observed.taints,
      lastSeenAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    },
  });
}

/**
 * Return the list of system pods currently scheduled on `nodeName`.
 * Used by updateNode to refuse a server→worker demotion that would
 * evict anything in SYSTEM_NAMESPACES.
 */
export async function listSystemPodsOnNode(k8s: K8sClients, nodeName: string): Promise<string[]> {
  const fieldSelector = `spec.nodeName=${nodeName},status.phase!=Succeeded,status.phase!=Failed`;
  const blockers: string[] = [];
  for (const ns of SYSTEM_NAMESPACES) {
    try {
      const res = await k8s.core.listNamespacedPod({ namespace: ns, fieldSelector });
      for (const pod of res.items) {
        blockers.push(`${ns}/${pod.metadata?.name ?? '<unknown>'}`);
      }
    } catch (err) {
      // Namespace missing in this cluster (e.g. dex in production) is
      // fine — keep scanning. Any other error bubbles so the PATCH
      // fails loud rather than silently allowing a risky demotion.
      const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status !== 404) throw err;
    }
  }
  return blockers;
}

/**
 * k8s-label-first update. PATCH flow:
 *   1. patchNode to set new labels (authoritative)
 *   2. tainting: apply/remove server-only taint based on target state
 *   3. upsertNodeFromK8s to refresh DB immediately
 *
 * If step 1 or 2 fails the DB stays consistent with k8s — the next
 * reconciler tick would overwrite anyway.
 */
export async function updateNode(
  db: Database,
  k8s: K8sClients,
  name: string,
  patch: UpdateClusterNodeInput,
): Promise<ClusterNode> {
  const existing = await getNode(db, name);
  if (!existing) {
    throw new ApiError('NODE_NOT_FOUND', `Node '${name}' not found`, 404, { node_name: name });
  }

  const targetRole: NodeRole = patch.role ?? existing.role;
  const targetCanHost = patch.canHostClientWorkloads ?? existing.canHostClientWorkloads;

  // Safety check: block server→worker demotion if system pods would be
  // evicted. `force: true` bypasses (admin accepts responsibility).
  if (existing.role === 'server' && targetRole === 'worker' && !patch.force) {
    const blockers = await listSystemPodsOnNode(k8s, name);
    if (blockers.length > 0) {
      throw new ApiError(
        'NODE_DEMOTION_BLOCKED',
        `Demoting '${name}' to worker would evict ${blockers.length} system pod(s). ` +
        `Drain the node first, or pass force=true to override.`,
        409,
        { blockers: blockers.slice(0, 20) },
      );
    }
  }

  // Build the labels object we want on the node. Merge with observed
  // labels so operator-set labels (kubernetes.io/*, custom team tags)
  // aren't wiped. Drizzle returns JSONB as already-parsed objects.
  const observedLabels = (existing.labels ?? {}) as Record<string, string>;
  const nextLabels: Record<string, string | null> = {
    ...observedLabels,
    [NODE_ROLE_LABEL]: targetRole,
    [HOST_CLIENT_WORKLOADS_LABEL]: String(targetCanHost),
  };

  // k8s merge-patch on labels (null = remove). Using a strategic-merge
  // JSON body on /api/v1/nodes/:name — the client-node library maps
  // raw dicts via the `body` parameter.
  if (patch.role !== undefined || patch.canHostClientWorkloads !== undefined) {
    // The typed param shape of the @kubernetes/client-node v1.4
    // generator omits `contentType` even though the runtime supports
    // it — the cast mirrors the idiom used elsewhere in this repo
    // (see file-manager/idle-cleanup.ts).
    await k8s.core.patchNode({
      name,
      body: { metadata: { labels: nextLabels } },
      contentType: 'application/strategic-merge-patch+json',
    } as unknown as Parameters<typeof k8s.core.patchNode>[0]);

    // Server-only taint only applies when role=server AND
    // canHostClientWorkloads=false. We set/remove it via a second
    // patch rather than overloading the first — keeps the rollback
    // story clear.
    const existingTaints = Array.isArray(existing.taints) ? existing.taints : [];
    const withoutOurs = existingTaints.filter((t) => t.key !== SERVER_ONLY_TAINT_KEY);
    const shouldTaint = targetRole === 'server' && !targetCanHost;
    const nextTaints = shouldTaint
      ? [...withoutOurs, { key: SERVER_ONLY_TAINT_KEY, value: 'true', effect: 'NoSchedule' }]
      : withoutOurs;
    await k8s.core.patchNode({
      name,
      body: { spec: { taints: nextTaints } },
      contentType: 'application/strategic-merge-patch+json',
    } as unknown as Parameters<typeof k8s.core.patchNode>[0]);
  }

  // notes is platform-only, no k8s equivalent — write directly.
  if (patch.notes !== undefined) {
    await db.update(clusterNodes)
      .set({ notes: patch.notes, updatedAt: sql`NOW()` })
      .where(eq(clusterNodes.name, name));
  }

  // Refresh from k8s to reflect the labels we just wrote.
  const updated = await getNode(db, name);
  if (!updated) {
    throw new ApiError('NODE_NOT_FOUND', `Node '${name}' disappeared after patch`, 500, { node_name: name });
  }
  return updated;
}
