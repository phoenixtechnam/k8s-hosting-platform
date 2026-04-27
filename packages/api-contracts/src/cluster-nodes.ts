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
    /** Set when the pod's nodeAffinity pins it to *this* node only. */
    pinnedToThisNode: z.boolean(),
  })),
  longhornReplicas: z.array(z.object({
    volumeName: z.string(),
    replicaName: z.string(),
    /** True when this is the LAST healthy replica — refusing to drain. */
    isLastReplica: z.boolean(),
  })),
});
export type DrainImpact = z.infer<typeof drainImpactSchema>;

export const drainNodeRequestSchema = z.object({
  /** Skip the "last Longhorn replica" guard. Operator accepts data risk. */
  forceLastReplica: z.boolean().optional(),
  /** Eviction grace period in seconds. Default 60. Cap 600. */
  gracePeriodSeconds: z.number().int().min(0).max(600).optional(),
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
