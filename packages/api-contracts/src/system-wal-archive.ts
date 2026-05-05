import { z } from 'zod';

// System Backup Phase 4 — WAL archive runtime config.
// Toggle CNPG `spec.backup.barmanObjectStore` per cluster from the
// admin UI; the operator picks an existing S3 backup_configurations
// row as the destination. SFTP/SSH targets are not supported by CNPG
// barman-cloud and are filtered out at the API + UI layer.

// Same DNS-label validator as pg-dump. Postgres database name isn't
// in scope here (WAL is at cluster level, not per-DB).
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a lowercase DNS label');

export const walArchiveEnableRequestSchema = z.object({
  clusterNamespace: dnsLabelSchema,
  clusterName: dnsLabelSchema,
  targetConfigId: z.string().uuid(),
  retentionDays: z.number().int().min(1).max(3650).default(30),
});
export type WalArchiveEnableRequest = z.infer<typeof walArchiveEnableRequestSchema>;

export const walArchiveDisableRequestSchema = z.object({
  clusterNamespace: dnsLabelSchema,
  clusterName: dnsLabelSchema,
});
export type WalArchiveDisableRequest = z.infer<typeof walArchiveDisableRequestSchema>;

// One entry per cluster in the GET /clusters list. Combines the DB
// state row (operator intent) with a snapshot of the CNPG CR's
// `.status` (cluster-reported truth: last archived WAL, archiver
// errors). When `enabled=false`, `state` is null.
export const walArchiveClusterSchema = z.object({
  clusterNamespace: z.string(),
  clusterName: z.string(),
  enabled: z.boolean(),
  state: z.object({
    targetConfigId: z.string(),
    targetName: z.string().nullable(),
    retentionDays: z.number().int(),
    destinationPath: z.string(),
    enabledAt: z.string().datetime(),
  }).nullable(),
  // Operator-visible status surfaced from CNPG CR's .status. Best-
  // effort — null when not yet populated by CNPG.
  status: z.object({
    firstRecoverabilityPoint: z.string().nullable(),
    lastArchivedWal: z.string().nullable(),
    lastArchivedWalTime: z.string().nullable(),
    lastFailedArchiveTime: z.string().nullable(),
    lastFailedArchiveError: z.string().nullable(),
  }).nullable(),
});
export type WalArchiveCluster = z.infer<typeof walArchiveClusterSchema>;

export const walArchiveListResponseSchema = z.array(walArchiveClusterSchema);
export type WalArchiveListResponse = z.infer<typeof walArchiveListResponseSchema>;

export const walArchiveActionResponseSchema = z.object({
  clusterNamespace: z.string(),
  clusterName: z.string(),
  enabled: z.boolean(),
  destinationPath: z.string().nullable(),
});
export type WalArchiveActionResponse = z.infer<typeof walArchiveActionResponseSchema>;
