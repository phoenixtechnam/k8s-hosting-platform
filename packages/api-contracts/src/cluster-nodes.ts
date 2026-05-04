import { z } from 'zod';

// M1: cluster_nodes API contracts.
//
// The admin-panel Nodes page (M4) consumes this. Backend owns the
// k8s-facing side — the reconciler upserts observed state; PATCH
// writes flow *k8s first, then DB* (labels are authoritative).

export const nodeRoleSchema = z.enum(['server', 'worker']);
export type NodeRole = z.infer<typeof nodeRoleSchema>;

// Three-state ingress mode (M-NS-1). See migration 0052.
//   all    — full ingress: nginx runs here, accepts traffic, can forward cluster-wide.
//   local  — nginx runs here but only forwards to pods on this same node (cross-node returns 503).
//   none   — no nginx here; workloads still run but traffic is served by other nodes.
export const nodeIngressModeSchema = z.enum(['all', 'local', 'none']);
export type NodeIngressMode = z.infer<typeof nodeIngressModeSchema>;

export const clusterNodeSchema = z.object({
  name: z.string(),
  /** Operator-friendly alias. Falls back to `name` when null. */
  displayName: z.string().nullable(),
  role: nodeRoleSchema,
  canHostClientWorkloads: z.boolean(),
  ingressMode: nodeIngressModeSchema,
  publicIp: z.string().nullable(),
  kubeletVersion: z.string().nullable(),
  k3sVersion: z.string().nullable(),
  cpuMillicores: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  storageBytes: z.number().nullable(),
  // Live usage from the last reconciler tick. null = reconciler hasn't
  // observed this node yet (e.g. between bootstrap seed and first
  // 60s tick).
  scheduledPods: z.number().nullable().optional(),
  cpuRequestsMillicores: z.number().nullable().optional(),
  memoryRequestsBytes: z.number().nullable().optional(),
  statusConditions: z.array(z.object({
    type: z.string(),
    status: z.string(),
    reason: z.string().optional(),
    message: z.string().optional(),
  })).nullable(),
  joinedAt: z.string(),
  lastSeenAt: z.string(),
  notes: z.string().nullable(),
  labels: z.record(z.string(), z.string()).nullable(),
  taints: z.array(z.object({
    key: z.string(),
    value: z.string().optional(),
    effect: z.string(),
  })).nullable(),
  /** Live cordon state — k8s node.spec.unschedulable. UI surfaces a
   *  red "Cordoned" tag; bootstrap.sh and `kubectl drain` set it. */
  cordoned: z.boolean(),
  /** True when the node is cordoned AND has no client workloads or
   *  PVC replicas left on it. UI shows a purple "Drained" tag and the
   *  Delete button to remove the node from the cluster. */
  drained: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClusterNodeResponse = z.infer<typeof clusterNodeSchema>;

// PATCH body — all fields optional. `force` bypasses the safety check
// that refuses to demote a server node which currently hosts system
// pods (the demotion would evict them). Use with care.
export const updateClusterNodeSchema = z.object({
  /**
   * Operator-friendly alias shown in the UI in place of `name`. Pass
   * empty string or `null` to clear. Length 0–63 to match a single
   * RFC1123 label (we allow more than that for `name` because k3s
   * permits FQDNs but the alias is a UX concern only).
   */
  displayName: z.string().max(63).nullable().optional(),
  role: nodeRoleSchema.optional(),
  canHostClientWorkloads: z.boolean().optional(),
  ingressMode: nodeIngressModeSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Toggle the k8s spec.unschedulable flag (cordon/uncordon). When
   *  the modal flips this to true, it also auto-clears
   *  canHostClientWorkloads so the operator's intent ("stop scheduling
   *  here") is honoured at both the cordon and the tenant-taint level. */
  cordoned: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type UpdateClusterNodeInput = z.infer<typeof updateClusterNodeSchema>;

// Drain impact preview (Phase C). The UI shows this before the
// operator confirms a drain. `nonSystemPods` is the set the drain
// will evict; the scheduler will reschedule them elsewhere
// (or leave them Pending if no other matching node exists).
export const drainImpactSchema = z.object({
  nodeName: z.string(),
  alreadyCordoned: z.boolean(),
  systemPods: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    /** Reason this pod won't be evicted (e.g. DaemonSet, system ns). */
    reason: z.string(),
  })),
  nonSystemPods: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    clientId: z.string().nullable(),
    /** Resolved client name for UI display. Falls back to namespace when client lookup fails. */
    clientName: z.string().nullable().default(null),
    /** Set when the pod's nodeAffinity OR nodeSelector pins it to *this* node only. */
    pinnedToThisNode: z.boolean(),
    /** Owner Deployment / StatefulSet name when traceable (used by re-pin UI). */
    workloadKind: z.string().nullable().default(null),
    workloadName: z.string().nullable().default(null),
  })),
  /**
   * Tenant clients with one or more pinned workloads or Longhorn PVCs
   * on this node. Pinning is a CLIENT-LEVEL concept (every Deployment,
   * StatefulSet, FM sidecar, and Longhorn volume in the client's
   * namespace inherits `clients.worker_node_name`), so the drain UI
   * must let the operator re-pin a CLIENT — not pick re-pin targets
   * for individual workloads or PVCs.
   *
   * Each client carries its `currentWorkerNodeName` (always equal to
   * this node when `tier=local`; may be `null` for `tier=ha` where
   * the pin is soft) and nested `workloads[]` + `pvcs[]` for an
   * expand-to-show details view in the modal — informational only.
   */
  pinnedClients: z.array(z.object({
    clientId: z.string(),
    clientName: z.string(),
    namespace: z.string(),
    storageTier: z.enum(['local', 'ha']),
    /** The client's current pin in the platform DB. */
    currentWorkerNodeName: z.string().nullable(),
    workloads: z.array(z.object({
      kind: z.enum(['Deployment', 'StatefulSet']),
      name: z.string(),
      replicas: z.number().int().nonnegative(),
      /** How the pin was expressed: nodeSelector vs. nodeAffinity. */
      pinKind: z.enum(['nodeSelector', 'nodeAffinity']),
    })),
    pvcs: z.array(z.object({
      pvcName: z.string(),
      volumeName: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      replicaCount: z.number().int().nonnegative(),
      /** True when this node holds the LAST running replica. */
      isLastReplica: z.boolean(),
      currentNodeSelector: z.array(z.string()).default([]),
    })),
  })).default([]),
  longhornReplicas: z.array(z.object({
    volumeName: z.string(),
    replicaName: z.string(),
    /** True when this is the LAST healthy replica — refusing to drain. */
    isLastReplica: z.boolean(),
    /** Owner namespace if the volume is bound to a PVC. */
    namespace: z.string().nullable().default(null),
    /** PVC name if the volume is bound to a PVC. */
    pvcName: z.string().nullable().default(null),
    /** Resolved client UUID when the namespace belongs to a tenant. */
    clientId: z.string().nullable().default(null),
    /** Resolved client company name when the namespace belongs to a tenant. */
    clientName: z.string().nullable().default(null),
    /** Pre-computed display label: client name OR "Platform System (<ns>)". */
    ownerLabel: z.string().default('Platform System'),
  })),
});
export type DrainImpact = z.infer<typeof drainImpactSchema>;

/**
 * Per-client re-pin instructions, one entry per `pinnedClients[]`.
 * Pinning is owned at the client level — the orchestrator propagates
 * the chosen target to every Deployment, StatefulSet, FM sidecar, and
 * Longhorn volume in the client's namespace.
 *
 *   ""        — clear the pin (auto: scheduler picks for workloads,
 *               Longhorn picks for PVCs)
 *   "<node>"  — re-pin the client to a specific other node
 *   "stay"    — keep the pin on the draining node (drain refuses
 *               unless `forceLastReplica` is also set)
 *
 * Key format: clientId.
 */
export const drainNodeRequestSchema = z.object({
  /** Skip the "last Longhorn replica" guard. Operator accepts data risk. */
  forceLastReplica: z.boolean().optional(),
  /** Eviction grace period in seconds. Default 60. Cap 600. */
  gracePeriodSeconds: z.number().int().min(0).max(600).optional(),
  /** Per-client re-pin instructions; missing entries default to "" (auto). */
  clientPlacement: z.record(z.string(), z.string()).optional().default({}),
});
export type DrainNodeRequest = z.infer<typeof drainNodeRequestSchema>;

export const drainNodeResponseSchema = z.object({
  nodeName: z.string(),
  cordoned: z.boolean(),
  evicted: z.number(),
  failed: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    error: z.string(),
  })),
  /** Number of clients whose pin was changed (DB + workloads + volumes). */
  rePinnedClients: z.number().int().nonnegative().default(0),
  /** Total Deployments/StatefulSets patched (sum across all rePinnedClients). */
  rePinnedWorkloads: z.number().int().nonnegative().default(0),
  /** Total Longhorn volumes whose nodeSelector was updated. */
  rePinnedPvcs: z.number().int().nonnegative().default(0),
});
export type DrainNodeResponse = z.infer<typeof drainNodeResponseSchema>;

export const deleteNodeResponseSchema = z.object({
  nodeName: z.string(),
  deletedFromKubernetes: z.boolean(),
  deletedFromInventory: z.boolean(),
});
export type DeleteNodeResponse = z.infer<typeof deleteNodeResponseSchema>;

export const listClusterNodesResponseSchema = z.object({
  data: z.array(clusterNodeSchema),
});
export type ListClusterNodesResponse = z.infer<typeof listClusterNodesResponseSchema>;
