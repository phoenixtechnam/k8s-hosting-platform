import { z } from 'zod';

/**
 * RFC 1123 hostname (label) syntax, anchored.
 *
 * The migration Job's shell script and the placement DB row both
 * consume node names as text. Without this constraint, a `super_admin`
 * (or any code path that bypasses the API) could inject shell
 * metacharacters via `targetNode` or via the `*_node` fields in
 * placement updates. The values flow into `sh -c` inside the rsync
 * Job (`backend/src/modules/mail-admin/migration.ts`), which mounts
 * the live RocksDB DataStore PVC.
 *
 * Kubernetes already constrains Node `metadata.name` to this syntax,
 * so anything legitimately coming from the cluster will pass. The
 * regex is intentionally tighter than Kubernetes' RFC 1123 subdomain:
 * we accept up to 253 chars, alphanumeric labels separated by `.`
 * or `-`, no uppercase, no underscores, no shell metacharacters.
 */
export const kubernetesNodeNameSchema = z.string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-.]{0,251}[a-z0-9])?$/,
    'must be a valid RFC 1123 Kubernetes node name (lowercase alphanumeric, dot, dash)',
  );

export const mailMigrationStartRequestSchema = z.object({
  targetNode: kubernetesNodeNameSchema,
  newGiB: z.number().int().min(1).max(2048).optional(),
  confirm: z.literal(true),
});

export const mailMigrationStatusResponseSchema = z.object({
  runId: z.string(),
  sourceNode: z.string(),
  targetNode: z.string(),
  state: z.enum(['queued', 'preflight', 'snapshotting', 'scaling-down', 'rsync', 'verifying', 'cutover', 'done', 'failed', 'rolled-back']),
  currentStep: z.string().nullable(),
  progressBytes: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
});

export type MailMigrationStartRequest = z.infer<typeof mailMigrationStartRequestSchema>;
export type MailMigrationStatusResponse = z.infer<typeof mailMigrationStatusResponseSchema>;

export const nodeCandidateSchema = z.object({
  hostname: z.string(),
  freeMemoryBytes: z.number(),
  freeDiskBytes: z.number(),
  role: z.string(),
  ready: z.boolean(),
});

export const mailPlacementResponseSchema = z.object({
  primaryNode: z.string().nullable(),
  secondaryNode: z.string().nullable(),
  tertiaryNode: z.string().nullable(),
  activeNode: z.string().nullable(),
  drState: z.enum(['healthy', 'degraded', 'failing-over', 'failed-over', 'failing-back']),
  autoFailoverEnabled: z.boolean(),
  failoverThresholdSeconds: z.number(),
  lastFailoverAt: z.string().nullable(),
  portExposureMode: z.enum(['thisNodeOnly', 'allServerNodes']),
  candidateNodes: z.array(nodeCandidateSchema),
});

export const mailPlacementUpdateRequestSchema = z.object({
  // Node names persist to system_settings and flow into the
  // migration Job's shell script. Use the strict node-name schema
  // (rejects shell metacharacters) instead of a plain string.
  primaryNode: kubernetesNodeNameSchema.nullable().optional(),
  secondaryNode: kubernetesNodeNameSchema.nullable().optional(),
  tertiaryNode: kubernetesNodeNameSchema.nullable().optional(),
  autoFailoverEnabled: z.boolean().optional(),
  failoverThresholdSeconds: z.number().int().min(60).max(3600).optional(),
}).refine(
  (d) => {
    const nodes = [d.primaryNode, d.secondaryNode, d.tertiaryNode].filter(Boolean);
    return new Set(nodes).size === nodes.length;
  },
  { message: 'Primary, secondary and tertiary nodes must be distinct' },
);

export const mailFailoverRequestSchema = z.object({
  // Same hostname constraint as mailMigrationStartRequestSchema —
  // failover flows through the same migration Job code path.
  targetNode: kubernetesNodeNameSchema.nullable(),
  confirm: z.literal(true),
});

export const mailFailbackRequestSchema = z.object({
  confirm: z.literal(true),
});

export const mailPortExposureUpdateSchema = z.object({
  mode: z.enum(['thisNodeOnly', 'allServerNodes']),
});

export const mailPortExposureResponseSchema = z.object({
  mode: z.enum(['thisNodeOnly', 'allServerNodes']),
  proxyProtocolActive: z.boolean(),
  daemonSetStatus: z.object({
    ready: z.number(),
    desired: z.number(),
  }).nullable(),
});

export type MailPlacementResponse = z.infer<typeof mailPlacementResponseSchema>;
export type MailPlacementUpdateRequest = z.infer<typeof mailPlacementUpdateRequestSchema>;
export type MailFailoverRequest = z.infer<typeof mailFailoverRequestSchema>;
export type MailFailbackRequest = z.infer<typeof mailFailbackRequestSchema>;
export type MailPortExposureUpdate = z.infer<typeof mailPortExposureUpdateSchema>;
export type MailPortExposureResponse = z.infer<typeof mailPortExposureResponseSchema>;
export type NodeCandidate = z.infer<typeof nodeCandidateSchema>;
