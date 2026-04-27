import { eq, sql, desc } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clusterNodes, type ClusterNode } from '../../db/schema.js';
import type { NodeRole, NodeIngressMode, UpdateClusterNodeInput } from '@k8s-hosting/api-contracts';
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
// M-NS-1: ingress-mode label. The ingress-nginx DaemonSet's
// nodeSelector excludes nodes carrying `ingress-mode=none`.
export const INGRESS_MODE_LABEL = 'platform.phoenix-host.net/ingress-mode';

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
  ingressMode: NodeIngressMode;
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
    ingressMode: observed.ingressMode,
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
    // displayName is operator-managed only (not derived from k8s) so
    // it's intentionally absent here — first INSERT leaves it null,
    // and the UPDATE branch below preserves whatever the operator set.
  }).onConflictDoUpdate({
    target: clusterNodes.name,
    set: {
      role: observed.role,
      canHostClientWorkloads: observed.canHostClientWorkloads,
      ingressMode: observed.ingressMode,
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
  const targetIngressMode: NodeIngressMode = patch.ingressMode ?? existing.ingressMode;

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
    [INGRESS_MODE_LABEL]: targetIngressMode,
  };

  // Compose labels + taints in a single strategic-merge patch to
  // avoid the old "labels succeeded, taints failed" orphan state.
  // We always patch when any k8s-projected field changes (role,
  // canHost, or ingressMode), since each maps to a label.
  const k8sFieldsChanged =
    patch.role !== undefined
    || patch.canHostClientWorkloads !== undefined
    || patch.ingressMode !== undefined;
  if (k8sFieldsChanged) {
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

  // displayName + notes are platform-only (no k8s equivalent) — write
  // directly to the DB. Empty string is treated as null so the UI's
  // "clear alias" UX (a textbox cleared to empty) round-trips correctly.
  if (patch.displayName !== undefined || patch.notes !== undefined) {
    const dbPatch: Record<string, unknown> = { updatedAt: sql`NOW()` };
    if (patch.displayName !== undefined) {
      dbPatch.displayName = patch.displayName === '' ? null : patch.displayName;
    }
    if (patch.notes !== undefined) {
      dbPatch.notes = patch.notes;
    }
    await db.update(clusterNodes)
      .set(dbPatch)
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

// ─── Phase C: drain + delete ─────────────────────────────────────────

interface PodLite {
  readonly namespace: string;
  readonly name: string;
  readonly nodeName: string | undefined;
  readonly ownerKind: string | undefined;
  readonly clientId: string | null;
  readonly hasNodeAffinityToThisNode: boolean;
}

/** Pod refs we never evict during a drain — same shape kubectl uses. */
function isUnevictable(pod: PodLite, thisNode: string): { skip: boolean; reason: string } {
  if (pod.nodeName !== thisNode) return { skip: true, reason: 'not on this node' };
  // Mirror pods (k8s static pod sentinels): owner kind 'Node' or annotation kubernetes.io/config.mirror
  if (pod.ownerKind === 'Node') return { skip: true, reason: 'mirror pod (static)' };
  // DaemonSet pods: never evicted by `kubectl drain` (recreated immediately)
  if (pod.ownerKind === 'DaemonSet') return { skip: true, reason: 'DaemonSet pod' };
  return { skip: false, reason: '' };
}

/** Inspect a Pod and decide whether its nodeAffinity pins it to one specific node. */
function podPinnedToNode(pod: { spec?: { affinity?: unknown } }, nodeName: string): boolean {
  // Conservative best-effort detection — we only flag the explicit single-host case.
  // A Pod with nodeName: <node> in spec is also pinned. Caller checks that separately.
  const affinity = (pod.spec as { affinity?: { nodeAffinity?: unknown } } | undefined)?.affinity;
  const nodeAffinity = affinity?.nodeAffinity as
    | { requiredDuringSchedulingIgnoredDuringExecution?: {
        nodeSelectorTerms?: Array<{ matchExpressions?: Array<{ key?: string; operator?: string; values?: string[] }> }>;
      }; }
    | undefined;
  const terms = nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  for (const term of terms) {
    for (const expr of term.matchExpressions ?? []) {
      if (expr.key === 'kubernetes.io/hostname'
        && expr.operator === 'In'
        && Array.isArray(expr.values)
        && expr.values.length === 1
        && expr.values[0] === nodeName) {
        return true;
      }
    }
  }
  return false;
}

interface RawPod {
  metadata?: {
    namespace?: string;
    name?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string }>;
    annotations?: Record<string, string>;
  };
  spec?: {
    nodeName?: string;
    affinity?: unknown;
  };
  status?: {
    phase?: string;
  };
}

/**
 * Build the impact preview the UI shows before the operator confirms a
 * drain. The drain itself uses `evictPods`, which calls eviction API.
 * Both share the same classification so the preview is faithful.
 */
export async function buildDrainImpact(k8s: K8sClients, name: string): Promise<{
  nodeName: string;
  alreadyCordoned: boolean;
  systemPods: Array<{ namespace: string; name: string; reason: string }>;
  nonSystemPods: Array<{ namespace: string; name: string; clientId: string | null; pinnedToThisNode: boolean }>;
  longhornReplicas: Array<{ volumeName: string; replicaName: string; isLastReplica: boolean }>;
}> {
  // 1) Cordon state
  let alreadyCordoned = false;
  try {
    const node = await k8s.core.readNode({ name }) as { spec?: { unschedulable?: boolean } };
    alreadyCordoned = node.spec?.unschedulable === true;
  } catch (err) {
    if ((err as { code?: number }).code === 404) {
      throw new ApiError('NODE_NOT_FOUND', `Node '${name}' not found in Kubernetes`, 404, { node_name: name });
    }
    throw err;
  }

  // 2) Pods on this node (excluding terminal phase)
  const pods = await k8s.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${name}`,
  });
  const systemPods: Array<{ namespace: string; name: string; reason: string }> = [];
  const nonSystemPods: Array<{ namespace: string; name: string; clientId: string | null; pinnedToThisNode: boolean }> = [];

  for (const raw of pods.items as RawPod[]) {
    const ns = raw.metadata?.namespace ?? '';
    const podName = raw.metadata?.name ?? '';
    const phase = raw.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;

    const ownerKind = raw.metadata?.ownerReferences?.[0]?.kind;
    const isMirror = raw.metadata?.annotations?.['kubernetes.io/config.mirror'] !== undefined;
    const lite: PodLite = {
      namespace: ns,
      name: podName,
      nodeName: raw.spec?.nodeName,
      ownerKind: isMirror ? 'Node' : ownerKind,
      clientId: raw.metadata?.labels?.['platform.phoenix-host.net/client-id'] ?? null,
      hasNodeAffinityToThisNode: podPinnedToNode(raw, name),
    };
    const verdict = isUnevictable(lite, name);
    if (verdict.skip || (SYSTEM_NAMESPACES as readonly string[]).includes(ns)) {
      systemPods.push({
        namespace: ns,
        name: podName,
        reason: verdict.reason || 'system namespace',
      });
      continue;
    }
    nonSystemPods.push({
      namespace: ns,
      name: podName,
      clientId: lite.clientId,
      pinnedToThisNode: lite.hasNodeAffinityToThisNode,
    });
  }

  // 3) Longhorn replicas — refuse to drain when this is the LAST healthy
  //    replica for any volume. The custom resource list is best-effort:
  //    if the CRD is absent (cluster without Longhorn) we just skip it.
  const longhornReplicas: Array<{ volumeName: string; replicaName: string; isLastReplica: boolean }> = [];
  try {
    interface LhReplica {
      metadata?: { name?: string };
      spec?: { volumeName?: string; nodeID?: string };
      status?: { currentState?: string };
    }
    const list = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io',
      version: 'v1beta2',
      namespace: 'longhorn-system',
      plural: 'replicas',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LhReplica[] };

    // Pre-aggregate healthy replicas per volume so we can flag last-replica risk.
    const healthyByVolume = new Map<string, number>();
    for (const r of list.items ?? []) {
      const vol = r.spec?.volumeName;
      if (!vol) continue;
      if (r.status?.currentState === 'running') {
        healthyByVolume.set(vol, (healthyByVolume.get(vol) ?? 0) + 1);
      }
    }
    for (const r of list.items ?? []) {
      if (r.spec?.nodeID !== name) continue;
      const vol = r.spec?.volumeName ?? '';
      const replicaName = r.metadata?.name ?? '';
      const isLastReplica = (healthyByVolume.get(vol) ?? 0) <= 1;
      longhornReplicas.push({ volumeName: vol, replicaName, isLastReplica });
    }
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn('[nodes] longhorn replicas list failed:', (err as Error).message);
    }
  }

  return { nodeName: name, alreadyCordoned, systemPods, nonSystemPods, longhornReplicas };
}

/**
 * Cordon the node (so the scheduler stops placing new pods) and evict
 * everything in `nonSystemPods`. The Eviction API respects PodDisruption
 * Budgets, so a tightly-budgeted Deployment can refuse — that error is
 * captured per-pod so the UI can show partial progress.
 *
 * Returns a count of successful evictions and an array of failures.
 * The caller (route handler) decides whether to treat partial failure
 * as 200 with details or as 5xx; we return both and let the route choose
 * (currently: 200 always — operator sees the failures and retries).
 */
export async function drainNode(
  k8s: K8sClients,
  name: string,
  opts: { readonly forceLastReplica?: boolean; readonly gracePeriodSeconds?: number },
): Promise<{ cordoned: boolean; evicted: number; failed: Array<{ namespace: string; name: string; error: string }> }> {
  // 1) Refuse if last Longhorn replica anywhere on this node, unless overridden.
  const impact = await buildDrainImpact(k8s, name);
  const lastReplicaVolumes = impact.longhornReplicas.filter((r) => r.isLastReplica);
  if (lastReplicaVolumes.length > 0 && !opts.forceLastReplica) {
    throw new ApiError(
      'NODE_DRAIN_BLOCKED_LAST_REPLICA',
      `Node '${name}' holds the last running replica for ${lastReplicaVolumes.length} volume(s). ` +
      `Wait for replica rebuild on another node, or pass forceLastReplica=true to override.`,
      409,
      { volumes: lastReplicaVolumes.slice(0, 20) },
    );
  }

  // 2) Cordon (idempotent — patch unschedulable=true).
  let cordoned = impact.alreadyCordoned;
  if (!cordoned) {
    await k8s.core.patchNode({
      name,
      body: { spec: { unschedulable: true } },
    } as unknown as Parameters<typeof k8s.core.patchNode>[0],
      STRATEGIC_MERGE_PATCH);
    cordoned = true;
  }

  // 3) Evict non-system pods.
  //
  // The TS client exposes evictions via createNamespacedPodEviction
  // (kubernetes-client v1.x). Validate the method exists before
  // entering the loop — if a future library upgrade renames or
  // removes it, the per-pod try/catch below would otherwise silently
  // count every eviction as a "failure" with `is not a function` and
  // the drain would appear to complete with zero pods evicted.
  const evictionMethod = (k8s.core as unknown as Record<string, unknown>).createNamespacedPodEviction;
  if (typeof evictionMethod !== 'function') {
    throw new ApiError(
      'NODE_DRAIN_API_UNAVAILABLE',
      'Pod eviction API not available on the kubernetes client. ' +
      'Library upgrade may have changed the method signature; check service.ts drainNode.',
      500,
    );
  }
  type EvictionRequest = {
    name: string;
    namespace: string;
    body: unknown;
  };
  const evict = evictionMethod.bind(k8s.core) as (req: EvictionRequest) => Promise<unknown>;

  const grace = opts.gracePeriodSeconds ?? 60;
  let evicted = 0;
  const failed: Array<{ namespace: string; name: string; error: string }> = [];

  for (const pod of impact.nonSystemPods) {
    try {
      await evict({
        name: pod.name,
        namespace: pod.namespace,
        body: {
          apiVersion: 'policy/v1',
          kind: 'Eviction',
          metadata: { name: pod.name, namespace: pod.namespace },
          deleteOptions: { gracePeriodSeconds: grace },
        },
      });
      evicted += 1;
    } catch (err) {
      failed.push({
        namespace: pod.namespace,
        name: pod.name,
        error: (err as Error).message ?? 'eviction failed',
      });
    }
  }

  return { cordoned, evicted, failed };
}

/**
 * Delete the node from Kubernetes (`kubectl delete node`) and from the
 * platform inventory (`cluster_nodes` row). The API server also
 * cascade-deletes Endpoints owned by the node and frees its name.
 *
 * Pre-conditions enforced:
 *   - Node must be cordoned (unschedulable=true).
 *   - No non-system pods remaining on the node (drained).
 *
 * The actual host (k3s-agent process, OS) is NOT touched. Operator is
 * expected to power down or repurpose the host afterwards.
 */
export async function deleteNode(
  db: Database,
  k8s: K8sClients,
  name: string,
): Promise<{ deletedFromKubernetes: boolean; deletedFromInventory: boolean }> {
  // 1) Pre-check: must be cordoned + no non-system pods.
  let nodeExistsInK8s = true;
  try {
    const node = await k8s.core.readNode({ name }) as { spec?: { unschedulable?: boolean } };
    if (node.spec?.unschedulable !== true) {
      throw new ApiError(
        'NODE_DELETE_NOT_CORDONED',
        `Node '${name}' is not cordoned. Drain it first.`,
        409,
        { node_name: name },
      );
    }
  } catch (err) {
    if ((err as { code?: number }).code === 404) {
      // Already gone from k8s — proceed to inventory cleanup.
      nodeExistsInK8s = false;
    } else if ((err as ApiError).code === 'NODE_DELETE_NOT_CORDONED') {
      throw err;
    } else {
      throw err;
    }
  }

  if (nodeExistsInK8s) {
    const impact = await buildDrainImpact(k8s, name);
    if (impact.nonSystemPods.length > 0) {
      throw new ApiError(
        'NODE_DELETE_HAS_PODS',
        `Node '${name}' still hosts ${impact.nonSystemPods.length} non-system pod(s). ` +
        `Wait for the drain to complete (or re-run it).`,
        409,
        { remaining: impact.nonSystemPods.slice(0, 20) },
      );
    }
  }

  // 2) Delete from k8s (idempotent; 404 = already gone).
  let deletedFromKubernetes = false;
  if (nodeExistsInK8s) {
    try {
      await k8s.core.deleteNode({ name });
      deletedFromKubernetes = true;
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        deletedFromKubernetes = true;
      } else {
        throw err;
      }
    }
  }

  // 3) Delete from inventory.
  await db.delete(clusterNodes).where(eq(clusterNodes.name, name));

  return { deletedFromKubernetes, deletedFromInventory: true };
}
