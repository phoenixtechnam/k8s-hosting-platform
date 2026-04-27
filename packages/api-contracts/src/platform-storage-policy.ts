import { z } from 'zod';

// M13: platform-level Longhorn replica policy (postgres + stalwart).
// Distinct from per-tenant storage_tier in clients.ts.

export const platformStorageTierSchema = z.enum(['local', 'ha']);
export type PlatformStorageTier = z.infer<typeof platformStorageTierSchema>;

export const platformStoragePolicySchema = z.object({
  systemTier: platformStorageTierSchema,
  pinnedByAdmin: z.boolean(),
  lastAppliedAt: z.string().datetime().nullable(),
  lastAppliedBy: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type PlatformStoragePolicy = z.infer<typeof platformStoragePolicySchema>;

// Cluster-observed state used to render the recommendation alongside
// the current policy. The reconciler uses these counts to compute the
// "recommended" tier — operator still has to opt-in.
export const clusterStorageStateSchema = z.object({
  readyServerCount: z.number().int().nonnegative(),
  totalNodeCount: z.number().int().nonnegative(),
  recommendedTier: platformStorageTierSchema,
  // Per-volume facts so the UI can show what will actually change. One
  // entry per Longhorn Volume backing a platform StatefulSet PVC.
  volumes: z.array(z.object({
    namespace: z.string(),
    pvcName: z.string(),
    volumeName: z.string(),
    currentReplicas: z.number().int().nonnegative(),
    desiredReplicas: z.number().int().nonnegative(),
    healthy: z.boolean(),
    phase: z.string().nullable(),
    /** M-NS-2: nodes currently hosting a healthy replica. */
    replicaNodes: z.array(z.string()).default([]),
    /** True when at least one replica sits on a non-system server (drift). */
    hasOffSystemReplica: z.boolean().default(false),
  })),
});
export type ClusterStorageState = z.infer<typeof clusterStorageStateSchema>;

export const getPlatformStoragePolicyResponseSchema = z.object({
  policy: platformStoragePolicySchema,
  clusterState: clusterStorageStateSchema,
});
export type GetPlatformStoragePolicyResponse = z.infer<typeof getPlatformStoragePolicyResponseSchema>;

export const updatePlatformStoragePolicySchema = z.object({
  systemTier: platformStorageTierSchema,
  // When true, the reconciler will not auto-flip the tier even if the
  // recommended tier diverges (e.g. a server temporarily NotReady).
  pinnedByAdmin: z.boolean().optional().default(true),
});
export type UpdatePlatformStoragePolicyInput = z.infer<typeof updatePlatformStoragePolicySchema>;

export const applyPlatformStoragePolicyResponseSchema = z.object({
  policy: platformStoragePolicySchema,
  // Per-volume patch result (Longhorn replicas).
  patches: z.array(z.object({
    namespace: z.string(),
    volumeName: z.string(),
    previousReplicas: z.number().int().nonnegative(),
    newReplicas: z.number().int().nonnegative(),
    patched: z.boolean(),
    error: z.string().nullable(),
  })),
  // M14: Apply HA also scales stateless Deployments + CNPG cluster.
  deployments: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    previousReplicas: z.number().int().nonnegative(),
    newReplicas: z.number().int().nonnegative(),
    patched: z.boolean(),
    error: z.string().nullable(),
  })),
  cnpgClusters: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    previousInstances: z.number().int().nonnegative(),
    newInstances: z.number().int().nonnegative(),
    patched: z.boolean(),
    error: z.string().nullable(),
  })),
});
export type ApplyPlatformStoragePolicyResponse = z.infer<typeof applyPlatformStoragePolicyResponseSchema>;
