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
  // entry per Longhorn Volume backing a platform StatefulSet PVC OR a
  // CNPG-managed Postgres PVC. `kind` lets the UI label the row;
  // backend behaviour (Longhorn-replica patching) is identical for both.
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
    /** Source of the PVC — `statefulset` (e.g. stalwart) or `cnpg` (e.g. postgres). */
    kind: z.enum(['statefulset', 'cnpg']).default('statefulset'),
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
  // Phase 3 — Apply HA persistent run id. Frontend polls
  // /admin/platform-storage-policy/runs/:id for live convergence
  // progress. runStatus is the post-patch initial status:
  // running | succeeded | partial | failed | capacity_blocked
  runId: z.string().uuid(),
  runStatus: z.enum(['running', 'succeeded', 'partial', 'failed', 'capacity_blocked']),
});
export type ApplyPlatformStoragePolicyResponse = z.infer<typeof applyPlatformStoragePolicyResponseSchema>;

// GET /admin/platform-storage-policy/runs/:id polling shape.
export const platformStorageApplyRunSchema = z.object({
  id: z.string().uuid(),
  tier: z.enum(['local', 'ha']),
  status: z.enum(['running', 'succeeded', 'partial', 'failed', 'capacity_blocked']),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  actorUserId: z.string().nullable(),
  patchOutcome: z.unknown().nullable(),
  convergence: z.object({
    volumesConverged: z.number().int(),
    volumesTotal: z.number().int(),
    volumesOffSystem: z.number().int(),
    cnpgConverged: z.number().int(),
    cnpgTotal: z.number().int(),
    deploymentsConverged: z.number().int(),
    deploymentsTotal: z.number().int(),
    lastObservedAt: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    stuckResources: z.array(z.object({
      kind: z.enum(['volume', 'cnpg', 'deployment']),
      name: z.string(),
      observed: z.number().int(),
      desired: z.number().int(),
      reason: z.string().optional(),
    })),
  }).nullable(),
});
export type PlatformStorageApplyRun = z.infer<typeof platformStorageApplyRunSchema>;
