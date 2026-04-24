import { z } from 'zod';

// M1: cluster_nodes API contracts.
//
// The admin-panel Nodes page (M4) consumes this. Backend owns the
// k8s-facing side — the reconciler upserts observed state; PATCH
// writes flow *k8s first, then DB* (labels are authoritative).

export const nodeRoleSchema = z.enum(['server', 'worker']);
export type NodeRole = z.infer<typeof nodeRoleSchema>;

export const clusterNodeSchema = z.object({
  name: z.string(),
  role: nodeRoleSchema,
  canHostClientWorkloads: z.boolean(),
  publicIp: z.string().nullable(),
  kubeletVersion: z.string().nullable(),
  k3sVersion: z.string().nullable(),
  cpuMillicores: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  storageBytes: z.number().nullable(),
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
  role: nodeRoleSchema.optional(),
  canHostClientWorkloads: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  force: z.boolean().optional(),
});
export type UpdateClusterNodeInput = z.infer<typeof updateClusterNodeSchema>;

export const listClusterNodesResponseSchema = z.object({
  data: z.array(clusterNodeSchema),
});
export type ListClusterNodesResponse = z.infer<typeof listClusterNodesResponseSchema>;
