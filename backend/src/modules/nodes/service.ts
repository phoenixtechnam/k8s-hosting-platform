import { eq, sql, desc } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clusterNodes, type ClusterNode } from '../../db/schema.js';
import type { NodeRole, NodeIngressMode, UpdateClusterNodeInput } from '@k8s-hosting/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { projectNode } from './k8s-sync.js';
import { STRATEGIC_MERGE_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';

// M1: Platform namespaces whose pods block a server→worker demotion
// unless the caller passes `force: true`. Anything here running on the
// node we're about to demote would be evicted when the scheduler
// re-evaluates the new nodeAffinity rules, so we refuse by default.
// Keep this list in sync with the system-node-affinity Kustomize
// component (see k8s/components/system-node-affinity/).
//
// IMPORTANT: this list also classifies pods in the drain-impact preview
// as "system" (info-only) vs "non-system" (will be evicted). Anything
// missing here gets shown to the operator as a tenant pod — which is
// wrong for cluster-infra namespaces (calico, tigera, kube-system, etc).
export const SYSTEM_NAMESPACES = Object.freeze([
  'platform',
  'platform-system',
  'platform-tenant-ops',
  'flux-system',
  'cert-manager',
  'ingress-nginx',
  'longhorn-system',
  'mail',
  'dex',
  'oauth2-proxy',
  // Cluster-infrastructure namespaces — these pods are platform-managed
  // by their respective operators (Calico CNI, kube-system control plane,
  // CloudNativePG, kube-prometheus). Treat as system for drain previews.
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'calico-system',
  'calico-apiserver',
  'tigera-operator',
  'cnpg-system',
  'monitoring',
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

/**
 * Enrich the DB row list with live K8s state — `cordoned` and
 * `drained` aren't persisted (they change on operator action /
 * scheduler decisions, not the reconciler tick), so we read them
 * once per LIST and decorate. `drained` = cordoned AND no tenant
 * pods (excluding DaemonSets / system namespaces) AND no Longhorn
 * replicas remain on the node.
 *
 * Best-effort: a K8s API hiccup yields cordoned/drained=false rather
 * than failing the whole call. The page falls back to "not cordoned"
 * which is safe — operators just lose the visual cue temporarily.
 */
export async function listNodesEnriched(
  db: Database,
  k8s: K8sClients | null,
): Promise<Array<ClusterNode & { cordoned: boolean; drained: boolean }>> {
  const rows = await listNodes(db);
  if (!k8s) return rows.map((r) => ({ ...r, cordoned: false, drained: false }));

  // Each call is wrapped in a try/catch — ANY of the three methods may
  // be missing in tests (mock that only stubs a subset) or fail in
  // production (CRD not installed → custom listNamespacedCustomObject
  // 404). We tolerate all of them and fall back to empty data; the
  // tags just won't render but the LIST itself succeeds.
  type NodesResp = { items?: Array<{ metadata?: { name?: string }; spec?: { unschedulable?: boolean } }> };
  type PodsResp = { items?: Array<{ metadata?: { namespace?: string; ownerReferences?: Array<{ kind?: string }> }; spec?: { nodeName?: string }; status?: { phase?: string } }> };
  type ReplicasResp = { items?: Array<{ spec?: { nodeID?: string }; status?: { currentState?: string } }> };
  const safeCall = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };
  const [nodesResp, podsResp, replicasResp] = await Promise.all([
    safeCall<NodesResp>(() => k8s.core.listNode() as Promise<NodesResp>, { items: [] }),
    safeCall<PodsResp>(() => k8s.core.listPodForAllNamespaces({}) as Promise<PodsResp>, { items: [] }),
    safeCall<ReplicasResp>(
      () => k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'replicas',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<ReplicasResp>,
      { items: [] },
    ),
  ]);

  const cordonedByName = new Map<string, boolean>();
  for (const n of nodesResp.items ?? []) {
    if (n.metadata?.name) {
      cordonedByName.set(n.metadata.name, n.spec?.unschedulable === true);
    }
  }

  // Count tenant pods per node (skip system NS, DaemonSets, mirror pods,
  // and terminal-phase pods).
  const tenantPodsByNode = new Map<string, number>();
  for (const p of podsResp.items ?? []) {
    const phase = p.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const ns = p.metadata?.namespace ?? '';
    if ((SYSTEM_NAMESPACES as readonly string[]).includes(ns)) continue;
    const ownerKind = p.metadata?.ownerReferences?.[0]?.kind;
    if (ownerKind === 'DaemonSet' || ownerKind === 'Node') continue;
    const node = p.spec?.nodeName;
    if (!node) continue;
    tenantPodsByNode.set(node, (tenantPodsByNode.get(node) ?? 0) + 1);
  }

  // Count running Longhorn replicas per node.
  const replicasByNode = new Map<string, number>();
  for (const r of replicasResp.items ?? []) {
    if (r.status?.currentState !== 'running') continue;
    const node = r.spec?.nodeID;
    if (!node) continue;
    replicasByNode.set(node, (replicasByNode.get(node) ?? 0) + 1);
  }

  return rows.map((r) => {
    const cordoned = cordonedByName.get(r.name) === true;
    const drained = cordoned
      && (tenantPodsByNode.get(r.name) ?? 0) === 0
      && (replicasByNode.get(r.name) ?? 0) === 0;
    return { ...r, cordoned, drained };
  });
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
    // body is interpreted correctly. Merge `cordoned` into the same
    // patch when set so the operator's "cordon + flip canHost" intent
    // lands in one round-trip.
    const specPatch: Record<string, unknown> = { taints: nextTaints };
    if (patch.cordoned !== undefined) specPatch.unschedulable = patch.cordoned;
    await k8s.core.patchNode({
      name,
      body: {
        metadata: { labels: nextLabels },
        spec: specPatch,
      },
    } as unknown as Parameters<typeof k8s.core.patchNode>[0],
      STRATEGIC_MERGE_PATCH);
  } else if (patch.cordoned !== undefined) {
    // No labels/taints touched but cordon flipped — still need to patch.
    await k8s.core.patchNode({
      name,
      body: { spec: { unschedulable: patch.cordoned } },
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

/**
 * Check whether a Pod template (or live Pod) is pinned to one specific
 * node via nodeSelector or nodeAffinity. We accept both forms because:
 *   - The platform's k8s-deployer sets `nodeSelector: kubernetes.io/hostname=<name>`
 *     when a tenant deployment has `clients.workerNodeName` populated.
 *   - Operators may also use nodeAffinity for more complex pinning.
 * Returns the pin kind so the UI can label rows accurately.
 */
function detectNodePin(
  spec: { nodeSelector?: Record<string, string>; affinity?: unknown } | undefined,
  nodeName: string,
): 'nodeSelector' | 'nodeAffinity' | null {
  if (spec?.nodeSelector?.['kubernetes.io/hostname'] === nodeName) {
    return 'nodeSelector';
  }
  const affinity = (spec as { affinity?: { nodeAffinity?: unknown } } | undefined)?.affinity;
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
        return 'nodeAffinity';
      }
    }
  }
  return null;
}

interface RawPod {
  metadata?: {
    namespace?: string;
    name?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind?: string; name?: string }>;
    annotations?: Record<string, string>;
  };
  spec?: {
    nodeName?: string;
    nodeSelector?: Record<string, string>;
    affinity?: unknown;
  };
  status?: {
    phase?: string;
  };
}

/**
 * Build the impact preview the UI shows before the operator confirms a
 * drain. Three primary kinds of resources are surfaced:
 *
 *  1. nonSystemPods   — live Pods on this node that will be evicted
 *  2. pinnedClients   — tenant clients with pinned workloads OR PVCs on
 *                       this node, aggregated by client (the unit of
 *                       re-pinning per the lifecycle architecture)
 *  3. longhornReplicas — every Longhorn replica record on this node,
 *                       used for platform last-replica risk surfacing
 *
 * `db` is required for the client lookup; pass app.db.
 */
export async function buildDrainImpact(
  k8s: K8sClients,
  db: Database,
  name: string,
): Promise<{
  nodeName: string;
  alreadyCordoned: boolean;
  systemPods: Array<{ namespace: string; name: string; reason: string }>;
  nonSystemPods: Array<{
    namespace: string; name: string;
    clientId: string | null; clientName: string | null;
    pinnedToThisNode: boolean;
    workloadKind: string | null; workloadName: string | null;
  }>;
  pinnedClients: Array<{
    clientId: string;
    clientName: string;
    namespace: string;
    storageTier: 'local' | 'ha';
    currentWorkerNodeName: string | null;
    workloads: Array<{
      kind: 'Deployment' | 'StatefulSet';
      name: string;
      replicas: number;
      pinKind: 'nodeSelector' | 'nodeAffinity';
    }>;
    pvcs: Array<{
      pvcName: string;
      volumeName: string;
      sizeBytes: number;
      replicaCount: number;
      isLastReplica: boolean;
      currentNodeSelector: string[];
    }>;
  }>;
  longhornReplicas: Array<{
    volumeName: string;
    replicaName: string;
    isLastReplica: boolean;
    namespace: string | null;
    pvcName: string | null;
    clientId: string | null;
    clientName: string | null;
    ownerLabel: string;
  }>;
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

  // 2) Cluster-wide client lookup table (namespace → {id, name, tier, pin}).
  //    Single SELECT covers every tenant; cheaper than per-namespace queries.
  //    storageTier and workerNodeName are needed by the pinnedClients
  //    aggregation to render the per-client expand view + show the
  //    operator the current pin (so they know what they're changing).
  const { clients: clientsTbl } = await import('../../db/schema.js');
  const clientRows = await db.select({
    id: clientsTbl.id,
    name: clientsTbl.companyName,
    ns: clientsTbl.kubernetesNamespace,
    tier: clientsTbl.storageTier,
    pin: clientsTbl.workerNodeName,
  }).from(clientsTbl);
  type ClientLite = {
    id: string;
    name: string;
    tier: 'local' | 'ha';
    pin: string | null;
  };
  const clientByNs = new Map<string, ClientLite>();
  for (const c of clientRows) {
    if (c.ns) {
      clientByNs.set(c.ns, {
        id: c.id,
        name: c.name,
        tier: (c.tier as 'local' | 'ha') ?? 'local',
        pin: c.pin ?? null,
      });
    }
  }

  // 3) Pods on this node (excluding terminal phase)
  const pods = await k8s.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${name}`,
  });
  const systemPods: Array<{ namespace: string; name: string; reason: string }> = [];
  const nonSystemPods: Array<{
    namespace: string; name: string;
    clientId: string | null; clientName: string | null;
    pinnedToThisNode: boolean;
    workloadKind: string | null; workloadName: string | null;
  }> = [];

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
      hasNodeAffinityToThisNode: detectNodePin(raw.spec, name) !== null,
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
    const clientLookup = clientByNs.get(ns);
    const ownerRef = raw.metadata?.ownerReferences?.[0];
    nonSystemPods.push({
      namespace: ns,
      name: podName,
      clientId: lite.clientId ?? clientLookup?.id ?? null,
      clientName: clientLookup?.name ?? null,
      pinnedToThisNode: lite.hasNodeAffinityToThisNode,
      workloadKind: ownerRef?.kind ?? null,
      workloadName: ownerRef?.name ?? null,
    });
  }

  // 4) Pinned workloads (Deployments + StatefulSets) — even when they
  //    have replicas=0 or pods stuck Pending, the Deployment's pin is
  //    what the operator wants to re-target. Fetched cluster-wide,
  //    filtered to those with kubernetes.io/hostname=<this node>.
  const pinnedWorkloads: Array<{
    namespace: string; kind: 'Deployment' | 'StatefulSet'; name: string;
    clientId: string | null; clientName: string | null;
    replicas: number;
    pinKind: 'nodeSelector' | 'nodeAffinity';
  }> = [];
  interface LiteWorkload {
    metadata?: { name?: string; namespace?: string };
    spec?: {
      replicas?: number;
      template?: { spec?: { nodeSelector?: Record<string, string>; affinity?: unknown } };
    };
  }
  try {
    const [deps, sts] = await Promise.all([
      k8s.apps.listDeploymentForAllNamespaces({}) as Promise<{ items?: LiteWorkload[] }>,
      k8s.apps.listStatefulSetForAllNamespaces({}) as Promise<{ items?: LiteWorkload[] }>,
    ]);
    const enumerate = (items: LiteWorkload[] | undefined, kind: 'Deployment' | 'StatefulSet') => {
      for (const w of items ?? []) {
        const ns = w.metadata?.namespace ?? '';
        if ((SYSTEM_NAMESPACES as readonly string[]).includes(ns)) continue;
        const pin = detectNodePin(w.spec?.template?.spec, name);
        if (!pin) continue;
        const c = clientByNs.get(ns);
        pinnedWorkloads.push({
          namespace: ns,
          kind,
          name: w.metadata?.name ?? '',
          clientId: c?.id ?? null,
          clientName: c?.name ?? null,
          replicas: w.spec?.replicas ?? 0,
          pinKind: pin,
        });
      }
    };
    enumerate(deps.items, 'Deployment');
    enumerate(sts.items, 'StatefulSet');
  } catch (err) {
    console.warn('[nodes] pinned workload enumeration failed:', (err as Error).message);
  }

  // 5) Longhorn replicas — refuse to drain when this is the LAST healthy
  //    replica for any volume. The custom resource list is best-effort:
  //    if the CRD is absent (cluster without Longhorn) we just skip it.
  //    Each entry is enriched with PVC namespace + name and resolved
  //    owner (client name or "Platform System") so the UI's last-replica
  //    risk panel can label volumes for the operator.
  const longhornReplicas: Array<{
    volumeName: string;
    replicaName: string;
    isLastReplica: boolean;
    namespace: string | null;
    pvcName: string | null;
    clientId: string | null;
    clientName: string | null;
    ownerLabel: string;
  }> = [];
  try {
    interface LhReplica {
      metadata?: { name?: string };
      spec?: { volumeName?: string; nodeID?: string };
      status?: { currentState?: string };
    }
    interface LhVolumeMeta {
      metadata?: { name?: string };
      status?: { kubernetesStatus?: { pvcName?: string; namespace?: string } };
    }
    // Fan out replicas + volumes lookup in parallel — both are cheap LISTs
    // against longhorn-system, and we need both to attribute owners.
    const [replicaResp, volumeResp] = await Promise.all([
      k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'replicas',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhReplica[] }>,
      k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as Promise<{ items?: LhVolumeMeta[] }>,
    ]);

    // volume name → { namespace, pvcName }
    const volumeMeta = new Map<string, { namespace: string; pvcName: string }>();
    for (const v of volumeResp.items ?? []) {
      const volName = v.metadata?.name ?? '';
      if (!volName) continue;
      volumeMeta.set(volName, {
        namespace: v.status?.kubernetesStatus?.namespace ?? '',
        pvcName: v.status?.kubernetesStatus?.pvcName ?? '',
      });
    }

    // Pre-aggregate healthy replicas per volume so we can flag last-replica risk.
    const healthyByVolume = new Map<string, number>();
    for (const r of replicaResp.items ?? []) {
      const vol = r.spec?.volumeName;
      if (!vol) continue;
      if (r.status?.currentState === 'running') {
        healthyByVolume.set(vol, (healthyByVolume.get(vol) ?? 0) + 1);
      }
    }
    for (const r of replicaResp.items ?? []) {
      if (r.spec?.nodeID !== name) continue;
      const vol = r.spec?.volumeName ?? '';
      const replicaName = r.metadata?.name ?? '';
      const isLastReplica = (healthyByVolume.get(vol) ?? 0) <= 1;
      const meta = volumeMeta.get(vol);
      const ns = meta?.namespace || null;
      const pvcName = meta?.pvcName || null;
      const client = ns ? clientByNs.get(ns) : undefined;
      // "Platform System" covers everything not owned by a tenant client:
      // longhorn-system, platform (postgres), monitoring, mail, etc.
      const ownerLabel = client?.name ?? (ns ? `Platform System (${ns})` : 'Platform System');
      longhornReplicas.push({
        volumeName: vol,
        replicaName,
        isLastReplica,
        namespace: ns,
        pvcName,
        clientId: client?.id ?? null,
        clientName: client?.name ?? null,
        ownerLabel,
      });
    }
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn('[nodes] longhorn replicas list failed:', (err as Error).message);
    }
  }

  // 6) Tenant PVCs with a replica on this node. We list Longhorn Volumes
  //    cluster-wide once and join with PV → PVC namespace to produce
  //    operator-friendly entries. Tenant = namespace IS in the clients
  //    table (excluding platform / mail / etc).
  const tenantPvcs: Array<{
    namespace: string; pvcName: string; volumeName: string;
    clientId: string | null; clientName: string | null;
    sizeBytes: number; replicaCount: number;
    isLastReplica: boolean;
    currentNodeSelector: string[];
  }> = [];
  try {
    interface LhVolume {
      metadata?: { name?: string };
      spec?: { size?: string; numberOfReplicas?: number; nodeSelector?: string[] };
      status?: { kubernetesStatus?: { pvcName?: string; namespace?: string } };
    }
    const vols = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as { items?: LhVolume[] };

    // Two indexes by volume:
    //   replicaNodes        → every replica record (any state) — used to
    //                         decide whether the volume has ANY presence
    //                         on the draining node (a stopped replica
    //                         still needs the operator's attention; it's
    //                         the case where re-pinning is most urgent).
    //   healthyReplicaNodes → only running replicas — used for the
    //                         operator-facing "replicas" count and the
    //                         isLastReplica risk classification.
    // Symmetric with the platform-replica loop above (which enumerates
    // all replica records on this node, healthy or not). Without this,
    // a tenant volume whose single replica is currently `stopped` on
    // the draining node was filtered out of tenantPvcs entirely — so
    // the modal hid the per-row "Re-pin to" dropdown and the operator
    // could only see the volume in the platform "Last-replica risk"
    // banner where re-pinning isn't offered. Reported on staging.
    const replicaNodes = new Map<string, string[]>();
    const healthyReplicaNodes = new Map<string, string[]>();
    const replicaListResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'replicas',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]) as {
      items?: Array<{ spec?: { volumeName?: string; nodeID?: string }; status?: { currentState?: string } }>;
    };
    for (const r of replicaListResp.items ?? []) {
      const v = r.spec?.volumeName;
      const n = r.spec?.nodeID;
      if (!v || !n) continue;
      const arr = replicaNodes.get(v) ?? [];
      arr.push(n);
      replicaNodes.set(v, arr);
      if (r.status?.currentState === 'running') {
        const ha = healthyReplicaNodes.get(v) ?? [];
        ha.push(n);
        healthyReplicaNodes.set(v, ha);
      }
    }

    for (const v of vols.items ?? []) {
      const volName = v.metadata?.name ?? '';
      const k8sStatus = v.status?.kubernetesStatus;
      const ns = k8sStatus?.namespace ?? '';
      const pvcName = k8sStatus?.pvcName ?? '';
      if (!ns || !clientByNs.has(ns)) continue; // tenant only
      const allNodes = replicaNodes.get(volName) ?? [];
      if (!allNodes.includes(name)) continue;
      const healthy = healthyReplicaNodes.get(volName) ?? [];
      const c = clientByNs.get(ns)!;
      const sizeBytes = Number(v.spec?.size ?? '0');
      tenantPvcs.push({
        namespace: ns,
        pvcName,
        volumeName: volName,
        clientId: c.id,
        clientName: c.name,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        replicaCount: healthy.length,
        isLastReplica: healthy.length <= 1,
        currentNodeSelector: Array.isArray(v.spec?.nodeSelector) ? [...v.spec.nodeSelector] : [],
      });
    }
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status !== 404) {
      console.warn('[nodes] tenant PVC enumeration failed:', (err as Error).message);
    }
  }

  // 7) Aggregate tenant pinned workloads + PVCs by client so the modal
  //    can offer ONE re-pin target per client (matching the lifecycle
  //    architecture: pinning is a client-level property in
  //    clients.worker_node_name, propagated to every workload + volume
  //    in the namespace by the orchestrator).
  type ClientAgg = {
    clientId: string;
    clientName: string;
    namespace: string;
    storageTier: 'local' | 'ha';
    currentWorkerNodeName: string | null;
    workloads: Array<{
      kind: 'Deployment' | 'StatefulSet';
      name: string;
      replicas: number;
      pinKind: 'nodeSelector' | 'nodeAffinity';
    }>;
    pvcs: Array<{
      pvcName: string;
      volumeName: string;
      sizeBytes: number;
      replicaCount: number;
      isLastReplica: boolean;
      currentNodeSelector: string[];
    }>;
  };
  const byClient = new Map<string, ClientAgg>();
  const ensureClient = (clientId: string, ns: string): ClientAgg | null => {
    const existing = byClient.get(clientId);
    if (existing) return existing;
    const c = clientByNs.get(ns);
    if (!c) return null;
    const agg: ClientAgg = {
      clientId,
      clientName: c.name,
      namespace: ns,
      storageTier: c.tier,
      currentWorkerNodeName: c.pin,
      workloads: [],
      pvcs: [],
    };
    byClient.set(clientId, agg);
    return agg;
  };
  for (const w of pinnedWorkloads) {
    if (!w.clientId) continue;
    const agg = ensureClient(w.clientId, w.namespace);
    if (!agg) continue;
    agg.workloads.push({
      kind: w.kind,
      name: w.name,
      replicas: w.replicas,
      pinKind: w.pinKind,
    });
  }
  for (const p of tenantPvcs) {
    if (!p.clientId) continue;
    const agg = ensureClient(p.clientId, p.namespace);
    if (!agg) continue;
    agg.pvcs.push({
      pvcName: p.pvcName,
      volumeName: p.volumeName,
      sizeBytes: p.sizeBytes,
      replicaCount: p.replicaCount,
      isLastReplica: p.isLastReplica,
      currentNodeSelector: p.currentNodeSelector,
    });
  }
  const pinnedClients = Array.from(byClient.values()).sort((a, b) =>
    a.clientName.localeCompare(b.clientName));

  return {
    nodeName: name,
    alreadyCordoned,
    systemPods,
    nonSystemPods,
    pinnedClients,
    longhornReplicas,
  };
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
  db: Database,
  name: string,
  opts: {
    readonly forceLastReplica?: boolean;
    readonly gracePeriodSeconds?: number;
    /**
     * Per-client re-pin instructions. Key = clientId. Values:
     *   ""        → clear the pin (auto)
     *   "<node>"  → re-pin the entire client (workloads + volumes) to <node>
     *   "stay"    → keep the pin on the draining node (drain refuses
     *               unless forceLastReplica covers data risk)
     * Any pinned client missing from the map defaults to "" (auto).
     */
    readonly clientPlacement?: Record<string, string>;
  },
): Promise<{
  cordoned: boolean;
  evicted: number;
  failed: Array<{ namespace: string; name: string; error: string }>;
  rePinnedClients: number;
  rePinnedWorkloads: number;
  rePinnedPvcs: number;
}> {
  // 1) Refuse if last Longhorn replica anywhere on this node, unless overridden.
  const impact = await buildDrainImpact(k8s, db, name);
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

  // 1.5) Apply CLIENT-LEVEL re-pin instructions BEFORE cordoning.
  //
  // Pinning is a client-level property — clients.worker_node_name in
  // the platform DB is the source of truth, and the orchestrator is
  // responsible for ensuring every Deployment, StatefulSet, FM
  // sidecar, and Longhorn volume in the client's namespace inherits
  // that pin. The drain endpoint therefore takes one re-pin target
  // per client and applies it consistently across the entire
  // namespace, rather than letting the operator pick conflicting
  // targets per-workload (which would violate the lifecycle
  // architecture).
  //
  // Auto-fill: any client present in pinnedClients but not in the
  // request gets "" (auto = clear pin → scheduler/Longhorn picks).
  // Without this, an API caller passing an empty map cordons the
  // node and evicts pods but leaves their nodeSelector pointing at
  // the cordoned host — pods come back Pending.
  const clientPlacement: Record<string, string> = { ...(opts.clientPlacement ?? {}) };
  for (const c of impact.pinnedClients) {
    if (!(c.clientId in clientPlacement)) clientPlacement[c.clientId] = '';
  }

  // Validate target nodes referenced by the operator BEFORE doing any
  // patches — a typo'd node name shouldn't leave the cluster half-
  // converted. We skip 'stay' and '' (auto) since they don't refer
  // to a target node.
  const referencedTargets = new Set<string>();
  for (const t of Object.values(clientPlacement)) {
    if (t && t !== 'stay') referencedTargets.add(t);
  }
  for (const target of referencedTargets) {
    try {
      await k8s.custom.getNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'nodes', name: target,
      } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]);
    } catch (err) {
      const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
      if (status === 404) {
        throw new ApiError(
          'NODE_REPIN_TARGET_NOT_FOUND',
          `Target node '${target}' not found in Longhorn — cannot re-pin to a non-existent node.`,
          400,
          { target },
        );
      }
    }
  }

  // Per-host Longhorn tag tracking — we add the tag to the target
  // Longhorn Node CR exactly once even when several clients are
  // re-pinned to it.
  const PER_HOST_TAG_PREFIX = 'node-';
  const taggedTargets = new Set<string>();
  const ensureLonghornHostTag = async (target: string): Promise<string> => {
    const hostTag = `${PER_HOST_TAG_PREFIX}${target}`;
    if (taggedTargets.has(target)) return hostTag;
    const existing = await k8s.custom.getNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes', name: target,
    } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as { spec?: { tags?: string[] } };
    const currentTags = existing.spec?.tags ?? [];
    if (!currentTags.includes(hostTag)) {
      await k8s.custom.patchNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'nodes', name: target,
        body: { spec: { tags: [...currentTags, hostTag] } },
      } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
        MERGE_PATCH);
    }
    taggedTargets.add(target);
    return hostTag;
  };

  let rePinnedClients = 0;
  let rePinnedWorkloads = 0;
  let rePinnedPvcs = 0;

  // Lookup workloads + PVCs by namespace once — buildDrainImpact
  // already has them grouped by client.
  const clientById = new Map(impact.pinnedClients.map((c) => [c.clientId, c]));

  // Order of operations per client (matters for partial-failure recovery):
  //   (a) Pre-flight: ensure the target Longhorn Node CR carries the
  //       per-host tag. This is the most likely fail-fast step (CRD
  //       not installed, Longhorn API down, target node missing tag-
  //       management permission). Doing it first means a failure
  //       leaves zero state mutated for this client.
  //   (b) Patch every Longhorn volume in the namespace.
  //   (c) Patch every Deployment + StatefulSet in the namespace.
  //   (d) Update clients.worker_node_name in the DB so the next
  //       reconciler tick / next deploy doesn't snap back.
  //
  // If (b) or (c) partially fails, the orchestrator's next reconciler
  // tick re-derives state from clients.worker_node_name (already
  // updated in (d)) and brings the cluster back into shape. Doing
  // (d) last is therefore important — if it ran first and (b)/(c)
  // fully failed, the DB would advertise a pin the cluster never
  // accepted and the next deploy would inherit the wrong node.
  for (const [clientId, target] of Object.entries(clientPlacement)) {
    if (target === 'stay') continue;
    const c = clientById.get(clientId);
    if (!c) continue; // operator targeted a client that has no pins on this node — no-op
    const ns = c.namespace;

    // (a) Resolve the Longhorn host-tag for the target. Failure here
    //     skips the entire client — none of (b)/(c)/(d) run, so no
    //     partial state.
    let nextSelector: string[] = [];
    if (target !== '') {
      try {
        nextSelector = [await ensureLonghornHostTag(target)];
      } catch (err) {
        console.warn(`[nodes] re-pin client=${clientId} target tag step on ${target} failed (skipping client):`, (err as Error).message);
        continue;
      }
    }

    // (b) Patch every Longhorn volume in the namespace.
    for (const p of c.pvcs) {
      try {
        await k8s.custom.patchNamespacedCustomObject({
          group: 'longhorn.io', version: 'v1beta2',
          namespace: 'longhorn-system', plural: 'volumes',
          name: p.volumeName, body: { spec: { nodeSelector: nextSelector } },
        } as unknown as Parameters<typeof k8s.custom.patchNamespacedCustomObject>[0],
          MERGE_PATCH);
        rePinnedPvcs += 1;
      } catch (err) {
        console.warn(`[nodes] re-pin client=${clientId} volume=${p.volumeName} → ${target || 'auto'} failed:`, (err as Error).message);
      }
    }

    // (c) Patch every Deployment + StatefulSet in the namespace.
    //     MERGE_PATCH (RFC 7396) so null on a key deletes it — the
    //     only patch type that reliably clears the hostname selector
    //     when target=''. Strategic-merge silently merges {} into the
    //     existing map.
    const selectorPatch: Record<string, string | null> =
      target === ''
        ? { 'kubernetes.io/hostname': null }
        : { 'kubernetes.io/hostname': target };
    const body = { spec: { template: { spec: { nodeSelector: selectorPatch } } } };

    for (const w of c.workloads) {
      try {
        if (w.kind === 'Deployment') {
          await k8s.apps.patchNamespacedDeployment({
            namespace: ns, name: w.name, body,
          } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
            MERGE_PATCH);
        } else {
          await k8s.apps.patchNamespacedStatefulSet({
            namespace: ns, name: w.name, body,
          } as unknown as Parameters<typeof k8s.apps.patchNamespacedStatefulSet>[0],
            MERGE_PATCH);
        }
        rePinnedWorkloads += 1;
      } catch (err) {
        console.warn(`[nodes] re-pin client=${clientId} ${w.kind}/${w.name} in ${ns} failed:`, (err as Error).message);
      }
    }

    // (d) Persist the new pin in the platform DB. Done LAST so the DB
    //     never advertises a pin the cluster failed to accept; if (b)
    //     or (c) partially failed, the reconciler reads this row on
    //     its next tick and re-applies the patches.
    try {
      const { clients: clientsTbl } = await import('../../db/schema.js');
      await db.update(clientsTbl)
        .set({ workerNodeName: target === '' ? null : target, updatedAt: sql`NOW()` })
        .where(eq(clientsTbl.id, clientId));
    } catch (err) {
      console.warn(`[nodes] platform pin DB sync failed for client=${clientId}:`, (err as Error).message);
    }
    rePinnedClients += 1;
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

  return { cordoned, evicted, failed, rePinnedClients, rePinnedWorkloads, rePinnedPvcs };
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
    const impact = await buildDrainImpact(k8s, db, name);
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
