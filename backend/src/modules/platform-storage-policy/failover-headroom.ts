/**
 * Cluster failover headroom calculation.
 *
 * Answers the operator question: "How much capacity can I safely
 * allocate to tenants without risking that a single server failure
 * leaves rescheduled tenant pods Pending?"
 *
 * Formula:
 *
 *   tenantAvailable = sumOverServers(allocatable)
 *                   − sumOverSystemPods(requests)         // system baseline
 *                   − max(allocatable per server)         // 1 failover slot
 *
 * The last term is what makes this "failover-aware": we reserve one
 * server's worth of capacity (the largest, to be conservative) so the
 * cluster can absorb a single-server loss without any tenant pod
 * being stranded due to insufficient capacity on survivors.
 *
 * On a homogeneous 3-server HA cluster this means tenants can safely
 * use ~2/3 of total cluster capacity (after system baseline). On a
 * 5-server cluster, ~4/5. The shape matches the user's intent on
 * 2026-05-11 — "in HA mode all servers should replicate all essential
 * services for ease of maintenance, so an operator might not
 * overschedule servers which might result in diminished fail-over
 * scenarios where system pods cannot re-schedule on node failure due
 * to some server resources being exhausted".
 *
 * Why not also subtract a slot per service: a 3-replica service with
 * DoNotSchedule already loses 1/3 of its replicas on a server failure
 * — the surviving 2 take the load, no rescheduling needed (see
 * service.ts HA_TOPOLOGY_SPREAD comment). The headroom calc only
 * needs to cover TENANT workloads, since system replication is per-
 * server-symmetric.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { parseResourceValue } from '../../shared/resource-parser.js';

// Namespaces whose pod requests count as "system baseline". Tenant
// namespaces (client-*) are intentionally excluded — their requests
// are the thing we're computing headroom AGAINST. ingress-nginx,
// calico, longhorn-* are DaemonSets so their per-node footprint is
// inherent and unavoidable.
const SYSTEM_NAMESPACES: ReadonlyArray<string> = [
  'kube-system',
  'calico-system',
  'tigera-operator',
  'cnpg-system',
  'longhorn-system',
  'flux-system',
  'cert-manager',
  'ingress-nginx',
  'redis-system',
  'platform',
  'platform-system',
  'mail',
  'hosting',
];

const SERVER_LABEL_KEY = 'platform.phoenix-host.net/node-role';
const SERVER_LABEL_VAL = 'server';

export interface ServerNodeFact {
  readonly name: string;
  readonly allocatableCpu: number;     // cores (decimal)
  readonly allocatableMemoryGi: number;
}

export interface FailoverHeadroom {
  /** All server-role nodes in Ready=True state, with their kube-allocatable. */
  readonly servers: ReadonlyArray<ServerNodeFact>;
  /** Sum of allocatable across all ready server nodes. */
  readonly totalCpu: number;
  readonly totalMemoryGi: number;
  /** Sum of pod requests across SYSTEM_NAMESPACES (the "tax" that must be paid). */
  readonly systemReservedCpu: number;
  readonly systemReservedMemoryGi: number;
  /** Capacity of the largest single server — kept aside for the 1-server-loss case. */
  readonly failoverReservedCpu: number;
  readonly failoverReservedMemoryGi: number;
  /** What tenants can safely request in total, after baseline + failover reserve. */
  readonly tenantAvailableCpu: number;
  readonly tenantAvailableMemoryGi: number;
  /** Currently observed tenant requests (sum across client-* namespaces). */
  readonly tenantUsedCpu: number;
  readonly tenantUsedMemoryGi: number;
  /**
   * `true` if a single-server failure would still leave enough capacity
   * to host all current tenant workloads. False = at-risk; the operator
   * has overscheduled past the failover boundary OR the cluster is
   * structurally too small to honor the headroom invariant (see
   * `headroomClamped` below).
   */
  readonly singleFailureSurvivable: boolean;
  /**
   * `true` when the raw headroom math `total − system − one_server`
   * came out ≤0 in at least one dimension and was clamped to 0 in the
   * tenantAvailable* fields. This is normal for single-node dev
   * installs (1 server = 100% reserved as failover) but anomalous for
   * an HA cluster — a sustained `headroomClamped=true` on a 3+ server
   * cluster means the system baseline grew past one server's capacity
   * and the operator should investigate before scheduling tenants.
   */
  readonly headroomClamped: boolean;
}

interface NodeLike {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: {
    allocatable?: { cpu?: string; memory?: string };
    conditions?: ReadonlyArray<{ type?: string; status?: string }>;
  };
  spec?: { taints?: ReadonlyArray<{ key?: string }> };
}

interface PodLike {
  metadata?: { namespace?: string };
  spec?: {
    containers?: ReadonlyArray<{
      resources?: { requests?: { cpu?: string; memory?: string } };
    }>;
  };
  status?: { phase?: string };
}

function isReadyServerNode(node: NodeLike): boolean {
  const labels = node.metadata?.labels ?? {};
  const isServerByLabel = labels[SERVER_LABEL_KEY] === SERVER_LABEL_VAL;
  // Legacy fallback: control-plane taint = de facto server, even
  // before the operator labels the node. Mirrors the same fallback
  // in service.ts:readClusterState.
  const isServerByTaint = (node.spec?.taints ?? []).some(
    (t) => t.key === 'node-role.kubernetes.io/control-plane',
  );
  if (!isServerByLabel && !isServerByTaint) return false;
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  return ready?.status === 'True';
}

function sumPodRequests(
  pods: ReadonlyArray<PodLike>,
  namespacePredicate: (ns: string) => boolean,
): { cpu: number; memoryGi: number } {
  let cpu = 0;
  let memoryGi = 0;
  for (const pod of pods) {
    const ns = pod.metadata?.namespace ?? '';
    if (!namespacePredicate(ns)) continue;
    // Skip Succeeded/Failed — they don't consume capacity even though
    // the API still lists them.
    const phase = pod.status?.phase ?? '';
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const c of pod.spec?.containers ?? []) {
      const req = c.resources?.requests ?? {};
      if (req.cpu) cpu += parseResourceValue(req.cpu, 'cpu');
      if (req.memory) memoryGi += parseResourceValue(req.memory, 'memory');
    }
  }
  return { cpu, memoryGi };
}

/**
 * Internal compute used by both the live K8s reader and the unit
 * tests. Pure function over already-fetched node + pod lists; no I/O.
 */
export function computeFailoverHeadroom(
  nodes: ReadonlyArray<NodeLike>,
  pods: ReadonlyArray<PodLike>,
): FailoverHeadroom {
  const serverNodes = nodes.filter(isReadyServerNode);
  const servers: ServerNodeFact[] = serverNodes.map((n) => ({
    name: n.metadata?.name ?? '',
    allocatableCpu: n.status?.allocatable?.cpu
      ? parseResourceValue(n.status.allocatable.cpu, 'cpu')
      : 0,
    allocatableMemoryGi: n.status?.allocatable?.memory
      ? parseResourceValue(n.status.allocatable.memory, 'memory')
      : 0,
  }));

  const totalCpu = servers.reduce((s, n) => s + n.allocatableCpu, 0);
  const totalMemoryGi = servers.reduce((s, n) => s + n.allocatableMemoryGi, 0);

  // Largest single server's allocatable. Conservative: a homogeneous
  // 3×4-core cluster reserves 4 cores; a heterogeneous cluster with
  // one beefy node reserves that beefy node so its loss is survivable
  // by the smaller survivors.
  const failoverReservedCpu = servers.reduce((m, n) => Math.max(m, n.allocatableCpu), 0);
  const failoverReservedMemoryGi = servers.reduce(
    (m, n) => Math.max(m, n.allocatableMemoryGi),
    0,
  );

  const systemPredicate = (ns: string): boolean => SYSTEM_NAMESPACES.includes(ns);
  const tenantPredicate = (ns: string): boolean => ns.startsWith('client-');

  const system = sumPodRequests(pods, systemPredicate);
  const tenant = sumPodRequests(pods, tenantPredicate);

  // Compute the raw (unclamped) headroom first so we can surface a
  // diagnostic when it goes negative — that signals either a transient
  // boot state (system pods still scheduling) or a structural
  // misconfiguration (system baseline now exceeds one server's capacity
  // on a small cluster). Either way the operator needs to know via
  // `headroomClamped`; silently returning 0 was the original bug
  // surfaced by the code-reviewer (2026-05-11).
  const rawCpu = totalCpu - system.cpu - failoverReservedCpu;
  const rawMemGi = totalMemoryGi - system.memoryGi - failoverReservedMemoryGi;
  const headroomClamped = rawCpu <= 0 || rawMemGi <= 0;
  const tenantAvailableCpu = Math.max(0, rawCpu);
  const tenantAvailableMemoryGi = Math.max(0, rawMemGi);

  // Survivable = current tenant load fits in (total − system − one_server).
  // If tenantUsed > tenantAvailable in either dimension, OR the headroom
  // had to be clamped to zero at all (meaning the cluster is
  // structurally over-committed before tenants are even considered),
  // the answer is no — even tenantUsed=0 is "not survivable" because
  // any new tenant request would fail.
  const singleFailureSurvivable =
    !headroomClamped &&
    tenant.cpu <= tenantAvailableCpu &&
    tenant.memoryGi <= tenantAvailableMemoryGi;

  return {
    servers,
    totalCpu,
    totalMemoryGi,
    systemReservedCpu: system.cpu,
    systemReservedMemoryGi: system.memoryGi,
    failoverReservedCpu,
    failoverReservedMemoryGi,
    tenantAvailableCpu,
    tenantAvailableMemoryGi,
    tenantUsedCpu: tenant.cpu,
    tenantUsedMemoryGi: tenant.memoryGi,
    singleFailureSurvivable,
    headroomClamped,
  };
}

/**
 * Read cluster headroom live from the k8s API.
 *
 * Listing all pods cluster-wide is O(pods); on a 3-server staging
 * with ~110 pods that's ~50 ms. Cheap enough for an admin endpoint
 * called on-demand; if this ever needs to be a per-second hot path,
 * cache the node list (rarely changes) and rely on pod-watch.
 */
export async function getClusterFailoverHeadroom(k8s: K8sClients): Promise<FailoverHeadroom> {
  const [nodesRes, podsRes] = await Promise.all([
    k8s.core.listNode(),
    k8s.core.listPodForAllNamespaces(),
  ]);
  return computeFailoverHeadroom(
    (nodesRes.items ?? []) as ReadonlyArray<NodeLike>,
    (podsRes.items ?? []) as ReadonlyArray<PodLike>,
  );
}
