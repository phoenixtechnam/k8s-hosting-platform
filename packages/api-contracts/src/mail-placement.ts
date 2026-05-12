import { z } from 'zod';

export const mailMigrationStartRequestSchema = z.object({
  targetNode: z.string().min(1),
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
  primaryNode: z.string().nullable().optional(),
  secondaryNode: z.string().nullable().optional(),
  tertiaryNode: z.string().nullable().optional(),
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
  targetNode: z.string().nullable(),
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
