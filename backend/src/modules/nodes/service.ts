import { eq, sql, desc } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clusterNodes, type ClusterNode } from '../../db/schema.js';
import type { NodeRole, UpdateClusterNodeInput } from '@k8s-hosting/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { projectNode } from './k8s-sync.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

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
  // Live usage — filled by the reconciler after projection.
  scheduledPods: number | null;
  cpuRequestsMillicores: number | null;
  memoryRequestsBytes: number | null;
}

/**
 * Upsert an observation from the k8s-sync reconciler. The k8s label is
 * authoritative for role + canHostClientWorkloads — if an operator
 * `kubectl label`s a node by hand, the next sync tick reflects that
 * into the DB. The reconciler never writes labels on its own; PATCH
 * /api/v1/admin/nodes/:name does, via service.updateNode below.
 */
export async function upsertNodeFromK8s(db: Database, observed: ObservedNode): Promise<void> {
  // Refuse phantom rows: k8s should always return a name, but the
  // defensive '<unknown>' fallback in projectNode would have inserted
  // a row with that literal primary key on malformed input.
  if (!observed.name || observed.name === '<unknown>') {
    console.warn('[node-sync] refusing to upsert nameless node');
    return;
  }
  // INSERT timestamps come from Drizzle's defaultNow() (DB clock);
  // UPDATE uses NOW() — both are DB-side so there's no process-vs-DB
  // skew between paths.
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
    scheduledPods: observed.scheduledPods,
    cpuRequestsMillicores: observed.cpuRequestsMillicores,
    memoryRequestsBytes: observed.memoryRequestsBytes,
    // lastSeenAt + updatedAt default to NOW() via defaultNow() on the
    // schema; omitting them here keeps every timestamp DB-side.
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
      scheduledPods: observed.scheduledPods,
      cpuRequestsMillicores: observed.cpuRequestsMillicores,
      memoryRequestsBytes: observed.memoryRequestsBytes,
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
 * k8s-first update. The previous version issued two separate
 * `patchNode` calls (labels, then taints), which could leave k8s in
 * a half-applied state if the second failed. This version combines
 * labels + taints into a single strategic-merge patch, so the whole
 * update lands atomically from the k8s API's perspective.
 *
 * After the patch, DB state is refreshed from k8s via the sync
 * projection (instead of trusting the existing DB row, which would
 * still show the pre-patch role until the next 60 s reconciler tick).
 */
export async function updateNode(
  db: Database,
  k8s: K8sClients,
  name: string,
  patch: UpdateClusterNodeInput,
  actor?: { userId: string; role: string },
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

  // force=true bypassed the safety check — record the decision in the
  // audit log before touching k8s, so even a subsequent failure is
  // attributable. Non-fatal if the audit write itself fails (would
  // mask the real action), so wrap and swallow.
  if (patch.force && existing.role === 'server' && targetRole === 'worker') {
    try {
      const { auditLogs } = await import('../../db/schema.js');
      await db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: actor?.userId ?? 'system',
        actorType: 'user',
        actionType: 'node.force_demote',
        resourceType: 'cluster_node',
        resourceId: name,
        changes: {
          from_role: existing.role,
          to_role: targetRole,
          actor_role: actor?.role ?? 'unknown',
          force: true,
        },
      });
    } catch (err) {
      console.error('[nodes] force-demote audit write failed (continuing):', (err as Error).message);
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

  // Compose labels + taints in a single strategic-merge patch to
  // avoid the old "labels succeeded, taints failed" orphan state.
  if (patch.role !== undefined || patch.canHostClientWorkloads !== undefined) {
    const existingTaints = Array.isArray(existing.taints) ? existing.taints : [];
    const withoutOurs = existingTaints.filter((t) => t.key !== SERVER_ONLY_TAINT_KEY);
    const shouldTaint = targetRole === 'server' && !targetCanHost;
    const nextTaints = shouldTaint
      ? [...withoutOurs, { key: SERVER_ONLY_TAINT_KEY, value: 'true', effect: 'NoSchedule' }]
      : withoutOurs;

    // Single atomic patch. The library's auto-generated client picks
    // Content-Type = application/json-patch+json by default; pass a
    // STRATEGIC_MERGE_PATCH middleware override so our object-shaped
    // body is interpreted correctly.
    await k8s.core.patchNode({
      name,
      body: {
        metadata: { labels: nextLabels },
        spec: { taints: nextTaints },
      },
    } as unknown as Parameters<typeof k8s.core.patchNode>[0],
      STRATEGIC_MERGE_PATCH);
  }

  // notes is platform-only, no k8s equivalent — write directly.
  if (patch.notes !== undefined) {
    await db.update(clusterNodes)
      .set({ notes: patch.notes, updatedAt: sql`NOW()` })
      .where(eq(clusterNodes.name, name));
  }

  // Re-read the node from k8s and upsert the DB so the response
  // reflects the labels we just wrote, not the stale pre-patch row.
  // The reconciler will repeat this work on its next tick — harmless
  // redundancy, much better UX than "saved but still shows old role
  // for 60 s."
  try {
    const liveRes = await k8s.core.readNode({ name });
    const observed = projectNode(liveRes as Parameters<typeof projectNode>[0]);
    await upsertNodeFromK8s(db, observed);
  } catch (err) {
    // Refresh is best-effort; if it fails the reconciler catches up
    // within 60 s. Don't mask a successful patch with a refresh error.
    console.warn('[nodes] post-patch refresh failed:', (err as Error).message);
  }

  const updated = await getNode(db, name);
  if (!updated) {
    throw new ApiError('NODE_NOT_FOUND', `Node '${name}' disappeared after patch`, 500, { node_name: name });
  }
  return updated;
}
